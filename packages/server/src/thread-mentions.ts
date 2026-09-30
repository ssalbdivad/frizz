import { threadHandle } from "@frizz/shared"
import { foldThreadName, type NamedThread } from "./thread-names.ts"

// ONE THREAD POINTING AT ANOTHER BY HANDLE — "ask @shellBudgets about this", "reconcile with @focusMode"
// (maintainer 2026-09-29). The handle is the camelCase form of the thread's name (shared thread-handle.ts),
// which is what the board SHOWS, so the operator and the worker type the same thing.
//
// Both sides are folded from the HANDLE, never from the stored words: `foldThreadName` strips a plural on
// the LAST word, and "Dev ops" is two words ("dev" + "ops", too short to strip) while `devOps` is one
// ("devops" → "devop"). Folding the handle on both sides makes every spelling of it agree.

/** The handle a named thread is addressed by — its camelCase name, or the slug for a name too long to
 *  have one (a legacy sentence title), so every thread stays addressable by SOMETHING. */
export function handleOf(t: Pick<NamedThread, "name" | "slug">): string {
  return threadHandle(t.name) ?? t.slug
}

function key(handle: string): string {
  return foldThreadName(handle.replace(/^@/, ""))
}

/** The thread `handle` names: an OPEN thread first (names are unique among those), else the most recent
 *  finished one that carried it. A raw slug resolves too. */
export function resolveThreadHandle(handle: string, threads: readonly NamedThread[]): NamedThread | undefined {
  const bare = handle.trim().replace(/^@/, "")
  const want = key(bare)
  if (!want) return undefined
  const hits = threads.filter((t) => key(handleOf(t)) === want || t.slug === bare)
  return hits.find((t) => t.open) ?? [...hits].sort((a, b) => b.at - a.at)[0]
}

/** The handles a worker can use, open threads first and newest first — what a miss is answered with. */
export function knownHandles(threads: readonly NamedThread[], exceptSlug?: string, cap = 40): string[] {
  return [...threads]
    .filter((t) => t.slug !== exceptSlug)
    .sort((a, b) => Number(b.open) - Number(a.open) || b.at - a.at)
    .slice(0, cap)
    .map((t) => `@${handleOf(t)}${t.open ? "" : " (done)"}`)
}

/** How many messages one thread may send ANOTHER per hour. Two workers told to "reconcile with each
 *  other" can each read every reply as something to answer; a loop between them costs a turn per message
 *  on both sides, and nothing a human sees would stop it. Ten is far past any real exchange. */
export const THREAD_MESSAGE_HOURLY_CAP = 10

/** The delivered text: who it is from, how to answer, and when not to. */
export function threadMessageBody(input: { fromHandle: string; message: string }): string {
  return [
    `Message from @${input.fromHandle}, another Frizz thread in this project:`,
    "",
    input.message,
    "",
    `---`,
    `Answer with \`mcp__frizz__message_thread\` (handle \`${input.fromHandle}\`) if it asks you something; ` +
      "its reply reaches that thread, not the human. Do not reply just to acknowledge, and do not drop your own work " +
      `for it unless it matters to that work. \`mcp__frizz__read_thread\` reads @${input.fromHandle}'s own request and latest handoff.`,
  ].join("\n")
}
