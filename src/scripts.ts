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

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Script as CompiledScript } from 'node:vm'
import { isEntryId, MAX_ID_LENGTH } from './entries.js'
import { DEFAULT_PROBE_TEXTS, MAX_PROBE_VALUE, type ProbeRun, type ProbeTexts } from './probe.js'
import { bodyHash, PromptStore, PromptStoreError } from './store.js'

/** Directory name, under the plugin's storage root, holding the scripts. */
export const SCRIPTS_DIR_NAME = 'scripts'

/** Extension every script file carries. */
export const SCRIPT_EXTENSION = '.js'

/** Largest accepted script, in bytes. */
export const MAX_SCRIPT_BYTES = 64 * 1024

/** At most this many scripts may live in the directory. */
export const MAX_SCRIPTS = 20

/** At most this many variables may come from one script. */
export const MAX_SCRIPT_VARIABLES = 64

/** Per-run timeout, used when a script's override sets none. */
export const DEFAULT_SCRIPT_TIMEOUT_MS = 3000

/** Largest amount of output read back from one run, in bytes. */
export const MAX_SCRIPT_OUTPUT = 64 * 1024

/** Default interpreter. An override replaces it, e.g. `python`. */
export const DEFAULT_SCRIPT_COMMAND = 'node'

/** Placeholder an override's `args` may carry for the script's own path. */
export const SCRIPT_PLACEHOLDER = '{script}'

/** Bookkeeping file beside the scripts; dot-prefixed so no scan ever sees it. */
export const SCRIPT_STATE_FILE = '.state.json'

/** Prefix of the throwaway file a draft run is executed from. */
const DRAFT_PREFIX = '.draft-'

/** Longest output tail the settings page is handed for one stream. */
const REPORT_OUTPUT = 2000

/** Valid prompt-variable names, mirroring the registry's own rule. */
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/

/** A draft file name this module wrote, as opposed to anything a person left. */
const DRAFT_FILE = new RegExp(`^\\${DRAFT_PREFIX}\\d+-\\d+\\${SCRIPT_EXTENSION}$`)

/** Monotonic suffix keeping concurrent draft names distinct within one process. */
let draftCounter = 0

/** What a composition may override about one script's execution. */
export interface ScriptOverride {
  /** Interpreter to run; defaults to {@link DEFAULT_SCRIPT_COMMAND}. */
  command?: string | undefined
  /** Arguments; `{script}` becomes the script's absolute path. */
  args?: string[] | undefined
  /** Timeout for this script alone, in milliseconds. */
  timeoutMs?: number | undefined
}

/** One resolved execution, ready for a runner. */
export interface ScriptSpec {
  /** Interpreter name or absolute path. */
  command: string
  /** Arguments, with the script's path already substituted in. */
  args: string[]
  /** Timeout for this run. */
  timeoutMs: number
}

/** Runs one script. Replaced in tests, so no interpreter is needed. */
export type ScriptRunner = (
  spec: ScriptSpec,
  options: { cwd: string; name: string },
) => Promise<ProbeRun>

/** One script's cached result, as persisted beside the scripts. */
export interface ScriptRecord {
  /** sha1 of the script source that produced {@link ScriptRecord.variables}. */
  sha1: string
  /** When the successful run happened, ISO-8601. */
  ranAt: string
  /** Wall time of that run, in milliseconds. */
  ms: number
  /** Exit code of that run, when it had one. */
  exitCode?: number | undefined
  /** Variables it supplied, as registered. */
  variables: Record<string, string>
  /** Why the most recent run after that one failed, when it did. */
  error?: string | undefined
}

/** Every script's bookkeeping, keyed by script name. */
export type ScriptState = Record<string, ScriptRecord>

