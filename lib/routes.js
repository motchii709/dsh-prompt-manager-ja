/**
 * The browser-facing half of the prompt store: one prefix route carrying the
 * body files the settings page edits.
 *
 * Bodies cannot ride the settings transport, because they are markdown files a
 * person also edits directly. This route is therefore the only write path from
 * the page, and it is fenced the way `/api` is: a loopback peer keeps the local
 * contract (no session needed, but the Host must be a loopback name), and any
 * other peer is handed to the composition's own browser trust — the deployment
 * decides how wide it serves, and this route follows that decision instead of
 * inventing a narrower one. Anything that mutates is additionally same-origin.
 * A stale editor is refused with 409 through the hash the page read, so two open
 * drafts cannot silently overwrite each other.
 *
 * Everything else the page edits — the entry index, the presets, the
 * subscriptions, the outbound settings — is a settings field, and this route
 * only fills the gaps that transport leaves: an id nobody holds, a body file, a
 * script on disk, a source's upstream check.
 *
 * @module @lolkda/dsh-prompt-manager/routes
 */
import { DEFAULT_SOURCE_REF, entryIdFor, isEntryId, MAX_BODY_BYTES, MAX_ENTRIES, MAX_PRESETS, } from './entries.js';
import { bodyHash, PromptStore, PromptStoreError } from './store.js';
import { malformedReferences } from './guard.js';
import { isRepo, isRef, isSourceId, MAX_SOURCES, normalizeMirror, sourceSlug } from './source.js';
import { CheckError } from './sync.js';
import { FetchFailure } from './net.js';
import { ScriptError } from './scripts.js';
import { MAX_PACK_BYTES, parsePack } from './pack.js';
import { isSessionId, NO_CHOICE, SessionChoiceError, } from './sessions.js';
/** The single prefix every route below lives under. */
export const ROUTE_PREFIX = '/dsh-prompt-manager';
/** Slack over a body limit, for JSON escaping and envelope overhead. */
const JSON_SLACK = 8192;
/** Slack over the body limit for JSON escaping overhead. */
const READ_LIMIT = MAX_BODY_BYTES * 2 + JSON_SLACK;
/** Largest accepted title on the id-allocation route. */
const TITLE_LIMIT = 4096;
/**
 * Register the prompt-store route.
 *
 * A composition without a web server (the TUI and SDK profiles) simply gets no
 * route; the settings page then reports the store as unreachable.
 *
 * @param ctx - the plugin context whose `webServer` service is injected.
 * @param host - body resolution, id allocation, and logging.
 */
export function installPromptRoutes(ctx, host) {
    // The trust authority belongs to another row — the `connection` row — and a
    // sibling's service is visible only to a plugin that *declares* it. Reaching
    // into the `webServer` scope for a name nobody asked for throws
    // (`cannot get property "connection" without inject`), and a route that
    // swallowed that threw away every LAN request as `no-trust-authority`.
    // Declaring it keeps the deployment's own decision: a composition that mounts
    // no Connection simply never runs this callback, and the route stays local.
    let trust;
    ctx.inject(['connection'], (scoped) => {
        trust = scoped.connection;
        return () => { trust = undefined; };
    });
    ctx.inject(['webServer'], (scoped) => {
        const webServer = scoped.webServer;
        if (webServer === undefined)
            return;
        // Read per request rather than at mount: a Connection that appears after this
        // callback ran still fences the next request.
        const trustOf = () => trust;
        try {
            const off = webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: createHandler(host, trustOf) });
            ctx.effect(() => off, 'dsh-prompt-manager: prompt store route');
        }
        catch (error) {
            host.warn(`cannot register ${ROUTE_PREFIX}: ${messageOf(error)}`);
        }
    });
}
/**
 * Build the request handler.
 * @param host - body resolution, id allocation, and logging.
 * @returns the handler registered on {@link ROUTE_PREFIX}.
 */
