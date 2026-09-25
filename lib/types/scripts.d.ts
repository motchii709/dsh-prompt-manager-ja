/**
 * User-authored scripts that supply prompt variables.
 *
 * One script is one file under `scripts/`, run as a child process, and one JSON
 * object printed on stdout: its keys become the `{{name}}` references the
 * prompt can use. A script therefore declares its own variables — there is no
 * second place to register a name — and one script can supply many.
 *
 * Execution is deliberately out of process. A provider is evaluated
 * synchronously for every assembly, so nothing that costs a subprocess can live
 * there; more to the point, user code that hangs or crashes must not be able to
 * take the host down with it. A run is bounded by a timeout, its output is
 * bounded by a size cap, and every failure is a report rather than a throw.
 *
 * A script's values are cached after every successful run, so a profile start
 * never has to execute anything to keep the prompt rendering the values it saw
 * last: the cache is read synchronously at mount, and changed scripts are
 * picked up by a refresh that runs behind the mount.
 *
 * @module @lolkda/dsh-prompt-manager/scripts
 */
import { type ProbeRun, type ProbeTexts } from './probe.js';
/** Directory name, under the plugin's storage root, holding the scripts. */
export declare const SCRIPTS_DIR_NAME = "scripts";
/** Extension every script file carries. */
export declare const SCRIPT_EXTENSION = ".js";
/** Largest accepted script, in bytes. */
export declare const MAX_SCRIPT_BYTES: number;
/** At most this many scripts may live in the directory. */
export declare const MAX_SCRIPTS = 20;
/** At most this many variables may come from one script. */
export declare const MAX_SCRIPT_VARIABLES = 64;
/** Per-run timeout, used when a script's override sets none. */
export declare const DEFAULT_SCRIPT_TIMEOUT_MS = 3000;
/** Largest amount of output read back from one run, in bytes. */
export declare const MAX_SCRIPT_OUTPUT: number;
/** Default interpreter. An override replaces it, e.g. `python`. */
export declare const DEFAULT_SCRIPT_COMMAND = "node";
/** Placeholder an override's `args` may carry for the script's own path. */
export declare const SCRIPT_PLACEHOLDER = "{script}";
/** Bookkeeping file beside the scripts; dot-prefixed so no scan ever sees it. */
export declare const SCRIPT_STATE_FILE = ".state.json";
/** What a composition may override about one script's execution. */
export interface ScriptOverride {
    /** Interpreter to run; defaults to {@link DEFAULT_SCRIPT_COMMAND}. */
    command?: string | undefined;
    /** Arguments; `{script}` becomes the script's absolute path. */
    args?: string[] | undefined;
    /** Timeout for this script alone, in milliseconds. */
    timeoutMs?: number | undefined;
}
/** One resolved execution, ready for a runner. */
export interface ScriptSpec {
    /** Interpreter name or absolute path. */
    command: string;
    /** Arguments, with the script's path already substituted in. */
    args: string[];
    /** Timeout for this run. */
    timeoutMs: number;
}
/** Runs one script. Replaced in tests, so no interpreter is needed. */
export type ScriptRunner = (spec: ScriptSpec, options: {
    cwd: string;
    name: string;
}) => Promise<ProbeRun>;
/** One script's cached result, as persisted beside the scripts. */
export interface ScriptRecord {
    /** sha1 of the script source that produced {@link ScriptRecord.variables}. */
    sha1: string;
    /** When the successful run happened, ISO-8601. */
    ranAt: string;
    /** Wall time of that run, in milliseconds. */
    ms: number;
    /** Exit code of that run, when it had one. */
    exitCode?: number | undefined;
    /** Variables it supplied, as registered. */
    variables: Record<string, string>;
    /** Why the most recent run after that one failed, when it did. */
    error?: string | undefined;
}
/** Every script's bookkeeping, keyed by script name. */
export type ScriptState = Record<string, ScriptRecord>;
/** One script as the settings page sees it. */
export interface ScriptSummary {
    /** Script name, which is also the file stem. */
    name: string;
    /** sha1 of the file on disk now, or `null` when it cannot be read. */
    sha1: string | null;
    /** Variables the last successful run supplied. */
    variables: string[];
    /** When that run happened. */
    ranAt?: string | undefined;
    /** Its exit code. */
    exitCode?: number | undefined;
    /** Its wall time, in milliseconds. */
    ms?: number | undefined;
    /** Why the most recent attempt failed, when it did. */
    error?: string | undefined;
    /** The file changed since the cached run, so its values are stale. */
    pending: boolean;
}
/** What one run produced. */
export interface ScriptRunReport {
    /** Script name; a draft run reports the name it was tested under. */
    name: string;
    /** Whether the run produced a usable variable set. */
    ok: boolean;
    /** Exit code, when the process ran. */
    exitCode: number | undefined;
    /** Wall time, in milliseconds. */
    ms: number;
    /** The variables the run supplies, when it succeeded. */
    variables: Record<string, string>;
    /** Variables whose value was cut to {@link MAX_PROBE_VALUE} characters. */
    truncated: string[];
    /** Everything that made the run unusable, in the order it was discovered. */
    problems: string[];
    /** Things worth showing that did not make the run unusable. */
    warnings: string[];
    /** Standard output, trimmed to a readable head for the page. */
    stdout: string;
    /** Standard error, trimmed to a readable tail for the page. */
    stderr: string;
}
/** Why a script operation was refused. */
export type ScriptErrorReason = 
/** The name is not a usable script name. */
'invalid-name'
/** The source does not parse, or is too large. */
 | 'invalid-source'
