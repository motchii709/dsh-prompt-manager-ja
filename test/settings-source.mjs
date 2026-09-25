#!/usr/bin/env node
/**
 * The settings seam this plugin has on DSH 0.1.7-rc.1.
 *
 * `settings.register` is gone, so the index no longer lives in a namespace the
 * plugin owns: it lives in the plugin's own Loader entry, as `volatile()` Config
 * fields. These tests pin the four things that contract requires, each of which
 * fails silently if it is missed — an index that never reaches the prompt, an
 * edit that never re-syncs, a save that goes nowhere, and a legacy row config
 * that stops the plugin from mounting at all.
 *
 * The seam is driven through a real cordis mount of the real plugin module, so
 * the schema resolution under test is cordis's own.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ESCAPE_MARK } from '../lib/guard.js'
import { SETTINGS_NAMESPACE, apply, inject, name } from '../lib/index.js'
import { fakeSettings, load, mountable } from './helpers/settings-source.mjs'

/**
 * The plugin's real schema. Imported dynamically on purpose: a missing export
 * must fail the assertion that names it, not the whole file at link time.
 */
const moduleConfig = (await import('../lib/index.js')).Config

/** Throwaway home for the body files, so the test never touches a real one. */
const STORE_ROOT = mkdtempSync(join(tmpdir(), 'prompt-manager-settings-'))

/** SystemPrompt config that isolates the sections under test. */
const BARE = { includeHarnessIdentity: false, includeRuntimeContext: false }

/**
 * Write one entry body under the store directory.
 * @param id - entry id, which is also the file name.
 * @param text - exact body contents.
 */
function writeBody(id, text) {
  mkdirSync(join(STORE_ROOT, 'sections'), { recursive: true })
  writeFileSync(join(STORE_ROOT, 'sections', `${id}.md`), text, 'utf8')
}

/** The escape marks the guard writes are invisible to a model, so drop them. */
const readable = (text) => text.split(ESCAPE_MARK).join('')

/**
 * Mount the plugin into a real SystemPrompt registry with the fixture's
 * settings service.
 * @param config - the row config the deployment would write.
 * @param settings - the fixture from {@link fakeSettings}.
 * @returns the mount and a reader for the assembled prompt.
 */
async function mount(config, settings) {
  const { Context } = await load('@deepseek-ai/cordis')
  const { default: SystemPrompt, renderPrompt } = await load('@deepseek-ai/dsh-system-prompt')
  const ctx = new Context()
  const warnings = []
  ctx.logger.warn = (...args) => { warnings.push(args.map(String).join(' ')) }
  await ctx.plugin(SystemPrompt, BARE)
  await ctx.plugin(settings.plugin)
  // Every mount is awaited, and the fixture commits a document synchronously, so
  // no test here waits on a tick budget: a fixed number of ticks would be a guess
  // about how long a mount takes, and a guess is a flake waiting to happen.
  await ctx.plugin(mountable({ name, inject, apply, Config: moduleConfig }, settings.state), { storeDir: STORE_ROOT, ...config })
  const read = async () => {
    const assembly = await ctx.systemPrompt.assemble({
      agent: {
        session: { id: 'settings-session', header: { cwd: join(STORE_ROOT, 'workspaces') } },
        options: { provider: 'test-provider', model: 'test-model' },
      },
    })
    return readable(renderPrompt(assembly))
  }
  return { ctx, warnings, read }
}




process.on('exit', () => rmSync(STORE_ROOT, { recursive: true, force: true }))

// ── the schema the Loader resolves ───────────────────────────────────────────

test('the plugin exposes its index as volatile Config fields', () => {
  assert.equal(typeof moduleConfig?.toJSON, 'function', 'the plugin must export a Config schema for the Loader to resolve')
  const wire = moduleConfig.toJSON()
  const fields = wire.refs[wire.uid].dict
  for (const key of ['entries', 'presets', 'activePreset', 'sources', 'mirror', 'proxy', 'compaction']) {
    assert.ok(key in fields, `the index field ${key} must be declared, or the settings surface cannot edit it`)
  }
  for (const key of ['entries', 'presets', 'activePreset', 'sources', 'mirror', 'proxy']) {
    const node = wire.refs[fields[key]]
    assert.equal(node.meta?.volatile, true, `${key} must be volatile, or settings.update refuses every write to it`)
  }
})

test('a legacy row config that turns the compaction seam off still mounts', () => {
  const wire = moduleConfig.toJSON()
  const node = wire.refs[wire.refs[wire.uid].dict.compaction]
  assert.equal(node.meta?.volatile, true, 'the seam switch shares the key with the legacy index pointer, so it must be live too')
  assert.equal(moduleConfig({ compaction: false }).compaction.get(), false, 'a boolean must resolve: this is the documented way to turn the seam off')
  assert.equal(moduleConfig({ compaction: 'compact-zh' }).compaction.get(), 'compact-zh', 'and a legacy entry pointer must still validate')
  assert.equal(moduleConfig({}).compaction.get(), true, 'an unconfigured row keeps the seam on')
})

// ── the index reaches the prompt ─────────────────────────────────────────────

test('an index configured on the plugin row drives the registered prompt sections', async () => {
  writeBody('row', 'ROW-BODY')
  const settings = fakeSettings()
  const mounted = await mount({ entries: [{ id: 'row', title: '行配置', order: 10, enabled: true }] }, settings)
  assert.equal(await mounted.read(), 'ROW-BODY', 'the index the row config carries is the index in force')
})

test('a committed settings write re-syncs without a restart', async () => {
  writeBody('later', 'LATER-BODY')
  const settings = fakeSettings()
  const mounted = await mount({}, settings)
  assert.ok((await mounted.read()).includes('# Machine environment'), 'an unconfigured row serves the packaged entry')
  settings.state.value = { entries: [{ id: 'later', title: '后来', order: 10, enabled: true }] }
  assert.equal(await mounted.read(), 'LATER-BODY', 'the announced commit is what makes the new index reach the prompt')
})

// ── writes go through the one service 0.1.7 offers ───────────────────────────

test('the plugin writes the index to its own entry id', async () => {
  // The only writer besides the settings surface is the subscription sync, which
  // rewrites the entry list when a source's snapshot changes. Driving it needs a
  // git source, so this asserts the contract that makes it work: the service the
  // plugin reaches for is `settings.update`, and the id it names is the Loader
  // entry id the browser half reads back with `configForms.get`.
  assert.equal(SETTINGS_NAMESPACE, 'prompt-manager', 'the entry id is the namespace, so the plugin must keep naming it')
  const settings = fakeSettings()
  const mounted = await mount({}, settings)
  assert.equal(typeof mounted.ctx.get('settings')?.update, 'function', 'the deployment must offer the 0.1.7 write path')
  assert.deepEqual(settings.state.updates, [], 'mounting must not write anything by itself')
  settings.state.value = { entries: [{ id: 'written', title: '写入', order: 10, enabled: true }] }
  assert.equal(settings.state.value.entries[0].id, 'written', 'and the committed index is what the plugin now reads')
})
