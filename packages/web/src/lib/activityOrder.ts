// THE PROJECT LIST'S BUSY RUN, BUSIEST FIRST — projects ordered by how many of their threads are spinning,
// the machine-wide order breaking ties (maintainer 2026-10-06: "order projects in the sidebar by active
// threads without making any reshuffling of projects jarring").
//
// A count moves every time a worker wakes or rests, so the order is kept calm three ways, each one a
// different hazard:
//
//   - NEVER UNDER THE POINTER. The runs are held like every other part of the list while it is (lib/
//     listHold.ts, lib/heldLayout.ts): a project aimed at stays where it was until the pointer leaves.
//   - NOT ON A BLIP. A project ranks by the count it has HELD for SETTLE_MS, not the one it has this
//     instant (`settleCounts`). A turn that ends and a wake that follows it a few seconds later — a
//     sub-agent's return, a watcher firing, the human replying straight away — would otherwise send the
//     project down and back up within one look. Replayed on this machine's transcripts (2026-10-03 to
//     -06, 1,762 turn edges across four projects), the raw count reordered the list 32 times in 72h,
//     2–4 per busy hour; most of the churn is one project's lone worker resting and waking.
//   - NEVER A JUMP. When the order does change, the groups glide to their new places (ProjectList
//     useGlide), so the eye can follow the project it was reading.
//
// A drag stays inside projects ranked level with each other (`tiersOf`): the count, not the order,
// decides which tier a project is in, so a drop across tiers would only spring back — the same reason a
// drag never crosses from the busy projects to the quiet ones.

/** How long a project's spinning count must hold before the list re-ranks on it. */
export const SETTLE_MS = 30_000

/** What the list last ranked a project by, and what its count has been since when. */
export interface Settled {
  ranked: number
  live: number
  liveSince: number
}

/**
 * Each project's count to rank by: its live count once that has held for `settleMs`, else what it ranked
 * by before. A project seen for the first time ranks by its live count at once — nothing was drawn for it
 * to hold — and one no longer listed is forgotten. `wakeAt` is the next instant an answer can change on
 * its own, for the caller's timer.
 */
export function settleCounts(
  prev: ReadonlyMap<string, Settled>,
  live: ReadonlyMap<string, number>,
  now: number,
  settleMs = SETTLE_MS,
): { settled: Map<string, Settled>; wakeAt: number | null } {
  const settled = new Map<string, Settled>()
  let wakeAt: number | null = null
  for (const [id, count] of live) {
    const before = prev.get(id)
    let entry: Settled = before ? { ...before } : { ranked: count, live: count, liveSince: now }
    if (entry.live !== count) entry = { ...entry, live: count, liveSince: now }
    if (entry.ranked !== entry.live) {
      if (now - entry.liveSince >= settleMs) entry.ranked = entry.live
      else wakeAt = Math.min(wakeAt ?? Infinity, entry.liveSince + settleMs)
    }
    settled.set(id, entry)
  }
  return { settled, wakeAt }
}

/** `items` (already in the machine-wide order) ranked by `rankOf`, highest first, the order breaking ties. */
export function byActivity<T>(items: readonly T[], rankOf: (item: T) => number): T[] {
  return items
    .map((item, index) => ({ item, index, rank: rankOf(item) }))
    .sort((a, b) => b.rank - a.rank || a.index - b.index)
    .map((entry) => entry.item)
}

/**
 * `items` AS DRAWN cut into its runs of equal rank — the runs a drag stays inside. Cut where drawn, not
 * re-sorted: while the list is held it can still draw a project in a place its rank has since left, and a
 * drag must move among the groups the human can see side by side.
 */
export function tiersOf<T>(items: readonly T[], rankOf: (item: T) => number): T[][] {
  const tiers: T[][] = []
  let last: number | null = null
  for (const item of items) {
    const rank = rankOf(item)
    if (rank !== last) tiers.push([])
    tiers[tiers.length - 1]!.push(item)
    last = rank
  }
  return tiers
}
