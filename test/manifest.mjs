#!/usr/bin/env node
/**
 * Manifest test: the marketplace-facing claims that nothing else checks.
 *
 * Three things live outside `src/` but are still promises this project makes, and
 * each one can be broken by an edit that no other suite would notice:
 *
 *  1. the compatibility window in `dsh.compatibility` — the store unlists an entry
 *     whose release window has no exact `compatible`, and it wants per-release
 *     `install`/`start`/`uninstall`/`rollback` evidence for the same window, so the
 *     two maps have to stay in step;
 *  2. the bundle patch body — `check-pack` only proves the patch is *present*, not
 *     that it stays additive and plugin-owned (the store refuses impersonated or
 *     duplicated entry IDs);
 *  3. the README's promise that this plugin reads no credentials — that is what the
 *     store's conservative scan leans on when it fills in the permission metadata,
 *     so it is checked against the shipped runtime sources rather than trusted.
 *
 * No Harness packages and no filesystem fixtures: this reads the repository.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const read = (relative) => readFileSync(new URL(relative, root), 'utf8')
const manifest = JSON.parse(read('package.json'))

// ── the compatibility window ─────────────────────────────────────────────────

/** Release states the store accepts, and the one that keeps an entry listed. */
const RELEASE_STATES = ['compatible', 'incompatible', 'unknown']
/** The four operations the store wants evidence for, on every release it lists. */
const OPERATIONS = ['install', 'start', 'uninstall', 'rollback']
const OPERATION_STATES = ['passed', 'failed', 'unknown']

const compatibility = manifest.dsh?.compatibility ?? {}
const releases = compatibility.dshReleases ?? {}
const operations = compatibility.dshOperations ?? {}
const releaseKeys = Object.keys(releases)

assert.ok(releaseKeys.length > 0, 'the manifest must declare a release window, or the store has nothing to check')

for (const [release, state] of Object.entries(releases)) {
  assert.ok(
    RELEASE_STATES.includes(state),
    `${release} must be declared as one of ${RELEASE_STATES.join(' / ')}, not ${JSON.stringify(state)}`,
  )
}

assert.ok(
  releaseKeys.some((release) => releases[release] === 'compatible'),
  'at least one release must be an exact `compatible`: a window of only unknown/incompatible is unlisted by the store',
)

// The two maps describe one window: the store reads the compatibility claims and
// the operation evidence for the same set of releases. Declaring a release in one
// map and forgetting it in the other is exactly the silent gap this pairing exists
// to prevent — a release with no operation record simply reads as `unknown`.
assert.deepEqual(
  Object.keys(operations).sort(),
  [...releaseKeys].sort(),
  'dshOperations must cover exactly the releases dshReleases declares, with no extras and no omissions',
)

for (const [release, record] of Object.entries(operations)) {
  assert.deepEqual(
    Object.keys(record).sort(),
    [...OPERATIONS].sort(),
    `${release} must record exactly ${OPERATIONS.join(' / ')}`,
  )
  for (const [operation, state] of Object.entries(record)) {
    assert.ok(
      OPERATION_STATES.includes(state),
      `${release}.${operation} must be one of ${OPERATION_STATES.join(' / ')}, not ${JSON.stringify(state)} — ` +
        'an untested operation stays `unknown`, it is never inferred from a compatible release',
    )
  }
}

// ── the bundle patch body ────────────────────────────────────────────────────

const patchPath = manifest.dsh?.bundle?.patch

assert.equal(typeof patchPath, 'string', 'the manifest must declare dsh.bundle.patch, which is what makes this a profile bundle')
assert.ok(patchPath.startsWith('./'), 'and it must be a safe relative path inside the package')

const patch = read(patchPath.replace(/^\.\//, ''))
const insertBlocks = patch.split(/^\s*-\s*insert:\s*$/m).length - 1

assert.equal(insertBlocks, 1, 'the bundle patch must be one `insert` block: mounting this package adds a row, it never rewrites the stack')

const entryIds = [...patch.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)].map((match) => match[1])

assert.equal(entryIds.length, 1, 'and it must insert exactly one row, so the store can list one entry ID for this package')
assert.ok(entryIds[0].length > 0, 'the inserted row carries a non-empty id')

// Impersonating an official component is the one thing the store names as grounds
// for refusal rather than remediation, so the patch is checked for the namespace
// itself rather than for a known-official list.
assert.ok(
  !/^\s*name:\s*['"]?@deepseek-ai\//m.test(patch),
  'the patch must never mount a row under the @deepseek-ai/ namespace: this package is additive, not a replacement',
)

// ── the "no credential access" promise ───────────────────────────────────────

// Credential access, in the shapes it actually takes in this codebase's stack:
// reading it out of the environment, sending it in a header, or opening the files
// the tools that hold it write. Matching the capability rather than the word keeps
// this honest — `src/source.ts` and `src/routes.ts` legitimately mention the word
// "credentials" in guards that *reject* credentialed URLs.
const CREDENTIAL_ACCESS = [
  { pattern: /process\.env\.[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY)\b/g, does: 'reads a credential-shaped environment variable' },
  { pattern: /['"`]Authorization['"`]\s*:/gi, does: 'builds an Authorization header' },
  { pattern: /\.(?:npmrc|netrc|git-credentials)|id_rsa|id_ed25519/g, does: 'opens a file that holds a credential' },
]

// `fileURLToPath`, not `URL.pathname`: this repository's path holds non-ASCII
// characters, which a URL pathname percent-encodes and `readdir` does not, so
// slicing one by the other's length would produce paths that never resolve.
const libDir = fileURLToPath(new URL('lib/', root))
const runtimeFiles = [
  ...readdirSync(libDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => `lib/${relative(libDir, join(entry.parentPath, entry.name)).replaceAll('\\', '/')}`),
  'client/client.js',
]

assert.ok(runtimeFiles.length > 5, 'the shipped runtime surface must be non-empty, or this check proves nothing')

for (const file of runtimeFiles) {
  const source = read(file)
  for (const { pattern, does } of CREDENTIAL_ACCESS) {
    const found = source.match(pattern)
    assert.equal(
      found,
      null,
      `${file} ${does} (${[...new Set(found ?? [])].join(', ')}), but README.md promises this plugin reads no credentials — ` +
        'either drop the access or change the disclosure, the store fills its permission metadata from that promise',
    )
  }
}

// The disclosure itself, in the store's four axes: its scan keys on these names,
// so losing one silently turns a declared capability into `unknown`.
const readme = read('README.md')
for (const axis of ['文件（`files`）', '网络（`network`）', '命令（`commands`）', '凭据（`credentials`）']) {
  assert.ok(readme.includes(axis), `README.md must disclose the ${axis.split('（')[0]} permission axis the store checks`)
}

console.log('manifest ok')
console.log(`  window      ${releaseKeys.map((release) => `${release}=${releases[release]}`).join(' ')}`)
console.log(`  operations  ${releaseKeys.map((release) => `${release}:${Object.values(operations[release]).join('')}`).join(' ')}`)
console.log(`  patch       one insert, entry id ${entryIds[0]}, no @deepseek-ai/ row`)
console.log(`  credentials ${String(runtimeFiles.length)} runtime files read no credential, no Authorization header, no credential file`)
