/**
 * Manage DeepSeek Harness system-prompt sections from the Web GUI.
 *
 * The prompt is a list of entries. Each entry's index record — title, order,
 * enabled — lives in the `prompt-manager` settings namespace, and its markdown
 * body is resolved from the first source that has one: a subscription snapshot,
 * a file under the store directory, or the body this package ships. A fresh
 * install therefore starts with the built-in machine-environment prompt, and
 * anything a person writes or subscribes replaces it.
 *
 * Section text is resolved per assembly, so enabling, disabling, adding, or
 * rewriting an entry takes effect on the next model step — no restart. The host
 * module itself is loaded once at profile startup, so changing `lib/` needs a
 * restart; the browser bundle does not, because `dsh-client-hmr` re-hashes it and
 * pushes the new revision to open pages.
 *
 * The section text is interpolated against prompt variables at each assembly.
 * This plugin registers `{{os}}`, `{{os_release}}`, `{{platform}}`, `{{arch}}`,
 * `{{home}}`, `{{dsh_home}}`, `{{user}}`, and `{{host}}`, plus any fixed
 * `variables` given in config, plus one variable per `probes` entry — a command
 * whose output is measured once at mount, because a provider is evaluated
 * synchronously on every assembly and must not spawn a process. Any other row
 * may register variables as well; a name this plugin cannot take is reported and
 * skipped rather than failing the mount.
 *
 * Which sections reach the prompt is decided per assembly: the session's chosen
 * preset answers it while one is in force, and each entry's own `enabled` flag
 * answers it otherwise. Compression is a separate manual session choice; a
 * preset switch never changes it.
 *
 * @module @lolkda/dsh-prompt-manager
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only side-effect import: the declaration augments `Context` with the
// `systemPrompt` service this plugin contributes to, and an augmentation only
// applies when its module is part of the program. Erased at emit, so there is no
// runtime import.
import type {} from '@deepseek-ai/dsh-system-prompt'
import { createRequire } from 'node:module'
import { homedir, hostname, release, userInfo } from 'node:os'
import { join } from 'node:path'
import {
  activeCompactionOf,
  activePresetOf,
  BUILTIN_PROMPTS,
  buildIndexSchema,
  builtinEntries,
  entryIdFor,
  MAX_ENTRIES,
  parseEntries,
  parsePresets,
  readBuiltinBody,
  type PromptEntry,
  type PromptPreset,
  type ResolvedBody,
  type SchemaFactory,
} from './entries.js'
import { installCompactionPrompt, type CompactionPromptStats } from './compaction.js'
import { SessionChoices } from './sessions.js'
import { installPromptRoutes } from './routes.js'
import { sanitizeReferences } from './guard.js'
import {
  buildPack,
  planImport,
  writePackBodies,
  type PackApplyResult,
  type PackImportReport,
  type PackMember,
  type PackSourceRef,
  type PromptPack,
} from './pack.js'
import { PromptStore } from './store.js'
import { normalizeMirror, parseSources, type PromptSource } from './source.js'
import { Subscriptions, type SubscriptionLocation } from './subscriptions.js'
import type { ProxyConfig } from './net.js'
import {
  DEFAULT_PROBES,
  DEFAULT_PROBE_TEXTS,
  MAX_PROBES,
  normalizeProbes,
  runProbes,
  type ProbeSpec,
  type ProbeTexts,
} from './probe.js'
import {
  cleanDrafts,
  normalizeScriptOverrides,
  PromptScripts,
  SCRIPTS_DIR_NAME,
  type ScriptOverride,
} from './scripts.js'

export { MAX_BODY_BYTES, MAX_ENTRIES, MAX_PRESETS } from './entries.js'
export { PromptStore } from './store.js'
export { ROUTE_PREFIX } from './routes.js'
export { MAX_PROBES } from './probe.js'
export { BUILTIN_PROMPTS } from './entries.js'
export { MAX_SCRIPTS, MAX_SCRIPT_BYTES, SCRIPTS_DIR_NAME } from './scripts.js'

/** Cordis plugin name. Distinct from the bare `prompt-manager` an unrelated package uses. */
export const name = 'dsh-prompt-manager'

/** The prompt registry this row contributes to. */
export const inject: string[] = ['systemPrompt']

/** Section-name prefix of every entry this plugin registers. */
export const USER_SECTION_PREFIX = 'user:prompt-manager:'

/** Settings namespace carrying the entry index. */
export const SETTINGS_NAMESPACE = 'prompt-manager'

/** Directory name appended to the resolved Harness home holding the bodies. */
export const STORE_DIR_NAME = 'prompt-manager'

/** Valid prompt-variable names, mirroring the registry's own rule. */
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/

/** Friendly names for the platforms this harness realistically runs on. */
const PLATFORM_NAMES: Readonly<Record<string, string>> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
  freebsd: 'FreeBSD',
  openbsd: 'OpenBSD',
  netbsd: 'NetBSD',
  sunos: 'Solaris',
  aix: 'AIX',
}

/** Facts about the process running the harness, exposed as prompt variables. */
export interface EnvironmentFacts {
  /** Friendly platform name, e.g. `Windows`. */
  os: string
  /** `os.release()`: Windows build, Linux kernel, or macOS Darwin version. */
  os_release: string
  /** Raw `process.platform`, e.g. `win32`. */
  platform: string
  /** Raw `process.arch`, e.g. `x64`. */
  arch: string
  /** `os.homedir()`: the user's home directory. */
  home: string
  /** The resolved harness home: `$DSH_HOME`, or `~/.dsh` when it is unset. */
  dsh_home: string
  /** `os.userInfo().username`: the account the harness runs as. */
  user: string
  /** `os.hostname()`: the machine's name. */
  host: string
}