/** The script ran but produced no usable variable set. */
 | 'invalid-output'
/** A variable name it wants belongs to something else. */
 | 'conflict'
/** Too many scripts, or too many variables from one. */
 | 'too-many'
/** The script file is not there. */
 | 'unknown-script';
/** A script operation the caller should report, not retry blindly. */
export declare class ScriptError extends Error {
    /** Machine-readable reason. */
    readonly reason: ScriptErrorReason;
    /** The run report, when the refusal came from running something. */
    readonly report: ScriptRunReport | undefined;
    /**
     * @param reason - machine-readable reason.
     * @param message - human-facing detail.
     * @param report - the run that produced the refusal, when there was one.
     */
    constructor(reason: ScriptErrorReason, message: string, report?: ScriptRunReport);
}
/** What the script engine needs from the plugin. */
export interface ScriptHost {
    /** Absolute directory holding `<name>.js`. */
    dir(): string;
    /** Per-script overrides, from composition config. */
    overrides(): Record<string, ScriptOverride>;
    /** Placeholder texts a value falls back to. */
    texts(): ProbeTexts;
    /**
     * Offer one variable to the prompt registry.
     * @param name - the `{{name}}` reference.
     * @param value - the value to serve; never empty.
     * @param detail - owning script name.
     * @returns `assigned` when this script already owns the name, `declared` when
     * it was free, `conflict` when another owner has it.
     */
    declare(name: string, value: string, detail: string): 'assigned' | 'declared' | 'conflict';
    /**
     * Who owns a variable name right now.
     * @param name - the `{{name}}` reference.
     * @returns the owning script name, or `undefined` when the name is free.
     */
    owner(name: string): string | undefined;
    /**
     * Whether any active entry still writes one reference.
     *
     * Letting go of a script means keeping its variables — a value that is not
     * there makes every section referencing it fail to assemble — but only a
     * reference justifies that, and this is how the engine knows whether there is
     * one.
     *
     * @param name - the `{{name}}` reference.
     * @returns `true` when some entry still writes that reference.
     */
    referenced(name: string): boolean;
    /**
     * Drop a variable this engine declared.
     *
     * Called for a variable nothing references any more, so the prompt stops
     * carrying a value whose script is gone. A name that has since moved to
     * another owner is left alone: only `<detail>`'s own declaration is dropped.
     *
     * @param name - the `{{name}}` reference.
     * @param detail - the script that declared it.
     */
    forget(name: string, detail: string): void;
    /** Report a non-fatal problem. */
    warn(message: string): void;
}
/**
 * Run one script and collect both streams.
 *
 * `spawn` rather than a synchronous runner, because a save or a test run is
 * driven by a click and must not block the host's event loop for the length of
 * the timeout. The timeout is enforced here, so a script that never exits is
 * killed and reported as a timeout rather than held open.
 *
 * @param spec - resolved interpreter, arguments, and timeout.
 * @param options - working directory, which is the script directory.
 * @returns the normalized run.
 */
