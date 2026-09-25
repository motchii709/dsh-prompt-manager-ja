/**
 * Mount-time detection of the tools a machine actually has.
 *
 * A prompt variable's provider is evaluated synchronously on every assembly, so
 * a value that costs a subprocess cannot be computed there: this plugin probes
 * once, when it mounts, and then serves the measured strings from memory.
 *
 * Every probe yields a string. A tool that is absent, one that prints nothing,
 * and one that hangs are all ordinary outcomes, because a variable that resolves
 * to `undefined` makes every section referencing it fail to render — one missing
 * tool would cost the whole system prompt.
 *
 * @module @lolkda/dsh-prompt-manager/probe
 */

import { spawnSync } from 'node:child_process'

/** Largest number of probes one configuration may declare. */
export const MAX_PROBES = 64

/** Per-probe timeout, used when a probe sets no `timeoutMs` of its own. */
export const DEFAULT_PROBE_TIMEOUT_MS = 1500

/**
 * Ceiling on the whole probing pass. Reaching it does not fail the mount: the
 * remaining probes report {@link ProbeTexts.skipped} instead, so a command that
 * hangs cannot stall a session's startup.
 */
export const DEFAULT_PROBE_BUDGET_MS = 8000

/** Longest value a probe may contribute to the prompt. */
export const MAX_PROBE_VALUE = 120

/** Largest amount of output read back from one probe. */
const MAX_PROBE_OUTPUT = 64 * 1024

/** Exit codes shells use for "no such command": POSIX 127, cmd.exe 9009. */
const NOT_FOUND_STATUS = [127, 9009]

/** Valid prompt-variable names, mirroring the registry's own rule. */
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/

/** What a probe contributes when it cannot contribute a version. */
export interface ProbeTexts {
  /** The executable could not be started. */
  missing: string
  /** The executable ran and printed nothing. */
  empty: string
  /** The executable outlived its timeout. */
  timeout: string
  /** The pass ran out of budget before this probe started. */
  skipped: string
}

/** Default placeholder texts, in English and machine-independent. */
export const DEFAULT_PROBE_TEXTS: ProbeTexts = {
  missing: '(not installed)',
  empty: '(no output)',
  timeout: '(timeout)',
  skipped: '(skipped)',
}

/** One executable a deployment asks this plugin to detect at mount. */
export interface ProbeSpec {
  /** Executable name on `PATH`, or an absolute path for a tool outside it. */
  command: string
  /** Fixed arguments; passed without a shell unless {@link ProbeSpec.shell} is set. */
  args?: string[] | undefined
  /**
   * Run the command through the platform shell. Needed on Windows for
   * `.cmd`/`.bat` shims such as `npm` and `pnpm`, which cannot be spawned
   * directly.
   */
  shell?: boolean | undefined
  /**
   * Optional regular expression whose first capture group narrows the value, so
   * `Python 3.12.10` or `git version 2.55.0` can feed a bare `3.12.10`. When it
   * does not match, the untrimmed first line is used instead.
   */
  pattern?: string | undefined
  /** Timeout for this probe alone, in milliseconds. */
  timeoutMs?: number | undefined
}

/**
 * Probes the built-in machine-environment prompt needs, so a deployment that
 * configures nothing still resolves every `{{...}}` that body references.
 *
 * They are ordinary probes: `config.probes` overrides any of them by name, and
 * `probeDefaults: false` drops them all. Dropping them while the built-in body
 * is still in force leaves its variables unregistered, which fails assembly, so
 * the two settings belong together.
 */
