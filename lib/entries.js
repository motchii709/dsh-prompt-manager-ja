/**
 * The prompt index: entry identity and the settings schema that carries one
 * section per entry.
 *
 * An entry's markdown body lives in one file per entry under the store
 * directory; everything else about it — title, order, whether it is injected —
 * lives in the `prompt-manager` settings namespace this module describes. Keeping
 * the index in the settings document means the browser gets reads, writes,
 * revision fencing, and the "user overrode this" flag from the shared settings
 * transport, while the bodies stay plain `.md` files a person can edit directly.
 * The same namespace carries the presets: named selections that decide injection
 * on their own while one of them is active, so a single `activePreset` write
 * swaps the whole set without touching any entry.
 *
 * Entry bodies live either as plain `.md` files a person can edit directly, or
 * as one markdown file shipped with this package: a fresh install starts with
 * the built-in machine-environment prompt, and anything a person writes or
 * subscribes overrides it.
 *
 * @module @lolkda/dsh-prompt-manager/entries
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
/** Order handed to the first entry a person adds; later additions sort after it. */
export const USER_ORDER_START = 30;
/** At most this many entries may be active at once. */
export const MAX_ENTRIES = 50;
/** At most this many presets may be configured. */
export const MAX_PRESETS = 20;
/** At most this many entries one preset may select. */
export const MAX_PRESET_ENTRIES = MAX_ENTRIES;
/** Ref a source starts on when the settings page names none. */
export const DEFAULT_SOURCE_REF = 'main';
/** Largest accepted body, in bytes. */
export const MAX_BODY_BYTES = 256 * 1024;
/** Largest accepted title, in characters. */
export const MAX_TITLE_LENGTH = 120;
/** Largest accepted id, in characters. */
export const MAX_ID_LENGTH = 64;
/**
 * Entry id grammar. The id becomes a file name and a prompt-section name
 * suffix, so it stays lowercase, hyphenated, and path-safe by construction.
 */
export const ENTRY_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/** The prompts this package ships. */
export const BUILTIN_PROMPTS = [
    {
        id: 'env',
        title: 'マシン環境',
        order: 5,
        file: new URL('../environment.md', import.meta.url),
    },
];
/**
 * The base layer's entries: one per {@link BUILTIN_PROMPTS} entry, enabled.
 *
 * They behave like any other entry — the page lists them, a write overrides
 * them, a toggle disables them — so the built-in prose is a starting point
 * rather than something the deployment cannot reach.
 *
 * @returns fresh entry records, safe to hand to a settings base layer.
 */
export function builtinEntries() {
    return BUILTIN_PROMPTS.map((prompt) => ({
        id: prompt.id,
        title: prompt.title,
        order: prompt.order,
        enabled: true,
    }));
}
/**
 * The packaged body for one entry id.
 * @param id - entry id to look up.
 * @returns the exact UTF-8 markdown, or `undefined` when the package ships none
 * for that id, or the packaged file cannot be read.
 */
export function readBuiltinBody(id) {
    const prompt = BUILTIN_PROMPTS.find((candidate) => candidate.id === id);
    if (prompt === undefined)
        return undefined;
    try {
        const text = readFileSync(fileURLToPath(prompt.file), 'utf8');
        return text.trim().length === 0 ? undefined : text;
    }
    catch {
        return undefined;
    }
}
/** Whether a value is a usable entry id. */
export function isEntryId(value) {
    return typeof value === 'string' && value.length <= MAX_ID_LENGTH && ENTRY_ID_PATTERN.test(value);
}
/**
 * Turn a human title into an unused entry id.
 *
 * Only ASCII letters and digits survive, so a title written entirely in a
 * non-Latin script falls back to the `entry` stem. That is deliberate: the id
 * is an internal handle (file name and section-name suffix), never user copy.
 *
 * @param title - the label a person typed.
 * @param taken - ids already in use.
 * @returns a lowercase, hyphenated, unused id.
 */
