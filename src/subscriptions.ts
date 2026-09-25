/**
 * The subscription engine: the one thing the HTTP routes call, the one thing the
 * settings page reads, and the source of truth for the bodies of subscribed
 * entries.
 *
 * It owns no global state of its own. Sources come from the resolved settings
 * document, proxy and mirror come from the same place, and the index it rewrites
 * is handed back to the plugin through {@link SubscriptionHost.setEntries}, so
 * the plugin stays the only writer of its own namespace.
 *
 * @module @lolkda/dsh-prompt-manager/subscriptions
 */

import { createFetcher, type ProxyConfig } from './net.js'
import { stemOf, type PromptSource } from './source.js'
import {
  applyChanges,
  checkSource,
  CheckError,
  revertChanges,
  SourceWorkspace,
  titleFor,
  type CheckOutcome,
  type PlannedChange,
} from './sync.js'
import type { PromptEntry } from './entries.js'

/** One source as the settings page sees it. */
export interface SourceSummary {
  /** Slug. */
  id: string
  /** `owner/name`. */
  repo: string
  /** Branch, tag, or commit. */
  ref: string
  /** Effective mirror, with the global default already folded in. */
  mirror: string
  /** Whether the source takes part in a check, an apply, or a revert. */
  enabled: boolean
  /** When its files were last applied. */
  appliedAt?: string
  /** Commit in force. */
  headSha?: string
  /** Bodies in force. */
  files: number
  /** Files a previous check staged and nobody applied yet. */
  pending: number
}

/** Where a subscribed entry's body lives. */
export interface SubscriptionLocation {
  /** Owning source. */
  slug: string
  /** Repository-relative path. */
  path: string
}

/** What the engine needs from the plugin. */
export interface SubscriptionHost {
  /** Sources in force, already narrowed from the settings document. */
  sources(): PromptSource[]
  /** Global proxy. */
  proxy(): ProxyConfig
  /** Global mirror, used when a source does not set its own. */
  mirror(): string
  /** The plugin's storage root. */
  root(): string
  /** The index in force. */
  entries(): PromptEntry[]
  /** Replace the index's entry list. */
  setEntries(entries: PromptEntry[]): Promise<void>
  /** The next free placement for an added entry. */
  nextOrder(): number
  /** Report a non-fatal problem. */
  warn(message: string): void
}

/** The result of applying a staged plan. */
export interface ApplyOutcome {
  /** Source slug. */
  slug: string
  /** Changes that landed. */
  applied: PlannedChange[]
  /** The index after the apply. */
  entries: PromptEntry[]
}

/** The subscription engine. */
export class Subscriptions {
  private readonly host: SubscriptionHost

  /** How one source's workspace is built; replaced in tests. */
  private readonly workspaceOf: (slug: string) => SourceWorkspace

  /**
   * Where the subscribed bodies were last found.
   *
   * Section text is resolved on every assembly, so `readBody` runs once per
   * subscribed entry per model step. Rebuilding this map each time would re-read
   * and re-parse every source's `state.json` in that hot path, so it is computed
   * once and dropped whenever the files or the source list can have changed.
   */
  private cachedLocations: Map<string, SubscriptionLocation> | undefined

  /**
   * @param host - the plugin side of the engine.
   * @param options - workspace factory, for tests that count what the engine reads.
   */
  constructor(host: SubscriptionHost, options: { workspace?: (slug: string) => SourceWorkspace } = {}) {
    this.host = host
    this.workspaceOf = options.workspace ?? ((slug) => new SourceWorkspace(this.host.root(), slug))
  }

  /**
   * The workspace of one source.
   * @param slug - source id.
   * @returns its file workspace.
   */
  workspace(slug: string): SourceWorkspace {
    return this.workspaceOf(slug)
  }

  /**
   * Where every subscribed entry's body lives.
   * @returns entry id → source and path, for the entries on disk.
   */
  locate(): Map<string, SubscriptionLocation> {
    this.cachedLocations ??= this.computeLocations()
    return this.cachedLocations
  }

  /**
   * Forget the cached map and read the sources again.
   *
   * Called when the source list changed, or after this engine moved files, so
   * the map never describes a snapshot that has already been replaced.
   *
   * @returns the freshly computed map.
   */
  refreshLocations(): Map<string, SubscriptionLocation> {
    this.cachedLocations = undefined
    return this.locate()
  }

  /**
   * Read one subscribed entry's body.
   * @param id - entry id.
   * @returns the body, or `undefined` when it is not a subscribed entry.
   */
  readBody(id: string): string | undefined {
    const location = this.locate().get(id)
    if (location === undefined) return undefined
    return this.workspace(location.slug).read('current', location.path)
  }

  /** Build the location map from every source's bookkeeping. */
  private computeLocations(): Map<string, SubscriptionLocation> {
    const located = new Map<string, SubscriptionLocation>()
    for (const source of this.host.sources()) {
      const state = this.workspace(source.id).readState()
      for (const [path, file] of Object.entries(state.files)) {
        located.set(file.id, { slug: source.id, path })
      }
    }
    return located
  }

  /**
   * The configured sources with their on-disk situation.
   * @returns one summary per source.
   */
  list(): SourceSummary[] {
    return this.host.sources().map((source) => {
      const workspace = this.workspace(source.id)
      const state = workspace.readState()
      const plan = workspace.readPlan()
      const summary: SourceSummary = {
        id: source.id,
        repo: source.repo,
        ref: source.ref,
        mirror: this.effectiveMirror(source),
        enabled: source.enabled,
        files: Object.keys(state.files).length,
        pending: plan === undefined ? 0 : plan.changes.length,
      }
      if (state.appliedAt !== undefined) summary.appliedAt = state.appliedAt
      if (state.headSha !== undefined) summary.headSha = state.headSha
      return summary
    })
  }

