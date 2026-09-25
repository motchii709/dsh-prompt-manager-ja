#!/usr/bin/env node
/**
 * Guard test: the reference scan that keeps one bad `{{...}}` from failing the
 * whole assembly.
 *
 * Coverage: the registry really does throw on a malformed or unknown reference,
 * the guard defuses exactly those and nothing else, the rendered prompt keeps
 * the prose (and the values that do resolve), a lone `{{` stays literal, and
 * the save-time listing names the references that can never resolve.
 *
 * The DeepSeek Harness packages are resolved in three steps: from this file,
 * from the current working directory's `node_modules`, then from the
 * `DSH_PACKAGES` directory holding `@deepseek-ai/*`.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { ESCAPE_MARK, malformedReferences, resolveReferences, sanitizeReferences } from '../lib/guard.js'

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

/**
 * Render one section the way the harness does.
 * @param text - the section text to interpolate.
 * @param variables - the variables registered for this assembly.
 * @returns the rendered prompt.
 */
function render(text, variables) {
  const { renderPrompt } = RENDER
  return renderPrompt({
    sections: [{ name: 'user:prompt-manager:note', order: 10, text }],
    contexts: [],
    tools: [],
    variables,
  })
}

/**
 * The rendered text as a model reads it: the escape marks are invisible.
 * @param text - rendered prompt text.
 * @returns the same text without the guard's escape marks.
 */
function withoutMarks(text) {
  return text.split(ESCAPE_MARK).join('')
}

const RENDER = await load('@deepseek-ai/dsh-system-prompt')
const variables = { os: 'Windows', node: '24.18.0' }

// ── the registry is strict, which is why the guard exists ─────────────────────

assert.throws(() => render('a {{ x }} b', variables), /malformed prompt variable reference/, 'a spaced reference must throw')
assert.throws(() => render('a {{a.b}} b', variables), /malformed prompt variable reference/, 'a dotted reference must throw')
assert.throws(() => render('a {{nope}} b', variables), /unknown prompt variable/, 'an unregistered name must throw')
assert.equal(render('a {{ brace', variables), 'a {{ brace', 'a lone opener must stay literal prose')
assert.equal(render('a {{os}} b', variables), 'a Windows b', 'a registered name must interpolate')

// ── the guard defuses exactly the throwing references ─────────────────────────

const mixed = 'A {{ x }} B {{nope}} C {{os}} D {{a.b}} E literal {{ brace'
const guarded = sanitizeReferences(mixed, variables)
assert.deepEqual(
  guarded.escaped,
  ['{{ x }}', '{{nope}}', '{{a.b}}'],
  'the guard must report exactly the references the registry cannot resolve',
)
assert.deepEqual(guarded.escaped.length, 3, 'a resolvable reference must not be reported')
assert.equal(
  withoutMarks(render(guarded.text, variables)),
  'A {{ x }} B {{nope}} C Windows D {{a.b}} E literal {{ brace',
  'the guarded text must render with the prose intact, the values substituted, and nothing thrown',
)
assert.equal(
  render(guarded.text, variables).split(ESCAPE_MARK).length - 1,
  guarded.escaped.length * 2,
  'the guard must emit two escape marks (one per opening brace) per defused reference',
)

for (const reference of guarded.escaped) {
  assert.ok(withoutMarks(guarded.text).includes(reference), `${reference} must still be readable as prose`)
}
assert.equal(
  sanitizeReferences(guarded.text, variables).escaped.length,
  0,
  'defusing must be idempotent: nothing left to defuse on a second pass',
)

// ── adjacent and nested braces cannot re-form a reference ────────────────────

for (const nasty of ['{{{{nested}}}}', '{{{x}}}}', 'a{{{b}}', '{{}}{{{{}}}}', '{{a{{b}}', '{{ x }}{{ y }}']) {
  const defused = sanitizeReferences(nasty, variables)
  assert.equal(defused.text.includes('{{'), false, `${JSON.stringify(nasty)} must come out with no reference left`)
  assert.doesNotThrow(
    () => render(defused.text, variables),
    `${JSON.stringify(nasty)} must render as prose rather than throw`,
  )
}

// ── a variable with no value for this assembly is defused too ─────────────────