/** One script as the settings page sees it. */
export interface ScriptSummary {
  /** Script name, which is also the file stem. */
  name: string
  /** sha1 of the file on disk now, or `null` when it cannot be read. */
  sha1: string | null
  /** Variables the last successful run supplied. */
  variables: string[]
  /** When that run happened. */
  ranAt?: string | undefined
  /** Its exit code. */
  exitCode?: number | undefined
  /** Its wall time, in milliseconds. */
  ms?: number | undefined
  /** Why the most recent attempt failed, when it did. */
  error?: string | undefined
  /** The file changed since the cached run, so its values are stale. */
  pending: boolean
}

/** What one run produced. */
export interface ScriptRunReport {
  /** Script name; a draft run reports the name it was tested under. */
  name: string
  /** Whether the run produced a usable variable set. */
  ok: boolean
  /** Exit code, when the process ran. */
  exitCode: number | undefined
  /** Wall time, in milliseconds. */
  ms: number
  /** The variables the run supplies, when it succeeded. */
  variables: Record<string, string>
  /** Variables whose value was cut to {@link MAX_PROBE_VALUE} characters. */
  truncated: string[]
  /** Everything that made the run unusable, in the order it was discovered. */
  problems: string[]
  /** Things worth showing that did not make the run unusable. */
  warnings: string[]
  /** Standard output, trimmed to a readable head for the page. */
  stdout: string
  /** Standard error, trimmed to a readable tail for the page. */
  stderr: string
}

/** Why a script operation was refused. */
export type ScriptErrorReason =
  /** The name is not a usable script name. */
  | 'invalid-name'
  /** The source does not parse, or is too large. */
  | 'invalid-source'
  /** The script ran but produced no usable variable set. */
  | 'invalid-output'
  /** A variable name it wants belongs to something else. */
  | 'conflict'
  /** Too many scripts, or too many variables from one. */
  | 'too-many'
  /** The script file is not there. */
  | 'unknown-script'

/** A script operation the caller should report, not retry blindly. */
export class ScriptError extends Error {
  /** Machine-readable reason. */
  readonly reason: ScriptErrorReason

  /** The run report, when the refusal came from running something. */
  readonly report: ScriptRunReport | undefined

  /**
   * @param reason - machine-readable reason.
   * @param message - human-facing detail.
   * @param report - the run that produced the refusal, when there was one.
   */
  constructor(reason: ScriptErrorReason, message: string, report?: ScriptRunReport) {
    super(message)
    this.name = 'ScriptError'
    this.reason = reason
    this.report = report
  }
}

/** What the script engine needs from the plugin. */
export interface ScriptHost {
  /** Absolute directory holding `<name>.js`. */
  dir(): string
  /** Per-script overrides, from composition config. */
  overrides(): Record<string, ScriptOverride>
  /** Placeholder texts a value falls back to. */
  texts(): ProbeTexts
  /**
   * Offer one variable to the prompt registry.
   * @param name - the `{{name}}` reference.
   * @param value - the value to serve; never empty.
   * @param detail - owning script name.
   * @returns `assigned` when this script already owns the name, `declared` when
   * it was free, `conflict` when another owner has it.
   */
  declare(name: string, value: string, detail: string): 'assigned' | 'declared' | 'conflict'
  /**
   * Who owns a variable name right now.
   * @param name - the `{{name}}` reference.
   * @returns the owning script name, or `undefined` when the name is free.
   */
  owner(name: string): string | undefined
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
  referenced(name: string): boolean
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
  forget(name: string, detail: string): void
  /** Report a non-fatal problem. */
  warn(message: string): void
}

/** Message text of an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read one stream back, bounded.
 * @param text - accumulated output.
 * @param tail - keep the end rather than the start, where errors usually are.
 * @returns the text, cut to the size cap and then to a display-friendly tail.
 */