  /**
   * Check one source against its upstream and stage whatever changed.
   * @param slug - source id.
   * @returns the check outcome, tagged with its source.
   * @throws {CheckError} when the source is unknown, switched off, or the check cannot conclude.
   */
  async check(slug: string): Promise<CheckOutcome & { slug: string }> {
    const source = this.writableSource(slug)
    const outcome = await checkSource({
      source,
      workspace: this.workspace(slug),
      fetcher: createFetcher({ proxy: this.host.proxy(), mirror: this.effectiveMirror(source) }),
    })
    return { ...outcome, slug }
  }

  /**
   * Apply what a check staged.
   * @param slug - source id.
   * @param files - paths to apply; all staged changes when omitted.
   * @returns what landed and the index that resulted.
   * @throws {CheckError} when nothing is staged for this source.
   */
  async apply(slug: string, files?: readonly string[]): Promise<ApplyOutcome> {
    const source = this.writableSource(slug)
    const workspace = this.workspace(slug)
    const plan = workspace.readPlan()
    if (plan === undefined) throw new CheckError('nothing-staged', `${slug} はまだ確認されていません。先に「更新を確認」を押してください`)
    const state = workspace.readState()
    const next = applyChanges({
      workspace,
      state,
      plan,
      source,
      ...(files === undefined ? {} : { selected: files }),
      nowIso: new Date().toISOString(),
    })
    workspace.writeState(next.state)
    workspace.clearStaging()
    this.cachedLocations = undefined
    const entries = await this.syncEntries()
    return { slug, applied: next.applied, entries }
  }

  /**
   * Put back the version the last apply replaced.
   * @param slug - source id.
   * @returns the paths that moved back and the index that resulted.
   */
  async revert(slug: string): Promise<{ slug: string; reverted: string[]; entries: PromptEntry[] }> {
    this.writableSource(slug)
    const workspace = this.workspace(slug)
    const next = revertChanges({ workspace, state: workspace.readState() })
    workspace.writeState(next.state)
    workspace.clearStaging()
    this.cachedLocations = undefined
    const entries = await this.syncEntries()
    return { slug, reverted: next.reverted, entries }
  }

  /**
   * Forget one source: its files and its entries.
   *
   * A source that is switched off can still be forgotten: removing it is exactly
   * what a person does with one they no longer want.
   *
   * @param slug - source id.
   * @returns the index that resulted.
   */
  async remove(slug: string): Promise<{ slug: string; entries: PromptEntry[] }> {
    this.workspace(slug).remove()
    this.cachedLocations = undefined
    const entries = await this.syncEntries()
    return { slug, entries }
  }

  /**
   * Rebuild the index's subscribed half from every source's state.
   *
   * Local entries are carried through untouched. A subscribed entry keeps the
   * title, placement, and switch a person gave it; an entry seen for the first
   * time arrives disabled, because remote prose must not reach the prompt before
   * someone turns it on.
   *
   * @returns the index now in force.
   */
  async syncEntries(): Promise<PromptEntry[]> {
    const current = this.host.entries()
    const previous = new Map(current.filter((entry) => entry.source !== undefined).map((entry) => [entry.id, entry]))
    const locals = current.filter((entry) => entry.source === undefined)
    const subscribed: PromptEntry[] = []
    let order = this.host.nextOrder()
    for (const source of this.host.sources()) {
      const state = this.workspace(source.id).readState()
      for (const [path, file] of Object.entries(state.files)) {
        // What this file was called before, when the last apply changed its id:
        // a manifest that started declaring its own `id`, or a rename. The title,
        // placement, and switch a person gave the old id belong to the entry that
        // is still this prompt, so they move with it rather than starting over.
        const history = file.renamedFromId === undefined ? undefined : previous.get(file.renamedFromId)
        const known = previous.get(file.id) ?? history
        // `file` here is the state record, so the manifest path is `path`.
        const title = known?.title ?? file.title ?? titleFor(source, { file: path })
        const placement = known?.order ?? file.order ?? order
        if (known === undefined && file.order === undefined) order += 10
        subscribed.push({
          id: file.id,
          title: title.length > 0 ? title : stemOf(path),
          order: placement,
          enabled: known?.enabled ?? false,
          source: source.id,
        })
      }
    }
    const next = [...locals, ...subscribed]
    if (JSON.stringify(next) !== JSON.stringify(current)) await this.host.setEntries(next)
    return next
  }
  /**
   * The mirror actually used for one source.
   * @param source - the source.
   * @returns its own mirror, or the global one.
   */
  private effectiveMirror(source: PromptSource): string {
    return source.mirror.length > 0 ? source.mirror : this.host.mirror()
  }

  /**
   * Look one source up.
   * @param slug - source id.
   * @returns the source.
   * @throws {CheckError} when no such source is configured.
   */
  private source(slug: string): PromptSource {
    const found = this.host.sources().find((candidate) => candidate.id === slug)
    if (found === undefined) throw new CheckError('unknown-source', `このサブスクライブソースはありません：${slug}`)
    return found
  }

  /**
   * Look up a source that may be operated on.
   *
   * A switched-off source keeps the bodies it already applied — turning it off
   * is not a way to erase entries that are in force — but it takes no new work
   * from upstream until it is switched back on.
   *
   * @param slug - source id.
   * @returns the source.
   * @throws {CheckError} when no such source is configured, or it is switched off.
   */
  private writableSource(slug: string): PromptSource {
    const source = this.source(slug)
    if (!source.enabled) {
      throw new CheckError('disabled', `${slug} は無効です。設定ページで有効化するか削除してから、アップストリームに対する操作を行ってください`)
    }
    return source
  }
}
