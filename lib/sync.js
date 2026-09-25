/**
 * One source's files on disk, and the three operations the settings page drives:
 * check what changed upstream, apply it, undo the last apply.
 *
 * The layout is a three-slot rotation, so nothing is ever half-updated:
 * `staging/` holds what a check downloaded, `current/` is what the prompt reads,
 * and `previous/` keeps the version the last apply replaced so one click can put
 * it back. `state.json` carries the bookkeeping: which commit is in force, which
 * entry each file became, and the hashes and validators that make the next check
 * cheap.
 *
 * @module @lolkda/dsh-prompt-manager/sync
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { bodyHash } from './store.js';
import { looksLikeHtml } from './net.js';
import { entryIdFor, entryIdForPrompt, headAtomUrl, isMovableRef, MANIFEST_FILE, MAX_FILE_BYTES, parseHeadSha, parseManifest, rawUrl, stemOf, } from './source.js';
/** A check that could not conclude. */
export class CheckError extends Error {
    /** Machine-readable reason. */
    reason;
    /**
     * @param reason - machine-readable reason.
     * @param message - human-facing detail.
     */
    constructor(reason, message) {
        super(message);
        this.name = 'CheckError';
        this.reason = reason;
    }
}
/** The files of one source, confined to one directory. */
export class SourceWorkspace {
    /** Source slug. */
    slug;
    /** `<root>/sources/<slug>`. */
    dir;
    /**
     * @param root - the plugin's storage root, e.g. `$DSH_HOME/prompt-manager`.
     * @param slug - the source id.
     */
    constructor(root, slug) {
        this.slug = slug;
        this.dir = resolve(root, 'sources', slug);
    }
    /** Directory holding the version in force. */
    get currentDir() {
        return join(this.dir, 'current');
    }
    /** Directory holding the version the last apply replaced. */
    get previousDir() {
        return join(this.dir, 'previous');
    }
    /** Directory holding what a check downloaded but nobody applied yet. */
    get stagingDir() {
        return join(this.dir, 'staging');
    }
    /** Path of the bookkeeping file. */
    get statePath() {
        return join(this.dir, 'state.json');
    }
    /**
     * Absolute path of one body file inside one slot.
     * @param slot - which slot.
     * @param path - repository-relative manifest path.
     * @returns the absolute path; a traversal attempt resolves to `undefined`.
     */
    slotPath(slot, path) {
        const base = slot === 'current' ? this.currentDir : slot === 'previous' ? this.previousDir : this.stagingDir;
        const file = resolve(base, path);
        const prefix = `${resolve(base)}${process.platform === 'win32' ? '\\' : '/'}`;
        return file.startsWith(prefix) ? file : undefined;
    }
    /** Whether this source has any files on disk. */
    exists() {
        return existsSync(this.dir);
    }
    /**
     * Read the bookkeeping, defaulting to an empty state.
     * @returns the state; an unreadable or malformed file reads as empty.
     */
    readState() {
        if (!existsSync(this.statePath))
            return { ref: '', files: {} };
        try {
            const parsed = JSON.parse(readFileSync(this.statePath, 'utf8'));
            if (typeof parsed !== 'object' || parsed === null)
                return { ref: '', files: {} };
            const record = parsed;
            const files = typeof record['files'] === 'object' && record['files'] !== null && !Array.isArray(record['files'])
                ? record['files']
                : {};
            const state = { ref: typeof record['ref'] === 'string' ? record['ref'] : '', files };
            if (typeof record['headSha'] === 'string')
                state.headSha = record['headSha'];
            if (typeof record['headShaPrevious'] === 'string')
                state.headShaPrevious = record['headShaPrevious'];
            if (typeof record['manifestSha1'] === 'string')
                state.manifestSha1 = record['manifestSha1'];
            if (typeof record['appliedAt'] === 'string')
                state.appliedAt = record['appliedAt'];
            if (typeof record['undo'] === 'object' && record['undo'] !== null && !Array.isArray(record['undo'])) {
                state.undo = record['undo'];
            }
            return state;
        }
        catch {
            return { ref: '', files: {} };
        }
    }
    /**
     * Persist the bookkeeping.
     * @param state - the state to write.
     */
    writeState(state) {
        mkdirSync(this.dir, { recursive: true });
        writeFileSync(this.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    }
    /** Read one body from a slot. */
    read(slot, path) {
        const file = this.slotPath(slot, path);
        if (file === undefined || !existsSync(file))
            return undefined;
        try {
            return readFileSync(file, 'utf8');
        }
        catch {
            return undefined;
        }
    }
    /** Paths present in a slot, relative to that slot. */
    list(slot) {
        const base = slot === 'current' ? this.currentDir : slot === 'previous' ? this.previousDir : this.stagingDir;
        if (!existsSync(base))
            return [];
        const found = [];
        const walk = (dir, prefix) => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
                if (entry.isDirectory())
                    walk(join(dir, entry.name), relative);
                else if (entry.name.endsWith('.md'))
                    found.push(relative);
            }
        };
        walk(base, '');
        return found.sort();
    }
    /** Write one body into the staging slot. */
    stage(path, text) {
        const file = this.slotPath('staging', path);
        if (file === undefined)
            throw new CheckError('manifest', `refusing to stage outside the source: ${path}`);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text, 'utf8');
    }
    /** Empty the staging slot. */
    clearStaging() {
        rmSync(this.stagingDir, { recursive: true, force: true });
    }
    /**
     * Record what a check staged, so an apply can run without repeating the
     * network round trip.
     * @param plan - the staged plan.
     */
    writePlan(plan) {
        mkdirSync(this.stagingDir, { recursive: true });
        writeFileSync(join(this.stagingDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
    }
    /**
     * Read the staged plan.
     * @returns the plan, or `undefined` when nothing is staged.
     */
    readPlan() {
        const file = join(this.stagingDir, 'plan.json');
        if (!existsSync(file))
            return undefined;
        try {
            const parsed = JSON.parse(readFileSync(file, 'utf8'));
            if (typeof parsed !== 'object' || parsed === null)
                return undefined;
            const record = parsed;
            if (!Array.isArray(record['changes']) || !Array.isArray(record['prompts']))
                return undefined;
            const plan = {
                changes: record['changes'],
                prompts: record['prompts'],
                manifestSha1: typeof record['manifestSha1'] === 'string' ? record['manifestSha1'] : '',
                etags: typeof record['etags'] === 'object' && record['etags'] !== null && !Array.isArray(record['etags'])
                    ? record['etags']
                    : {},
            };
            if (typeof record['headSha'] === 'string')
                plan.headSha = record['headSha'];
            return plan;
        }
        catch {
            return undefined;
        }
    }
    /** Remove the whole source directory. */
    remove() {
        rmSync(this.dir, { recursive: true, force: true });
    }
}
/**
 * Line counts of what a change adds and removes, by longest common
 * subsequence over lines. The dynamic table is skipped for pathologically large
 * pairs, where the answer degrades to "roughly how many lines differ" rather
 * than stalling the request.
 *
 * @param before - the body in force, or `''` for a new file.
 * @param after - the checked body.
 * @returns added and removed line counts.
 */
export function diffCounts(before, after) {
    const left = before.length === 0 ? [] : before.split('\n');
    const right = after.length === 0 ? [] : after.split('\n');
    let head = 0;
    while (head < left.length && head < right.length && left[head] === right[head])
        head += 1;
    let tail = 0;
    while (tail < left.length - head
        && tail < right.length - head
        && left[left.length - 1 - tail] === right[right.length - 1 - tail])
        tail += 1;
    const a = left.slice(head, left.length - tail);
    const b = right.slice(head, right.length - tail);
    if (a.length === 0 && b.length === 0)
        return { added: 0, removed: 0 };
    if (a.length === 0)
        return { added: b.length, removed: 0 };
    if (b.length === 0)
        return { added: 0, removed: a.length };
    const common = a.length * b.length > 250_000 ? Math.min(a.length, b.length) : lcsLength(a, b);
    return { added: b.length - common, removed: a.length - common };
}
/**
 * Longest common subsequence length over two line arrays.
 * @param a - first sequence.
 * @param b - second sequence.
 * @returns the length of the longest common subsequence.
 */
function lcsLength(a, b) {
    let previous = new Array(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i += 1) {
        const current = new Array(b.length + 1).fill(0);
        for (let j = 1; j <= b.length; j += 1) {
            current[j] = a[i - 1] === b[j - 1]
                ? (previous[j - 1] ?? 0) + 1
                : Math.max(previous[j] ?? 0, current[j - 1] ?? 0);
        }
        previous = current;
    }
    return previous[b.length] ?? 0;
}
/**
 * Check one source against its upstream and stage whatever changed.
 *
 * @param input - source, workspace, and the fetcher carrying the proxy and mirror.
 * @returns what changed, or that nothing did.
 * @throws {CheckError} when the check cannot conclude.
 */
export async function checkSource(input) {
    const { source, workspace, fetcher } = input;
    const state = workspace.readState();
    const warnings = [];
    let headSha;
    if (isMovableRef(source.ref)) {
        try {
            const feed = await fetcher.get(headAtomUrl(source.repo, source.ref), { timeoutMs: 8000 });
            if (feed.status === 200)
                headSha = parseHeadSha(feed.text);
            if (headSha === undefined)
                warnings.push('commits ソースから commit sha を読み取れなかったため、ファイルごとの比較に切り替えます');
        }
        catch (error) {
            warnings.push(`commit プローブに失敗したため、ファイルごとの比較に切り替えます：${error instanceof Error ? error.message : String(error)}`);
        }
        if (headSha !== undefined && headSha === state.headSha) {
            return { upToDate: true, headSha, changes: [], prompts: [], warnings };
        }
    }
    const manifestResponse = await fetchOrThrow(fetcher, rawUrl(source.repo, source.ref, MANIFEST_FILE));
    if (manifestResponse.status === 404) {
        throw new CheckError('manifest', `リポジトリに ${MANIFEST_FILE} がありません（${source.repo}@${source.ref} のルートディレクトリ）`);
    }
    const manifestSha1 = bodyHash(manifestResponse.text);
    let prompts;
    try {
        prompts = parseManifest(JSON.parse(manifestResponse.text));
    }
    catch (error) {
        throw new CheckError('manifest', error instanceof Error ? error.message : String(error));
    }
    workspace.clearStaging();
    const changes = [];
    const etags = {};
    const wanted = new Set(prompts.map((prompt) => prompt.file));
    /**
     * Paths upstream dropped, with the id and body each one carried.
     *
     * Computed before the loop rather than after it because the loop needs them:
     * a file that is new here and gone there may be the same prompt under a new
     * name, and the only way to tell is to have both sides in hand at once.
     */
    const removals = Object.keys(state.files)
        .filter((path) => !wanted.has(path))
        .map((path) => {
        const record = state.files[path];
        return {
            path,
            id: record?.id ?? entryIdFor(source.id, path),
            sha1: record?.sha1 ?? bodyHash(workspace.read('current', path) ?? ''),
        };
    });
    /** New files whose body might be a renamed copy of something above. */
    const orphans = [];
    for (const prompt of prompts) {
        const known = state.files[prompt.file];
        // Identity, in order of who knows best. A declared `id` is the manifest
        // saying what this file *is*, so it outranks the name the file happens to
        // have; what this path already became outranks the derivation, so a file that
        // keeps its path keeps its id even when the two disagree. A path this machine
        // has never seen is the only case a rename can hide in, and the hash below is
        // what looks there.
        const declared = entryIdForPrompt(source.id, prompt);
        const identity = known !== undefined && prompt.id === undefined ? known.id : declared;
        const identityMoved = known !== undefined && known.id !== identity;
        // A conditional request is only worth sending when the copy it would
        // validate is on disk. With the body file gone — deleted by hand, or lost
        // between two applies — a 304 would answer with no content at all, and
        // staging that empty answer would silently blank the entry for good. So the
        // validator is dropped and the file is fetched in full instead.
        const local = workspace.read('current', prompt.file);
        const response = await fetchOrThrow(fetcher, rawUrl(source.repo, source.ref, prompt.file), local === undefined ? undefined : known?.etag);
        if (response.status === 404) {
            warnings.push(`${prompt.file} はリモートに存在しないためスキップしました`);
            continue;
        }
        if (response.status === 304) {
            // A body nobody touched, under an identity that moved: the entry has to be
            // re-recorded, and the body it already has is the one to stage.
            if (!identityMoved)
                continue;
            const body = local ?? '';
            workspace.stage(prompt.file, body);
            changes.push({ path: prompt.file, id: identity, kind: 'changed', added: 0, removed: 0 });
            continue;
        }
        const sha1 = bodyHash(response.text);
        if (known !== undefined && known.sha1 === sha1 && !identityMoved)
            continue;
        if (Buffer.byteLength(response.text, 'utf8') > MAX_FILE_BYTES) {
            warnings.push(`${prompt.file} が ${String(MAX_FILE_BYTES)} バイトを超えているためスキップしました`);
            continue;
        }
        workspace.stage(prompt.file, response.text);
        if (response.etag !== undefined)
            etags[prompt.file] = response.etag;
        const counts = diffCounts(local ?? '', response.text);
        const change = {
            id: identity,
            path: prompt.file,
            kind: known === undefined ? 'added' : 'changed',
            added: counts.added,
            removed: counts.removed,
        };
        if (known === undefined && prompt.id === undefined)
            orphans.push({ path: prompt.file, sha1, change });
        if (prompt.title !== undefined)
            change.title = prompt.title;
        if (prompt.order !== undefined)
            change.order = prompt.order;
        changes.push(change);
    }
    // A rename leaves the same body under a new name, so an identical sha1 on
    // exactly one dropped path and exactly one new one is the whole signal — and
    // the only honest one. Every wider match (near-identical bodies, two new files
    // sharing a body, a body that also exists unchanged elsewhere) is a guess that
    // would hand somebody else's entry id to the wrong prompt, so it is declined
    // and reported instead.
    const byOrphanSha1 = indexBySha1(orphans.map((orphan) => [orphan.sha1, orphan.path]));
    const byRemovalSha1 = indexBySha1(removals.map((removal) => [removal.sha1, removal.path]));
    for (const orphan of orphans) {
        // Nothing dropped carries this body, so this is an ordinary new file, not a
        // rename hiding anywhere.
        if (!byRemovalSha1.has(orphan.sha1))
            continue;
        const from = unambiguous(byRemovalSha1.get(orphan.sha1));
        const to = unambiguous(byOrphanSha1.get(orphan.sha1));
        if (from === undefined || to !== orphan.path) {
            warnings.push(`${orphan.path} の本文は削除されたファイルと同じですが、複数のファイルが一致するため改名かどうか確定できません。新規エントリとして扱います（id を固定したい場合はマニフェストに "id" を書いてください）`);
            continue;
        }
        const removal = removals.find((candidate) => candidate.path === from);
        if (removal === undefined)
            continue;
        orphan.change.id = removal.id;
        orphan.change.renamedFrom = removal.path;
    }
    for (const removal of removals) {
        const body = workspace.read('current', removal.path) ?? '';
        const change = {
            path: removal.path,
            id: removal.id,
            kind: 'removed',
            added: 0,
            removed: body.length === 0 ? 0 : body.split('\n').length,
        };
        // A removal and an addition carrying one id are one move even when the body
        // changed on the way: the manifest declared that id, so the entry kept its
        // identity while its file was renamed, and the pair has to land together.
        // (When the body did not change, the hash already paired them; this is the
        // same pairing stated the other way round, so there is one rule and not two.)
        const renamedTo = changes.find((candidate) => candidate.kind === 'added'
            && candidate.id === removal.id
            && (candidate.renamedFrom === undefined || candidate.renamedFrom === removal.path));
        if (renamedTo !== undefined) {
            renamedTo.renamedFrom = removal.path;
            change.renamedTo = renamedTo.path;
        }
        changes.push(change);
    }
    const plan = { changes, prompts, manifestSha1, etags };
    if (headSha !== undefined)
        plan.headSha = headSha;
    workspace.writePlan(plan);
    const outcome = { upToDate: changes.length === 0, changes, prompts, warnings };
    if (headSha !== undefined)
        outcome.headSha = headSha;
    return outcome;
}
/**
 * Group paths by the body hash they carry.
 * @param pairs - `[sha1, path]`, in the order the check met them.
 * @returns sha1 to every path carrying it.
 */
function indexBySha1(pairs) {
    const index = new Map();
    for (const [sha1, path] of pairs) {
        const paths = index.get(sha1);
        if (paths === undefined)
            index.set(sha1, [path]);
        else
            paths.push(path);
    }
    return index;
}
/**
 * The one path a hash stands for.
 * @param paths - the paths carrying one hash.
 * @returns that path, or `undefined` when there is not exactly one.
 */
function unambiguous(paths) {
    return paths !== undefined && paths.length === 1 ? paths[0] : undefined;
}
/**
 * Fetch one URL and refuse obvious non-content answers.
 * @param fetcher - the fetcher to use.
 * @param url - absolute upstream URL.
 * @param etag - stored validator, when the caller has one.
 * @returns the response.
 * @throws {CheckError} on network failure, an HTML answer, or a server error.
 */
async function fetchOrThrow(fetcher, url, etag) {
    let response;
    try {
        response = await fetcher.get(url, etag === undefined ? {} : { etag });
    }
    catch (error) {
        throw new CheckError('network', error instanceof Error ? error.message : String(error));
    }
    if (response.status === 200 && looksLikeHtml(response)) {
        throw new CheckError('mirror', `${url} が HTML ページを返しました。ミラーがこのファイルを正しくプロキシしていません`);
    }
    if (response.status !== 200 && response.status !== 304 && response.status !== 404) {
        throw new CheckError('network', `${url} は ${String(response.status)} を返しました`);
    }
    return { status: response.status, text: response.text, etag: response.etag };
}
/**
 * Apply staged changes into the version in force.
 *
 * @param input - workspace, current state, the staged plan, the source, and the
 * paths the caller selected (all of them when omitted).
 * @returns the new state and the changes that landed.
 */
export function applyChanges(input) {
    const { workspace, state, plan, source } = input;
    const selected = resolveSelection(plan.changes, input.selected);
    const applied = [];
    const files = { ...state.files };
    const undo = {};
    for (const change of plan.changes) {
        if (selected !== undefined && !selected.has(change.path))
            continue;
        const current = workspace.slotPath('current', change.path);
        const previous = workspace.slotPath('previous', change.path);
        const staged = workspace.slotPath('staging', change.path);
        if (current === undefined || previous === undefined)
            continue;
        undo[change.path] = files[change.path] ?? null;
        if (change.kind === 'removed') {
            if (existsSync(current)) {
                mkdirSync(dirname(previous), { recursive: true });
                copyFileSync(current, previous);
                rmSync(current, { force: true });
            }
            delete files[change.path];
            applied.push(change);
            continue;
        }
        if (staged === undefined || !existsSync(staged))
            continue;
        if (existsSync(current)) {
            mkdirSync(dirname(previous), { recursive: true });
            copyFileSync(current, previous);
        }
        mkdirSync(dirname(current), { recursive: true });
        copyFileSync(staged, current);
        const prompt = plan.prompts.find((candidate) => candidate.file === change.path);
        const before = files[change.path];
        const sha1 = bodyHash(readFileSync(current, 'utf8'));
        const next = {
            id: change.id,
            enabled: prompt?.enabled ?? true,
            sha1,
        };
        // The id moved — a manifest that started declaring its own, or a file that
        // was renamed. Remember what it was, so the index can carry the title,
        // placement, and switch a person chose onto the id it has now.
        if (before !== undefined && before.id !== change.id)
            next.renamedFromId = before.id;
        const title = prompt?.title ?? undefined;
        if (title !== undefined)
            next.title = title;
        const order = prompt?.order ?? undefined;
        if (order !== undefined)
            next.order = order;
        // A validator only ever describes one body, so it is carried over exactly
        // when the body it validated is the one still in force: an id that moved
        // alone keeps the cheap conditional request, a changed body starts over.
        const etag = plan.etags[change.path] ?? (before?.sha1 === sha1 ? before.etag : undefined);
        if (etag !== undefined)
            next.etag = etag;
        files[change.path] = next;
        applied.push(change);
    }
    const next = {
        ref: source.ref,
        files,
        appliedAt: input.nowIso,
        manifestSha1: plan.manifestSha1,
        undo,
    };
    if (plan.headSha !== undefined)
        next.headSha = plan.headSha;
    else if (state.headSha !== undefined)
        next.headSha = state.headSha;
    if (state.headSha !== undefined)
        next.headShaPrevious = state.headSha;
    return { state: next, applied };
}
/**
 * The paths an apply should touch, with every rename pair completed.
 *
 * A rename reaches the plan as two changes that are really one move. Applying
 * only the new path would leave two state records claiming the same entry id, and
 * the index would then carry that entry twice; applying only the old one would
 * erase the id without putting the new body in its place — the entry would be
 * gone while the file that replaced it sits applied-but-unknown. So either both
 * sides of a pair land or neither does, whatever the caller selected.
 *
 * @param changes - the staged changes.
 * @param requested - paths the caller selected, or `undefined` for all of them.
 * @returns the paths to apply, or `undefined` when everything applies.
 */
function resolveSelection(changes, requested) {
    if (requested === undefined)
        return undefined;
    const selected = new Set(requested);
    for (const change of changes) {
        const mate = change.renamedTo ?? change.renamedFrom;
        if (mate === undefined)
            continue;
        if (!selected.has(mate) && !selected.has(change.path))
            continue;
        selected.add(change.path);
        selected.add(mate);
    }
    return selected;
}
/**
 * Put the version the last apply replaced back in force, guided by the apply's
 * undo ledger so a restored file also gets its title, placement, and switch back.
 *
 * @param input - workspace and current state.
 * @returns the restored state and the paths that moved back.
 */
export function revertChanges(input) {
    const { workspace, state } = input;
    const reverted = [];
    const files = { ...state.files };
    for (const [path, record] of Object.entries(state.undo ?? {})) {
        const current = workspace.slotPath('current', path);
        const previous = workspace.slotPath('previous', path);
        if (current === undefined || previous === undefined)
            continue;
        if (record === null) {
            rmSync(current, { force: true });
            delete files[path];
            reverted.push(path);
            continue;
        }
        if (!existsSync(previous))
            continue;
        mkdirSync(dirname(current), { recursive: true });
        copyFileSync(previous, current);
        rmSync(previous, { force: true });
        files[path] = record;
        reverted.push(path);
    }
    const next = { ref: state.ref, files };
    if (state.headShaPrevious !== undefined)
        next.headSha = state.headShaPrevious;
    const manifestSha1 = state.manifestSha1 ?? undefined;
    if (manifestSha1 !== undefined)
        next.manifestSha1 = manifestSha1;
    return { state: next, reverted };
}
/**
 * The entry title a manifest file should get on import.
 * @param source - owning source.
 * @param prompt - the manifest entry.
 * @returns a non-empty display title.
 */
export function titleFor(source, prompt) {
    if (prompt.title !== undefined && prompt.title.length > 0)
        return prompt.title;
    if (prompt.id !== undefined && prompt.id.length > 0)
        return prompt.id;
    return stemOf(prompt.file);
}
//# sourceMappingURL=sync.js.map