function clipStream(text: string, tail: boolean): string {
  const clipped = text.length > MAX_SCRIPT_OUTPUT ? (tail ? text.slice(-MAX_SCRIPT_OUTPUT) : text.slice(0, MAX_SCRIPT_OUTPUT)) : text
  return clipped.length > REPORT_OUTPUT
    ? (tail ? `…${clipped.slice(-REPORT_OUTPUT)}` : `${clipped.slice(0, REPORT_OUTPUT)}…`)
    : clipped
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
export const defaultScriptRunner: ScriptRunner = (spec, options) => {
  return new Promise<ProbeRun>((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false

    const finish = (run: ProbeRun): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(run)
    }

    const child = spawn(spec.command, spec.args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // The host's environment comes through, so PATH and proxies work as they
      // do anywhere else; the two markers let a script tell what is running it.
      env: { ...process.env, DSH_PROMPT_MANAGER: '1', DSH_PROMPT_MANAGER_SCRIPT: options.name },
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, spec.timeoutMs)

    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (stdout.length < MAX_SCRIPT_OUTPUT) stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderr.length < MAX_SCRIPT_OUTPUT) stderr += chunk.toString()
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({ spawnError: error.code ?? 'EINVAL', status: undefined, stdout, stderr, timedOut: false })
    })
    child.on('close', (code: number | null) => {
      finish({
        spawnError: undefined,
        status: code === null ? undefined : code,
        stdout,
        stderr,
        timedOut,
      })
    })
  })
}

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
export function resolveSpec(scriptPath: string, override: ScriptOverride | undefined): ScriptSpec {
  const timeoutMs = override?.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS
  const command = override?.command?.trim() ?? ''
  if (command.length === 0) return { command: DEFAULT_SCRIPT_COMMAND, args: [scriptPath], timeoutMs }
  const args = override?.args
  if (args === undefined) return { command, args: [scriptPath], timeoutMs }
  let substituted = false
  const resolved = args.map((argument) => {
    if (!argument.includes(SCRIPT_PLACEHOLDER)) return argument
    substituted = true
    return argument.split(SCRIPT_PLACEHOLDER).join(scriptPath)
  })
  return { command, args: substituted ? resolved : [...resolved, scriptPath], timeoutMs }
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
export function normalizeScriptOverrides(raw: unknown): {
  overrides: Record<string, ScriptOverride>
  problems: string[]
} {
  const overrides: Record<string, ScriptOverride> = {}
  const problems: string[] = []
  if (raw === undefined || raw === null) return { overrides, problems }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { overrides, problems: ['scripts must be a mapping of script name to an override'] }
  }
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isEntryId(name)) {
      problems.push(`script override name ${JSON.stringify(name)} is not a usable script name`)
      continue
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      problems.push(`override for ${name} must be a mapping`)
      continue
    }
    const record = value as Record<string, unknown>
    const override: ScriptOverride = {}
    const command = record['command']
    if (command !== undefined) {
      if (typeof command !== 'string' || command.trim().length === 0) {
        problems.push(`override for ${name} has a command that is not a non-empty string`)
        continue
      }
      override.command = command.trim()
    }
    const args = record['args']
    if (args !== undefined) {
      if (!Array.isArray(args) || args.some((entry) => typeof entry !== 'string')) {
        problems.push(`override for ${name} has args that are not a list of strings`)
        continue
      }
      override.args = args as string[]
    }
    const timeoutMs = record['timeoutMs']
    if (timeoutMs !== undefined) {
      if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        problems.push(`override for ${name} has a timeoutMs that is not a positive number`)
        continue
      }
      override.timeoutMs = Math.trunc(timeoutMs)
    }
    overrides[name] = override
  }
  return { overrides, problems }
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
export function checkSyntax(source: string): string | undefined {
  try {
    new CompiledScript(source, { filename: 'script.js' })
    return undefined
  } catch (error) {
    return messageOf(error)
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
export function parseScriptOutput(
  raw: string,
  texts: ProbeTexts = DEFAULT_PROBE_TEXTS,
): { variables: Record<string, string>; truncated: string[]; problems: string[] } {
  const truncated: string[] = []
  const text = raw.trim()
  if (text.length === 0) return { variables: {}, truncated, problems: ['スクリプトは何も出力しませんでした'] }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (error) {
    return { variables: {}, truncated, problems: [`出力は有効な JSON ではありません：${messageOf(error)}`] }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { variables: {}, truncated, problems: ['出力は JSON オブジェクトでなければなりません。キーが変数名です'] }
  }
  const record = parsed as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length === 0) return { variables: {}, truncated, problems: ['オブジェクトにキーがありません'] }
  if (keys.length > MAX_SCRIPT_VARIABLES) {
    return {
      variables: {},
      truncated,
      problems: [`1つのスクリプトが提供できる変数は最大 ${String(MAX_SCRIPT_VARIABLES)} 個です。今回は ${String(keys.length)} 個ありました`],
    }
  }
  const variables: Record<string, string> = {}
  const problems: string[] = []
  for (const key of keys) {
    if (!VARIABLE_NAME.test(key) || key.length > MAX_ID_LENGTH) {
      problems.push(`変数名 ${JSON.stringify(key)} は不正です（${String(VARIABLE_NAME)} に一致する必要があります）`)
      continue
    }
    const value = record[key]
    if (typeof value === 'string') {
      const clipped = value.slice(0, MAX_PROBE_VALUE)
      if (value.length > clipped.length) truncated.push(key)
      variables[key] = clipped.length > 0 ? clipped : texts.empty
      continue
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      const rendered = String(value)
      if (rendered.length > MAX_PROBE_VALUE) truncated.push(key)
      variables[key] = rendered.slice(0, MAX_PROBE_VALUE)
      continue
    }
    problems.push(`変数 ${key} の値は文字列か数値でなければなりません`)
  }
  if (problems.length > 0) return { variables: {}, truncated, problems }
  return { variables, truncated, problems }
}

/**
 * Read the bookkeeping beside the scripts.
 * @param dir - the script directory.
 * @returns one record per script; an unreadable or malformed file reads as empty.
 */
export function readScriptState(dir: string): ScriptState {
  const file = join(dir, SCRIPT_STATE_FILE)
  if (!existsSync(file)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const state: ScriptState = {}
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isEntryId(name)) continue
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
      const record = value as Record<string, unknown>
      const sha1 = record['sha1']
      const variables = record['variables']
      // An empty hash is kept: it is what a script that has never succeeded
      // writes, and the page should still be able to show why it failed.
      if (typeof sha1 !== 'string') continue
      if (typeof variables !== 'object' || variables === null || Array.isArray(variables)) continue
      const kept: Record<string, string> = {}
      for (const [variable, text] of Object.entries(variables as Record<string, unknown>)) {
        if (VARIABLE_NAME.test(variable) && typeof text === 'string' && text.length > 0) kept[variable] = text
      }
      const entry: ScriptRecord = {
        sha1,
        variables: kept,
        ranAt: typeof record['ranAt'] === 'string' ? record['ranAt'] : '',
        ms: typeof record['ms'] === 'number' && Number.isFinite(record['ms']) ? record['ms'] : 0,
      }
      if (typeof record['exitCode'] === 'number' && Number.isFinite(record['exitCode'])) entry.exitCode = record['exitCode']
      if (typeof record['error'] === 'string' && record['error'].length > 0) entry.error = record['error']
      state[name] = entry
    }
    return state
  } catch {
    return {}
  }
}

