#!/usr/bin/env node
/**
 * Pack test: everything pure about a preset pack — what goes in, what a foreign
 * file has to look like to be accepted, and which ids an import would take.
 *
 * No HTTP, no store, no settings: building, parsing, and planning are all
 * functions of their arguments, so this drives them directly. The routes that
 * read and write on behalf of a browser are covered in `routes.mjs`.
 */
import assert from 'node:assert/strict'

import {
  buildPack,
  MAX_PACK_BYTES,
  MAX_PACK_ENTRIES,
  PACK_FORMAT,
  PACK_VERSION,
  parsePack,
  planImport,
  writePackBodies,
} from '../lib/pack.js'
import { MAX_BODY_BYTES, MAX_ENTRIES } from '../lib/entries.js'

// ── building a pack ───────────────────────────────────────────────────────────

const local = {
  id: 'env',
  title: '本机环境',
  order: 5,
  enabled: true,
  body: '# Machine environment\n\nMeasured on this machine.\n',
  origin: 'local',
}
const subscribed = {
  id: 'lolkda-dsh-prompt-pack-ctf',
  title: 'CTF 沙箱契约',
  order: 30,
  enabled: true,
  source: { slug: 'lolkda-dsh-prompt-pack', repo: 'lolkda/dsh-prompt-pack', ref: 'main', file: 'ctf.md' },
}

const pack = buildPack({
  preset: { id: 'ctf', name: 'ctf', entries: ['env', 'lolkda-dsh-prompt-pack-ctf', 'gone-entry'], compaction: '' },
  members: [local, subscribed],
  missing: ['gone-entry'],
  pluginName: '@lolkda/dsh-prompt-manager',
  pluginVersion: '9.9.9',
  now: new Date('2026-09-12T00:00:00.000Z'),
})

assert.equal(pack.format, PACK_FORMAT, 'a pack names its format')
assert.equal(pack.version, PACK_VERSION, 'and its version')
assert.equal(pack.exportedAt, '2026-09-12T00:00:00.000Z', 'the header records when it was written')
assert.deepEqual(pack.generator, { plugin: '@lolkda/dsh-prompt-manager', pluginVersion: '9.9.9' }, 'and by what')
assert.deepEqual(pack.preset.entries, ['env', 'lolkda-dsh-prompt-pack-ctf', 'gone-entry'], 'membership is carried as written')
assert.deepEqual(pack.missing, ['gone-entry'], 'a member that no longer exists is reported, not dropped in silence')
assert.equal(pack.entries[0].body, local.body, 'a local member carries its body')
assert.equal(pack.entries[0].origin, 'local', 'and says which layer supplied it')
assert.equal(pack.entries[1].body, undefined, 'a subscribed member carries no body')
assert.deepEqual(
  pack.entries[1].source,
  { slug: 'lolkda-dsh-prompt-pack', repo: 'lolkda/dsh-prompt-pack', ref: 'main', file: 'ctf.md' },
  'it carries where its body comes from instead',
)

// A member with neither body nor source is what a bodyless local entry looks
// like; the pack has to survive it rather than invent one.
const bare = buildPack({
  preset: { id: 'p', name: 'p', entries: ['x'], compaction: '' },
  members: [{ id: 'x', title: '空条目', order: 0, enabled: false }],
  pluginName: '@lolkda/dsh-prompt-manager',
  pluginVersion: '9.9.9',
})
assert.deepEqual(bare.entries, [{ id: 'x', title: '空条目', order: 0, enabled: false }], 'a bodyless member round-trips')

// ── reading a pack back ───────────────────────────────────────────────────────

const round = parsePack(JSON.parse(JSON.stringify(pack)))
assert.equal(round.ok, true, 'a pack this build wrote parses')
assert.deepEqual(round.pack, pack, 'and survives the round trip unchanged')
assert.equal(MAX_PACK_BYTES, 4 * 1024 * 1024, 'the import ceiling is published for the route to use')