export const DEFAULT_PROBES: Readonly<Record<string, ProbeSpec>> = {
  pwsh: { command: 'pwsh', args: ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'] },
  bash: { command: 'bash', args: ['--version'], pattern: 'version ([0-9.]+)' },
  git: { command: 'git', args: ['--version'], pattern: '([0-9]+\.[0-9]+\.[0-9]+)' },
  node: { command: 'node', args: ['--version'], pattern: 'v?([0-9.]+)' },
  python: { command: 'python', args: ['--version'], pattern: '([0-9.]+)' },
}

/** What one process run reported, normalized across success and failure. */
export interface ProbeRun {
  /** `error.code` when the process could not be started at all, e.g. `ENOENT`. */
  spawnError: string | undefined
  /** Exit code, when the process ran at all. */
  status: number | undefined
  /** Captured standard output. */
  stdout: string
  /** Captured standard error; some tools print their version there. */
  stderr: string
  /** The runner killed the process when its timeout expired. */
  timedOut: boolean
}

/** Runs one probe's command. Replaced in tests, so no real tool is needed. */
export type ProbeRunner = (command: string, args: string[], options: { shell: boolean; timeoutMs: number }) => ProbeRun

/** One probe's result, as {@link runProbes} reports it. */
export interface ProbeOutcome {
  /** The variable name this probe feeds. */
  name: string
  /** The value to register; never empty. */
  value: string
  /** Wall time this probe took, in milliseconds. */
  ms: number
}

/** The result of a probing pass. */
export interface ProbeReport {
  /** One outcome per probe that ran or was skipped, in declaration order. */
  outcomes: ProbeOutcome[]
}

/**
 * Run a command and collect both streams.
 *
 * `spawnSync` rather than `execFileSync`, because the latter discards standard
 * error on success — and some tools, `java -version` among them, print their
 * version there while exiting zero.
 *
 * @param command - executable name or absolute path.
 * @param args - fixed arguments.
 * @param options - whether to use a shell, and the timeout.
 * @returns the normalized run.
 */
export const defaultProbeRunner: ProbeRunner = (command, args, options) => {
  const result = spawnSync(command, args, {
    shell: options.shell,
    timeout: options.timeoutMs,
    windowsHide: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: MAX_PROBE_OUTPUT,
  })
  const code = result.error === undefined ? undefined : (result.error as NodeJS.ErrnoException).code
  return {
    spawnError: code === undefined || code === 'ETIMEDOUT' ? undefined : code,
    status: typeof result.status === 'number' ? result.status : undefined,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    timedOut: code === 'ETIMEDOUT',
  }
}

/**
 * Message text of an unknown thrown value.
 * @param error - the caught value.
 * @returns a human-facing message.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * First line carrying anything.
 * @param text - raw output, possibly multi-line or blank.
 * @returns the trimmed line, or `undefined` when nothing was printed.
 */
function firstLine(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length > 0) return trimmed
  }
  return undefined
}

/**
 * Apply an optional pattern to a line.
 * @param line - the first non-empty output line.
 * @param pattern - optional regular expression; its first capture group wins.
 * @returns the value to register, never longer than {@link MAX_PROBE_VALUE}.
 */
function narrow(line: string, pattern: string | undefined): string {
  const fallback = line.slice(0, MAX_PROBE_VALUE)
  if (pattern === undefined || pattern.length === 0) return fallback
  try {
    const match = new RegExp(pattern).exec(line)
    if (match === null) return fallback
    return (match[1] ?? match[0]).slice(0, MAX_PROBE_VALUE)
  } catch {
    return fallback
  }
}

/**
 * The value one probe contributes.
 * @param spec - the probe to run.
 * @param run - process runner; the real one by default.
 * @param texts - placeholders for the outcomes that carry no version.
 * @returns a non-empty string, whatever happened.
 */
export function probeValue(
  spec: ProbeSpec,
  run: ProbeRunner = defaultProbeRunner,
  texts: ProbeTexts = DEFAULT_PROBE_TEXTS,
): string {
  const result = run(spec.command, spec.args ?? [], {
    shell: spec.shell ?? false,
    timeoutMs: spec.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
  })
  if (result.timedOut) return texts.timeout
  if (result.spawnError !== undefined) return texts.missing
  if (result.status !== undefined && NOT_FOUND_STATUS.includes(result.status) && result.stdout.trim().length === 0) {
    return texts.missing
  }
  const line = firstLine(result.stdout) ?? firstLine(result.stderr)
  if (line === undefined) return texts.empty
  return narrow(line, spec.pattern)
}

