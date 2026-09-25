/**
 * The plugin's only outbound path.
 *
 * Two things can happen to a request here: it can be routed through a proxy —
 * `http(s)` via undici's `ProxyAgent`, `socks5` via undici's own
 * `Socks5ProxyAgent`, so no new dependency enters the package — or its URL can
 * be rewritten for a prefix mirror. A request with neither goes out on the
 * default fetch, which already carries whatever proxy the harness launcher
 * installed from the environment.
 *
 * Mirrors are applied to `raw.githubusercontent.com` only. The commits feed on
 * `github.com` stays direct: that host is reachable from this deployment and a
 * mirror's routing table is not ours to assume.
 *
 * @module @lolkda/dsh-prompt-manager/net
 */

import { createRequire } from 'node:module'
import { withMirror } from './source.js'

/** Largest response body read, in bytes. */
const READ_LIMIT = 1024 * 1024

/** Default per-request timeout, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 10_000

/** How a request reaches the network. */
export interface ProxyConfig {
  /** `none` | `http` | `socks5`; anything else is treated as `none`. */
  kind: string
  /** Proxy URL, e.g. `http://127.0.0.1:7890` or `socks5://127.0.0.1:1080`. */
  url: string
}

/** A completed request that reached a server. */
export interface TextResponse {
  /** HTTP status code. */
  status: number
  /** Response body, empty for `304`. */
  text: string
  /** `etag` header, when the server sent one. */
  etag: string | undefined
  /** `content-type` header, when the server sent one. */
  contentType: string | undefined
}

/** A request that never reached a usable response. */
export class FetchFailure extends Error {
  /** Machine-readable reason. */
  readonly reason: 'timeout' | 'network' | 'too-large' | 'no-undici'

  /**
   * @param reason - machine-readable reason.
   * @param message - human-facing detail.
   */
  constructor(reason: FetchFailure['reason'], message: string) {
    super(message)
    this.name = 'FetchFailure'
    this.reason = reason
  }
}

/** The reader slice of a response body stream. */
interface BodyReader {
  /** Next chunk, or a `done` marker. */
  read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>
  /** Give up on the rest of the stream. */
  cancel(): Promise<void>
}

/** The slice of undici this module uses. */
interface UndiciLike {
  fetch: (url: string, init?: Record<string, unknown>) => Promise<{
    status: number
    headers: { get(name: string): string | null }
    text(): Promise<string>
    /** Present on every real fetch; absent only in a hand-rolled stand-in. */
    body?: { getReader(): BodyReader } | null | undefined
  }>
  ProxyAgent: new (uri: string) => unknown
  Socks5ProxyAgent?: new (uri: string) => unknown
}

/** The response slice the bounded reader needs. */
type StreamedResponse = Awaited<ReturnType<UndiciLike['fetch']>>

/**
 * Read a response body, refusing anything past {@link READ_LIMIT}.
 *
 * The cap is enforced while reading, not after: a mirror — or an upstream file —
 * that answers with something enormous must not be able to make the host hold
 * all of it in memory first.
 *
 * @param response - the response to read.
 * @param target - the URL, for the failure message.
 * @returns the body text.
 * @throws {FetchFailure} when the body exceeds the cap.
 */