function createHandler(host, trustOf) {
    return async (request, response) => {
        try {
            const refusal = decide(request, trustOf);
            if (refusal !== undefined) {
                sendJson(response, refusal.status, { error: refusal.error, code: refusal.code });
                return;
            }
            const method = request.method ?? 'GET';
            if (method !== 'GET' && method !== 'HEAD' && !sameOrigin(request)) {
                sendJson(response, 403, { error: 'cross-origin writes are refused' });
                return;
            }
            const url = new URL(request.url ?? '/', 'http://127.0.0.1');
            const rest = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, '');
            const slash = rest.indexOf('/');
            const head = slash < 0 ? rest : rest.slice(0, slash);
            const tail = slash < 0 ? '' : rest.slice(slash + 1);
            if (head === 'status' && method === 'GET') {
                const compaction = host.compaction?.();
                sendJson(response, 200, {
                    ...host.store.status(),
                    maxEntries: MAX_ENTRIES,
                    // Where the per-session choices live and how many exist, so a deployment
                    // can tell "this conversation chose nothing" from "nothing was written".
                    sessions: host.sessions.status(),
                    variables: Object.fromEntries(host.variables().map((variable) => [variable.name, variable.value])),
                    // Absent rather than zeroed when the feature is off: a page cannot tell
                    // "switched off" from "on but never fired" if both read as 0.
                    ...(compaction === undefined ? {} : { compaction }),
                });
                return;
            }
            if (head === 'id' && method === 'POST') {
                const payload = asRecord(await readJsonBody(request));
                const title = typeof payload?.['title'] === 'string' ? payload['title'] : '';
                if (title.trim().length === 0) {
                    sendJson(response, 400, { error: 'title must be a non-empty string' });
                    return;
                }
                sendJson(response, 200, { id: host.idFor(title.slice(0, TITLE_LIMIT)) });
                return;
            }
            if (head === 'preset' && tail === 'id' && method === 'POST') {
                await handlePresetId(host, request, response);
                return;
            }
            if (head === 'body' && tail.length > 0) {
                // The id grammar is checked here, so every method answers the same way
                // for an id that could never address a body file.
                const id = decodeId(tail);
                if (id === undefined || !isEntryId(id)) {
                    sendJson(response, 400, { error: `the entry id is not a valid id: ${JSON.stringify(tail)}`, code: 'invalid-id' });
                    return;
                }
                await handleBody(host, method, id, request, response);
                return;
            }
            if (head === 'sources') {
                await handleSources(host, method, tail, request, response);
                return;
            }
            if (head === 'session' && tail.length > 0) {
                await handleSession(host, method, tail, request, response);
                return;
            }
            if (head === 'variables') {
                await handleVariables(host, method, tail, request, response);
                return;
            }
            if (head === 'script' && tail.length > 0) {
                const name = decodeId(tail);
                if (name === undefined || !isEntryId(name)) {
                    sendJson(response, 400, { error: `the script name is not a usable name: ${JSON.stringify(tail)}`, code: 'invalid-id' });
                    return;
                }
                await handleScript(host, method, name, request, response);
                return;
            }
            if (head === 'pack' && tail.length > 0) {
                await handlePack(host, method, tail, request, response);
                return;
            }
            sendJson(response, 404, { error: 'unknown prompt route' });
        }
        catch (error) {
            handleFailure(host, error, response);
        }
    };
}
/**
 * Allocate an id for a preset the settings page is about to write.
 *
 * The preset list itself rides the settings namespace, like the entry index, so
 * this route contributes the one thing the page cannot derive: an id nobody
 * holds. The cap is checked here for the same reason the source route checks
 * its own — a page that has run out of room should be told before it writes a
 * list the host would only narrow away.
 *
 * @param host - consulted for the preset ids in force.
 * @param request - the request, read for its JSON body.
 * @param response - the response to answer on.
 */
