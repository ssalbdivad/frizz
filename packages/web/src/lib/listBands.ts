import type { ThreadView } from "@frizz/shared"
import { isPinned, orderByInteraction, queued, sectionOf } from "../groups.ts"
import { threadKey, type QueuesProject } from "./allQueues.ts"
import { optimisticallyArchived } from "./optimisticArchive.ts"
import { optimisticallySteered } from "./steering.ts"

// THE PROJECT LIST'S LOUD BANDS — a project's work in flight, as its rows list it (components/ProjectList.tsx).
// Pure, so the banding and the optimism over it are tested without a component around them.

export interface LoudBands {
  /** Every pinned thread, whatever its state: the pin is the human's shelf, and it outranks Done. */
  pinned: ThreadView[]
  ready: ThreadView[]
  working: ThreadView[]
  /** The threads whose card is in the queue — a Ready row, or a pinned one that is Ready — which the cord
   *  across the gutter ties to that card (ThreadConnector). */
  carded: ReadonlySet<string>
  rows: number
}

/**
 * What the operator has just done to a project's threads that the poll cannot know yet, as one overlay
 * for its rows. The page project's drawer files its records by bare slug; a card or a row files them under
 * the thread's key, whatever the project (lib/steering.ts markSteeredIn) — so a bare slug is read for the
 * page project alone, where it cannot name another project's thread of the same name. Done is only ever
 * predicted from the drawer (a card's Mark as done takes its row with the card), so it is the page's alone.
 */
export function listOverlay(
  projectId: string,
  onPage: boolean,
  steeredAt: Readonly<Record<string, number>>,
  archivingAt: Readonly<Record<string, number>>,
  nowMs = Date.now(),
): (t: ThreadView) => ThreadView {
  return (t) => {
    const keyed = steeredAt[threadKey(projectId, t.id)]
    const bare = onPage ? steeredAt[t.id] : undefined
    const steered = optimisticallySteered(t, keyed === undefined || (bare !== undefined && bare > keyed) ? bare : keyed, nowMs)
    return onPage ? optimisticallyArchived(steered, archivingAt[t.id], nowMs) : steered
  }
}

/**
 * A project's work in flight, as its rail banded it: Pinned first (the pin diverts a thread out of every
 * other band, groups.ts sectionThreads), then Ready in queue order, then Working. A Ready card being
 * finished leaves its row with it (`hidden`); one open in a drawer keeps its row, marked open.
 *
 * `overlay` is what the operator has just done that the poll cannot know yet (lib/steering.ts,
 * lib/optimisticArchive.ts): a reply, an answer or a Retry sets the thread to work, so its row leaves
 * Ready for Working the moment it is sent — the rail did this until 2026-09-28, and the list replacing it
 * showed the row vanish with its card and come back under Working a poll later. The bands are re-derived
 * from the overlaid threads by the rail's own predicates, so the row lands where the server will put it.
 */
export function loudBands(project: QueuesProject, hidden: (key: string) => boolean, overlay: (t: ThreadView) => ThreadView = (t) => t): LoudBands {
  const pinned = [...project.queued, ...project.running, ...project.snoozed].filter(isPinned).map(overlay)
  pinned.sort((a, b) => (a.pinnedAt ?? "").localeCompare(b.pinnedAt ?? "") || a.id.localeCompare(b.id))
  const flight = [...project.queued, ...project.running].filter((t) => !isPinned(t)).map(overlay)
  const ready = flight.filter((t) => queued(t) && !hidden(threadKey(project.id, t.id)))
  const working = orderByInteraction(flight.filter((t) => !queued(t) && sectionOf(t) === "active"))
  const carded = new Set([...pinned.filter(queued), ...ready].map((t) => t.id))
  return { pinned, ready, working, carded, rows: pinned.length + ready.length + working.length }
}
