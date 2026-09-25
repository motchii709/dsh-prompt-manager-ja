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
/** Largest number of probes one configuration may declare. */
export declare const MAX_PROBES = 64;
/** Per-probe timeout, used when a probe sets no `timeoutMs` of its own. */
export declare const DEFAULT_PROBE_TIMEOUT_MS = 1500;
/**
 * Ceiling on the whole probing pass. Reaching it does not fail the mount: the
 * remaining probes report {@link ProbeTexts.skipped} instead, so a command that
 * hangs cannot stall a session's startup.
 */
export declare const DEFAULT_PROBE_BUDGET_MS = 8000;
/** Longest value a probe may contribute to the prompt. */
export declare const MAX_PROBE_VALUE = 120;
/** What a probe contributes when it cannot contribute a version. */
export interface ProbeTexts {
    /** The executable could not be started. */
    missing: string;
    /** The executable ran and printed nothing. */
    empty: string;
    /** The executable outlived its timeout. */
    timeout: string;
    /** The pass ran out of budget before this probe started. */
    skipped: string;
}
/** Default placeholder texts, in English and machine-independent. */
export declare const DEFAULT_PROBE_TEXTS: ProbeTexts;
/** One executable a deployment asks this plugin to detect at mount. */
export interface ProbeSpec {
    /** Executable name on `PATH`, or an absolute path for a tool outside it. */
    command: string;
    /** Fixed arguments; passed without a shell unless {@link ProbeSpec.shell} is set. */
    args?: string[] | undefined;
    /**
     * Run the command through the platform shell. Needed on Windows for
     * `.cmd`/`.bat` shims such as `npm` and `pnpm`, which cannot be spawned
     * directly.
     */
    shell?: boolean | undefined;
    /**
     * Optional regular expression whose first capture group narrows the value, so
     * `Python 3.12.10` or `git version 2.55.0` can feed a bare `3.12.10`. When it
     * does not match, the untrimmed first line is used instead.
     */
    pattern?: string | undefined;
    /** Timeout for this probe alone, in milliseconds. */
    timeoutMs?: number | undefined;
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
export declare const DEFAULT_PROBES: Readonly<Record<string, ProbeSpec>>;
/** What one process run reported, normalized across success and failure. */
export interface ProbeRun {
    /** `error.code` when the process could not be started at all, e.g. `ENOENT`. */
    spawnError: string | undefined;
    /** Exit code, when the process ran at all. */
    status: number | undefined;
    /** Captured standard output. */
    stdout: string;
    /** Captured standard error; some tools print their version there. */
    stderr: string;
    /** The runner killed the process when its timeout expired. */
    timedOut: boolean;
}
/** Runs one probe's command. Replaced in tests, so no real tool is needed. */
export type ProbeRunner = (command: string, args: string[], options: {
    shell: boolean;
    timeoutMs: number;
}) => ProbeRun;
/** One probe's result, as {@link runProbes} reports it. */
export interface ProbeOutcome {
    /** The variable name this probe feeds. */
    name: string;
    /** The value to register; never empty. */
    value: string;
    /** Wall time this probe took, in milliseconds. */
    ms: number;
}
/** The result of a probing pass. */
export interface ProbeReport {
    /** One outcome per probe that ran or was skipped, in declaration order. */
    outcomes: ProbeOutcome[];
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
export declare const defaultProbeRunner: ProbeRunner;
/**
 * The value one probe contributes.
 * @param spec - the probe to run.
 * @param run - process runner; the real one by default.
 * @param texts - placeholders for the outcomes that carry no version.
 * @returns a non-empty string, whatever happened.
 */
export declare function probeValue(spec: ProbeSpec, run?: ProbeRunner, texts?: ProbeTexts): string;
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
export declare function normalizeProbes(raw: unknown): {
    specs: Record<string, ProbeSpec>;
    problems: string[];
};
/**
 * Probe every declared command once, in declaration order.
 * @param specs - usable specs, as {@link normalizeProbes} returns them.
 * @param options - runner, placeholder texts, total budget, and clock.
 * @returns one outcome per probe, none of which can be empty.
 */
export declare function runProbes(specs: Record<string, ProbeSpec>, options?: {
    run?: ProbeRunner | undefined;
    texts?: ProbeTexts | undefined;
    budgetMs?: number | undefined;
    now?: (() => number) | undefined;
}): ProbeReport;
//# sourceMappingURL=probe.d.ts.map