async function handlePresetId(host, request, response) {
    const payload = asRecord(await readJsonBody(request));
    const title = typeof payload?.['title'] === 'string' ? payload['title'] : '';
    if (title.trim().length === 0) {
        sendJson(response, 400, { error: 'title must be a non-empty string' });
        return;
    }
    const taken = host.presetIds();
    if (taken.length >= MAX_PRESETS) {
        sendJson(response, 409, {
            error: `プリセットは最大 ${String(MAX_PRESETS)} 個です。1つ削除してください`,
            code: 'too-many-presets',
        });
        return;
    }
    sendJson(response, 200, { id: entryIdFor(title.slice(0, TITLE_LIMIT), taken) });
}
/**
 * Serve the two preset-pack routes.
 *
 * Export answers with a file the browser saves; import reads one back. Both are
 * deliberately narrow: export never writes anything, and import is the only
 * route here that creates entries from a document that came from somewhere else,
 * so it validates the whole pack before it touches a single file.
 *
 * @param host - consulted for packs and asked to carry out an import.
 * @param method - HTTP method of the request.
 * @param tail - everything after `pack/`: `export` or `import`.
 * @param request - the request; the export reads its query, the import its body.
 * @param response - the response to answer on.
 */
async function handlePack(host, method, tail, request, response) {
    if (tail === 'export') {
        if (method !== 'GET') {
            sendJson(response, 405, { error: `method ${method} is not allowed on the pack export` });
            return;
        }
        const presetId = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('preset') ?? '';
        if (presetId.trim().length === 0) {
            sendJson(response, 400, { error: 'エクスポートにはクエリ文字列でプリセットを指定してください：/pack/export?preset=<プリセット id>', code: 'missing-preset' });
            return;
        }
        const pack = host.packFor(presetId.trim());
        if (pack === undefined) {
            sendJson(response, 404, { error: `このプリセットはありません：${presetId}`, code: 'unknown-preset' });
            return;
        }
        // A name the browser can use when the address is opened directly; a page
        // that fetches the URL and saves the blob names the file itself.
        response.setHeader('content-disposition', `attachment; filename="prompt-manager-pack-${presetId}.json"`);
        sendJson(response, 200, pack);
        return;
    }
    if (tail === 'import') {
        if (method !== 'POST') {
            sendJson(response, 405, { error: `method ${method} is not allowed on the pack import` });
            return;
        }
        const parsed = parsePack(await readJsonBody(request, MAX_PACK_BYTES + JSON_SLACK));
        if (!parsed.ok) {
            sendJson(response, 400, { error: parsed.message, code: parsed.code });
            return;
        }
        const outcome = await host.importPack(parsed.pack);
        if (!outcome.ok) {
            sendJson(response, 400, { error: outcome.message, code: outcome.code });
            return;
        }
        sendJson(response, 200, outcome.report);
        return;
    }
    sendJson(response, 404, { error: `unknown pack route: ${JSON.stringify(tail)}` });
}
/**
 * Serve the source routes: list, add, check, apply, revert, and forget a source.
 *
 * @param host - the subscription engine.
 * @param method - HTTP method of the request.
 * @param tail - everything after `sources/`: empty, `<slug>`, or `<slug>/<action>`.
 * @param request - the request, read for a JSON body on add and apply.
 * @param response - the response to answer on.
 */