/**
 * Persist the bookkeeping.
 * @param dir - the script directory.
 * @param state - the state to write.
 */
export function writeScriptState(dir: string, state: ScriptState): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, SCRIPT_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

/**
 * Remove draft files this module left behind, so an interrupted run cannot
 * accumulate files in a directory a person reads.
 * @param dir - the script directory.
 */
export function cleanDrafts(dir: string): void {
  if (!existsSync(dir)) return
  try {
    for (const name of readdirSync(dir)) {
      if (DRAFT_FILE.test(name)) rmSync(join(dir, name), { force: true })
    }
  } catch {
    /* a directory that cannot be listed has nothing this pass can clean */
  }
}

/** The script engine: on-disk scripts, their runs, and their values. */
export class PromptScripts {
  private readonly host: ScriptHost

  /** `<root>/scripts`, from the plugin's resolved storage root. */
  private readonly store: PromptStore

  /** How one script is executed; replaced in tests. */
  private readonly runner: ScriptRunner

  /** Keep a run from writing its values into a prompt that has been torn down. */
  private disposed = false

  /**
   * @param host - the plugin side of the engine.
   * @param options - the process runner; the real one by default.
   */
  constructor(host: ScriptHost, options: { run?: ScriptRunner | undefined } = {}) {
    this.host = host
    this.store = new PromptStore(join(host.dir()), { extension: SCRIPT_EXTENSION, maxBytes: MAX_SCRIPT_BYTES })
    this.runner = options.run ?? defaultScriptRunner
  }

