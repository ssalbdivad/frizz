import { subAgentAddress, subAgentChain, subAgentHandle, threadHandle } from "@frizz/shared"
import { foldThreadName, type NamedThread } from "./thread-names.ts"

// ONE THREAD POINTING AT ANOTHER BY HANDLE — "ask @shellBudgets about this", "reconcile with @focusMode"
// (maintainer 2026-09-29). The handle is the camelCase form of the thread's name (shared thread-handle.ts),
// which is what the board SHOWS, so the operator and the worker type the same thing.
//
// Both sides are folded from the HANDLE, never from the stored words: `foldThreadName` strips a plural on
// the LAST word, and "Dev ops" is two words ("dev" + "ops", too short to strip) while `devOps` is one
// ("devops" → "devop"). Folding the handle on both sides makes every spelling of it agree.

/** The handle a named thread is addressed by — its camelCase name, or, for a name too long to have one
 *  (a legacy sentence title, a long session title), its SLUG in camelCase, which resolves the same way —
 *  so every thread is addressable, and always by something shaped like a handle. */
export function handleOf(t: Pick<NamedThread, "name" | "slug">): string {
  return threadHandle(t.name) ?? threadHandle(t.slug.replace(/-/g, " ")) ?? t.slug
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

// A THREAD'S SUB-AGENTS, BY ADDRESS — `portTheParser.cacheKeys` (shared thread-handle.ts), resolved against
// the thread's sub-agent DIRECTORY: every child it ever dispatched, live first, then finished ones newest
// first (tailer subAgentDirectory). A name reused over a thread's life — a second "Review" an hour after the
// first — therefore means the one still running, else the latest, the way a thread handle means the open
// thread before a finished one; the id always names exactly one.

type Child = { readonly id: string; readonly label: string; readonly parentId?: string; readonly state: string; readonly outcome?: string }

/** The sub-agent `segments` walks down to under one thread, or undefined. Each segment matches a child
 *  of the one before it (the thread's own children first) by its handle, folded like a thread's, or by
 *  its id. Among several matches the directory's order decides — live before finished, newest finished
 *  first — with a RUNNING child ahead of a quiet live one. */
export function resolveSubAgent<T extends Child>(segments: readonly string[], agents: readonly T[]): T | undefined {
  let parentId: string | undefined
  let hit: T | undefined
  for (const segment of segments) {
    const want = key(segment)
    const matches = agents.filter((a) => a.parentId === parentId && (a.id === segment || (want !== "" && key(subAgentHandle(a.label) ?? "") === want)))
    hit = matches.find((a) => a.state === "running") ?? matches[0]
    if (!hit) return undefined
    parentId = hit.id
  }
  return hit
}

/** The addresses a miss is answered with, live first and finished ones tagged, capped like thread
 *  handles. A child with no handle (a sentence-length description) has no address and is left out. */
export function subAgentAddresses(threadHandle: string, agents: readonly Child[], cap = 40): string[] {
  return agents
    .flatMap((a) => {
      const chain = subAgentChain(agents, a.id)
      return chain ? [`@${subAgentAddress(threadHandle, chain)}${a.state === "done" ? " (done)" : ""}`] : []
    })
    .slice(0, cap)
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
    // Read in two places: as the wait's name on the card while it stands, and as the wake if it fires —
    // so the first sentence is the wait and the rest is conditional on it having run out.
    `Waiting on @${handle} to reply (thread \`${slug}\`). If this fires, no answer came in time: read where it is ` +
    "with `mcp__frizz__read_thread`, then ask again with `mcp__frizz__message_thread` (`await_reply: true`) if " +
    "the answer still matters, or go on without it."
  )
}

export function isReplyWait(prompt: string): boolean {
  return prompt.startsWith("Waiting on @") && prompt.includes(" to reply (thread `")
}

export function isReplyWaitFor(prompt: string, slug: string): boolean {
  return isReplyWait(prompt) && prompt.includes(`(thread \`${slug}\`)`)
}
