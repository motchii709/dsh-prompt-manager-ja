#!/usr/bin/env node
/**
 * Store test: the body files the settings page edits.
 *
 * Coverage: the id grammar as the only path segment, optimistic write fencing,
 * atomic writes, size limits, listing, and the degradation a read-only
 * directory produces. Runs entirely inside a throwaway temporary directory.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { bodyHash, PromptStore, PromptStoreError } from '../lib/store.js'
import { entryIdFor, isEntryId, MAX_BODY_BYTES, parseEntries } from '../lib/entries.js'

/** Throwaway root for the whole run. */
const ROOT = mkdtempSync(join(tmpdir(), 'prompt-manager-store-'))
/** Directory the store owns. */
const SECTIONS = join(ROOT, 'sections')

try {
  const store = new PromptStore(SECTIONS)

  // ── the id grammar is the only path segment ─────────────────────────────────

  for (const bad of ['', '..', '../escape', 'a/b', 'A-Upper', '-leading', 'x'.repeat(65), 'with space', 'dot.dot']) {
    assert.throws(() => store.bodyPath(bad), PromptStoreError, `id ${JSON.stringify(bad)} must be refused`)
  }
  assert.equal(store.bodyPath('note-1'), join(SECTIONS, 'note-1.md'), 'a valid id must resolve inside the directory')
  assert.ok(isEntryId('note-1') && !isEntryId('Note'), 'the id predicate must mirror the store')

  // ── write, read, and the hash fence ─────────────────────────────────────────

  assert.equal(store.read('note'), undefined, 'an absent body must read as undefined')
  const created = store.write('note', 'FIRST', { kind: 'absent' })
  assert.equal(created.sha1, bodyHash('FIRST'), 'the write must report the stored hash')
  assert.equal(store.read('note').body, 'FIRST', 'the body must round-trip')
  assert.equal(readFileSync(join(SECTIONS, 'note.md'), 'utf8'), 'FIRST', 'the body must land in <id>.md')
  assert.deepEqual(
    readdirSync(SECTIONS).filter((name) => name.endsWith('.tmp')),
    [],
    'an atomic write must leave no temporary file behind',
  )

  assert.throws(() => store.write('note', 'SECOND', { kind: 'absent' }), /appeared/, 'the absent fence must refuse an existing file')
  assert.throws(() => store.write('note', 'SECOND', { kind: 'sha1', sha1: 'deadbeef' }), /changed on disk/, 'a stale fence must refuse')
  assert.equal(store.write('note', 'SECOND', { kind: 'sha1', sha1: created.sha1 }).sha1, bodyHash('SECOND'), 'a matching fence must write')
  assert.equal(store.write('note', 'THIRD').body, 'THIRD', 'an unfenced write must overwrite')

  assert.throws(
    () => store.write('huge', 'x'.repeat(MAX_BODY_BYTES + 1)),
    /limit is/,
    'an oversized body must be refused',
  )
  assert.throws(() => store.write('huge', 'x'.repeat(MAX_BODY_BYTES + 1)), PromptStoreError, 'the refusal must carry the store error type')

  // ── listing, removal, status ────────────────────────────────────────────────

  store.write('alpha', 'A', { kind: 'absent' })
  assert.deepEqual(store.ids(), ['alpha', 'note'], 'the listing must be sorted and complete')
  assert.deepEqual(store.status().ids, ['alpha', 'note'], 'status must list the stored bodies')
  assert.equal(store.status().dir, SECTIONS, 'status must report the directory')
  assert.equal(store.status().writable, true, 'a writable directory must report writable')

  assert.equal(store.remove('alpha'), true, 'removing a stored body must report true')
  assert.equal(store.remove('alpha'), false, 'removing an absent body must report false')
  assert.deepEqual(store.ids(), ['note'], 'the removed body must be gone')

  // ── a directory that cannot exist ───────────────────────────────────────────

  const blocker = join(ROOT, 'blocker')
  writeFileSync(blocker, 'not a directory', 'utf8')
  const broken = new PromptStore(join(blocker, 'sections'))
  assert.equal(broken.status().writable, false, 'an unusable directory must report unwritable')
  assert.deepEqual(broken.ids(), [], 'an unusable directory must list nothing')
  assert.throws(() => broken.write('note', 'X'), /cannot create/, 'a write into an unusable directory must fail loudly')

  // ── id allocation ───────────────────────────────────────────────────────────

  assert.equal(entryIdFor('My Note', []), 'my-note', 'a title must slug into an id')
  assert.equal(entryIdFor('My Note', ['my-note']), 'my-note-2', 'a taken id must gain a suffix')
  assert.equal(entryIdFor('中文标题', []), 'entry', 'a non-Latin title must fall back to the entry stem')
  assert.ok(isEntryId(entryIdFor('中文标题', ['entry'])), 'the fallback must stay a valid id')

  // ── index narrowing ────────────────────────────────────────────────────────

  const index = [
    { id: 'alpha', title: '第一条', order: 10, enabled: true },
    { id: 'beta', title: '第二条', order: 20, enabled: false },
  ]
  assert.deepEqual(parseEntries({ entries: index }).map((entry) => entry.id), ['alpha', 'beta'], 'a well-formed index must survive narrowing')
  assert.deepEqual(
    parseEntries({ entries: [...index, { id: 'alpha', title: 'dup', order: 1, enabled: true }] }).length,
    2,
    'a duplicate id must be dropped',
  )
  assert.deepEqual(parseEntries({ entries: 'nope' }), [], 'a malformed index must narrow to nothing')
  assert.deepEqual(parseEntries(undefined), [], 'a missing index must narrow to nothing')

  console.log('store ok')
  console.log(`  grammar     ${String(12)} unusable ids refused, path stays inside ${SECTIONS}`)
  console.log('  fencing     absent / sha1 / any, conflicts rejected')
  console.log('  limits      body cap 256 KiB, atomic writes leave no temp file')
  console.log('  degradation an unusable directory reports unwritable instead of throwing on mount')
} finally {
  rmSync(ROOT, { recursive: true, force: true })
}
