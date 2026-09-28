// THE QUEUE NEVER MOVES A CARD THE HUMAN IS LOOKING AT (maintainer 2026-09-28: "it needs to be guaranteed
// that cards that I'm currently viewing on the screen don't move in their position"). This is the ORDER
// half of that guarantee; lib/viewportLock.ts is the SCROLL half, and neither is enough alone.
//
// The queue's own order (groups.ts orderQueue: when each thread entered the queue) is the truth, and
// everything OFF screen follows it exactly. The cards ON screen — the RUN, one contiguous stretch of the
// list — are frozen as they were drawn: nothing is inserted between them, none of them swaps, and none of
// them disappears on its own. A card ALREADY DRAWN sorts above the run or below it, by where it falls
// against the run's live cards; a card NOT drawn before — an arrival, a card coming back — always goes
// BELOW the run while the run is on screen, whatever its stamp says. A card crossing from below the run
// to above it moves the run in the document by exactly its height, and there is always room to scroll by
// that much (it was below the screen, so the page extends at least that far), so the viewport lock
// absorbs it; a change below the run moves nothing at all. An arrival above the run would need room the
// page may not have — a short queue cannot scroll far enough to hide it — and its stamp can be earlier
// than cards already drawn for reasons nobody acted on (another project's poll landing a few seconds
// late, a server restart re-listing its queue, a dismissal the server did not take coming back), so it
// never gets the chance. It joins the bottom as a queue's should (FIFO); newest-first (LIFO), it waits
// under the run and takes its place at the top once the run has moved on.
//
// A card whose thread leaves the queue while its card is on screen, without the human putting it away
// (it woke itself on a finished shell, a child's return, a timer; or someone acted on it from another
// tab), becomes a GHOST: it keeps its place, drawn quiet, until it scrolls off screen — or until the
// thread rests again, when it is simply the card again, in the same place. A card the human put away
// (done, snooze, a reply sent from its own box) is not a ghost; it leaves the ordinary way, and anything
// that follows it moving is the human's own doing.

export interface QueueSlot<T> {
  key: string
  item: T
  /** The thread left the queue on its own while its card was on screen; the card holds its place. */
  ghost: boolean
}

export interface StableQueueInput<T> {
  /** What the last render drew, in order (ghosts included). Empty on first draw: the queue's own order. */
  prev: readonly QueueSlot<T>[]
  /** The queue's own order now. */
  target: readonly T[]
  keyOf: (item: T) => string
  /** Keys of the slots the last measurement found on screen (lib/viewportLock.ts measures them). */
  onScreen: ReadonlySet<string>
  /**
   * Whether a card that just left the queue may stay as a ghost. False for a thread the human put away
   * — archived, snoozed, answered from here — which leaves the ordinary way.
   */
  mayGhost: (key: string) => boolean
  /**
   * Keys still drawn as ordinary cards although the queue no longer lists them: a card the human
   * dismissed, fading out after the board dropped it. Only honoured on screen; off screen the fade is
   * invisible and the card simply goes.
   */
  keep?: ReadonlySet<string>
}

export function stableQueue<T>({ prev, target, keyOf, onScreen, mayGhost, keep }: StableQueueInput<T>): QueueSlot<T>[] {
  const live = new Map<string, { item: T; index: number }>()
  target.forEach((item, index) => live.set(keyOf(item), { item, index }))

  // The RUN: from the first slot on screen to the last, exactly as drawn. On screen is measured on the
  // previous commit, so it names slots of `prev`; a key no longer in `prev` is not on screen.
  let lo = -1
  let hi = -1
  prev.forEach((slot, index) => {
    if (!onScreen.has(slot.key)) return
    if (lo < 0) lo = index
    hi = index
  })
  const run: QueueSlot<T>[] = []
  if (lo >= 0) {
    for (const slot of prev.slice(lo, hi + 1)) {
      const now = live.get(slot.key)
      if (now) run.push({ key: slot.key, item: now.item, ghost: false })
      else if (keep?.has(slot.key)) run.push({ key: slot.key, item: slot.item, ghost: false })
      else if (mayGhost(slot.key)) run.push({ key: slot.key, item: slot.item, ghost: true })
      // Otherwise it leaves: the human put it away, so what follows it closing up is theirs.
    }
  }
  const inRun = new Set(run.map((slot) => slot.key))

  // Above or below the run. A card not drawn before goes below. One already drawn is placed against the
  // run's LIVE cards when it has any: a card that sorts before all of them goes above, anything else below
  // — so a card whose place is BETWEEN two cards on screen waits under them rather than pushing one of
  // them down. With no live card on screen (only ghosts) it stays on the side it was already on.
  let pivot = Number.POSITIVE_INFINITY
  for (const slot of run) {
    const index = live.get(slot.key)?.index
    if (index !== undefined && index < pivot) pivot = index
  }
  const prevIndex = new Map(prev.map((slot, index) => [slot.key, index]))
  const above = (key: string, index: number): boolean => {
    const was = prevIndex.get(key)
    if (lo < 0 || was === undefined) return false
    if (pivot !== Number.POSITIVE_INFINITY) return index < pivot
    return was < lo
  }

  const before: QueueSlot<T>[] = []
  const after: QueueSlot<T>[] = []
  for (const [key, { item, index }] of live) {
    if (inRun.has(key)) continue
    ;(above(key, index) ? before : after).push({ key, item, ghost: false })
  }
  return [...before, ...run, ...after]
}

/**
 * What a ghost says in place of since-when-it-was-ready: where its thread went, so a card that stopped
 * waiting while the human read it says so rather than just going quiet. `gone` is a thread the view can
 * no longer see — done from somewhere without a list of done threads, forgotten, or its project closed.
 */
export type GhostReason = "working" | "snoozed" | "done" | "gone"
export const GHOST_LABEL: Record<GhostReason, string> = {
  working: "Back at work",
  snoozed: "Snoozed",
  done: "Done",
  gone: "No longer waiting",
}
