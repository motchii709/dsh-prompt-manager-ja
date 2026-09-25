#!/usr/bin/env node
/**
 * Route test: the `/dsh-prompt-manager` prefix route the settings page edits
 * bodies through.
 *
 * The handler is driven directly with fake request and response objects, so the
 * test covers what the browser cannot be trusted to decide: the loopback gate,
 * same-origin enforcement on writes, path and id validation, the optimistic
 * write fence, and the status codes each failure earns.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { installPromptRoutes, ROUTE_PREFIX } from '../lib/routes.js'
import { SessionChoices } from '../lib/sessions.js'
import { PromptStore } from '../lib/store.js'
import { entryIdFor, MAX_ENTRIES, MAX_PRESETS } from '../lib/entries.js'
import { MAX_PACK_BYTES } from '../lib/pack.js'
import { MAX_SOURCES } from '../lib/source.js'
import { CheckError } from '../lib/sync.js'
import { ScriptError } from '../lib/scripts.js'

/** Throwaway root for the whole run. */
const ROOT = mkdtempSync(join(tmpdir(), 'prompt-manager-routes-'))
/** Directory the store owns. */
const SECTIONS = join(ROOT, 'sections')

/**
 * Build one fake request.
 * @param options - method, url, peer address, headers, and raw body.
 * @returns an object good enough for the route handler.
 */
