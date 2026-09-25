/**
 * Preset packs: one preset, the bodies of its local members, and enough
 * provenance to say where the bodies that are *not* in the pack come from.
 *
 * A pack is plain JSON a person can read, diff, mail, and keep. It carries no
 * code: scripts stay on the machine that wrote them, and a pack cannot ask for
 * one. Everything in this module is pure — building, validating, and planning an
 * import are all functions of their arguments — so the rules a pack has to pass
 * are testable without an HTTP request, a store, or a settings namespace.
 *
 * The split of responsibility is deliberate:
 *
 * - {@link buildPack} turns already-resolved members into a pack. Reading bodies
 *   and subscription origins is the host's job, because only it knows them.
 * - {@link parsePack} decides whether a foreign file is a pack this build can
 *   use at all, and refuses by naming the entry that is wrong.
 * - {@link planImport} works out which ids the entries will take on this machine
 *   and rewrites the preset's membership to match, without touching anything.
 *
 * @module @lolkda/dsh-prompt-manager/pack
 */
import { type PromptPreset } from './entries.js';
/** Marker every pack carries, so a foreign JSON file is refused by name. */
export declare const PACK_FORMAT = "dsh-prompt-manager-pack";
/** Pack schema this build writes, and the only one it reads. */
export declare const PACK_VERSION = 1;
/**
 * Largest pack accepted on import, in bytes.
 *
 * A pack can carry up to {@link MAX_ENTRIES} bodies of {@link MAX_BODY_BYTES}
 * each, so the route's ordinary JSON limit — sized for one body — is far too
 * small here. This is the ceiling that replaces it, and it is also the largest
 * body the route will read at all.
 */
