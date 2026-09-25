#!/usr/bin/env node
/**
 * Script test: the user-written scripts whose output becomes prompt variables.
 *
 * One script is one file; its standard output is a JSON object whose keys become
 * `{{name}}` references. The process runner is injected, so every outcome —
 * success, a non-zero exit, an interpreter that cannot start, a timeout — is
 * exercised without depending on the tools a machine happens to have; the last
 * block runs the real runner over real files to prove that path works too.
 *
 * Coverage: output parsing and its refusals, override resolution and its shape
 * checks, syntax checking, save-then-run ordering, the write fence, the cache
 * mountDeclare reads, dropping the values of a deleted script that nothing
 * references, path confinement, and the draft run that must leave nothing behind.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_PROBE_TEXTS, MAX_PROBE_VALUE } from '../lib/probe.js'
import { bodyHash } from '../lib/store.js'
import {
  checkSyntax,
  cleanDrafts,
  DEFAULT_SCRIPT_TIMEOUT_MS,
  MAX_SCRIPT_BYTES,
  MAX_SCRIPTS,
  MAX_SCRIPT_VARIABLES,
  normalizeScriptOverrides,
  parseScriptOutput,
  PromptScripts,
  readScriptState,
  resolveSpec,
  SCRIPT_EXTENSION,
  SCRIPT_STATE_FILE,
  ScriptError,
  writeScriptState,
} from '../lib/scripts.js'

/** Throwaway storage root for the whole run. */
const ROOT = mkdtempSync(join(tmpdir(), 'prompt-manager-scripts-'))

/** Directory the engine owns. */
const SCRIPTS = join(ROOT, 'scripts')

/** The source a good script has, as far as these tests care. */
const GOOD = 'console.log(JSON.stringify({ rust: "1.80.0" }))'

/** A second good script, supplying a name no other script in this test claims. */
const OTHER = 'console.log(JSON.stringify({ go: "1.22.0" }))'

/**
 * One canned process run.
 * @param stdout - what the script printed.
 * @param extra - fields to override.
 * @returns a run result.
 */
function answer(stdout, extra = {}) {
  return { spawnError: undefined, status: 0, stdout, stderr: '', timedOut: false, ...extra }
}

/**
 * A runner that answers one canned result and records what it was asked to run.
 * @param result - the run to answer with, or a function of the spec.
 * @returns the runner plus the calls it received.
 */
function canned(result) {
  const calls = []
  const run = async (spec, options) => {
    calls.push({ spec, options })
    return typeof result === 'function' ? result(spec) : result
  }
  return { run, calls }
}

/** What each canned source prints, keyed by the source itself. */
const OUTPUT = new Map([
  [GOOD, '{"rust":"1.80.0","cargo":"1.79.0"}'],
  [OTHER, '{"go":"1.22.0"}'],
  ['nonsense', 'rust 1.80.0'],
  ['console.log(JSON.stringify({ probe: "ok" }))', '{"probe":"ok"}'],
])

/**
 * A runner that reads the file it was pointed at and answers that source's
 * output, which is the closest a stand-in can get to running it.
 * @returns the runner plus the calls it received.
 */
function sourceAware() {
  const calls = []
  const run = async (spec, options) => {
    calls.push({ spec, options })
    const source = readFileSync(spec.args[spec.args.length - 1], 'utf8')
    return answer(OUTPUT.get(source) ?? '{"fallback":"1"}')
  }
  return { run, calls }
}

/**
 * A runner for the script cap, where every script must supply a name of its own.
 * @returns the runner plus the calls it received.
 */
function numbered() {
  const calls = []
  const run = async (spec) => {
    calls.push({ spec })
    const source = readFileSync(spec.args[spec.args.length - 1], 'utf8')
    const index = /v(\d+)\s*:/.exec(source)?.[1] ?? 'x'
    return answer(`{"v${index}":"1"}`)
  }
  return { run, calls }
}

/**
 * A stand-in plugin side, mirroring the registry's own conflict rule.
 * @param overrides - per-script overrides the host reports.
 * @param dir - the directory the host points the engine at.
 * @returns the host plus the variables and warnings it collected.
 */
