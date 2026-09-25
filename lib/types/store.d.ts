/**
 * The on-disk half of the prompt index: one markdown file per entry under a
 * single directory, addressed by entry id.
 *
 * Everything a caller can name is validated before it reaches the filesystem —
 * the id grammar is the only path segment this store ever accepts — and writes
 * land through a temporary file plus a rename, so a crashed or interrupted
 * write cannot leave a half-written body in the prompt.
 *
 * @module @lolkda/dsh-prompt-manager/store
 */
/** Why a store operation was refused. */
export type PromptStoreErrorCode = 'invalid-id' | 'too-large' | 'conflict' | 'unwritable' | 'unreadable';
/** A store operation the caller should report, not retry blindly. */
export declare class PromptStoreError extends Error {
    /** Machine-readable reason. */
    readonly code: PromptStoreErrorCode;
    /**
     * @param code - machine-readable reason.
     * @param message - human-facing detail.
     */
    constructor(code: PromptStoreErrorCode, message: string);
}
/** What a write expects to find on disk. */
export type WriteFence = 
/** Overwrite whatever is there. */
{
    readonly kind: 'any';
}
/** Refuse unless this entry has no body file yet. */
 | {
    readonly kind: 'absent';
}
/** Refuse unless the current body still hashes to `sha1`. */
 | {
    readonly kind: 'sha1';
    readonly sha1: string;
};
/** One stored body plus the hash a later write can fence against. */
export interface StoredBody {
    /** Exact UTF-8 contents. */
    body: string;
    /** sha1 of {@link body}, the fence value for the next write. */
    sha1: string;
}
/** The store's current situation, as reported to the settings page. */
export interface StoreStatus {
    /** Absolute directory holding the body files. */
    dir: string;
    /** Whether a body can be written right now. */
    writable: boolean;
    /** Ids that currently have a body file. */
    ids: string[];
}
/**
 * sha1 of one body, the value the settings page round-trips to fence writes.
 * @param body - exact UTF-8 contents.
 * @returns a lowercase hex digest.
 */
export declare function bodyHash(body: string): string;
/** What one store holds: the file shape and the size a body may reach. */
export interface PromptStoreOptions {
    /** File extension, leading dot included. Defaults to `.md`. */
    extension?: string | undefined;
    /** Largest accepted body, in bytes. Defaults to {@link MAX_BODY_BYTES}. */
    maxBytes?: number | undefined;
}
/**
 * Body files for prompt entries, confined to one directory.
 *
 * The same guards back the user-script directory, where `id` is a script name
 * and the file is `<name>.js`: one id grammar, one fence, one atomic write.
 */
export declare class PromptStore {
    /** Absolute directory holding the body files. */
    readonly dir: string;
    /** File extension the store owns, leading dot included. */
    private readonly extension;
    /** Largest body this store accepts, in bytes. */
    private readonly maxBytes;
    /**
     * @param dir - directory holding `<id><extension>`; created on first write.
     * @param options - file extension and size cap; the prompt-body defaults are
     * `.md` at 256 KiB, so the script store reuses every guard below unchanged.
     */
    constructor(dir: string, options?: PromptStoreOptions);
    /**
     * Absolute path of one entry's body file.
     * @param id - entry id; validated against the id grammar.
     * @returns the absolute file path.
     * @throws {PromptStoreError} when the id is unusable or escapes {@link dir}.
     */
    bodyPath(id: string): string;
    /**
     * Whether a body file exists.
     * @param id - entry id.
     * @returns `true` when the file is present.
     */
    has(id: string): boolean;
    /**
     * Read one stored body.
     * @param id - entry id.
     * @returns the body and its hash, or `undefined` when no file exists.
     * @throws {PromptStoreError} when the file exists but cannot be read.
     */
    read(id: string): StoredBody | undefined;
    /**
     * Write one body, refusing a stale editor.
     *
     * The fence is judged against the file as it stands when the write reaches
     * the disk, so two editors holding the same draft cannot both land.
     *
     * @param id - entry id.
     * @param body - exact UTF-8 contents to store.
     * @param fence - what the caller expects to find; defaults to overwriting.
     * @returns the hash of what was written.
     * @throws {PromptStoreError} on an invalid id, oversized body, fence mismatch, or failed write.
     */
    write(id: string, body: string, fence?: WriteFence): StoredBody;
    /**
     * Remove one stored body, which restores the bundled default.
     * @param id - entry id.
     * @returns `true` when a file was removed.
     * @throws {PromptStoreError} when the removal fails.
     */
    remove(id: string): boolean;
    /**
     * The directory's situation, for the settings page.
     * @returns the directory, whether writing is possible, and the stored ids.
     */
    status(): StoreStatus;
    /**
     * Ids that currently have a body file.
     * @returns the stored ids, in directory order; empty when the directory is absent.
     */
    ids(): string[];
    /** Create {@link dir} when it is missing. */
    private ensureDirectory;
}
//# sourceMappingURL=store.d.ts.map