const refuse = (raw, code, what) => {
  const result = parsePack(raw)
  assert.equal(result.ok, false, `${what} must be refused`)
  assert.equal(result.code, code, `${what} must be refused as ${code}, not ${result.code}`)
  assert.ok(result.message.length > 0, `${what} must come with a message for the page`)
}

refuse('not an object', 'bad-format', 'a bare string')
refuse({ format: 'something-else', version: 1 }, 'bad-format', 'a foreign JSON file')
refuse({ format: PACK_FORMAT, version: 99 }, 'bad-version', 'a newer pack format')
refuse({ format: PACK_FORMAT, version: PACK_VERSION }, 'bad-preset', 'a pack with no preset')
refuse(
  { format: PACK_FORMAT, version: PACK_VERSION, preset: { name: 'x' } },
  'bad-preset',
  'a preset that carries no membership array',
)
refuse(
  { format: PACK_FORMAT, version: PACK_VERSION, preset: { name: 'x', entries: [] } },
  'bad-entry',
  'a pack with no entries array at all',
)
refuse(
  { format: PACK_FORMAT, version: PACK_VERSION, preset: { name: 'x', entries: [] }, entries: [{ order: 1 }] },
  'bad-entry',
  'an entry with no title',
)
refuse(
  {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    preset: { name: 'x', entries: [] },
    entries: Array.from({ length: MAX_PACK_ENTRIES + 1 }, (_, index) => ({ id: `e${String(index)}`, title: `e${String(index)}` })),
  },
  'too-many-entries',
  'a pack over the entry cap',
)
refuse(
  {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    preset: { name: 'x', entries: [] },
    entries: [{ id: 'a', title: 'a', body: 'x'.repeat(MAX_BODY_BYTES + 1) }],
  },
  'too-large',
  'a body over the store limit',
)

// The one refusal that protects the assembly: an index entry whose body cannot
// render fails every model step, so the pack never gets that far. A well-formed
// name that is merely unregistered today is a different thing — another row may
// register it, and the guard renders it as prose meanwhile — so it is accepted.
refuse(
  {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    preset: { name: 'x', entries: [] },
    entries: [{ id: 'a', title: '写法不对', body: 'before {{不是变量名}} after' }],
  },
  'bad-reference',
  'a body with an unusable reference',
)
const unregistered = parsePack({
  format: PACK_FORMAT,
  version: PACK_VERSION,
  preset: { name: 'x', entries: ['a'] },
  entries: [{ id: 'a', title: '还没注册', body: 'before {{oops}} after' }],
})
assert.equal(unregistered.ok, true, 'a well-formed reference to an unregistered name is accepted')

// An empty preset is a real thing to move — somebody's blank slate — so a pack
// that carries no members at all is accepted rather than refused.
const empty = parsePack({
  format: PACK_FORMAT,
  version: PACK_VERSION,
  preset: { id: 'blank', name: 'blank', entries: [] },
  entries: [],
})
assert.equal(empty.ok, true, 'a preset with no members is a valid pack')
assert.deepEqual(empty.pack.entries, [], 'and it carries nothing')
assert.deepEqual(planImport(empty.pack, { entryIds: [], presetIds: [] }).plan.preset, { id: 'blank', name: 'blank', entries: [] }, 'importing an empty preset must not create a compression setting')

// A pack is data: a prompt of the right shape, not a program.
const withScripts = parsePack({
  format: PACK_FORMAT,
  version: PACK_VERSION,
  preset: { name: 'x', entries: ['a'] },
  entries: [{ id: 'a', title: 'a', body: 'hello' }],
  scripts: { evil: 'console.log(JSON.stringify({ a: 1 }))' },
})
assert.equal(withScripts.ok, true, 'a pack never carries scripts, so a stray field cannot change that')
assert.equal(withScripts.pack.entries.length, 1, 'only entries are read out of a pack')