function fakeHost(overrides = {}, dir = SCRIPTS) {
  const declared = new Map()
  const warnings = []
  const forgotten = []
  const referenced = new Set()
  return {
    declared,
    warnings,
    forgotten,
    /** Mark one variable as referenced by an entry body. */
    reference: (name) => { referenced.add(name) },
    dir: () => dir,
    overrides: () => overrides,
    texts: () => DEFAULT_PROBE_TEXTS,
    declare: (name, value, detail) => {
      const existing = declared.get(name)
      if (existing === undefined) {
        declared.set(name, { value, detail })
        return 'declared'
      }
      if (existing.detail !== detail) return 'conflict'
      existing.value = value
      return 'assigned'
    },
    owner: (name) => declared.get(name)?.detail,
    referenced: (name) => referenced.has(name),
    forget: (name, detail) => {
      const existing = declared.get(name)
      if (existing === undefined || existing.detail !== detail) return
      declared.delete(name)
      forgotten.push(name)
    },
    warn: (message) => warnings.push(message),
  }
}

/**
 * Write one script file directly, as a person with an editor would.
 * @param name - script name.
 * @param source - file contents.
 * @param dir - directory to write into.
 * @returns the script's sha1.
 */
function writeScript(name, source, dir = SCRIPTS) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}${SCRIPT_EXTENSION}`), source, 'utf8')
  return bodyHash(source)
}

try {
  // ── the output grammar ──────────────────────────────────────────────────────

  const parsed = parseScriptOutput('{"rust":"1.80.0","count":3}')
  assert.deepEqual(parsed.variables, { rust: '1.80.0', count: '3' }, 'string and finite-number values are used as they stand')
  assert.deepEqual(parsed.problems, [], 'a flat object of scalars is exactly what a script must print')

  for (const [label, stdout, expected] of [
    ['no output at all', '', '脚本没有输出任何内容'],
    ['a non-JSON line', 'rust 1.80.0', '输出不是合法 JSON'],
    ['an array', '[1,2]', '输出必须是 JSON 对象'],
    ['an empty object', '{}', '对象里没有任何键'],
  ]) {
    const refused = parseScriptOutput(stdout)
    assert.equal(refused.problems.length, 1, `${label} must be refused`)
    assert.ok(refused.problems[0].includes(expected), `${label} must say why: ${refused.problems[0]}`)
  }

  const nested = parseScriptOutput('{"a":{"b":1}}')
  assert.equal(nested.problems[0], '变量 a 的值必须是字符串或数字', 'a nested value cannot be interpolated, so it is refused')
  const nulled = parseScriptOutput('{"a":null}')
  assert.equal(nulled.problems[0], '变量 a 的值必须是字符串或数字', 'null is refused too, rather than rendered as "null"')
  const shouted = parseScriptOutput('{"Rust":"1.80.0"}')
  assert.ok(shouted.problems[0].includes('不合法'), 'an upper-case name can never be a prompt variable')

  const emptied = parseScriptOutput('{"a":""}')
  assert.equal(emptied.variables.a, DEFAULT_PROBE_TEXTS.empty, 'an empty value becomes a placeholder, never an empty string')

  const long = parseScriptOutput(JSON.stringify({ a: 'x'.repeat(MAX_PROBE_VALUE + 40) }))
  assert.equal(long.variables.a.length, MAX_PROBE_VALUE, 'a value is cut to what a prompt can carry')
  assert.deepEqual(long.truncated, ['a'], 'and the cut is reported so the page can say so')

  const many = parseScriptOutput(JSON.stringify(Object.fromEntries(
    Array.from({ length: MAX_SCRIPT_VARIABLES + 1 }, (_, index) => [`v${String(index)}`, 'x']),
  )))
  assert.ok(many.problems[0].includes('最多'), 'one script cannot declare an unbounded number of variables')

  // ── how a script is run ─────────────────────────────────────────────────────

  const bare = resolveSpec('/tmp/x/toolchain.js', undefined)
  assert.deepEqual(bare, { command: 'node', args: ['/tmp/x/toolchain.js'], timeoutMs: DEFAULT_SCRIPT_TIMEOUT_MS }, 'a script with no override runs under node with its own path')

  const otherInterpreter = resolveSpec('/tmp/x/toolchain.js', { command: 'C:\\python\\python.exe' })
  assert.deepEqual(otherInterpreter.args, ['/tmp/x/toolchain.js'], 'changing the interpreter keeps the default argument')

  const templated = resolveSpec('/tmp/x/toolchain.js', { command: 'python', args: ['-u', '{script}'] })
  assert.deepEqual(templated.args, ['-u', '/tmp/x/toolchain.js'], 'the placeholder becomes the script path')

  const appended = resolveSpec('/tmp/x/toolchain.js', { command: 'python', args: ['-u'] })
  assert.deepEqual(appended.args, ['-u', '/tmp/x/toolchain.js'], 'an override that never mentions the script gets it appended')

  assert.equal(resolveSpec('/tmp/x/toolchain.js', { timeoutMs: 900 }).timeoutMs, 900, 'an override may set its own timeout')

  const overrides = normalizeScriptOverrides({
    toolchain: { timeoutMs: 900 },
    inventory: { command: 'python', args: ['{script}'] },
  })
  assert.deepEqual(overrides.problems, [], 'a well-formed override map is accepted')
  assert.equal(overrides.overrides.inventory.command, 'python', 'and kept')

  for (const [label, raw] of [
    ['a name that is not a script name', { 'BAD NAME': { timeoutMs: 1 } }],
    ['an override that is not a mapping', { toolchain: 'node' }],
    ['an empty command', { toolchain: { command: '  ' } }],
    ['args that are not strings', { toolchain: { args: [1] } }],
    ['a non-positive timeout', { toolchain: { timeoutMs: 0 } }],
    ['a list instead of a map', [{ command: 'node' }]],
  ]) {
    assert.ok(normalizeScriptOverrides(raw).problems.length > 0, `${label} must be reported`)
  }

  assert.equal(checkSyntax(GOOD), undefined, 'a script that parses is accepted')
  assert.equal(checkSyntax('function ('), 'Function statements require a function name', 'a script that does not parse reports the parser message')
  assert.ok(checkSyntax('const x = ').includes('Unexpected end of input'), 'and an unfinished script reports where it ran out')

  // ── saving, running, and what each leaves behind ────────────────────────────

  const host = fakeHost()
  const runner = sourceAware()
  const engine = new PromptScripts(host, { run: runner.run })

  const saved = await engine.save('toolchain', GOOD, { kind: 'absent' })
  assert.equal(existsSync(join(SCRIPTS, `toolchain${SCRIPT_EXTENSION}`)), true, 'a saved script becomes a file')
  assert.equal(readFileSync(join(SCRIPTS, `toolchain${SCRIPT_EXTENSION}`), 'utf8'), GOOD, 'and the file is the source, byte for byte')
  assert.deepEqual(saved.variables, { rust: '1.80.0', cargo: '1.79.0' }, 'one script supplies as many variables as its object has keys')
  assert.equal(saved.sha1, bodyHash(GOOD), 'the save reports the hash the next write fences against')
  assert.equal(host.declared.get('rust').value, '1.80.0', 'the values reach the registry through the host')
  assert.equal(host.declared.get('rust').detail, 'toolchain', 'and each one remembers which script owns it')

  const saveCalls = runner.calls.length
  assert.equal(runner.calls.at(-1).options.cwd, SCRIPTS, 'a run happens in the script directory, so its relative paths mean something')
  assert.equal(runner.calls.at(-1).options.name, 'toolchain', 'and the runner is told which script it is running')
  assert.ok(runner.calls.at(-1).spec.args[0].includes('.draft-'), 'a save runs a draft first, so a script that does not work never becomes a file')

  const cached = readScriptState(SCRIPTS)
  assert.equal(cached.toolchain.sha1, bodyHash(GOOD), 'a successful run is cached with the source it belongs to')
  assert.deepEqual(cached.toolchain.variables, { rust: '1.80.0', cargo: '1.79.0' }, 'and with the values it produced')

  const brokenOutput = await engine.save('first-run', 'nonsense', { kind: 'absent' }).then(
    () => undefined,
    (error) => error,
  )
  assert.ok(brokenOutput instanceof ScriptError, 'a script whose output is unusable is refused')
  assert.equal(brokenOutput.reason, 'invalid-output', 'and the refusal says the run was the problem')
  assert.ok(brokenOutput.report !== undefined, 'carrying the run report the page shows')
  assert.equal(existsSync(join(SCRIPTS, `first-run${SCRIPT_EXTENSION}`)), false, 'and nothing reaches the disk')

  const badSyntax = await engine.save('syntax', 'function (', { kind: 'absent' }).then(() => undefined, (error) => error)
  assert.equal(badSyntax.reason, 'invalid-source', 'a script that does not parse is refused')
  assert.equal(runner.calls.length, saveCalls + 1, 'and it is refused before anything is executed')

  const oversized = await engine.save('huge', `//${'x'.repeat(MAX_SCRIPT_BYTES)}`, { kind: 'absent' }).then(() => undefined, (error) => error)
  assert.equal(oversized.reason, 'invalid-source', 'an oversized script is refused')

  // The host reports itself as the owner of `os`, so a script claiming it is refused.
  const hostWithOs = fakeHost()
  hostWithOs.declare('os', 'Windows', 'environment')
  const claiming = new PromptScripts(hostWithOs, { run: canned(answer('{"os":"Linux"}')).run })
  const nameTaken = await claiming.save('clash', 'console.log("{}")', { kind: 'absent' }).then(() => undefined, (error) => error)
  assert.equal(nameTaken.reason, 'conflict', 'a variable another source owns is refused rather than shadowed')
  assert.equal(existsSync(join(SCRIPTS, `clash${SCRIPT_EXTENSION}`)), false, 'and the conflicting script is not written')

  const stale = await engine.save('toolchain', GOOD, { kind: 'sha1', sha1: 'f'.repeat(40) }).then(() => undefined, (error) => error)
  assert.equal(stale.reason, 'conflict', 'a stale draft cannot overwrite a file that changed underneath it')
  const alreadyThere = await engine.save('fresh-again', OTHER, { kind: 'absent' })
  const duplicate = await engine.save('fresh-again', OTHER, { kind: 'absent' }).then(() => undefined, (error) => error)
  assert.equal(duplicate.reason, 'conflict', 'a brand-new script must find no file, and a second save is refused')
  assert.equal(alreadyThere.name, 'fresh-again', 'the first save is what made the file')

  // ── failure classification, all of which must stay reportable ───────────────

  const timeout = new PromptScripts(host, { run: canned(answer('', { timedOut: true })).run })
  const timedOut = await timeout.runSource('toolchain', GOOD)
  assert.equal(timedOut.ok, false, 'a script that never exits fails its run')
  assert.ok(timedOut.problems[0].includes('超时'), `a timeout says so: ${timedOut.problems[0]}`)

  const missing = new PromptScripts(host, { run: canned(answer('', { spawnError: 'ENOENT' })).run })
  const noInterpreter = await missing.runSource('toolchain', GOOD)
  assert.equal(noInterpreter.ok, false, 'an interpreter that cannot start fails its run')
  assert.ok(noInterpreter.problems[0].includes('无法启动'), 'and the missing tool is named')

  const noisy = new PromptScripts(host, { run: canned(answer('{"rust":"1.80.0"}', { status: 1, stderr: 'warning: nothing to do' })).run })
  const nonZero = await noisy.runSource('toolchain', GOOD)
  assert.equal(nonZero.ok, true, 'a non-zero exit that still printed a usable object is kept')
  assert.ok(nonZero.warnings[0].includes('退出码 1'), 'with the exit code reported beside the values')
  assert.equal(nonZero.stderr, 'warning: nothing to do', 'and the stream for the page to show')

  const failedBadly = new PromptScripts(host, { run: canned(answer('boom', { status: 2 })).run })
  const both = await failedBadly.runSource('toolchain', GOOD)
  assert.equal(both.ok, false, 'a non-zero exit with unusable output fails')
  assert.ok(both.problems[0].startsWith('退出码 2'), 'and the report carries both facts')

  // ── a draft run leaves nothing behind ───────────────────────────────────────

  const draftsBefore = readdirSync(SCRIPTS).filter((name) => name.startsWith('.draft-')).length
  const declarationsBefore = host.declared.size
  const draft = await engine.runSource('scratch', 'console.log(JSON.stringify({ probe: "ok" }))')
  assert.equal(draft.ok, true, 'a draft run reports what it produced')
  assert.equal(draft.variables.probe, 'ok', 'including the variables a person would get')
  assert.equal(host.declared.size, declarationsBefore, 'but a draft registers nothing, so trying something out cannot change the prompt')
  assert.equal(readdirSync(SCRIPTS).filter((name) => name.startsWith('.draft-')).length, draftsBefore, 'and its throwaway file is gone')
  assert.equal(existsSync(join(SCRIPTS, `scratch${SCRIPT_EXTENSION}`)), false, 'nothing was written under the draft name')

  writeFileSync(join(SCRIPTS, '.draft-999-1.js'), 'left over from a crash', 'utf8')
  cleanDrafts(SCRIPTS)
  assert.equal(existsSync(join(SCRIPTS, '.draft-999-1.js')), false, 'an interrupted draft is cleaned up at mount')
  assert.equal(existsSync(join(SCRIPTS, SCRIPT_STATE_FILE)), true, 'and the bookkeeping file is left alone')

  // ── the cache, and what a mount sees ────────────────────────────────────────

  // A directory of its own, so nothing an earlier case wrote can be declared here.
  const CACHE = join(ROOT, 'cached')
  const sha1 = writeScript('inventory', GOOD, CACHE)
  const fresh = fakeHost({}, CACHE)
  const freshEngine = new PromptScripts(fresh, { run: canned(answer('{"rust":"9.9.9"}')).run })
  assert.deepEqual(freshEngine.mountDeclare(), ['inventory'], 'a script with no cached run is left for a refresh')
  assert.equal(fresh.declared.size, 0, 'so a profile start does not wait for it')

  writeScriptState(CACHE, {
    inventory: { sha1, ranAt: '2026-09-11T00:00:00.000Z', ms: 40, variables: { rust: '1.80.0' } },
  })
  const cachedHost = fakeHost({}, CACHE)
  const cachedEngine = new PromptScripts(cachedHost, { run: canned(answer('{"rust":"9.9.9"}')).run })
  assert.deepEqual(cachedEngine.mountDeclare(), [], 'a script whose file still hashes to its cached run needs no run')
  assert.equal(cachedHost.declared.get('rust').value, '1.80.0', 'and its cached value is in force from the first assembly')

  writeScript('inventory', `${GOOD}\n// changed while the profile was down`, CACHE)
  const changed = new PromptScripts(fakeHost({}, CACHE), { run: canned(answer('{"rust":"9.9.9"}')).run })
  assert.deepEqual(changed.mountDeclare(), ['inventory'], 'a script edited while the profile was down is picked up by a refresh')

  writeFileSync(join(CACHE, SCRIPT_STATE_FILE), '{ not json', 'utf8')
  assert.deepEqual(readScriptState(CACHE), {}, 'a damaged cache reads as empty rather than breaking the mount')

  // ── deleting a script drops what nothing references ────────────────────────

  const frozenHost = fakeHost()
  const frozenEngine = new PromptScripts(frozenHost, { run: canned(answer('{"rust":"1.80.0"}')).run })
  await frozenEngine.save('frozen', GOOD, { kind: 'absent' })
  assert.equal(frozenHost.declared.get('rust').value, '1.80.0', 'the script supplies its values')
  frozenHost.reference('rust')
  assert.equal(frozenEngine.remove('frozen'), true, 'deleting it removes the file')
  assert.equal(existsSync(join(SCRIPTS, `frozen${SCRIPT_EXTENSION}`)), false, 'from the disk')
  assert.equal(readScriptState(SCRIPTS).frozen, undefined, 'and from the cache')
  assert.equal(frozenHost.declared.get('rust').value, '1.80.0', 'an entry still references the name, so the value stays in force: a missing one would fail assembly')
  assert.equal(frozenEngine.list().some((script) => script.name === 'frozen'), false, 'while the page no longer lists the script')

  // Nothing references this one, so keeping it would leave the variables page
  // showing a value for a script that is gone — the shape of a script that looks
  // impossible to delete.
  const droppedHost = fakeHost()
  const droppedEngine = new PromptScripts(droppedHost, { run: canned(answer('{"gone":"1"}')).run })
  await droppedEngine.save('dropped', 'console.log(JSON.stringify({ gone: "1" }))', { kind: 'absent' })
  droppedEngine.remove('dropped')
  assert.deepEqual(droppedHost.forgotten, ['gone'], 'a variable nothing references is let go of, provider and all')
  assert.equal(droppedHost.declared.has('gone'), false, 'so the page stops offering it')

  // A script deleted by hand never went through `remove`, so the pass that
  // notices is a refresh (or the next mount).
  const vanishedHost = fakeHost({}, join(ROOT, 'vanished'))
  const vanishedEngine = new PromptScripts(vanishedHost, { run: canned(answer('{"handdeleted":"1"}')).run })
  await vanishedEngine.save('manual', 'console.log(JSON.stringify({ handdeleted: "1" }))', { kind: 'absent' })
  rmSync(join(vanishedEngine.dir, `manual${SCRIPT_EXTENSION}`))
  await vanishedEngine.refresh()
  assert.deepEqual(vanishedHost.forgotten, ['handdeleted'], 'a script deleted behind the engine is reconciled on the next refresh')
  assert.equal(readScriptState(vanishedEngine.dir).manual, undefined, 'and its cache entry goes with it')

  const disposed = new PromptScripts(fakeHost(), { run: canned(answer('{"late":"1"}')).run })
  disposed.dispose()
  await disposed.refresh(['inventory'])
  assert.equal(disposed.list().length > 0, true, 'a refresh after teardown still reports, but publishes nothing')

  // ── a name is a file name, and nothing else ────────────────────────────────

  for (const bad of ['..', '../escape', 'a/b', 'A-Upper', 'with space', '']) {
    const refused = await engine.save(bad, GOOD, { kind: 'absent' }).then(() => undefined, (error) => error)
    assert.ok(refused instanceof ScriptError, `script name ${JSON.stringify(bad)} must be refused`)
    assert.equal(refused.reason, 'invalid-name', `and the refusal must be the name: ${refused.reason}`)
  }
  assert.equal(engine.read('../escape'), undefined, 'and a traversal name never resolves to a file')

  // A directory of its own again, so the cap is the only thing being measured.
  const CAP = join(ROOT, 'capped')
  const full = fakeHost({}, CAP)
  const fullEngine = new PromptScripts(full, { run: numbered().run })
  for (let index = 0; index < MAX_SCRIPTS; index += 1) {
    await fullEngine.save(`script-${String(index)}`, `console.log(JSON.stringify({ v${String(index)}: "1" }))`, { kind: 'absent' })
  }
  const overCap = await fullEngine.save('one-too-many', 'console.log(JSON.stringify({ v99: "1" }))', { kind: 'absent' }).then(() => undefined, (error) => error)
  assert.equal(overCap.reason, 'too-many', `the script cap of ${String(MAX_SCRIPTS)} is enforced`)

  // ── the real runner, over real files ───────────────────────────────────────

  const realHost = fakeHost()
  const realEngine = new PromptScripts(realHost)
  const realSource = [
    'const answer = { rust: process.version, count: 2 }',
    'console.log(JSON.stringify(answer))',
  ].join('\n')
  const realSaved = await realEngine.save('runtime', realSource, { kind: 'absent' })
  assert.ok(realSaved.variables.rust.startsWith('v'), `the real runner measures a real interpreter, got ${realSaved.variables.rust}`)
  assert.equal(realSaved.variables.count, '2', 'and the numbers come back as their text')

  // The host marks the environment, so a script can tell what is running it.
  const markers = await realEngine.save('markers', [
    'console.log(JSON.stringify({',
    '  marker: `${process.env.DSH_PROMPT_MANAGER ?? "unset"}:${process.env.DSH_PROMPT_MANAGER_SCRIPT ?? "unset"}`',
    '}))',
  ].join('\n'), { kind: 'absent' })
  assert.equal(markers.variables.marker, '1:markers', 'a running script sees the two marker variables, and its own name')

  const hanging = new PromptScripts(fakeHost({ slow: { timeoutMs: 250 } }))
  const hangReport = await hanging.runSource('slow', 'setTimeout(() => {}, 60000)\nconsole.log("{}")')
  assert.equal(hangReport.ok, false, 'a script that outlives its timeout is killed')
  assert.ok(hangReport.problems[0].includes('超时'), `and reported: ${hangReport.problems[0]}`)
  assert.ok(hangReport.ms < 5000, `without holding the host for the length of the script: ${String(hangReport.ms)}ms`)

  assert.deepEqual(host.warnings, [], `no warning expected, got: ${host.warnings.join(' | ')}`)

  console.log('scripts ok')
  console.log('  output      flat JSON only: keys become variables, scalars only, 120 chars each')
  console.log('  refusals    no output, non-JSON, an array, an empty object, a bad name, a nested value')
  console.log('  timing      draft first: a broken script never becomes a file, a draft registers nothing')
  console.log('  fences      absent / sha1, and a conflict is refused before anything is written')
  console.log('  failures    timeout, missing interpreter, non-zero exit with and without usable output')
  console.log('  cache       mountDeclare serves the last good run, changes are re-run behind the mount')
  console.log('  delete      the file and the cache entry go: a referenced value is frozen, an unreferenced one is dropped')
  console.log('  real        the default runner measures a real interpreter and kills a real hang')
} finally {
  rmSync(ROOT, { recursive: true, force: true })
}
