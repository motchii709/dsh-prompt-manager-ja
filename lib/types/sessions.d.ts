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
/** Directory under the store root holding one file per session. */
export declare const SESSIONS_DIR_NAME = "sessions";
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
export declare const MAX_SESSION_CHOICES = 200;
/** Why a session-choice operation was refused. */
export type SessionChoiceErrorCode = 'invalid-id' | 'unreadable' | 'unwritable';
/** A session-choice operation the caller should report rather than retry. */
export declare class SessionChoiceError extends Error {
    /** Machine-readable reason. */
    readonly code: SessionChoiceErrorCode;
    /**
     * @param code - machine-readable reason.
     * @param message - human-facing detail.
     */
    constructor(code: SessionChoiceErrorCode, message: string);
}
/** Whether a value can name a session file. */
export declare function isSessionId(value: unknown): value is string;
/** What one session has chosen. Both fields answer "nothing" with `''`. */
export interface SessionChoice {
    /** Preset id in force for this session, or `''` for each entry's own switch. */
    preset: string;
    /** Compaction instruction id for this session, or `''` for DSH's own text. */
    compaction: string;
}
/** What a session that has chosen nothing gets. */
export declare const NO_CHOICE: SessionChoice;
/** One field of a choice, as a caller may write it. */
export interface SessionChoicePatch {
    /** New preset id, or `''` to stop using one. */
    preset?: string;
    /** New compaction instruction id, or `''` for DSH's own text. */
    compaction?: string;
}
/** The store's situation, as reported to the settings page and the status route. */
export interface SessionChoicesStatus {
    /** Absolute directory holding the choice files. */
    dir: string;
    /** How many sessions currently have a file. */
    count: number;
    /** Whether a choice can be written right now. */
    writable: boolean;
}
/**
 * One deployment's per-session choices, confined to one directory.
 *
 * Read from disk on every assembly, deliberately, exactly as a prompt body is:
 * a choice file is something a person can open in an editor, and a choice that
 * only took effect after a restart would be a worse answer than one small read
 * per model step.
 */
export declare class SessionChoices {
    /** Absolute directory holding `<session id>.json`. */
    readonly dir: string;
    /**
     * @param root - the plugin's store root; choices live in its `sessions/`.
     */
    constructor(root: string);
    /**
     * Absolute path of one session's choice file.
     * @param sessionId - session id; validated against the id grammar.
     * @returns the absolute file path.
     * @throws {SessionChoiceError} when the id is unusable or escapes {@link dir}.
     */
    choicePath(sessionId: string): string;
    /**
     * Whether one session has a choice file.
     * @param sessionId - session id.
     * @returns `true` when the file exists.
     */
    has(sessionId: string): boolean;
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
    read(sessionId: string): SessionChoice | undefined;
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
    effective(sessionId: string | undefined): SessionChoice;
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
    write(sessionId: string, patch: SessionChoicePatch): SessionChoice;
    /**
     * Forget one session's choice, which puts it back to choosing nothing.
     * @param sessionId - session id.
     * @returns `true` when a file was removed.
     * @throws {SessionChoiceError} when the removal fails.
     */
    clear(sessionId: string): boolean;
    /**
     * Session ids that currently have a choice.
     * @returns the ids, in directory order; empty when the directory is absent.
     */
    ids(): string[];
    /** How many sessions currently have a choice. */
    count(): number;
    /**
     * The directory's situation, for the status route.
     * @returns the directory, how many sessions have a choice, and whether writing works.
     */
    status(): SessionChoicesStatus;
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
    prune(keep?: number): number;
    /** Create {@link dir} when it is missing. */
    private ensureDirectory;
}
//# sourceMappingURL=sessions.d.ts.map