const missingValue = sanitizeReferences('value={{late}}', { late: undefined })
assert.deepEqual(missingValue.escaped, ['{{late}}'], 'a registered name with no value must be defused')
assert.equal(
  withoutMarks(render(missingValue.text, { late: undefined })),
  'value={{late}}',
  'a name whose provider returned undefined must render as prose, not throw',
)

// ── substitution stays the registry's job ────────────────────────────────────

assert.equal(
  render('v={{brace}}', { brace: 'a {{b}} literal' }),
  'v=a {{b}} literal',
  'a substituted value must not be rescanned, so the guard must not pre-substitute',
)
assert.equal(
  sanitizeReferences('v={{os}}', { os: 'Windows' }).text,
  'v={{os}}',
  'the guard must hand a resolvable reference through untouched',
)
assert.equal(ESCAPE_MARK.length, 1, 'the escape mark must be a single character, so offsets stay predictable')

// ── a compaction body has no registry pass, so one call substitutes too ──────
//
// A section's resolvable references are left for the registry to interpolate.
// The compaction instruction is not a section: nothing else will render it, so
// this entry point has to substitute and defuse in the same pass — and agree
// with `sanitizeReferences` about which references are unusable, because the two
// must never disagree about what is safe to send.

const substituted = resolveReferences(mixed, variables)
assert.equal(
  withoutMarks(substituted.text),
  'A {{ x }} B {{nope}} C Windows D {{a.b}} E literal {{ brace',
  'a resolvable reference must be substituted, not handed through',
)
assert.deepEqual(
  substituted.escaped,
  guarded.escaped,
  'both entry points must report exactly the same unusable references',
)
assert.equal(
  substituted.text.split(ESCAPE_MARK).length - 1,
  substituted.escaped.length * 2,
  'the substituted text must carry the same two marks per defused reference',
)
assert.doesNotThrow(
  () => render(substituted.text, {}),
  'the substituted text must be safe for a strict pass with no variables at all',
)
assert.equal(
  resolveReferences('a {{ brace', variables).text,
  'a {{ brace',
  'a lone opener is literal prose here too',
)
assert.deepEqual(
  resolveReferences('value={{late}}', { late: undefined }).escaped,
  ['{{late}}'],
  'a registered name whose provider returned undefined must be defused',
)
assert.equal(
  resolveReferences('v={{brace}}', { brace: 'a {{b}} literal' }).text,
  'v=a {{b}} literal',
  'a substituted value must not be rescanned, exactly as the registry does it',
)
for (const nasty of ['{{{{nested}}}}', '{{{x}}}}', '{{}}{{{{}}}}', '{{a{{b}}']) {
  assert.doesNotThrow(
    () => resolveReferences(nasty, variables),
    `${JSON.stringify(nasty)} must be defused rather than thrown`,
  )
}

// ── save-time listing: only what can never resolve ───────────────────────────

assert.deepEqual(
  malformedReferences('a {{ x }} b {{a.b}} c {{unregistered}} d {{os}}'),
  ['{{ x }}', '{{a.b}}'],
  'only shape-invalid references are refused up front; an unregistered name is not',
)
assert.deepEqual(malformedReferences('plain prose'), [], 'prose without references must list nothing')
assert.deepEqual(malformedReferences('a {{ x }} b {{ x }}'), ['{{ x }}'], 'repeats must be listed once')
assert.deepEqual(malformedReferences('{{'), [], 'a lone opener is literal prose, not a malformed reference')
assert.deepEqual(malformedReferences('{{}} and {{1}}'), ['{{}}', '{{1}}'], 'an empty and a digit-only reference are both malformed')
assert.deepEqual(malformedReferences('{{{{nested}}}}').length, 1, 'a nested opener must be reported as one entry')
assert.deepEqual(
  malformedReferences('{{ spaced }} {{also spaced}}'),
  ['{{ spaced }}', '{{also spaced}}'],
  'every malformed group must be listed, in order',
)

console.log('guard ok')
console.log('  registry    malformed / unknown / undefined references throw; a lone opener does not')
console.log(`  defused     ${String(guarded.escaped.length)} of 5 groups escaped, resolvable ones handed through`)
console.log('  idempotent  a second pass finds nothing; substituted values are never rescanned')
console.log('  save gate   only shape-invalid references are refused before a write')
