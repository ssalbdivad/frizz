// WHO TOOK THE CARD AWAY. lib/stableQueue.ts holds a card that leaves the queue while it is on screen in
// its place as a GHOST, because a card the human is reading must not vanish and pull the ones below it
// up (David 2026-09-28: "it needs to be guaranteed that cards that I'm currently viewing on the
// screen don't move in their position") — unless the human took it away, which is a move they asked for.
// The board cannot say which: a thread back at work reads the same whether its agent woke itself or the
// human replied, and a card marked done reads the same from this tab as from a phone. This tab can,
// because every act on a thread goes through its RPC client, which notes each one here before it sends.
//
// The project list reads the same record (lib/heldLayout.ts): while the pointer is over it, a row moves only
// if this tab moved its thread.
//
// Only an act from THIS tab counts. A reply from another window, a snooze from the phone, a worker that
// woke on its own — to the reader of this page those are all things that happened TO the card they were
// looking at, so it stays where it was, as a ghost, until they scroll it away.

/** How long an act keeps its thread's card from ghosting: past the round trip and the board push behind it. */
const ACT_MS = 30_000

// Calls that change nothing the queue reads: a card read, a link opened.
const PASSIVE = new Set(["markRead", "threadSeen", "openExternal", "openLocalFile", "openThreadFolder", "openProjectFolder", "composeTake"])

const acted = new Map<string, number>()

/** Called by the RPC client for every mutation, before it is sent — and with its result, which names a dispatched thread. */
export function noteRpcMutation(name: string, input: unknown, now = Date.now()): void {
  if (PASSIVE.has(name) || name.startsWith("list") || name.startsWith("get")) return
  // Every thread-scoped mutation names its thread `slug` (api/contract.ts).
  const slug = (input as { slug?: unknown } | null | undefined)?.slug
  if (typeof slug === "string") acted.set(slug, now)
}

/** Whether the human acted on this thread from this tab in the last half minute. */
export function actedOnHere(slug: string, now = Date.now()): boolean {
  const at = acted.get(slug)
  return at !== undefined && now - at < ACT_MS
}

/** Test seam: forget every act. */
export function resetHumanActs(): void {
  acted.clear()
}