  /** Absolute directory holding the scripts. */
  get dir(): string {
    return this.store.dir
  }

  /** Stop accepting run results. */
  dispose(): void {
    this.disposed = true
  }

  /**
   * Script names present on disk, in directory order.
   * @returns the names, capped at {@link MAX_SCRIPTS}.
   */
  names(): string[] {
    return this.store.ids().slice(0, MAX_SCRIPTS)
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
  read(name: string): { source: string; sha1: string } | undefined {
    if (!isEntryId(name)) return undefined
    let stored
    try {
      stored = this.store.read(name)
    } catch (error) {
      this.host.warn(`cannot read the script ${name}: ${messageOf(error)}`)
      return undefined
    }
    return stored === undefined ? undefined : { source: stored.body, sha1: stored.sha1 }
  }

  /**
   * The scripts as the settings page sees them.
   * @returns one summary per script on disk.
   */
  list(): ScriptSummary[] {
    const state = readScriptState(this.dir)
    return this.names().map((name) => {
      const record = state[name]
      const stored = this.read(name)
      const summary: ScriptSummary = {
        name,
        sha1: stored?.sha1 ?? null,
        variables: record === undefined ? [] : Object.keys(record.variables),
        pending: record === undefined || stored === undefined || record.sha1 !== stored.sha1,
      }
      if (record !== undefined) {
        if (record.ranAt.length > 0) summary.ranAt = record.ranAt
        if (record.exitCode !== undefined) summary.exitCode = record.exitCode
        if (record.ms > 0) summary.ms = record.ms
        if (record.error !== undefined) summary.error = record.error
      }
      return summary
    })
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
  mountDeclare(): string[] {
    const onDisk = this.names()
    // A record whose script is gone is housekeeping: nothing has been declared
    // yet at mount, so only the cache entry can be let go of here.
    this.reconcile(onDisk)
    const state = readScriptState(this.dir)
    const pending: string[] = []
    for (const name of onDisk) {
      const record = state[name]
      const stored = this.read(name)
      if (record === undefined || stored === undefined || record.sha1 !== stored.sha1) {
        pending.push(name)
        continue
      }
      for (const [variable, value] of Object.entries(record.variables)) {
        this.apply(name, variable, value)
      }
    }
    return pending
  }

  /**
   * Run every named script, or every script on disk, and publish the values.
   * @param names - scripts to run; all of them when omitted.
   * @returns one report per script, in the order they were run.
   */
  async refresh(names?: readonly string[]): Promise<ScriptRunReport[]> {
    const onDisk = this.names()
    // A script deleted by hand (or by another profile sharing the store) leaves
    // its record and its variables behind; this is the pass that notices.
    this.reconcile(onDisk)
    const wanted = names === undefined ? onDisk : names.filter((name) => onDisk.includes(name))
    const reports: ScriptRunReport[] = []
    for (const name of wanted) reports.push(await this.run(name))
    return reports
  }

  /**
   * Run one script from disk and publish whatever it supplies.
   * @param name - script name.
   * @returns the run report.
   * @throws {ScriptError} when the script does not exist.
   */
  async run(name: string): Promise<ScriptRunReport> {
    const stored = this.read(name)
    if (stored === undefined) throw new ScriptError('unknown-script', `このスクリプトはありません：${name}`)
    const report = await this.execute(name, stored.source, false)
    if (report.ok) this.recordSuccess(name, stored.sha1, report)
    else this.recordFailure(name, report.problems.join('；'))
    return report
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
  async runSource(name: string, source: string): Promise<ScriptRunReport> {
    if (!isEntryId(name)) throw new ScriptError('invalid-name', `${JSON.stringify(name)} はスクリプト名として使えません`)
    return this.execute(name, source, true)
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
  async save(
    name: string,
    source: string,
    fence: { kind: 'absent' } | { kind: 'sha1'; sha1: string } | { kind: 'any' },
  ): Promise<{ name: string; sha1: string; variables: Record<string, string>; report: ScriptRunReport }> {
    if (!isEntryId(name)) throw new ScriptError('invalid-name', `${JSON.stringify(name)} はスクリプト名として使えません`)
    const existing = this.names()
    if (!existing.includes(name) && existing.length >= MAX_SCRIPTS) {
      throw new ScriptError('too-many', `スクリプトは最大 ${String(MAX_SCRIPTS)} 個です。1つ削除してください`)
    }
    if (Buffer.byteLength(source, 'utf8') > MAX_SCRIPT_BYTES) {
      throw new ScriptError('invalid-source', `スクリプトが ${String(MAX_SCRIPT_BYTES)} バイトを超えています`)
    }
    const syntax = checkSyntax(source)
    if (syntax !== undefined) throw new ScriptError('invalid-source', `スクリプトを解析できません：${syntax}`)

    const report = await this.execute(name, source, true)
    if (!report.ok) {
      throw new ScriptError('invalid-output', report.problems.join('；'), report)
    }
    const conflicts: string[] = []
    for (const variable of Object.keys(report.variables)) {
      const owner = this.host.owner(variable)
      if (owner !== undefined && owner !== name) conflicts.push(`${variable}（${owner} 提供）`)
    }
    if (conflicts.length > 0) {
      throw new ScriptError('conflict', `変数名が既に使われています：${conflicts.join('、')}`, report)
    }

    try {
      this.store.write(name, source, fence)
    } catch (error) {
      if (error instanceof PromptStoreError) {
        throw new ScriptError(error.code === 'conflict' ? 'conflict' : 'invalid-source', error.message, report)
      }
      throw error
    }
    const sha1 = bodyHash(source)
    this.recordSuccess(name, sha1, report)
    return { name, sha1, variables: report.variables, report }
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
  remove(name: string): boolean {
    const state = readScriptState(this.dir)
    const record = state[name]
    const removed = this.store.remove(name)
    if (record !== undefined) {
      delete state[name]
      writeScriptState(this.dir, state)
    }
    this.release(name, record)
    return removed
  }

  /**
   * Drop the cache entries and variables of scripts that are no longer on disk.
   * @param onDisk - script names currently on disk.
   */
  private reconcile(onDisk: readonly string[]): void {
    const state = readScriptState(this.dir)
    let changed = false
    for (const name of Object.keys(state)) {
      if (onDisk.includes(name)) continue
      const record = state[name]
      delete state[name]
      changed = true
      this.release(name, record)
    }
    if (changed) writeScriptState(this.dir, state)
  }

  /**
   * Let go of what one script supplied, keeping whatever is still referenced.
   * @param name - the script that is gone.
   * @param record - its cache entry, when it had one.
   */
  private release(name: string, record: ScriptRecord | undefined): void {
    if (record === undefined) return
    for (const variable of Object.keys(record.variables)) {
      if (this.host.referenced(variable)) continue
      this.host.forget(variable, name)
    }
  }

  /**
   * Record a successful run: its values reach the registry, its summary reaches
   * the cache.
   * @param name - owning script.
   * @param sha1 - hash of the source that produced the values.
   * @param report - the run that succeeded.
   */
  private recordSuccess(name: string, sha1: string, report: ScriptRunReport): void {
    const state = readScriptState(this.dir)
    const entry: ScriptRecord = {
      sha1,
      ranAt: new Date().toISOString(),
      ms: report.ms,
      variables: { ...report.variables },
    }
    if (report.exitCode !== undefined) entry.exitCode = report.exitCode
    state[name] = entry
    writeScriptState(this.dir, state)
    for (const [variable, value] of Object.entries(report.variables)) this.apply(name, variable, value)
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
  private recordFailure(name: string, error: string): void {
    const state = readScriptState(this.dir)
    const previous = state[name]
    const entry: ScriptRecord = {
      sha1: previous?.sha1 ?? '',
      ranAt: previous?.ranAt ?? '',
      ms: previous?.ms ?? 0,
      variables: previous?.variables ?? {},
      error,
    }
    if (previous?.exitCode !== undefined) entry.exitCode = previous.exitCode
    state[name] = entry
    writeScriptState(this.dir, state)
  }

  /**
   * Publish one variable, reporting a name another owner already holds.
   * @param name - owning script.
   * @param variable - the `{{name}}` reference.
   * @param value - the value to serve.
   */
  private apply(name: string, variable: string, value: string): void {
    if (this.disposed) return
    if (this.host.declare(variable, value, name) === 'conflict') {
      this.host.warn(`script ${name} wants the variable ${variable}, which another source already owns; it keeps its current value`)
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
  private async execute(name: string, source: string, draft: boolean): Promise<ScriptRunReport> {
    mkdirSync(this.dir, { recursive: true })
    let path = join(this.dir, `${name}${SCRIPT_EXTENSION}`)
    if (draft) {
      draftCounter += 1
      path = join(this.dir, `${DRAFT_PREFIX}${String(process.pid)}-${String(draftCounter)}${SCRIPT_EXTENSION}`)
      writeFileSync(path, source, 'utf8')
    }
    const spec = resolveSpec(path, this.host.overrides()[name])
    const started = Date.now()
    let run: ProbeRun
    try {
      run = await this.runner(spec, { cwd: this.dir, name })
    } catch (error) {
      run = { spawnError: undefined, status: undefined, stdout: '', stderr: messageOf(error), timedOut: false }
    } finally {
      if (draft) rmSync(path, { force: true })
    }
    const ms = Date.now() - started
    const report: ScriptRunReport = {
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
    }
    if (run.timedOut) {
      report.problems.push(`スクリプトがタイムアウトしました（${String(spec.timeoutMs)}ms 超過）。終了させました`)
      return report
    }
    if (run.spawnError !== undefined) {
      report.problems.push(`${spec.command} を起動できません（${run.spawnError}）`)
      return report
    }
    const parsed = parseScriptOutput(run.stdout, this.host.texts())
    if (parsed.problems.length > 0) {
      const prefix = run.status !== undefined && run.status !== 0 ? `終了コード ${String(run.status)}；` : ''
      for (const problem of parsed.problems) report.problems.push(`${prefix}${problem}`)
      return report
    }
    // A tool that prints a usable version and still exits non-zero told us what
    // we asked for, so the values are kept and the exit code is surfaced beside
    // them rather than costing the run.
    if (run.status !== undefined && run.status !== 0) {
      report.warnings.push(`終了コード ${String(run.status)}（出力は利用可能で、値を通常通り採用します）`)
    }
    report.variables = parsed.variables
    report.truncated = parsed.truncated
    report.ok = true
    return report
  }
}
