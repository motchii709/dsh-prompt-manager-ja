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

import { MAX_ID_LENGTH } from './entries.js'

/** Manifest every subscribed repository must carry at its root. */
export const MANIFEST_FILE = 'prompt-manager.json'

/** Largest manifest accepted, in bytes. */
export const MAX_MANIFEST_BYTES = 64 * 1024

/** Largest single prompt body accepted, in bytes. Mirrors the store's limit. */
export const MAX_FILE_BYTES = 256 * 1024

/** At most this many prompts may come from one source. */
export const MAX_SOURCE_FILES = 50

/** At most this many sources may be configured. */
export const MAX_SOURCES = 20

/** `owner/name` as GitHub writes it. */
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

/** A branch, tag, or commit sha: no spaces, no traversal, no scheme. */
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/

/** Source ids reuse the entry-id grammar: lowercase, hyphenated, path-safe. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/** One prompt declared by a repository manifest. */
export interface ManifestPrompt {
  /** Repository-relative path of the markdown body. */
  file: string
  /** Id stem; defaults to the file name. */
  id?: string
  /** Display title; defaults to the manifest id or file stem. */
  title?: string
  /** Default placement; defaults to the importer's next free slot. */
  order?: number
  /** Default enabled state; the importer overrides this to `false` on import. */
  enabled?: boolean
}

/** A configured subscription source. */
export interface PromptSource {
  /** Local slug: entry-id prefix, workspace directory name. */
  id: string
  /** `owner/name`. */
  repo: string
  /** Branch, tag, or commit sha. */
  ref: string
  /** URL-prefix mirror; empty means inherit the global one. */
  mirror: string
  /** Whether this source takes part in a check. */
  enabled: boolean
}

/** A manifest that cannot be used, with the reason a person needs. */
export class ManifestError extends Error {
  /** Machine-readable reason. */
  readonly reason: 'not-json' | 'not-object' | 'no-prompts' | 'bad-entry' | 'too-large' | 'too-many'

  /**
   * @param reason - machine-readable reason.
   * @param message - human-facing detail.
   */
  constructor(reason: ManifestError['reason'], message: string) {
    super(message)
    this.name = 'ManifestError'
    this.reason = reason
  }
}

/**
 * Whether a value is a usable `owner/name`.
 * @param value - candidate repository.
 * @returns `true` when the shape is acceptable.
 */
export function isRepo(value: unknown): value is string {
  return typeof value === 'string' && REPO_PATTERN.test(value)
}

/**
 * Whether a value is a usable ref. Path-shaped refs (`release/notes`) are
 * allowed; anything with `..`, a leading dash, or a scheme is not.
 * @param value - candidate ref.
 * @returns `true` when the shape is acceptable.
 */
export function isRef(value: unknown): value is string {
  if (typeof value !== 'string' || !REF_PATTERN.test(value)) return false
  return !value.includes('..')
}

/**
 * Whether a value is a usable source slug.
 * @param value - candidate slug.
 * @returns `true` when the shape is acceptable.
 */
export function isSourceId(value: unknown): value is string {
  return typeof value === 'string' && SLUG_PATTERN.test(value)
}

/**
 * Derive a source slug from `owner/name`.
 * @param repo - a validated `owner/name`.
 * @returns a lowercase, hyphenated slug.
 */
export function sourceSlug(repo: string): string {
  const slug = repo.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return SLUG_PATTERN.test(slug) ? slug.slice(0, 64) : 'source'
}

/**
 * The id stem of one manifest file: its basename without the extension.
 * @param file - repository-relative path.
 * @returns a lowercase slug.
 */
