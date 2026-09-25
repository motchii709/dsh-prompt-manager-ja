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
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Script as CompiledScript } from 'node:vm';
import { isEntryId, MAX_ID_LENGTH } from './entries.js';
import { DEFAULT_PROBE_TEXTS, MAX_PROBE_VALUE } from './probe.js';
import { bodyHash, PromptStore, PromptStoreError } from './store.js';
/** Directory name, under the plugin's storage root, holding the scripts. */
export const SCRIPTS_DIR_NAME = 'scripts';
/** Extension every script file carries. */
export const SCRIPT_EXTENSION = '.js';
/** Largest accepted script, in bytes. */
export const MAX_SCRIPT_BYTES = 64 * 1024;
/** At most this many scripts may live in the directory. */
export const MAX_SCRIPTS = 20;
/** At most this many variables may come from one script. */
export const MAX_SCRIPT_VARIABLES = 64;
/** Per-run timeout, used when a script's override sets none. */
export const DEFAULT_SCRIPT_TIMEOUT_MS = 3000;
/** Largest amount of output read back from one run, in bytes. */
export const MAX_SCRIPT_OUTPUT = 64 * 1024;
/** Default interpreter. An override replaces it, e.g. `python`. */
export const DEFAULT_SCRIPT_COMMAND = 'node';
/** Placeholder an override's `args` may carry for the script's own path. */
export const SCRIPT_PLACEHOLDER = '{script}';
/** Bookkeeping file beside the scripts; dot-prefixed so no scan ever sees it. */
export const SCRIPT_STATE_FILE = '.state.json';
/** Prefix of the throwaway file a draft run is executed from. */
const DRAFT_PREFIX = '.draft-';
/** Longest output tail the settings page is handed for one stream. */
const REPORT_OUTPUT = 2000;
/** Valid prompt-variable names, mirroring the registry's own rule. */
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/;
/** A draft file name this module wrote, as opposed to anything a person left. */
const DRAFT_FILE = new RegExp(`^\\${DRAFT_PREFIX}\\d+-\\d+\\${SCRIPT_EXTENSION}$`);
/** Monotonic suffix keeping concurrent draft names distinct within one process. */
let draftCounter = 0;
/** A script operation the caller should report, not retry blindly. */
export class ScriptError extends Error {
    /** Machine-readable reason. */
    reason;
    /** The run report, when the refusal came from running something. */
    report;
    /**
     * @param reason - machine-readable reason.
     * @param message - human-facing detail.
     * @param report - the run that produced the refusal, when there was one.
     */
    constructor(reason, message, report) {
        super(message);
        this.name = 'ScriptError';
        this.reason = reason;
        this.report = report;
    }
}
/** Message text of an unknown thrown value. */
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * Read one stream back, bounded.
 * @param text - accumulated output.
 * @param tail - keep the end rather than the start, where errors usually are.
 * @returns the text, cut to the size cap and then to a display-friendly tail.
 */
