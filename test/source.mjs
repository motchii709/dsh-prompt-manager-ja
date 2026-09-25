#!/usr/bin/env node
/**
 * Source test: everything pure about a subscription — the manifest grammar, the
 * slug and id derivation, the mirror shapes, and the URL builders.
 *
 * No network and no filesystem: this module is strings and JSON only, so the
 * test drives it directly.
 */
import assert from 'node:assert/strict'

import {
  entryIdFor,
  entryIdForPrompt,
  headAtomUrl,
  isRepo,
  isRef,
  isMovableRef,
  MANIFEST_FILE,
  ManifestError,
  normalizeMirror,
  parseHeadSha,
  parseManifest,
  parseSource,
  parseSources,
  rawUrl,
  sourceSlug,
  stemOf,
  withMirror,
} from '../lib/source.js'

// ── repository, ref, and slug grammar ─────────────────────────────────────────

assert.ok(isRepo('lolkda/dsh-prompt-manager'), 'owner/name is accepted')
assert.ok(!isRepo('lolkda'), 'a bare owner is not a repository')
assert.ok(!isRepo('/leading'), 'a leading slash is refused')
assert.ok(!isRepo('a/b/c'), 'a third segment is refused')

assert.ok(isRef('main') && isRef('release/notes') && isRef('v1.2.3'), 'branches, path refs, and tags are accepted')
assert.ok(!isRef('..') && !isRef('main..dev') && !isRef('-dash'), 'traversal and leading dashes are refused')
assert.ok(!isRef('a'.repeat(101)), 'an over-long ref is refused')

assert.equal(sourceSlug('lolkda/dsh-prompt-manager'), 'lolkda-dsh-prompt-manager', 'a slug is derived from owner/name')
assert.equal(sourceSlug('Some_Owner/Weird.Name'), 'some-owner-weird-name', 'a slug is lowercased and hyphenated')
assert.equal(stemOf('prompts/My Prompt.md'), 'my-prompt', 'a file stem is slugged')
assert.equal(entryIdFor('lolkda-prompts', 'prompts/my-prompt.md'), 'lolkda-prompts-my-prompt', 'an entry id carries its source')

const longSlug = 'x'.repeat(64)
assert.equal(entryIdFor(longSlug, 'prompts/one.md'), `${'x'.repeat(60)}-one`, 'a long source slug gives up the room its stem needs')
assert.equal(entryIdFor(longSlug, 'prompts/one.md').length, 64, 'and the id still fills the cap exactly')
assert.notEqual(
  entryIdFor(longSlug, 'prompts/one.md'),
  entryIdFor(longSlug, 'prompts/two.md'),
  'two files of one long-named source must keep distinct ids',
)

assert.equal(
  entryIdForPrompt('src', { file: 'prompts/whatever.md', id: 'contract' }),
  'src-contract',
  'a declared id is the entry id, whatever the file happens to be called',
)
assert.equal(
  entryIdForPrompt('src', { file: 'prompts/contract.md' }),
  entryIdFor('src', 'prompts/contract.md'),
  'without a declaration the file name decides, exactly as before',
)
assert.equal(entryIdForPrompt(longSlug, { file: 'prompts/whatever.md', id: 'one' }).length, 64, 'a declared id obeys the cap too')

assert.ok(isMovableRef('main'), 'a branch is worth probing')
assert.ok(!isMovableRef('0'.repeat(40)), 'a pinned commit is not worth probing')

// ── the manifest ──────────────────────────────────────────────────────────────

const parsed = parseManifest({
  prompts: [
    { file: 'prompts/contract.md', title: '契约', order: 30, enabled: true },
    { file: 'prompts/notes.md', id: 'Notes Extra' },
  ],
})
assert.equal(parsed.length, 2, 'both prompts are accepted')
assert.equal(parsed[0].title, '契约', 'the title is carried')
assert.equal(parsed[0].order, 30, 'the placement is carried')
assert.equal(parsed[1].id, 'notes-extra', 'the id stem is slugged')

