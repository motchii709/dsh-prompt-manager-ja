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
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isEntryId, MAX_BODY_BYTES } from './entries.js';
/** Monotonic suffix keeping concurrent temporary names distinct within one process. */
let temporaryCounter = 0;
/** A store operation the caller should report, not retry blindly. */
export class PromptStoreError extends Error {
    /** Machine-readable reason. */
    code;
    /**
     * @param code - machine-readable reason.
     * @param message - human-facing detail.
     */
    constructor(code, message) {
        super(message);
        this.name = 'PromptStoreError';
        this.code = code;
    }
}
/**
 * sha1 of one body, the value the settings page round-trips to fence writes.
 * @param body - exact UTF-8 contents.
 * @returns a lowercase hex digest.
 */
export function bodyHash(body) {
    return createHash('sha1').update(body, 'utf8').digest('hex');
}
/**
 * Body files for prompt entries, confined to one directory.
 *
 * The same guards back the user-script directory, where `id` is a script name
 * and the file is `<name>.js`: one id grammar, one fence, one atomic write.
 */
export class PromptStore {
    /** Absolute directory holding the body files. */
    dir;
    /** File extension the store owns, leading dot included. */
    extension;
    /** Largest body this store accepts, in bytes. */
    maxBytes;
    /**
     * @param dir - directory holding `<id><extension>`; created on first write.
     * @param options - file extension and size cap; the prompt-body defaults are
     * `.md` at 256 KiB, so the script store reuses every guard below unchanged.
     */
    constructor(dir, options = {}) {
        this.dir = resolve(dir);
        this.extension = options.extension ?? '.md';
        this.maxBytes = options.maxBytes ?? MAX_BODY_BYTES;
    }
    /**
     * Absolute path of one entry's body file.
     * @param id - entry id; validated against the id grammar.
     * @returns the absolute file path.
     * @throws {PromptStoreError} when the id is unusable or escapes {@link dir}.
     */
    bodyPath(id) {
        if (!isEntryId(id))
            throw new PromptStoreError('invalid-id', `invalid prompt entry id ${JSON.stringify(id)}`);
        const file = resolve(this.dir, `${id}${this.extension}`);
        if (dirname(file) !== this.dir)
            throw new PromptStoreError('invalid-id', `prompt entry id ${JSON.stringify(id)} escapes the store directory`);
        return file;
    }
    /**
     * Whether a body file exists.
     * @param id - entry id.
     * @returns `true` when the file is present.
     */
    has(id) {
        try {
            return existsSync(this.bodyPath(id));
        }
        catch {
            return false;
        }
    }
    /**
     * Read one stored body.
     * @param id - entry id.
     * @returns the body and its hash, or `undefined` when no file exists.
     * @throws {PromptStoreError} when the file exists but cannot be read.
     */
    read(id) {
        const file = this.bodyPath(id);
        if (!existsSync(file))
            return undefined;
        try {
            const body = readFileSync(file, 'utf8');
            return { body, sha1: bodyHash(body) };
        }
        catch (error) {
            throw new PromptStoreError('unreadable', `cannot read ${file}: ${messageOf(error)}`);
        }
    }
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
    write(id, body, fence = { kind: 'any' }) {
        const file = this.bodyPath(id);
        const size = Buffer.byteLength(body, 'utf8');
        if (size > this.maxBytes) {
            throw new PromptStoreError('too-large', `prompt body is ${String(size)} bytes; the limit is ${String(this.maxBytes)}`);
        }
        if (fence.kind !== 'any') {
            const current = this.read(id);
            if (fence.kind === 'absent' && current !== undefined) {
                throw new PromptStoreError('conflict', `${id}${this.extension} appeared while this draft was open`);
            }
            if (fence.kind === 'sha1' && current?.sha1 !== fence.sha1) {
                throw new PromptStoreError('conflict', `${id}${this.extension} changed on disk while this draft was open`);
            }
        }
        this.ensureDirectory();
        temporaryCounter += 1;
        const temporary = join(this.dir, `.${id}${this.extension}.${String(process.pid)}.${String(temporaryCounter)}.tmp`);
        try {
            writeFileSync(temporary, body, 'utf8');
            renameSync(temporary, file);
        }
        catch (error) {
            try {
                rmSync(temporary, { force: true });
            }
            catch {
                /* the temporary file is best-effort cleanup; the write error is what matters */
            }
            throw new PromptStoreError('unwritable', `cannot write ${file}: ${messageOf(error)}`);
        }
        return { body, sha1: bodyHash(body) };
    }
    /**
     * Remove one stored body, which restores the bundled default.
     * @param id - entry id.
     * @returns `true` when a file was removed.
     * @throws {PromptStoreError} when the removal fails.
     */
    remove(id) {
        const file = this.bodyPath(id);
        if (!existsSync(file))
            return false;
        try {
            rmSync(file);
            return true;
        }
        catch (error) {
            throw new PromptStoreError('unwritable', `cannot remove ${file}: ${messageOf(error)}`);
        }
    }
    /**
     * The directory's situation, for the settings page.
     * @returns the directory, whether writing is possible, and the stored ids.
     */
    status() {
        let writable = false;
        try {
            this.ensureDirectory();
            accessSync(this.dir, constants.W_OK);
            writable = true;
        }
        catch {
            writable = false;
        }
        return { dir: this.dir, writable, ids: this.ids() };
    }
    /**
     * Ids that currently have a body file.
     * @returns the stored ids, in directory order; empty when the directory is absent.
     */
    ids() {
        if (!existsSync(this.dir))
            return [];
        try {
            return readdirSync(this.dir)
                .filter((name) => name.endsWith(this.extension))
                .map((name) => name.slice(0, -this.extension.length))
                .filter((id) => isEntryId(id))
                .sort();
        }
        catch {
            return [];
        }
    }
    /** Create {@link dir} when it is missing. */
    ensureDirectory() {
        try {
            mkdirSync(this.dir, { recursive: true });
        }
        catch (error) {
            throw new PromptStoreError('unwritable', `cannot create ${this.dir}: ${messageOf(error)}`);
        }
    }
}
/**
 * Message text of an unknown thrown value.
 * @param error - the caught value.
 * @returns a human-facing message.
 */
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=store.js.map