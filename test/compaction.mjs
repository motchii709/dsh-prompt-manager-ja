#!/usr/bin/env node
/**
 * Compaction test: the instruction a context compaction sends to its summarizer,
 * and the plugin's ability to replace it from an entry body.
 *
 * What is asserted is what the **adapter received** — the thing that would go on
 * the wire — not that some listener was called. The harness mounts the real
 * `@deepseek-ai/dsh-llm` runtime (no network: the adapter is a stand-in that
 * records every request and answers with one fixed chunk stream), so the
 * `llm/stream` waterfall, the message projection, and the adapter boundary are
 * all the real ones.
 *
 * Which instruction is in force is the *session's* own choice, so every request
 * below names the session it summarises (`sessionId`, as the engine sends it) and
 * the harness writes that session's own file under `<storeDir>/sessions/`. A
 * session that has chosen nothing gets DSH's own text, and the settings document
 * no longer decides this at all.
 *
 * Coverage: the untouched default, a replacement drawn from a body file with
 * variables interpolated, the identity of everything not replaced, requests that
 * must never be touched, the four ways a chosen instruction can be unusable, one
 * session's choice not reaching another, a frozen request, a deployment with no
 * LLM at all, and the config switch that turns the whole feature off.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { ROUTE_PREFIX, apply, inject, name } from '../lib/index.js'
import { fakeSettings, mountable } from './helpers/settings-source.mjs'

/** Throwaway home for the body files, so the test never touches a real one. */
const STORE_ROOT = mkdtempSync(join(tmpdir(), 'prompt-manager-compaction-'))

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

