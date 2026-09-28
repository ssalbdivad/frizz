// THE QUEUE NEVER MOVES A CARD THE HUMAN IS LOOKING AT (maintainer 2026-09-28: "it needs to be guaranteed
// that cards that I'm currently viewing on the screen don't move in their position"). This is the ORDER
// half of that guarantee; lib/viewportLock.ts is the SCROLL half, and neither is enough alone.
//
// The queue's own order (groups.ts orderQueue: when each thread entered the queue) is the truth, and
// everything OFF screen follows it exactly. The cards ON screen — the RUN, one contiguous stretch of the
// list — are frozen as they were drawn: nothing is inserted between them, none of them swaps, and none of
// them disappears on its own. Every other card sorts ABOVE the run or BELOW it, by where it falls against
// the run's live cards. A change above the run moves the run in the document, and the viewport lock
// scrolls by exactly that much, so on screen it moves nothing; a change below the run moves nothing at
// all. So an arrival joins the bottom as a queue's should (FIFO), lands above the viewport under the
// newest-first preference (LIFO), and a thread returning to an old place in line (the server's
// queue-clock keeps a self-woken thread's place) waits BELOW the run until its slot is off screen.
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

  // Above or below the run. Against the run's LIVE cards when it has any: a card that sorts before all of
  // them goes above, anything else below — so a card whose place is BETWEEN two cards on screen waits
  // under them rather than pushing one of them down. With no live card on screen (nothing drawn there, or
  // only ghosts) a card stays on the side it was already on, and a new one goes below what is on screen.
  let pivot = Number.POSITIVE_INFINITY
  for (const slot of run) {
    const index = live.get(slot.key)?.index
    if (index !== undefined && index < pivot) pivot = index
  }
  const prevIndex = new Map(prev.map((slot, index) => [slot.key, index]))
  const above = (key: string, index: number): boolean => {
    if (pivot !== Number.POSITIVE_INFINITY) return index < pivot
    const was = prevIndex.get(key)
    return lo >= 0 && was !== undefined && was < lo
  }

  const before: QueueSlot<T>[] = []
  const after: QueueSlot<T>[] = []
  for (const [key, { item, index }] of live) {
    if (inRun.has(key)) continue
    ;(above(key, index) ? before : after).push({ key, item, ghost: false })
  }
  return [...before, ...run, ...after]
}