/** Plugin config: the prompt variables it registers and where bodies are stored. */
export interface Config {
  /**
   * Register {@link environmentFacts} as prompt variables. Defaults to `true`;
   * set `false` when no entry references them, or when another row already owns
   * those names.
   */
  environment?: boolean
  /**
   * Extra `{{name}}` variables with fixed values. Names must match
   * `[a-z][a-z0-9_]*` and must not repeat a registered name.
   */
  variables?: Record<string, string>
  /**
   * Commands to run once when this plugin mounts, one prompt variable each. The
   * value is the first non-empty output line, narrowed by the probe's `pattern`
   * when it has one; a tool that is absent, silent, or too slow contributes a
   * placeholder from {@link Config.probeTexts} instead. Nothing here runs again
   * until the row remounts, so a newly installed tool shows up after a
   * composition change or a restart, not on its own.
   *
   * These override {@link DEFAULT_PROBES} by name.
   */
  probes?: Record<string, ProbeSpec>
  /**
   * Run the package's own {@link DEFAULT_PROBES} alongside `probes`. Defaults to
   * `true`, which is what makes the built-in environment entry resolve without
   * any configuration. Set `false` only together with entries that reference none
   * of those variables.
   */
  probeDefaults?: boolean
  /** Replace the placeholder texts a probe contributes when it yields no version. */
  probeTexts?: Partial<ProbeTexts>
  /** Total time the pass may spend, in milliseconds. Defaults to 8000. */
  probeBudgetMs?: number
  /**
   * Per-script execution overrides, keyed by script name. A script is a file a
   * person wrote under the store's `scripts/` directory whose standard output is
   * a JSON object of prompt variables; this only changes how one is run —
   * interpreter, arguments, timeout. A script that needs no change runs under
   * `node`, in three seconds, with its own path as the only argument.
   */
  scripts?: Record<string, ScriptOverride>
  /**
   * Directory holding one markdown file per entry, under a `sections/`
   * subdirectory, and one script per file under `scripts/`. Defaults to
   * `$DSH_HOME/prompt-manager`, where `$DSH_HOME` is the environment value when
   * set and `~/.dsh` otherwise.
   */
  storeDir?: string
  /**
   * Replace the instruction a context compaction sends to its summarizer with
   * the body of the entry the index puts in force. Defaults to `true`; set
   * `false` when another row owns that seam, or to keep this plugin strictly to
   * the system prompt.
   *
   * The default changes nothing: with no entry in force — which is every
   * deployment that never made one — every compaction call goes out exactly as
   * the engine built it.
   */
  compaction?: boolean
}

/** Where one plugin-owned prompt variable's value came from. */
export type VariableSource = 'environment' | 'config' | 'probe' | 'script'

/**
 * Known DSH agent-loop references. Catalogue metadata only: the plugin must not
 * register providers for them or turn one agent's values into profile globals.
 */
const DSH_CONTEXT_VARIABLES = {
  cwd: '現在のセッションの作業ディレクトリ（ホストの起動ディレクトリではありません）',
  model: '現在の agent が使用するモデル ID。モデル切り替え後、次の組み立て時に更新されます',
  provider: '現在の agent が使用するモデルプロバイダ ID',
} as const

/** One prompt variable, as the settings page sees it. */
export interface VariableView {
  /** The `{{name}}` reference. */
  name: string
  /** A profile-wide value, omitted for DSH's per-agent/per-session references. */
  value?: string | undefined
  /** Which layer supplies it; `dsh` denotes context-dependent native references. */
  source: VariableSource | 'dsh'
  /** Owning script name, or an explanation of a native reference. */
  detail?: string | undefined
  /** When a profile-wide value was last written; absent for native references. */
  updatedAt?: string | undefined
  /** Titles of the prompt entries whose bodies reference this variable. */
  referencedBy: string[]
}

/** A settings scope this plugin reads its index through and writes it back to. */
interface SettingsScopeFace {
  /** Merge editable fields into the namespace document. */
  update(patch: Record<string, unknown>): Promise<void>
  /** The namespace document as currently resolved. */
  get(): unknown
  /** Re-run the listener on every commit; returns the disposer. */
  watch(listener: () => void): () => void
}

/** The `settings` service slice this plugin owns its index through. */
interface SettingsFace {
  /**
   * Open this plugin's settings namespace with built-in defaults.
   *
   * @param ns - namespace id, which is this plugin's legacy `prompt-manager`.
   * @param schema - the index schema built from the schemastery factory.
   * @param opts - the base layer: what a deployment that configured nothing gets.
   */
  register(ns: string, schema: unknown, opts: { base: Record<string, unknown> }): SettingsScopeFace
}

/** Friendly platform name for the running process. */
function platformName(): string {
  return PLATFORM_NAMES[process.platform] ?? process.platform
}

/**
 * What a machine fact falls back to when the process cannot report it.
 *
 * A registered variable must never resolve to the empty string — the registry
 * throws on an undefined value, and one throwing section fails the assembly, so
 * every model step of the profile would fail. The wording matches the probe
 * placeholders a missing tool gets.
 */
const UNKNOWN_FACT = '(unknown)'

/**
 * Facts about the running process, as prompt-variable values.
 *
 * Every one of these is a process-level fact, fixed for as long as the profile
 * runs. Deliberately absent: the *session's* working directory and the model in
 * use. The registry's `AssembleContext` carries only a scope key and a signal,
 * so those are not reachable from a variable provider — and publishing the host
 * process's `process.cwd()` under the name `cwd` would invite exactly the wrong
 * reading, since a session's workspace can be a different directory.
 *
 * @returns one value per environment variable this plugin registers.
 */
export function environmentFacts(): EnvironmentFacts {
  return {
    os: platformName(),
    os_release: release(),
    platform: process.platform,
    arch: process.arch,
    home: factOrUnknown(() => homedir()),
    dsh_home: resolveHarnessHome(),
    user: factOrUnknown(() => userInfo().username),
    host: factOrUnknown(() => hostname()),
  }
}

/**
 * Read one machine fact, substituting {@link UNKNOWN_FACT} for anything the
 * platform declines to answer — `os.userInfo()` throws on a system with no
 * account, and an empty return value is just as unusable.
 *
 * @param read - the fact to read.
 * @returns the value, or the placeholder.
 */
function factOrUnknown(read: () => string): string {
  try {
    const value = read().trim()
    return value.length > 0 ? value : UNKNOWN_FACT
  } catch {
    return UNKNOWN_FACT
  }
}

/**
 * The harness home directory: `$DSH_HOME` when it names one, `~/.dsh` otherwise.
 *
 * The one place this is decided, so the `{{dsh_home}}` variable and the store
 * directory can never disagree about where the harness keeps its files.
 *
 * @returns an absolute path.
 */
export function resolveHarnessHome(): string {
  const home = process.env['DSH_HOME']?.trim()
  return home !== undefined && home.length > 0 ? home : join(homedir(), '.dsh')
}

/**
 * Resolve the directory holding the entry bodies and the settings files.
 * @param config - plugin config; `storeDir` wins when it names a directory.
 * @returns an absolute path, without the `sections` leaf.
 */
export function resolveStoreDir(config: Config = {}): string {
  const configured = config.storeDir?.trim()
  if (configured !== undefined && configured.length > 0) return configured
  return join(resolveHarnessHome(), STORE_DIR_NAME)
}