export declare const defaultScriptRunner: ScriptRunner;
/**
 * Resolve one script's execution from its override.
 *
 * An override with no `command` keeps the default interpreter; one that names a
 * command replaces both the command and the arguments, with `{script}`
 * substituted for the script's path — appended when the override does not
 * mention the placeholder at all.
 *
 * @param scriptPath - absolute path of the script file.
 * @param override - the script's configured override, when it has one.
 * @returns the resolved spec.
 */
export declare function resolveSpec(scriptPath: string, override: ScriptOverride | undefined): ScriptSpec;
/**
 * Accept the `scripts` config value in whatever shape a composition delivers.
 *
 * Reports rather than throws: a malformed override is a composition mistake the
 * caller fails the mount over, but the caller is the one that knows the mount is
 * still happening.
 *
 * @param raw - the config value.
 * @returns the usable overrides, plus one problem message per dropped entry.
 */
export declare function normalizeScriptOverrides(raw: unknown): {
    overrides: Record<string, ScriptOverride>;
    problems: string[];
};
/**
 * Whether a script's source parses.
 *
 * Compiling is not running: `new vm.Script()` reports a syntax error and
 * executes nothing, which is what makes it safe to call on a draft.
 *
 * @param source - the script text.
 * @returns the parser's complaint, or `undefined` when it is fine.
 */
export declare function checkSyntax(source: string): string | undefined;
/**
 * Turn one script's output into the variables it supplies.
 *
 * The output must be a flat JSON object; its keys are the variable names. A
 * string is used as it stands, a finite number is stringified, and anything
 * else is refused — a value that is not text cannot be interpolated into a
 * prompt, and refusing it here is better than discovering it at assembly.
 *
 * @param raw - the script's standard output.
 * @param texts - placeholder used for a value that came out empty.
 * @returns the variables, plus every reason the output is unusable.
 */
export declare function parseScriptOutput(raw: string, texts?: ProbeTexts): {
    variables: Record<string, string>;
    truncated: string[];
    problems: string[];
};
/**
 * Read the bookkeeping beside the scripts.
 * @param dir - the script directory.
 * @returns one record per script; an unreadable or malformed file reads as empty.
 */
export declare function readScriptState(dir: string): ScriptState;
/**
 * Persist the bookkeeping.
 * @param dir - the script directory.
 * @param state - the state to write.
 */
export declare function writeScriptState(dir: string, state: ScriptState): void;
/**
 * Remove draft files this module left behind, so an interrupted run cannot
 * accumulate files in a directory a person reads.
 * @param dir - the script directory.
 */