export function entryIdFor(title, taken) {
    const stem = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32);
    const base = stem.length >= 2 ? stem : 'entry';
    const used = new Set(taken);
    if (!used.has(base))
        return base;
    for (let suffix = 2; suffix < 1000; suffix += 1) {
        const candidate = `${base.slice(0, 28)}-${String(suffix)}`;
        if (!used.has(candidate))
            return candidate;
    }
    return `${base.slice(0, 24)}-${String(Date.now())}`;
}
/**
 * Keep one id when it is free, or take the nearest free variant of it.
 *
 * For the places where the id *is* the identity rather than a handle derived
 * from a title: a subscribed entry's body is looked up by id upstream, so an
 * imported `env` that collides is far better off as `env-2` than as whatever a
 * title — possibly written entirely in a non-Latin script — would slug to.
 *
 * @param preferred - the id that was asked for.
 * @param taken - ids already in use.
 * @returns `preferred`, or a `-2`-suffixed variant of its stem.
 */
export function freeId(preferred, taken) {
    const used = new Set(taken);
    if (isEntryId(preferred) && !used.has(preferred))
        return preferred;
    const stem = (isEntryId(preferred) ? preferred : 'entry').replace(/-\d+$/, '').slice(0, 28);
    const base = stem.length >= 2 ? stem : 'entry';
    if (!used.has(base))
        return base;
    for (let suffix = 2; suffix < 1000; suffix += 1) {
        const candidate = `${base.slice(0, 28)}-${String(suffix)}`;
        if (!used.has(candidate))
            return candidate;
    }
    return `${base.slice(0, 24)}-${String(Date.now())}`;
}
/** One usable entry, or `undefined` when the raw value is unusable. */
function toEntry(raw) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        return undefined;
    const record = raw;
    const { id, title, order, enabled, source, kind } = record;
    if (!isEntryId(id))
        return undefined;
    if (typeof order !== 'number' || !Number.isFinite(order))
        return undefined;
    if (typeof enabled !== 'boolean')
        return undefined;
    const label = typeof title === 'string' ? title.trim() : '';
    const entry = {
        id,
        title: label.length === 0 ? id : label.slice(0, MAX_TITLE_LENGTH),
        order,
        enabled,
    };
    if (typeof source === 'string' && source.length > 0)
        entry.source = source.slice(0, 64);
    // A hand-edited document can carry anything here; only the one value this
    // build knows changes what the entry does. An unknown one reads as a section —
    // dropping the entry instead would silently delete a prompt somebody wrote.
    if (kind === 'compaction')
        entry.kind = 'compaction';
    return entry;
}
/**
 * Narrow one resolved settings value into an index. A hand-edited document can
 * hold anything, so unusable entries are dropped rather than thrown: the worst
 * case is a prompt with fewer sections, never a session that cannot assemble.
 *
 * @param raw - the resolved `prompt-manager` namespace value.
 * @returns the usable entries, deduplicated by id and capped at {@link MAX_ENTRIES}.
 */
export function parseEntries(raw) {
    const list = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
        ? raw['entries']
        : undefined;
    if (!Array.isArray(list))
        return [];
    const entries = [];
    const seen = new Set();
    for (const candidate of list) {
        const entry = toEntry(candidate);
        if (entry === undefined || seen.has(entry.id))
            continue;
        seen.add(entry.id);
        entries.push(entry);
        if (entries.length >= MAX_ENTRIES)
            break;
    }
    return entries;
}
/** One usable preset, or `undefined` when the raw value is unusable. */
function toPreset(raw) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        return undefined;
    const record = raw;
    const { id, name, entries } = record;
    if (!isEntryId(id))
        return undefined;
    const label = typeof name === 'string' ? name.trim() : '';
    const chosen = [];
    const seen = new Set();
    if (Array.isArray(entries)) {
        for (const candidate of entries) {
            // An id the index does not carry right now is kept: it may belong to a
            // subscription that has not come back yet, and dropping it here would
            // silently rewrite what the person selected.
            if (typeof candidate !== 'string' || !isEntryId(candidate) || seen.has(candidate))
                continue;
            seen.add(candidate);
            chosen.push(candidate);
            if (chosen.length >= MAX_PRESET_ENTRIES)
                break;
        }
    }
    // Old compaction metadata is deliberately ignored. Only a session's manual
    // choice may select a compression instruction; presets select sections.
    return {
        id,
        name: label.length === 0 ? id : label.slice(0, MAX_TITLE_LENGTH),
        entries: chosen,
    };
}
/**
 * Narrow a resolved settings value into the preset list. Like {@link parseEntries},
 * a hand-edited document can hold anything, so unusable presets are dropped
 * rather than thrown: the worst case is a smaller list, never an assembly that
 * cannot be built.
 *
 * @param raw - the resolved `presets` field.
 * @returns the usable presets, deduplicated by id and capped at {@link MAX_PRESETS}.
 */