async function handleSources(host, method, tail, request, response) {
    if (tail.length === 0) {
        if (method === 'POST') {
            await handleSourceCreate(host, request, response);
            return;
        }
        if (method !== 'GET') {
            sendJson(response, 405, { error: `method ${method} is not allowed on the source list` });
            return;
        }
        sendJson(response, 200, { sources: host.subscriptions.list() });
        return;
    }
    const slash = tail.indexOf('/');
    const slug = decodeId(slash < 0 ? tail : tail.slice(0, slash));
    const action = slash < 0 ? '' : tail.slice(slash + 1);
    if (slug === undefined || !isSourceId(slug)) {
        sendJson(response, 400, { error: 'the source id is not a valid slug' });
        return;
    }
    if (method === 'DELETE' && action.length === 0) {
        sendJson(response, 200, await host.subscriptions.remove(slug));
        return;
    }
    if (method === 'POST' && action === 'check') {
        sendJson(response, 200, await host.subscriptions.check(slug));
        return;
    }
    if (method === 'POST' && action === 'apply') {
        const payload = asRecord(await readJsonBody(request));
        const raw = payload?.['files'];
        const files = Array.isArray(raw) ? raw.filter((value) => typeof value === 'string') : undefined;
        sendJson(response, 200, await host.subscriptions.apply(slug, files));
        return;
    }
    if (method === 'POST' && action === 'revert') {
        sendJson(response, 200, await host.subscriptions.revert(slug));
        return;
    }
    sendJson(response, 405, { error: `unsupported source route: ${method} ${action}` });
}
/**
 * Validate a repository the settings page wants to subscribe to, and hand back
 * the slug no other source holds.
 *
 * The page stays the writer — sources ride the same settings namespace as the
 * entry index, and the page already writes that — so this route contributes the
 * two things the page cannot work out on its own: a slug that is still free, and
 * the shape checks a hand-typed repository, ref, and mirror need before the
 * engine turns them into outbound requests.
 *
 * @param host - the subscription engine, consulted for the sources in force.
 * @param request - the request, read for its JSON body.
 * @param response - the response to answer on.
 */
async function handleSourceCreate(host, request, response) {
    const payload = asRecord(await readJsonBody(request));
    if (payload === undefined) {
        sendJson(response, 400, { error: 'the request body must be a JSON object', code: 'invalid-body' });
        return;
    }
    const repo = typeof payload['repo'] === 'string' ? payload['repo'].trim() : '';
    if (!isRepo(repo)) {
        sendJson(response, 400, {
            error: `repo must be owner/name, got ${JSON.stringify(payload['repo'] ?? null)}`,
            code: 'invalid-repo',
        });
        return;
    }
    const rawRef = payload['ref'];
    const ref = rawRef === undefined || rawRef === null || (typeof rawRef === 'string' && rawRef.trim().length === 0)
        ? DEFAULT_SOURCE_REF
        : typeof rawRef === 'string'
            ? rawRef.trim()
            : undefined;
    if (ref === undefined || !isRef(ref)) {
        sendJson(response, 400, {
            error: `ref must be a branch, tag, or commit, got ${JSON.stringify(rawRef ?? null)}`,
            code: 'invalid-ref',
        });
        return;
    }
    const rawMirror = payload['mirror'];
    if (rawMirror !== undefined && rawMirror !== null && typeof rawMirror !== 'string') {
        sendJson(response, 400, { error: 'mirror must be a string when present', code: 'invalid-mirror' });
        return;
    }
    const mirror = normalizeMirror(typeof rawMirror === 'string' ? rawMirror : '');
    if (mirror === undefined) {
        sendJson(response, 400, {
            error: 'mirror must be an https origin without credentials, query, or fragment',
            code: 'invalid-mirror',
        });
        return;
    }
    const configured = host.subscriptions.list();
    const duplicate = configured.find((source) => source.repo === repo && source.ref === ref);
    if (duplicate !== undefined) {
        sendJson(response, 409, {
            error: `${repo}@${ref} is already subscribed as ${duplicate.id}`,
            code: 'duplicate-source',
        });
        return;
    }
    if (configured.length >= MAX_SOURCES) {
        sendJson(response, 409, {
            error: `at most ${String(MAX_SOURCES)} sources are supported`,
            code: 'too-many-sources',
        });
        return;
    }
    sendJson(response, 200, {
        id: slugFor(repo, configured.map((source) => source.id)),
        repo,
        ref,
        mirror,
    });
}
/**
 * Allocate a source slug no configured source holds.
 * @param repo - a validated `owner/name`.
 * @param taken - slugs already in force.
 * @returns a slug inside the source-id grammar, at most 64 characters.
 */