function clipStream(text, tail) {
    const clipped = text.length > MAX_SCRIPT_OUTPUT ? (tail ? text.slice(-MAX_SCRIPT_OUTPUT) : text.slice(0, MAX_SCRIPT_OUTPUT)) : text;
    return clipped.length > REPORT_OUTPUT
        ? (tail ? `…${clipped.slice(-REPORT_OUTPUT)}` : `${clipped.slice(0, REPORT_OUTPUT)}…`)
        : clipped;
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
export const defaultScriptRunner = (spec, options) => {
    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timedOut = false;
        const finish = (run) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(run);
        };
        const child = spawn(spec.command, spec.args, {
            cwd: options.cwd,
            shell: false,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            // The host's environment comes through, so PATH and proxies work as they
            // do anywhere else; the two markers let a script tell what is running it.
            env: { ...process.env, DSH_PROMPT_MANAGER: '1', DSH_PROMPT_MANAGER_SCRIPT: options.name },
        });
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, spec.timeoutMs);
        child.stdout?.on('data', (chunk) => {
            if (stdout.length < MAX_SCRIPT_OUTPUT)
                stdout += chunk.toString();
        });
        child.stderr?.on('data', (chunk) => {
            if (stderr.length < MAX_SCRIPT_OUTPUT)
                stderr += chunk.toString();
        });
        child.on('error', (error) => {
            finish({ spawnError: error.code ?? 'EINVAL', status: undefined, stdout, stderr, timedOut: false });
        });
        child.on('close', (code) => {
            finish({
                spawnError: undefined,
                status: code === null ? undefined : code,
                stdout,
                stderr,
                timedOut,
            });
        });
    });
};
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
export function resolveSpec(scriptPath, override) {
    const timeoutMs = override?.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;
    const command = override?.command?.trim() ?? '';
    if (command.length === 0)
        return { command: DEFAULT_SCRIPT_COMMAND, args: [scriptPath], timeoutMs };
    const args = override?.args;
    if (args === undefined)
        return { command, args: [scriptPath], timeoutMs };
    let substituted = false;
    const resolved = args.map((argument) => {
        if (!argument.includes(SCRIPT_PLACEHOLDER))
            return argument;
        substituted = true;
        return argument.split(SCRIPT_PLACEHOLDER).join(scriptPath);
    });
    return { command, args: substituted ? resolved : [...resolved, scriptPath], timeoutMs };
}
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
export function normalizeScriptOverrides(raw) {
    const overrides = {};
    const problems = [];
    if (raw === undefined || raw === null)
        return { overrides, problems };
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        return { overrides, problems: ['scripts must be a mapping of script name to an override'] };
    }
    for (const [name, value] of Object.entries(raw)) {
        if (!isEntryId(name)) {
            problems.push(`script override name ${JSON.stringify(name)} is not a usable script name`);
            continue;
        }
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            problems.push(`override for ${name} must be a mapping`);
            continue;
        }
        const record = value;
        const override = {};
        const command = record['command'];
        if (command !== undefined) {
            if (typeof command !== 'string' || command.trim().length === 0) {
                problems.push(`override for ${name} has a command that is not a non-empty string`);
                continue;
            }
            override.command = command.trim();
        }
        const args = record['args'];
        if (args !== undefined) {
            if (!Array.isArray(args) || args.some((entry) => typeof entry !== 'string')) {
                problems.push(`override for ${name} has args that are not a list of strings`);
                continue;
            }
            override.args = args;
        }
        const timeoutMs = record['timeoutMs'];
        if (timeoutMs !== undefined) {
            if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
                problems.push(`override for ${name} has a timeoutMs that is not a positive number`);
                continue;
            }
            override.timeoutMs = Math.trunc(timeoutMs);
        }
        overrides[name] = override;
    }
    return { overrides, problems };
}
/**
 * Whether a script's source parses.
 *
 * Compiling is not running: `new vm.Script()` reports a syntax error and
 * executes nothing, which is what makes it safe to call on a draft.
 *
 * @param source - the script text.
 * @returns the parser's complaint, or `undefined` when it is fine.
 */
export function checkSyntax(source) {
    try {
        new CompiledScript(source, { filename: 'script.js' });
        return undefined;
    }
    catch (error) {
        return messageOf(error);
    }
}
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
export function parseScriptOutput(raw, texts = DEFAULT_PROBE_TEXTS) {
    const truncated = [];
    const text = raw.trim();
    if (text.length === 0)
        return { variables: {}, truncated, problems: ['スクリプトは何も出力しませんでした'] };
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (error) {
        return { variables: {}, truncated, problems: [`出力は有効な JSON ではありません：${messageOf(error)}`] };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { variables: {}, truncated, problems: ['出力は JSON オブジェクトでなければなりません。キーが変数名です'] };
    }
    const record = parsed;
    const keys = Object.keys(record);
    if (keys.length === 0)
        return { variables: {}, truncated, problems: ['オブジェクトにキーがありません'] };
    if (keys.length > MAX_SCRIPT_VARIABLES) {
        return {
            variables: {},
            truncated,
            problems: [`1つのスクリプトが提供できる変数は最大 ${String(MAX_SCRIPT_VARIABLES)} 個です。今回は ${String(keys.length)} 個ありました`],
        };
    }
    const variables = {};
    const problems = [];
    for (const key of keys) {
        if (!VARIABLE_NAME.test(key) || key.length > MAX_ID_LENGTH) {
            problems.push(`変数名 ${JSON.stringify(key)} は不正です（${String(VARIABLE_NAME)} に一致する必要があります）`);
            continue;
        }
        const value = record[key];
        if (typeof value === 'string') {
            const clipped = value.slice(0, MAX_PROBE_VALUE);
            if (value.length > clipped.length)
                truncated.push(key);
            variables[key] = clipped.length > 0 ? clipped : texts.empty;
            continue;
        }
        if (typeof value === 'number' && Number.isFinite(value)) {
            const rendered = String(value);
            if (rendered.length > MAX_PROBE_VALUE)
                truncated.push(key);
            variables[key] = rendered.slice(0, MAX_PROBE_VALUE);
            continue;
        }
        problems.push(`変数 ${key} の値は文字列か数値でなければなりません`);
    }
    if (problems.length > 0)
        return { variables: {}, truncated, problems };
    return { variables, truncated, problems };
}
/**
 * Read the bookkeeping beside the scripts.
 * @param dir - the script directory.
 * @returns one record per script; an unreadable or malformed file reads as empty.
 */