async function readBounded(response: StreamedResponse, target: string): Promise<string> {
  const body = response.body
  if (body === undefined || body === null) {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > READ_LIMIT) {
      throw new FetchFailure('too-large', `${target}: response exceeds ${String(READ_LIMIT)} bytes`)
    }
    return text
  }
  const reader = body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    size += value.byteLength
    if (size > READ_LIMIT) {
      await reader.cancel().catch(() => undefined)
      throw new FetchFailure('too-large', `${target}: response exceeds ${String(READ_LIMIT)} bytes`)
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** One request path, with its dispatcher already decided. */
export interface Fetcher {
  /**
   * Fetch one URL, optionally conditionally.
   * @param url - absolute upstream URL.
   * @param options - conditional validator and timeout.
   * @returns the response, whatever its status.
   * @throws {FetchFailure} when the request never produced a response.
   */
  get(url: string, options?: { etag?: string | undefined; timeoutMs?: number }): Promise<TextResponse>
}

/**
 * Load undici through the profile's own module tree.
 * @returns the module, or `undefined` when it cannot be resolved.
 */
function loadUndici(): UndiciLike | undefined {
  try {
    const loaded: unknown = createRequire(import.meta.url)('undici')
    const candidate = typeof loaded === 'object' && loaded !== null && typeof (loaded as UndiciLike).fetch === 'function'
      ? loaded as UndiciLike
      : undefined
    return candidate
  } catch {
    return undefined
  }
}

/**
 * Whether a URL is one a mirror is allowed to rewrite.
 * @param url - the absolute upstream URL.
 * @returns `true` for raw-content URLs.
 */
function mirrorable(url: string): boolean {
  return url.startsWith('https://raw.githubusercontent.com/')
}

/**
 * Build the fetcher for one proxy configuration.
 *
 * @param config - proxy kind and URL, plus the effective mirror.
 * @returns the fetcher; failures are reported per request, not at construction.
 */
export function createFetcher(config: { proxy: ProxyConfig; mirror: string }): Fetcher {
  const kind = config.proxy.kind === 'http' || config.proxy.kind === 'socks5' ? config.proxy.kind : 'none'
  const proxyUrl = config.proxy.url.trim()
  const wanted = kind !== 'none' && proxyUrl.length > 0
  let dispatcher: unknown
  let failure: FetchFailure | undefined

  if (wanted) {
    const undici = loadUndici()
    if (undici === undefined) {
      failure = new FetchFailure('no-undici', 'this deployment has no resolvable undici, so a proxy cannot be used')
    } else if (kind === 'http') {
      dispatcher = new undici.ProxyAgent(proxyUrl)
    } else if (typeof undici.Socks5ProxyAgent === 'function') {
      dispatcher = new undici.Socks5ProxyAgent(proxyUrl)
    } else {
      failure = new FetchFailure('no-undici', 'this deployment\'s undici has no Socks5ProxyAgent, so a SOCKS5 proxy cannot be used')
    }
  }

  return {
    async get(url, options = {}) {
      if (failure !== undefined) throw failure
      const target = mirrorable(url) ? withMirror(config.mirror, url) : url
      const headers: Record<string, string> = { 'user-agent': '@lolkda/dsh-prompt-manager' }
      if (options.etag !== undefined && options.etag.length > 0) headers['if-none-match'] = options.etag
      const undici = dispatcher === undefined ? undefined : loadUndici()
      const init: Record<string, unknown> = {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      }
      if (dispatcher !== undefined && undici !== undefined) init['dispatcher'] = dispatcher
      let response: Awaited<ReturnType<UndiciLike['fetch']>>
      try {
        response = undici === undefined
          ? await fetch(target, init) as unknown as Awaited<ReturnType<UndiciLike['fetch']>>
          : await undici.fetch(target, init)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
        throw new FetchFailure(timedOut ? 'timeout' : 'network', `${target}: ${message}`)
      }
      const etag = response.headers.get('etag') ?? undefined
      const contentType = response.headers.get('content-type') ?? undefined
      if (response.status === 304) return { status: 304, text: '', etag, contentType }
      const text = await readBounded(response, target)
      return { status: response.status, text, etag, contentType }
    },
  }
}

/**
 * Whether a response looks like an HTML error page rather than the file asked
 * for. Mirrors and captive portals answer 200 with a page when they cannot
 * reach the upstream, and staging that page as a prompt would be worse than
 * failing.
 *
 * @param response - the response to judge.
 * @returns `true` when the body is HTML.
 */
export function looksLikeHtml(response: TextResponse): boolean {
  const contentType = (response.contentType ?? '').toLowerCase()
  if (contentType.includes('text/html')) return true
  const head = response.text.slice(0, 256).trimStart().toLowerCase()
  return head.startsWith('<!doctype html') || head.startsWith('<html')
}
