#!/usr/bin/env node
/**
 * Network test: the one outbound path.
 *
 * A local HTTP server plays the mirror, so the rewrite rule, the conditional
 * request, the non-raw passthrough, the HTML detection, and the failure
 * classification are all exercised without touching the internet.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { createFetcher, FetchFailure, looksLikeHtml } from '../lib/net.js'

/** Paths the fake mirror answered, so the rewrite can be asserted. */
const seen = []

/** Body served for the conditional-request case. */
const BODY = '# Title\n\nbody\n'

const server = createServer((request, response) => {
  const url = request.url ?? '/'
  seen.push({ url, etag: request.headers['if-none-match'] })
  if (url.endsWith('/slow')) return
  if (url.endsWith('/missing.md')) {
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('not found')
    return
  }
  if (url.endsWith('/page.md')) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><html><body>captcha</body></html>')
    return
  }
  if (url.endsWith('/huge.md')) {
    response.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' })
    // Two megabytes, written in chunks so the reader has to stop early.
    const chunk = 'x'.repeat(64 * 1024)
    for (let written = 0; written < 32; written += 1) response.write(chunk)
    response.end()
    return
  }
  if (url.endsWith('/conditional.md') && request.headers['if-none-match'] === '"v1"') {
    response.writeHead(304, { etag: '"v1"' })
    response.end()
    return
  }
  response.writeHead(200, { etag: '"v1"', 'content-type': 'text/markdown; charset=utf-8' })
  response.end(BODY)
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const mirror = `http://127.0.0.1:${String(port)}`
const raw = `https://raw.githubusercontent.com/o/r/main/prompts/conditional.md`

try {
  const fetcher = createFetcher({ proxy: { kind: 'none', url: '' }, mirror })

  // ── the mirror rewrite ───────────────────────────────────────────────────────

  const first = await fetcher.get(raw, { timeoutMs: 4000 })
  assert.equal(first.status, 200, 'a mirrored request answers')
  assert.equal(first.text, BODY, 'the body comes back untouched')
  assert.equal(first.etag, '"v1"', 'the validator is carried')
  assert.equal(seen[0].url, `/${raw}`, 'a raw URL is rewritten to <mirror>/<url>')
  assert.equal(looksLikeHtml(first), false, 'markdown is not mistaken for a page')

  // ── conditional requests ─────────────────────────────────────────────────────

  const cached = await fetcher.get(raw, { etag: '"v1"', timeoutMs: 4000 })
  assert.equal(cached.status, 304, 'a matching validator answers 304')
  assert.equal(cached.text, '', 'a 304 carries no body')
  assert.equal(seen[1].etag, '"v1"', 'the validator is sent as If-None-Match')

  // ── non-raw URLs stay direct ─────────────────────────────────────────────────

  const direct = await fetcher.get(`http://127.0.0.1:${String(port)}/direct`, { timeoutMs: 4000 })
  assert.equal(direct.status, 200, 'a non-raw URL is fetched as-is')
  assert.equal(seen.at(-1).url, '/direct', 'only raw URLs are rewritten')

  // ── statuses and pages ───────────────────────────────────────────────────────

  const missing = await fetcher.get(`https://raw.githubusercontent.com/o/r/main/prompts/missing.md`, { timeoutMs: 4000 })
  assert.equal(missing.status, 404, 'a missing file answers 404 rather than throwing')

  const page = await fetcher.get(`https://raw.githubusercontent.com/o/r/main/prompts/page.md`, { timeoutMs: 4000 })
  assert.equal(page.status, 200, 'the mirror answered')
  assert.ok(looksLikeHtml(page), 'an HTML answer is recognised so it is never staged as a prompt')

  // ── failures ─────────────────────────────────────────────────────────────────

  await assert.rejects(
    fetcher.get(`https://raw.githubusercontent.com/o/r/main/prompts/huge.md`, { timeoutMs: 4000 }),
    (error) => error instanceof FetchFailure && error.reason === 'too-large',
    'a body past the read cap is refused while reading it, not after holding it',
  )

  await assert.rejects(
    createFetcher({ proxy: { kind: 'none', url: '' }, mirror: 'http://127.0.0.1:1' })
      .get(raw, { timeoutMs: 1500 }),
    (error) => error instanceof FetchFailure && error.reason === 'network',
    'an unreachable mirror is a network failure',
  )

  await assert.rejects(
    fetcher.get(`https://raw.githubusercontent.com/o/r/main/prompts/slow`, { timeoutMs: 200 }),
    (error) => error instanceof FetchFailure && error.reason === 'timeout',
    'a stalled response is a timeout, not a hang',
  )

  await assert.rejects(
    createFetcher({ proxy: { kind: 'http', url: 'http://127.0.0.1:1' }, mirror: '' })
      .get(raw, { timeoutMs: 1500 }),
    (error) => error instanceof FetchFailure,
    'an unreachable HTTP proxy fails loudly instead of going direct',
  )

  const socks = createFetcher({ proxy: { kind: 'socks5', url: 'socks5://127.0.0.1:1' }, mirror: '' })
  await assert.rejects(
    socks.get(raw, { timeoutMs: 1500 }),
    (error) => error instanceof FetchFailure,
    'an unreachable SOCKS5 proxy fails loudly too',
  )

  console.log('net ok')
  console.log(`  mirror      raw URLs become <mirror>/<url>; other hosts stay direct`)
  console.log('  conditional 200 with an etag, then 304 for the same validator')
  console.log('  content     markdown passes, an HTML captcha page is recognised')
  console.log('  cap         a body past 1 MiB is refused while it is being read')
  console.log('  failures    unreachable mirror, timeout, unreachable http and socks5 proxies')
} finally {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