export function readScriptState(dir) {
    const file = join(dir, SCRIPT_STATE_FILE);
    if (!existsSync(file))
        return {};
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
            return {};
        const state = {};
        for (const [name, value] of Object.entries(parsed)) {
            if (!isEntryId(name))
                continue;
            if (typeof value !== 'object' || value === null || Array.isArray(value))
                continue;
            const record = value;
            const sha1 = record['sha1'];
            const variables = record['variables'];
            // An empty hash is kept: it is what a script that has never succeeded
            // writes, and the page should still be able to show why it failed.
            if (typeof sha1 !== 'string')
                continue;
            if (typeof variables !== 'object' || variables === null || Array.isArray(variables))
                continue;
            const kept = {};
            for (const [variable, text] of Object.entries(variables)) {
                if (VARIABLE_NAME.test(variable) && typeof text === 'string' && text.length > 0)
                    kept[variable] = text;
            }
            const entry = {
                sha1,
                variables: kept,
                ranAt: typeof record['ranAt'] === 'string' ? record['ranAt'] : '',
                ms: typeof record['ms'] === 'number' && Number.isFinite(record['ms']) ? record['ms'] : 0,
            };
            if (typeof record['exitCode'] === 'number' && Number.isFinite(record['exitCode']))
                entry.exitCode = record['exitCode'];
            if (typeof record['error'] === 'string' && record['error'].length > 0)
                entry.error = record['error'];
            state[name] = entry;
        }
        return state;
    }
    catch {
        return {};
    }
}
/**
 * Persist the bookkeeping.
 * @param dir - the script directory.
 * @param state - the state to write.
 */
export function writeScriptState(dir, state) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, SCRIPT_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
/**
 * Remove draft files this module left behind, so an interrupted run cannot
 * accumulate files in a directory a person reads.
 * @param dir - the script directory.
 */
