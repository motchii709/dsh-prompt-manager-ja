#!/usr/bin/env node
/**
 * The schema the Loader resolves for this plugin, under the import window the
 * Loader itself creates.
 *
 * `dsh-settings` serves a settings namespace only for an entry whose
 * `fiber.runtime.Config` is a native schemastery schema with a volatile form. On
 * 0.1.7-rc.1 the Loader imports every entry of the profile concurrently
 * (`EntryGroup.update` fans out with `Promise.all`), so this module is evaluated
 * while other graphs are still loading. Anything this module does *synchronously*
 * at that moment shares the window with them — which is why the factory must not
 * be reached through a synchronous `require()`: a `require()` that meets an
 * ESM-only dependency still loading cannot wait for it, and Node refuses with
 * `ERR_REQUIRE_ESM_RACE_CONDITION`.
 *
 * The Loader's concurrency cannot be reproduced deterministically in a unit test
 * (timing and loader-hook variants were tried), so this test injects the exact
 * failure the Loader raises and asserts the module does not depend on that path.
 *
 * The module is imported under a distinct query so it is evaluated afresh with
 * the fault already in place; the process-wide fault is always removed.
 */
import assert from 'node:assert/strict'
import Module, { register } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

/** The index fields the settings surface edits, in the order the schema declares them. */
const INDEX_FIELDS = ['entries', 'presets', 'activePreset', 'compaction', 'sources', 'mirror', 'proxy']

/**
 * Make every synchronous `require()` of an ESM-only dependency fail the way the
 * Loader's own concurrent import makes it fail.
 *
 * This is not a stand-in for the race: it is the race's exact error, raised on
 * the exact path the module must stop taking. `Module._load` is the hook a
 * `createRequire`-based factory goes through, and nothing in the module's ESM
 * graph does.
 * @returns a disposer restoring the real loader.
 */
function failSynchronousEsmRequire() {
  const original = Module._load
  Module._load = function load(request) {
    if (String(request).includes('cosmokit')) {
      const error = new Error(
        `Cannot require() ES Module ${String(request)} because it is not yet fully loaded. `
        + 'This may be caused by a race condition if the module is simultaneously dynamically import()-ed via Promise.all().',
      )
      error.code = 'ERR_REQUIRE_ESM_RACE_CONDITION'
      throw error
    }
    return Reflect.apply(original, this, arguments)
  }
  return () => {
    Module._load = original
  }
}

test('the schema survives a synchronous require() that cannot load an ESM-only dependency', async () => {
  const restore = failSynchronousEsmRequire()
  let module
  try {
    module = await import(new URL('../lib/index.js?config-schema-race', import.meta.url).href)
  } finally {
    restore()
  }
  const Config = module.Config
  assert.notEqual(
    Config,
    undefined,
    'the factory must be reached through the ESM graph: a synchronous require() during the Loader\'s concurrent import leaves Config undefined, and the settings namespace is never served',
  )
  assert.equal(Reflect.get(Config, Symbol.for('schemastery')), true, 'the Loader only projects a native schemastery schema into a settings form')
  assert.equal(typeof Config.toJSON, 'function', 'the settings wire envelope is built from toJSON()')
  const wire = Config.toJSON()
  const fields = wire.refs[wire.uid].dict
  for (const key of INDEX_FIELDS) {
    const node = wire.refs[fields[key]]
    assert.equal(node?.meta?.volatile, true, `${key} must be volatile, or settings.update refuses every write to it`)
  }
})

/** Register the schemastery denial once, for the tests that need it. */
let denied = false
function denySchemastery() {
  if (denied) return
  denied = true
  // A hook only affects specifiers resolved after it is registered, so the tests
  // that need it import the module under a query of their own.
  register(new URL('./helpers/no-schemastery.mjs', import.meta.url), import.meta.url)
}

/**
 * Mount the plugin into a real SystemPrompt registry, with the fixture's
 * settings service when the module under test still has a schema.
 * @param module - the plugin module to mount.
 * @param store - store directory for entry bodies.
 * @returns the context, the warnings it collected, and a prompt reader.
 */
async function mountPlugin(module, store) {
  const { Context } = await import('@deepseek-ai/cordis')
  const { default: SystemPrompt, renderPrompt } = await import('@deepseek-ai/dsh-system-prompt')
  const { ESCAPE_MARK } = await import('../lib/guard.js')
  const { fakeSettings, mountable } = await import('./helpers/settings-source.mjs')
  const ctx = new Context()
  const warnings = []
  ctx.logger.warn = (...args) => {
    warnings.push(args.map(String).join(' '))
  }
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false })
  await ctx.plugin(mountable(module, fakeSettings().state), { storeDir: store })
  const read = async () => {
    const assembly = await ctx.systemPrompt.assemble({
      agent: {
        session: { id: 'config-schema-session', header: { cwd: join(store, 'workspaces') } },
        options: { provider: 'test-provider', model: 'test-model' },
      },
    })
    return renderPrompt(assembly).split(ESCAPE_MARK).join('')
  }
  return { warnings, read }
}

test('a factory that cannot be reached is reported, not swallowed', async () => {
  const store = mkdtempSync(join(tmpdir(), 'prompt-manager-schema-'))
  try {
    denySchemastery()
    const module = await import(new URL('../lib/index.js?config-schema-missing', import.meta.url).href)
    assert.equal(module.Config, undefined, 'an unreachable factory leaves the plugin without a settings surface')
    const { warnings } = await mountPlugin(module, store)
    assert.ok(
      warnings.some((line) => /schemastery/i.test(line)),
      `a deployment whose factory cannot be reached must say so once, with the reason; warnings were ${JSON.stringify(warnings)}`,
    )
  } finally {
    rmSync(store, { recursive: true, force: true })
  }
})

// ── the property the lazy resolution protects ────────────────────────────────

test('a deployment without the settings capability still serves its packaged entry', async () => {
  const store = mkdtempSync(join(tmpdir(), 'prompt-manager-noschema-'))
  try {
    denySchemastery()
    const module = await import(new URL('../lib/index.js?config-schema-degraded', import.meta.url).href)
    const { read } = await mountPlugin(module, store)
    assert.ok(
      (await read()).includes('# Machine environment'),
      'the settings surface is optional: without a schema the plugin must still inject the entry it packages',
    )
  } finally {
    rmSync(store, { recursive: true, force: true })
  }
})
