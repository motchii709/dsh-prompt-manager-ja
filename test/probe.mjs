#!/usr/bin/env node
/**
 * Probe test: the mount-time detection behind the `probes` config.
 *
 * Every case runs against an injected runner, so nothing here depends on the
 * tools a machine happens to have; the last block runs two real commands to
 * prove the default runner works and yields values the registry accepts.
 *
 * Coverage: value extraction from either stream, the three placeholder
 * outcomes, pattern narrowing and its fallbacks, truncation, argument and
 * timeout pass-through, spec normalization, and the pass budget.
 */
import assert from 'node:assert/strict'

import {
  DEFAULT_PROBE_TEXTS,
  MAX_PROBE_VALUE,
  normalizeProbes,
  probeValue,
  runProbes,
} from '../lib/probe.js'

/**
 * Build a runner that answers one canned result and records its call.
 * @param result - the partial run to answer with.
 * @returns the runner plus the list of calls it received.
 */
function fakeRunner(result) {
  const calls = []
  const run = (command, args, options) => {
    calls.push({ command, args, options })
    return { spawnError: undefined, status: 0, stdout: '', stderr: '', timedOut: false, ...result }
  }
  return { run, calls }
}

/** Placeholder texts a Chinese deployment would configure. */
const ZH = { missing: '无', empty: '(无输出)', timeout: '(超时)', skipped: '(略过)' }

