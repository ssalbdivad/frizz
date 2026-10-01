import { activeBandThread, type BoardSnapshot, type ThreadView } from "@frizz/shared"
import { isPinned, orderByInteraction, orderQueue, sectionThreads, sessionIndicatorKind, type QueueDirection } from "../groups.ts"
import { isBusy, threadKey, type QueuesProject } from "./allQueues.ts"
import { loudBands } from "./listBands.ts"

// THE PHONE PAGE'S MODEL — what each of its three tabs lists, across the projects the view shows
// (components/PhonePage.tsx). Pure, so the banding is tested without a browser and the component stays a
// layout.
//
// It is upstream's phone board (colinhacks/frizz MobileBoard.tsx, 2026-09-30) brought onto the fork's ONE
// page: that board listed one project's `sectionThreads`; this lists whichever projects the page's view
// shows — one when focused, every one in All projects — from the same machine-wide reads the desktop's
// list and queue draw (lib/allQueues.ts), banded by the list's own `loudBands` so a phone and a desktop
// can never disagree about which band a thread is in.
//
// THE QUEUE IS READY AND WORKING TOGETHER, asks first — upstream's call (maintainer review 2026-08-17:
// "something is active until it's marked done"), and on the one screen a phone has, "what needs me" earns
// the top. Within that, upstream's own order: PINNED leads (the phone has no pinned band, so the human's
// shelf folds into the top of the one list rather than vanishing), then the asks, then the rest of Ready
// in the queue's order, then Working by recency — `orderActive`'s order with the asks lifted out.
//
// AN ASK IS A ROW MARKED "?" (`isAsk`), the one mark that spends the accent. Upstream lifted and counted
// `needsAction` rows, which misses a permission request waiting on the human (`actionableInteraction`):
// its row wore the "?" while it sorted among the handoffs and the header's "need you" left it out
// (seen 2026-09-30 on the standup demo's lockfile-bump). The mark is what the eye counts, so the order
// and the header count the mark.
// Across projects the Ready rows merge in ONE queue order (the desktop's `mergedQueue`): one server stamps
// every project's `queuedAt` on one clock, so the stamps compare.

export type PhoneTab = "queue" | "snoozed" | "done"

/** One row of a tab: a thread, with the project it belongs to (it may not be the page project's). */
export interface PhoneRow {
  project: QueuesProject
  thread: ThreadView
  /** `threadKey` — a slug is unique only within one project. */
  key: string
}

/** What the operator has just done to a project's threads that the poll cannot know yet (listBands.ts listOverlay). */
export type OverlayFor = (project: QueuesProject) => (t: ThreadView) => ThreadView

const noOverlay: OverlayFor = () => (t) => t

/** Rows for `threads`, each tagged with its owner, in `threads`' order. */
function rowsOf(threads: readonly ThreadView[], owner: ReadonlyMap<ThreadView, QueuesProject>): PhoneRow[] {
  return threads.map((thread) => {
    const project = owner.get(thread)!
    return { project, thread, key: threadKey(project.id, thread.id) }
  })
}

/** A row marked "?" — waiting on the human's answer (sessionIndicatorKind's `needs-input`). */
export function isAsk(t: ThreadView): boolean {
  return sessionIndicatorKind(t) === "needs-input"
}

/** Pin order, oldest pin first — the shelf the human arranged (groups.ts sectionThreads). */
function byPin(a: ThreadView, b: ThreadView): number {
  return (a.pinnedAt ?? "").localeCompare(b.pinnedAt ?? "") || a.id.localeCompare(b.id)
}

/**
 * THE QUEUE TAB: pinned, then the asks, then the rest of Ready, then Working. `hidden` is a card being
 * finished or sent away on the desktop's queue (AllQueues.tsx useLeavingCards) — the list drops its row with
 * it, and so does this.
 */
