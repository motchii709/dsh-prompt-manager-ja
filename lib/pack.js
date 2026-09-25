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
import { entryIdFor, freeId, isEntryId, MAX_BODY_BYTES, MAX_ENTRIES, MAX_TITLE_LENGTH, } from './entries.js';
import { malformedReferences } from './guard.js';
/** Marker every pack carries, so a foreign JSON file is refused by name. */
export const PACK_FORMAT = 'dsh-prompt-manager-pack';
/** Pack schema this build writes, and the only one it reads. */
export const PACK_VERSION = 1;
/**
 * Largest pack accepted on import, in bytes.
 *
 * A pack can carry up to {@link MAX_ENTRIES} bodies of {@link MAX_BODY_BYTES}
 * each, so the route's ordinary JSON limit — sized for one body — is far too
 * small here. This is the ceiling that replaces it, and it is also the largest
 * body the route will read at all.
 */
export const MAX_PACK_BYTES = 4 * 1024 * 1024;
/** At most this many entries one pack may declare. Mirrors the index's own cap. */
export const MAX_PACK_ENTRIES = MAX_ENTRIES;
/**
 * Assemble a pack from members whose bodies the host has already resolved.
 *
 * Refuses nothing: a member with no body is exactly what a subscribed entry
 * looks like, and its provenance is what makes the pack usable somewhere else.
 *
 * @param input - the preset, its resolved members, and the version recording it.
 * @returns the pack, ready to be serialized.
 */
