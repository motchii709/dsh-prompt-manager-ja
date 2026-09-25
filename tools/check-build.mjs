#!/usr/bin/env node
/**
 * Build-freshness check: the built files must match the sources they came from,
 * and every built file must be tracked.
 *
 * `lib/` is committed, so a clone can be mounted without a toolchain — which
 * also means a commit can ship an `lib/index.js` that imports a `lib/*.js`
 * nobody added. This check rebuilds and then asks git whether the result is
 * exactly what is committed: a stale or half-added build fails here rather than
 * in a profile that cannot start.
 *
 * Run it from the repository root, with git available and a clean index for
 * `lib/`, right before committing.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()

if (!existsSync(join(ROOT, 'tsconfig.json'))) {
  console.error('check-build: run this from the repository root')
  process.exit(1)
}

/** Run one git command and return its stdout. */
function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
}

let tracked
try {
  tracked = git(['status', '--porcelain', '--', 'lib'])
} catch (error) {
  console.error(`check-build: git is not usable here: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}

const lines = tracked.split('\n').filter((line) => line.trim().length > 0)
if (lines.length > 0) {
  console.error('check-build: lib/ does not match what is committed — run `git add lib` and commit it with the source:')
  for (const line of lines) console.error(`  ${line}`)
  process.exit(1)
}

console.log('check-build ok: lib/ is a fresh build of src/ and every file in it is tracked')