export declare function cleanDrafts(dir: string): void;
/** The script engine: on-disk scripts, their runs, and their values. */
export declare class PromptScripts {
    private readonly host;
    /** `<root>/scripts`, from the plugin's resolved storage root. */
    private readonly store;
    /** How one script is executed; replaced in tests. */
    private readonly runner;
    /** Keep a run from writing its values into a prompt that has been torn down. */
    private disposed;
    /**
     * @param host - the plugin side of the engine.
     * @param options - the process runner; the real one by default.
     */
    constructor(host: ScriptHost, options?: {
        run?: ScriptRunner | undefined;
    });
    /** Absolute directory holding the scripts. */
    get dir(): string;
    /** Stop accepting run results. */
    dispose(): void;
    /**
     * Script names present on disk, in directory order.
     * @returns the names, capped at {@link MAX_SCRIPTS}.
     */
    names(): string[];
    /**
     * Read one script's source.
     *
     * A lookup answers `undefined` rather than throwing: an unusable name is a
     * script that is not there, and a file that cannot be read is reported and
     * skipped, so neither can turn a page refresh into a failed request.
     *
     * @param name - script name.
     * @returns the source and its hash, or `undefined` when there is no readable file.
     */
    read(name: string): {
        source: string;
        sha1: string;
    } | undefined;
    /**
     * The scripts as the settings page sees them.
     * @returns one summary per script on disk.
     */
    list(): ScriptSummary[];
    /**
     * Declare the values cached for every script whose file has not changed.
     *
     * Called at mount, synchronously, so a profile start serves the values it saw
     * last without executing anything. A script with no cache, or one whose file
     * changed while the profile was down, is left to {@link refresh}.
     *
     * @returns the names that still need a run.
     */
    mountDeclare(): string[];
    /**
     * Run every named script, or every script on disk, and publish the values.
     * @param names - scripts to run; all of them when omitted.
     * @returns one report per script, in the order they were run.
     */
    refresh(names?: readonly string[]): Promise<ScriptRunReport[]>;
    /**
     * Run one script from disk and publish whatever it supplies.
     * @param name - script name.
     * @returns the run report.
     * @throws {ScriptError} when the script does not exist.
     */
    run(name: string): Promise<ScriptRunReport>;
    /**
     * Run a draft without touching the disk, the cache, or the prompt.
     *
     * This is the test button: the run is the same code path a saved script takes,
     * so what it reports is what saving would produce — but nothing is registered,
     * which is what makes it safe to try things out.
     *
     * @param name - the name the draft is being written under.
     * @param source - the draft's source.
     * @returns the run report.
     * @throws {ScriptError} when the name or the source is unusable.
     */
    runSource(name: string, source: string): Promise<ScriptRunReport>;
    /**
     * Validate a draft, run it, and only then put it in place.
     *
     * Nothing is written until the script has produced a usable variable set and
     * no name it wants is taken by something else, so a broken or conflicting
     * script never becomes a file.
     *
     * @param name - script name.
     * @param source - the source to save.
     * @param fence - what the caller expects to find on disk.
     * @returns the variables that are now in force, and the run that produced them.
     * @throws {ScriptError} on any refusal, carrying the run report when there was one.
     */
    save(name: string, source: string, fence: {
        kind: 'absent';
    } | {
        kind: 'sha1';
        sha1: string;
    } | {
        kind: 'any';
    }): Promise<{
        name: string;
        sha1: string;
        variables: Record<string, string>;
        report: ScriptRunReport;
    }>;
    /**
     * Forget one script: its file and its cache entry.
     *
     * A variable an entry still references stays declared, frozen at the value it
     * last held: a missing value would make every section that references it fail
     * to assemble. One that nothing references is dropped outright — keeping it
     * would leave the variables page showing a value for a script that is gone,
     * which is what made a deleted script look undeletable.
     *
     * @param name - script name.
     * @returns `true` when a file was removed.
     */
    remove(name: string): boolean;
    /**
     * Drop the cache entries and variables of scripts that are no longer on disk.
     * @param onDisk - script names currently on disk.
     */
    private reconcile;
    /**
     * Let go of what one script supplied, keeping whatever is still referenced.
     * @param name - the script that is gone.
     * @param record - its cache entry, when it had one.
     */
    private release;
    /**
     * Record a successful run: its values reach the registry, its summary reaches
     * the cache.
     * @param name - owning script.
     * @param sha1 - hash of the source that produced the values.
     * @param report - the run that succeeded.
     */
    private recordSuccess;
    /**
     * Record a failed run.
     *
     * The values from the last success stay in force: a variable with no value
     * would make every section referencing it fail to assemble, so a broken run
     * costs the error message and nothing else. The hash of the success those
     * values belong to is kept too, so the script still reads as needing a run.
     *
     * @param name - owning script.
     * @param error - why the run failed.
     */
    private recordFailure;
    /**
     * Publish one variable, reporting a name another owner already holds.
     * @param name - owning script.
     * @param variable - the `{{name}}` reference.
     * @param value - the value to serve.
     */
    private apply;
    /**
     * Execute a source without writing it: a draft file is used so that the script
     * sees a real path, a real `__dirname`, and a real working directory, which is
     * what makes a test run the same thing as a saved run.
     *
     * @param name - script name, for the report.
     * @param source - the source to run.
     * @param draft - whether to run from a throwaway file.
     * @returns the report, never a throw for a script-level failure.
     */
    private execute;
}
//# sourceMappingURL=scripts.d.ts.map