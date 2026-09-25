/**
 * The per-session half of the index: which prompt set and which compaction
 * instruction one session has chosen.
 *
 * The index itself — entries, bodies, presets, subscriptions, the outbound
 * settings — is one document for the whole deployment, because it is a catalog:
 * what a prompt says is not a matter of which conversation reads it. Which of
 * those prompts is *in force* is the opposite kind of fact. It belongs to the
 * conversation, and a switch made in one conversation must not reach another,
 * so it lives here — one file per session — instead of in the settings document
 * every session reads.
 *
 * A session with no file has chosen nothing and therefore gets nothing: no
 * preset (each entry's own switch decides) and no compaction instruction (DSH's
 * own text is sent). Nothing migrates a document's old `activePreset` into a
 * session file: that field stopped deciding anything when this module arrived,
 * and inventing a choice on behalf of a conversation nobody is looking at would
 * be a lie about what that conversation asked for.
 *
 * Every name that reaches the filesystem is validated first, and every write
 * lands through a temporary file plus a rename — the same discipline the body
 * store keeps, for the same reason: an interrupted write must not leave a
 * half-written choice behind for the next assembly to read.
 *
 * @module @lolkda/dsh-prompt-manager/sessions
 */
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isEntryId } from './entries.js';
/** Directory under the store root holding one file per session. */
export const SESSIONS_DIR_NAME = 'sessions';
/**
 * How many sessions may keep a choice.
 *
 * A choice is worth keeping for as long as its conversation matters, and there
 * is no reliable signal for when that stops being true — a session can be
 * archived, deleted, or simply never opened again. A bound plus oldest-first
 * eviction is the honest approximation: the conversations somebody is actually
 * using stay, and the ones that fall off the end are ones whose switch nobody
 * has touched in the longest time.
 */
export const MAX_SESSION_CHOICES = 200;
/**
 * The session ids this store will name a file after.
 *
 * DSH session ids are `session-<uuid>`, and subagent sessions mint their own
 * from the same alphabet. Everything a file name cannot carry — separators, a
 * leading dot, uppercase, non-ASCII — is refused rather than escaped, so no id
 * can address anything but a file inside the store's own directory.
 */
const SESSION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
/** Longest session id accepted, generous for any id DSH mints. */
const MAX_SESSION_ID_LENGTH = 128;
/** A session-choice operation the caller should report rather than retry. */
export class SessionChoiceError extends Error {
    /** Machine-readable reason. */
    code;
    /**
     * @param code - machine-readable reason.
     * @param message - human-facing detail.
     */
    constructor(code, message) {
        super(message);
        this.name = 'SessionChoiceError';
        this.code = code;
    }
}
/** Whether a value can name a session file. */
export function isSessionId(value) {
    return typeof value === 'string'
        && value.length <= MAX_SESSION_ID_LENGTH
        && SESSION_ID_PATTERN.test(value);
}
/** What a session that has chosen nothing gets. */
export const NO_CHOICE = Object.freeze({ preset: '', compaction: '' });
/**
 * One deployment's per-session choices, confined to one directory.
 *
 * Read from disk on every assembly, deliberately, exactly as a prompt body is:
 * a choice file is something a person can open in an editor, and a choice that
 * only took effect after a restart would be a worse answer than one small read
 * per model step.
 */