for (const [label, manifest] of [
  ['a non-object', []],
  ['a manifest without prompts', {}],
  ['an empty list', { prompts: [] }],
  ['a file that is not markdown', { prompts: [{ file: 'contract.txt' }] }],
  ['an absolute path', { prompts: [{ file: '/etc/passwd.md' }] }],
  ['a traversal path', { prompts: [{ file: '../../secret.md' }] }],
  ['a duplicate file', { prompts: [{ file: 'a.md' }, { file: 'a.md' }] }],
  ['too many prompts', { prompts: Array.from({ length: 51 }, (_, index) => ({ file: `p${String(index)}.md` })) }],
]) {
  assert.throws(() => parseManifest(manifest), ManifestError, `${label} is refused`)
}

// ── mirrors ───────────────────────────────────────────────────────────────────

assert.equal(normalizeMirror('https://gh-proxy.lolkda.top/'), 'https://gh-proxy.lolkda.top', 'a trailing slash is stripped')
assert.equal(normalizeMirror('https://gh.example/sub/'), 'https://gh.example/sub', 'a path-carrying mirror keeps its prefix')
assert.equal(normalizeMirror(''), '', 'an empty mirror means inherit')
assert.equal(normalizeMirror('http://plain.example'), undefined, 'a non-https mirror is refused')
assert.equal(normalizeMirror('https://user:pass@host'), undefined, 'a mirror with credentials is refused')
assert.equal(normalizeMirror('https://host/?q=1'), undefined, 'a mirror with a query is refused')

const raw = 'https://raw.githubusercontent.com/o/r/main/a.md'
assert.equal(withMirror('', raw), raw, 'no mirror means no rewrite')
assert.equal(withMirror('https://gh-proxy.lolkda.top', raw), `https://gh-proxy.lolkda.top/${raw}`, 'a prefix mirror matches the market plugin')
assert.equal(withMirror('https://p.example/{url}', raw), `https://p.example/${raw}`, 'a {url} template is substituted')
assert.equal(
  withMirror('https://p.example/raw?u={url}', raw),
  `https://p.example/raw?u=${raw}`,
  'a template may place the URL anywhere',
)

// ── URL builders and the commits feed ─────────────────────────────────────────

assert.equal(MANIFEST_FILE, 'prompt-manager.json', 'the manifest name is the documented one')
assert.equal(rawUrl('o/r', 'main', 'prompts/a b.md'), 'https://raw.githubusercontent.com/o/r/main/prompts/a%20b.md', 'a path segment with a space is encoded')
assert.equal(headAtomUrl('o/r', 'main'), 'https://github.com/o/r/commits/main.atom', 'the feed URL is built')

const feed = `<?xml version="1.0"?><feed><entry><id>tag:github.com,2008:Grit::Commit/${'a'.repeat(40)}</id></entry><entry><id>tag:github.com,2008:Grit::Commit/${'b'.repeat(40)}</id></entry></feed>`
assert.equal(parseHeadSha(feed), 'a'.repeat(40), 'the newest commit is read from the feed')
assert.equal(parseHeadSha('<feed></feed>'), undefined, 'a feed without commits yields nothing')

// ── sources ───────────────────────────────────────────────────────────────────

assert.deepEqual(
  parseSource({ id: 'src', repo: 'o/r', ref: 'main', mirror: '' }),
  { id: 'src', repo: 'o/r', ref: 'main', mirror: '', enabled: true },
  'a well-formed source survives narrowing',
)
assert.equal(parseSource({ id: 'BAD', repo: 'o/r', ref: 'main' }), undefined, 'a bad slug is dropped')
assert.equal(parseSource({ id: 'src', repo: 'o', ref: 'main' }), undefined, 'a bad repo is dropped')
assert.equal(parseSource({ id: 'src', repo: 'o/r', ref: 'main', mirror: 'http://x.example' }), undefined, 'a bad mirror is dropped')
assert.deepEqual(parseSource({ id: 'src', repo: 'o/r', ref: 'main' }).mirror, '', 'an absent mirror narrows to inherit')
assert.deepEqual(
  parseSources([{ id: 'a', repo: 'o/r', ref: 'main' }, { id: 'a', repo: 'o/r2', ref: 'main' }, { id: 'b', repo: 'o/r', ref: 'main' }]).map((entry) => entry.id),
  ['a', 'b'],
  'a duplicate source id is dropped',
)

console.log('source ok')
console.log('  grammar     repo / ref / slug / id derivation, traversal refused')
console.log('  manifest    titles, placements, and ids narrowed; malformed inputs refused')
console.log('  mirror      https-only, prefix and {url} shapes')
console.log('  feed        head sha read from the commits atom feed')