export function parsePresets(raw) {
    if (!Array.isArray(raw))
        return [];
    const presets = [];
    const seen = new Set();
    for (const candidate of raw) {
        const preset = toPreset(candidate);
        if (preset === undefined || seen.has(preset.id))
            continue;
        seen.add(preset.id);
        presets.push(preset);
        if (presets.length >= MAX_PRESETS)
            break;
    }
    return presets;
}
/**
 * The id of the preset in force.
 * @param raw - the resolved `activePreset` field.
 * @returns the configured id, or `''` when the deployment runs without a preset.
 */
export function activePresetOf(raw) {
    return typeof raw === 'string' ? raw.trim() : '';
}
/**
 * The id of the compaction instruction in force.
 *
 * Read exactly like {@link activePresetOf}: an absent, empty, or unusable value
 * means `''`, which is "the instruction DSH itself ships". A preset's own
 * pointer overrides this one while that preset is active, so the caller decides
 * which of the two it is asking about.
 *
 * @param raw - the resolved `compaction` field.
 * @returns the configured entry id, or `''` when the stock instruction stands.
 */
export function activeCompactionOf(raw) {
    return typeof raw === 'string' ? raw.trim() : '';
}
/**
 * Build the `prompt-manager` namespace schema.
 *
 * @param factory - the schemastery factory loaded at mount.
 * @returns a schema carrying the entry index, the subscriptions, and the
 * outbound settings the engine reads.
 */
export function buildIndexSchema(factory) {
    const entry = factory.object({
        id: factory.string().required(),
        title: factory.string().default(''),
        order: factory.number().default(USER_ORDER_START),
        enabled: factory.boolean().default(true),
        // No default: a local entry must resolve without the field at all. With
        // `.default('')` every entry carried `source: ''`, which reads as
        // "subscribed" to anything testing presence rather than value, and a
        // settings write-back would then persist the phantom field to disk.
        source: factory.string(),
        // Same reason: absent means a system-prompt section, which is what an
        // existing document holds, so the schema must not invent a value for it.
        kind: factory.string(),
    });
    const source = factory.object({
        id: factory.string().required(),
        repo: factory.string().required(),
        ref: factory.string().default(DEFAULT_SOURCE_REF),
        mirror: factory.string().default(''),
        enabled: factory.boolean().default(true),
    });
    const preset = factory.object({
        id: factory.string().required(),
        name: factory.string().default(''),
        entries: factory.array(factory.string()).default([]),
    });
    const proxy = factory.object({
        kind: factory.string().default('none'),
        url: factory.string().default(''),
    }).default({ kind: 'none', url: '' });
    return factory.object({
        entries: factory.array(entry).default([]),
        presets: factory.array(preset).default([]),
        // No default beyond the empty string: an unset preset means the entries'
        // own switches decide, which is what a deployment that never made one gets.
        activePreset: factory.string().default(''),
        // Same shape as `activePreset`, and the same meaning: "nothing was chosen".
        // Here that reads as the instruction DSH itself ships, so a document written
        // before this field existed keeps behaving exactly as it did.
        compaction: factory.string().default(''),
        sources: factory.array(source).default([]),
        mirror: factory.string().default(''),
        proxy,
    });
}
//# sourceMappingURL=entries.js.map