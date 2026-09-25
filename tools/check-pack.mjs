#!/usr/bin/env node
/**
 * Pack-contract check: what `npm publish` would ship must be everything a DSH
 * install needs.
 *
 * The bundle patch, the browser half, and the built host half are the three things
 * `dsh plugin add` mounts, and they are metadata and build output rather than code,
 * so no test in `test/` covers them — a `files` array edited by hand can silently
 * drop one. The patch path is read from `dsh.bundle.patch` instead of being repeated
 * here, so the manifest and its target cannot disagree.
 *
 * Reports the tarball's file count and size, then exits non-zero listing anything
 * missing.
 *
 * @module @lolkda/dsh-prompt-manager/tools/check-pack
 */

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Paths every published tarball must carry, on top of the declared bundle patch. */
const REQUIRED = ['package.json', 'lib/index.js', 'client/client.js', 'environment.md', 'README.md']

/**
 * Ask npm what it would pack, without writing a tarball.
 *
 * A fixed command string through the platform shell, because on Windows `npm` is a
 * `.cmd` shim that `execFile` cannot start at all (`EINVAL`), and passing an argument
 * array with `shell: true` is what raises `DEP0190`. The command carries no
 * interpolation, so there is nothing to escape. `--json` keeps the listing
 * machine-readable — the human one goes to stderr.
 *
 * @returns the single pack record npm reports.
 */
function packRecord() {
  const raw = execSync('npm pack --dry-run --json', {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const parsed = JSON.parse(raw)
  const record = Array.isArray(parsed) ? parsed[0] : parsed
  if (record === null || typeof record !== 'object' || !Array.isArray(record.files)) {
    throw new Error('npm pack --dry-run --json did not report a file list')
  }
  return record
}

/**
 * The package.json this checkout publishes.
 *
 * @returns the parsed manifest.
 */
function manifest() {
  return JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
}

const record = packRecord()
const shipped = new Set(record.files.map((file) => file.path))
const own = manifest()
const declared = own.dsh && own.dsh.bundle ? own.dsh.bundle.patch : undefined
const patch = typeof declared === 'string' ? declared.replace(/^\.\//, '') : undefined

if (patch === undefined) {
  console.log('check-pack: package.json declares no dsh.bundle.patch — the package cannot mount itself')
}

const wanted = patch === undefined ? REQUIRED : [...REQUIRED, patch]
const missing = [...new Set(wanted)].filter((path) => !shipped.has(path))

if (missing.length > 0) {
  console.error(`check-pack: the tarball is missing ${String(missing.length)} required file(s):`)
  for (const path of missing) console.error(`  ${path}`)
  process.exitCode = 1
} else {
  const kilobytes = Math.round(record.size / 100) / 10
  console.log(
    `check-pack ok: ${String(record.entryCount)} files, ${String(kilobytes)} kB, ` +
      `bundle patch ${String(patch)} present`,
  )
}