function slugFor(repo, taken) {
    const base = sourceSlug(repo);
    const used = new Set(taken);
    if (!used.has(base))
        return base;
    for (let suffix = 2; suffix < 1000; suffix += 1) {
        const candidate = `${base.slice(0, 60)}-${String(suffix)}`;
        if (!used.has(candidate))
            return candidate;
    }
    return `${base.slice(0, 50)}-${String(Date.now())}`;
}
/**
 * Serve the variable routes: the list of what the prompt can interpolate, a
 * test run, and a refresh.
 *
 * A test run is deliberately the same execution a saved script gets, down to
 * running from a real file, so what the page reports is what saving would
 * produce. What it does *not* do is register anything: a draft that is only
 * being tried out cannot change the prompt.
 *
 * @param host - the script engine and the variable list.
 * @param method - HTTP method of the request.
 * @param tail - empty, `run`, or `refresh`.
 * @param request - the request, read for a JSON body on `run`.
 * @param response - the response to answer on.
 */
async function handleVariables(host, method, tail, request, response) {
    if (tail.length === 0) {
        if (method !== 'GET') {
            sendJson(response, 405, { error: `method ${method} is not allowed on the variable list` });
            return;
        }
        sendJson(response, 200, {
            dir: host.scripts.dir,
            variables: host.variables(),
            scripts: host.scripts.list(),
        });
        return;
    }
    if (method !== 'POST') {
        sendJson(response, 405, { error: `method ${method} is not allowed on ${tail}` });
        return;
    }
    if (tail === 'run') {
        const payload = asRecord(await readJsonBody(request));
        const name = typeof payload?.['name'] === 'string' ? payload['name'].trim() : '';
        const source = payload?.['source'];
        if (source !== undefined) {
            if (typeof source !== 'string') {
                sendJson(response, 400, { error: 'source must be a string when present' });
                return;
            }
            sendJson(response, 200, await host.scripts.runSource(name.length > 0 ? name : 'draft', source));
            return;
        }
        if (name.length === 0) {
            sendJson(response, 400, { error: 'send either name (a saved script) or source (a draft)' });
            return;
        }
        sendJson(response, 200, await host.scripts.run(name));
        return;
    }
    if (tail === 'refresh') {
        sendJson(response, 200, { reports: await host.scripts.refresh() });
        return;
    }
    sendJson(response, 404, { error: `unknown variable route: ${tail}` });
}
/**
 * Serve one script: read its source, save a new one, or forget it.
 *
 * A save validates, runs, and only then writes: the file is put in place by the
 * same atomic write a prompt body uses, and a script whose output or variable
 * names are unusable never becomes a file at all.
 *
 * @param host - the script engine.
 * @param method - HTTP method of the request.
 * @param name - decoded script name.
 * @param request - the request, read for a JSON body on PUT.
 * @param response - the response to answer on.
 */
async function handleScript(host, method, name, request, response) {
    if (method === 'GET') {
        const stored = host.scripts.read(name);
        if (stored === undefined) {
            sendJson(response, 404, { error: `このスクリプトはありません：${name}`, code: 'unknown-script' });
            return;
        }
        sendJson(response, 200, { name, source: stored.source, sha1: stored.sha1 });
        return;
    }
    if (method === 'PUT') {
        const payload = asRecord(await readJsonBody(request));
        const source = payload?.['source'];
        if (typeof source !== 'string') {
            sendJson(response, 400, { error: 'source must be a string' });
            return;
        }
        const fence = payload?.['fileSha1'];
        if (fence !== undefined && fence !== null && typeof fence !== 'string') {
            sendJson(response, 400, { error: 'fileSha1 must be a string when present' });
            return;
        }
        const saved = await host.scripts.save(name, source, fence === undefined || fence === null ? { kind: 'absent' } : { kind: 'sha1', sha1: fence });
        sendJson(response, 200, saved);
        return;
    }
    if (method === 'DELETE') {
        sendJson(response, 200, { name, removed: host.scripts.remove(name) });
        return;
    }
    sendJson(response, 405, { error: `method ${method} is not allowed on a script` });
}
/**
 * Serve one entry's body: read, write, or restore the bundled default.
 * @param host - body resolution and the store.
 * @param method - HTTP method of the request.
 * @param id - decoded entry id, already checked against the id grammar.
 * @param request - the request, read for a JSON body on PUT.
 * @param response - the response to answer on.
 */
