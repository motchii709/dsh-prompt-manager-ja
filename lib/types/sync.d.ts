/**
 * One source's files on disk, and the three operations the settings page drives:
 * check what changed upstream, apply it, undo the last apply.
 *
 * The layout is a three-slot rotation, so nothing is ever half-updated:
 * `staging/` holds what a check downloaded, `current/` is what the prompt reads,
 * and `previous/` keeps the version the last apply replaced so one click can put
 * it back. `state.json` carries the bookkeeping: which commit is in force, which
 * entry each file became, and the hashes and validators that make the next check
 * cheap.
 *
 * @module @lolkda/dsh-prompt-manager/sync
 */
import { type Fetcher } from './net.js';
import { type ManifestPrompt, type PromptSource } from './source.js';
/** One file's bookkeeping inside a source. */
export interface SourceFileState {
    /** Local entry id this file became. */
    id: string;
    /**
     * The id this file carried before the apply that recorded it, when that apply
     * changed the id — a manifest that started declaring its own `id`, or a file
     * whose name changed. The index reads it to move the title, placement, and
     * switch a person chose onto the new id instead of starting the entry over.
     * Dropped by the next apply of the same path, so it never outlives its use.
     */
    renamedFromId?: string;
    /** Display title the manifest asked for, when it asked for one. */
    title?: string;
    /** Placement the manifest asked for, when it asked for one. */
    order?: number;
    /** Whether the manifest wanted it enabled; the importer overrides on import. */
    enabled: boolean;
    /** sha1 of the body in force. */
    sha1: string;
    /** `etag` the upstream sent for that body. */
    etag?: string;
}
/** A source's bookkeeping, persisted beside its files. */
export interface SourceState {
    /** Ref the snapshot was taken from. */
    ref: string;
    /** Commit in force, when the ref could be resolved to one. */
    headSha?: string;
    /** Commit the last apply replaced, for revert. */
    headShaPrevious?: string;
    /** sha1 of the manifest in force. */
    manifestSha1?: string;
    /** When the last apply ran, ISO-8601. */
    appliedAt?: string;
    /** One record per body file in force, keyed by repository path. */
    files: Record<string, SourceFileState>;
    /**
     * The last apply's undo ledger: the record each touched path had before, or
     * `null` when the path had no file at all. This is what makes revert exact —
     * a removed file comes back with the title, placement, and switch it had.
     */
    undo?: Record<string, SourceFileState | null>;
}
/** One file the upstream check found a difference in. */
export interface PlannedChange {
    /** Repository-relative path. */
    path: string;
    /** Local entry id. */
    id: string;
    /** Display title from the manifest, when present. */
    title?: string;
    /** Placement from the manifest, when present. */
    order?: number;
    /** Which way the file moved. */
    kind: 'added' | 'changed' | 'removed';
    /** Lines the new body has and the old one did not. */
    added: number;
    /** Lines the old body had and the new one does not. */
    removed: number;
    /**
     * On an added file: the path this file was renamed from, when the check
     * recognised it as a rename. The pair is applied together or not at all.
     */
    renamedFrom?: string;
    /**
     * On a removal: the path this file was renamed to. Present exactly when the
     * matching added change carries {@link renamedFrom}.
     */
    renamedTo?: string;
}
/** What a check concluded. */
export interface CheckOutcome {
    /** Whether upstream already matches what is in force. */
    upToDate: boolean;
    /** Commit the ref resolves to, when it could be resolved. */
    headSha?: string;
    /** Files that differ, newest manifest order first. */
    changes: PlannedChange[];
    /** Prompts the manifest declared, in order. */
    prompts: ManifestPrompt[];
    /** Non-fatal problems worth showing: an unreachable feed, a skipped file. */
    warnings: string[];
}
/** What a check left staged, for a later apply to pick up. */
export interface StagedPlan {
    /** Commit the check resolved. */
    headSha?: string;
    /** sha1 of the manifest the check read. */
    manifestSha1: string;
    /** Prompts the manifest declared. */
    prompts: ManifestPrompt[];
    /** Files the check staged. */
    changes: PlannedChange[];
    /** `etag` per staged path, the validator the next check sends. */
    etags: Record<string, string>;
}
/** A check that could not conclude. */
export declare class CheckError extends Error {
    /** Machine-readable reason. */
    readonly reason: 'manifest' | 'network' | 'mirror' | 'too-large' | 'unknown-source' | 'nothing-staged' | 'disabled';
    /**
     * @param reason - machine-readable reason.
     * @param message - human-facing detail.
     */
    constructor(reason: CheckError['reason'], message: string);
}
/** The files of one source, confined to one directory. */
export declare class SourceWorkspace {
    /** Source slug. */
    readonly slug: string;
    /** `<root>/sources/<slug>`. */
    readonly dir: string;
    /**
     * @param root - the plugin's storage root, e.g. `$DSH_HOME/prompt-manager`.
     * @param slug - the source id.
     */
    constructor(root: string, slug: string);
    /** Directory holding the version in force. */
    get currentDir(): string;
    /** Directory holding the version the last apply replaced. */
    get previousDir(): string;
    /** Directory holding what a check downloaded but nobody applied yet. */
    get stagingDir(): string;
    /** Path of the bookkeeping file. */
    get statePath(): string;
    /**
     * Absolute path of one body file inside one slot.
     * @param slot - which slot.
     * @param path - repository-relative manifest path.
     * @returns the absolute path; a traversal attempt resolves to `undefined`.
     */
    slotPath(slot: 'current' | 'previous' | 'staging', path: string): string | undefined;
    /** Whether this source has any files on disk. */
    exists(): boolean;
    /**
     * Read the bookkeeping, defaulting to an empty state.
     * @returns the state; an unreadable or malformed file reads as empty.
     */
    readState(): SourceState;
    /**
     * Persist the bookkeeping.
     * @param state - the state to write.
     */
    writeState(state: SourceState): void;
    /** Read one body from a slot. */
    read(slot: 'current' | 'previous' | 'staging', path: string): string | undefined;
    /** Paths present in a slot, relative to that slot. */
    list(slot: 'current' | 'previous' | 'staging'): string[];
    /** Write one body into the staging slot. */
    stage(path: string, text: string): void;
    /** Empty the staging slot. */
    clearStaging(): void;
    /**
     * Record what a check staged, so an apply can run without repeating the
     * network round trip.
     * @param plan - the staged plan.
     */
    writePlan(plan: StagedPlan): void;
    /**
     * Read the staged plan.
     * @returns the plan, or `undefined` when nothing is staged.
     */
    readPlan(): StagedPlan | undefined;
    /** Remove the whole source directory. */
    remove(): void;
}
/**
 * Line counts of what a change adds and removes, by longest common
 * subsequence over lines. The dynamic table is skipped for pathologically large
 * pairs, where the answer degrades to "roughly how many lines differ" rather
 * than stalling the request.
 *
 * @param before - the body in force, or `''` for a new file.
 * @param after - the checked body.
 * @returns added and removed line counts.
 */
