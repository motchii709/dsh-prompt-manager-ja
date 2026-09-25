#!/usr/bin/env node
/**
 * Boot acceptance: does a cold boot of a real profile actually serve this
 * plugin's settings namespace?
 *
 * The unit tests can inject the failures they need, but nothing in them mounts
 * the plugin through DSH's own Loader — and the bug this checks for only exists
 * there. On 0.1.7-rc.1 the Loader imports every entry concurrently, and a
 * settings namespace exists only for an entry whose `fiber.runtime.Config` the
 * settings service can project. When that goes wrong the plugin still mounts,
 * still answers its own HTTP routes, and still looks healthy: only the namespace
 * is missing, which is why the whole thing has to be checked against a real boot.
 *
 * It runs against a COPY of the profile in a throwaway home, on a free port, so
 * the deployment under test keeps running and its state is never touched. The
 * browser cookie is obtained the way a browser gets it — by exchanging the launch
 * token the child prints — so no credential file is read.
 *
 * Usage:
 *   node tools/check-boot-acceptance.mjs
 * Environment:
 *   DSH_BIN   dsh executable (default: `dsh` from PATH)
 *   DSH_HOME  harness home holding the profile (default: $DSH_HOME, else ~/.dsh)
 *   DSH_PROFILE  profile name (default: web)
 *
 * @module @lolkda/dsh-prompt-manager/tools/check-boot-acceptance
 */

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Settings namespace this plugin's entry must be served under. */
const NAMESPACE = 'prompt-manager'

/** How long a cold boot may take before the check gives up, in milliseconds. */
const BOOT_TIMEOUT_MS = 120_000

/** How long one request may take, in milliseconds. */
const REQUEST_TIMEOUT_MS = 20_000

const BIN = process.env.DSH_BIN ?? 'dsh'
const PROFILE = process.env.DSH_PROFILE ?? 'web'
const HOME = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')

/**
 * Ask the OS for a free port.
 * @returns the port number.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : undefined
      server.close(() => (port === undefined ? reject(new Error('no port')) : resolve(port)))
    })
  })
}

/**
 * POST one Client Remote call and return its result.
 * @param base - the instance origin.
 * @param cookie - the browser session cookie.
 * @param endpoint - `<namespace>/<method>` endpoint.
 * @param args - named wire arguments.
 * @returns the decoded result envelope.
 */
async function call(base, cookie, endpoint, args) {
  const rpcId = `acceptance-${String(Date.now())}`
  const response = await fetch(`${base}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${endpoint} answered HTTP ${String(response.status)}: ${text.slice(0, 200)}`)
  const decoded = JSON.parse(text)
  if (decoded.rpcId !== rpcId) throw new Error(`${endpoint} answered another request`)
  return decoded.result
}

/**
 * Wait for the child's startup line, then exchange its token for a cookie.
 * @param base - the instance origin.
 * @param token - the launch token the child printed.
 * @returns the cookie header value.
 */
async function cookieFor(base, token) {
  const response = await fetch(`${base}/?token=${encodeURIComponent(token)}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const header = response.headers.getSetCookie().find((value) => value.startsWith('dsh-auth-'))
  if (header === undefined) throw new Error('the index exchange issued no browser session cookie')
  return header.split(';', 1)[0]
}

/**
 * Boot a copy of the profile and check what the running instance serves.
 * @returns after the check, with the process stopped either way.
 */
async function main() {
  const source = join(HOME, 'profiles', PROFILE)
  if (!existsSync(source)) {
    console.error(`check-boot-acceptance: no profile at ${source}; set DSH_HOME or DSH_PROFILE`)
    process.exit(2)
  }
  const home = mkdtempSync(join(tmpdir(), 'prompt-manager-acceptance-'))
  cpSync(source, join(home, 'profiles', PROFILE), { recursive: true, dereference: true })
  const port = await freePort()
  const base = `http://127.0.0.1:${String(port)}`
  const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
  delete env['DSH_SESSION_ID']
  delete env['DSH_WEB_URL']
  const child = spawn(BIN, ['--profile', PROFILE, '--host', '127.0.0.1', '--port', String(port), '--no-open'], {
    cwd: home,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += String(chunk) })
  child.stderr.on('data', (chunk) => { output += String(chunk) })
  try {
    const deadline = Date.now() + BOOT_TIMEOUT_MS
    let token
    while (token === undefined) {
      const match = /[?&]token=([A-Za-z0-9_-]+)/.exec(output)
      if (match !== null) token = match[1]
      else if (Date.now() > deadline) throw new Error(`no launch token within ${String(BOOT_TIMEOUT_MS)} ms; output was:\n${output.slice(-2000)}`)
      else if (child.exitCode !== null) throw new Error(`the child exited with ${String(child.exitCode)}; output was:\n${output.slice(-2000)}`)
      else await new Promise((resolve) => setTimeout(resolve, 250))
    }
    const cookie = await cookieFor(base, token)
    const described = await call(base, cookie, 'settings/describe', {})
    const namespaces = (described?.value?.namespaces ?? []).map((entry) => entry.ns)
    if (!namespaces.includes(NAMESPACE)) {
      console.error(`check-boot-acceptance: FAIL ${NAMESPACE} is not served; the boot serves ${JSON.stringify(namespaces)}`)
      process.exitCode = 1
      return
    }
    // A served namespace also has to accept writes: the refusal this bug produced
    // was "No configurable plugin entry", which the field check below distinguishes.
    const refused = await call(base, cookie, 'settings/update', { ns: NAMESPACE, patch: { __acceptance__: 1 } })
    const message = String(refused?.error?.message ?? '')
    if (!message.includes('__acceptance__')) {
      console.error(`check-boot-acceptance: FAIL ${NAMESPACE} refused the probe for the wrong reason: ${message}`)
      process.exitCode = 1
      return
    }
    console.log(`check-boot-acceptance: ok — ${NAMESPACE} is served and its writes are validated (${String(namespaces.length)} namespaces)`)
  } finally {
    child.kill('SIGTERM')
    await new Promise((resolve) => child.once('exit', resolve))
    rmSync(home, { recursive: true, force: true })
  }
}

await main()
