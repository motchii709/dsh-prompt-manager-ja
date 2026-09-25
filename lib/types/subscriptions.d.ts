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
import { type ProxyConfig } from './net.js';
import { type PromptSource } from './source.js';
import { SourceWorkspace, type CheckOutcome, type PlannedChange } from './sync.js';
import type { PromptEntry } from './entries.js';
/** One source as the settings page sees it. */
export interface SourceSummary {
    /** Slug. */
    id: string;
    /** `owner/name`. */
    repo: string;
    /** Branch, tag, or commit. */
    ref: string;
    /** Effective mirror, with the global default already folded in. */
    mirror: string;
    /** Whether the source takes part in a check, an apply, or a revert. */
    enabled: boolean;
    /** When its files were last applied. */
    appliedAt?: string;
    /** Commit in force. */
    headSha?: string;
    /** Bodies in force. */
    files: number;
    /** Files a previous check staged and nobody applied yet. */
    pending: number;
}
/** Where a subscribed entry's body lives. */
export interface SubscriptionLocation {
    /** Owning source. */
    slug: string;
    /** Repository-relative path. */
    path: string;
}
/** What the engine needs from the plugin. */
export interface SubscriptionHost {
    /** Sources in force, already narrowed from the settings document. */
    sources(): PromptSource[];
    /** Global proxy. */
    proxy(): ProxyConfig;
    /** Global mirror, used when a source does not set its own. */
    mirror(): string;
    /** The plugin's storage root. */
    root(): string;
    /** The index in force. */
    entries(): PromptEntry[];
    /** Replace the index's entry list. */
    setEntries(entries: PromptEntry[]): Promise<void>;
    /** The next free placement for an added entry. */
    nextOrder(): number;
    /** Report a non-fatal problem. */
    warn(message: string): void;
}
/** The result of applying a staged plan. */
export interface ApplyOutcome {
    /** Source slug. */
    slug: string;
    /** Changes that landed. */
    applied: PlannedChange[];
    /** The index after the apply. */
    entries: PromptEntry[];
}
/** The subscription engine. */
export declare class Subscriptions {
    private readonly host;
    /** How one source's workspace is built; replaced in tests. */
    private readonly workspaceOf;
    /**
     * Where the subscribed bodies were last found.
     *
     * Section text is resolved on every assembly, so `readBody` runs once per
     * subscribed entry per model step. Rebuilding this map each time would re-read
     * and re-parse every source's `state.json` in that hot path, so it is computed
     * once and dropped whenever the files or the source list can have changed.
     */
    private cachedLocations;
    /**
     * @param host - the plugin side of the engine.
     * @param options - workspace factory, for tests that count what the engine reads.
     */
    constructor(host: SubscriptionHost, options?: {
        workspace?: (slug: string) => SourceWorkspace;
    });
    /**
     * The workspace of one source.
     * @param slug - source id.
     * @returns its file workspace.
     */
    workspace(slug: string): SourceWorkspace;
    /**
     * Where every subscribed entry's body lives.
     * @returns entry id → source and path, for the entries on disk.
     */
    locate(): Map<string, SubscriptionLocation>;
    /**
     * Forget the cached map and read the sources again.
     *
     * Called when the source list changed, or after this engine moved files, so
     * the map never describes a snapshot that has already been replaced.
     *
     * @returns the freshly computed map.
     */
    refreshLocations(): Map<string, SubscriptionLocation>;
    /**
     * Read one subscribed entry's body.
     * @param id - entry id.
     * @returns the body, or `undefined` when it is not a subscribed entry.
     */
    readBody(id: string): string | undefined;
    /** Build the location map from every source's bookkeeping. */
    private computeLocations;
    /**
     * The configured sources with their on-disk situation.
     * @returns one summary per source.
     */
    list(): SourceSummary[];
    /**
     * Check one source against its upstream and stage whatever changed.
     * @param slug - source id.
     * @returns the check outcome, tagged with its source.
     * @throws {CheckError} when the source is unknown, switched off, or the check cannot conclude.
     */
    check(slug: string): Promise<CheckOutcome & {
        slug: string;
    }>;
    /**
     * Apply what a check staged.
     * @param slug - source id.
     * @param files - paths to apply; all staged changes when omitted.
     * @returns what landed and the index that resulted.
     * @throws {CheckError} when nothing is staged for this source.
     */
    apply(slug: string, files?: readonly string[]): Promise<ApplyOutcome>;
    /**
     * Put back the version the last apply replaced.
     * @param slug - source id.
     * @returns the paths that moved back and the index that resulted.
     */
    revert(slug: string): Promise<{
        slug: string;
        reverted: string[];
        entries: PromptEntry[];
    }>;
    /**
     * Forget one source: its files and its entries.
     *
     * A source that is switched off can still be forgotten: removing it is exactly
     * what a person does with one they no longer want.
     *
     * @param slug - source id.
     * @returns the index that resulted.
     */
    remove(slug: string): Promise<{
        slug: string;
        entries: PromptEntry[];
    }>;
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
    syncEntries(): Promise<PromptEntry[]>;
    /**
     * The mirror actually used for one source.
     * @param source - the source.
     * @returns its own mirror, or the global one.
     */
    private effectiveMirror;
    /**
     * Look one source up.
     * @param slug - source id.
     * @returns the source.
     * @throws {CheckError} when no such source is configured.
     */
    private source;
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
    private writableSource;
}
//# sourceMappingURL=subscriptions.d.ts.map