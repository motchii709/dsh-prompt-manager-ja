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

import type { Context } from '@deepseek-ai/cordis'
// Type-only side-effect import: the declaration augments the event map with the
// `llm/stream` waterfall this module listens on, and an augmentation only applies
// when its module is part of the program. Erased at emit, so a deployment without
// an LLM never loads the package at runtime.
import type {} from '@deepseek-ai/dsh-llm'
import { resolveReferences } from './guard.js'

/**
 * Message provenance that identifies the instruction in a compaction request.
 *
 * The engine tags the message it appends with its own plugin name, which is how
 * the instruction is found without counting messages. The count is the fallback,
 * not the rule.
 */
const INSTRUCTION_PLUGIN = 'dsh-compaction-basic'

/** Largest number of unusable references reported before the log is reset. */
const REPORT_LIMIT = 64

/** What the plugin answers about the instruction in force right now. */
export interface CompactionPromptHost {
  /**
   * The instruction to send instead of DSH's own, or `undefined` to leave the
   * request exactly as it is. Called once per compaction, so it may read the
   * index, the settings document, and the body file directly.
   */
  resolve(sessionId: string | undefined): { id: string; text: string } | undefined
  /** The names a body may reference, exactly as a section's body may. */
  variables(): Readonly<Record<string, string | undefined>>
  /** Report a non-fatal problem; implementations deduplicate or not as they see fit. */
  warn(message: string): void
}

/** What a deployment can see about this feature without running a compaction. */
export interface CompactionPromptStats {
  /** Compaction calls seen since this mount. */
  matches: number
  /** Calls whose instruction was replaced. */
  replacements: number
  /** When the last replacement happened, ISO-8601, or `''`. */
  lastReplacedAt: string
  /** Characters that last replacement carried, or `0`. */
  characters: number
}

/** The installed feature, as the rest of the plugin refers to it. */
export interface CompactionPrompt {
  /** A snapshot of the counters above. */
  stats(): CompactionPromptStats
}

/** The slice of a request this module reads. */
interface RequestLike {
  purpose?: unknown
  messages?: unknown
  [field: string]: unknown
}

/**
 * Read one dispatched value as a request, when it is an object.
 * @param value - the first argument of the `llm/stream` listener.
 * @returns the request, or `undefined` for anything else.
 */
function asRequest(value: unknown): RequestLike | undefined {
  return typeof value === 'object' && value !== null ? (value as RequestLike) : undefined
}

/**
 * Which message carries the instruction.
 *
 * The engine's own message is found first, whatever position it holds. Only when
 * no message carries that provenance does this fall back to the last message,
 * which is where the instruction is appended: a count is a guess about another
 * package's implementation, and a guess that silently replaced the wrong message
 * would corrupt the summary call rather than fail it.
 *
 * @param messages - the request's message list.
 * @returns the index to replace, or `-1` for an empty list.
 */
function instructionIndex(messages: readonly unknown[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const source = (messages[index] as { source?: unknown } | null)?.source
    if (typeof source === 'object' && source !== null && (source as { plugin?: unknown }).plugin === INSTRUCTION_PLUGIN) {
      return index
    }
  }
  return messages.length - 1
}

/**
 * One message with its text replaced, everything else kept byte for byte.
 *
 * A shallow copy rather than an edit in place: the message may be frozen, and
 * its identity, role, and provenance are what the engine and the session log
 * rely on. Non-text blocks are carried over in order, so an instruction that
 * ever gained an attachment keeps it.
 *
 * @param original - the message being replaced.
 * @param text - the instruction text to send.
 * @returns a new message object.
 */
function withInstruction(original: unknown, text: string): unknown {
  const record = typeof original === 'object' && original !== null ? (original as Record<string, unknown>) : {}
  const content = Array.isArray(record['content']) ? record['content'] : []
  const carried = content.filter((block) => {
    const type = typeof block === 'object' && block !== null ? (block as { type?: unknown }).type : undefined
    return type !== 'text'
  })
  return { ...record, content: [{ type: 'text', text }, ...carried] }
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
export function installCompactionPrompt(ctx: Context, host: CompactionPromptHost): CompactionPrompt {
  const state: CompactionPromptStats = { matches: 0, replacements: 0, lastReplacedAt: '', characters: 0 }
  /** Reports already made, so one misconfigured instruction cannot flood the log. */
  const reported = new Set<string>()

  /**
   * Report one problem once per signature.
   * @param key - the signature.
   * @param message - what to say.
   */
  const report = (key: string, message: string): void => {
    if (reported.has(key)) return
    reported.add(key)
    if (reported.size > REPORT_LIMIT) reported.clear()
    host.warn(message)
  }

  ctx.inject(['llm'], (scoped) => {
    scoped.on('llm/stream', (options, next) => {
      const request = asRequest(options)
      // The first check, and the cheapest one: every ordinary model call takes
      // this branch, and none of them carries a purpose.
      if (request === undefined || request.purpose !== 'compaction') return next()
      state.matches += 1

      // The request names the session it summarises, so the instruction this
      // plugin sends can be the one that session chose.
      const sessionId = typeof request['sessionId'] === 'string' ? request['sessionId'] : undefined
      const instruction = host.resolve(sessionId)
      // Nothing configured, or the configured thing is unusable: the request goes
      // out exactly as the engine built it. This is the default state of every
      // deployment that never made a compaction entry, so it must stay free of
      // side effects.
      if (instruction === undefined) return next()

      const messages = Array.isArray(request.messages) ? request.messages : []
      if (messages.length === 0) {
        report(`${instruction.id}\u0000no-message`, `圧縮命令 ${instruction.id} が有効ですが、今回の圧縮リクエストに置き換えるメッセージがありません。DSH 内蔵の命令をそのまま使用しました`)
        return next()
      }

      const index = instructionIndex(messages)
      // The same rendering a section gets, finished in one pass because no
      // registry step follows this text.
      const rendered = resolveReferences(instruction.text, host.variables())
      for (const reference of rendered.escaped) {
        report(
          `${instruction.id}\u0000${reference}`,
          `${instruction.id} の本文が ${JSON.stringify(reference)} を参照しています。レジストリが解析できないためリテラルとしてレンダリングしました（この参照を変更するか、いずれかのソースでその名前を登録してください）`,
        )
      }

      try {
        request.messages = [
          ...messages.slice(0, index),
          withInstruction(messages[index], rendered.text),
          ...messages.slice(index + 1),
        ]
      } catch (error) {
        // A request this module cannot rewrite is not a failed compaction: the
        // engine's own instruction is still perfectly usable.
        report(
          `${instruction.id}\u0000frozen`,
          `圧縮命令 ${instruction.id} は今回のリクエストを置き換えられませんでした（${messageOf(error)}）。DSH 内蔵の命令をそのまま使用しました`,
        )
        return next()
      }

      state.replacements += 1
      state.lastReplacedAt = new Date().toISOString()
      state.characters = rendered.text.length
      return next()
    // `global` on purpose: a framework is free to deliver a request only to
    // listeners in the emitting context's own realm, and this listener has to
    // follow a call wherever it was issued from. Registering it non-global would
    // make interception depend on which plane happens to run the backend — and
    // the failure would be silent, because nothing reports a compaction that was
    // left alone.
    }, { global: true })
  })

  return { stats: () => ({ ...state }) }
}
