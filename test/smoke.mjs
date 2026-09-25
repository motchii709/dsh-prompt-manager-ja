#!/usr/bin/env node
/**
 * Smoke test: mount this plugin into a real SystemPrompt registry and assert
 * that the prompt index — not a section baked into the plugin — decides what the
 * assembled system prompt contains.
 *
 * Coverage: an empty fresh install, the settings-driven index (add, enable,
 * disable, order), body resolution from the store and from a subscription
 * snapshot, index sanitization, prompt variables, the real namespace schema, and
 * config validation.
 *
 * The DeepSeek Harness packages are resolved in three steps: from this file,
 * from the current working directory's `node_modules`, then from the
 * `DSH_PACKAGES` directory holding `@deepseek-ai/*`. So either run it inside a
 * directory that can see the packages, or set `DSH_PACKAGES`, e.g.
 * `DSH_PACKAGES=C:/Users/me/.dsh/profiles/node_modules/@deepseek-ai node test/smoke.mjs`.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { MAX_PROBES, ROUTE_PREFIX, SETTINGS_NAMESPACE, apply, environmentFacts, inject, name, resolveHarnessHome } from '../lib/index.js'
import { activeCompactionOf, activePresetOf, buildIndexSchema, parseEntries, parsePresets } from '../lib/entries.js'
import { ESCAPE_MARK } from '../lib/guard.js'
import { bodyHash } from '../lib/store.js'
import { fakeSettings as fakeSettingsFixture, mountable } from './helpers/settings-source.mjs'

/** Throwaway home for the body files, so the test never touches a real one. */
const STORE_ROOT = mkdtempSync(join(tmpdir(), 'prompt-manager-smoke-'))

/** The plugin's real row-config schema, mounted with the plugin itself. */
const moduleConfig = (await import('../lib/index.js')).Config

/** Body directory the plugin derives from {@link STORE_ROOT}. */
const SECTIONS = join(STORE_ROOT, 'sections')

/**
 * Import a `@deepseek-ai/*` package, trying this file, the cwd, then `DSH_PACKAGES`.
 * @param packageName - the bare specifier to resolve.
 * @returns the imported module namespace.
 */
async function load(packageName) {
  const failures = []
  try {
    return await import(packageName)
  } catch (error) {
    failures.push(error.message)
  }
  try {
    const require = createRequire(join(process.cwd(), 'noop.js'))
    return await import(pathToFileURL(require.resolve(packageName)).href)
  } catch (error) {
    failures.push(error.message)
  }
  const root = process.env.DSH_PACKAGES
  if (root !== undefined) {
    const leaf = packageName.slice('@deepseek-ai/'.length)
    return import(pathToFileURL(join(root, leaf, 'lib', 'index.js')).href)
  }
  throw new Error(`cannot resolve ${packageName}; set DSH_PACKAGES to the directory holding @deepseek-ai/* (${failures.join(' | ')})`)
}