export declare const MAX_PACK_BYTES: number;
/** At most this many entries one pack may declare. Mirrors the index's own cap. */
export declare const MAX_PACK_ENTRIES = 50;
/** Where a subscribed entry's body comes from, as recorded in a pack. */
export interface PackSourceRef {
    /** Source slug the entry is subscribed to, e.g. `lolkda-dsh-prompt-pack`. */
    slug: string;
    /** `owner/repo`, when the exporting machine still had that source configured. */
    repo?: string | undefined;
    /** The ref in force there, e.g. `main`. */
    ref?: string | undefined;
    /** Path inside the source's workspace, e.g. `ctf.md`. */
    file?: string | undefined;
}
/** Where an exported body came from. */
export type PackOrigin = 'local' | 'builtin';
/** One entry inside a pack. */
export interface PackEntry {
    /** Id it had on the exporting machine; not necessarily free on this one. */
    id: string;
    /** Human label, used to allocate a new id when this one is taken. */
    title: string;
    /** Section placement, carried over as written. */
    order: number;
    /** The entry's own switch, carried over as written. */
    enabled: boolean;
    /** Body text. Absent for a subscribed entry, whose body belongs to a source. */
    body?: string | undefined;
    /** Which layer supplied {@link PackEntry.body}. Absent for a subscription. */
    origin?: PackOrigin | undefined;
    /** Present instead of a body when the entry is a subscription. */
    source?: PackSourceRef | undefined;
    /**
     * `compaction` when this entry feeds the compaction instruction rather than
     * the system prompt, absent for an ordinary section.
     *
     * Carried because it cannot be recovered from anything else: the body of a
     * compaction instruction reads exactly like the body of a section, so an
     * import that dropped this would silently turn it into a section and inject
     * the summarizer's template into every model step.
     */
    kind?: 'compaction' | undefined;
}
/** The preset a pack carries. */
export interface PackPreset {
    /** Id it had on the exporting machine; not necessarily free on this one. */
    id: string;
    /** Display name; kept verbatim on import even when the id has to change. */
    name: string;
    /** Member ids, referring to {@link PromptPack.entries}. */
    entries: string[];
}
/** A pack this build understands. */
export interface PromptPack {
    /** Always {@link PACK_FORMAT}. */
    format: string;
    /** Always {@link PACK_VERSION}. */
    version: number;
    /** When the exporting machine wrote it, for a human reading the file. */
    exportedAt: string;
    /** What wrote it, for a human reading the file. */
    generator: {
        plugin: string;
        pluginVersion: string;
    };
    /** The preset being moved. */
    preset: PackPreset;
    /** Its members, in the order the exporting index held them. */
    entries: PackEntry[];
    /** Members the preset named that no longer existed when the pack was written. */
    missing: string[];
}
/** Why a pack was refused. */
export interface PackRefusal {
    ok: false;
    /** Stable code the browser can branch on. */
    code: PackRefusalCode;
    /** Message written for the person reading the page. */
    message: string;
}
/** The refusal codes a pack can be turned down with. */
export type PackRefusalCode = 'bad-format' | 'bad-version' | 'bad-preset' | 'bad-entry' | 'bad-reference' | 'too-large' | 'too-many-entries';
/** One member of a preset, resolved for export. */
export interface PackMember {
    /** Entry id. */
    id: string;
    /** Human label. */
    title: string;
    /** Section placement. */
    order: number;
    /** The entry's own switch. */
    enabled: boolean;
    /** Resolved body, when this machine has one. */
    body?: string | undefined;
    /** Which layer supplied the body. */
    origin?: PackOrigin | undefined;
    /** Subscription origin, when the body belongs to a source. */
    source?: PackSourceRef | undefined;
    /** `compaction` when this member is the compaction instruction. */
    kind?: 'compaction' | undefined;
}
/** Everything {@link buildPack} needs, all of it already resolved. */
export interface PackExportInput {
    /** The preset being exported. */
    preset: PromptPreset;
    /** Its resolvable members, in the order the pack should carry them. */
    members: PackMember[];
    /** Member ids the preset names that this machine cannot resolve. */
    missing?: string[] | undefined;
    /** This plugin's package name, recorded in the pack's header. */
    pluginName: string;
    /** This plugin's version, recorded in the pack's header. */
    pluginVersion: string;
    /** Clock, for tests; defaults to now. */
    now?: Date | undefined;
}
/** One entry an import would create. */
export interface PackImportEntry {
    /** The id it will take on this machine. */
    id: string;
    /** Human label. */
    title: string;
    /** Section placement. */
    order: number;
    /** Whether it contributes while no preset is in force. */
    enabled: boolean;
    /** Body to write, absent for an entry whose text a source supplies. */
    body?: string | undefined;
    /** Which layer the body came from. */
    origin?: PackOrigin | undefined;
    /** Source slug to record in the index, when the entry is a subscription. */
    source?: string | undefined;
    /** The id this entry had on the exporting machine, when it had to change. */
    renamedFrom?: string | undefined;
    /** `compaction` when this entry feeds the compaction instruction. */
    kind?: 'compaction' | undefined;
}
/** What an import would do, ready to be checked and then carried out. */
export interface PackImportPlan {
    /** Entries to create, in pack order. */
    entries: PackImportEntry[];
    /** The preset to create, with membership pointing at the ids above. */
    preset: PromptPreset;
    /** Every id that had to change, for the report. */
    renamed: Array<{
        from: string;
        to: string;
    }>;
    /** Titles whose bodies this machine will not have until a source is set up. */
    noBody: string[];
    /**
     * Titles that arrived as subscriptions but had to give up their id, and with
     * it the ability to read their body from the source. They are imported as
     * ordinary empty entries, and this is how the page says so.
     */
    sourceDropped: string[];
    /** Preset members the pack itself could not carry (already gone at export). */
    missingMembers: string[];
}
/** The result of planning an import. */
export type PackImportResult = {
    ok: true;
    plan: PackImportPlan;
} | PackRefusal;
/** What an import did, in the words the page reports it with. */
export interface PackImportReport {
    /** Entries created, in pack order. */
    entries: Array<{
        id: string;
        title: string;
        renamedFrom?: string | undefined;
    }>;
    /** The preset created, with membership already pointing at the ids above. */
    preset: PromptPreset;
    /** Every id that changed, so the page can say which entry is which. */
    renamed: Array<{
        from: string;
        to: string;
    }>;
    /** Titles whose body the pack does not carry, because a source supplies it. */
    noBody: string[];
    /** Titles that arrived as subscriptions but could not keep their id. */
    sourceDropped: string[];
    /** Preset members the pack itself could not carry. */
    missingMembers: string[];
    /**
     * Variable names the imported bodies reference that *this* plugin does not
     * supply. Not proof of a broken prompt: another row may register them, and the
     * reference guard renders whatever is left as prose and says so in the log.
     */
    unregistered: string[];
}
/** The result of carrying out an import. */
export type PackApplyResult = {
    ok: true;
    report: PackImportReport;
} | PackRefusal;
/** The result of reading a pack. */
export type PackParseResult = {
    ok: true;
    pack: PromptPack;
} | PackRefusal;
/**
 * Assemble a pack from members whose bodies the host has already resolved.
 *
 * Refuses nothing: a member with no body is exactly what a subscribed entry
 * looks like, and its provenance is what makes the pack usable somewhere else.
 *
 * @param input - the preset, its resolved members, and the version recording it.
 * @returns the pack, ready to be serialized.
 */
