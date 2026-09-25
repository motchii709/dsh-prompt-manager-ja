#!/usr/bin/env node
/**
 * Sync test: check → apply → revert over one source's files.
 *
 * The fetcher is a stub keyed by URL, so this exercises the three-slot rotation,
 * the staged plan, the change accounting, and every failure the pages have to
 * report — with no network and no real repository.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  applyChanges,
  checkSource,
  CheckError,
  diffCounts,
  revertChanges,
  SourceWorkspace,
} from '../lib/sync.js'
import { rawUrl, headAtomUrl } from '../lib/source.js'
import { bodyHash } from '../lib/store.js'

/** Throwaway storage root. */
const ROOT = mkdtempSync(join(tmpdir(), 'prompt-manager-sync-'))

/** The source every case below runs against. */
const SOURCE = { id: 'o-r', repo: 'o/r', ref: 'main', mirror: '', enabled: true }

const MANIFEST_URL = rawUrl('o/r', 'main', 'prompt-manager.json')
const ATOM_URL = headAtomUrl('o/r', 'main')
const A_URL = rawUrl('o/r', 'main', 'prompts/a.md')
const B_URL = rawUrl('o/r', 'main', 'prompts/b.md')

/**
 * Build a fetcher over a URL → response table.
 * @param routes - responses keyed by URL; a function is called with the options.
 * @returns a fetcher plus the calls it recorded.
 */
function fakeFetcher(routes) {
  const calls = []
  return {
    calls,
    async get(url, options = {}) {
      calls.push({ url, etag: options.etag })
      const entry = routes[url]
      if (entry === undefined) return { status: 404, text: '', etag: undefined, contentType: 'text/plain' }
      const resolved = typeof entry === 'function' ? entry(options) : entry
      return { status: 200, text: '', etag: undefined, contentType: 'text/plain', ...resolved }
    },
  }
}

/** A manifest declaring one or two prompts. */
const manifest = (prompts) => ({ status: 200, text: JSON.stringify({ prompts }), contentType: 'application/json' })