/** Let Cordis flush the fibers an injection created. */
async function settle() {
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * A stand-in `settings` service, plus the fixture that drives the volatile
 * index fields the Loader would otherwise commit into.
 *
 * DSH 0.1.7 deleted `settings.register`: the plugin's own Loader entry is the
 * namespace, the index travels as `volatile()` Config fields, and a committed
 * write moves those references and announces `loader/volatile-update`. The
 * fixture reproduces exactly that, so `state.value = document` is the same act
 * as a committed settings write.
 * @param initial - the document to report before a mount attaches a config.
 * @returns the plugin to mount and the state it exposes.
 */
const fakeSettings = (initial) => fakeSettingsFixture(initial)

/**
 * A stand-in `webServer` service: it records the routes a row registers, so the
 * real handler can be driven without a socket.
 * @param routes - the array registered routes are pushed into.
 * @returns the plugin to mount.
 */
function fakeWebServer(routes) {
  return {
    name: 'fake-web-server',
    apply: (ctx) => {
      ctx.provide('webServer', {
        register: (route) => {
          routes.push(route)
          return () => {}
        },
      })
    },
  }
}

/**
 * A fake request good enough for the route handler.
 * @param options - method, url, origin, and raw body.
 * @returns an object the handler can read.
 */
function fakeRequest(options) {
  const chunks = options.body === undefined ? [] : [Buffer.from(options.body, 'utf8')]
  const headers = { host: '127.0.0.1:3080' }
  if (options.origin !== undefined) headers.origin = options.origin
  return {
    method: options.method ?? 'GET',
    url: options.url,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/**
 * A fake response that captures what the handler wrote.
 * @returns the response plus its captured state.
 */
function fakeResponse() {
  const state = { status: 0, headers: {}, body: '' }
  return {
    state,
    setHeader(name, value) {
      state.headers[name.toLowerCase()] = value
    },
    writeHead(status) {
      state.status = status
    },
    end(body) {
      state.body = body ?? ''
    },
    json() {
      return JSON.parse(state.body)
    },
  }
}

/**
 * Mount the plugin into a fresh SystemPrompt registry.
 * @param config - plugin config.
 * @param promptConfig - SystemPrompt service config.
 * @param plugins - extra plugins to mount before this one.
 * @returns the rendered system prompt, the assembly, and a re-assemble function.
 */
/** The session every assembly in this file is for, unless a test names another. */
const SESSION = 'session-harness'

/**
 * Record one session's choice, the way the composer chip's own request does.
 *
 * These tests drive the Host, so this writes the file the Host reads instead of
 * going through the route: the route's own shaping is asserted in `routes.mjs`,
 * and what an assembly does with a choice is what these tests are about.
 * @param sessionId - the session choosing.
 * @param patch - the fields to set, merged over whatever the file already holds.
 */
function choose(sessionId, patch) {
  const dir = join(STORE_ROOT, 'sessions')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${sessionId}.json`)
  let current = { preset: '', compaction: '' }
  try {
    current = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    /* no choice yet, which is how every session starts */
  }
  writeFileSync(file, JSON.stringify({ ...current, ...patch }), 'utf8')
}

async function assembleWith(config, promptConfig, plugins = []) {
  const { Context } = await load('@deepseek-ai/cordis')
  const { default: SystemPrompt, renderPrompt } = await load('@deepseek-ai/dsh-system-prompt')
  const ctx = new Context()
  // The plugin reports through `ctx.logger`, so the test collects what it says
  // rather than trusting that a warning happened.
  const warnings = []
  ctx.logger.warn = (...args) => { warnings.push(args.map(String).join(' ')) }
  await ctx.plugin(SystemPrompt, promptConfig)
  for (const plugin of plugins) await ctx.plugin(plugin)
  // The plugin's own `Config` is mounted with it: that is what makes cordis
  // resolve the index fields as live references, exactly as the Loader does.
  const fixture = plugins.map((plugin) => plugin.settingsState).find((state) => state !== undefined)
  await ctx.plugin(mountable({ name, inject, apply, Config: moduleConfig }, fixture), { storeDir: STORE_ROOT, ...config })
  await settle()
  const read = async (
    sessionId = SESSION,
    cwd = join(STORE_ROOT, 'workspaces', sessionId),
    options = { provider: 'test-provider', model: 'test-default-model' },
  ) => {
    const assembly = await ctx.systemPrompt.assemble({ agent: { session: { id: sessionId, header: { cwd } }, options } })
    return { assembly, prompt: renderPrompt(assembly) }
  }
  const first = await read()
  return { ...first, read, warnings }
}

/** SystemPrompt config that isolates the sections under test. */
const BARE = { includeHarnessIdentity: false, includeRuntimeContext: false }

/**
 * A rendered prompt as a model reads it: the guard's escape marks are invisible.
 * @param text - rendered prompt text.
 * @returns the same text without escape marks.
 */
const readable = (text) => text.split(ESCAPE_MARK).join('')

/** Section name a person-added entry must register under. */
const sectionName = (id) => `user:prompt-manager:${id}`

/**
 * Write one entry body under a store directory.
 * @param id - entry id, which is also the file name.
 * @param text - exact body contents.
 * @param root - storage root to write under.
 */
function writeBody(id, text, root = STORE_ROOT) {
  const sections = join(root, 'sections')
  mkdirSync(sections, { recursive: true })
  writeFileSync(join(sections, `${id}.md`), text, 'utf8')
}

/** Throwaway roots the script cases create, removed with the rest. */
const extraRoots = []

try {
  // ── a fresh install carries the built-in environment prompt ─────────────────

  // DSH's agent-loop owns these providers; use their contracts without mounting
  // the entire agent runtime. The actual registry and prompt-manager render below.
  const nativeRoutes = []
  const fresh = await assembleWith({}, BARE, [fakeWebServer(nativeRoutes), {
    name: 'session-variables',
    inject: ['systemPrompt'],
    apply: (ctx) => {
      ctx.systemPrompt.variable('cwd', (context) => context.agent?.session.header.cwd)
      ctx.systemPrompt.variable('model', (context) => context.agent?.options.model)
      ctx.systemPrompt.variable('provider', (context) => context.agent?.options.provider)
    },
  }])
  assert.ok(
    fresh.prompt.includes('# Machine environment'),
    `a fresh install must inject the built-in environment prompt, got: ${fresh.prompt.slice(0, 120)}`,
  )
  assert.ok(
    /- \*\*git\*\* `[^`]+`/.test(fresh.prompt),
    'the built-in body must interpolate the tool variables, which the probe defaults supply',
  )
  assert.ok(
    fresh.assembly.sections.some((section) => section.name === sectionName('env')),
    'the built-in entry must register under its own id',
  )

  // The packaged body is shipped prose, so it is checked statically too: a
  // literal brace pair that is not a variable name makes assembly throw.
  const packaged = readFileSync(new URL('../environment.md', import.meta.url), 'utf8')
  assert.ok(
    !/\{\{(?![a-z][a-z0-9_]*\}\})/.test(packaged),
    'the built-in body must not carry a malformed variable reference',
  )

  // ── the built-in environment follows each session's workspace ──────────────

  assert.ok(
    fresh.prompt.includes(`This session's working directory is \`${join(STORE_ROOT, 'workspaces', SESSION)}\``),
    'the built-in environment must tell the model this session\'s working directory',
  )
  assert.ok(packaged.includes('{{cwd}}'), 'the shipped template must reference DSH\'s session variable')
  assert.equal(Object.hasOwn(environmentFacts(), 'cwd'), false, 'cwd must not become a mount-time machine fact')

  const cwdA = 'F:\\工作区 A\\project'
  const cwdB = '/srv/工作区 B/project'
  const [workspaceA, workspaceB] = await Promise.all([
    fresh.read('session-workspace-a', cwdA),
    fresh.read('session-workspace-b', cwdB),
  ])
  for (const [result, own, other] of [[workspaceA, cwdA, cwdB], [workspaceB, cwdB, cwdA]]) {
    assert.ok(
      result.prompt.includes(`This session's working directory is \`${own}\``),
      'the environment must preserve this session\'s absolute path, including spaces, Unicode and separators',
    )
    assert.ok(!result.prompt.includes(other), 'concurrent sessions must not share workspace paths')
    assert.ok(!result.prompt.includes(process.cwd()), 'the host process directory must not stand in for the session workspace')
    assert.ok(!result.prompt.includes('{{cwd}}'), 'the model must receive the resolved directory, not the variable token')
  }
  assert.equal(
    (await fresh.read('session-workspace-a', cwdA)).prompt,
    workspaceA.prompt,
    'reassembling A after B must keep A\'s own directory',
  )
  assert.ok(
    !fresh.warnings.some((warning) => warning.includes('cwd')),
    'the plugin must neither contest DSH\'s cwd registration nor report it as unresolved',
  )

  // ── the built-in environment follows the current agent's model ────────────

  assert.ok(
    fresh.prompt.includes('This agent\'s current model is `test-default-model` (provider: `test-provider`).'),
    'the built-in environment must tell the model which model this agent selected',
  )
  for (const variable of ['model', 'provider']) {
    assert.ok(packaged.includes(`{{${variable}}}`), 'the shipped body must use DSH\'s dynamic model selection variables')
    assert.equal(Object.hasOwn(environmentFacts(), variable), false, 'a model selection must not become a mount-time machine fact')
  }

  const optionsA = { provider: 'provider-a', model: 'vendor/model-a-v1' }
  const optionsB = { provider: 'provider-b', model: 'model-b:latest' }
  const [modelA, modelB] = await Promise.all([
    fresh.read('session-model-a', cwdA, optionsA),
    fresh.read('session-model-b', cwdB, optionsB),
  ])
  for (const [result, own, other] of [[modelA, optionsA, optionsB], [modelB, optionsB, optionsA]]) {
    assert.ok(
      result.prompt.includes(`This agent's current model is \`${own.model}\` (provider: \`${own.provider}\`).`),
      'each session must receive its own exact model ID and provider, not a display alias or startup default',
    )
    assert.ok(!result.prompt.includes(other.model), 'concurrent sessions must not share model selections')
    assert.ok(!result.prompt.includes(other.provider), 'concurrent sessions must not share providers')
    assert.ok(!result.prompt.includes('{{model}}'), 'the model name must be resolved before it reaches the agent')
  }

  optionsA.model = 'model-a-next'
  optionsA.provider = 'provider-next'
  const switchedModel = await fresh.read('session-model-a', cwdA, optionsA)
  assert.ok(
    switchedModel.prompt.includes('This agent\'s current model is `model-a-next` (provider: `provider-next`).'),
    'switching a model must update the next assembly without remounting the plugin',
  )
  assert.ok(!switchedModel.prompt.includes('vendor/model-a-v1'), 'the previous model must not remain in the environment')
  assert.equal((await fresh.read('session-model-b', cwdB, optionsB)).prompt, modelB.prompt, 'switching A must leave B unchanged')
  const siblingModel = await fresh.read('session-model-a', cwdA, { provider: 'child-provider', model: 'child-model' })
  assert.ok(
    siblingModel.prompt.includes('This agent\'s current model is `child-model` (provider: `child-provider`).'),
    'the assembly must use the current agent, even when another agent uses the same session',
  )
  assert.ok(
    !fresh.warnings.some((warning) => warning.includes('model') || warning.includes('provider')),
    'the plugin must not contest DSH\'s model variables or report them as unresolved',
  )

  // ── native references belong in the catalogue, never as global values ──────

  const nativeNames = ['cwd', 'model', 'provider']
  const readNativeApi = async (endpoint) => {
    const response = fakeResponse()
    await nativeRoutes[0].handler(fakeRequest({ url: `${ROUTE_PREFIX}/${endpoint}` }), response)
    assert.equal(response.state.status, 200)
    return response.json()
  }
  const nativeCatalog = (await readNativeApi('variables')).variables.filter((variable) => nativeNames.includes(variable.name))
  assert.deepEqual(nativeCatalog.map((variable) => variable.name), nativeNames, 'the editor catalogue must include all three DSH context variables')
  for (const variable of nativeCatalog) {
    assert.equal(variable.source, 'dsh', 'a native reference must be identified as DSH-owned, not a plugin registration')
    assert.equal(Object.hasOwn(variable, 'value'), false, 'a global catalogue must not expose the last session or model value')
    assert.equal(Object.hasOwn(variable, 'updatedAt'), false, 'native references have no mount-time measurement')
    assert.ok(typeof variable.detail === 'string' && variable.detail.length > 0)
    assert.deepEqual(variable.referencedBy, ['机器环境'], 'native references must participate in reference tracking')
  }
  await fresh.read('session-catalogue', '/private/context-not-for-settings', { provider: 'catalogue-provider', model: 'catalogue-model' })
  assert.deepEqual((await readNativeApi('variables')).variables.filter((variable) => nativeNames.includes(variable.name)), nativeCatalog, 'assembling a different agent must not freeze its values into the settings catalogue')
  const nativeStatus = await readNativeApi('status')
  for (const variable of nativeNames) {
    assert.equal(Object.hasOwn(nativeStatus.variables, variable), false, 'the status value map must contain real global values only')
  }

  // ── the settings index drives the prompt ────────────────────────────────────

  const settings = fakeSettings([])
  const driven = await assembleWith({}, BARE, [settings.plugin])
  assert.ok(moduleConfig !== undefined, 'the plugin must export the row-config schema the Loader resolves')
  assert.equal(SETTINGS_NAMESPACE, 'prompt-manager', 'the namespace must be the Loader entry id the browser half reads')
  assert.deepEqual(
    settings.state.value.entries,
    [{ id: 'env', title: '机器环境', order: 5, enabled: true }],
    'an unconfigured row must resolve to the built-in entry',
  )
  assert.ok(driven.prompt.includes('# Machine environment'), 'the composed base must inject the built-in prompt')

  // A body written here replaces the packaged one, body and all.
  writeBody('env', 'MY-OWN-ENVIRONMENT')
  const overridden = await driven.read()
  assert.equal(overridden.prompt, 'MY-OWN-ENVIRONMENT', 'a local body must override the built-in one')

  writeBody('early', 'EARLY-BODY')
  writeBody('note', 'NOTE-BODY')
  settings.state.value = {
    entries: [
      { id: 'early', title: '先说的', order: 5, enabled: true },
      { id: 'note', title: '补充说明', order: 40, enabled: true },
    ],
  }
  settings.state.watcher()
  const added = await driven.read()
  const addedNames = added.assembly.sections
    .map((section) => section.name)
    .filter((sectionName_) => sectionName_.startsWith('user:prompt-manager:'))
  assert.deepEqual(addedNames, [sectionName('early'), sectionName('note')], `unexpected sections: ${addedNames.join(', ')}`)
  assert.ok(added.prompt.includes('EARLY-BODY') && added.prompt.includes('NOTE-BODY'), 'both bodies must reach the prompt')
  assert.ok(
    added.prompt.indexOf('EARLY-BODY') < added.prompt.indexOf('NOTE-BODY'),
    'entries must be concatenated in ascending order',
  )

  // A disabled entry leaves the prompt; the others stay.
  settings.state.value = {
    entries: [
      { id: 'early', title: '先说的', order: 5, enabled: true },
      { id: 'note', title: '补充说明', order: 40, enabled: false },
    ],
  }
  settings.state.watcher()
  const disabled = await driven.read()
  assert.ok(disabled.prompt.includes('EARLY-BODY'), 'an enabled entry must stay')
  assert.ok(!disabled.prompt.includes('NOTE-BODY'), 'a disabled entry must leave the prompt')

  // An entry with no body file contributes nothing rather than breaking assembly.
  settings.state.value = {
    entries: [{ id: 'nobody', title: '还没写正文', order: 50, enabled: true }],
  }
  settings.state.watcher()
  const bodyless = await driven.read()
  assert.equal(bodyless.prompt, '', 'an entry without a body file must contribute nothing')

  // ── a subscribed entry reads its snapshot, not a local file ─────────────────

  const workspace = join(STORE_ROOT, 'sources', 'src-a')
  mkdirSync(join(workspace, 'current', 'p'), { recursive: true })
  writeFileSync(join(workspace, 'current', 'p', 'a.md'), 'SUBSCRIBED-BODY', 'utf8')
  writeFileSync(join(workspace, 'state.json'), JSON.stringify({
    ref: 'main',
    files: { 'p/a.md': { id: 'src-a-a', enabled: true, sha1: 'x' } },
  }), 'utf8')
  settings.state.value = {
    entries: [{ id: 'src-a-a', title: '订阅来的', order: 60, enabled: true, source: 'src-a' }],
    sources: [{ id: 'src-a', repo: 'o/r', ref: 'main', enabled: true }],
  }
  settings.state.watcher()
  const subscribed = await driven.read()
  assert.ok(subscribed.prompt.includes('SUBSCRIBED-BODY'), 'a subscribed entry must read its snapshot')
  assert.ok(
    subscribed.assembly.sections.some((section) => section.name === sectionName('src-a-a')),
    'a subscribed entry must register a section like any other entry',
  )

  // ── a preset decides injection whole ────────────────────────────────────────

  // This is what the composer chip writes: one field naming a set. While a preset
  // is in force it — not the entries' own switches — answers "does this reach the
  // prompt", which is what lets a switch be one settings write with no bookkeeping.
  settings.state.value = {
    entries: [
      { id: 'early', title: '先说的', order: 5, enabled: true },
      { id: 'note', title: '补充说明', order: 40, enabled: false },
    ],
    presets: [{ id: 'full', name: '全都要', entries: ['early', 'note'] }],
  }
  settings.state.watcher()
  // Which preset is in force is the conversation's own choice, recorded in that
  // conversation's own file — the settings document no longer answers it at all.
  choose('session-preset', { preset: 'full' })
  const presetOn = await driven.read('session-preset')
  assert.ok(presetOn.prompt.includes('EARLY-BODY'), 'a preset must inject the entries it names')
  assert.ok(presetOn.prompt.includes('NOTE-BODY'), 'including one whose own switch is off')

  settings.state.value = {
    ...settings.state.value,
    presets: [{ id: 'full', name: '全都要', entries: ['note'] }],
  }
  settings.state.watcher()
  const presetNarrow = await driven.read('session-preset')
  assert.ok(
    !presetNarrow.prompt.includes('EARLY-BODY'),
    'an entry the preset leaves out must stay out, however its own switch reads',
  )
  assert.ok(presetNarrow.prompt.includes('NOTE-BODY'), 'and the members it does name stay in')

  // Switching is one small file write and nothing else: the sections keep the names
  // and placements they registered with, because text is resolved per assembly.
  settings.state.value = {
    ...settings.state.value,
    presets: [{ id: 'full', name: '全都要', entries: ['early', 'note'] }],
  }
  settings.state.watcher()
  const switched = await driven.read('session-preset')
  const switchedNames = switched.assembly.sections
    .map((section) => section.name)
    .filter((name_) => name_.startsWith('user:prompt-manager:'))
  assert.deepEqual(
    switchedNames,
    [sectionName('early'), sectionName('note')],
    'switching a preset must not re-register the sections',
  )

  // Choosing no preset hands the decision back to the switches.
  choose('session-preset', { preset: '' })
  const noPreset = await driven.read('session-preset')
  assert.ok(noPreset.prompt.includes('EARLY-BODY'), 'without a preset the entry switches decide again')
  assert.ok(!noPreset.prompt.includes('NOTE-BODY'), 'and a switch left off stays off')

  // An id that names nothing must not freeze the prompt on whatever it was: the
  // switches take over, and the problem is reported once.
  const warningsBefore = driven.warnings.length
  choose('session-preset', { preset: 'gone' })
  const missingPreset = await driven.read('session-preset')
  assert.ok(missingPreset.prompt.includes('EARLY-BODY'), 'a preset that no longer exists must fall back to the switches')
  assert.ok(
    driven.warnings.slice(warningsBefore).some((warning) => warning.includes('gone')),
    'and the plugin must report the id it could not resolve',
  )

  // A preset that exists while a member does not is the quieter half of the same
  // problem: the preset still switches, the other members still inject, and the
  // missing one simply stops appearing — exactly what an upstream rename looks
  // like from here. It has to be said out loud, once.
  const danglingBefore = driven.warnings.length
  settings.state.value = {
    ...settings.state.value,
    presets: [{ id: 'partial', name: '缺一条', entries: ['early', 'renamed-away'] }],
  }
  settings.state.watcher()
  choose('session-preset', { preset: 'partial' })
  const partial = await driven.read('session-preset')
  assert.ok(partial.prompt.includes('EARLY-BODY'), 'the members that do exist still inject')
  const dangling = driven.warnings.slice(danglingBefore).filter((warning) => warning.includes('renamed-away'))
  assert.equal(dangling.length, 1, 'the member no entry answers to is reported exactly once')
  assert.ok(dangling[0].includes('partial'), 'and the report names the preset it is missing from')

  // Reporting is keyed on which ids are missing, so an unchanged broken preset
  // says it once rather than on every assembly.
  const settled = driven.warnings.length
  settings.state.watcher()
  await driven.read()
  assert.equal(
    driven.warnings.slice(settled).filter((warning) => warning.includes('renamed-away')).length,
    0,
    'a preset left broken must not repeat itself on every settings sync',
  )

  // The other member that never injects: one that is in the index, but is a
  // compaction instruction. The page's type switch is what creates this — a
  // preset still lists the id it used to inject as a section — and the symptom is
  // one prompt quietly missing from the prompt, which is worth one log line.
  const misplacedBefore = driven.warnings.length
  writeBody('compact-zh', 'COMPACT-BODY')
  settings.state.value = {
    ...settings.state.value,
    entries: [
      { id: 'early', title: '先说的', order: 5, enabled: true },
      { id: 'compact-zh', title: '压缩指令', order: 90, enabled: false, kind: 'compaction' },
    ],
    presets: [{ id: 'mixed', name: '混了', entries: ['early', 'compact-zh'] }],
  }
  settings.state.watcher()
  choose('session-preset', { preset: 'mixed' })
  const mixed = await driven.read('session-preset')
  assert.ok(mixed.prompt.includes('EARLY-BODY'), 'a preset member that is a section still injects')
  assert.ok(!mixed.prompt.includes('COMPACT-BODY'), 'and the compaction instruction named as a member does not')
  const misplaced = driven.warnings.slice(misplacedBefore).filter((warning) => warning.includes('compact-zh'))
  assert.equal(misplaced.length, 1, 'a preset member that is a compaction instruction is reported exactly once')
  assert.ok(misplaced[0].includes('mixed'), 'and the report names the preset it sits in')

  // ── prompt variables ────────────────────────────────────────────────────────

  const facts = environmentFacts()
  assert.equal(facts.platform, process.platform, 'platform fact must mirror process.platform')
  assert.equal(facts.arch, process.arch, 'arch fact must mirror process.arch')
  assert.equal(facts.dsh_home, resolveHarnessHome(), 'dsh_home must be the home the store itself resolves')
  assert.ok(facts.dsh_home.length > 0, 'dsh_home must never be empty')
  for (const name of ['home', 'user', 'host']) {
    assert.ok(typeof facts[name] === 'string' && facts[name].length > 0, `${name} must resolve to a non-empty string`)
  }

  writeBody('vars', 'os={{os}} platform={{platform}} arch={{arch}} release={{os_release}}')
  settings.state.value = { entries: [{ id: 'vars', title: '变量', order: 10, enabled: true }] }
  settings.state.watcher()
  const environment = await driven.read()
  assert.ok(environment.prompt.startsWith(`os=${facts.os} platform=`), `unexpected environment line: ${environment.prompt}`)
  assert.ok(environment.prompt.includes(`platform=${process.platform}`), 'platform variable must resolve')
  assert.ok(environment.prompt.includes(`arch=${process.arch}`), 'arch variable must resolve')
  assert.ok(environment.prompt.includes(`release=${facts.os_release}`), 'os_release variable must resolve')

  // The machine facts a body actually reaches for: paths, the account, the box.
  writeBody('paths', 'home={{home}} dsh={{dsh_home}} user={{user}} host={{host}}')
  settings.state.value = { entries: [{ id: 'paths', title: '路径', order: 10, enabled: true }] }
  settings.state.watcher()
  const machine = await driven.read()
  assert.equal(
    machine.prompt,
    `home=${facts.home} dsh=${facts.dsh_home} user=${facts.user} host=${facts.host}`,
    'every machine fact must resolve to the value the process reported',
  )

  writeBody('shell', 'shell={{shell}}')
  const vars = fakeSettings([])
  const withVars = await assembleWith({ variables: { shell: 'powershell' } }, BARE, [vars.plugin])
  vars.state.value = { entries: [{ id: 'shell', title: 'shell', order: 10, enabled: true }] }
  vars.state.watcher()
  assert.equal((await withVars.read()).prompt, 'shell=powershell', 'config variables must register and resolve')

  writeBody('missing', 'before {{nope}} after')
  const noEnv = fakeSettings([])
  const guardedAssembly = await assembleWith({ environment: false }, BARE, [noEnv.plugin])
  noEnv.state.value = { entries: [{ id: 'missing', title: '未知变量', order: 10, enabled: true }] }
  noEnv.state.watcher()
  const unregistered = await guardedAssembly.read()
  assert.equal(
    readable(unregistered.prompt),
    'before {{nope}} after',
    'environment:false leaves the built-in variables unregistered, so the reference renders as the prose it is',
  )
  assert.ok(
    guardedAssembly.warnings.some((warning) => warning.includes('{{nope}}')),
    'and the plugin says which reference it defused, rather than failing every model step',
  )
  assert.ok(
    guardedAssembly.warnings.some((warning) => warning.includes('字面量')),
    'the report explains that the text was rendered literally',
  )

  // ── probes register as variables, and their failures stay values ────────────

  writeBody('tooling', 'node={{nodever}} rust={{rustver}}')
  const probed = fakeSettings([])
  const withProbes = await assembleWith({
    probes: {
      nodever: { command: process.execPath, args: ['--version'], pattern: 'v?([0-9.]+)' },
      rustver: { command: 'prompt-manager-definitely-not-a-command', args: ['--version'] },
    },
    probeTexts: { missing: '无' },
  }, BARE, [probed.plugin])
  probed.state.value = { entries: [{ id: 'tooling', title: '工具版本', order: 10, enabled: true }] }
  probed.state.watcher()
  const probedPrompt = (await withProbes.read()).prompt
  assert.equal(
    probedPrompt,
    `node=${process.version.replace(/^v/, '')} rust=无`,
    `probes must be measured at mount and rendered like any variable: ${probedPrompt}`,
  )

  // A name another row already owns is reported and skipped, and the rest of the
  // variables still register: one contested name must not cost the mount.
  const contested = fakeSettings([])
  const guarded = await assembleWith({ probes: { os: { command: process.execPath, args: ['--version'] } } }, BARE, [contested.plugin])
  writeBody('contested', 'os={{os}}')
  contested.state.value = { entries: [{ id: 'contested', title: '重名', order: 10, enabled: true }] }
  contested.state.watcher()
  assert.equal(
    (await guarded.read()).prompt,
    `os=${facts.os}`,
    'a probe whose name is already registered must be skipped, leaving the original variable intact',
  )
  assert.ok(
    guarded.warnings.some((warning) => warning.includes('os') && warning.includes('环境变量')),
    'the skipped layer is reported, so a person can see why their own value never took effect',
  )

  // Configuring a probe replaces the default of that name outright — it is not
  // merged field by field. This default carries a pattern that would narrow
  // `v24.18.0` to `24.18.0`, so the leading `v` in the value is what proves the
  // pattern did not survive the replacement.
  writeBody('restated', 'git={{git}}')
  const restated = fakeSettings([])
  const asNode = await assembleWith({
    probes: { git: { command: process.execPath, args: ['--version'] } },
  }, BARE, [restated.plugin])
  restated.state.value = { entries: [{ id: 'restated', title: '覆盖', order: 10, enabled: true }] }
  restated.state.watcher()
  const restatedPrompt = (await asNode.read()).prompt
  assert.equal(
    restatedPrompt,
    `git=v${process.version.replace(/^v/, '')}`,
    `a configured probe must replace the default spec outright, its pattern included: ${restatedPrompt}`,
  )

  // ── a document the schema refuses never reaches the plugin ──────────────────
  // The row config is validated where every DSH plugin's config is, so a
  // hand-edited patch that does not validate is refused as a write and the index
  // in force is left alone — the same containment the Loader applies.
  const beforeRefusal = settings.state.value.entries.map((entry) => entry.id)
  settings.state.value = { entries: [{ id: '../escape', title: 'bad', order: 1, enabled: true }, 'nonsense'] }
  assert.equal(settings.state.refusals.length, 1, 'a document the schema refuses must be refused, not delivered')
  assert.deepEqual(
    settings.state.value.entries.map((entry) => entry.id),
    beforeRefusal,
    'and the index in force must be the last one that validated',
  )

  // ── unusable index entries are dropped, never thrown ────────────────────────

  settings.state.value = { entries: [{ id: '../escape', title: 'bad', order: 1, enabled: true }] }
  const sanitized = await driven.read()
  assert.equal(sanitized.prompt, '', 'unusable index entries must be dropped, not injected')
  assert.ok(
    !sanitized.assembly.sections.some((section) => section.name.startsWith('user:prompt-manager:')),
    'an unusable index must register no section',
  )

  // A hand-edited preset list is narrowed the same way, and a preset naming an
  // entry that is not there is kept rather than rewritten: it may be a
  // subscription that has not come back yet.
  writeBody('kept', 'KEPT-BODY')
  settings.state.value = {
    entries: [{ id: 'kept', title: '留下的', order: 10, enabled: false }],
    presets: [
      { id: 'ok', name: '好的', entries: ['kept', '../escape', 'kept'] },
      { id: '../escape', name: '坏的', entries: ['kept'] },
      { id: 'ok', name: '重名', entries: ['kept'] },
    ],
  }
  settings.state.watcher()
  // Which preset is in force is a session's own choice, so the narrowed list is
  // exercised through one: the settings document no longer answers this at all.
  choose('session-narrowed', { preset: 'ok' })
  const narrowedPresets = await driven.read('session-narrowed')
  assert.ok(narrowedPresets.prompt.includes('KEPT-BODY'), 'the usable preset must still decide injection')

  const withPresets = parsePresets([
    { id: 'ok', name: '好的', entries: ['kept', '../escape', 'kept', 7] },
    { id: '../escape', name: '坏的', entries: ['kept'] },
    { id: 'ok', name: '重名', entries: ['kept'] },
    { id: 'unnamed', entries: ['kept'] },
    'nonsense',
  ])
  assert.equal(withPresets.length, 2, 'unusable presets and duplicate ids must be dropped')
  assert.deepEqual(withPresets[0].entries, ['kept'], 'an unusable member must be dropped and a repeat collapsed')
  assert.equal(withPresets[0].name, '好的', 'the first preset with an id wins')
  assert.equal(withPresets[1].name, 'unnamed', 'a preset with no name must fall back to its id')
  assert.equal(parsePresets('nonsense').length, 0, 'a preset list that is not a list must read as empty')
  assert.equal(activePresetOf('  full  '), 'full', 'the active id must be trimmed')
  assert.equal(activePresetOf(7), '', 'a non-string active id must read as no preset')

  // ── the real namespace schema, when schemastery is resolvable ───────────────

  let schemaNote = 'skipped (schemastery not resolvable from here)'
  try {
    const { default: Schema } = await load('@deepseek-ai/schemastery')
    const schema = buildIndexSchema(Schema)
    assert.equal(typeof schema.toJSON, 'function', 'the namespace schema must serialize for the settings wire')
    assert.deepEqual(schema({}).entries, [], 'an empty document must resolve to an empty index')
    const resolved = schema({ entries: [{ id: 'note', title: '补充说明', order: 40, enabled: true }] })
    assert.equal(resolved.entries.length, 1, 'the real schema must resolve a stored index')
    assert.equal(resolved.entries[0].id, 'note', 'the entry survives the round trip')
    assert.equal(
      resolved.entries[0].source,
      undefined,
      'a local entry must resolve without a source value, or every entry reads as subscribed',
    )
    const subscribedEntry = schema({ entries: [{ id: 'note', order: 40, enabled: true, source: 'src-a' }] })
    assert.equal(subscribedEntry.entries[0].source, 'src-a', 'a subscribed entry keeps its source')
    assert.equal(resolved.sources.length, 0, 'an absent source list resolves to empty')
    assert.deepEqual(schema({}).presets, [], 'an empty document must resolve to no presets')
    assert.equal(schema({}).activePreset, '', 'and to no preset in force')
    const stored = schema({ presets: [{ id: 'ctf', name: 'CTF 作业', entries: ['note'] }], activePreset: 'ctf' })
    assert.equal(stored.presets.length, 1, 'the real schema must resolve a stored preset')
    assert.equal(stored.presets[0].id, 'ctf', 'the preset id survives the round trip')
    assert.equal(stored.presets[0].name, 'CTF 作业', 'with its display name')
    assert.deepEqual(stored.presets[0].entries, ['note'], 'and the entries it selects')
    assert.equal(stored.activePreset, 'ctf', 'the preset in force is part of the document the page reads')
    schemaNote = 'real schemastery resolves the index, the presets, and serializes for the wire'
  } catch (error) {
    schemaNote = `skipped (${error.message})`
  }

  // ── user scripts supply variables, cached or measured ───────────────────────

  // A profile start reads the cache, so the values a script produced last time
  // are in force without executing anything.
  mkdirSync(join(STORE_ROOT, 'scripts'), { recursive: true })
  const cachedSource = 'console.log(JSON.stringify({ greet: "measured" }))'
  writeFileSync(join(STORE_ROOT, 'scripts', 'factory.js'), cachedSource, 'utf8')
  writeFileSync(join(STORE_ROOT, 'scripts', '.state.json'), `${JSON.stringify({
    factory: {
      sha1: bodyHash(cachedSource),
      ranAt: '2026-09-11T00:00:00.000Z',
      ms: 30,
      exitCode: 0,
      variables: { greet: 'cached' },
    },
  }, null, 2)}\n`, 'utf8')

  const scriptSettings = fakeSettings([])
  const scripted = await assembleWith({}, BARE, [scriptSettings.plugin])
  writeBody('scripted', 'greet={{greet}}')
  scriptSettings.state.value = { entries: [{ id: 'scripted', title: '脚本变量', order: 10, enabled: true }] }
  scriptSettings.state.watcher()
  assert.equal(
    (await scripted.read()).prompt,
    'greet=cached',
    'a script value cached from the last run is in force at mount, without executing anything',
  )

  // A script that has never run is picked up behind the mount, by a real
  // interpreter, and a prompt referencing it starts working without a restart.
  const LIVE = mkdtempSync(join(tmpdir(), 'prompt-manager-scripts-live-'))
  extraRoots.push(LIVE)
  mkdirSync(join(LIVE, 'scripts'), { recursive: true })
  writeFileSync(join(LIVE, 'scripts', 'runtime.js'), 'console.log(JSON.stringify({ stamp: "live" }))', 'utf8')
  const liveSettings = fakeSettings([])
  const live = await assembleWith({ storeDir: LIVE }, BARE, [liveSettings.plugin])
  writeBody('live', 'stamp={{stamp}}', LIVE)
  liveSettings.state.value = { entries: [{ id: 'live', title: '运行时脚本', order: 10, enabled: true }] }
  liveSettings.state.watcher()
  let livePrompt = ''
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      livePrompt = (await live.read()).prompt
    } catch (error) {
      livePrompt = `threw: ${error.message}`
    }
    if (livePrompt === 'stamp=live') break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(
    livePrompt,
    'stamp=live',
    'a script with no cached run is measured behind the mount, so a brand-new variable works without a restart',
  )

  // Letting go of the script must not let go of the value: a reference with no
  // value fails assembly, so the last good one stays in force.
  rmSync(join(LIVE, 'scripts', 'runtime.js'), { force: true })
  assert.equal((await live.read()).prompt, 'stamp=live', 'deleting a script freezes its variables rather than breaking the prompt')

  // A script that fails is its own problem: the mount, and every other prompt,
  // carry on.
  const BROKEN = mkdtempSync(join(tmpdir(), 'prompt-manager-scripts-broken-'))
  extraRoots.push(BROKEN)
  mkdirSync(join(BROKEN, 'scripts'), { recursive: true })
  writeFileSync(join(BROKEN, 'scripts', 'broken.js'), 'process.exit(3)', 'utf8')
  const brokenSettings = fakeSettings([])
  const broken = await assembleWith({ storeDir: BROKEN }, BARE, [brokenSettings.plugin])
  writeBody('plain', 'no variables here', BROKEN)
  brokenSettings.state.value = { entries: [{ id: 'plain', title: '普通', order: 10, enabled: true }] }
  brokenSettings.state.watcher()
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal((await broken.read()).prompt, 'no variables here', 'a script that fails costs nothing but its own values')

  // ── the routes reach the real engine, which is the seam the other two test
  //    files stub on either side ──────────────────────────────────────────────

  const LIVE_ROUTES = mkdtempSync(join(tmpdir(), 'prompt-manager-routes-live-'))
  extraRoots.push(LIVE_ROUTES)
  const routes = []
  const routeSettings = fakeSettings([])
  const mounted = await assembleWith({ storeDir: LIVE_ROUTES }, BARE, [routeSettings.plugin, fakeWebServer(routes)])
  writeBody('from-script', 'rust={{rust}}', LIVE_ROUTES)
  routeSettings.state.value = { entries: [{ id: 'from-script', title: '脚本变量', order: 10, enabled: true }] }
  routeSettings.state.watcher()
  assert.equal(routes.length, 1, 'the plugin registers exactly one route through the web server service')

  const handler = routes[0].handler
  const call = async (options) => {
    const response = fakeResponse()
    await handler(fakeRequest(options), response)
    return response
  }
  const saveScript = (name, rust, fence = null) => call({
    method: 'PUT',
    url: `${ROUTE_PREFIX}/script/${name}`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({ source: `console.log(JSON.stringify({ rust: "${rust}" }))`, fileSha1: fence }),
  })

  const saved = await saveScript('toolchain', '1.0.0')
  assert.equal(saved.state.status, 200, `a save through the route must answer 200, got ${saved.state.body}`)
  assert.equal(
    (await mounted.read()).prompt,
    'rust=1.0.0',
    'and the values it registered reach the prompt without a restart',
  )

  const listed = await call({ url: `${ROUTE_PREFIX}/variables` })
  const rust = listed.json().variables.find((variable) => variable.name === 'rust')
  assert.equal(rust.source, 'script', 'the variable list says which layer supplied a value')
  assert.equal(rust.detail, 'toolchain', 'and which script owns it')
  assert.deepEqual(rust.referencedBy, ['脚本变量'], 'and which entries reference it')
  assert.equal(
    listed.json().variables.some((variable) => variable.name === 'git'),
    true,
    'with the probe variables listed beside the script ones',
  )

  // A live script keeps its names: this is what stops two scripts from quietly
  // overwriting each other.
  const clash = await saveScript('clash', '3.0.0')
  assert.equal(clash.state.status, 409, 'a name a script still on disk owns is refused')
  assert.equal(clash.json().code, 'conflict', 'and the refusal says it was a conflict')

  // Deleting freezes the values...
  const removed = await call({ method: 'DELETE', url: `${ROUTE_PREFIX}/script/toolchain`, origin: 'http://127.0.0.1:3080' })
  assert.equal(removed.json().removed, true, 'deleting removes the file')
  assert.equal((await mounted.read()).prompt, 'rust=1.0.0', 'and the prompt keeps rendering what it last measured')

  // A value nothing references goes with its script. Keeping it would leave the
  // variables page showing a value for a script that no longer exists, which is
  // exactly what makes a deleted script look impossible to get rid of.
  const orphan = await call({
    method: 'PUT',
    url: `${ROUTE_PREFIX}/script/orphan`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({ source: 'console.log(JSON.stringify({ go: "1.22.0" }))', fileSha1: null }),
  })
  assert.equal(orphan.state.status, 200, `a second script must save, got ${orphan.state.body}`)
  const withOrphan = (await call({ url: `${ROUTE_PREFIX}/variables` })).json().variables
  assert.equal(withOrphan.some((variable) => variable.name === 'go'), true, 'and its variable is listed')
  await call({ method: 'DELETE', url: `${ROUTE_PREFIX}/script/orphan`, origin: 'http://127.0.0.1:3080' })
  const withoutOrphan = (await call({ url: `${ROUTE_PREFIX}/variables` })).json().variables
  assert.equal(
    withoutOrphan.some((variable) => variable.name === 'go'),
    false,
    'deleting a script whose variable nothing references takes the variable with it',
  )
  assert.equal(
    withoutOrphan.some((variable) => variable.name === 'rust'),
    true,
    'while one an entry still references stays frozen',
  )

  // ...and a name whose script is gone is adoptable, which is what makes a
  // rename work: delete the old script, save the new one under its own name.
  const renamed = await saveScript('toolchain2', '2.0.0')
  assert.equal(renamed.state.status, 200, `a script may adopt a name left by a deleted script, got ${renamed.state.body}`)
  assert.equal((await mounted.read()).prompt, 'rust=2.0.0', 'so a rename does not lock its variables behind a restart')

  // ── preset packs, through the route, against the real store and index ───────

  // A subscription on disk: the layout `sync` leaves behind, so `refreshLocations`
  // sees it and the export can name the source instead of copying its body.
  mkdirSync(join(LIVE_ROUTES, 'sources', 'pack', 'current'), { recursive: true })
  writeFileSync(join(LIVE_ROUTES, 'sources', 'pack', 'current', 'ctf.md'), '# 契约\n\n上游正文\n', 'utf8')
  writeFileSync(
    join(LIVE_ROUTES, 'sources', 'pack', 'state.json'),
    JSON.stringify({
      ref: 'main',
      files: { 'ctf.md': { id: 'pack-ctf', title: '契约', order: 30, enabled: true, sha1: 'a'.repeat(40) } },
      appliedAt: '2026-09-12T00:00:00.000Z',
      manifestSha1: 'b'.repeat(40),
      undo: {},
      headSha: 'c'.repeat(40),
    }),
    'utf8',
  )

  writeBody('local-one', '本地正文 {{rust}}', LIVE_ROUTES)
  routeSettings.state.value = {
    entries: [
      { id: 'local-one', title: '本地条目', order: 10, enabled: true },
      { id: 'pack-ctf', title: '契约', order: 30, enabled: true, source: 'pack' },
    ],
    presets: [{ id: 'ctf', name: 'ctf', entries: ['local-one', 'pack-ctf', 'gone-entry'] }],
    activePreset: '',
    sources: [{ id: 'pack', repo: 'o/r', ref: 'main', mirror: '', enabled: true }],
    mirror: '',
    proxy: { kind: 'none', url: '' },
  }
  routeSettings.state.watcher()

  const exported = await call({ url: `${ROUTE_PREFIX}/pack/export?preset=ctf` })
  assert.equal(exported.state.status, 200, `the export must answer 200, got ${exported.state.body}`)
  const carried = exported.json()
  assert.equal(carried.version, 1, 'the pack names the format version it was written in')
  assert.equal(carried.generator.pluginVersion.length > 0, true, 'and the version of the plugin that wrote it')
  assert.deepEqual(carried.missing, ['gone-entry'], 'a member the index no longer has is reported instead of dropped')
  assert.deepEqual(
    carried.entries.map((entry) => entry.id),
    ['local-one', 'pack-ctf'],
    'the members that do exist are carried, in the preset order',
  )
  assert.equal(carried.entries[0].body, '本地正文 {{rust}}', 'a local body is copied into the pack')
  assert.equal(carried.entries[0].origin, 'local', 'and labelled as this machine\'s own')
  assert.equal(carried.entries[1].body, undefined, 'a subscribed body is not copied')
  assert.deepEqual(
    carried.entries[1].source,
    { slug: 'pack', repo: 'o/r', ref: 'main', file: 'ctf.md' },
    'the pack names the source, the ref, and the file instead',
  )

  // Import the very pack this deployment just wrote, plus one new entry.
  const incoming = {
    ...carried,
    preset: { id: 'ctf', name: 'ctf', entries: ['local-one', 'pack-ctf', 'gone-entry', 'fresh-one'] },
    entries: [...carried.entries, { id: 'fresh-one', title: '新条目', order: 50, enabled: true, origin: 'local', body: '新正文 {{rust}}' }],
  }
  const imported = await call({
    method: 'POST',
    url: `${ROUTE_PREFIX}/pack/import`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify(incoming),
  })
  assert.equal(imported.state.status, 200, `the import must answer 200, got ${imported.state.body}`)
  const report = imported.json()
  assert.deepEqual(
    report.renamed,
    [{ from: 'local-one', to: 'local-one-2' }, { from: 'pack-ctf', to: 'pack-ctf-2' }],
    'ids already in use here give way to suffixed variants instead of overwriting anything',
  )
  assert.deepEqual(report.sourceDropped, ['契约'], 'and a renamed subscription gives up a source it could no longer read')
  assert.deepEqual(report.missingMembers, ['gone-entry'], 'a member the pack itself could not carry is reported')
  assert.deepEqual(report.unregistered, [], 'the imported bodies reference only variables this deployment registers')
  assert.equal(
    readFileSync(join(LIVE_ROUTES, 'sections', 'fresh-one.md'), 'utf8'),
    '新正文 {{rust}}',
    'the body the pack carried is on disk',
  )
  assert.equal(
    routeSettings.state.value.entries.some((entry) => entry.id === 'fresh-one'),
    true,
    'and the index names it',
  )
  assert.equal(
    routeSettings.state.value.entries.find((entry) => entry.id === 'pack-ctf-2').source,
    undefined,
    'while the entry that lost its id does not claim to be a subscription',
  )
  assert.deepEqual(
    routeSettings.state.value.presets.at(-1),
    { id: 'ctf-2', name: 'ctf', entries: ['local-one-2', 'pack-ctf-2', 'gone-entry', 'fresh-one'] },
    'the imported preset lands beside the one already here, its membership following the renames',
  )
  assert.equal(
    routeSettings.state.value.presets.length,
    2,
    'importing the same pack twice produces two sets rather than rewriting the first',
  )

  // A pack that cannot be read changes nothing at all.
  const entriesBefore = JSON.stringify(routeSettings.state.value.entries)
  const refused = await call({
    method: 'POST',
    url: `${ROUTE_PREFIX}/pack/import`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({ format: 'dsh-prompt-manager-pack', version: 1, preset: { name: 'x', entries: [] }, entries: [{ id: 'y', title: '' }] }),
  })
  assert.equal(refused.state.status, 400, 'a pack with an unusable entry is refused')
  assert.equal(JSON.stringify(routeSettings.state.value.entries), entriesBefore, 'and the index is untouched')

  // ── exporting and importing a preset never changes manual compression ──────

  writeBody('compact-zh', '压缩正文', LIVE_ROUTES)
  routeSettings.state.value = {
    entries: [
      ...routeSettings.state.value.entries,
      { id: 'compact-zh', title: '压缩指令', order: 90, enabled: false, kind: 'compaction' },
    ],
    presets: [{ id: 'ctf', name: 'ctf', entries: ['local-one', 'compact-zh'], compaction: 'compact-zh' }],
    activePreset: 'ctf',
  }
  routeSettings.state.watcher()
  const manualChoice = (await call({
    method: 'POST',
    url: `${ROUTE_PREFIX}/session/session-pack-manual`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({ compaction: 'compact-zh' }),
  })).json()
  assert.equal(manualChoice.compaction, 'compact-zh')
  const carrying = (await call({ url: `${ROUTE_PREFIX}/pack/export?preset=ctf` })).json()
  assert.deepEqual(carrying.preset, { id: 'ctf', name: 'ctf', entries: ['local-one'] }, 'export must remove old compression bindings and mistaken compression membership')
  assert.deepEqual(carrying.entries.map((entry) => entry.id), ['local-one'], 'an independent compression body must not be exported with the preset')

  const legacy = {
    ...carrying,
    preset: { ...carrying.preset, entries: ['local-one', 'compact-zh'], compaction: 'compact-zh' },
    entries: [...carrying.entries, { id: 'compact-zh', title: '压缩指令', order: 90, enabled: false, kind: 'compaction', body: '压缩正文' }],
  }
  const landed = await call({
    method: 'POST',
    url: `${ROUTE_PREFIX}/pack/import`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify(legacy),
  })
  assert.equal(landed.state.status, 200, `legacy compression bodies must remain importable, got ${landed.state.body}`)
  assert.equal(Object.hasOwn(landed.json().preset, 'compaction'), false, 'import must not recreate a preset compression binding')
  assert.ok(!landed.json().preset.entries.includes('compact-zh-2'), 'the imported compression entry must stay outside the preset')
  assert.equal(routeSettings.state.value.entries.find((entry) => entry.id === 'compact-zh-2').kind, 'compaction', 'the legacy body must stay an independent compression entry')
  assert.equal(readFileSync(join(LIVE_ROUTES, 'sections', 'compact-zh-2.md'), 'utf8'), '压缩正文', 'import must preserve the original compression body')
  assert.deepEqual((await call({ url: `${ROUTE_PREFIX}/session/session-pack-manual` })).json(), manualChoice, 'pack operations must leave the existing manual session choice unchanged')

  // Native references in an imported body are known without becoming plugin
  // globals. A genuinely unknown name must still be reported independently.
  const nativeImported = await call({
    method: 'POST',
    url: `${ROUTE_PREFIX}/pack/import`,
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({
      format: 'dsh-prompt-manager-pack', version: 1,
      preset: { id: 'contextual', name: '会话变量', entries: ['contextual'] },
      entries: [{ id: 'contextual', title: '会话变量', body: '{{cwd}} {{model}} {{provider}} {{truly_unknown}}' }],
    }),
  })
  assert.equal(nativeImported.state.status, 200)
  assert.deepEqual(nativeImported.json().unregistered, ['truly_unknown'], 'pack imports must not misreport DSH native references as unregistered')

  // ── a compaction instruction is an entry kind, not a section ─────────────────
  //
  // It shares the index, the body files, and the reference guard with every other
  // entry, but it reaches the summary call instead of the system prompt. So the
  // two things that must hold here: it never registers a section, and only a
  // pointer — not its own switch — decides which one is in force.

  assert.equal(activeCompactionOf(' compaction-zh '), 'compaction-zh', 'the pointer must be trimmed')
  assert.equal(activeCompactionOf(undefined), '', 'an absent pointer leaves the stock instruction in force')
  assert.equal(activeCompactionOf(7), '', 'a non-string pointer must read as none')

  const kinds = parseEntries({
    entries: [
      { id: 'plain', title: '段落', order: 10, enabled: true },
      { id: 'compact-zh', title: '压缩指令', order: 90, enabled: false, kind: 'compaction' },
      { id: 'bogus', title: '怪东西', order: 20, enabled: true, kind: 'nonsense' },
    ],
  })
  assert.equal(kinds.length, 3, 'every usable entry survives, whatever its kind')
  assert.equal(kinds[0].kind, undefined, 'a section entry must carry no kind, or every entry gains a phantom field')
  assert.equal(kinds[1].kind, 'compaction', 'a compaction entry keeps its kind')
  assert.equal(kinds[2].kind, undefined, 'an unknown kind must read as a section rather than dropping the entry')

  const chosen = parsePresets([{ id: 'ctf', name: 'ctf', entries: ['plain'], compaction: 'compact-zh' }])
  assert.deepEqual(chosen, [{ id: 'ctf', name: 'ctf', entries: ['plain'] }], 'legacy compression fields must be ignored when reading presets')
  assert.deepEqual(parsePresets([{ id: 'bare', name: 'bare', entries: [] }]), [{ id: 'bare', name: 'bare', entries: [] }], 'new presets must not gain a default compression field')
  assert.deepEqual(parsePresets([{ id: 'bad', name: 'bad', entries: [], compaction: 7 }]), [{ id: 'bad', name: 'bad', entries: [] }], 'even malformed legacy compression metadata is irrelevant to a preset')

  // The real schema, skipped only when schemastery itself is unresolvable — an
  // assertion failure here must never be swallowed into "skipped".
  let compactSchema
  try {
    const { default: Schema } = await load('@deepseek-ai/schemastery')
    compactSchema = buildIndexSchema(Schema)
  } catch {
    compactSchema = undefined
  }
  if (compactSchema === undefined) {
    console.log('  (schemastery is not resolvable here, so the compaction schema round trip is skipped)')
  } else {
    const stored = compactSchema({
      entries: [{ id: 'compact-zh', title: '压缩指令', order: 90, enabled: false, kind: 'compaction' }],
      compaction: 'compact-zh',
      presets: [{ id: 'ctf', name: 'ctf', entries: [], compaction: 'compact-zh' }],
    })
    assert.equal(stored.entries[0].kind, 'compaction', 'the schema must resolve a stored compaction entry')
    assert.equal(stored.compaction, 'compact-zh', 'legacy root metadata remains readable without deciding a session choice')
    assert.equal(Object.hasOwn(parsePresets(stored.presets)[0], 'compaction'), false, 'a legacy document must resolve to a section-only preset')
    const wire = compactSchema.toJSON()
    const presetListSchema = wire.refs[wire.refs[wire.uid].dict.presets]
    const presetSchema = wire.refs[presetListSchema.inner]
    assert.deepEqual(Object.keys(presetSchema.dict).sort(), ['entries', 'id', 'name'], 'the settings wire must expose no compression field on a preset')
    const plainDoc = compactSchema({ entries: [{ id: 'plain', title: 'x', order: 10, enabled: true }] })
    assert.equal(plainDoc.entries[0].kind, undefined, 'a stored section entry must not gain a kind')
    assert.equal(plainDoc.compaction, '', 'a document without a pointer must read as the stock instruction')
    assert.equal(
      compactSchema({ presets: [{ id: 'x', name: 'x', entries: [] }] }).presets[0].compaction,
      undefined,
      'and a preset must resolve without a phantom pointer field',
    )
  }

  const kindSettings = fakeSettings([])
  const kindDriven = await assembleWith({}, BARE, [kindSettings.plugin])
  writeBody('compact-zh', 'COMPACT-BODY')
  kindSettings.state.value = {
    entries: [
      { id: 'early', title: '先说的', order: 5, enabled: true },
      { id: 'compact-zh', title: '压缩指令', order: 90, enabled: true, kind: 'compaction' },
    ],
    compaction: 'compact-zh',
  }
  kindSettings.state.watcher()
  const kindRead = await kindDriven.read()
  assert.ok(kindRead.prompt.includes('EARLY-BODY'), 'a section entry beside a compaction entry must still inject')
  assert.ok(
    !kindRead.prompt.includes('COMPACT-BODY'),
    'a compaction entry must never reach the system prompt, whatever its own switch says',
  )
  assert.ok(
    !kindRead.assembly.sections.some((section) => section.name === sectionName('compact-zh')),
    'a compaction entry must not register a section at all',
  )

  // ── config validation ───────────────────────────────────────────────────────
  const fakeCtx = {
    effect: (execute) => {
      execute()
      return () => {}
    },
    get: () => undefined,
    inject: () => {},
    systemPrompt: {
      section: () => () => {},
      variable: () => () => {},
    },
  }
  assert.throws(
    () => apply(fakeCtx, { storeDir: STORE_ROOT, variables: { 'Bad-Name': 'x' } }),
    /invalid variable name/,
  )
  assert.throws(
    () => apply(fakeCtx, { storeDir: STORE_ROOT, probes: { 'Bad-Name': { command: 'x' } } }),
    /invalid variable name|not a usable variable name/,
    'a malformed probe name must fail the mount rather than leave an unusable reference',
  )
  assert.throws(
    () => apply(fakeCtx, { storeDir: STORE_ROOT, probes: { tool: { args: ['--version'] } } }),
    /needs a non-empty command/,
    'a probe without a command must fail the mount',
  )
  const tooMany = {}
  for (let index = 0; index <= MAX_PROBES; index += 1) tooMany[`tool${String(index)}`] = { command: 'x' }
  assert.throws(
    () => apply(fakeCtx, { storeDir: STORE_ROOT, probes: tooMany }),
    /at most 64 probes/,
    'the probe cap must fail the mount rather than probe silently in part',
  )
  assert.throws(
    () => apply(fakeCtx, { storeDir: STORE_ROOT, scripts: { 'Bad Name': {} } }),
    /not a usable script name/,
    'a script override under an unusable name must fail the mount',
  )
  assert.throws(
    () => apply(fakeCtx, { storeDir: STORE_ROOT, scripts: { toolchain: { timeoutMs: -1 } } }),
    /timeoutMs that is not a positive number/,
    'a script timeout that cannot be used must fail the mount',
  )

  console.log('smoke ok')
  console.log('  empty       a fresh install registers no section and injects nothing')
  console.log(`  sections    ${addedNames.join(' -> ')}`)
  console.log('  index       settings-driven add / enable / disable / order / sanitize')
  console.log('  presets     a session\'s own choice swaps the set, unknown id falls back to the switches')
  console.log('  members     a preset naming an entry this machine lacks, or one that is a compaction instruction, is reported once')
  console.log('  bodies      store file, subscribed snapshot, and a bodyless entry')
  console.log(`  variables   os=${facts.os} platform=${facts.platform} arch=${facts.arch} release=${facts.os_release}`)
  console.log(`              home=${facts.home} dsh_home=${facts.dsh_home} user=${facts.user} host=${facts.host}`)
  console.log(`  probes      measured at mount (node ${process.version}), absent tool -> 无, contested name reported`)
  console.log('  guard       an unresolvable reference renders as prose and is reported, never fatal')
  console.log('  scripts     a cached value is in force at mount; a new one is measured behind it, and a delete keeps only what an entry references')
  console.log(`  schema      ${schemaNote}`)
  console.log('  packs       export names a subscription instead of copying it; import lands bodies, then the index')
} finally {
  rmSync(STORE_ROOT, { recursive: true, force: true })
  for (const root of extraRoots) rmSync(root, { recursive: true, force: true })
}