/** Is this a JSON object rather than an array or a scalar? */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Accept the `probes` config value in whatever shape a composition delivers and
 * keep only the specs that can be run.
 *
 * Reports rather than throws: the caller decides whether a malformed probe is a
 * composition error worth failing the mount over.
 *
 * @param raw - the config value.
 * @returns the usable specs, plus one problem message per dropped entry.
 */
export function normalizeProbes(raw: unknown): { specs: Record<string, ProbeSpec>; problems: string[] } {
  const specs: Record<string, ProbeSpec> = {}
  const problems: string[] = []
  if (raw === undefined || raw === null) return { specs, problems }
  if (!isRecord(raw)) {
    return { specs, problems: ['probes must be a mapping of variable name to a spec'] }
  }
  for (const [name, value] of Object.entries(raw)) {
    if (!VARIABLE_NAME.test(name)) {
      problems.push(`probe name ${JSON.stringify(name)} is not a usable variable name (must match ${String(VARIABLE_NAME)})`)
      continue
    }
    if (!isRecord(value)) {
      problems.push(`probe ${name} must be a mapping with a command`)
      continue
    }
    const command = typeof value['command'] === 'string' ? value['command'].trim() : ''
    if (command.length === 0) {
      problems.push(`probe ${name} needs a non-empty command`)
      continue
    }
    let args: string[] = []
    const rawArgs = value['args']
    if (rawArgs !== undefined) {
      if (!Array.isArray(rawArgs) || rawArgs.some((entry) => typeof entry !== 'string')) {
        problems.push(`probe ${name} has args that are not a list of strings`)
        continue
      }
      args = rawArgs as string[]
    }
    const spec: ProbeSpec = { command, args }
    if (typeof value['shell'] === 'boolean') spec.shell = value['shell']
    const pattern = value['pattern']
    if (pattern !== undefined) {
      if (typeof pattern !== 'string' || pattern.length === 0) {
        problems.push(`probe ${name} has a pattern that is not a non-empty string`)
        continue
      }
      try {
        new RegExp(pattern)
      } catch (error) {
        problems.push(`probe ${name} has a pattern that is not a regular expression: ${messageOf(error)}`)
        continue
      }
      spec.pattern = pattern
    }
    const timeoutMs = value['timeoutMs']
    if (timeoutMs !== undefined) {
      if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        problems.push(`probe ${name} has a timeoutMs that is not a positive number`)
        continue
      }
      spec.timeoutMs = Math.trunc(timeoutMs)
    }
    specs[name] = spec
  }
  return { specs, problems }
}

/**
 * Probe every declared command once, in declaration order.
 * @param specs - usable specs, as {@link normalizeProbes} returns them.
 * @param options - runner, placeholder texts, total budget, and clock.
 * @returns one outcome per probe, none of which can be empty.
 */
export function runProbes(
  specs: Record<string, ProbeSpec>,
  options: {
    run?: ProbeRunner | undefined
    texts?: ProbeTexts | undefined
    budgetMs?: number | undefined
    now?: (() => number) | undefined
  } = {},
): ProbeReport {
  const run = options.run ?? defaultProbeRunner
  const texts = options.texts ?? DEFAULT_PROBE_TEXTS
  const budgetMs = options.budgetMs ?? DEFAULT_PROBE_BUDGET_MS
  const now = options.now ?? ((): number => Date.now())
  const started = now()
  const outcomes: ProbeOutcome[] = []
  for (const [name, spec] of Object.entries(specs)) {
    if (now() - started >= budgetMs) {
      outcomes.push({ name, value: texts.skipped, ms: 0 })
      continue
    }
    const probeStarted = now()
    const value = probeValue(spec, run, texts)
    outcomes.push({ name, value, ms: now() - probeStarted })
  }
  return { outcomes }
}