export function stemOf(file: string): string {
  const base = file.split('/').at(-1) ?? file
  const stem = base.replace(/\.md$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return stem.length > 0 ? stem.slice(0, 48) : 'prompt'
}

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
export function entryIdFor(sourceId: string, file: string): string {
  return entryIdForStem(sourceId, stemOf(file))
}

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
export function entryIdForStem(sourceId: string, stem: string): string {
  const clean = stem.length > 0 ? stem.slice(0, 48) : 'prompt'
  return `${sourceId.slice(0, MAX_ID_LENGTH - clean.length - 1)}-${clean}`
}

/**
 * The entry id one manifest prompt becomes, its own declaration first.
 *
 * @param sourceId - owning source slug.
 * @param prompt - the manifest entry.
 * @returns the local entry id.
 */
export function entryIdForPrompt(sourceId: string, prompt: ManifestPrompt): string {
  return prompt.id === undefined ? entryIdFor(sourceId, prompt.file) : entryIdForStem(sourceId, prompt.id)
}

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
export function parseManifest(raw: unknown): ManifestPrompt[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ManifestError('not-object', 'manifest must be a JSON object')
  }
  const list = (raw as Record<string, unknown>)['prompts']
  if (!Array.isArray(list)) throw new ManifestError('no-prompts', 'manifest must carry a "prompts" array')
  if (list.length === 0) throw new ManifestError('no-prompts', 'manifest declares no prompts')
  if (list.length > MAX_SOURCE_FILES) {
    throw new ManifestError('too-many', `manifest declares ${String(list.length)} prompts; the limit is ${String(MAX_SOURCE_FILES)}`)
  }
  const prompts: ManifestPrompt[] = []
  const seen = new Set<string>()
  for (const candidate of list) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      throw new ManifestError('bad-entry', 'every manifest prompt must be an object')
    }
    const record = candidate as Record<string, unknown>
    const file = record['file']
    if (typeof file !== 'string' || file.length === 0 || file.startsWith('/') || file.includes('..') || !file.toLowerCase().endsWith('.md')) {
      throw new ManifestError('bad-entry', `unusable "file" in manifest: ${JSON.stringify(file)}`)
    }
    if (seen.has(file)) throw new ManifestError('bad-entry', `manifest lists ${file} twice`)
    seen.add(file)
    const prompt: ManifestPrompt = { file }
    const id = record['id']
    if (typeof id === 'string' && id.trim().length > 0) prompt.id = stemOf(id.trim())
    const title = record['title']
    if (typeof title === 'string' && title.trim().length > 0) prompt.title = title.trim().slice(0, 120)
    const order = record['order']
    if (typeof order === 'number' && Number.isFinite(order)) prompt.order = order
    const enabled = record['enabled']
    if (typeof enabled === 'boolean') prompt.enabled = enabled
    prompts.push(prompt)
  }
  return prompts
}

/**
 * Normalize a URL-prefix mirror. Only an absolute `https` origin (plus an
 * optional path) is accepted, with no query, fragment, or credentials — the
 * same bar the market plugin applies to its `githubProxy`.
 * @param value - the configured value.
 * @returns the normalized mirror, or `undefined` when it is unusable.
 */
export function normalizeMirror(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return ''
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'https:') return undefined
    if (url.username !== '' || url.password !== '') return undefined
    if (url.search !== '' || url.hash !== '') return undefined
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return undefined
  }
}

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
export function withMirror(mirror: string, url: string): string {
  if (mirror.length === 0) return url
  if (mirror.includes('{url}')) return mirror.split('{url}').join(url)
  return `${mirror}/${url}`
}

/**
 * The raw-content URL of one repository file.
 * @param repo - `owner/name`.
 * @param ref - branch, tag, or commit.
 * @param file - repository-relative path.
 * @returns an absolute `raw.githubusercontent.com` URL.
 */
export function rawUrl(repo: string, ref: string, file: string): string {
  const path = file.split('/').map((segment) => encodeURIComponent(segment)).join('/')
  return `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/${path}`
}

/**
 * The commits feed that carries a branch's head sha without spending API quota.
 * @param repo - `owner/name`.
 * @param ref - branch name.
 * @returns an absolute `github.com` atom URL.
 */
export function headAtomUrl(repo: string, ref: string): string {
  return `https://github.com/${repo}/commits/${encodeURIComponent(ref)}.atom`
}

/**
 * Read the newest commit sha out of a commits atom feed.
 * @param atom - the feed's XML.
 * @returns the sha, or `undefined` when the feed does not carry one.
 */
export function parseHeadSha(atom: string): string | undefined {
  const tagged = /Grit::Commit\/([0-9a-f]{40})/.exec(atom)
  if (tagged?.[1] !== undefined) return tagged[1]
  return /[0-9a-f]{40}/.exec(atom)?.[0]
}

/**
 * Whether a ref is worth probing for changes: a branch moves, a tag or commit
 * does not.
 * @param ref - the configured ref.
 * @returns `true` when the ref should be probed.
 */
export function isMovableRef(ref: string): boolean {
  return !/^[0-9a-f]{40}$/.test(ref)
}

/**
 * Narrow one settings value into a source, dropping unknown fields.
 * @param raw - a candidate from the `sources` array.
 * @returns the source, or `undefined` when it is unusable.
 */
export function parseSource(raw: unknown): PromptSource | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const { id, repo, ref } = record
  if (!isSourceId(id) || !isRepo(repo) || !isRef(ref)) return undefined
  // An absent mirror means "inherit the global one"; a present-but-unusable one
  // means the source itself is unusable.
  const mirror = record['mirror'] === undefined ? '' : normalizeMirror(record['mirror'])
  if (mirror === undefined) return undefined
  return { id, repo, ref, mirror, enabled: record['enabled'] !== false }
}

/**
 * Narrow a settings value into a source list, dropping unusable entries.
 * @param raw - the resolved `sources` field.
 * @returns the usable sources, capped at {@link MAX_SOURCES}.
 */
export function parseSources(raw: unknown): PromptSource[] {
  if (!Array.isArray(raw)) return []
  const sources: PromptSource[] = []
  const seen = new Set<string>()
  for (const candidate of raw) {
    const source = parseSource(candidate)
    if (source === undefined || seen.has(source.id)) continue
    seen.add(source.id)
    sources.push(source)
    if (sources.length >= MAX_SOURCES) break
  }
  return sources
}