// Recoverable fields are recovered rather than refused: an importer decides the
// id and the placement again anyway.
const recovered = parsePack({
  format: PACK_FORMAT,
  version: PACK_VERSION,
  preset: { name: 'x', entries: ['odd'] },
  entries: [{ id: 'Not An Id', title: '标题', body: '' }, { id: 'ok', title: 'ok', order: 'nonsense', enabled: 'yes' }],
})
assert.equal(recovered.ok, true, 'an unusable id or order is not fatal')
assert.equal(recovered.pack.entries[0].order, 0, 'an unusable order falls back to zero')
assert.equal(recovered.pack.entries[1].enabled, false, 'a non-boolean enabled falls back to off')
assert.equal(recovered.pack.entries[1].order, 0, 'a non-numeric order falls back to zero')

// ── planning an import ────────────────────────────────────────────────────────

const free = planImport(pack, { entryIds: [], presetIds: [] })
assert.equal(free.ok, true, 'a pack fits on an empty machine')
assert.deepEqual(
  free.plan.entries.map((entry) => entry.id),
  ['env', 'lolkda-dsh-prompt-pack-ctf'],
  'free ids are kept',
)
assert.deepEqual(free.plan.renamed, [], 'so nothing is renamed')
assert.deepEqual(free.plan.noBody, ['CTF 沙箱契约'], 'a subscribed member is reported as having no body here')
assert.deepEqual(free.plan.missingMembers, ['gone-entry'], 'a member the pack could not carry is reported')
assert.deepEqual(
  free.plan.preset,
  { id: 'ctf', name: 'ctf', entries: ['env', 'lolkda-dsh-prompt-pack-ctf', 'gone-entry'] },
  'membership survives, including the id that may come back with a source',
)

const collided = planImport(pack, {
  entryIds: ['env', 'other'],
  presetIds: ['ctf', 'more'],
})
assert.equal(collided.ok, true, 'a taken id is not an error')
assert.deepEqual(
  collided.plan.entries.map((entry) => entry.id),
  ['env-2', 'lolkda-dsh-prompt-pack-ctf'],
  'a taken id gives way to one derived from the title',
)
assert.deepEqual(collided.plan.renamed, [{ from: 'env', to: 'env-2' }], 'and the rename is reported')
assert.deepEqual(
  collided.plan.preset,
  { id: 'ctf-2', name: 'ctf', entries: ['env-2', 'lolkda-dsh-prompt-pack-ctf', 'gone-entry'] },
  'the preset follows the entries that moved, keeps its name, and takes a free id',
)
assert.equal(collided.plan.entries[0].renamedFrom, 'env', 'the entry remembers what it was called')

// Two entries in one pack claiming the same id is the same rule, applied twice.
const doubled = planImport(
  buildPack({
    preset: { id: 'p', name: 'p', entries: ['dup'], compaction: '' },
    members: [
      { id: 'dup', title: '第一份', order: 1, enabled: true, body: 'a' },
      { id: 'dup', title: '第二份', order: 2, enabled: true, body: 'b' },
    ],
    pluginName: '@lolkda/dsh-prompt-manager',
  pluginVersion: '9.9.9',
  }),
  { entryIds: [], presetIds: [] },
)
assert.deepEqual(
  doubled.plan.entries.map((entry) => entry.id),
  ['dup', 'dup-2'],
  'the second claim on an id gets a suffixed variant of that id, not one slugged from its title',
)
assert.deepEqual(
  doubled.plan.entries.map((entry) => entry.body),
  ['a', 'b'],
  'and each keeps the body it came with',
)

// An id that could never address a file is replaced by one derived from the
// title — the one case where the title is the only thing there is to go on.
const unusable = planImport(
  buildPack({
    preset: { id: 'p', name: 'p', entries: [], compaction: '' },
    members: [{ id: 'Not An Id', title: '中文标题', order: 1, enabled: true, body: 'x' }],
    pluginName: '@lolkda/dsh-prompt-manager',
  pluginVersion: '9.9.9',
  }),
  { entryIds: [], presetIds: [] },
)
assert.deepEqual(unusable.plan.entries.map((entry) => entry.id), ['entry'], 'an unusable id falls back to the title stem')