const { Context } = await load('@deepseek-ai/cordis')
const { default: LlmRuntime, LlmAdapter } = await load('@deepseek-ai/dsh-llm')
const { default: SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')

/**
 * The fake model. It records the request it was handed and answers with the
 * smallest chunk stream the runtime accepts, so a test asserts the request that
 * would have gone on the wire.
 */
class RecordingAdapter extends LlmAdapter {
  /** Every request handed to this adapter, oldest first. */
  requests = []

  async *stream(options) {
    this.requests.push(options)
    yield { type: 'text', text: '(stand-in model)' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Message ids are allocated from a counter so two builds of one shape compare equal. */
let messageSeq = 0

/**
 * One message in the shape the harness uses (role, content, source).
 * @param role - message role.
 * @param text - the single text block.
 * @param source - message provenance.
 * @returns the message.
 */
function message(role, text, source) {
  messageSeq += 1
  return { id: `m${String(messageSeq).padStart(3, '0')}`, role, content: [{ type: 'text', text }], source }
}

/** The directive DSH itself ships, as the summary call carries it. */
const STOCK_INSTRUCTION = 'You are now acting as a compaction engine for this AI coding assistant. Output EXACTLY the Markdown structure below: ...'

/**
 * The shape `dsh-compaction-basic` sends: the replayed conversation, and the
 * instruction as the final user message under its own plugin source.
 * @returns the message list.
 */
function compactionMessages() {
  return [
    message('system', 'SYSTEM-PROMPT-REPLAY', { kind: 'plugin', plugin: 'system-prompt' }),
    message('user', 'first request', { kind: 'user' }),
    message('assistant', 'working on it', { kind: 'assistant' }),
    message('user', STOCK_INSTRUCTION, { kind: 'plugin', plugin: 'dsh-compaction-basic' }),
  ]
}

/** The text of the last message: what the summarizer actually reads. */
function lastText(request) {
  return request.messages.at(-1).content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/** Consume a request the way the engine does. */
async function send(ctx, options) {
  for await (const _chunk of ctx.llm.stream(options)) { /* the chunks are not under test */ }
}

/** Write one entry body under the store root. */
function writeBody(id, text) {
  mkdirSync(SECTIONS, { recursive: true })
  writeFileSync(join(SECTIONS, `${id}.md`), text, 'utf8')
}

/** The session every compaction below is for, unless a test names another. */
const SESSION = 'session-compaction'

/**
 * Record one session's choice, the way the composer chip's own request does.
 *
 * The Host reads `<storeDir>/sessions/<id>.json` on every compaction, so this
 * writes the file the Host reads instead of going through the route: the route's
 * own shaping is asserted in `routes.mjs`, and which instruction a compaction
 * sends is what this file is about.
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

/**
 * One compaction request, shaped as `dsh-compaction-basic` sends it.
 *
 * `sessionId` is not decoration: it is the only thing that says whose choice
 * applies, and the engine always sends it.
 * @param messages - the replayed prefix plus the instruction.
 * @param sessionId - the session being summarised.
 * @returns the request to hand to `ctx.llm.stream`.
 */
function compactionFor(messages, sessionId = SESSION) {
  return { provider: 'lab', model: 'stand-in', purpose: 'compaction', sessionId, messages }
}

/** SystemPrompt config that keeps the assembly to what this plugin contributes. */
const BARE = { includeHarnessIdentity: false, includeRuntimeContext: false }

/**
 * Mount the plugin over the real LLM runtime.
 * @param config - plugin config.
 * @param options - `settings` to mount a settings service, `llm: false` to leave
 * the LLM out of the deployment entirely.
 * @returns the context, what the plugin warned about, the mounted plugin, and
 * the recording adapter when one was registered.
 */
async function mount(config = {}, options = {}) {
  const ctx = new Context()
  const warnings = []
  ctx.logger.warn = (...args) => { warnings.push(args.map(String).join(' ')) }
  await ctx.plugin(SystemPrompt, BARE)
  let adapter
  if (options.llm !== false) {
    await ctx.plugin(LlmRuntime)
    adapter = new RecordingAdapter()
    ctx.llm.registerAdapter(['lab'], adapter)
  }
  if (options.settings !== undefined) await ctx.plugin(options.settings.plugin)
  // The plugin's own `Config` is mounted with it: that is what makes cordis
  // resolve the index fields as live references, exactly as the Loader does.
  await ctx.plugin(
    mountable({ name, inject, apply, Config: moduleConfig }, options.settings?.state),
    { storeDir: STORE_ROOT, ...config },
  )
  await settle()
  return { ctx, warnings, adapter, settings: options.settings }
}

/**
 * One settings document holding a section entry and a compaction entry.
 *
 * It deliberately carries no instruction pointer: neither this document nor a
 * preset's own field answers "which instruction goes out" any more, and one case
 * below asserts exactly that by naming a different one here.
 */
function indexWith() {
  return {
    entries: [
      { id: 'note', title: '补充说明', order: 10, enabled: true },
      { id: 'compact-zh', title: '压缩指令', order: 90, enabled: false, kind: 'compaction' },
    ],
  }
}

try {
  // ── the default: nothing configured means DSH's own instruction stands ──────

  const settings = fakeSettings([])
  const driven = await mount({}, { settings })
  const { ctx, adapter } = driven

  const untouched = compactionMessages()
  await send(ctx, compactionFor(untouched))
  assert.equal(lastText(adapter.requests.at(-1)), STOCK_INSTRUCTION, 'a session that chose nothing sends the stock instruction unchanged')
  assert.equal(
    JSON.stringify(adapter.requests.at(-1).messages),
    JSON.stringify(untouched),
    'and no message may be touched at all',
  )

  // ── a session's choice replaces it with the entry body, variables and all ───

  writeBody('compact-zh', '压缩：{{os}} / {{nope}}')
  settings.state.value = indexWith()
  settings.state.watcher()
  choose(SESSION, { compaction: 'compact-zh' })

  const replaced = compactionMessages()
  await send(ctx, compactionFor(replaced))
  const afterReplace = adapter.requests.at(-1)
  const instruction = lastText(afterReplace)
  assert.ok(instruction.startsWith('压缩：'), `the body must replace the instruction, got: ${instruction.slice(0, 40)}`)
  assert.ok(!instruction.includes('compaction engine'), 'the stock instruction must not survive the replacement')
  assert.ok(
    /^压缩：\S+ \/ \{\{\u200b?nope\}\}/.test(instruction) || /^压缩：\S+ \/ \{\{nope\}\}/.test(instruction.replace(/\u200b/g, '')),
    `an unregistered reference must render as prose rather than throw, got: ${JSON.stringify(instruction)}`,
  )
  assert.ok(
    !instruction.includes('{{os}}'),
    'a registered variable — the plugin registers the platform facts itself — must be interpolated',
  )

  // Everything the replacement did not name is untouched, identity included.
  assert.equal(afterReplace.messages.length, replaced.length, 'replacing the instruction must not add or drop a message')
  for (let index = 0; index < replaced.length - 1; index += 1) {
    assert.equal(
      JSON.stringify(afterReplace.messages[index]),
      JSON.stringify(replaced[index]),
      `message ${String(index)} is part of the replayed prefix and must be byte-identical`,
    )
  }
  assert.equal(afterReplace.messages.at(-1).id, replaced.at(-1).id, 'the instruction keeps its identity when its text changes')
  assert.equal(afterReplace.messages.at(-1).role, 'user', 'and stays a user message')
  assert.deepEqual(
    afterReplace.messages.at(-1).source,
    { kind: 'plugin', plugin: 'dsh-compaction-basic' },
    'and keeps its provenance, which is what identifies a compaction call',
  )

  // ── requests that are not a compaction are never touched ────────────────────

  const conversation = [message('system', 'SYSTEM', { kind: 'plugin', plugin: 'system-prompt' }), message('user', 'hello', { kind: 'user' })]
  const conversationBefore = JSON.stringify(conversation)
  await send(ctx, { provider: 'lab', model: 'stand-in', messages: conversation })
  assert.equal(
    JSON.stringify(adapter.requests.at(-1).messages),
    conversationBefore,
    'an ordinary conversation request carries no purpose and must pass through untouched',
  )

  const titleRequest = [message('user', 'name this session', { kind: 'plugin', plugin: 'dsh-session-title' })]
  const titleBefore = JSON.stringify(titleRequest)
  await send(ctx, { provider: 'lab', model: 'stand-in', purpose: 'session-title', messages: titleRequest })
  assert.equal(
    JSON.stringify(adapter.requests.at(-1).messages),
    titleBefore,
    'the session-title call must not be mistaken for a compaction',
  )

  // ── the request arrives from another realm, which is how the real one does ──
  //
  // In a shipped deployment the compaction backend is mounted inside an isolated
  // group (`isolate: { compaction: true }`), while `llm` itself is not isolated,
  // so it is the same service this plugin injected. What this case pins down is
  // that interception follows the *request*, not the context this plugin happens
  // to sit in: a listener wired to the wrong context would leave every real
  // compaction alone and nothing would report it.

  const realm = ctx.isolate('compaction')
  let fromRealm
  await realm.plugin({
    name: 'stand-in-backend',
    inject: ['llm'],
    apply: (scoped) => {
      fromRealm = async () => {
        for await (const _chunk of scoped.llm.stream(compactionFor(compactionMessages()))) { /* the chunks are not under test */ }
      }
    },
  })
  writeBody('compact-zh', 'FROM-ANOTHER-REALM')
  await fromRealm()
  assert.equal(
    lastText(adapter.requests.at(-1)),
    'FROM-ANOTHER-REALM',
    'a compaction issued from an isolated realm must still be intercepted',
  )

  // ── the instruction is found by provenance, not by counting ─────────────────
  //
  // The engine tags the message it appends (`source.plugin` is its own package
  // name), and that tag is what the plugin looks for. Counting would be a guess
  // about another package's internals; this is the shape the tag actually takes,
  // taken from the backend that ships in this harness.

  settings.state.value = indexWith()
  settings.state.watcher()
  writeBody('compact-zh', 'FOUND-BY-TAG')
  const tagged = [
    ...compactionMessages(),
    message('user', 'a later message the projection added', { kind: 'user' }),
  ]
  await send(ctx, compactionFor(tagged))
  const found = adapter.requests.at(-1)
  assert.equal(lastText(found), 'a later message the projection added', 'the message that is not the instruction must stay last')
  assert.equal(
    found.messages[3].content.find((block) => block.type === 'text').text,
    'FOUND-BY-TAG',
    'the instruction must be replaced where it actually is, not where it is usually appended',
  )

  // An untagged instruction still gets replaced: the last message is the
  // fallback, and a compaction request that carries no tag is still a compaction.
  writeBody('compact-zh', 'LAST-RESORT-BODY')
  const untagged = [
    message('system', 'SYSTEM-PROMPT-REPLAY', { kind: 'plugin', plugin: 'system-prompt' }),
    message('user', 'first request', { kind: 'user' }),
    message('user', 'STOCK-INSTRUCTION-UNTAGGED'),
  ]
  await send(ctx, compactionFor(untagged))
  assert.equal(
    lastText(adapter.requests.at(-1)),
    'LAST-RESORT-BODY',
    'an instruction that carries no provenance must still be replaced, from the last message',
  )

  // ── the four ways a chosen instruction is unusable: all pass through ────────

  const unusable = [
    { label: 'a session naming an entry the index does not have', id: 'gone' },
    { label: 'a session naming a section entry', id: 'note' },
  ]
  for (const sample of unusable) {
    choose(SESSION, { compaction: sample.id })
    const request = compactionMessages()
    await send(ctx, compactionFor(request))
    assert.equal(
      lastText(adapter.requests.at(-1)),
      STOCK_INSTRUCTION,
      `${sample.label} must leave the stock instruction in force`,
    )
  }

  // An entry that is in force but has no body yet must not blank the instruction.
  writeBody('compact-empty', '   \n')
  settings.state.value = {
    entries: [
      ...indexWith().entries,
      { id: 'compact-empty', title: '空的', order: 91, enabled: false, kind: 'compaction' },
    ],
  }
  settings.state.watcher()
  choose(SESSION, { compaction: 'compact-empty' })
  await send(ctx, compactionFor(compactionMessages()))
  assert.equal(
    lastText(adapter.requests.at(-1)),
    STOCK_INSTRUCTION,
    'a body that is only whitespace must leave the stock instruction in force rather than send nothing',
  )

  // The body file deleted by hand, with the index still naming it.
  rmSync(join(SECTIONS, 'compact-zh.md'), { force: true })
  choose(SESSION, { compaction: 'compact-zh' })
  await send(ctx, compactionFor(compactionMessages()))
  assert.equal(
    lastText(adapter.requests.at(-1)),
    STOCK_INSTRUCTION,
    'a body file that vanished must leave the stock instruction in force',
  )

  // ── a frozen request is left alone rather than failing the compaction ───────

  writeBody('compact-zh', 'FROZEN-CASE-BODY')
  const frozen = Object.freeze({
    provider: 'lab',
    model: 'stand-in',
    purpose: 'compaction',
    sessionId: SESSION,
    messages: Object.freeze(compactionMessages()),
  })
  await assert.doesNotReject(
    () => send(ctx, frozen),
    'a request this plugin cannot rewrite must not become a failed compaction',
  )
  assert.equal(lastText(adapter.requests.at(-1)), STOCK_INSTRUCTION, 'and it must go out with the instruction it came in with')

  // ── the session's own choice is the only pointer, and it is nobody else's ───

  // Both of the old global pointers are still sitting in the document here, and
  // both name a *different* instruction: the root `compaction` field and the
  // preset's obsolete field. Neither may move what this session sends. Preset
  // switches now write only the preset id, and compression changes only when
  // this session manually selects it.
  const OTHER = 'session-compaction-other'
  writeBody('compact-preset', 'PRESET-BODY')
  settings.state.value = {
    entries: [
      ...indexWith().entries,
      { id: 'compact-preset', title: '组合用的压缩指令', order: 92, enabled: false, kind: 'compaction' },
    ],
    compaction: 'compact-preset',
    presets: [{ id: 'ctf', name: 'ctf', entries: ['note'], compaction: 'compact-preset' }],
    activePreset: 'ctf',
  }
  settings.state.watcher()
  await send(ctx, compactionFor(compactionMessages()))
  assert.equal(
    lastText(adapter.requests.at(-1)),
    'FROZEN-CASE-BODY',
    'the document pointer and the preset in force decide nothing: the session choice is what is in force',
  )

  choose(SESSION, { compaction: 'compact-preset' })
  await send(ctx, compactionFor(compactionMessages()))
  assert.equal(
    lastText(adapter.requests.at(-1)),
    'PRESET-BODY',
    'a session that switches its instruction sends the one it switched to',
  )

  // The point of the whole module: that switch was this conversation's. A
  // compaction for a session that chose nothing must not inherit it.
  await send(ctx, compactionFor(compactionMessages(), OTHER))
  assert.equal(
    lastText(adapter.requests.at(-1)),
    STOCK_INSTRUCTION,
    'another session must not inherit an instruction this one chose',
  )

  choose(OTHER, { preset: 'ctf', compaction: 'compact-zh' })
  await send(ctx, compactionFor(compactionMessages(), OTHER))
  assert.equal(
    lastText(adapter.requests.at(-1)),
    'FROZEN-CASE-BODY',
    'and a session that chose for itself sends its own, whatever another session chose',
  )

  choose(SESSION, { preset: 'ctf', compaction: '' })
  await send(ctx, compactionFor(compactionMessages()))
  assert.equal(
    lastText(adapter.requests.at(-1)),
    STOCK_INSTRUCTION,
    'a session that chose no instruction goes back to the stock one, whatever the document pointer says',
  )

  // ── a deployment with no LLM mounts, it just never intercepts ───────────────

  const noLlm = fakeSettings([])
  const bare = await mount({}, { settings: noLlm, llm: false })
  assert.equal(typeof moduleConfig?.toJSON, 'function', 'the plugin must expose the row-config schema the Loader resolves')
  assert.deepEqual(
    noLlm.state.value.entries,
    [{ id: 'env', title: '机器环境', order: 5, enabled: true }],
    'the plugin must mount and serve its index even with no llm service',
  )
  assert.ok(
    bare.warnings.every((line) => !line.includes('compaction')),
    `mounting without an llm service is not a problem to report, got: ${bare.warnings.join(' | ')}`,
  )

  // ── the config switch turns the feature off, and turns it back on live ──────
  //
  // `compaction` is a volatile config field, so it is read per call: a mount that
  // cached the switch would turn the seam off forever the first time it saw
  // `false`, and a deployment could never turn it back on without a restart.

  const off = fakeSettings([])
  const switched = await mount({ compaction: false }, { settings: off })
  writeBody('compact-zh', 'SWITCHED-BODY')
  off.state.value = indexWith()
  // A session asking for one is exactly the case the switch has to override.
  choose(SESSION, { compaction: 'compact-zh' })
  await send(switched.ctx, compactionFor(compactionMessages()))
  assert.equal(
    lastText(switched.adapter.requests.at(-1)),
    STOCK_INSTRUCTION,
    'compaction: false must leave every request exactly as it was',
  )

  off.state.value = { compaction: true }
  await send(switched.ctx, compactionFor(compactionMessages()))
  assert.equal(
    lastText(switched.adapter.requests.at(-1)),
    'SWITCHED-BODY',
    'a live commit back to true must re-enable the seam without a remount',
  )

  off.state.value = { compaction: 'compact-zh' }
  await send(switched.ctx, compactionFor(compactionMessages()))
  assert.equal(
    lastText(switched.adapter.requests.at(-1)),
    'SWITCHED-BODY',
    'the legacy string pointer leaves the seam on: which entry is in force is still the session\'s own choice',
  )

  off.state.value = { compaction: false }
  await send(switched.ctx, compactionFor(compactionMessages()))
  assert.equal(
    lastText(switched.adapter.requests.at(-1)),
    STOCK_INSTRUCTION,
    'and turning it off again takes effect on the very next call',
  )

  console.log('compaction ok')
  console.log('  default     a session that chose nothing gets the instruction DSH ships, byte for byte')
  console.log('  replace     the entry body goes out with its variables resolved, the replayed prefix untouched')
  console.log('  scope       conversation and session-title calls are never touched')
  console.log('  realm       a compaction issued from an isolated group is intercepted too, which is the shipped topology')
  console.log('  unusable    a dangling id, a section id, an empty body, and a deleted file all pass through')
  console.log('  frozen      a request that cannot be rewritten goes out unchanged instead of failing')
  console.log('  sessions    the session file is the only pointer, its choice reaches no other session, and none goes back to stock')
  console.log('  optional    no llm service still mounts; compaction: false never intercepts')
  console.log(`  routes      ${ROUTE_PREFIX} routes are registered by the same mount`)
} finally {
  rmSync(STORE_ROOT, { recursive: true, force: true })
}