export declare function diffCounts(before: string, after: string): {
    added: number;
    removed: number;
};
/**
 * Check one source against its upstream and stage whatever changed.
 *
 * @param input - source, workspace, and the fetcher carrying the proxy and mirror.
 * @returns what changed, or that nothing did.
 * @throws {CheckError} when the check cannot conclude.
 */
export declare function checkSource(input: {
    source: PromptSource;
    workspace: SourceWorkspace;
    fetcher: Fetcher;
}): Promise<CheckOutcome>;
/**
 * Apply staged changes into the version in force.
 *
 * @param input - workspace, current state, the staged plan, the source, and the
 * paths the caller selected (all of them when omitted).
 * @returns the new state and the changes that landed.
 */
export declare function applyChanges(input: {
    workspace: SourceWorkspace;
    state: SourceState;
    plan: StagedPlan;
    source: PromptSource;
    selected?: readonly string[];
    nowIso: string;
}): {
    state: SourceState;
    applied: PlannedChange[];
};
/**
 * Put the version the last apply replaced back in force, guided by the apply's
 * undo ledger so a restored file also gets its title, placement, and switch back.
 *
 * @param input - workspace and current state.
 * @returns the restored state and the paths that moved back.
 */
export declare function revertChanges(input: {
    workspace: SourceWorkspace;
    state: SourceState;
}): {
    state: SourceState;
    reverted: string[];
};
/**
 * The entry title a manifest file should get on import.
 * @param source - owning source.
 * @param prompt - the manifest entry.
 * @returns a non-empty display title.
 */
export declare function titleFor(source: PromptSource, prompt: ManifestPrompt): string;
//# sourceMappingURL=sync.d.ts.map