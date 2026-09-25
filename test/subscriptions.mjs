#!/usr/bin/env node
/**
 * Subscription engine test: the join between the settings document, the source
 * workspaces on disk, and the entry index.
 *
 * The engine is driven against a host stub and real workspaces in a throwaway
 * directory, so what is covered here is the engine's own bookkeeping: the body
 * location map and its cache, the gate a switched-off source puts on upstream
 * work, and the index it rebuilds after an apply or a removal.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { Subscriptions } from '../lib/subscriptions.js'
import { CheckError, SourceWorkspace } from '../lib/sync.js'

/** Throwaway storage root for every workspace below. */
const ROOT = mkdtempSync(join(tmpdir(), 'prompt-manager-subscriptions-'))

/**
 * One configured source.
 * @param id - source slug.
 * @param extra - fields to override.
 * @returns the source record the engine reads.
 */
const source = (id, extra = {}) => ({ id, repo: `o/${id}`, ref: 'main', mirror: '', enabled: true, ...extra })

/** The host stub the engine talks to, and what it recorded. */
const host = {
  sourcesList: [],
  entriesList: [],
  written: [],
  sources: () => host.sourcesList,
  proxy: () => ({ kind: 'none', url: '' }),
  mirror: () => '',
  root: () => ROOT,
  entries: () => host.entriesList,
  setEntries: async (entries) => {
    host.written.push(entries)
    host.entriesList = entries
  },
  nextOrder: () => 30,
  warn: () => {},
}

/** How many times a workspace read its bookkeeping, across every workspace. */
let reads = 0

/** The engine under test, with every workspace it builds counted. */
const engine = new Subscriptions(host, {
  workspace: (slug) => {
    const workspace = new SourceWorkspace(ROOT, slug)
    const readState = workspace.readState.bind(workspace)
    workspace.readState = () => {
      reads += 1
      return readState()
    }
    return workspace
  },
})

/**
 * Put one applied snapshot on disk, the way a previous apply would have.
 * @param slug - source slug.
 * @param files - state records keyed by repository path.
 * @param bodies - body contents keyed by repository path.
 */
function snapshot(slug, files, bodies) {
  const workspace = new SourceWorkspace(ROOT, slug)
  for (const [path, body] of Object.entries(bodies)) {
    const file = join(workspace.currentDir, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, body, 'utf8')
  }
  workspace.writeState({ ref: 'main', files, appliedAt: '2026-01-01T00:00:00.000Z' })
}

try {
  // ── the location map is computed once, not once per body read ───────────────

  host.sourcesList = [source('src-a')]
  snapshot('src-a', { 'prompts/a.md': { id: 'src-a-a', enabled: true, sha1: 'x' } }, { 'prompts/a.md': 'BODY-A' })

  const before = reads
  assert.equal(engine.readBody('src-a-a'), 'BODY-A', 'a subscribed body is read from its snapshot')
  assert.equal(engine.readBody('src-a-a'), 'BODY-A', 'reading it again answers the same')
  assert.equal(reads - before, 1, 'the location map must be computed once, not once per body read')
  assert.equal(engine.readBody('nobody-owns-this'), undefined, 'an id no source owns has no body')
  assert.equal(reads - before, 1, 'and an unknown id must not re-read either')

  engine.refreshLocations()
  assert.equal(reads - before, 2, 'refreshLocations must read the sources again')

  assert.deepEqual(
    engine.locate().get('src-a-a'),
    { slug: 'src-a', path: 'prompts/a.md' },
    'the map must point at the file the body lives in',
  )

  // ── a switched-off source takes no new work from upstream ───────────────────

  host.sourcesList = [source('src-a', { enabled: false })]
  engine.refreshLocations()
  assert.equal(engine.list()[0].enabled, false, 'the summary must carry the switch')
  for (const action of ['check', 'apply', 'revert']) {
    await assert.rejects(
      engine[action]('src-a'),
      (error) => error instanceof CheckError && error.reason === 'disabled',
      `${action} must be refused while the source is switched off`,
    )
  }
  assert.equal(engine.readBody('src-a-a'), 'BODY-A', 'a switched-off source keeps the bodies already in force')

  const forgotten = await engine.remove('src-a')
  assert.deepEqual(forgotten.entries, [], 'a switched-off source can still be forgotten')
  assert.equal(engine.readBody('src-a-a'), undefined, 'and forgetting it drops its files')

  await assert.rejects(
    engine.check('no-such-source'),
    (error) => error instanceof CheckError && error.reason === 'unknown-source',
    'an unknown source is still reported as unknown',
  )

  // ── the index is rebuilt from what is on disk ───────────────────────────────

  host.entriesList = [
    { id: 'local', title: '本地条目', order: 10, enabled: true },
    { id: 'src-a-a', title: '上一份快照', order: 30, enabled: true, source: 'src-a' },
    { id: 'src-a-gone', title: '上游已经删掉', order: 40, enabled: true, source: 'src-a' },
  ]
  host.sourcesList = [source('src-b')]
  snapshot('src-b', { 'prompts/b.md': { id: 'src-b-b', enabled: true } }, { 'prompts/b.md': 'BODY-B' })
  engine.refreshLocations()

  const synced = await engine.syncEntries()
  assert.deepEqual(synced, [
    { id: 'local', title: '本地条目', order: 10, enabled: true },
    { id: 'src-b-b', title: 'b', order: 30, enabled: false, source: 'src-b' },
  ], 'a local entry survives, a dropped source loses its entries, and a new one arrives switched off')
  assert.equal(host.written.length, 1, 'the rebuilt index must be written back')

  const steady = await engine.syncEntries()
  assert.deepEqual(steady, synced, 'a second pass must agree')
  assert.equal(host.written.length, 1, 'and must not write an unchanged index again')

  // An entry whose id moved — a manifest that started declaring its own `id`, or
  // a file renamed with its body edited too — is still the same prompt, so what
  // a person gave the old id comes with it instead of starting the entry over.
  host.entriesList = [
    { id: 'local', title: '本地条目', order: 10, enabled: true },
    { id: 'src-b-old', title: '人工起的标题', order: 70, enabled: true, source: 'src-b' },
  ]
  host.sourcesList = [source('src-b')]
  snapshot(
    'src-b',
    { 'prompts/new.md': { id: 'src-b-new', renamedFromId: 'src-b-old', enabled: true } },
    { 'prompts/new.md': 'BODY-B' },
  )
  engine.refreshLocations()

  const carried = await engine.syncEntries()
  assert.deepEqual(carried, [
    { id: 'local', title: '本地条目', order: 10, enabled: true },
    { id: 'src-b-new', title: '人工起的标题', order: 70, enabled: true, source: 'src-b' },
  ], 'the title, placement, and switch move to the id the entry has now')
  assert.ok(
    carried.every((entry, index) => index === 0 || entry.id !== 'src-b-old'),
    'and the id it left behind is not in the index twice',
  )

  console.log('subscriptions ok')
  console.log('  locations   the body map is computed once, refreshed when the engine moves files')
  console.log('  switch      a switched-off source takes no check / apply / revert, and keeps its bodies')
  console.log('  index       locals survive, stale sources lose their entries, new entries arrive off')
  console.log('  identity    an entry whose id moved keeps the title, placement, and switch it had')
} finally {
  rmSync(ROOT, { recursive: true, force: true })
}