export declare function buildPack(input: PackExportInput): PromptPack;
/** Where an import's body files go. */
export interface PackBodySink {
    /**
     * Create one body file.
     *
     * Must refuse to replace a file that already exists: an id the planner
     * believes is free may have been taken by somebody else in the meantime, and
     * silently overwriting their body is the one outcome worse than failing.
     */
    write(id: string, body: string): void;
    /**
     * Remove one body file this call created.
     *
     * Expected to swallow its own failures — there is nothing useful to do about
     * one at this point, and the original error is the one worth reporting.
     */
    remove(id: string): void;
}
/**
 * Write the bodies an import carries, and take back whatever was written if one
 * of them fails.
 *
 * An import that gets half-way leaves an index nobody has updated yet and a pile
 * of files nothing points at, which is why the files go down first and the index
 * last: a failure here removes exactly what this call created, so the machine
 * ends up as it was, and importing the same pack again starts clean.
 *
 * @param entries - the planned entries, in pack order.
 * @param sink - where the bodies go.
 * @throws the sink's own error, after the rollback.
 */
export declare function writePackBodies(entries: readonly PackImportEntry[], sink: PackBodySink): void;
/**
 * Read a pack from an untrusted value.
 *
 * Strict about what cannot be recovered and forgiving about what can: a title is
 * required because a missing id is derived from it, while an unusable id, a
 * missing order, or an absent `enabled` are all things the importer decides
 * again anyway. A body that no assembly could render is refused here rather than
 * written into the index, because an index entry that cannot assemble fails
 * every model step until somebody edits it.
 *
 * @param raw - the parsed JSON value.
 * @returns the pack, or the first reason it is unusable.
 */
export declare function parsePack(raw: unknown): PackParseResult;
/**
 * Decide which ids an imported pack will take here, and what its preset will say.
 *
 * A taken id is not an error and not an overwrite: the entry gets a fresh id
 * derived from its title, the preset's membership follows it, and the pack's
 * display name is kept. Importing the same pack twice therefore produces two
 * distinct sets rather than quietly rewriting the first one. Members the pack
 * itself could not carry are kept in the preset as they were — the same rule the
 * index uses for a subscription that may come back — and reported separately.
 *
 * @param pack - a pack that already passed {@link parsePack}.
 * @param taken - ids already in use here: the index, the stored bodies, the
 * built-ins, and the configured presets.
 * @returns the plan, or why the pack does not fit on this machine.
 */
export declare function planImport(pack: PromptPack, taken: {
    entryIds: Iterable<string>;
    presetIds: Iterable<string>;
}): PackImportResult;
//# sourceMappingURL=pack.d.ts.map