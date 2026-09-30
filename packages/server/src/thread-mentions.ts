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
 *  finished one that carried it. The SLUG resolves too, folded the same way: it is minted from the
 *  dispatch title, so `@teaRecipes` still finds a thread dispatched as "Tea recipes" whose shown name has
 *  since become Claude's own session title (seen on a real run, 2026-09-29). */
export function resolveThreadHandle(handle: string, threads: readonly NamedThread[]): NamedThread | undefined {
  const bare = handle.trim().replace(/^@/, "")
  const want = key(bare)
  if (!want) return undefined
  const named = threads.filter((t) => key(handleOf(t)) === want || t.slug === bare)
  const hits = named.length ? named : threads.filter((t) => key(t.slug) === want)
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

/** The delivered text: who it is from, whether they are waiting, and how to answer. */
export function threadMessageBody(input: { fromHandle: string; message: string; awaitsReply?: boolean; answersWait?: boolean }): string {
  const from = input.fromHandle
  const how = input.awaitsReply
    ? `@${from} is WAITING on your answer — it is parked until you reply. Answer with \`mcp__frizz__message_thread\` ` +
      `(handle \`${from}\`) as soon as you can, even if only to say you cannot help; it reaches that thread, not the human.`
    : `Answer with \`mcp__frizz__message_thread\` (handle \`${from}\`) only if it asks you something; it reaches that ` +
      "thread, not the human. Do not reply just to acknowledge."
  return [
    `Message from @${from}, another Frizz thread in this project${input.answersWait ? " — this answers the message you were waiting on" : ""}:`,
    "",
    input.message,
    "",
    "---",
    `${how} Do not drop your own work for it unless it matters to that work. ` +
      `\`mcp__frizz__read_thread\` reads @${from}'s own request, approach and latest handoff.`,
  ].join("\n")
}

// A REPLY WAIT is an ordinary one-off timer whose prompt names the thread it waits on. The prompt is also
// its NAME on the card and in `activity`, so it reads as the wait; the `(thread \`slug\`)` tail is what
// the answer is matched by (the handle can change with a rename, the slug cannot).
export function replyWaitPrompt(handle: string, slug: string): string {
  return (
    `Waiting on @${handle} to reply (thread \`${slug}\`) — it has not answered in time. Read where it is with ` +
    "`mcp__frizz__read_thread`, then ask again with `mcp__frizz__message_thread` (`await_reply: true`) if the " +
    "answer still matters, or go on without it."
  )
}

export function isReplyWait(prompt: string): boolean {
  return prompt.startsWith("Waiting on @") && prompt.includes(" to reply (thread `")
}

export function isReplyWaitFor(prompt: string, slug: string): boolean {
  return isReplyWait(prompt) && prompt.includes(`(thread \`${slug}\`)`)
}
