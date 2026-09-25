/**
 * The reference guard: keeps a prompt body from breaking the whole assembly.
 *
 * The registry interpolates section text strictly — a reference it cannot
 * resolve, and a reference whose shape is not a variable name, both throw, and
 * one throwing section fails the entire assembly. Since the plugin serves text
 * that a person can also hand-edit in `sections/`, one stray `{{ }}` in a
 * markdown file would otherwise break every model step of the profile.
 *
 * This module therefore mirrors the registry's own scan, reference for
 * reference, and defuses exactly the groups the registry would throw on: it
 * puts a zero-width space after each of the two opening braces, so the text
 * reads the same to a model but no longer starts a reference. Everything the
 * registry can resolve is left untouched, so a variable another row registers
 * still interpolates normally.
 *
 * One caller has no registry pass at all: the compaction instruction is sent to
 * the summarizer as-is, so {@link resolveReferences} substitutes the resolvable
 * references itself and defuses the rest, sharing this scan so the two entry
 * points cannot disagree about what is safe.
 *
 * The scan below is a deliberate mirror of the registry's `interpolate`
 * (`@deepseek-ai/dsh-system-prompt`, `lib/index.js`, its `GROUP_AT` and
 * `VARIABLE_NAME` constants). When that implementation changes shape, this one
 * has to follow.
 *
 * @module @lolkda/dsh-prompt-manager/guard
 */
/** A complete `{{...}}` group at the scan position, as the registry reads it. */
const GROUP_AT = /^\{\{([^{}]*)\}\}/;
/** Variable-name grammar the registry enforces between the braces. */
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/;
/** Longest snippet of an unusable reference carried into a report. */
const SNIPPET_LENGTH = 16;
/**
 * Zero-width space, inserted after each brace of a reference that must not
 * resolve. It is invisible in rendered prose, and because every emitted `{` is
 * followed by one, neither the escaped reference nor its neighbours can ever
 * re-form a `{{` pair.
 */
export const ESCAPE_MARK = '\u200b';
/** One defused reference, as it appears in the guarded text. */
function escapedOpener() {
    return `{${ESCAPE_MARK}{${ESCAPE_MARK}`;
}
/** Whether one reference name resolves for the assembly being rendered. */
function resolvable(name, variables) {
    return VARIABLE_NAME.test(name) && Object.hasOwn(variables, name) && variables[name] !== undefined;
}
/**
 * Defuse every reference the registry would throw on, leaving resolvable ones
 * for the registry to interpolate.
 *
 * A reference is defused when its shape is not a variable name, when no
 * variable of that name exists for this assembly, or when the variable exists
 * but has no value. A lone `{{` with no later `}}` is literal prose to the
 * registry and is left exactly as it is.
 *
 * @param text - the section text about to be handed to the registry.
 * @param variables - the names the registry will resolve for this assembly.
 * @returns the safe text and the references that were defused.
 */
export function sanitizeReferences(text, variables) {
    return scanReferences(text, variables, false);
}
/**
 * The same scan, with resolvable references substituted instead of handed on.
 *
 * A compaction instruction is not a section: no registry pass will render it, so
 * whoever sends it has to finish the job. This entry point does exactly what the
 * registry would — substitute a resolvable reference, defuse the rest — and it
 * shares the scan above rather than repeating it, so the two can never disagree
 * about which references are safe.
 *
 * A substituted value is never rescanned, for the same reason the registry does
 * not rescan one: a value that happens to contain `{{...}}` is data, not a
 * reference.
 *
 * @param text - the text about to be sent as-is.
 * @param variables - the names that can be resolved for this send.
 * @returns the rendered text and the references that were defused.
 */
export function resolveReferences(text, variables) {
    return scanReferences(text, variables, true);
}
/**
 * Walk the text reference by reference and build the safe version.
 *
 * This is the one scan both entry points use, and a deliberate mirror of the
 * registry's `interpolate`. When that implementation changes shape, this one has
 * to follow — once, not twice.
 *
 * @param text - the text to scan.
 * @param variables - the names that resolve for this pass.
 * @param substitute - replace a resolvable reference with its value instead of
 * copying it through for a later registry pass.
 * @returns the safe text and the references that were defused.
 */
function scanReferences(text, variables, substitute) {
    const escaped = [];
    let result = '';
    let last = 0;
    let open = text.indexOf('{{');
    while (open >= 0) {
        const group = GROUP_AT.exec(text.slice(open));
        if (group === null) {
            // No complete group here. The registry only fails a stray opener when a
            // closer follows it somewhere; otherwise the opener is ordinary prose.
            if (text.indexOf('}}', open + 2) >= 0) {
                result += text.slice(last, open) + escapedOpener();
                escaped.push(text.slice(open, open + SNIPPET_LENGTH));
            }
            else {
                result += text.slice(last, open + 2);
            }
            last = open + 2;
            open = text.indexOf('{{', last);
            continue;
        }
        const name = group[0].slice(2, -2);
        const value = resolvable(name, variables) ? variables[name] : undefined;
        if (value !== undefined) {
            result += text.slice(last, open) + (substitute ? value : group[0]);
            last = open + group[0].length;
        }
        else {
            // Defuse the opener and keep the body of the reference verbatim: the
            // prose a person wrote must survive, closing braces included.
            result += text.slice(last, open) + escapedOpener();
            escaped.push(group[0]);
            last = open + 2;
        }
        open = text.indexOf('{{', last);
    }
    return { text: result + text.slice(last), escaped };
}
/**
 * The references that can never resolve, whatever else is registered.
 *
 * A malformed group throws for every deployment, so a save can refuse it up
 * front. A well-formed name is not listed: another row may register it, and a
 * name that is merely unregistered today is a body the person may still be
 * writing.
 *
 * @param text - the body about to be stored.
 * @returns the unusable references, deduplicated, in the order they appear.
 */
export function malformedReferences(text) {
    const found = [];
    const seen = new Set();
    let last = 0;
    let open = text.indexOf('{{');
    while (open >= 0) {
        const group = GROUP_AT.exec(text.slice(open));
        if (group === null) {
            if (text.indexOf('}}', open + 2) >= 0) {
                const snippet = text.slice(open, open + SNIPPET_LENGTH);
                if (!seen.has(snippet)) {
                    seen.add(snippet);
                    found.push(snippet);
                }
            }
            last = open + 2;
            open = text.indexOf('{{', last);
            continue;
        }
        const name = group[0].slice(2, -2);
        if (!VARIABLE_NAME.test(name) && !seen.has(group[0])) {
            seen.add(group[0]);
            found.push(group[0]);
        }
        last = open + group[0].length;
        open = text.indexOf('{{', last);
    }
    return found;
}
//# sourceMappingURL=guard.js.map