export function buildPack(input) {
    const compressionIds = new Set(input.members.filter((member) => member.kind === 'compaction').map((member) => member.id));
    const members = input.members.filter((member) => member.kind !== 'compaction').map((member) => {
        const carried = {
            id: member.id,
            title: member.title,
            order: member.order,
            enabled: member.enabled,
        };
        if (member.body !== undefined) {
            carried.body = member.body;
            if (member.origin !== undefined)
                carried.origin = member.origin;
            return carried;
        }
        if (member.source !== undefined)
            carried.source = member.source;
        return carried;
    });
    const preset = {
        id: input.preset.id,
        name: input.preset.name,
        entries: input.preset.entries.filter((id) => !compressionIds.has(id)),
    };
    return {
        format: PACK_FORMAT,
        version: PACK_VERSION,
        exportedAt: (input.now ?? new Date()).toISOString(),
        generator: { plugin: input.pluginName, pluginVersion: input.pluginVersion },
        preset,
        entries: members,
        missing: (input.missing ?? []).filter((id) => !compressionIds.has(id)),
    };
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
export function writePackBodies(entries, sink) {
    const written = [];
    try {
        for (const entry of entries) {
            if (entry.body === undefined)
                continue;
            sink.write(entry.id, entry.body);
            written.push(entry.id);
        }
    }
    catch (error) {
        for (const id of written)
            sink.remove(id);
        throw error;
    }
}
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
export function parsePack(raw) {
    const root = asRecord(raw);
    if (root === undefined)
        return refuse('bad-format', 'パッケージは JSON オブジェクトでなければなりません');
    if (root['format'] !== PACK_FORMAT) {
        return refuse('bad-format', `これは ${PACK_FORMAT} パッケージではありません（format = ${JSON.stringify(root['format'])}）`);
    }
    if (root['version'] !== PACK_VERSION) {
        return refuse('bad-version', `パッケージのバージョンは ${JSON.stringify(root['version'])}。このバージョンは ${String(PACK_VERSION)} のみ受け付けます`);
    }
    const presetRaw = asRecord(root['preset']);
    if (presetRaw === undefined)
        return refuse('bad-preset', 'パッケージ内の preset はオブジェクトでなければなりません');
    const presetName = textOf(presetRaw['name']) ?? textOf(presetRaw['id']);
    if (presetName === undefined)
        return refuse('bad-preset', 'preset には name が必要です');
    const membersRaw = presetRaw['entries'];
    if (!Array.isArray(membersRaw))
        return refuse('bad-preset', 'preset.entries は文字列の配列でなければなりません');
    const memberIds = membersRaw.filter((member) => typeof member === 'string');
    const listRaw = root['entries'];
    if (!Array.isArray(listRaw))
        return refuse('bad-entry', 'entries は配列でなければなりません');
    if (listRaw.length > MAX_PACK_ENTRIES) {
        return refuse('too-many-entries', `パッケージには ${String(listRaw.length)} 件ありますが、上限は ${String(MAX_PACK_ENTRIES)} 件です`);
    }
    const entries = [];
    for (const [index, item] of listRaw.entries()) {
        const position = index + 1;
        const record = asRecord(item);
        if (record === undefined)
            return refuse('bad-entry', `第 ${String(position)} 件目はオブジェクトではありません`);
        const title = textOf(record['title']);
        if (title === undefined)
            return refuse('bad-entry', `第 ${String(position)} 件目に使える title がありません`);
        const orderRaw = record['order'];
        const entry = {
            id: textOf(record['id']) ?? '',
            title: title.slice(0, MAX_TITLE_LENGTH),
            order: typeof orderRaw === 'number' && Number.isFinite(orderRaw) ? orderRaw : 0,
            enabled: record['enabled'] === true,
        };
        // Only the one value this build knows: a hand-edited `kind` of any other
        // shape reads as an ordinary section, which is what an entry is by default.
        if (record['kind'] === 'compaction')
            entry.kind = 'compaction';
        const bodyRaw = record['body'];
        if (typeof bodyRaw === 'string') {
            const size = Buffer.byteLength(bodyRaw, 'utf8');
            if (size > MAX_BODY_BYTES) {
                return refuse('too-large', `「${entry.title}」の本文は ${String(size)} バイトで、上限は ${String(MAX_BODY_BYTES)} バイト`);
            }
            const broken = malformedReferences(bodyRaw);
            if (broken.length > 0) {
                return refuse('bad-reference', `「${entry.title}」の本文にレジストリが解析できない参照があります：${broken.join(' ')}（このような本文がインデックスに入ると、毎回のモデルステップが失敗します）`);
            }
            entry.body = bodyRaw;
            const origin = record['origin'];
            if (origin === 'local' || origin === 'builtin')
                entry.origin = origin;
        }
        else {
            const source = parseSourceRef(record['source']);
            if (source !== undefined)
                entry.source = source;
        }
        entries.push(entry);
    }
    const compressionIds = new Set(entries.filter((entry) => entry.kind === 'compaction').map((entry) => entry.id));
    const missingRaw = root['missing'];
    const missing = Array.isArray(missingRaw)
        ? missingRaw.filter((id) => typeof id === 'string' && !compressionIds.has(id))
        : [];
    return {
        ok: true,
        pack: {
            format: PACK_FORMAT,
            version: PACK_VERSION,
            exportedAt: textOf(root['exportedAt']) ?? '',
            generator: readGenerator(root['generator']),
            preset: {
                id: textOf(presetRaw['id']) ?? '',
                name: presetName.slice(0, MAX_TITLE_LENGTH),
                entries: memberIds.filter((id) => !compressionIds.has(id)),
            },
            // Legacy compression bodies remain independent entries for manual use.
            entries,
            missing,
        },
    };
}
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
export function planImport(pack, taken) {
    const used = new Set(taken.entryIds);
    const room = MAX_ENTRIES - used.size;
    if (pack.entries.length > room) {
        return refuse('too-many-entries', `このマシンにはあと ${String(Math.max(room, 0))} 件分の空きがあり、このパッケージには ${String(pack.entries.length)} 件あります（上限 ${String(MAX_ENTRIES)} 件）`);
    }
    const renamed = [];
    const noBody = [];
    const sourceDropped = [];
    const entries = pack.entries.map((entry) => {
        const wanted = isEntryId(entry.id) ? freeId(entry.id, used) : entryIdFor(entry.title, used);
        used.add(wanted);
        const kept = wanted === entry.id;
        if (!kept)
            renamed.push({ from: entry.id, to: wanted });
        if (entry.body === undefined)
            noBody.push(entry.title);
        const planned = {
            id: wanted,
            title: entry.title,
            order: entry.order,
            enabled: entry.enabled,
        };
        if (entry.body !== undefined)
            planned.body = entry.body;
        if (entry.origin !== undefined)
            planned.origin = entry.origin;
        if (entry.kind === 'compaction')
            planned.kind = 'compaction';
        // A subscription's body is found upstream *by id*, so an entry that had to
        // be renamed can never read its file: recording the source anyway would
        // present an entry as read-only-upstream while it can only ever render
        // empty — and read-only means the person cannot even paste the body in.
        if (entry.source !== undefined) {
            if (kept)
                planned.source = entry.source.slug;
            else
                sourceDropped.push(entry.title);
        }
        if (!kept)
            planned.renamedFrom = entry.id;
        return planned;
    });
    const presetUsed = new Set(taken.presetIds);
    const presetId = isEntryId(pack.preset.id) && !presetUsed.has(pack.preset.id)
        ? pack.preset.id
        : entryIdFor(pack.preset.name, presetUsed);
    const moved = new Map(renamed.map(({ from, to }) => [from, to]));
    const carried = new Set(pack.entries.map((entry) => entry.id));
    const compressionIds = new Set(pack.entries.filter((entry) => entry.kind === 'compaction').map((entry) => entry.id));
    const memberIds = pack.preset.entries.filter((id) => !compressionIds.has(id));
    const missingMembers = memberIds.filter((id) => !carried.has(id));
    return {
        ok: true,
        plan: {
            entries,
            preset: {
                id: presetId,
                name: pack.preset.name,
                entries: memberIds.map((id) => moved.get(id) ?? id),
            },
            renamed,
            noBody,
            sourceDropped,
            missingMembers,
        },
    };
}
/** Build one refusal. */
function refuse(code, message) {
    return { ok: false, code, message };
}
/** Narrow a value to a plain object. */
function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
/** Read a non-empty trimmed string. */
function textOf(value) {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
/** Read a subscription reference, keeping only what it actually carries. */
function parseSourceRef(value) {
    const record = asRecord(value);
    if (record === undefined)
        return undefined;
    const slug = textOf(record['slug']);
    if (slug === undefined)
        return undefined;
    const ref = { slug };
    const repo = textOf(record['repo']);
    if (repo !== undefined)
        ref.repo = repo;
    const branch = textOf(record['ref']);
    if (branch !== undefined)
        ref.ref = branch;
    const file = textOf(record['file']);
    if (file !== undefined)
        ref.file = file;
    return ref;
}
/** Read the optional header a pack's writer left for a human. */
function readGenerator(value) {
    const record = asRecord(value);
    return {
        plugin: textOf(record?.['plugin']) ?? '',
        pluginVersion: textOf(record?.['pluginVersion']) ?? '',
    };
}
//# sourceMappingURL=pack.js.map