export function phoneQueue(
  projects: readonly QueuesProject[],
  hidden: (key: string) => boolean = () => false,
  overlayFor: OverlayFor = noOverlay,
  direction: QueueDirection = "fifo",
): PhoneRow[] {
  const owner = new Map<ThreadView, QueuesProject>()
  const pinned: ThreadView[] = []
  const ready: ThreadView[] = []
  const working: ThreadView[] = []
  for (const project of projects) {
    const bands = loudBands(project, hidden, overlayFor(project))
    for (const t of [...bands.pinned, ...bands.ready, ...bands.working]) owner.set(t, project)
    pinned.push(...bands.pinned)
    ready.push(...bands.ready)
    working.push(...bands.working)
  }
  const active = [...orderQueue(ready, direction), ...orderByInteraction(working)]
  return rowsOf([...pinned.sort(byPin), ...active.filter(isAsk), ...active.filter((t) => !isAsk(t))], owner)
}

/** THE SNOOZED TAB: every shown project's parked threads, most recently touched first. A pinned one is on the
 *  shelf at the top of the queue instead, as it is in the list. */
export function phoneSnoozed(projects: readonly QueuesProject[]): PhoneRow[] {
  const owner = new Map<ThreadView, QueuesProject>()
  for (const project of projects) for (const t of project.snoozed) if (!isPinned(t)) owner.set(t, project)
  return rowsOf(orderByInteraction([...owner.keys()]), owner)
}

/**
 * THE DONE TAB: every shown project's finished threads, most recent first — read from each project's own
 * board, since the poll carries only a COUNT of them (lib/projectBoards.ts). A project whose board has not
 * been read yet contributes nothing until it has. A pinned thread that is done is listed here too: the
 * queue's shelf comes from the poll, which carries open threads alone, so this is the one tab that can show
 * it.
 */
export function phoneDone(projects: readonly QueuesProject[], boardOf: (project: QueuesProject) => Pick<BoardSnapshot, "threads"> | null | undefined): PhoneRow[] {
  const owner = new Map<ThreadView, QueuesProject>()
  for (const project of projects) {
    const board = boardOf(project)
    if (!board) continue
    const sections = sectionThreads(board.threads)
    for (const t of [...sections.inactive, ...sections.pinned.filter((p) => p.state === "archived")]) owner.set(t, project)
  }
  return rowsOf(orderByInteraction([...owner.keys()]), owner)
}

/** The header's and the tabs' readings: how many rows are marked "?", and how many are spinning. */
export function phoneCounts(queue: readonly PhoneRow[]): { asks: number; working: number } {
  let asks = 0
  let working = 0
  for (const { thread } of queue) {
    if (isAsk(thread)) asks += 1
    // The maintainer's ACTIVE band, counted with the predicate the desktop rail's badge uses, so the phone
    // and the rail cannot disagree (upstream MobileBoard's own rule).
    if (activeBandThread(thread)) working += 1
  }
  return { asks, working }
}

/** One project as the phone's projects list draws it. */
export interface PhoneProjectEntry {
  project: QueuesProject
  /** Its Ready rows — the accent count, as the switcher and the list wear it. */
  ready: number
  /** Its Active band — the threads spinning. */
  working: number
}

/**
 * THE PROJECTS LIST'S ORDER — the desktop switcher's: projects with work in flight first, then the quiet
 * ones, each group in the machine-wide order, and Home last, on its own.
 */
export function phoneProjects(projects: readonly QueuesProject[], hidden: (key: string) => boolean = () => false): { projects: PhoneProjectEntry[]; home: PhoneProjectEntry | undefined } {
  const entry = (project: QueuesProject): PhoneProjectEntry => ({
    project,
    ready: project.queued.filter((t) => !hidden(threadKey(project.id, t.id))).length,
    working: project.running.filter(activeBandThread).length,
  })
  const listed = projects.filter((project) => !project.card?.home)
  const home = projects.find((project) => project.card?.home)
  return {
    projects: [...listed.filter(isBusy), ...listed.filter((project) => !isBusy(project))].map(entry),
    home: home && entry(home),
  }
}