export function cleanDrafts(dir) {
    if (!existsSync(dir))
        return;
    try {
        for (const name of readdirSync(dir)) {
            if (DRAFT_FILE.test(name))
                rmSync(join(dir, name), { force: true });
        }
    }
    catch {
        /* a directory that cannot be listed has nothing this pass can clean */
    }
}
/** The script engine: on-disk scripts, their runs, and their values. */
export class PromptScripts {
    host;
    /** `<root>/scripts`, from the plugin's resolved storage root. */
    store;
    /** How one script is executed; replaced in tests. */
    runner;
    /** Keep a run from writing its values into a prompt that has been torn down. */
    disposed = false;
    /**
     * @param host - the plugin side of the engine.
     * @param options - the process runner; the real one by default.
     */
    constructor(host, options = {}) {
        this.host = host;
        this.store = new PromptStore(join(host.dir()), { extension: SCRIPT_EXTENSION, maxBytes: MAX_SCRIPT_BYTES });
        this.runner = options.run ?? defaultScriptRunner;
    }
    /** Absolute directory holding the scripts. */
    get dir() {
        return this.store.dir;
    }
    /** Stop accepting run results. */
    dispose() {
        this.disposed = true;
    }
    /**
     * Script names present on disk, in directory order.
     * @returns the names, capped at {@link MAX_SCRIPTS}.
     */
    names() {
        return this.store.ids().slice(0, MAX_SCRIPTS);
    }
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
    read(name) {
        if (!isEntryId(name))
            return undefined;
        let stored;
        try {
            stored = this.store.read(name);
        }
        catch (error) {
            this.host.warn(`cannot read the script ${name}: ${messageOf(error)}`);
            return undefined;
        }
        return stored === undefined ? undefined : { source: stored.body, sha1: stored.sha1 };
    }
    /**
     * The scripts as the settings page sees them.
     * @returns one summary per script on disk.
     */
    list() {
        const state = readScriptState(this.dir);
        return this.names().map((name) => {
            const record = state[name];
            const stored = this.read(name);
            const summary = {
                name,
                sha1: stored?.sha1 ?? null,
                variables: record === undefined ? [] : Object.keys(record.variables),
                pending: record === undefined || stored === undefined || record.sha1 !== stored.sha1,
            };
            if (record !== undefined) {
                if (record.ranAt.length > 0)
                    summary.ranAt = record.ranAt;
                if (record.exitCode !== undefined)
                    summary.exitCode = record.exitCode;
                if (record.ms > 0)
                    summary.ms = record.ms;
                if (record.error !== undefined)
                    summary.error = record.error;
            }
            return summary;
        });
    }
    /**
     * Declare the values cached for every script whose file has not changed.
     *
     * Called at mount, synchronously, so a profile start serves the values it saw
     * last without executing anything. A script with no cache, or one whose file
     * changed while the profile was down, is left to {@link refresh}.
     *
     * @returns the names that still need a run.
     */
    mountDeclare() {
        const onDisk = this.names();
        // A record whose script is gone is housekeeping: nothing has been declared
        // yet at mount, so only the cache entry can be let go of here.
        this.reconcile(onDisk);
        const state = readScriptState(this.dir);
        const pending = [];
        for (const name of onDisk) {
            const record = state[name];
            const stored = this.read(name);
            if (record === undefined || stored === undefined || record.sha1 !== stored.sha1) {
                pending.push(name);
                continue;
            }
            for (const [variable, value] of Object.entries(record.variables)) {
                this.apply(name, variable, value);
            }
        }
        return pending;
    }
    /**
     * Run every named script, or every script on disk, and publish the values.
     * @param names - scripts to run; all of them when omitted.
     * @returns one report per script, in the order they were run.
     */
    async refresh(names) {
        const onDisk = this.names();
        // A script deleted by hand (or by another profile sharing the store) leaves
        // its record and its variables behind; this is the pass that notices.
        this.reconcile(onDisk);
        const wanted = names === undefined ? onDisk : names.filter((name) => onDisk.includes(name));
        const reports = [];
        for (const name of wanted)
            reports.push(await this.run(name));
        return reports;
    }
    /**
     * Run one script from disk and publish whatever it supplies.
     * @param name - script name.
     * @returns the run report.
     * @throws {ScriptError} when the script does not exist.
     */
    async run(name) {
        const stored = this.read(name);
        if (stored === undefined)
            throw new ScriptError('unknown-script', `このスクリプトはありません：${name}`);
        const report = await this.execute(name, stored.source, false);
        if (report.ok)
            this.recordSuccess(name, stored.sha1, report);
        else
            this.recordFailure(name, report.problems.join('；'));
        return report;
    }
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
    async runSource(name, source) {
        if (!isEntryId(name))
            throw new ScriptError('invalid-name', `${JSON.stringify(name)} はスクリプト名として使えません`);
        return this.execute(name, source, true);
    }
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
    async save(name, source, fence) {
        if (!isEntryId(name))
            throw new ScriptError('invalid-name', `${JSON.stringify(name)} はスクリプト名として使えません`);
        const existing = this.names();
        if (!existing.includes(name) && existing.length >= MAX_SCRIPTS) {
            throw new ScriptError('too-many', `スクリプトは最大 ${String(MAX_SCRIPTS)} 個です。1つ削除してください`);
        }
        if (Buffer.byteLength(source, 'utf8') > MAX_SCRIPT_BYTES) {
            throw new ScriptError('invalid-source', `スクリプトが ${String(MAX_SCRIPT_BYTES)} バイトを超えています`);
        }
        const syntax = checkSyntax(source);
        if (syntax !== undefined)
            throw new ScriptError('invalid-source', `スクリプトを解析できません：${syntax}`);
        const report = await this.execute(name, source, true);
        if (!report.ok) {
            throw new ScriptError('invalid-output', report.problems.join('；'), report);
        }
        const conflicts = [];
        for (const variable of Object.keys(report.variables)) {
            const owner = this.host.owner(variable);
            if (owner !== undefined && owner !== name)
                conflicts.push(`${variable}（${owner} 提供）`);
        }
        if (conflicts.length > 0) {
            throw new ScriptError('conflict', `変数名が既に使われています：${conflicts.join('、')}`, report);
        }
        try {
            this.store.write(name, source, fence);
        }
        catch (error) {
            if (error instanceof PromptStoreError) {
                throw new ScriptError(error.code === 'conflict' ? 'conflict' : 'invalid-source', error.message, report);
            }
            throw error;
        }
        const sha1 = bodyHash(source);
        this.recordSuccess(name, sha1, report);
        return { name, sha1, variables: report.variables, report };
    }
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
    remove(name) {
        const state = readScriptState(this.dir);
        const record = state[name];
        const removed = this.store.remove(name);
        if (record !== undefined) {
            delete state[name];
            writeScriptState(this.dir, state);
        }
        this.release(name, record);
        return removed;
    }
    /**
     * Drop the cache entries and variables of scripts that are no longer on disk.
     * @param onDisk - script names currently on disk.
     */
    reconcile(onDisk) {
        const state = readScriptState(this.dir);
        let changed = false;
        for (const name of Object.keys(state)) {
            if (onDisk.includes(name))
                continue;
            const record = state[name];
            delete state[name];
            changed = true;
            this.release(name, record);
        }
        if (changed)
            writeScriptState(this.dir, state);
    }
    /**
     * Let go of what one script supplied, keeping whatever is still referenced.
     * @param name - the script that is gone.
     * @param record - its cache entry, when it had one.
     */
    release(name, record) {
        if (record === undefined)
            return;
        for (const variable of Object.keys(record.variables)) {
            if (this.host.referenced(variable))
                continue;
            this.host.forget(variable, name);
        }
    }
    /**
     * Record a successful run: its values reach the registry, its summary reaches
     * the cache.
     * @param name - owning script.
     * @param sha1 - hash of the source that produced the values.
     * @param report - the run that succeeded.
     */
    recordSuccess(name, sha1, report) {
        const state = readScriptState(this.dir);
        const entry = {
            sha1,
            ranAt: new Date().toISOString(),
            ms: report.ms,
            variables: { ...report.variables },
        };
        if (report.exitCode !== undefined)
            entry.exitCode = report.exitCode;
        state[name] = entry;
        writeScriptState(this.dir, state);
        for (const [variable, value] of Object.entries(report.variables))
            this.apply(name, variable, value);
    }
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
    recordFailure(name, error) {
        const state = readScriptState(this.dir);
        const previous = state[name];
        const entry = {
            sha1: previous?.sha1 ?? '',
            ranAt: previous?.ranAt ?? '',
            ms: previous?.ms ?? 0,
            variables: previous?.variables ?? {},
            error,
        };
        if (previous?.exitCode !== undefined)
            entry.exitCode = previous.exitCode;
        state[name] = entry;
        writeScriptState(this.dir, state);
    }
    /**
     * Publish one variable, reporting a name another owner already holds.
     * @param name - owning script.
     * @param variable - the `{{name}}` reference.
     * @param value - the value to serve.
     */
    apply(name, variable, value) {
        if (this.disposed)
            return;
        if (this.host.declare(variable, value, name) === 'conflict') {
            this.host.warn(`script ${name} wants the variable ${variable}, which another source already owns; it keeps its current value`);
        }
    }
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
    async execute(name, source, draft) {
        mkdirSync(this.dir, { recursive: true });
        let path = join(this.dir, `${name}${SCRIPT_EXTENSION}`);
        if (draft) {
            draftCounter += 1;
            path = join(this.dir, `${DRAFT_PREFIX}${String(process.pid)}-${String(draftCounter)}${SCRIPT_EXTENSION}`);
            writeFileSync(path, source, 'utf8');
        }
        const spec = resolveSpec(path, this.host.overrides()[name]);
        const started = Date.now();
        let run;
        try {
            run = await this.runner(spec, { cwd: this.dir, name });
        }
        catch (error) {
            run = { spawnError: undefined, status: undefined, stdout: '', stderr: messageOf(error), timedOut: false };
        }
        finally {
            if (draft)
                rmSync(path, { force: true });
        }
        const ms = Date.now() - started;
        const report = {
            name,
            ok: false,
            exitCode: run.status,
            ms,
            variables: {},
            truncated: [],
            problems: [],
            warnings: [],
            stdout: clipStream(run.stdout, false),
            stderr: clipStream(run.stderr, true),
        };
        if (run.timedOut) {
            report.problems.push(`スクリプトがタイムアウトしました（${String(spec.timeoutMs)}ms 超過）。終了させました`);
            return report;
        }
        if (run.spawnError !== undefined) {
            report.problems.push(`${spec.command} を起動できません（${run.spawnError}）`);
            return report;
        }
        const parsed = parseScriptOutput(run.stdout, this.host.texts());
        if (parsed.problems.length > 0) {
            const prefix = run.status !== undefined && run.status !== 0 ? `終了コード ${String(run.status)}；` : '';
            for (const problem of parsed.problems)
                report.problems.push(`${prefix}${problem}`);
            return report;
        }
        // A tool that prints a usable version and still exits non-zero told us what
        // we asked for, so the values are kept and the exit code is surfaced beside
        // them rather than costing the run.
        if (run.status !== undefined && run.status !== 0) {
            report.warnings.push(`終了コード ${String(run.status)}（出力は利用可能で、値を通常通り採用します）`);
        }
        report.variables = parsed.variables;
        report.truncated = parsed.truncated;
        report.ok = true;
        return report;
    }
}
//# sourceMappingURL=scripts.js.map