function fakeRequest(options) {
  const chunks = options.body === undefined ? [] : [Buffer.from(options.body, 'utf8')]
  const headers = {}
  if (options.origin !== undefined) headers.origin = options.origin
  headers.host = options.host ?? '127.0.0.1:3080'
  return {
    method: options.method ?? 'GET',
    url: options.url,
    headers,
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/**
 * Build one fake response that records what the handler wrote.
 * @returns the response plus its captured state.
 */
function fakeResponse() {
  const state = { status: 0, headers: {}, body: '' }
  return {
    state,
    setHeader(name, value) {
      state.headers[name.toLowerCase()] = value
    },
    writeHead(status, headers) {
      state.status = status
      Object.assign(state.headers, headers)
    },
    end(body) {
      state.body = body ?? ''
    },
    json() {
      return JSON.parse(state.body)
    },
  }
}

try {
  const store = new PromptStore(SECTIONS)
  const warnings = []
  const routes = []
  /** Preset ids the fake host reports; a case below fills it to reach the cap. */
  const presetIds = { held: [] }

  /** One canned pack, and what the fake host records about the pack routes. */
  const samplePack = {
    format: 'dsh-prompt-manager-pack',
    version: 1,
    exportedAt: '2026-09-12T00:00:00.000Z',
    generator: { plugin: 'dsh-prompt-manager', pluginVersion: '9.9.9' },
    preset: { id: 'ctf', name: 'ctf', entries: ['env'] },
    entries: [{ id: 'env', title: '本机环境', order: 5, enabled: true, origin: 'local', body: '# Machine environment\n' }],
    missing: [],
  }
  const packs = {
    /** Preset ids the export route asked about, in order. */
    served: [],
    /** Packs the import route handed to the engine. */
    imports: [],
    /** Which preset ids have a pack to serve. */
    available: new Map(),
    /** When set, `importPack` refuses with it instead of creating anything. */
    refusal: null,
  }
  /**
   * A composition, modelled the way cordis actually behaves.
   *
   * Rows are siblings: each one provides its services into the composition, and
   * a plugin only ever sees the ones it *declared*. Reading anything else throws
   * `cannot get property "x" without inject` — which is exactly what the real
   * `web` profile does to a route that tries to poke at `connection` without
   * asking for it. A service mounted after the plugin mounted reaches the plugin
   * that declared it, which is what "read live" has to mean.
   *
   * @returns the composition: its routes, the trust authority's log, a mount for
   * that authority, and a caller bound to the registered handler.
   */
  function compose() {
    const provided = new Map([
      ['webServer', { register: (route) => { routes.push(route); return () => {} } }],
    ])
    const waiting = []
    const asked = []

    /** The scope one `inject` callback receives: declared names only. */
    const scopeFor = (deps) => new Proxy({}, {
      get: (_target, prop) => {
        if (typeof prop !== 'string' || !deps.includes(prop) || !provided.has(prop)) {
          throw new Error(`cannot get property ${JSON.stringify(String(prop))} without inject`)
        }
        return provided.get(prop)
      },
    })

    /** Mount one service, and wake every inject that was waiting on it. */
    const provide = (name, value) => {
      provided.set(name, value)
      for (let index = waiting.length - 1; index >= 0; index -= 1) {
        if (!waiting[index].deps.every((dep) => provided.has(dep))) continue
        const [entry] = waiting.splice(index, 1)
        entry.callback(scopeFor(entry.deps))
      }
    }

    installPromptRoutes({
      inject: (deps, callback) => {
        if (deps.every((dep) => provided.has(dep))) {
          callback(scopeFor(deps))
          return () => {}
        }
        waiting.push({ deps, callback })
        return () => {}
      },
      effect: (execute) => {
        const disposer = execute()
        return typeof disposer === 'function' ? disposer : () => {}
      },
    }, host)

    return {
      asked,
      /** Mount the harness's browser trust, the way the `connection` row does. */
      mountTrust: (answer) => provide('connection', {
        requestRejection: (request) => { asked.push(request); return answer(request) },
      }),
      call: async (options) => {
        const response = fakeResponse()
        await routes.at(-1).handler(fakeRequest(options), response)
        return response
      },
    }
  }

  /** What the fake engine recorded, and how it answers. */
  const engine = {
    calls: [],
    /** Sources the engine reports as configured; the add route allocates against these. */
    configured: [{ id: 'src-a', repo: 'o/r', ref: 'main', mirror: '', enabled: true, files: 2, pending: 1 }],
    list: () => engine.configured,
    check: async (slug) => {
      engine.calls.push({ action: 'check', slug })
      if (slug === 'nope') throw new CheckError('unknown-source', '没有这个订阅源：nope')
      if (slug === 'closed') throw new CheckError('disabled', 'closed 已关闭：在设置页打开它，或删掉它，再对上游做操作')
      return { slug, upToDate: false, headSha: 'a'.repeat(40), changes: [{ path: 'p/a.md', id: 'src-a-a', kind: 'changed', added: 2, removed: 1 }], prompts: [], warnings: [] }
    },
    apply: async (slug, files) => {
      if (slug === 'stale') throw new CheckError('nothing-staged', 'src-a 还没有检查结果')
      engine.calls.push({ action: 'apply', slug, files })
      return { slug, applied: [], entries: [] }
    },
    revert: async (slug) => {
      engine.calls.push({ action: 'revert', slug })
      return { slug, reverted: ['p/a.md'], entries: [] }
    },
    remove: async (slug) => {
      engine.calls.push({ action: 'remove', slug })
      return { slug, entries: [] }
    },
  }

  /** One canned run report, as the engine hands it back. */
  const report = (variables, extra = {}) => ({
    name: 'draft',
    ok: true,
    exitCode: 0,
    ms: 62,
    variables,
    truncated: [],
    problems: [],
    warnings: [],
    stdout: JSON.stringify(variables),
    stderr: '',
    ...extra,
  })

  /** The script names the fake engine accepts, mirroring the real grammar. */
  const scriptName = /^[a-z0-9][a-z0-9-]*$/

  /** What the fake script engine recorded, and how it answers. */
  const scripts = {
    calls: [],
    dir: join(ROOT, 'scripts'),
    list: () => [{
      name: 'toolchain',
      sha1: 'a'.repeat(40),
      variables: ['rust', 'go'],
      ranAt: '2026-09-11T00:00:00.000Z',
      exitCode: 0,
      ms: 62,
      pending: false,
    }],
    read: (name) => (name === 'toolchain' ? { source: 'console.log("{}")', sha1: 'a'.repeat(40) } : undefined),
    run: async (name) => {
      scripts.calls.push({ action: 'run', name })
      if (name !== 'toolchain') throw new ScriptError('unknown-script', `没有这个脚本：${name}`)
      return report({ rust: '1.80.0' })
    },
    runSource: async (name, source) => {
      scripts.calls.push({ action: 'runSource', name, source })
      if (!scriptName.test(name)) throw new ScriptError('invalid-name', `${JSON.stringify(name)} 不是一个可用的脚本名`)
      return report({ rust: '1.80.0' })
    },
    refresh: async () => {
      scripts.calls.push({ action: 'refresh' })
      return [report({ rust: '1.80.0' })]
    },
    save: async (name, source, fence) => {
      scripts.calls.push({ action: 'save', name, fence })
      if (!scriptName.test(name)) throw new ScriptError('invalid-name', `${JSON.stringify(name)} 不是一个可用的脚本名`)
      if (name === 'taken') throw new ScriptError('conflict', '变量名已被占用：rust（属于 environment）')
      if (name === 'broken') throw new ScriptError('invalid-output', '输出不是合法 JSON', report({}, { ok: false, problems: ['输出不是合法 JSON'] }))
      if (fence.kind === 'sha1' && fence.sha1 !== 'a'.repeat(40)) throw new ScriptError('conflict', 'toolchain.js changed on disk while this draft was open')
      return { name, sha1: 'b'.repeat(40), variables: { rust: '1.80.0' }, report: report({ rust: '1.80.0' }) }
    },
    remove: (name) => {
      scripts.calls.push({ action: 'remove', name })
      return name === 'toolchain'
    },
  }

  /** What the compaction seam reports; `undefined` means the feature is off here. */
  let compactionStats

  /** The host half the route drives; reused by every composition below. */
  const host = {
    store,
    // The real host hands the live per-session store in; the route only ever reads
    // and writes files through it, so the real one is what a test should drive.
    sessions: new SessionChoices(ROOT),
    describe: (id) => {
      if (id === 'src-a-a') return { text: 'SUBSCRIBED', source: 'subscribed' }
      // The real host swallows an unusable id here and answers an empty body:
      // refusing one is the dispatcher's job, not this hook's.
      try {
        const stored = store.read(id)
        return stored === undefined
          ? { text: '', source: 'empty' }
          : { text: stored.body, source: 'user' }
      } catch {
        return { text: '', source: 'empty' }
      }
    },
    idFor: (title) => entryIdFor(title, store.ids()),
    /** Preset ids in force; the preset-id route allocates against these. */
    presetIds: () => presetIds.held,
    warn: (message) => warnings.push(message),
    subscriptions: engine,
    scripts,
    variables: () => [
      { name: 'os', value: 'Windows', source: 'environment', updatedAt: '2026-09-11T00:00:00.000Z', referencedBy: ['环境'] },
      { name: 'node', value: '24.18.0', source: 'probe', updatedAt: '2026-09-11T00:00:00.000Z', referencedBy: [] },
    ],
    packFor: (presetId) => {
      packs.served.push(presetId)
      return packs.available.get(presetId)
    },
    importPack: async (pack) => {
      packs.imports.push(pack)
      if (packs.refusal !== null) return { ok: false, ...packs.refusal }
      return {
        ok: true,
        report: {
          entries: [{ id: 'env', title: '本机环境' }],
          preset: { id: 'ctf', name: 'ctf', entries: ['env'], compaction: '' },
          renamed: [],
          noBody: [],
          sourceDropped: [],
          missingMembers: [],
          unregistered: [],
        },
      }
    },
    compaction: () => compactionStats,
  }

  const composition = compose()

  assert.equal(routes.length, 1, 'the plugin must register exactly one route')
  assert.equal(routes[0].kind, 'prefix', 'the route must be a prefix route')
  assert.equal(routes[0].path, ROUTE_PREFIX, 'the route must live under the documented prefix')
  const handler = routes[0].handler

  /**
   * Call the handler once.
   * @param options - fake request options.
   * @returns the captured response state.
   */
  async function call(options) {
    const response = fakeResponse()
    await handler(fakeRequest(options), response)
    return response
  }

  // ── reads ───────────────────────────────────────────────────────────────────

  const status = await call({ url: `${ROUTE_PREFIX}/status` })
  assert.equal(status.state.status, 200, 'status must answer 200')
  assert.equal(status.json().dir, SECTIONS, 'status must report the body directory')
  assert.equal(status.json().maxEntries, MAX_ENTRIES, 'status must report the entry cap the page has to respect')
  assert.deepEqual(
    status.json().variables,
    { os: 'Windows', node: '24.18.0' },
    'status must report the prompt variables in force, so a deployment can check what the probes measured',
  )
  assert.equal(
    'compaction' in status.json(),
    false,
    'a deployment that switched the compaction seam off must report nothing about it, rather than zeros that read as "on"',
  )

  // Whether a compaction instruction was ever substituted is the one thing the
  // page cannot work out for itself: the summary simply comes back looking as if
  // it were written to a different template, and nothing in the session says
  // otherwise. So the counters are reported here, live, per request.
  compactionStats = { matches: 3, replacements: 2, lastReplacedAt: '2026-09-12T01:02:03.000Z', characters: 812 }
  const seam = await call({ url: `${ROUTE_PREFIX}/status` })
  assert.deepEqual(
    seam.json().compaction,
    { matches: 3, replacements: 2, lastReplacedAt: '2026-09-12T01:02:03.000Z', characters: 812 },
    'status must report what the compaction seam has done since this mount',
  )
  compactionStats = undefined
  assert.equal(
    'compaction' in (await call({ url: `${ROUTE_PREFIX}/status` })).json(),
    false,
    'and the reading must be live: switching it off takes the field away on the next request',
  )

  const bodyless = await call({ url: `${ROUTE_PREFIX}/body/nobody` })
  assert.equal(bodyless.json().body, '', 'an entry with no body file must report an empty body')
  assert.equal(bodyless.json().source, 'empty', 'and must be labelled empty')
  assert.equal(bodyless.json().fileSha1, null, 'an entry without a body file must report no file hash')

  // ── writes, escapes, and fencing ────────────────────────────────────────────

  const created = await call({
    method: 'PUT',
    url: `${ROUTE_PREFIX}/body/draft`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({ body: 'EDITED', fileSha1: null }),
  })
  assert.equal(created.state.status, 200, 'a fenced create must succeed')
  assert.equal(created.json().source, 'user', 'the answered view must read the stored body')
  assert.equal(store.read('draft').body, 'EDITED', 'the body must land on disk')

  const replayed = await call({
    method: 'PUT',
    url: `${ROUTE_PREFIX}/body/draft`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({ body: 'SECOND-EDIT', fileSha1: null }),
  })
  assert.equal(replayed.state.status, 409, 'a draft that saw no file must not overwrite one that appeared')

  const stale = await call({
    method: 'PUT',
    url: `${ROUTE_PREFIX}/body/draft`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({ body: 'STALE', fileSha1: 'deadbeef' }),
  })
  assert.equal(stale.state.status, 409, 'a stale hash must be refused')

  const current = store.read('draft').sha1
  const updated = await call({
    method: 'PUT',
    url: `${ROUTE_PREFIX}/body/draft`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({ body: 'THIRD-EDIT', fileSha1: current }),
  })
  assert.equal(updated.state.status, 200, 'a matching hash must write')

  const deleted = await call({
    method: 'DELETE',
    url: `${ROUTE_PREFIX}/body/draft`,
    origin: 'http://127.0.0.1:3080',
  })
  assert.equal(deleted.json().removed, true, 'deleting a body file must report it was removed')
  assert.equal(deleted.json().body, '', 'the view must fall back to an empty body')
  assert.equal(deleted.json().source, 'empty', 'and report the entry as empty')
  assert.equal(store.has('draft'), false, 'the body file must be gone')

  // ── gates ───────────────────────────────────────────────────────────────────

  const remote = await call({ url: `${ROUTE_PREFIX}/status`, remoteAddress: '192.168.1.5' })
  assert.equal(remote.state.status, 403, 'a non-loopback peer must be refused')

  // A name that resolves to this machine arrives from a loopback peer and brings
  // an origin of its own, so the requested host name is the gate that holds.
  const rebound = await call({ url: `${ROUTE_PREFIX}/status`, host: 'evil.example:3080', origin: 'http://evil.example:3080' })
  assert.equal(rebound.state.status, 403, 'a non-loopback host name must be refused even from a loopback peer')
  assert.equal(rebound.json().code, 'host-not-loopback', 'and the refusal must say why')
  const reboundWrite = await call({
    method: 'PUT',
    url: `${ROUTE_PREFIX}/body/note`,
    host: 'evil.example:3080',
    origin: 'http://evil.example:3080',
    body: JSON.stringify({ body: 'X', fileSha1: null }),
  })
  assert.equal(reboundWrite.state.status, 403, 'a rebound write must be refused even when its origin matches its host')
  assert.equal(store.has('note'), false, 'and it must not touch the disk')
  for (const host of ['127.0.0.1:3080', 'localhost:3080', '[::1]:3080', '127.0.0.1']) {
    const allowed = await call({ url: `${ROUTE_PREFIX}/status`, host })
    assert.equal(allowed.state.status, 200, `${host} must be accepted as a loopback host name`)
  }

  // ── the LAN deployment: the harness's own browser trust decides ─────────────
  // `dsh web` behind @lolkda/dsh-web-lan binds 0.0.0.0 and hands the browser a
  // session cookie, so the page opened from another device is authenticated but
  // not loopback. The store has to ride the same decision `/api` rides: without
  // that, every store call is refused and the settings page shows the raw
  // refusal instead of bodies, variables, sources and presets.
  const lan = compose()
  lan.mountTrust(() => undefined)
  const lanRead = await lan.call({
    url: `${ROUTE_PREFIX}/status`,
    remoteAddress: '192.168.1.5',
    host: '192.168.1.100:3080',
    origin: 'http://192.168.1.100:3080',
  })
  assert.equal(lanRead.state.status, 200, 'a LAN page whose session the harness accepts must reach the store')
  assert.equal(lanRead.json().dir, SECTIONS, 'and must get the same answer a loopback page gets')
  assert.equal(lan.asked.length, 1, 'the harness must be the thing that decided')

  const lanWrite = await lan.call({
    method: 'PUT',
    url: `${ROUTE_PREFIX}/body/lan-note`,
    remoteAddress: '192.168.1.5',
    host: '192.168.1.100:3080',
    origin: 'http://192.168.1.100:3080',
    body: JSON.stringify({ body: 'FROM-THE-LAN', fileSha1: null }),
  })
  assert.equal(lanWrite.state.status, 200, 'an accepted session may write')
  assert.equal(store.read('lan-note').body, 'FROM-THE-LAN', 'and the body lands on disk')

  const lanCrossOrigin = await lan.call({
    method: 'PUT',
    url: `${ROUTE_PREFIX}/body/lan-note`,
    remoteAddress: '192.168.1.5',
    host: '192.168.1.100:3080',
    origin: 'http://evil.example',
    body: JSON.stringify({ body: 'NOPE', fileSha1: null }),
  })
  assert.equal(lanCrossOrigin.state.status, 403, 'an accepted session still owes same-origin on a write')
  assert.equal(store.read('lan-note').body, 'FROM-THE-LAN', 'and a cross-origin write changes nothing')

  const noSession = compose()
  noSession.mountTrust(() => 401)
  const noSessionRead = await noSession.call({
    url: `${ROUTE_PREFIX}/status`,
    remoteAddress: '192.168.1.5',
    host: '192.168.1.100:3080',
  })
  assert.equal(noSessionRead.state.status, 401, 'a LAN page without a session is told to get one, not told to come back on loopback')
  assert.equal(noSessionRead.json().code, 'no-session', 'and the refusal names the missing session')

  const foreignHost = compose()
  foreignHost.mountTrust(() => 403)
  const foreignRead = await foreignHost.call({
    url: `${ROUTE_PREFIX}/status`,
    remoteAddress: '10.0.0.5',
    host: 'evil.example:3080',
  })
  assert.equal(foreignRead.state.status, 403, 'a Host the deployment does not serve stays refused')
  assert.equal(foreignRead.json().code, 'host-not-trusted', 'and the refusal says which rule held')

  // A loopback peer keeps the strict local path: a rebound name is refused
  // before the harness is ever asked, even when the harness would accept it.
  const askedBefore = lan.asked.length
  const localRebound = await lan.call({ url: `${ROUTE_PREFIX}/status`, host: 'evil.example:3080', origin: 'http://evil.example:3080' })
  assert.equal(localRebound.state.status, 403, 'a loopback peer with a rebound Host is refused')
  assert.equal(localRebound.json().code, 'host-not-loopback', 'and the refusal names the host rule')
  assert.equal(lan.asked.length, askedBefore, 'the harness must not be consulted for a loopback request')

  // The authority is read per request, so a Connection mounted after the route
  // was registered still admits (and fences) later requests.
  const late = compose()
  const beforeMount = await late.call({
    url: `${ROUTE_PREFIX}/status`,
    remoteAddress: '192.168.1.5',
    host: '192.168.1.100:3080',
  })
  assert.equal(beforeMount.state.status, 403, 'a composition with no trust authority stays loopback-only')
  assert.equal(beforeMount.json().code, 'no-trust-authority', 'and says which rule held')
  late.mountTrust(() => undefined)
  const afterMount = await late.call({
    url: `${ROUTE_PREFIX}/status`,
    remoteAddress: '192.168.1.5',
    host: '192.168.1.100:3080',
  })
  assert.equal(afterMount.state.status, 200, 'a Connection mounted later is picked up on the next request')

  // The route must reach the authority the way the composition offers it: a
  // sibling row's service is only visible to a plugin that declared it. Poking
  // at the scope for a name nobody asked for throws, and a route that swallowed
  // that would refuse every LAN request with no-trust-authority — which is
  // exactly what shipped once.
  const declared = compose()
  declared.mountTrust(() => undefined)
  const declaredRead = await declared.call({
    url: `${ROUTE_PREFIX}/status`,
    remoteAddress: '192.168.1.5',
    host: '192.168.1.100:3080',
  })
  assert.equal(declaredRead.state.status, 200, 'the trust authority must be reached by declaring it, not by reaching into the webServer scope')

  const crossOrigin = await call({
    method: 'PUT',
    url: `${ROUTE_PREFIX}/body/note`,
    origin: 'http://evil.example',
    body: JSON.stringify({ body: 'X', fileSha1: null }),
  })
  assert.equal(crossOrigin.state.status, 403, 'a cross-origin write must be refused')
  assert.equal(store.has('note'), false, 'a refused write must not touch the disk')

  const traversal = await call({ url: `${ROUTE_PREFIX}/body/${encodeURIComponent('../secrets')}` })
  assert.equal(traversal.state.status, 400, 'a traversal id must be refused before it reaches the filesystem')
  assert.equal(traversal.json().code, 'invalid-id', 'and the refusal must name the id grammar')
  for (const bad of ['UPPER', 'not%20an%20id', '.dot', 'nobody%2Fx']) {
    const refused = await call({ url: `${ROUTE_PREFIX}/body/${bad}` })
    assert.equal(refused.state.status, 400, `GET ${bad} must be refused: every method agrees on an unusable id`)
  }
  const refusedScript = await call({ url: `${ROUTE_PREFIX}/script/${encodeURIComponent('a/b')}` })
  assert.equal(refusedScript.state.status, 400, 'an unusable script name must be refused before it reaches the disk')

  const oversized = await call({
    method: 'PUT',
    url: `${ROUTE_PREFIX}/body/note`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({ body: 'x'.repeat(1024 * 1024) }),
  })
  assert.equal(oversized.state.status, 400, 'an oversized request must be refused')

  const wrongMethod = await call({ method: 'PATCH', url: `${ROUTE_PREFIX}/body/note`, origin: 'http://127.0.0.1:3080' })
  assert.equal(wrongMethod.state.status, 405, 'an unsupported method must be refused')

  // ── references the registry could never interpolate ─────────────────────────

  const malformed = await call({
    method: 'PUT',
    url: `${ROUTE_PREFIX}/body/note`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({ body: '模板写成 {{ x }} 就会炸', fileSha1: null }),
  })
  assert.equal(malformed.state.status, 422, 'a body carrying an unusable reference must be refused')
  assert.equal(malformed.json().code, 'malformed-reference', 'and the refusal must name the reason')
  assert.deepEqual(malformed.json().references, ['{{ x }}'], 'and list the references it found')
  assert.equal(store.has('note'), false, 'a refused reference must never reach the disk')

  const unregistered = await call({
    method: 'PUT',
    url: `${ROUTE_PREFIX}/body/note`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({ body: '还没注册的名字 {{not_yet}} 允许保存', fileSha1: null }),
  })
  assert.equal(unregistered.state.status, 200, 'a well-formed but unregistered name is still saved: the assembly guard covers it')
  assert.equal(store.has('note'), true, 'and it reaches the disk')
  store.remove('note')

  const unknown = await call({ url: `${ROUTE_PREFIX}/nope` })
  assert.equal(unknown.state.status, 404, 'an unknown path must 404')

  // ── id allocation ───────────────────────────────────────────────────────────

  const allocated = await call({
    method: 'POST',
    url: `${ROUTE_PREFIX}/id`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({ title: 'My Note' }),
  })
  assert.equal(allocated.json().id, 'my-note', 'the id route must slug the title')

  writeFileSync(join(SECTIONS, 'my-note.md'), 'exists', 'utf8')
  const again = await call({
    method: 'POST',
    url: `${ROUTE_PREFIX}/id`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({ title: 'My Note' }),
  })
  assert.equal(again.json().id, 'my-note-2', 'the id route must avoid stored ids')

  // ── preset id allocation ────────────────────────────────────────────────────

  // A preset rides the settings namespace like the entry index, so this route is
  // only ever asked for the one thing the page cannot know: which id is free.
  const allocatedPreset = await call({
    method: 'POST',
    url: `${ROUTE_PREFIX}/preset/id`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({ title: 'CTF 作业' }),
  })
  assert.equal(allocatedPreset.state.status, 200, 'the preset id route must answer')
  assert.equal(allocatedPreset.json().id, 'ctf', 'the preset id route must slug the title')

  presetIds.held = ['ctf']
  const secondPreset = await call({
    method: 'POST',
    url: `${ROUTE_PREFIX}/preset/id`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({ title: 'CTF 作业' }),
  })
  assert.equal(secondPreset.json().id, 'ctf-2', 'the route must avoid the preset ids already in force')

  const unromanizable = await call({
    method: 'POST',
    url: `${ROUTE_PREFIX}/preset/id`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({ title: '作业' }),
  })
  assert.equal(unromanizable.json().id, 'entry', 'a title with no ASCII at all must still get a usable id')

  const untitled = await call({
    method: 'POST',
    url: `${ROUTE_PREFIX}/preset/id`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({ title: '   ' }),
  })
  assert.equal(untitled.state.status, 400, 'a blank title must be refused')

  presetIds.held = Array.from({ length: MAX_PRESETS }, (unused, index) => `p${String(index)}`)
  const cappedPresets = await call({
    method: 'POST',
    url: `${ROUTE_PREFIX}/preset/id`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({ title: 'Overflow' }),
  })
  assert.equal(cappedPresets.state.status, 409, 'the preset cap must refuse an allocation')
  assert.equal(cappedPresets.json().code, 'too-many-presets', 'and the cap reports its own reason')
  presetIds.held = []

  // ── subscription sources ────────────────────────────────────────────────────

  const listed = await call({ url: `${ROUTE_PREFIX}/sources` })
  assert.equal(listed.state.status, 200, 'the source list answers')
  assert.equal(listed.json().sources[0].id, 'src-a', 'the list carries the configured source')

  // ── adding a source ─────────────────────────────────────────────────────────

  const added = await call({
    method: 'POST',
    url: `${ROUTE_PREFIX}/sources`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({ repo: 'lolkda/dsh-prompt-pack', ref: 'main' }),
  })
  assert.equal(added.state.status, 200, 'adding a source answers 200')
  assert.equal(added.json().id, 'lolkda-dsh-prompt-pack', 'the slug is derived from owner/name')
  assert.equal(added.json().repo, 'lolkda/dsh-prompt-pack', 'the Host echoes the validated repository')
  assert.equal(added.json().mirror, '', 'an absent mirror means inherit the global one')
  engine.configured = [...engine.configured, {
    id: added.json().id,
    repo: added.json().repo,
    ref: added.json().ref,
    mirror: added.json().mirror,
    enabled: true,
    files: 0,
    pending: 0,
  }]

  const duplicated = await call({
    method: 'POST',
    url: `${ROUTE_PREFIX}/sources`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({ repo: 'lolkda/dsh-prompt-pack', ref: 'main' }),
  })
  assert.equal(duplicated.state.status, 409, 'one repository and ref cannot be subscribed twice')
  assert.equal(duplicated.json().code, 'duplicate-source', 'and the reason is machine-readable')

  const otherRef = await call({
    method: 'POST',
    url: `${ROUTE_PREFIX}/sources`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({ repo: 'lolkda/dsh-prompt-pack', ref: 'dev' }),
  })
  assert.equal(otherRef.json().id, 'lolkda-dsh-prompt-pack-2', 'a taken slug gets a numeric suffix')

  const mirrored = await call({
    method: 'POST',
    url: `${ROUTE_PREFIX}/sources`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({ repo: 'o/r2', mirror: 'https://gh-proxy.example/' }),
  })
  assert.equal(mirrored.json().ref, 'main', 'an omitted ref defaults to the branch the schema names')
  assert.equal(mirrored.json().mirror, 'https://gh-proxy.example', 'the mirror is normalized before it is stored')

  for (const [label, payload] of [
    ['a bare owner', { repo: 'lolkda' }],
    ['a third path segment', { repo: 'a/b/c' }],
    ['a traversal ref', { repo: 'o/r', ref: '../evil' }],
    ['a non-string ref', { repo: 'o/r', ref: 7 }],
    ['an http mirror', { repo: 'o/r', mirror: 'http://plain.example' }],
    ['a credentialed mirror', { repo: 'o/r', mirror: 'https://user:pass@host' }],
  ]) {
    const refused = await call({
      method: 'POST',
      url: `${ROUTE_PREFIX}/sources`,
      origin: 'http://127.0.0.1:3080',
      body: JSON.stringify(payload),
    })
    assert.equal(refused.state.status, 400, `${label} must be refused`)
  }

  const notAnObject = await call({
    method: 'POST',
    url: `${ROUTE_PREFIX}/sources`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify('lolkda/dsh-prompt-pack'),
  })
  assert.equal(notAnObject.state.status, 400, 'a body that is not a JSON object is refused')

  const crossOriginAdd = await call({
    method: 'POST',
    url: `${ROUTE_PREFIX}/sources`,
    origin: 'http://evil.example',
    body: JSON.stringify({ repo: 'o/r3' }),
  })
  assert.equal(crossOriginAdd.state.status, 403, 'a cross-origin add is refused')

  const filled = engine.configured
  engine.configured = Array.from({ length: MAX_SOURCES }, (_, index) => ({
    id: `src-${String(index)}`,
    repo: `o/r${String(index)}`,
    ref: 'main',
    mirror: '',
    enabled: true,
    files: 0,
    pending: 0,
  }))
  const capped = await call({
    method: 'POST',
    url: `${ROUTE_PREFIX}/sources`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({ repo: 'o/one-too-many' }),
  })
  assert.equal(capped.state.status, 409, 'the source cap is enforced')
  assert.equal(capped.json().code, 'too-many-sources', 'and the cap reports its own reason')
  engine.configured = filled

  const checked = await call({ method: 'POST', url: `${ROUTE_PREFIX}/sources/src-a/check`, origin: 'http://127.0.0.1:3080' })
  assert.equal(checked.state.status, 200, 'a check answers 200')
  assert.equal(checked.json().changes[0].kind, 'changed', 'the check reports what moved')

  const appliedSource = await call({
    method: 'POST',
    url: `${ROUTE_PREFIX}/sources/src-a/apply`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({ files: ['p/a.md'] }),
  })
  assert.equal(appliedSource.state.status, 200, 'an apply answers 200')
  assert.deepEqual(engine.calls.at(-1), { action: 'apply', slug: 'src-a', files: ['p/a.md'] }, 'the selected files reach the engine')

  const reverted = await call({ method: 'POST', url: `${ROUTE_PREFIX}/sources/src-a/revert`, origin: 'http://127.0.0.1:3080' })
  assert.equal(reverted.json().reverted[0], 'p/a.md', 'a revert answers what moved back')

  const unknownSource = await call({ method: 'POST', url: `${ROUTE_PREFIX}/sources/nope/check`, origin: 'http://127.0.0.1:3080' })
  assert.equal(unknownSource.state.status, 404, 'an unknown source is a 404')
  const nothingStaged = await call({ method: 'POST', url: `${ROUTE_PREFIX}/sources/stale/apply`, origin: 'http://127.0.0.1:3080' })
  assert.equal(nothingStaged.state.status, 409, 'applying without a check result is a 409')
  const closed = await call({ method: 'POST', url: `${ROUTE_PREFIX}/sources/closed/check`, origin: 'http://127.0.0.1:3080' })
  assert.equal(closed.state.status, 409, 'a switched-off source is a 409')
  assert.equal(closed.json().code, 'disabled', 'and the refusal says the source is switched off')

  const badSlug = await call({ url: `${ROUTE_PREFIX}/sources/BAD_SLUG/check` })
  assert.equal(badSlug.state.status, 400, 'an unusable slug never reaches the engine')

  const crossOriginCheck = await call({
    method: 'POST',
    url: `${ROUTE_PREFIX}/sources/src-a/check`,
    origin: 'http://evil.example',
  })
  assert.equal(crossOriginCheck.state.status, 403, 'a cross-origin check is refused')

  const removedSource = await call({ method: 'DELETE', url: `${ROUTE_PREFIX}/sources/src-a`, origin: 'http://127.0.0.1:3080' })
  assert.equal(removedSource.state.status, 200, 'forgetting a source answers 200')
  assert.equal(engine.calls.at(-1).action, 'remove', 'the engine is asked to forget it')

  const subscribedWrite = await call({
    method: 'PUT',
    url: `${ROUTE_PREFIX}/body/src-a-a`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({ body: 'NOPE', fileSha1: null }),
  })
  assert.equal(subscribedWrite.state.status, 403, 'a subscribed body is refused a write')
  assert.equal(store.has('src-a-a'), false, 'and nothing reaches the disk')

  // ── the variable and script routes ──────────────────────────────────────────

  const variables = await call({ url: `${ROUTE_PREFIX}/variables` })
  assert.equal(variables.state.status, 200, 'the variable list answers 200')
  assert.equal(variables.json().variables[0].source, 'environment', 'each variable reports which layer supplied it')
  assert.deepEqual(variables.json().variables[0].referencedBy, ['环境'], 'and which entries reference it, so a delete can warn first')
  assert.equal(variables.json().scripts[0].name, 'toolchain', 'the list carries the scripts beside the variables')
  assert.equal(variables.json().dir, scripts.dir, 'and the directory the scripts live in')

  const draftRun = await call({
    method: 'POST',
    url: `${ROUTE_PREFIX}/variables/run`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({ name: 'toolchain', source: 'console.log("{}")' }),
  })
  assert.equal(draftRun.state.status, 200, 'a test run answers 200')
  assert.equal(draftRun.json().variables.rust, '1.80.0', 'and reports the variables the draft would supply')
  assert.equal(scripts.calls.at(-1).action, 'runSource', 'a draft goes through the draft path, which registers nothing')

  const savedRun = await call({
    method: 'POST',
    url: `${ROUTE_PREFIX}/variables/run`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({ name: 'toolchain' }),
  })
  assert.equal(savedRun.state.status, 200, 'running a saved script answers 200')
  assert.equal(scripts.calls.at(-1).action, 'run', 'and runs the file rather than a draft')

  const namelessRun = await call({ method: 'POST', url: `${ROUTE_PREFIX}/variables/run`, origin: 'http://127.0.0.1:3080', body: '{}' })
  assert.equal(namelessRun.state.status, 400, 'a run with neither a name nor a source is refused')
  const unknownRun = await call({
    method: 'POST',
    url: `${ROUTE_PREFIX}/variables/run`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({ name: 'nope' }),
  })
  assert.equal(unknownRun.state.status, 404, 'running a script that does not exist is a 404')

  const refreshed = await call({ method: 'POST', url: `${ROUTE_PREFIX}/variables/refresh`, origin: 'http://127.0.0.1:3080' })
  assert.equal(refreshed.json().reports.length, 1, 'a refresh reports every run it made')
  const unknownVariableRoute = await call({ method: 'POST', url: `${ROUTE_PREFIX}/variables/nope`, origin: 'http://127.0.0.1:3080' })
  assert.equal(unknownVariableRoute.state.status, 404, 'an unknown variable route is a 404')
  const variablesPost = await call({ method: 'POST', url: `${ROUTE_PREFIX}/variables`, origin: 'http://127.0.0.1:3080' })
  assert.equal(variablesPost.state.status, 405, 'a POST on the variable list is refused')

  const scriptRead = await call({ url: `${ROUTE_PREFIX}/script/toolchain` })
  assert.equal(scriptRead.json().sha1, 'a'.repeat(40), 'a script read reports the hash the next write must fence against')
  const missingScript = await call({ url: `${ROUTE_PREFIX}/script/nope` })
  assert.equal(missingScript.state.status, 404, 'an unknown script is a 404')

  const scriptWrite = await call({
    method: 'PUT',
    url: `${ROUTE_PREFIX}/script/toolchain`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({ source: 'console.log("{}")', fileSha1: 'a'.repeat(40) }),
  })
  assert.equal(scriptWrite.state.status, 200, 'saving a script answers 200')
  assert.equal(scriptWrite.json().variables.rust, '1.80.0', 'and reports the variables that are now in force')
  assert.deepEqual(scripts.calls.at(-1).fence, { kind: 'sha1', sha1: 'a'.repeat(40) }, 'the hash the page read becomes the fence')

  await call({
    method: 'PUT',
    url: `${ROUTE_PREFIX}/script/fresh`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({ source: 'console.log("{}")', fileSha1: null }),
  })
  assert.deepEqual(scripts.calls.at(-1).fence, { kind: 'absent' }, 'a brand-new script must find no file at all')

  const conflicted = await call({
    method: 'PUT',
    url: `${ROUTE_PREFIX}/script/taken`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({ source: 'console.log("{}")', fileSha1: null }),
  })
  assert.equal(conflicted.state.status, 409, 'a variable name another source owns is a 409')
  assert.equal(conflicted.json().code, 'conflict', 'and it reports the conflict reason')

  const brokenWrite = await call({
    method: 'PUT',
    url: `${ROUTE_PREFIX}/script/broken`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({ source: 'nonsense', fileSha1: null }),
  })
  assert.equal(brokenWrite.state.status, 422, 'a script whose output is unusable is a 422')
  assert.equal(brokenWrite.json().report.problems[0], '输出不是合法 JSON', 'and the run report reaches the page')

  const staleWrite = await call({
    method: 'PUT',
    url: `${ROUTE_PREFIX}/script/toolchain`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({ source: 'console.log("{}")', fileSha1: 'c'.repeat(40) }),
  })
  assert.equal(staleWrite.state.status, 409, 'a stale editor is refused with 409')

  for (const [label, payload] of [
    ['a missing source', {}],
    ['a non-string source', { source: 7 }],
    ['a non-string fence', { source: 'x', fileSha1: 7 }],
  ]) {
    const refused = await call({
      method: 'PUT',
      url: `${ROUTE_PREFIX}/script/toolchain`,
      origin: 'http://127.0.0.1:3080',
      body: JSON.stringify(payload),
    })
    assert.equal(refused.state.status, 400, `${label} must be refused`)
  }

  const badScriptName = await call({
    method: 'PUT',
    url: `${ROUTE_PREFIX}/script/BAD_NAME`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({ source: 'x', fileSha1: null }),
  })
  assert.equal(badScriptName.state.status, 400, 'an unusable script name never reaches the disk')

  const wrongScriptMethod = await call({ method: 'POST', url: `${ROUTE_PREFIX}/script/toolchain`, origin: 'http://127.0.0.1:3080' })
  assert.equal(wrongScriptMethod.state.status, 405, 'a POST on a script is refused')

  const removedScript = await call({ method: 'DELETE', url: `${ROUTE_PREFIX}/script/toolchain`, origin: 'http://127.0.0.1:3080' })
  assert.equal(removedScript.json().removed, true, 'a delete reports whether a file went away')

  // Every mutating variable route is gated twice: loopback peer, then origin.
  for (const [label, options] of [
    ['a cross-origin draft run', { method: 'POST', url: `${ROUTE_PREFIX}/variables/run`, origin: 'http://evil.example', body: '{}' }],
    ['a cross-origin refresh', { method: 'POST', url: `${ROUTE_PREFIX}/variables/refresh`, origin: 'http://evil.example' }],
    ['a cross-origin save', { method: 'PUT', url: `${ROUTE_PREFIX}/script/toolchain`, origin: 'http://evil.example', body: '{"source":"x"}' }],
    ['a cross-origin delete', { method: 'DELETE', url: `${ROUTE_PREFIX}/script/toolchain`, origin: 'http://evil.example' }],
  ]) {
    const refused = await call(options)
    assert.equal(refused.state.status, 403, `${label} must be refused`)
  }

  for (const [label, options] of [
    ['a remote draft run', { method: 'POST', url: `${ROUTE_PREFIX}/variables/run`, remoteAddress: '10.0.0.5', host: '10.0.0.5:3080', origin: 'http://10.0.0.5:3080', body: '{}' }],
    ['a remote save', { method: 'PUT', url: `${ROUTE_PREFIX}/script/toolchain`, remoteAddress: '10.0.0.5', host: '10.0.0.5:3080', origin: 'http://10.0.0.5:3080', body: '{"source":"x"}' }],
  ]) {
    const refused = await call(options)
    assert.equal(refused.state.status, 403, `${label} must be refused: user code is written from the host only`)
  }

  assert.deepEqual(warnings, [], `no warning expected, got: ${warnings.join(' | ')}`)

  // ── preset packs ────────────────────────────────────────────────────────────

  const exportUrl = (preset) => `${ROUTE_PREFIX}/pack/export?preset=${encodeURIComponent(preset)}`

  const missingPreset = await call({ url: `${ROUTE_PREFIX}/pack/export` })
  assert.equal(missingPreset.state.status, 400, 'an export without a preset is refused')
  assert.equal(missingPreset.json().code, 'missing-preset', 'and says which parameter is missing')

  const unknownPreset = await call({ url: exportUrl('nope') })
  assert.equal(unknownPreset.state.status, 404, 'an export of a preset that does not exist is a 404')
  assert.equal(unknownPreset.json().code, 'unknown-preset', 'with a code the page can branch on')

  packs.available.set('ctf', samplePack)
  const exported = await call({ url: exportUrl('ctf') })
  assert.equal(exported.state.status, 200, 'a preset that exists exports')
  assert.deepEqual(packs.served, ['nope', 'ctf'], 'the host is asked about the preset that was named')
  assert.equal(
    exported.state.headers['content-disposition'],
    'attachment; filename="prompt-manager-pack-ctf.json"',
    'the download carries a file name, so the URL works from the address bar too',
  )
  assert.deepEqual(exported.json(), samplePack, 'and the body is the pack itself')

  const wrongExportMethod = await call({ method: 'POST', url: exportUrl('ctf'), origin: 'http://127.0.0.1:3080', body: '{}' })
  assert.equal(wrongExportMethod.state.status, 405, 'an export is a read, so only GET is allowed on it')

  const foreignJson = await call({
    method: 'POST',
    url: `${ROUTE_PREFIX}/pack/import`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({ format: 'something-else', version: 1 }),
  })
  assert.equal(foreignJson.state.status, 400, 'a foreign JSON file is refused')
  assert.equal(foreignJson.json().code, 'bad-format', 'as bad-format')
  assert.deepEqual(packs.imports, [], 'and it never reaches the engine')

  const unusableBody = await call({
    method: 'POST',
    url: `${ROUTE_PREFIX}/pack/import`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({
      format: 'dsh-prompt-manager-pack',
      version: 1,
      preset: { id: 'x', name: 'x', entries: ['a'] },
      entries: [{ id: 'a', title: '写法不对', body: 'bad {{不是变量名}} reference' }],
    }),
  })
  assert.equal(unusableBody.state.status, 400, 'a body that could never assemble is refused')
  assert.equal(unusableBody.json().code, 'bad-reference', 'as bad-reference')
  assert.deepEqual(packs.imports, [], 'and nothing is written for it either')

  // The reason the import route raises its own read limit: a pack may carry what
  // the entry route carries in fifty separate writes. Each body stays under the
  // store's own limit, while the pack as a whole is past the ordinary one.
  const chunk = 'x'.repeat(200_000)
  const wideIds = ['a', 'b', 'c', 'd']
  const wide = await call({
    method: 'POST',
    url: `${ROUTE_PREFIX}/pack/import`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({
      format: 'dsh-prompt-manager-pack',
      version: 1,
      preset: { id: 'wide', name: 'wide', entries: wideIds },
      entries: wideIds.map((id, index) => ({ id, title: `大条目 ${String(index)}`, order: index, body: chunk })),
    }),
  })
  assert.equal(wide.state.status, 200, 'a pack larger than a single body is still read')
  assert.equal(packs.imports.at(-1).entries.length, 4, 'and arrives whole')

  const tooBig = await call({
    method: 'POST',
    url: `${ROUTE_PREFIX}/pack/import`,
    origin: 'http://127.0.0.1:3080',
    body: 'x'.repeat(MAX_PACK_BYTES + 8192 + 1),
  })
  assert.equal(tooBig.state.status, 400, 'a pack past the ceiling is refused while being read')
  assert.equal(tooBig.json().code, 'too-large', 'as too-large')

  // A refusal the engine reaches after validation is reported as a 400 with its
  // own code, not as a server error: nothing was written.
  packs.refusal = { code: 'too-many-entries', message: '这台机器还能再放 0 条，这个包有 2 条' }
  const packed = await call({
    method: 'POST',
    url: `${ROUTE_PREFIX}/pack/import`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify(samplePack),
  })
  assert.equal(packed.state.status, 400, 'a pack that does not fit is refused')
  assert.equal(packed.json().code, 'too-many-entries', 'with the code the planner chose')
  assert.ok(packed.json().error.includes('还能再放'), 'and the message it wrote for the page')

  packs.refusal = null
  const imported = await call({
    method: 'POST',
    url: `${ROUTE_PREFIX}/pack/import`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify(samplePack),
  })
  assert.equal(imported.state.status, 200, 'a usable pack imports')
  assert.deepEqual(imported.json().entries, [{ id: 'env', title: '本机环境' }], 'and its report reaches the page')
  assert.equal(packs.imports.at(-1).preset.id, 'ctf', 'the engine was handed the pack the route parsed')

  const wrongImportMethod = await call({ url: `${ROUTE_PREFIX}/pack/import` })
  assert.equal(wrongImportMethod.state.status, 405, 'an import is a write, so only POST is allowed on it')

  const unknownPackAction = await call({ url: `${ROUTE_PREFIX}/pack/nonsense` })
  assert.equal(unknownPackAction.state.status, 404, 'an unknown pack action is a 404')

  // Import writes bodies and settings, so it sits behind the same two gates as
  // every other write.
  const crossOriginImport = await call({
    method: 'POST',
    url: `${ROUTE_PREFIX}/pack/import`,
    origin: 'http://evil.example',
    body: JSON.stringify(samplePack),
  })
  assert.equal(crossOriginImport.state.status, 403, 'a cross-origin import is refused')

  const remoteExport = await call({
    url: exportUrl('ctf'),
    remoteAddress: '10.0.0.5',
    host: '10.0.0.5:3080',
  })
  assert.equal(remoteExport.state.status, 403, 'and even an export stays on loopback')

  // ── one session's choice ────────────────────────────────────────────────────
  //
  // This is the route the two composer chips write through, and it is the only
  // thing that decides which prompt set and which compaction instruction a
  // conversation gets. Beyond the status codes, two properties matter: a session
  // that has never chosen answers with the effective "nothing" rather than a 404,
  // and a patch merges, because each chip owns one field and neither should have
  // to read the other's.

  const SESSION = 'session-route'
  const choiceUrl = (sessionId) => [ROUTE_PREFIX, 'session', sessionId].join('/')
  const local = { origin: 'http://127.0.0.1:3080' }

  const noChoice = await call({ url: choiceUrl(SESSION) })
  assert.equal(noChoice.state.status, 200, 'a session that chose nothing is not an error')
  assert.deepEqual(
    noChoice.json(),
    { session: SESSION, preset: '', compaction: '', stored: false },
    'and it answers with the effective nothing, saying nothing is stored yet',
  )

  const chosePreset = await call({
    method: 'POST',
    url: choiceUrl(SESSION),
    ...local,
    body: JSON.stringify({ preset: 'ctf' }),
  })
  assert.equal(chosePreset.state.status, 200, 'choosing a preset is a write that succeeds')
  assert.deepEqual(
    chosePreset.json(),
    { session: SESSION, preset: 'ctf', compaction: '', stored: true },
    'and it answers with what was stored, which is what the chip holds on to',
  )

  const choseInstruction = await call({
    method: 'POST',
    url: choiceUrl(SESSION),
    ...local,
    body: JSON.stringify({ compaction: 'compact-zh' }),
  })
  assert.equal(choseInstruction.json().preset, 'ctf', 'a patch naming one field must leave the other alone')
  assert.equal(choseInstruction.json().compaction, 'compact-zh', 'and set the field it names')

  const otherSession = await call({ url: choiceUrl('session-other') })
  assert.equal(otherSession.json().preset, '', 'a second session must not inherit the first one\'s choice')
  assert.equal(otherSession.json().compaction, '', 'in either field')

  // The health route is how a person sees that choices are being stored at all,
  // and where: a settings page that silently wrote nothing is otherwise
  // indistinguishable from one whose writes work.
  const health = await call({ url: [ROUTE_PREFIX, 'status'].join('/') })
  assert.equal(health.json().sessions.dir, join(ROOT, 'sessions'), 'status must report where the choices live')
  assert.equal(health.json().sessions.count, 1, 'and how many sessions have one, so the store is not invisible')

  const cleared = await call({ method: 'DELETE', url: choiceUrl(SESSION), ...local })
  assert.equal(cleared.state.status, 200, 'a session may forget its choice')
  assert.deepEqual(
    cleared.json(),
    { session: SESSION, preset: '', compaction: '', stored: false, cleared: true },
    'which puts it back exactly where a fresh session starts, and says a file was removed',
  )
  const clearedAgain = await call({ method: 'DELETE', url: choiceUrl(SESSION), ...local })
  assert.equal(clearedAgain.json().cleared, false, 'clearing a choice that is already gone is not an error')
  const emptied = await call({ url: [ROUTE_PREFIX, 'status'].join('/') })
  assert.equal(emptied.json().sessions.count, 0, 'and a forgotten choice stops counting against the store')

  // An id, and two values, that could not address anything are refused before they
  // are written: an id that never resolves would be reported at every assembly
  // from then on, which is a much worse place to learn about it.
  const refusals = [
    ['a session id the store will not name a file after', { url: choiceUrl('Upper') }, 'invalid-id'],
    ['a session id that is a path', { url: choiceUrl('..%2Fescape') }, 'invalid-id'],
    ['a preset id that is not an id', {
      method: 'POST',
      url: choiceUrl(SESSION),
      ...local,
      body: JSON.stringify({ preset: '../escape' }),
    }, 'invalid-value'],
    ['a compaction id that is not a string', {
      method: 'POST',
      url: choiceUrl(SESSION),
      ...local,
      body: JSON.stringify({ compaction: 7 }),
    }, 'invalid-value'],
    ['a patch naming neither field', {
      method: 'POST',
      url: choiceUrl(SESSION),
      ...local,
      body: JSON.stringify({ irrelevant: true }),
    }, undefined],
  ]
  for (const [label, options, code] of refusals) {
    const refused = await call(options)
    assert.equal(refused.state.status, 400, label + ' must be refused')
    if (code !== undefined) assert.equal(refused.json().code, code, 'and the refusal must say why: ' + label)
  }

  const wrongSessionMethod = await call({ method: 'PUT', url: choiceUrl(SESSION), ...local, body: '{}' })
  assert.equal(wrongSessionMethod.state.status, 405, 'a choice is read, replaced, or forgotten — nothing else')

  const crossOriginChoice = await call({
    method: 'POST',
    url: choiceUrl(SESSION),
    origin: 'http://evil.example',
    body: JSON.stringify({ preset: 'ctf' }),
  })
  assert.equal(crossOriginChoice.state.status, 403, 'a choice is a write, so it sits behind the same-origin gate')

  assert.deepEqual(warnings, [], `no warning expected, got: ${warnings.join(' | ')}`)

  console.log('routes ok')
  console.log('  gates       loopback local path (host name checked), deployment trust for every other peer, same-origin writes only')
  console.log('  fencing     409 on absent-or-changed override, 200 on a matching hash')
  console.log('  statuses    400 malformed/oversized, 404 unknown path, 405 wrong method, 422 bad reference')
  console.log('  health      status reports the compaction seam only when the feature is on')
  console.log(`  presets     preset id allocation, ${String(MAX_PRESETS)} preset cap, blank title refused`)
  console.log('  gates       403 for a rebound host, a foreign origin, an unserved Host, and a composition with no trust authority; 401 without a session')
  console.log('  sources     add / list / check / apply / revert / forget, subscribed bodies read-only')
  console.log('  variables   list with provenance and references, draft run, saved run, refresh')
  console.log('  scripts     read / save with fence / delete, 422 on an unusable run, host-only writes')
  console.log('  packs       export by preset with a download name, import validated before it is applied')
  console.log('  sessions    read / merge / clear one session\'s choice, neighbours untouched, unusable ids and values refused')
} finally {
  rmSync(ROOT, { recursive: true, force: true })
}