/**
 * Load the schemastery factory a settings namespace needs.
 *
 * Read through `createRequire` rather than a static import: a deployment
 * without the settings capability also has no schemastery, and this plugin must
 * still mount there with its composed configuration.
 *
 * @returns the schema factory, or `undefined` when it cannot be resolved.
 */
function loadSchemaFactory(): SchemaFactory | undefined {
  try {
    const loaded: unknown = createRequire(import.meta.url)('@deepseek-ai/schemastery')
    const candidate: unknown = typeof loaded === 'function'
      ? loaded
      : (loaded as { default?: unknown } | null)?.default
    if (typeof candidate !== 'function') return undefined
    const factory = candidate as unknown as Partial<SchemaFactory>
    if (typeof factory.object !== 'function' || typeof factory.array !== 'function') return undefined
    return factory as SchemaFactory
  } catch {
    return undefined
  }
}

/**
 * This package's own manifest identity, read at most once.
 *
 * Read through `createRequire` because `package.json` sits beside `lib/` rather
 * than inside the emitted program, and a deployment that ships only the built
 * files must still be able to write a pack — empty header values are a cosmetic
 * loss, not a failure. Both values are read rather than hardcoded so a rename can
 * never leave the exported header naming a package that no longer exists.
 *
 * @returns the package name and version, empty strings when they cannot be read.
 */
function ownManifest(): { name: string; version: string } {
  if (ownManifestCache !== undefined) return ownManifestCache
  let manifest = { name: '', version: '' }
  try {
    const loaded: unknown = createRequire(import.meta.url)('../package.json')
    const record = loaded as { name?: unknown; version?: unknown }
    manifest = {
      name: typeof record.name === 'string' ? record.name : '',
      version: typeof record.version === 'string' ? record.version : '',
    }
  } catch {
    manifest = { name: '', version: '' }
  }
  ownManifestCache = manifest
  return manifest
}

/** Cache for {@link ownManifest}. */
let ownManifestCache: { name: string; version: string } | undefined

/**
 * Report a non-fatal problem without ever breaking the mount.
 * @param ctx - plugin context owning the logger.
 * @param message - the detail to report.
 */