try {
  // ── where the value comes from ──────────────────────────────────────────────

  const stdout = fakeRunner({ stdout: 'Python 3.12.10\n' })
  assert.equal(
    probeValue({ command: 'python', args: ['--version'] }, stdout.run),
    'Python 3.12.10',
    'the first non-empty stdout line is the value',
  )
  assert.deepEqual(stdout.calls[0].args, ['--version'], 'declared arguments must reach the runner')
  assert.equal(stdout.calls[0].options.shell, false, 'a probe runs without a shell unless it asks for one')
  assert.equal(
    probeValue({ command: 'npm', args: ['--version'], shell: true }, fakeRunner({}).run),
    DEFAULT_PROBE_TEXTS.empty,
    'a silent probe contributes the empty placeholder',
  )

  const stderr = fakeRunner({ stdout: '', stderr: 'openjdk version "25.0.4.1" 2026-08-18 LTS\n' })
  assert.equal(
    probeValue({ command: 'java', args: ['-version'] }, stderr.run),
    'openjdk version "25.0.4.1" 2026-08-18 LTS',
    'a version printed to stderr must still reach the prompt',
  )

  const mixed = fakeRunner({ stdout: '   \n\n', stderr: 'second choice\n' })
  assert.equal(probeValue({ command: 'x' }, mixed.run), 'second choice', 'blank stdout falls through to stderr')

  // ── the three placeholder outcomes ──────────────────────────────────────────

  assert.equal(
    probeValue({ command: 'rustc' }, fakeRunner({ spawnError: 'ENOENT' }).run),
    DEFAULT_PROBE_TEXTS.missing,
    'an executable that cannot start is reported as missing',
  )
  assert.equal(
    probeValue({ command: 'nope' }, fakeRunner({ spawnError: 'EINVAL' }).run),
    DEFAULT_PROBE_TEXTS.missing,
    'a process Windows refuses to start is reported as missing',
  )
  assert.equal(
    probeValue({ command: 'nope', shell: true }, fakeRunner({ status: 9009, stderr: "'nope' is not recognized\r\n" }).run),
    DEFAULT_PROBE_TEXTS.missing,
    'a shell that cannot find the command is reported as missing',
  )
  assert.equal(
    probeValue({ command: 'python3' }, fakeRunner({ status: 1 }).run),
    DEFAULT_PROBE_TEXTS.empty,
    'a command that runs and prints nothing is reported as empty, not missing',
  )
  assert.equal(
    probeValue({ command: 'slow' }, fakeRunner({ timedOut: true }).run),
    DEFAULT_PROBE_TEXTS.timeout,
    'a probe killed on its timeout is reported as such',
  )
  assert.equal(
    probeValue({ command: 'rustc' }, fakeRunner({ spawnError: 'ENOENT' }).run, ZH),
    '无',
    'placeholder texts are configurable, so a localized prompt reads naturally',
  )

  // ── pattern narrowing ───────────────────────────────────────────────────────

  assert.equal(
    probeValue({ command: 'git', pattern: '([0-9]+\\.[0-9]+\\.[0-9]+)' }, fakeRunner({ stdout: 'git version 2.55.0.windows.2\n' }).run),
    '2.55.0',
    'a pattern narrows the value to its captured version',
  )
  assert.equal(
    probeValue({ command: 'gh', pattern: 'gh version ([0-9.]+)' }, fakeRunner({ stdout: 'gh version 2.96.0 (2026-07-02)\n' }).run),
    '2.96.0',
    'a multi-line match narrows to the capture group',
  )
  assert.equal(
    probeValue({ command: 'x', pattern: 'v?([0-9.]+)' }, fakeRunner({ stdout: 'v24.18.0\n' }).run),
    '24.18.0',
    'an optional prefix may sit outside the capture group',
  )
  assert.equal(
    probeValue({ command: 'x', pattern: '([0-9]+)' }, fakeRunner({ stdout: 'no digits here\n' }).run),
    'no digits here',
    'a pattern that does not match falls back to the whole line',
  )
  assert.equal(
    probeValue({ command: 'x', pattern: 'x(' }, fakeRunner({ stdout: 'still a value\n' }).run),
    'still a value',
    'an unusable pattern must not lose the output',
  )

  const long = fakeRunner({ stdout: `${'v'.repeat(MAX_PROBE_VALUE * 2)}\n` })
  assert.equal(probeValue({ command: 'x' }, long.run).length, MAX_PROBE_VALUE, 'values are truncated')

  // ── timeouts ────────────────────────────────────────────────────────────────

  const timed = fakeRunner({})
  probeValue({ command: 'x', timeoutMs: 250 }, timed.run)
  assert.equal(timed.calls[0].options.timeoutMs, 250, 'a probe timeout reaches the runner')

  // ── spec normalization ──────────────────────────────────────────────────────

  assert.deepEqual(normalizeProbes(undefined), { specs: {}, problems: [] }, 'an absent probes config is not a problem')
  assert.deepEqual(
    normalizeProbes({ python: { command: 'python', args: ['--version'], pattern: '([0-9.]+)', timeoutMs: 900.7 } }).specs,
    { python: { command: 'python', args: ['--version'], pattern: '([0-9.]+)', timeoutMs: 900 } },
    'a well-formed spec survives normalization',
  )
  for (const [label, raw] of [
    ['a scalar', 'python'],
    ['a bad variable name', { 'Bad-Name': { command: 'x' } }],
    ['a spec that is not a mapping', { python: 'python --version' }],
    ['a spec without a command', { python: { args: ['--version'] } }],
    ['an empty command', { python: { command: '  ' } }],
    ['args that are not strings', { python: { command: 'x', args: ['--version', 7] } }],
    ['a pattern that is not a string', { python: { command: 'x', pattern: 7 } }],
    ['an invalid pattern', { python: { command: 'x', pattern: '([' } }],
    ['a negative timeout', { python: { command: 'x', timeoutMs: -1 } }],
    ['a non-numeric timeout', { python: { command: 'x', timeoutMs: 'fast' } }],
  ]) {
    const { specs, problems } = normalizeProbes(raw)
    assert.equal(problems.length, 1, `${label} must be reported`)
    assert.deepEqual(specs, {}, `${label} must not become a spec`)
  }

  // ── the pass, and its budget ────────────────────────────────────────────────

  const order = runProbes(
    { first: { command: 'a' }, second: { command: 'b' } },
    { run: fakeRunner({ stdout: 'ok\n' }).run },
  )
  assert.deepEqual(order.outcomes.map((outcome) => outcome.name), ['first', 'second'], 'probes run in declaration order')

  // A pass budget exists so one hanging command cannot stall the mount: the
  // probes that did not get to run are reported, not attempted.
  let clock = 0
  const slow = { commands: [] }
  const budgeted = runProbes(
    { first: { command: 'a' }, second: { command: 'b' }, third: { command: 'c' } },
    {
      run: (command) => {
        slow.commands.push(command)
        clock += 40
        return { spawnError: undefined, status: 0, stdout: 'ok\n', stderr: '', timedOut: false }
      },
      budgetMs: 30,
      now: () => clock,
    },
  )
  assert.deepEqual(
    budgeted.outcomes.map((outcome) => outcome.value),
    ['ok', DEFAULT_PROBE_TEXTS.skipped, DEFAULT_PROBE_TEXTS.skipped],
    'once the pass budget is spent the remaining probes are skipped',
  )
  assert.deepEqual(slow.commands, ['a'], 'a skipped probe must not run at all')
  assert.equal(
    runProbes({ first: { command: 'a' } }, { run: fakeRunner({ spawnError: 'ENOENT' }).run, texts: ZH }).outcomes[0].value,
    '无',
    'custom texts reach the pass',
  )
  assert.equal(
    runProbes({}, { run: fakeRunner({}).run }).outcomes.length,
    0,
    'no probes means no outcomes',
  )

  // ── the real runner ─────────────────────────────────────────────────────────

  const real = runProbes({
    node: { command: process.execPath, args: ['--version'], pattern: 'v?([0-9.]+)' },
    absent: { command: 'prompt-manager-definitely-not-a-command', args: ['--version'] },
  })
  assert.equal(
    real.outcomes[0].value,
    process.version.replace(/^v/, ''),
    `the real runner must report this Node (${process.version}), got ${real.outcomes[0].value}`,
  )
  assert.equal(real.outcomes[0].ms >= 0, true, 'the pass reports elapsed time')
  assert.equal(
    real.outcomes[1].value,
    DEFAULT_PROBE_TEXTS.missing,
    'a command that does not exist must not throw, and must not become a value',
  )

  console.log('probe ok')
  console.log('  sources     stdout, stderr, blank-stdout fallthrough, and first non-empty line')
  console.log('  outcomes    missing / empty / timeout / skipped placeholders, all configurable')
  console.log('  patterns    capture group, optional prefix, no-match and invalid fallbacks, truncation')
  console.log('  config      malformed names, specs, args, patterns, and timeouts are each reported')
  console.log(`  real        node ${real.outcomes[0].value} in ${String(real.outcomes[0].ms)}ms, absent tool -> ${real.outcomes[1].value}`)
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