// The hazard worth naming: a subscription reads its body upstream *by id*, so
// an entry that had to be renamed cannot read its file any more.
const subscriptionCollision = planImport(pack, { entryIds: ['lolkda-dsh-prompt-pack-ctf'], presetIds: [] })
assert.deepEqual(
  subscriptionCollision.plan.entries.map((entry) => entry.id),
  ['env', 'lolkda-dsh-prompt-pack-ctf-2'],
  'a colliding subscription takes a suffixed id',
)
assert.equal(
  subscriptionCollision.plan.entries[1].source,
  undefined,
  'and gives up its source reference rather than claiming a read-only body it could never read',
)
assert.deepEqual(
  subscriptionCollision.plan.sourceDropped,
  ['CTF 沙箱契约'],
  'which the report says out loud',
)
assert.equal(
  subscriptionCollision.plan.entries[1].renamedFrom,
  'lolkda-dsh-prompt-pack-ctf',
  'the entry still records the id it arrived with',
)

// Fitting is checked before anything else: a pack that does not fit changes
// nothing at all.
const full = planImport(pack, {
  entryIds: Array.from({ length: MAX_ENTRIES - 1 }, (_, index) => `fill-${String(index)}`),
  presetIds: [],
})
assert.equal(full.ok, false, 'a pack that does not fit is refused')
assert.equal(full.code, 'too-many-entries', 'as too-many-entries')
assert.ok(full.message.includes('还能再放 1 条'), `the message must say how much room is left: ${full.message}`)

const exact = planImport(pack, {
  entryIds: Array.from({ length: MAX_ENTRIES - 2 }, (_, index) => `fill-${String(index)}`),
  presetIds: [],
})
assert.equal(exact.ok, true, 'a pack that exactly fills the last slots is accepted')

// ── presets carry sections only; legacy compression bodies stay independent ──

const compactionMember = {
  id: 'compact-zh',
  title: '压缩指令',
  order: 90,
  enabled: false,
  kind: 'compaction',
  body: '你是压缩引擎，按八节模板输出。',
}
const legacyPack = {
  ...pack,
  preset: { id: 'ctf', name: 'ctf', entries: ['env', 'compact-zh'], compaction: 'compact-zh' },
  entries: [local, compactionMember],
  missing: [],
}
const sectionsOnly = buildPack({
  preset: legacyPack.preset,
  members: [local, compactionMember],
  pluginName: '@lolkda/dsh-prompt-manager',
  pluginVersion: '9.9.9',
})
assert.deepEqual(sectionsOnly.preset, { id: 'ctf', name: 'ctf', entries: ['env'] }, 'new exports must omit legacy compression bindings and members')
assert.deepEqual(sectionsOnly.entries, [local], 'a preset export must not carry an independent compaction body')
const reread = parsePack(JSON.parse(JSON.stringify(sectionsOnly)))
assert.equal(reread.ok, true, 'a section-only pack must read back')
assert.deepEqual(reread.pack, sectionsOnly, 'the section-only format must round-trip unchanged')

const legacyRead = parsePack(legacyPack)
assert.equal(legacyRead.ok, true, 'old version-1 packs must remain readable')
assert.deepEqual(legacyRead.pack.preset, { id: 'ctf', name: 'ctf', entries: ['env'] }, 'old compression metadata must not bind the imported preset')
assert.equal(legacyRead.pack.entries[1].kind, 'compaction', 'a legacy compression body must not become a normal section')
assert.equal(legacyRead.pack.entries[1].body, compactionMember.body, 'legacy bodies are preserved for manual selection')