async function handleBody(host, method, id, request, response) {
    if (method === 'GET') {
        sendJson(response, 200, viewOf(host, id));
        return;
    }
    if (method === 'PUT') {
        if (host.describe(id).source === 'subscribed') {
            sendJson(response, 403, { error: 'a subscribed body is read-only; fork it into a local entry first' });
            return;
        }
        const payload = asRecord(await readJsonBody(request));
        const body = typeof payload?.['body'] === 'string' ? payload['body'] : undefined;
        if (body === undefined) {
            sendJson(response, 400, { error: 'body must be a string' });
            return;
        }
        const fence = payload?.['fileSha1'];
        if (fence !== undefined && fence !== null && typeof fence !== 'string') {
            sendJson(response, 400, { error: 'fileSha1 must be a string when present' });
            return;
        }
        // A reference the registry cannot even read as a variable name makes every
        // later model step fail, so it never reaches a file. A well-formed name that
        // happens to be unregistered is not refused here: another row may register
        // it, and the assembly guard covers the rest.
        const malformed = malformedReferences(body);
        if (malformed.length > 0) {
            sendJson(response, 422, {
                error: `本文に不正な参照があります。レジストリは {{name}} のような単純参照しか受け付けません：${malformed.join(' ')}（保存すると、その後の毎回の組み立てが失敗します）`,
                code: 'malformed-reference',
                references: malformed,
            });
            return;
        }
        host.store.write(id, body, fence === undefined || fence === null
            ? { kind: 'absent' }
            : { kind: 'sha1', sha1: fence });
        sendJson(response, 200, viewOf(host, id));
        return;
    }
    if (method === 'DELETE') {
        const removed = host.store.remove(id);
        sendJson(response, 200, { ...viewOf(host, id), removed });
        return;
    }
    sendJson(response, 405, { error: `method ${method} is not allowed on a prompt body` });
}
/**
 * The page's view of one entry body.
 * @param host - body resolution and the store.
 * @param id - entry id.
 * @returns effective body, its source and hash, and the override file's hash when present.
 */
function viewOf(host, id) {
    const described = host.describe(id);
    const stored = host.store.has(id) ? host.store.read(id) : undefined;
    return {
        id,
        body: described.text,
        source: described.source,
        sha1: hashOf(described.text),
        fileSha1: stored?.sha1 ?? null,
    };
}
/**
 * sha1 of a body, mirroring {@link PromptStore.read}.
 * @param body - the body to hash.
 * @returns a lowercase hex digest.
 */
function hashOf(body) {
    return bodyHash(body);
}
/** Report a failed request with the status its reason deserves. */
function handleFailure(host, error, response) {
    if (error instanceof PromptStoreError) {
        const status = error.code === 'conflict' ? 409 : error.code === 'invalid-id' || error.code === 'too-large' ? 400 : 500;
        sendJson(response, status, { error: error.message, code: error.code });
        return;
    }
    if (error instanceof ScriptError) {
        const status = error.reason === 'unknown-script'
            ? 404
            : error.reason === 'conflict'
                ? 409
                : error.reason === 'invalid-output' || error.reason === 'too-many'
                    ? 422
                    : 400;
        sendJson(response, status, { error: error.message, code: error.reason, report: error.report });
        return;
    }
    if (error instanceof CheckError) {
        const status = error.reason === 'unknown-source'
            ? 404
            : error.reason === 'nothing-staged' || error.reason === 'disabled'
                ? 409
                : error.reason === 'manifest'
                    ? 422
                    : error.reason === 'mirror' || error.reason === 'network'
                        ? 502
                        : 400;
        sendJson(response, status, { error: error.message, code: error.reason });
        return;
    }
    if (error instanceof FetchFailure) {
        sendJson(response, 502, { error: error.message, code: error.reason });
        return;
    }
    host.warn(`prompt route failed: ${messageOf(error)}`);
    sendJson(response, 500, { error: messageOf(error) });
}
/**
 * Who decides this request is allowed, before any route logic runs.
 *
 * The peer address alone does not settle where the request came from: a page
 * served by a name that resolves to this machine reaches the same socket, and
 * presents a `Host` and a matching `Origin` of its own. So a loopback peer keeps
 * the local contract — no browser session required, which is what the README's
 * curl self-check relies on — and must still name a loopback Host, so a rebound
 * name cannot get in. Every other peer is the deployment's call: the
 * composition's browser trust answers for it exactly as it answers for `/api`.
 *
 * @param request - the incoming request.
 * @param trustOf - the trust authority, read live; `undefined` when none is mounted.
 * @returns the refusal to answer, or `undefined` to continue to the routes.
 */
