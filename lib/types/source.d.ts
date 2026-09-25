/**
 * Subscription sources: where a prompt set comes from, and what the repository
 * manifest says is inside it.
 *
 * Everything in this module is pure: string and JSON work only. The network
 * lives in `net.ts`, the files and their history live in `sync.ts`, and the two
 * are joined by the engine in `subscriptions.ts`.
 *
 * @module @lolkda/dsh-prompt-manager/source
 */
/** Manifest every subscribed repository must carry at its root. */
export declare const MANIFEST_FILE = "prompt-manager.json";
/** Largest manifest accepted, in bytes. */
export declare const MAX_MANIFEST_BYTES: number;
/** Largest single prompt body accepted, in bytes. Mirrors the store's limit. */
export declare const MAX_FILE_BYTES: number;
/** At most this many prompts may come from one source. */
export declare const MAX_SOURCE_FILES = 50;
/** At most this many sources may be configured. */
export declare const MAX_SOURCES = 20;
/** One prompt declared by a repository manifest. */
export interface ManifestPrompt {
    /** Repository-relative path of the markdown body. */
    file: string;
    /** Id stem; defaults to the file name. */
    id?: string;
    /** Display title; defaults to the manifest id or file stem. */
    title?: string;
    /** Default placement; defaults to the importer's next free slot. */
    order?: number;
    /** Default enabled state; the importer overrides this to `false` on import. */
    enabled?: boolean;
}
/** A configured subscription source. */
export interface PromptSource {
    /** Local slug: entry-id prefix, workspace directory name. */
    id: string;
    /** `owner/name`. */
    repo: string;
    /** Branch, tag, or commit sha. */
    ref: string;
    /** URL-prefix mirror; empty means inherit the global one. */
    mirror: string;
    /** Whether this source takes part in a check. */
    enabled: boolean;
}
/** A manifest that cannot be used, with the reason a person needs. */
export declare class ManifestError extends Error {
    /** Machine-readable reason. */
    readonly reason: 'not-json' | 'not-object' | 'no-prompts' | 'bad-entry' | 'too-large' | 'too-many';
    /**
     * @param reason - machine-readable reason.
     * @param message - human-facing detail.
     */
    constructor(reason: ManifestError['reason'], message: string);
}
/**
 * Whether a value is a usable `owner/name`.
 * @param value - candidate repository.
 * @returns `true` when the shape is acceptable.
 */
export declare function isRepo(value: unknown): value is string;
/**
 * Whether a value is a usable ref. Path-shaped refs (`release/notes`) are
 * allowed; anything with `..`, a leading dash, or a scheme is not.
 * @param value - candidate ref.
 * @returns `true` when the shape is acceptable.
 */
export declare function isRef(value: unknown): value is string;
/**
 * Whether a value is a usable source slug.
 * @param value - candidate slug.
 * @returns `true` when the shape is acceptable.
 */
export declare function isSourceId(value: unknown): value is string;
/**
 * Derive a source slug from `owner/name`.
 * @param repo - a validated `owner/name`.
 * @returns a lowercase, hyphenated slug.
 */
export declare function sourceSlug(repo: string): string;
/**
 * The id stem of one manifest file: its basename without the extension.
 * @param file - repository-relative path.
 * @returns a lowercase slug.
 */
export declare function stemOf(file: string): string;
/**
 * The local entry id a manifest file becomes.
 *
 * The id is capped at {@link MAX_ID_LENGTH}, so the source half gives up exactly
 * the room its stem needs. Truncating the tail instead would collapse every file
 * of a long-named source onto one id, and the index would silently keep only the
 * first of them.
 *
 * @param sourceId - owning source slug.
 * @param file - repository-relative path.
 * @returns `<sourceId>-<stem>`, within the entry-id grammar.
 */
export declare function entryIdFor(sourceId: string, file: string): string;
/**
 * The local entry id one stem becomes.
 *
 * Kept separate from {@link entryIdFor} because a manifest may declare the stem
 * itself: `id` is the file's identity, not a label, so a file may be renamed in
 * the repository while its local entry — and every preset naming it — stays put.
 *
 * @param sourceId - owning source slug.
 * @param stem - declared id, or a file's own stem.
 * @returns `<sourceId>-<stem>`, within the entry-id grammar.
 */
export declare function entryIdForStem(sourceId: string, stem: string): string;
/**
 * The entry id one manifest prompt becomes, its own declaration first.
 *
 * @param sourceId - owning source slug.
 * @param prompt - the manifest entry.
 * @returns the local entry id.
 */
export declare function entryIdForPrompt(sourceId: string, prompt: ManifestPrompt): string;
/**
 * Validate and normalize a repository manifest.
 *
 * The manifest is untrusted input from the internet: every field is checked,
 * unknown fields are dropped, and a manifest that declares nothing usable is
 * refused rather than silently producing an empty import.
 *
 * @param raw - parsed JSON from the repository.
 * @returns the usable prompts, in manifest order.
 * @throws {ManifestError} when the manifest cannot be used at all.
 */
export declare function parseManifest(raw: unknown): ManifestPrompt[];
/**
 * Normalize a URL-prefix mirror. Only an absolute `https` origin (plus an
 * optional path) is accepted, with no query, fragment, or credentials — the
 * same bar the market plugin applies to its `githubProxy`.
 * @param value - the configured value.
 * @returns the normalized mirror, or `undefined` when it is unusable.
 */
export declare function normalizeMirror(value: unknown): string | undefined;
/**
 * Rewrite an upstream URL for a mirror.
 *
 * Both shapes are accepted so an existing configuration keeps working: a
 * template containing `{url}` gets the URL substituted, and anything else is
 * treated as a prefix, giving `<prefix>/<url>` — exactly what the market plugin
 * writes into its `githubProxy`.
 *
 * @param mirror - normalized mirror; empty means no rewrite.
 * @param url - the absolute upstream URL.
 * @returns the URL to request.
 */
export declare function withMirror(mirror: string, url: string): string;
/**
 * The raw-content URL of one repository file.
 * @param repo - `owner/name`.
 * @param ref - branch, tag, or commit.
 * @param file - repository-relative path.
 * @returns an absolute `raw.githubusercontent.com` URL.
 */
export declare function rawUrl(repo: string, ref: string, file: string): string;
/**
 * The commits feed that carries a branch's head sha without spending API quota.
 * @param repo - `owner/name`.
 * @param ref - branch name.
 * @returns an absolute `github.com` atom URL.
 */
export declare function headAtomUrl(repo: string, ref: string): string;
/**
 * Read the newest commit sha out of a commits atom feed.
 * @param atom - the feed's XML.
 * @returns the sha, or `undefined` when the feed does not carry one.
 */
export declare function parseHeadSha(atom: string): string | undefined;
/**
 * Whether a ref is worth probing for changes: a branch moves, a tag or commit
 * does not.
 * @param ref - the configured ref.
 * @returns `true` when the ref should be probed.
 */
export declare function isMovableRef(ref: string): boolean;
/**
 * Narrow one settings value into a source, dropping unknown fields.
 * @param raw - a candidate from the `sources` array.
 * @returns the source, or `undefined` when it is unusable.
 */
export declare function parseSource(raw: unknown): PromptSource | undefined;
/**
 * Narrow a settings value into a source list, dropping unusable entries.
 * @param raw - the resolved `sources` field.
 * @returns the usable sources, capped at {@link MAX_SOURCES}.
 */
export declare function parseSources(raw: unknown): PromptSource[];
//# sourceMappingURL=source.d.ts.map