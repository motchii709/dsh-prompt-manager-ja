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
/** Default per-request timeout, in milliseconds. */
export declare const DEFAULT_TIMEOUT_MS = 10000;
/** How a request reaches the network. */
export interface ProxyConfig {
    /** `none` | `http` | `socks5`; anything else is treated as `none`. */
    kind: string;
    /** Proxy URL, e.g. `http://127.0.0.1:7890` or `socks5://127.0.0.1:1080`. */
    url: string;
}
/** A completed request that reached a server. */
export interface TextResponse {
    /** HTTP status code. */
    status: number;
    /** Response body, empty for `304`. */
    text: string;
    /** `etag` header, when the server sent one. */
    etag: string | undefined;
    /** `content-type` header, when the server sent one. */
    contentType: string | undefined;
}
/** A request that never reached a usable response. */
export declare class FetchFailure extends Error {
    /** Machine-readable reason. */
    readonly reason: 'timeout' | 'network' | 'too-large' | 'no-undici';
    /**
     * @param reason - machine-readable reason.
     * @param message - human-facing detail.
     */
    constructor(reason: FetchFailure['reason'], message: string);
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
    get(url: string, options?: {
        etag?: string | undefined;
        timeoutMs?: number;
    }): Promise<TextResponse>;
}
/**
 * Build the fetcher for one proxy configuration.
 *
 * @param config - proxy kind and URL, plus the effective mirror.
 * @returns the fetcher; failures are reported per request, not at construction.
 */
export declare function createFetcher(config: {
    proxy: ProxyConfig;
    mirror: string;
}): Fetcher;
/**
 * Whether a response looks like an HTML error page rather than the file asked
 * for. Mirrors and captive portals answer 200 with a page when they cannot
 * reach the upstream, and staging that page as a prompt would be worse than
 * failing.
 *
 * @param response - the response to judge.
 * @returns `true` when the body is HTML.
 */
export declare function looksLikeHtml(response: TextResponse): boolean;
//# sourceMappingURL=net.d.ts.map