function decide(request, trustOf) {
    if (isLoopback(request)) {
        return isLoopbackHost(request.headers.host)
            ? undefined
            : {
                status: 403,
                code: 'host-not-loopback',
                error: 'the prompt store answers loopback host names only (127.0.0.1, localhost, [::1])',
            };
    }
    const trust = trustOf();
    // No authority to delegate to: refuse rather than invent a trust decision.
    if (trust === undefined) {
        return {
            status: 403,
            code: 'no-trust-authority',
            error: 'the prompt store is reachable from loopback clients only (this composition mounts no Connection service)',
        };
    }
    const rejection = trust.requestRejection(request);
    if (rejection === undefined)
        return undefined;
    return rejection === 401
        ? {
            status: 401,
            code: 'no-session',
            error: 'the prompt store needs the browser session /api uses: open the URL printed by dsh web',
        }
        : {
            status: 403,
            code: 'host-not-trusted',
            error: 'this Host is not in trustedHosts, so the prompt store refuses it',
        };
}
/**
 * Loopback-peer check: the prompt store is a local file surface.
 * @param request - the incoming request.
 * @returns `true` when the peer address is the local machine.
 */
function isLoopback(request) {
    const address = request.socket?.remoteAddress ?? '';
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.');
}
/**
 * Loopback-host check: which name the client used to reach this socket.
 *
 * A page served from a name that resolves to this machine — the classic
 * DNS-rebinding setup — arrives from a loopback peer and presents a `Host` and
 * a matching `Origin` of its own, which the peer check and the same-origin
 * check both accept. Requiring a loopback host name closes that door.
 *
 * @param host - the `Host` header value.
 * @returns `true` when it names the local machine.
 */
function isLoopbackHost(host) {
    if (host === undefined)
        return false;
    let name;
    try {
        name = new URL(`http://${host}`).hostname;
    }
    catch {
        return false;
    }
    const bare = name.startsWith('[') && name.endsWith(']') ? name.slice(1, -1) : name;
    return bare === '127.0.0.1' || bare === 'localhost' || bare === '::1' || bare.startsWith('127.');
}
/**
 * Same-origin check for mutating routes.
 * @param request - the incoming request.
 * @returns `true` when the Origin header names the Host.
 */
function sameOrigin(request) {
    const origin = request.headers.origin;
    const host = request.headers.host;
    if (origin === undefined || host === undefined)
        return false;
    try {
        return new URL(origin).host === host;
    }
    catch {
        return false;
    }
}
/**
 * Read a JSON request body under a size limit.
 * @param request - the incoming request.
 * @param limit - largest accepted body in bytes; the pack route raises it,
 * because one pack may carry what the entry route carries in fifty writes.
 * @returns the parsed JSON value, or `undefined` when the body is not JSON.
 */
async function readJsonBody(request, limit = READ_LIMIT) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > limit)
            throw new PromptStoreError('too-large', `request body is ${String(size)} bytes; the limit is ${String(limit)}`);
        chunks.push(buffer);
    }
    if (size === 0)
        return undefined;
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch {
        throw new PromptStoreError('invalid-id', 'request body is not valid JSON');
    }
}
/**
 * Narrow a parsed JSON value to a record.
 * @param value - the parsed value.
 * @returns the record, or `undefined` when the value is not a plain object.
 */