function warn(ctx: Context, message: string): void {
  try {
    ctx.logger?.warn(`dsh-prompt-manager: ${message}`)
  } catch {
    /* logging must never be the reason a session cannot assemble a prompt */
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
 * One named field of a resolved settings document.
 *
 * A hand-edited or half-written document can hold anything, so every read of one
 * goes through here rather than assuming the shape the schema describes.
 *
 * @param document - the resolved namespace value.
 * @param name - the field to read.
 * @returns the field value, or `undefined` when there is no object to read.
 */
function fieldOf(document: unknown, name: string): unknown {
  return typeof document === 'object' && document !== null && !Array.isArray(document)
    ? (document as Record<string, unknown>)[name]
    : undefined
}

/**
 * Register the prompt sections, their variables, the settings index, and the
 * body-file route.
 *
 * @param ctx - Cordis context carrying the `systemPrompt` service.
 * @param config - optional overrides for variables and storage.
 */
export function apply(ctx: Context, config: Config = {}): void {
  /** Placeholder texts, shared by probes and scripts. */
  const texts: ProbeTexts = { ...DEFAULT_PROBE_TEXTS, ...config.probeTexts }

  /**
   * The variables in force, keyed by reference name.
   *
   * The provider handed to the registry reads this map instead of a captured
   * value, so refreshing a value costs one assignment here and nothing at the
   * registry. That is what lets a script's output change without a restart, and
   * it is also what guarantees every `{{name}}` resolves to a non-empty string
   * for as long as it is registered.
   */
  const variables = new Map<string, {
    value: string
    source: VariableSource
    detail?: string | undefined
    updatedAt: string
  }>()

  /**
   * How to unregister each variable's provider.
   *
   * Kept so a variable can be dropped when nothing references it any more — the
   * disposer Cordis handed back when the provider was registered.
   */
  const variableDisposers = new Map<string, () => void>()

  /**
   * Whether any entry currently references one variable.
   *
   * Filled in once the index exists; the engine asks during mount, before the
   * per-entry bodies have been read, so the default answers "no reference" —
   * which at that point is true, because nothing has been declared yet.
   */
  let isReferenced: (variable: string) => boolean = () => false

  /**
   * Scripts currently on disk.
   *
   * A variable keeps its name and value after the script that supplied it is
   * deleted — a missing value would fail assembly — but a name whose script is
   * gone for good is adoptable, so renaming a script does not leave its old
   * variables owned by a file that no longer exists. Filled in once the engine
   * exists; nothing declared before that can be a script variable.
   */
  let onDiskScripts: () => string[] = () => []

  /**
   * Offer one prompt variable, registering its provider the first time.
   *
   * A name another source already owns is refused rather than overwritten: the
   * registry throws on a duplicate, and one contested name must not cost the
   * whole mount.
   *
   * @param variable - the `{{name}}` to serve; validated by the caller.
   * @param value - the value assemblies will see; never empty.
   * @param source - which layer the value came from.
   * @param detail - owning script name, for a script variable.
   * @returns `assigned` when this source already owned the name, `declared` when
   * it was free, `conflict` when something else owns it.
   */
  function declareVariable(
    variable: string,
    value: string,
    source: VariableSource,
    detail?: string,
  ): 'assigned' | 'declared' | 'conflict' {
    const existing = variables.get(variable)
    if (existing !== undefined) {
      const sameOwner = existing.source === source && existing.detail === detail
      const adoptable = !sameOwner
        && existing.source === 'script'
        && source === 'script'
        && existing.detail !== undefined
        && !onDiskScripts().includes(existing.detail)
      if (!sameOwner && !adoptable) return 'conflict'
      existing.value = value
      existing.source = source
      existing.detail = detail
      existing.updatedAt = new Date().toISOString()
      return 'assigned'
    }
    variables.set(variable, { value, source, detail, updatedAt: new Date().toISOString() })
    try {
      const dispose = ctx.effect(
        () => ctx.systemPrompt.variable(variable, () => variables.get(variable)?.value ?? texts.missing),
        `dsh-prompt-manager.variable(${variable})`,
      )
      variableDisposers.set(variable, dispose)
    } catch (error) {
      variables.delete(variable)
      warn(ctx, `cannot register the prompt variable ${variable}, so entries referencing it will not assemble: ${messageOf(error)}`)
      return 'conflict'
    }
    return 'declared'
  }

  /**
   * Let go of one variable this plugin registered.
   *
   * Unregistering the provider as well as dropping the record, because a
   * registered name with no value is worse than no name at all: the reference
   * would resolve to the placeholder text instead of being reported as the
   * unresolvable one it has become.
   *
   * @param variable - the `{{name}}` to drop.
   * @param detail - the script that declared it; another owner's name is kept.
   */
  function forgetVariable(variable: string, detail: string): void {
    const record = variables.get(variable)
    if (record === undefined) return
    if (record.source !== 'script' || record.detail !== detail) return
    variables.delete(variable)
    const dispose = variableDisposers.get(variable)
    variableDisposers.delete(variable)
    if (dispose !== undefined) dispose()
  }

  /**
   * The layer a variable's value came from, in the words the log reader needs.
   * @param record - the variable record in force.
   * @returns a short label naming the owner.
   */
  function ownerLabel(record: { source: VariableSource; detail?: string | undefined }): string {
    if (record.source === 'script') return `スクリプト ${record.detail ?? '?'}`
    if (record.source === 'config') return 'config.variables'
    if (record.source === 'probe') return 'プローブ'
    return '環境変数'
  }

  /**
   * Offer one prompt variable, reporting a name this plugin already handed out.
   *
   * A name taken by another row is reported where the registry refuses it, so
   * only the conflict this plugin resolves by itself needs a voice here — and it
   * needs one: the losing layer is otherwise dropped in silence, and a person
   * reading `{{os}}` in an entry would have no way to learn why their
   * `variables` entry never took effect.
   *
   * @param variable - the `{{name}}` to serve; validated by the caller.
   * @param value - the value assemblies will see.
   * @param source - which layer the value came from.
   */
  function declareOrReport(variable: string, value: string, source: VariableSource): void {
    if (declareVariable(variable, value, source) !== 'conflict') return
    const owner = variables.get(variable)
    if (owner === undefined) return
    warn(
      ctx,
      `${variable} は既に${ownerLabel(owner)}から提供されています（現在の値 ${JSON.stringify(owner.value)}）。今回 ${ownerLabel({ source })} が提供した値は無視されました`,
    )
  }

  const facts = environmentFacts()
  if (config.environment ?? true) {
    for (const [variable, value] of Object.entries(facts)) declareOrReport(variable, value, 'environment')
  }
  for (const [variable, value] of Object.entries(config.variables ?? {})) {
    if (!VARIABLE_NAME.test(variable)) {
      throw new Error(`dsh-prompt-manager: invalid variable name ${JSON.stringify(variable)} (must match ${String(VARIABLE_NAME)})`)
    }
    declareOrReport(variable, value, 'config')
  }

  // A malformed probe is a composition mistake, so it fails the mount loudly
  // rather than leaving a `{{name}}` that no assembly can resolve. Whether a
  // probed tool exists, stays silent, or hangs is a value, not an error.
  const probed = normalizeProbes(config.probes)
  if (probed.problems.length > 0) throw new Error(`dsh-prompt-manager: ${probed.problems.join('; ')}`)
  const specs: Record<string, ProbeSpec> = {
    ...((config.probeDefaults ?? true) ? DEFAULT_PROBES : {}),
    ...probed.specs,
  }
  const probeNames = Object.keys(specs)
  if (probeNames.length > MAX_PROBES) {
    throw new Error(`dsh-prompt-manager: at most ${String(MAX_PROBES)} probes are allowed, got ${String(probeNames.length)}`)
  }
  if (probeNames.length > 0) {
    const report = runProbes(specs, { texts, budgetMs: config.probeBudgetMs })
    for (const outcome of report.outcomes) declareOrReport(outcome.name, outcome.value, 'probe')
  }

  const store = new PromptStore(join(resolveStoreDir(config), 'sections'))

  // Script overrides are composition config, so a malformed one fails the mount
  // for the same reason a malformed probe does: it is the deployment's mistake,
  // and leaving it silent would leave a script nobody can run.
  const scriptOverrides = normalizeScriptOverrides(config.scripts)
  if (scriptOverrides.problems.length > 0) throw new Error(`dsh-prompt-manager: ${scriptOverrides.problems.join('; ')}`)

  /**
   * The user-script engine. It owns the files and the runs; every value it
   * produces passes through {@link declareVariable}, so the plugin stays the
   * only writer of its own variable registry.
   */
  const scripts = new PromptScripts({
    dir: () => join(resolveStoreDir(config), SCRIPTS_DIR_NAME),
    overrides: () => scriptOverrides.overrides,
    texts: () => texts,
    declare: (variable, value, detail) => declareVariable(variable, value, 'script', detail),
    owner: (variable) => {
      const record = variables.get(variable)
      if (record === undefined) return undefined
      if (record.source !== 'script') return record.source
      const detail = record.detail ?? 'script'
      // A name left behind by a script that no longer exists is free again.
      return onDiskScripts().includes(detail) ? detail : undefined
    },
    referenced: (variable) => isReferenced(variable),
    forget: (variable, detail) => { forgetVariable(variable, detail) },
    warn: (message) => warn(ctx, message),
  })
  onDiskScripts = () => scripts.names()
  ctx.effect(() => () => { scripts.dispose() }, 'dsh-prompt-manager: script engine')

  // The cached values are read synchronously, so a profile start serves what it
  // saw last without executing anything; only scripts whose file changed while
  // the profile was down are re-run, behind the mount.
  cleanDrafts(scripts.dir)
  const pendingScripts = scripts.mountDeclare()
  if (pendingScripts.length > 0) {
    void scripts.refresh(pendingScripts).catch((error: unknown) => {
      warn(ctx, `a script refresh failed: ${messageOf(error)}`)
    })
  }

  /**
   * The index in force. Seeded with the built-in entries so a deployment without
   * a settings service still gets them; the settings sync below replaces this
   * with the resolved document as soon as one is available.
   */
  const active: PromptEntry[] = builtinEntries()
  /** Live lookup for section text callbacks. */
  const byId = new Map<string, PromptEntry>()
  /** Registered sections, keyed by entry id. */
  const sections = new Map<string, { disposer: () => void; name: string; order: number }>()
  /** The resolved settings document, as the engine reads it. */
  let resolved: unknown = {
    entries: builtinEntries(),
    presets: [],
    activePreset: '',
    sources: [],
    mirror: '',
    proxy: { kind: 'none', url: '' },
  }

  /**
   * The preset in force, or `undefined` when the entries' own switches decide.
   *
   * Read per assembly like everything else here: activation is a settings write,
   * so both the switch itself and a later edit of the preset land on the next
   * model step with no re-registration — section text is a callback, and neither
   * a preset's name nor its membership is part of a section's identity.
   */
  /**
   * Parsed presets for the current settings document, rebuilt on every commit.
   *
   * Cached rather than re-parsed per section: one assembly asks which preset is
   * in force once per registered entry, and the answer is the same every time.
   */
  let presetList: PromptPreset[] = []

  /** Id of the last "no such preset" report, so one broken choice says so once. */
  let presetReported = ''

  /**
   * The per-session half of the index: which preset and which compaction
   * instruction one conversation chose.
   *
   * The index above is a catalog and stays one document for the deployment. What
   * belongs to a conversation is only the pick — and a pick made in one
   * conversation must never reach another, which is why it lives in its own file
   * per session instead of in the settings document every session reads.
   */
  const choices = new SessionChoices(resolveStoreDir(config))

  /**
   * The preset a session put in force, or `undefined` for each entry's own switch.
   *
   * A session that chose nothing, a session whose preset has since been deleted,
   * and an assembly that names no session at all answer the same way: each entry's
   * own switch decides. That is the one answer which cannot change another
   * conversation's prompt, and the one a person can always reason about.
   *
   * @param sessionId - the session this assembly is for, when the caller says.
   * @returns the preset in force for that session, or `undefined`.
   */
  function presetInForceFor(sessionId: string | undefined): PromptPreset | undefined {
    const wanted = choices.effective(sessionId).preset
    if (wanted.length === 0) return undefined
    const found = presetList.find((preset) => preset.id === wanted)
    if (found !== undefined) return found
    if (presetReported !== wanted) {
      presetReported = wanted
      warn(ctx, `セッションが選択したプリセット ${wanted} は存在しません（削除された可能性があります）。今回の組み立ては各エントリのトグルに戻ります`)
    }
    return undefined
  }

  /**
   * The session one assembly is for, when the caller names it.
   *
   * Read structurally rather than declared: `AssembleContext` is merge-extensible
   * and `@deepseek-ai/dsh-agent` is the package that augments it with the agent a
   * section provider is called for, so naming the field here keeps this plugin
   * from depending on that package to say what it already receives.
   *
   * @param context - the assembly context a section provider is handed.
   * @returns the session id, or `undefined` when no agent is in view.
   */
  function sessionIdOf(context: unknown): string | undefined {
    const agent = (context as { agent?: { session?: { id?: unknown } } } | null | undefined)?.agent
    const id = agent?.session?.id
    return typeof id === 'string' ? id : undefined
  }
  /**
   * The id sets already reported as missing from a preset, one signature per
   * preset, so a preset left broken for a week says so once rather than on every
   * assembly.
   */
  const danglingReported = new Set<string>()
  /** Where each subscribed entry's body lives; refreshed when settings commit. */
  let locations = new Map<string, SubscriptionLocation>()
  /** How the engine writes the index back; present only with a settings service. */
  let writeEntries: ((entries: PromptEntry[]) => Promise<void>) | undefined

  /**
   * How an import lands the index and the preset list, in one settings write.
   *
   * Separate from {@link writeEntries} because an import has to place both
   * fields together: a preset whose members were written while its entries were
   * not is an index somebody has to repair by hand, whereas the reverse — bodies
   * on disk that the index does not name — is repaired by importing again, since
   * the ids come back the same.
   */
  let writeIndex: ((patch: { entries: PromptEntry[]; presets: PromptPreset[] }) => Promise<void>) | undefined

  /** One field of the index currently in force. */
  function field(name: string): unknown {
    return fieldOf(resolved, name)
  }

  function sourcesInForce(): PromptSource[] {
    return parseSources(field('sources'))
  }

  function proxyInForce(): ProxyConfig {
    const raw = field('proxy')
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { kind: 'none', url: '' }
    const record = raw as Record<string, unknown>
    return {
      kind: typeof record['kind'] === 'string' ? record['kind'] : 'none',
      url: typeof record['url'] === 'string' ? record['url'] : '',
    }
  }

  function mirrorInForce(): string {
    return normalizeMirror(field('mirror')) ?? ''
  }

  /** The configured presets, narrowed from the settings document. */
  function presetsInForce(): PromptPreset[] {
    return parsePresets(field('presets'))
  }

  /**
   * Re-read the configured presets from the document that just committed.
   *
   * The presets are catalog: every session picks from this same list, and the
   * pick itself lives in that session's own file. This is therefore the only
   * place the list is parsed, however many sections ask who is in force.
   */
  function refreshPresets(): void {
    presetList = presetsInForce()
  }

  /** Reports already made about the compaction pointer, by signature. */
  let compactionReported = ''

  /**
   * The compaction instruction in force, or `undefined` to send DSH's own.
   *
   * The session answers this, and nothing else does: the instruction its own
   * choice names, or DSH's own text when it chose none. A pointer in the shared
   * document could only answer for every conversation at once, which is exactly
   * the bleeding this seam exists to avoid.
   *
   * Every way this can come up empty is reported once and then resolves to the
   * stock instruction. Sending an empty instruction would be worse than useless:
   * the summarizer would be asked to do nothing, and the summary that came back
   * would be whatever the model improvised.
   *
   * @returns the entry id and body to send, or `undefined` for the stock one.
   */
  function resolveCompaction(sessionId: string | undefined): { id: string; text: string } | undefined {
    const wanted = choices.effective(sessionId).compaction
    if (wanted.length === 0) return undefined

    const entry = byId.get(wanted)
    if (entry === undefined || entry.kind !== 'compaction') {
      reportCompaction(
        `absent:${wanted}`,
        `圧縮命令 ${wanted} はインデックスにありません（圧縮エントリではない可能性もあります）。今回の圧縮は DSH 内蔵の命令を使用します`,
      )
      return undefined
    }
    const text = describe(entry.id).text
    if (text.trim().length === 0) {
      reportCompaction(`empty:${wanted}`, `圧縮命令 ${wanted} には本文がありません。今回の圧縮は DSH 内蔵の命令を使用します`)
      return undefined
    }
    return { id: entry.id, text }
  }

  /**
   * Report one problem with the compaction pointer, once per signature.
   * @param signature - what changed since the last report.
   * @param message - what to say.
   */
  function reportCompaction(signature: string, message: string): void {
    if (signature === compactionReported) return
    compactionReported = signature
    warn(ctx, message)
  }

  /**
   * The names a compaction body may reference.
   *
   * The assembly's table when there has been one, and this plugin's own
   * registrations before that: a body is written against what the deployment
   * registers, and the registry may not have run yet when the first compaction
   * happens.
   *
   * @returns the table to interpolate against.
   */
  function compactionVariables(): Readonly<Record<string, string | undefined>> {
    if (lastAssemblyVariables !== undefined) return lastAssemblyVariables
    const own: Record<string, string | undefined> = {}
    for (const [variable, record] of variables) own[variable] = record.value
    return own
  }

  /** The next free placement for an entry the engine adds. */
  function nextOrder(): number {
    let highest = 0
    for (const entry of active) if (entry.order > highest) highest = entry.order
    return highest + 10
  }

  const subscriptions = new Subscriptions({
    sources: sourcesInForce,
    proxy: proxyInForce,
    mirror: mirrorInForce,
    root: () => resolveStoreDir(config),
    entries: () => active,
    setEntries: async (next) => {
      if (writeEntries === undefined) throw new Error('サブスクライブには settings サービスが必要ですが、現在のデプロイにはマウントされていません')
      await writeEntries(next)
    },
    nextOrder,
    warn: (message) => warn(ctx, message),
  })

  /**
   * The body that would reach the prompt for one entry. A subscribed entry reads
   * its snapshot first — its body is upstream's, not this machine's — then a body
   * written here, then the body this package ships for that id. Read per
   * assembly, so an edited or freshly applied file lands on the next model step.
   */
  function describe(id: string): ResolvedBody {
    if (locations.has(id)) {
      const subscribed = subscriptions.readBody(id)
      return subscribed === undefined
        ? { text: '', source: 'empty' }
        : { text: subscribed, source: 'subscribed' }
    }
    try {
      const stored = store.read(id)
      if (stored !== undefined) return { text: stored.body, source: 'user' }
    } catch (error) {
      warn(ctx, messageOf(error))
    }
    const builtin = readBuiltinBody(id)
    if (builtin !== undefined) return { text: builtin, source: 'builtin' }
    return { text: '', source: 'empty' }
  }

  /** Every entry registers under the plugin's own prefix. */
  function sectionNameFor(entry: PromptEntry): string {
    return `${USER_SECTION_PREFIX}${entry.id}`
  }

  /**
   * Build the pack for one preset: its members, each carrying either its body or
   * the source that owns it.
   *
   * That split is the whole point of the format. A local or built-in body is
   * copied into the pack, because nothing else could reproduce it. A subscribed
   * body is *named* rather than copied, because it belongs to a source the
   * importing machine can configure for itself — copying it would silently
   * divorce the entry from upstream. A member the index no longer has cannot be
   * carried at all and is reported instead of quietly left out.
   *
   * @param presetId - the preset to export.
   * @returns the pack, or `undefined` when no such preset exists here.
   */
  function packFor(presetId: string): PromptPack | undefined {
    const preset = presetsInForce().find((candidate) => candidate.id === presetId)
    if (preset === undefined) return undefined
    const sources = sourcesInForce()
    const members: PackMember[] = []
    const missing: string[] = []
    const carried = new Set<string>()
    const addMember = (id: string): void => {
      if (carried.has(id)) return
      const entry = byId.get(id)
      if (entry === undefined) {
        missing.push(id)
        return
      }
      carried.add(id)
      const owner = entry.source !== undefined && entry.source.length > 0
        ? entry.source
        : locations.get(id)?.slug
      if (owner !== undefined) {
        const source = sources.find((candidate) => candidate.id === owner)
        const ref: PackSourceRef = { slug: owner }
        if (source !== undefined) {
          ref.repo = source.repo
          ref.ref = source.ref
        }
        const file = locations.get(id)?.path
        if (file !== undefined) ref.file = file
        members.push({ id, title: entry.title, order: entry.order, enabled: entry.enabled, source: ref })
        return
      }
      const resolved = describe(id)
      const member: PackMember = {
        id,
        title: entry.title,
        order: entry.order,
        enabled: entry.enabled,
        body: resolved.text,
        origin: resolved.source === 'builtin' ? 'builtin' : 'local',
      }
      members.push(member)
    }
    // Legacy settings may have listed a compression entry as a member. It stays
    // available for manual selection, but never belongs to a preset export.
    const sectionIds = preset.entries.filter((id) => byId.get(id)?.kind !== 'compaction')
    for (const id of sectionIds) addMember(id)
    const own = ownManifest()
    return buildPack({ preset: { ...preset, entries: sectionIds }, members, missing, pluginName: own.name, pluginVersion: own.version })
  }

  /**
   * Carry out an import: write the bodies the pack brought, then merge its
   * entries and its preset into the index in a single settings write.
   *
   * Everything refusable is refused before a file is written, and a failure
   * while writing takes back the files this import created, so a refused pack
   * leaves the machine exactly as it was. The index lands last on purpose: a
   * crash in between leaves body files nothing points at, which importing the
   * same pack again repairs, while the opposite order would leave index records
   * whose bodies never existed.
   *
   * @param pack - a pack that already passed {@link parsePack}.
   * @returns what it did, or why it did nothing.
   */
  async function importPack(pack: PromptPack): Promise<PackApplyResult> {
    if (writeIndex === undefined) {
      return { ok: false, code: 'bad-format', message: 'インポートにはインデックス書き込み用の settings サービスが必要ですが、現在のデプロイにはマウントされていません' }
    }
    const planned = planImport(pack, {
      entryIds: takenIds(),
      presetIds: presetsInForce().map((preset) => preset.id),
    })
    if (!planned.ok) return planned
    const { plan } = planned

    writePackBodies(plan.entries, {
      write: (id, body) => {
        // `absent` rather than `any`: an id this import believes is free must not
        // silently replace a body somebody put there a moment ago.
        store.write(id, body, { kind: 'absent' })
      },
      remove: (id) => {
        try {
          store.remove(id)
        } catch (error) {
          warn(ctx, `${id} の本文のロールバックに失敗しました：${messageOf(error)}`)
        }
      },
    })

    const added: PromptEntry[] = plan.entries.map((entry) => {
      const record: PromptEntry = {
        id: entry.id,
        title: entry.title,
        order: entry.order,
        enabled: entry.enabled,
      }
      if (entry.source !== undefined) record.source = entry.source
      if (entry.kind === 'compaction') record.kind = 'compaction'
      return record
    })
    await writeIndex({ entries: [...active, ...added], presets: [...presetsInForce(), plan.preset] })

    const report: PackImportReport = {
      entries: plan.entries.map((entry) => {
        const created: { id: string; title: string; renamedFrom?: string | undefined } = {
          id: entry.id,
          title: entry.title,
        }
        if (entry.renamedFrom !== undefined) created.renamedFrom = entry.renamedFrom
        return created
      }),
      preset: plan.preset,
      renamed: plan.renamed,
      noBody: plan.noBody,
      sourceDropped: plan.sourceDropped,
      missingMembers: plan.missingMembers,
      unregistered: unregisteredReferences(plan.entries.flatMap((entry) => entry.body ?? [])),
    }
    return { ok: true, report }
  }

  /**
   * References absent from the plugin-owned and known DSH-native catalogue.
   *
   * A report, never a refusal: another row may register a name, and a name that
   * is merely unregistered today is a variable somebody is still about to write.
   * The reference guard is what keeps such a body from failing an assembly.
   *
   * @param bodies - the text that arrived in a pack.
   * @returns the distinct names, in the order they first appear.
   */
  function unregisteredReferences(bodies: readonly string[]): string[] {
    const found: string[] = []
    for (const body of bodies) {
      for (const match of body.matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/g)) {
        const reference = match[1]
        if (reference === undefined || variables.has(reference) || Object.hasOwn(DSH_CONTEXT_VARIABLES, reference)) continue
        if (!found.includes(reference)) found.push(reference)
      }
    }
    return found
  }

  /**
   * The text one entry contributes to one session right now, or `''` when it
   * contributes none.
   *
   * A preset in force answers "is this entry on" by itself, and it is the only
   * thing that does: the entry's own switch is left exactly as a person set it,
   * for every session that chose no preset. Switching a preset is therefore one
   * small file write that loses nothing, and cancelling one puts the switches
   * back the way they were found.
   *
   * @param sessionId - the session this assembly is for, when the caller says.
   * @param id - entry id.
   * @returns the interpolatable body, or the empty string.
   */
  function render(sessionId: string | undefined, id: string): string {
    const entry = byId.get(id)
    if (entry === undefined) return ''
    const preset = presetInForceFor(sessionId)
    const on = preset === undefined ? entry.enabled : preset.entries.includes(entry.id)
    return on ? describe(id).text : ''
  }

  /** References already reported, so one bad body cannot flood the log. */
  const reportedReferences = new Set<string>()

  /**
   * The variable table of the most recent assembly: the whole deployment's, not
   * just this plugin's.
   *
   * A compaction body may reference anything a section may, and that table is
   * the only place the full set exists — it is built per assembly by the
   * registry. Until the first one has run, the names this plugin registers
   * itself are all that can resolve.
   */
  let lastAssemblyVariables: Readonly<Record<string, string | undefined>> | undefined

  // The text this plugin serves is interpolated by the registry, strictly: a
  // reference it cannot resolve, or one whose shape is not a variable name,
  // makes that assembly throw — and one throwing section fails the whole
  // assembly, so every model step of the profile would fail until somebody
  // edited the body back. A body can also be hand-edited in `sections/`, where
  // no page gets to warn first. This hook therefore checks the text this plugin
  // owns against the assembly's own variable table and escapes whatever the
  // registry would refuse, leaving every resolvable reference alone.
  ctx.effect(() => ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    const out = await next()
    // Remembered on the way past: a compaction may happen before this plugin's
    // own sections are assembled, and this is the only view of the whole
    // deployment's variable table.
    lastAssemblyVariables = out.variables ?? {}
    const sections = out.sections.map((section) => {
      if (!section.name.startsWith(USER_SECTION_PREFIX)) return section
      const guarded = sanitizeReferences(section.text, out.variables ?? {})
      if (guarded.escaped.length === 0) return section
      for (const reference of guarded.escaped) {
        const key = `${section.name}\u0000${reference}`
        if (reportedReferences.has(key)) continue
        reportedReferences.add(key)
        warn(
          ctx,
          `${section.name} の本文が ${JSON.stringify(reference)} を参照しています。レジストリが解析できないためリテラルとしてレンダリングしました（この参照を変更するか、いずれかのソースでその名前を登録してください）`,
        )
      }
      if (reportedReferences.size > 512) reportedReferences.clear()
      return { ...section, text: guarded.text }
    })
    return { ...out, sections }
  }), 'dsh-prompt-manager: reference guard')

  /**
   * Bring the registered sections in line with the index. An entry whose name
   * or placement moved is re-registered, because both are fixed when the
   * section is declared; adding, removing, enabling, and disabling need no
   * other bookkeeping because section text is resolved per assembly.
   *
   * A compaction entry is skipped in both directions: it never registers a
   * section, and an entry that *became* one has its section withdrawn rather
   * than left behind pointing at a body that no longer feeds the prompt.
   */
  function reconcile(entries: readonly PromptEntry[]): void {
    byId.clear()
    for (const entry of entries) byId.set(entry.id, entry)
    for (const [id, registered] of [...sections]) {
      const entry = byId.get(id)
      const keep = entry !== undefined
        && entry.kind !== 'compaction'
        && registered.name === sectionNameFor(entry)
        && registered.order === entry.order
      if (keep) continue
      registered.disposer()
      sections.delete(id)
    }
    for (const entry of entries) {
      if (entry.kind === 'compaction') continue
      if (sections.has(entry.id)) continue
      const section = sectionNameFor(entry)
      const entryOrder = entry.order
      const disposer = ctx.effect(() => ctx.systemPrompt.section({
        name: section,
        order: entryOrder,
        text: (context) => render(sessionIdOf(context), entry.id),
      }), `dsh-prompt-manager.section(${section})`)
      sections.set(entry.id, { disposer, name: section, order: entryOrder })
    }
    reportDanglingMembers()
  }

  /**
   * Report a preset that names entries which will not inject.
   *
   * This is the failure nobody notices by itself: the preset still switches, the
   * members that do resolve still inject, and the rest simply stop appearing —
   * the usual cause being an upstream rename, or a source whose subscription has
   * not been applied yet. Reporting is keyed on the *set* of such ids so a
   * change to which ones they are is reported again, while a preset left broken
   * for a week says so once.
   *
   * Two kinds of member land here. One the index does not carry at all. And one
   * that is in the index but is a compaction instruction — the page's own type
   * switch creates that, leaving a preset still listing an id it used to inject
   * as a section, and it costs exactly one prompt from the set.
   */
  function reportDanglingMembers(): void {
    // Every configured preset is checked, not merely whichever one a session happens
    // to be using: a preset is a promise about what injecting it does, and that
    // promise is broken whether or not anybody is using it today. Each preset is
    // keyed on its own signature and named in its own report, because "one of your
    // presets is broken" is not an answer anybody can act on.
    for (const preset of presetList) {
      // Both kinds are read from the *whole* member list, not from one another:
      // a misplaced member is in the index, so it is by definition not absent, and
      // filtering it out of the absent set is what made this report never fire.
      const absent = preset.entries.filter((id) => !byId.has(id))
      const misplaced = preset.entries.filter((id) => byId.get(id)?.kind === 'compaction')
      const signature = `${preset.id}:${absent.join(',')}:${misplaced.join(',')}`
      if (danglingReported.has(signature)) continue
      danglingReported.add(signature)
      if (absent.length === 0 && misplaced.length === 0) continue
      const parts: string[] = []
      if (absent.length > 0) {
        parts.push(`${String(absent.length)} 件がインデックスにありません：${absent.join('、')}`)
      }
      if (misplaced.length > 0) {
        parts.push(`${String(misplaced.length)} 件は圧縮命令でありセクションではありません：${misplaced.join('、')}`)
      }
      warn(
        ctx,
        `プリセット ${preset.id} で${parts.join('；')}。これらのエントリは今回のラウンドで注入されません（サブスクライブが取得できていないか、アップストリームがファイル名を変更しました）。`,
      )
    }
  }

  /** Ids a new entry may not take: the index, every stored body, and the built-ins. */
  function takenIds(): string[] {
    return [...new Set([
      ...active.map((entry) => entry.id),
      ...store.ids(),
      ...BUILTIN_PROMPTS.map((prompt) => prompt.id),
    ])]
  }

  /**
   * Which entry titles reference each variable.
   *
   * A reference to a name that is no longer registered makes assembly throw, so
   * the page needs this in front of a delete rather than in the log afterwards.
   *
   * @returns variable name → titles of the entries that reference it.
   */
  function referencesIn(): Map<string, string[]> {
    const reference = /\{\{([a-z][a-z0-9_]*)\}\}/g
    const found = new Map<string, string[]>()
    for (const entry of active) {
      let body: string
      try {
        body = describe(entry.id).text
      } catch {
        continue
      }
      for (const match of body.matchAll(reference)) {
        const name = match[1]
        if (name === undefined) continue
        const titles = found.get(name) ?? []
        if (!titles.includes(entry.title)) titles.push(entry.title)
        found.set(name, titles)
      }
    }
    return found
  }

  // From here on the index exists, so the script engine can ask whether a
  // variable is still referenced before it lets one go.
  isReferenced = (variable) => referencesIn().has(variable)

  /**
   * The variable catalogue: plugin-owned values and DSH's native references.
   * Context-dependent values are deliberately absent from this global view.
   * @returns one view per name, sorted by name.
   */
  function variableViews(): VariableView[] {
    const references = referencesIn()
    const own = [...variables.entries()].map(([name, record]) => ({
      name,
      value: record.value,
      source: record.source,
      detail: record.detail,
      updatedAt: record.updatedAt,
      referencedBy: references.get(name) ?? [],
    }))
    const native = Object.entries(DSH_CONTEXT_VARIABLES)
      .filter(([name]) => !variables.has(name))
      .map(([name, detail]) => ({
        name,
        source: 'dsh' as const,
        detail,
        referencedBy: references.get(name) ?? [],
      }))
    return [...own, ...native]
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  }

  // The compaction instruction is a second seam, not a second prompt: it reaches
  // the summarizer instead of the system prompt, and only when the index puts one
  // in force. Installed after the sections so a body can reference the variables
  // this mount just registered.
  const compactionPrompt = config.compaction === false
    ? undefined
    : installCompactionPrompt(ctx, {
      resolve: resolveCompaction,
      variables: compactionVariables,
      warn: (message) => warn(ctx, message),
    })

  /** What the settings page reports about the compaction instruction. */
  function compactionStats(): CompactionPromptStats | undefined {
    return compactionPrompt?.stats()
  }

  installPromptRoutes(ctx, {
    store,
    sessions: choices,
    describe,
    idFor: (title) => entryIdFor(title, takenIds()),
    presetIds: () => presetsInForce().map((preset) => preset.id),
    warn: (message) => warn(ctx, message),
    subscriptions,
    scripts,
    variables: () => variableViews(),
    packFor,
    importPack,
    compaction: compactionStats,
  })

  /** Whether the cap has already been reported for this mount. */
  let truncationReported = false

  /**
   * Report an index the entry cap shortened.
   *
   * At most {@link MAX_ENTRIES} sections may be active, so entries past the cap
   * never reach the prompt. The settings page reads the document rather than the
   * narrowed index, so it would still list them — saying so once is the
   * difference between a silent no-op and something a person can act on.
   *
   * @param document - the resolved settings document.
   * @param kept - how many entries survived narrowing.
   */
  function reportTruncation(document: unknown, kept: number): void {
    if (truncationReported) return
    const raw = fieldOf(document, 'entries')
    if (!Array.isArray(raw) || raw.length <= kept) return
    truncationReported = true
    warn(
      ctx,
      `インデックスには ${String(raw.length)} 件のエントリがありますが、上限は ${String(MAX_ENTRIES)} 件です。最初の ${String(kept)} 件のみがプロンプトに入ります（設定ページにはすべて表示されます）`,
    )
  }

  /**
   * Open the settings namespace and put the stored index in force.
   *
   * The namespace is owned by this plugin (`settings.register`): the stored
   * document is the only read path, and the settings page writes through the
   * same namespace, which is what keeps the packaged sections in force on a
   * deployment that configured nothing.
   */
  const factory = loadSchemaFactory()
  if (factory === undefined) {
    warn(ctx, 'schemastery is unavailable, so prompt entries cannot be edited from Settings')
  } else {
    ctx.inject(['settings'], (scoped) => {
      const settings = (scoped as unknown as { settings?: SettingsFace }).settings
      if (settings === undefined) return
      let scope: SettingsScopeFace
      try {
        scope = settings.register(SETTINGS_NAMESPACE, buildIndexSchema(factory), {
          base: {
            entries: builtinEntries(),
            presets: [],
            activePreset: '',
            sources: [],
            mirror: '',
            proxy: { kind: 'none', url: '' },
          },
        })
      } catch (error) {
        warn(ctx, `cannot register the ${SETTINGS_NAMESPACE} settings namespace: ${messageOf(error)}`)
        return
      }
      writeEntries = async (next) => {
        await scope.update({ entries: next })
      }
      writeIndex = async (patch) => {
        await scope.update({ entries: patch.entries, presets: patch.presets })
      }
      const sync = (): void => {
        resolved = scope.get()
        refreshPresets()
        const entries = parseEntries(resolved)
        reportTruncation(resolved, entries.length)
        active.length = 0
        active.push(...entries)
        locations = subscriptions.refreshLocations()
        reconcile(active)
      }
      sync()
      ctx.effect(() => scope.watch(sync), 'dsh-prompt-manager: settings watcher')
    })
  }
  refreshPresets()
  locations = subscriptions.refreshLocations()
  reconcile(active)
}