export class SessionChoices {
    /** Absolute directory holding `<session id>.json`. */
    dir;
    /**
     * @param root - the plugin's store root; choices live in its `sessions/`.
     */
    constructor(root) {
        this.dir = resolve(root, SESSIONS_DIR_NAME);
    }
    /**
     * Absolute path of one session's choice file.
     * @param sessionId - session id; validated against the id grammar.
     * @returns the absolute file path.
     * @throws {SessionChoiceError} when the id is unusable or escapes {@link dir}.
     */
    choicePath(sessionId) {
        if (!isSessionId(sessionId)) {
            throw new SessionChoiceError('invalid-id', `invalid session id ${JSON.stringify(sessionId)}`);
        }
        const file = resolve(this.dir, `${sessionId}.json`);
        if (dirname(file) !== this.dir) {
            throw new SessionChoiceError('invalid-id', `session id ${JSON.stringify(sessionId)} escapes the choices directory`);
        }
        return file;
    }
    /**
     * Whether one session has a choice file.
     * @param sessionId - session id.
     * @returns `true` when the file exists.
     */
    has(sessionId) {
        try {
            return existsSync(this.choicePath(sessionId));
        }
        catch {
            return false;
        }
    }
    /**
     * Read one session's choice.
     *
     * A missing file is not a problem to report: it is how every session starts.
     * A file that cannot be read or parsed is a different matter — that is why it
     * is thrown rather than swallowed, so the caller can say so instead of
     * silently serving a different prompt than the one somebody chose.
     *
     * @param sessionId - session id.
     * @returns the stored choice, or `undefined` when this session chose nothing.
     * @throws {SessionChoiceError} when a file exists but cannot be read or understood.
     */
    read(sessionId) {
        const file = this.choicePath(sessionId);
        if (!existsSync(file))
            return undefined;
        let parsed;
        try {
            parsed = JSON.parse(readFileSync(file, 'utf8'));
        }
        catch (error) {
            throw new SessionChoiceError('unreadable', `cannot read ${file}: ${messageOf(error)}`);
        }
        return narrowChoice(parsed);
    }
    /**
     * The choice in force for one session, answering `undefined` sessions with
     * {@link NO_CHOICE}.
     *
     * Every caller on the assembly path wants this and none of them wants to
     * handle a throw: a conversation that cannot say what it chose gets the same
     * thing a fresh conversation gets, and the caller reports the problem once.
     *
     * @param sessionId - session id, or `undefined` when no session is in view.
     * @returns the choice, never `undefined`.
     */
    effective(sessionId) {
        if (sessionId === undefined || !isSessionId(sessionId))
            return NO_CHOICE;
        try {
            return this.read(sessionId) ?? NO_CHOICE;
        }
        catch {
            return NO_CHOICE;
        }
    }
    /**
     * Write one session's choice, merging over what that session already chose.
     *
     * A field the caller leaves out keeps its current value, because the two chips
     * that write here each own one field and neither should have to read-modify-
     * write the other's.
     *
     * @param sessionId - session id.
     * @param patch - the fields to change.
     * @returns the choice as stored.
     * @throws {SessionChoiceError} on an unusable id, value, or failed write.
     */
    write(sessionId, patch) {
        const file = this.choicePath(sessionId);
        const previous = this.effective(sessionId);
        const next = {
            preset: patch.preset === undefined ? previous.preset : presetValue(patch.preset),
            compaction: patch.compaction === undefined ? previous.compaction : instructionValue(patch.compaction),
        };
        this.ensureDirectory();
        temporaryCounter += 1;
        const temporary = join(this.dir, `.${sessionId}.json.${String(process.pid)}.${String(temporaryCounter)}.tmp`);
        try {
            writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
            renameSync(temporary, file);
        }
        catch (error) {
            try {
                rmSync(temporary, { force: true });
            }
            catch {
                /* best-effort cleanup; the write error is what the caller needs */
            }
            throw new SessionChoiceError('unwritable', `cannot write ${file}: ${messageOf(error)}`);
        }
        this.prune();
        return next;
    }
    /**
     * Forget one session's choice, which puts it back to choosing nothing.
     * @param sessionId - session id.
     * @returns `true` when a file was removed.
     * @throws {SessionChoiceError} when the removal fails.
     */
    clear(sessionId) {
        const file = this.choicePath(sessionId);
        if (!existsSync(file))
            return false;
        try {
            rmSync(file);
            return true;
        }
        catch (error) {
            throw new SessionChoiceError('unwritable', `cannot remove ${file}: ${messageOf(error)}`);
        }
    }
    /**
     * Session ids that currently have a choice.
     * @returns the ids, in directory order; empty when the directory is absent.
     */
    ids() {
        if (!existsSync(this.dir))
            return [];
        try {
            return readdirSync(this.dir)
                .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
                .map((name) => name.slice(0, -'.json'.length))
                .filter((id) => isSessionId(id))
                .sort();
        }
        catch {
            return [];
        }
    }
    /** How many sessions currently have a choice. */
    count() {
        return this.ids().length;
    }
    /**
     * The directory's situation, for the status route.
     * @returns the directory, how many sessions have a choice, and whether writing works.
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
        return { dir: this.dir, count: this.count(), writable };
    }
    /**
     * Drop the oldest choices until at most `keep` remain.
     *
     * Called after every write rather than on a timer: the number of files can
     * only grow on a write, so that is the one moment worth checking, and doing it
     * here means a deployment that stops being used does not keep a background
     * task alive to tidy up after it.
     *
     * @param keep - how many choices to keep, newest first. Defaults to {@link MAX_SESSION_CHOICES}.
     * @returns how many files were removed.
     */
    prune(keep = MAX_SESSION_CHOICES) {
        if (keep < 0)
            return 0;
        let names;
        try {
            names = readdirSync(this.dir).filter((name) => name.endsWith('.json') && !name.startsWith('.'));
        }
        catch {
            return 0;
        }
        if (names.length <= keep)
            return 0;
        const aged = [];
        for (const name of names) {
            try {
                aged.push({ name, at: statSync(join(this.dir, name)).mtimeMs });
            }
            catch {
                /* a file that vanished between listing and stat is already gone */
            }
        }
        aged.sort((left, right) => left.at - right.at);
        let removed = 0;
        for (const entry of aged.slice(0, Math.max(0, aged.length - keep))) {
            try {
                rmSync(join(this.dir, entry.name), { force: true });
                removed += 1;
            }
            catch {
                /* an unremovable file is one over the cap, not a reason to fail a write */
            }
        }
        return removed;
    }
    /** Create {@link dir} when it is missing. */
    ensureDirectory() {
        try {
            mkdirSync(this.dir, { recursive: true });
        }
        catch (error) {
            throw new SessionChoiceError('unwritable', `cannot create ${this.dir}: ${messageOf(error)}`);
        }
    }
}
/** Monotonic suffix keeping concurrent temporary names distinct within one process. */
let temporaryCounter = 0;
/**
 * Narrow one parsed document to a choice, ignoring anything else it carries.
 *
 * A field that is present but unusable reads as "nothing chosen" rather than
 * failing the whole file: the other field is still a real answer, and a prompt
 * set restored from a hand-edited file is better than no prompt set at all.
 *
 * @param raw - the parsed `JSON.parse` result.
 * @returns the narrowed choice.
 */
function narrowChoice(raw) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        return NO_CHOICE;
    const record = raw;
    return {
        preset: presetValue(record['preset']),
        compaction: instructionValue(record['compaction']),
    };
}
/**
 * Narrow one preset field.
 * @param raw - the value as stored or sent.
 * @returns the id, or `''` when it names nothing usable.
 */
function presetValue(raw) {
    return typeof raw === 'string' && (raw === '' || isEntryId(raw)) ? raw : '';
}
/**
 * Narrow one compaction field.
 * @param raw - the value as stored or sent.
 * @returns the id, or `''` (DSH's own instruction) when it names nothing usable.
 */
function instructionValue(raw) {
    return typeof raw === 'string' && (raw === '' || isEntryId(raw)) ? raw : '';
}
/**
 * Message text of an unknown thrown value.
 * @param error - the caught value.
 * @returns a human-facing message.
 */
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=sessions.js.map