const manualImport = planImport(legacyPack, { entryIds: [], presetIds: [] })
assert.equal(manualImport.ok, true)
assert.deepEqual(manualImport.plan.preset, { id: 'ctf', name: 'ctf', entries: ['env'] }, 'the import planner must also exclude compression membership')
assert.equal(manualImport.plan.entries[1].kind, 'compaction', 'legacy compression is imported as a standalone entry')
const movedManual = planImport(legacyRead.pack, { entryIds: ['compact-zh'], presetIds: [] })
assert.equal(movedManual.ok, true)
assert.equal(movedManual.plan.entries[1].id, 'compact-zh-2', 'standalone compression still receives a collision-free id')
assert.equal(movedManual.plan.entries[1].renamedFrom, 'compact-zh')
assert.deepEqual(movedManual.plan.preset, { id: 'ctf', name: 'ctf', entries: ['env'] }, 'renaming compression must never reattach it to the preset')

const danglingLegacy = parsePack({
  format: PACK_FORMAT,
  version: PACK_VERSION,
  preset: { id: 'x', name: 'x', entries: ['a'], compaction: 'gone-instruction' },
  entries: [{ id: 'a', title: 'a', body: 'hello' }],
})
assert.equal(danglingLegacy.ok, true, 'an unused legacy pointer must not prevent import')
const danglingPlan = planImport(danglingLegacy.pack, { entryIds: [], presetIds: [] })
assert.deepEqual(danglingPlan.plan.preset, { id: 'x', name: 'x', entries: ['a'] }, 'a legacy pointer must be ignored rather than copied or defaulted')
assert.equal(Object.hasOwn(danglingPlan.plan, 'compactionDropped'), false, 'a preset import no longer reports a compression binding')
const compressionOnly = parsePack({ ...legacyPack, preset: { ...legacyPack.preset, entries: ['compact-zh'] }, entries: [compactionMember] })
assert.equal(compressionOnly.ok, true)
assert.deepEqual(compressionOnly.pack.preset.entries, [], 'an old compression-only selection must become an empty section preset')
assert.equal(compressionOnly.pack.entries[0].kind, 'compaction', 'its independent compression entry is not lost')

// ── writing the bodies ────────────────────────────────────────────────────────

// The rollback is the reason the plan carries ids rather than a bare object: a
// half-written import must not leave files nothing points at.
const sinkLog = []
const sinkFor = (failOn) => ({
  write: (id, body) => {
    sinkLog.push(`write ${id} (${String(body.length)} 字节)`)
    if (id === failOn) throw new Error('磁盘满了')
  },
  remove: (id) => { sinkLog.push(`remove ${id}`) },
})

writePackBodies(
  [
    { id: 'a', title: 'a', order: 1, enabled: true, body: 'one' },
    { id: 'b', title: 'b', order: 2, enabled: true },
    { id: 'c', title: 'c', order: 3, enabled: true, body: 'three' },
  ],
  sinkFor(null),
)
assert.deepEqual(sinkLog, ['write a (3 字节)', 'write c (5 字节)'], 'a subscription carries no body, so nothing is written for it')

sinkLog.length = 0
assert.throws(
  () => writePackBodies(
    [
      { id: 'a', title: 'a', order: 1, enabled: true, body: 'one' },
      { id: 'b', title: 'b', order: 2, enabled: true, body: 'two' },
    ],
    sinkFor('b'),
  ),
  /磁盘满了/,
  'a failing body write is rethrown',
)
assert.deepEqual(sinkLog, ['write a (3 字节)', 'write b (3 字节)', 'remove a'], 'and the files this import created are taken back')

console.log('pack ok')
console.log('  build       local bodies inline, subscriptions by reference, missing members named')
console.log('  parse       format and version named, bad entries refused by position, unrenderable bodies refused')
console.log('  recover     unusable ids and orders recovered instead of refused')
console.log('  plan        free ids kept, taken ids renamed with the preset following, capacity checked first')
console.log('  compression new exports contain sections only; legacy compression bodies import as standalone entries')
console.log('  bodies      written in pack order, subscriptions skipped, everything taken back on failure')