function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
/**
 * Percent-decode one path segment.
 * @param segment - the raw segment.
 * @returns the decoded id, or `undefined` when decoding fails.
 */
function decodeId(segment) {
    try {
        return decodeURIComponent(segment);
    }
    catch {
        return undefined;
    }
}
/** Write a JSON payload with no-store caching. */
function sendJson(response, status, payload) {
    response.writeHead(status, {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
    });
    response.end(JSON.stringify(payload));
}
/**
 * Message text of an unknown thrown value.
 * @param error - the caught value.
 * @returns a human-facing message.
 */
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * Read, set, or forget one session's choice.
 *
 * The chips in the composer are the only callers: they know which conversation
 * they are drawn in, and the Host is the only side that can answer what that
 * conversation will actually inject. Body writes carry a hash fence; this one
 * carries none, because a choice is a single value a person just picked rather
 * than a draft two editors could hold at once.
 *
 * @param host - the session-choice store.
 * @param method - the request method: `GET`, `POST`, or `DELETE`.
 * @param tail - the path below `session/`, holding the session id.
 * @param request - the incoming request, whose body carries a `POST` patch.
 * @param response - the response to answer on.
 */
async function handleSession(host, method, tail, request, response) {
    const sessionId = decodeId(tail);
    if (sessionId === undefined || !isSessionId(sessionId)) {
        sendJson(response, 400, {
            error: `the session id is not a valid id: ${JSON.stringify(tail)}`,
            code: 'invalid-id',
        });
        return;
    }
    if (method === 'GET' || method === 'HEAD') {
        // The effective choice rather than the file: a session that chose nothing and
        // a session whose file says `''` inject the same thing, and the chip should
        // say so rather than making a person tell those two apart.
        sendJson(response, 200, {
            session: sessionId,
            ...host.sessions.effective(sessionId),
            stored: host.sessions.has(sessionId),
        });
        return;
    }
    if (method === 'DELETE') {
        let cleared;
        try {
            cleared = host.sessions.clear(sessionId);
        }
        catch (error) {
            sendJson(response, 500, { error: messageOf(error), code: errorCodeOf(error) });
            return;
        }
        sendJson(response, 200, { session: sessionId, ...NO_CHOICE, stored: false, cleared });
        return;
    }
    if (method !== 'POST') {
        sendJson(response, 405, { error: `method ${method} is not allowed on a session choice` });
        return;
    }
    const payload = asRecord(await readJsonBody(request));
    if (payload === undefined) {
        sendJson(response, 400, { error: 'the patch must be a JSON object' });
        return;
    }
    const patch = {};
    for (const field of ['preset', 'compaction']) {
        const value = payload[field];
        if (value === undefined)
            continue;
        if (typeof value !== 'string') {
            sendJson(response, 400, { error: `${field} must be a string`, code: 'invalid-value' });
            return;
        }
        // An id-shaped value or nothing: a name that could never address an entry is
        // refused here rather than stored and reported at every later assembly.
        if (value !== '' && !isEntryId(value)) {
            sendJson(response, 400, {
                error: `${field} is not a usable id: ${JSON.stringify(value)}`,
                code: 'invalid-value',
            });
            return;
        }
        patch[field] = value;
    }
    if (patch.preset === undefined && patch.compaction === undefined) {
        sendJson(response, 400, { error: 'the patch names neither preset nor compaction' });
        return;
    }
    try {
        const stored = host.sessions.write(sessionId, patch);
        sendJson(response, 200, { session: sessionId, ...stored, stored: true });
    }
    catch (error) {
        sendJson(response, 500, { error: messageOf(error), code: errorCodeOf(error) });
    }
}
/**
 * The code one session-choice failure answers with.
 * @param error - the caught value.
 * @returns `invalid-id` for a refused name, `unwritable` otherwise.
 */
function errorCodeOf(error) {
    return error instanceof SessionChoiceError ? error.code : 'unwritable';
}
//# sourceMappingURL=routes.js.map