try {
  // ── line accounting ──────────────────────────────────────────────────────────

  assert.deepEqual(diffCounts('', 'a\nb'), { added: 2, removed: 0 }, 'a new file adds every line')
  assert.deepEqual(diffCounts('a\nb', ''), { added: 0, removed: 2 }, 'a removed file removes every line')
  assert.deepEqual(diffCounts('a\nb\nc', 'a\nX\nc'), { added: 1, removed: 1 }, 'one replacement is one and one')
  assert.deepEqual(diffCounts('a\nb', 'a\nb'), { added: 0, removed: 0 }, 'an identical body has no difference')
  assert.deepEqual(diffCounts('a\nb\nc', 'a\nc'), { added: 0, removed: 1 }, 'a deleted interior line is one removal')

  // ── first import ─────────────────────────────────────────────────────────────

  const workspace = new SourceWorkspace(ROOT, SOURCE.id)
  const first = await checkSource({
    source: SOURCE,
    workspace,
    fetcher: fakeFetcher({
      [ATOM_URL]: { status: 200, text: `<entry><id>Grit::Commit/${'a'.repeat(40)}</id></entry>` },
      [MANIFEST_URL]: manifest([
        { file: 'prompts/a.md', title: 'A', order: 30 },
        { file: 'prompts/b.md' },
      ]),
      [A_URL]: { status: 200, text: 'ONE\nTWO', etag: 'etag-a' },
      [B_URL]: { status: 200, text: 'BODY-B', etag: 'etag-b' },
    }),
  })
  assert.equal(first.upToDate, false, 'a first check finds work')
  assert.equal(first.headSha, 'a'.repeat(40), 'the commit is carried')
  assert.deepEqual(first.changes.map((change) => [change.path, change.kind, change.added]), [
    ['prompts/a.md', 'added', 2],
    ['prompts/b.md', 'added', 1],
  ], 'both files are staged as additions with their line counts')
  assert.equal(first.changes[0].id, 'o-r-a', 'the staged change carries the entry id it will become')
  assert.ok(existsSync(join(workspace.stagingDir, 'prompts/a.md')), 'the body is staged, not installed')

  const applied = applyChanges({
    workspace,
    state: workspace.readState(),
    plan: workspace.readPlan(),
    source: SOURCE,
    nowIso: '2026-01-01T00:00:00.000Z',
  })
  workspace.writeState(applied.state)
  workspace.clearStaging()
  assert.equal(applied.applied.length, 2, 'both staged files land')
  assert.equal(readFileSync(join(workspace.currentDir, 'prompts/a.md'), 'utf8'), 'ONE\nTWO', 'the body is in force')
  assert.equal(applied.state.files['prompts/a.md'].etag, 'etag-a', 'the validator is remembered')
  assert.equal(applied.state.files['prompts/a.md'].title, 'A', 'the manifest title is remembered')
  assert.equal(applied.state.headSha, 'a'.repeat(40), 'the commit is in force')
  assert.equal(applied.state.appliedAt, '2026-01-01T00:00:00.000Z', 'the apply is timestamped')

  // ── nothing changed ──────────────────────────────────────────────────────────

  const steady = await checkSource({
    source: SOURCE,
    workspace,
    fetcher: fakeFetcher({ [ATOM_URL]: { status: 200, text: `Grit::Commit/${'a'.repeat(40)}` } }),
  })
  assert.equal(steady.upToDate, true, 'the same commit needs no file requests')
  assert.deepEqual(steady.changes, [], 'and stages nothing')

  // ── an update, then a revert ─────────────────────────────────────────────────

  const updated = await checkSource({
    source: SOURCE,
    workspace,
    fetcher: fakeFetcher({
      [ATOM_URL]: { status: 200, text: `Grit::Commit/${'b'.repeat(40)}` },
      [MANIFEST_URL]: manifest([{ file: 'prompts/a.md', title: 'A', order: 30 }]),
      [A_URL]: { status: 200, text: 'ONE\nTWO\nTHREE', etag: 'etag-a2' },
    }),
  })
  assert.deepEqual(updated.changes.map((change) => [change.kind, change.added, change.removed]), [
    ['changed', 1, 0],
    ['removed', 0, 1],
  ], 'one body grew a line and the dropped file is reported as removed')

  const next = applyChanges({
    workspace,
    state: workspace.readState(),
    plan: workspace.readPlan(),
    source: SOURCE,
    nowIso: '2026-01-02T00:00:00.000Z',
  })
  workspace.writeState(next.state)
  workspace.clearStaging()
  assert.equal(readFileSync(join(workspace.previousDir, 'prompts/a.md'), 'utf8'), 'ONE\nTWO', 'the replaced body is kept')
  assert.ok(!existsSync(join(workspace.currentDir, 'prompts/b.md')), 'the dropped file left the snapshot')
  assert.equal(next.state.files['prompts/b.md'], undefined, 'and left the bookkeeping')

  const reverted = revertChanges({ workspace, state: workspace.readState() })
  workspace.writeState(reverted.state)
  assert.equal(readFileSync(join(workspace.currentDir, 'prompts/a.md'), 'utf8'), 'ONE\nTWO', 'revert puts the replaced body back')
  assert.equal(readFileSync(join(workspace.currentDir, 'prompts/b.md'), 'utf8'), 'BODY-B', 'revert restores the file that was dropped')
  assert.equal(reverted.state.files['prompts/b.md'].id, 'o-r-b', 'the restored file keeps its entry identity')
  assert.equal(reverted.state.files['prompts/a.md'].sha1, workspace.readState().files['prompts/a.md'].sha1, 'the bookkeeping is written where the state is read from')
  assert.equal(reverted.state.headSha, 'a'.repeat(40), 'revert puts the commit back')

  // ── partial apply ────────────────────────────────────────────────────────────

  const two = await checkSource({
    source: SOURCE,
    workspace,
    fetcher: fakeFetcher({
      [ATOM_URL]: { status: 200, text: `Grit::Commit/${'c'.repeat(40)}` },
      [MANIFEST_URL]: manifest([{ file: 'prompts/a.md' }, { file: 'prompts/b.md' }]),
      [A_URL]: { status: 200, text: 'A2', etag: 'e1' },
      [B_URL]: { status: 200, text: 'B2', etag: 'e2' },
    }),
  })
  assert.equal(two.changes.length, 2, 'both files differ')
  const partial = applyChanges({
    workspace,
    state: workspace.readState(),
    plan: workspace.readPlan(),
    source: SOURCE,
    selected: ['prompts/a.md'],
    nowIso: '2026-01-03T00:00:00.000Z',
  })
  assert.deepEqual(partial.applied.map((change) => change.path), ['prompts/a.md'], 'only the selected file lands')
  assert.equal(readFileSync(join(workspace.currentDir, 'prompts/a.md'), 'utf8'), 'A2', 'the selected body is in force')

  // ── failures the page has to report ──────────────────────────────────────────

  await assert.rejects(
    checkSource({ source: SOURCE, workspace: new SourceWorkspace(ROOT, 'missing'), fetcher: fakeFetcher({ [ATOM_URL]: { status: 404 } }) }),
    (error) => error instanceof CheckError && error.reason === 'manifest',
    'a repository without a manifest is refused',
  )
  await assert.rejects(
    checkSource({
      source: SOURCE,
      workspace: new SourceWorkspace(ROOT, 'html'),
      fetcher: fakeFetcher({
        [ATOM_URL]: { status: 404 },
        [MANIFEST_URL]: { status: 200, text: '<!doctype html><html>captcha</html>', contentType: 'text/html' },
      }),
    }),
    (error) => error instanceof CheckError && error.reason === 'mirror',
    'a mirror answering with a page is refused rather than staged',
  )
  await assert.rejects(
    checkSource({
      source: SOURCE,
      workspace: new SourceWorkspace(ROOT, 'offline'),
      fetcher: fakeFetcher({
        [ATOM_URL]: { status: 404 },
        [MANIFEST_URL]: () => {
          throw new Error('connect ECONNREFUSED')
        },
      }),
    }),
    (error) => error instanceof CheckError && error.reason === 'network',
    'a request that never lands is reported as a network failure',
  )

  const partialFailure = await checkSource({
    source: SOURCE,
    workspace: new SourceWorkspace(ROOT, 'warn'),
    fetcher: fakeFetcher({
      [ATOM_URL]: { status: 404 },
      [MANIFEST_URL]: manifest([{ file: 'prompts/a.md' }, { file: 'prompts/gone.md' }]),
      [A_URL]: { status: 200, text: 'A', etag: 'x' },
    }),
  })
  assert.equal(partialFailure.changes.length, 1, 'the file that exists is still staged')
  assert.ok(
    partialFailure.warnings.some((warning) => warning.includes('prompts/gone.md')),
    'the missing file is reported as a warning',
  )
  assert.ok(
    partialFailure.warnings.some((warning) => warning.includes('commit')),
    'an unreachable commits feed is reported, not fatal',
  )

  // ── a body file that vanished must be fetched again, never blanked ───────────

  /** Bookkeeping that remembers one body file, ready for the file to vanish. */
  const holed = (slug) => {
    const workspace = new SourceWorkspace(ROOT, slug)
    mkdirSync(join(workspace.currentDir, 'prompts'), { recursive: true })
    writeFileSync(join(workspace.currentDir, 'prompts/a.md'), 'ONE\nTWO', 'utf8')
    workspace.writeState({
      ref: 'main',
      files: { 'prompts/a.md': { id: `${slug}-a`, enabled: true, sha1: bodyHash('ONE\nTWO'), etag: 'etag-a' } },
    })
    return workspace
  }

  const holey = holed('holey')
  rmSync(join(holey.currentDir, 'prompts/a.md'))
  const refetch = fakeFetcher({
    [ATOM_URL]: { status: 404 },
    [MANIFEST_URL]: manifest([{ file: 'prompts/a.md', title: 'A' }]),
    [A_URL]: { status: 200, text: 'ONE\nTWO\nTHREE', etag: 'etag-a2' },
  })
  const recovered = await checkSource({ source: SOURCE, workspace: holey, fetcher: refetch })
  assert.equal(
    refetch.calls.find((call) => call.url === A_URL).etag,
    undefined,
    'a missing body file must drop the validator, so the answer carries content',
  )
  assert.deepEqual(
    recovered.changes.map((change) => [change.path, change.kind]),
    [['prompts/a.md', 'changed']],
    'the vanished file is staged as an ordinary change',
  )
  assert.equal(
    readFileSync(join(holey.stagingDir, 'prompts/a.md'), 'utf8'),
    'ONE\nTWO\nTHREE',
    'what is staged is the real body, never an empty 304 answer',
  )
  const restored = applyChanges({
    workspace: holey,
    state: holey.readState(),
    plan: holey.readPlan(),
    source: SOURCE,
    nowIso: '2026-01-04T00:00:00.000Z',
  })
  holey.writeState(restored.state)
  holey.clearStaging()
  assert.equal(
    readFileSync(join(holey.currentDir, 'prompts/a.md'), 'utf8'),
    'ONE\nTWO\nTHREE',
    'applying the plan puts a body back in force',
  )

  // An upstream that answers 304 anyway (a broken mirror, a stub) must be
  // skipped rather than staged as an empty body.
  const stubborn = holed('stubborn')
  rmSync(join(stubborn.currentDir, 'prompts/a.md'))
  const stubbornOutcome = await checkSource({
    source: SOURCE,
    workspace: stubborn,
    fetcher: fakeFetcher({
      [ATOM_URL]: { status: 404 },
      [MANIFEST_URL]: manifest([{ file: 'prompts/a.md' }]),
      [A_URL]: () => ({ status: 304, text: '', etag: 'etag-a' }),
    }),
  })
  assert.deepEqual(stubbornOutcome.changes, [], 'an unasked-for 304 stages nothing')
  assert.equal(existsSync(join(stubborn.stagingDir, 'prompts/a.md')), false, 'and leaves no empty body in staging')

  // ── a file renamed upstream ──────────────────────────────────────────────────

  /**
   * Take one source through two revisions, the first one applied.
   * @param slug - source slug and workspace directory.
   * @param before - the first revision: manifest prompts and their bodies.
   * @param after - the second revision, checked but not applied.
   * @returns the second check, and the workspace with the first one in force.
   */
  async function revised(slug, before, after) {
    const space = new SourceWorkspace(ROOT, slug)
    const source = { id: slug, repo: 'o/r', ref: 'main', mirror: '', enabled: true }
    /**
     * One body's route: a string is a plain 200, an object is a whole response,
     * and a function is called with the request options so a case can answer 304.
     */
    const route = (body) => {
      if (typeof body === 'function') return body
      if (typeof body === 'string') return { status: 200, text: body }
      return { status: 200, ...body }
    }
    const routesFor = (revision) => ({
      [ATOM_URL]: { status: 404 },
      [MANIFEST_URL]: manifest(revision.prompts),
      ...Object.fromEntries(Object.entries(revision.bodies).map(([file, body]) => [
        rawUrl('o/r', 'main', file),
        route(body),
      ])),
    })
    const opening = await checkSource({ source, workspace: space, fetcher: fakeFetcher(routesFor(before)) })
    assert.equal(opening.upToDate, false, `${slug}: the first revision must stage something`)
    const landed = applyChanges({
      workspace: space,
      state: space.readState(),
      plan: space.readPlan(),
      source,
      nowIso: '2026-01-01T00:00:00.000Z',
    })
    space.writeState(landed.state)
    space.clearStaging()
    const second = await checkSource({ source, workspace: space, fetcher: fakeFetcher(routesFor(after)) })
    return { space, source, second, opening }
  }

  const CONTRACT = '# 契约\n\n上游正文\n'

  // The signal that needs nobody's cooperation: the same body under a new name.
  const moved = await revised(
    'ren',
    { prompts: [{ file: 'prompts/contract.md', title: '契约', order: 30 }], bodies: { 'prompts/contract.md': CONTRACT } },
    { prompts: [{ file: 'prompts/ctf.md', title: '契约', order: 30 }], bodies: { 'prompts/ctf.md': CONTRACT } },
  )
  assert.equal(moved.opening.changes[0].id, 'ren-contract', 'the first revision gets the id its file name earns')
  const arrives = moved.second.changes.find((change) => change.kind === 'added')
  const leaves = moved.second.changes.find((change) => change.kind === 'removed')
  assert.equal(arrives.id, 'ren-contract', 'the renamed file inherits the id the preset knows')
  assert.equal(arrives.renamedFrom, 'prompts/contract.md', 'and says which path it came from')
  assert.equal(leaves.id, 'ren-contract', 'the dropped path is reported under the same identity')
  assert.equal(leaves.renamedTo, 'prompts/ctf.md', 'pointing at where it went')
  assert.equal(
    moved.second.warnings.some((warning) => warning.includes('改名')),
    false,
    'a recognised rename is not a warning',
  )

  // The pair is one move: a partial apply that names only the new path must not
  // leave two state records claiming the same entry id.
  const halfMoved = applyChanges({
    workspace: moved.space,
    state: moved.space.readState(),
    plan: moved.space.readPlan(),
    source: moved.source,
    selected: ['prompts/ctf.md'],
    nowIso: '2026-01-02T00:00:00.000Z',
  })
  assert.deepEqual(
    halfMoved.applied.map((change) => change.path).sort(),
    ['prompts/contract.md', 'prompts/ctf.md'],
    'selecting one side of a rename applies both',
  )
  assert.equal(halfMoved.state.files['prompts/contract.md'], undefined, 'the old path leaves the bookkeeping')
  assert.equal(halfMoved.state.files['prompts/ctf.md'].id, 'ren-contract', 'and the id survives the move')
  assert.equal(readFileSync(join(moved.space.currentDir, 'prompts/ctf.md'), 'utf8'), CONTRACT, 'with its body in place')

  // A body edited in the same commit is not recognisable as the same prompt, and
  // the check must not guess: it becomes a new entry, which is what the report
  // says and what the composition page shows as a member that no longer exists.
  const edited = await revised(
    'edit',
    { prompts: [{ file: 'prompts/contract.md' }], bodies: { 'prompts/contract.md': CONTRACT } },
    { prompts: [{ file: 'prompts/ctf.md' }], bodies: { 'prompts/ctf.md': `${CONTRACT}加了一句\n` } },
  )
  assert.equal(
    edited.second.changes.find((change) => change.kind === 'added').id,
    'edit-ctf',
    'a rename with a changed body cannot be matched, so it arrives as its own entry',
  )

  // Two files may carry one body — a copy, a translation left identical — and
  // then no hash can say which of them inherited the id.
  const ambiguous = await revised(
    'amb',
    { prompts: [{ file: 'prompts/contract.md' }], bodies: { 'prompts/contract.md': CONTRACT } },
    {
      prompts: [{ file: 'prompts/x.md' }, { file: 'prompts/y.md' }],
      bodies: { 'prompts/x.md': CONTRACT, 'prompts/y.md': CONTRACT },
    },
  )
  assert.deepEqual(
    ambiguous.second.changes.filter((change) => change.kind === 'added').map((change) => change.id),
    ['amb-x', 'amb-y'],
    'an ambiguous body is left to the file names rather than guessed at',
  )
  assert.ok(
    ambiguous.second.warnings.some((warning) => warning.includes('不敢确定是改名')),
    `the declined match must be reported, got: ${ambiguous.second.warnings.join(' | ')}`,
  )

  // The declaration that survives a rename *and* an edit: `id` is identity.
  const declared = await revised(
    'dec',
    { prompts: [{ file: 'prompts/old.md', id: 'stable', title: '稳定' }], bodies: { 'prompts/old.md': 'V1' } },
    { prompts: [{ file: 'prompts/new.md', id: 'stable', title: '稳定' }], bodies: { 'prompts/new.md': 'V2（改过）' } },
  )
  assert.equal(declared.opening.changes[0].id, 'dec-stable', 'a declared id outranks the file name')
  const declaredArrives = declared.second.changes.find((change) => change.kind === 'added')
  const declaredLeaves = declared.second.changes.find((change) => change.kind === 'removed')
  assert.equal(declaredArrives.id, 'dec-stable', 'and it holds while the file is renamed')
  assert.equal(declaredArrives.renamedFrom, 'prompts/old.md', 'the move is still reported as one')
  assert.equal(declaredLeaves.renamedTo, 'prompts/new.md', 'from both sides')

  // Declaring an id for a file that is already here moves the entry onto it —
  // which is how a preset that lost an id learns it again. The body is untouched,
  // so the mirror answers 304 and the move has to be noticed anyway.
  const repinned = await revised(
    'pin',
    { prompts: [{ file: 'prompts/a.md', title: 'A' }], bodies: { 'prompts/a.md': { text: 'BODY', etag: 'etag-a' } } },
    {
      prompts: [{ file: 'prompts/a.md', id: 'was-here', title: 'A' }],
      bodies: {
        'prompts/a.md': (options) => (options.etag === 'etag-a'
          ? { status: 304, text: '', etag: 'etag-a' }
          : { status: 200, text: 'BODY' }),
      },
    },
  )
  const repinnedChange = repinned.second.changes[0]
  assert.equal(repinned.second.changes.length, 1, 'an id that moved alone is one change')
  assert.equal(repinnedChange.id, 'pin-was-here', 'the declared id replaces the derived one')
  assert.equal(repinnedChange.kind, 'changed', 'while the file itself did not move')
  assert.equal(repinnedChange.added + repinnedChange.removed, 0, 'and no line did either')
  const repinnedLand = applyChanges({
    workspace: repinned.space,
    state: repinned.space.readState(),
    plan: repinned.space.readPlan(),
    source: repinned.source,
    nowIso: '2026-01-03T00:00:00.000Z',
  })
  assert.equal(
    repinnedLand.state.files['prompts/a.md'].renamedFromId,
    'pin-a',
    'the apply records the id the entry had, so the index can move its title and switch along',
  )
  assert.equal(
    repinnedLand.state.files['prompts/a.md'].etag,
    'etag-a',
    'and keeps the validator the unchanged body was fetched under',
  )

  // ── the workspace refuses to escape itself ───────────────────────────────────

  const guard = new SourceWorkspace(ROOT, 'guard')
  assert.equal(guard.slotPath('current', '../../escape.md'), undefined, 'a traversal path resolves to nothing')
  assert.throws(() => guard.stage('../../escape.md', 'x'), /outside the source/, 'staging a traversal path is refused')

  console.log('sync ok')
  console.log('  rotation    staging -> current, replaced bodies kept in previous')
  console.log('  accounting  added / changed / removed with line counts, partial apply honoured')
  console.log('  revert      the replaced body and the dropped file both come back')
  console.log('  conditional a vanished body is refetched, and a 304 never stages an empty one')
  console.log('  rename      a new path inherits the old id, the pair applies together, a declared id is identity')
  console.log('  failures    no manifest, an HTML mirror, a missing file, a traversal path')
} finally {
  rmSync(ROOT, { recursive: true, force: true })
}
