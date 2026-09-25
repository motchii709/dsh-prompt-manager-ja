/**
 * The compaction instruction: the text a context compaction sends to the model
 * that writes the summary, and this plugin's ability to replace it.
 *
 * A compaction is one extra model call. The engine replays the conversation's
 * own prefix — system prompt, tools, and the messages about to be shadowed — and
 * appends the instruction as the *final user message*, so the call stays a
 * genuine prefix of the last request and the provider's KV cache is reused. That
 * call goes through `ctx.llm.stream({ purpose: 'compaction' })`, and the LLM
 * runtime dispatches every such call through the `llm/stream` waterfall — which
 * is the seam this module uses.
 *
 * Two properties of that seam shape everything below:
 *
 * - A request built by the agent loop arrives deep-frozen, because its content
 *   is a pure function of the session log; listeners read it and never rewrite
 *   it. A compaction call is hand-built by the engine instead, which is why it
 *   can be rewritten at all. The gate is `purpose`, not freezing.
 * - The adapter reads `options.messages` when it dispatches, so a listener that
 *   replaces the array before calling `next()` changes what actually goes out.
 *
 * What this module deliberately does **not** do is touch the checkpoint that
 * lands in the session afterwards — the "automatically generated checkpoint"
 * preamble and the `<compacted-summary>` tags around the summary. Those are
 * assembled by the backend's own private framing *after* the summary returns, so
 * nothing on this seam can reach them; changing them means implementing a
 * compaction backend of your own.
 *
 * @module @lolkda/dsh-prompt-manager/compaction
 */
import type { Context } from '@deepseek-ai/cordis';
/** What the plugin answers about the instruction in force right now. */
export interface CompactionPromptHost {
    /**
     * The instruction to send instead of DSH's own, or `undefined` to leave the
     * request exactly as it is. Called once per compaction, so it may read the
     * index, the settings document, and the body file directly.
     */
    resolve(sessionId: string | undefined): {
        id: string;
        text: string;
    } | undefined;
    /** The names a body may reference, exactly as a section's body may. */
    variables(): Readonly<Record<string, string | undefined>>;
    /** Report a non-fatal problem; implementations deduplicate or not as they see fit. */
    warn(message: string): void;
}
/** What a deployment can see about this feature without running a compaction. */
export interface CompactionPromptStats {
    /** Compaction calls seen since this mount. */
    matches: number;
    /** Calls whose instruction was replaced. */
    replacements: number;
    /** When the last replacement happened, ISO-8601, or `''`. */
    lastReplacedAt: string;
    /** Characters that last replacement carried, or `0`. */
    characters: number;
}
/** The installed feature, as the rest of the plugin refers to it. */
export interface CompactionPrompt {
    /** A snapshot of the counters above. */
    stats(): CompactionPromptStats;
}
/**
 * Replace the compaction instruction with the one this deployment configured.
 *
 * Registered only when the deployment has an LLM: a composition without one
 * (the TUI and SDK profiles) mounts the rest of the plugin and never sees a
 * compaction call at all. Listening on the injected context means the listener
 * also disappears with the service rather than outliving it.
 *
 * @param ctx - the plugin context whose `llm` service is injected.
 * @param host - which instruction is in force, the variable table, and logging.
 * @returns the installed feature, for health reporting.
 */
export declare function installCompactionPrompt(ctx: Context, host: CompactionPromptHost): CompactionPrompt;
//# sourceMappingURL=compaction.d.ts.map