// THE PROJECT LIST — the page's left column under the prompt box: the VIEW's projects (lib/pageView.ts) —
// the one project the page is focused on, or every project on the machine — each with its work in flight
// listed under its name, and the rest of it one click away, in place.
//
// It is the project view's rail, folded into the one page (maintainer 2026-09-28: "does there need to be a
// project specific view at all or can we do enough with the main project view to just focus on what
// people are currently working on and make things expandable?", and then "ensure detailed drill down like
// `done` or other statuses for each project is still visible somehow just deemphasize it creatively all
// functionality must still be available without a project-specific view"). So every band that rail had is
// here, for each project, at two volumes:
//
//   LOUD  — Pinned, Ready and Working: the work in flight, listed under its project unless it is folded,
//           with no name over any of them. Colin's sidebar named all three ("sidebar labels for pinned,
//           queue, and running … should not be collapsible"); here each row says its band itself — a pin,
//           a rest time, a spinner — so the names were dropped (maintainer 2026-09-29).
//   QUIET — Snoozed, Done and External: a muted count per band under the work in flight, in the band's own
//           glyph (the rail's legend, BandLabel.tsx), never louder than the names. Each count is its own
//           toggle, collapsed to start (Colin's sidebar had the same three as separate collapsible
//           sections), and an open band lists under the counts with its own name, rows and verbs.
//
// ONE PRESENTATION, BOTH VIEWS. Focus mode is this list with one project in it; All projects is the same
// groups, one per project. So the density is what a busy project costs beyond its own rows, and it is
// measured, not guessed — see BAND_LABEL below and the header of ProjectGroup.
//
// And the row itself FOLDS its project: one click and everything under it goes, work in flight included,
// so the list shows only the projects being looked at (lib/crossProject.ts has the folds).
//
// EVERY ROW IS ITS PROJECT'S. The page project is only what the page is bound to — showing All projects,
// the prompt box's pick, which is usually another project — so each group sits in a ThreadProjectScope: pin, reopen, Retry and a sub-agent's × go through the row's
// own project's client, and a click opens its card or its drawer in place (RowScope). The row itself is
// the rail's (Sidebar.tsx RailRow) — the same anatomy, hover strip and marks the project view drew,
// measured once, not a second copy of them.
//
// AND THE PROJECTS DRAG. A project's row is its grip: press, travel a few pixels, and the whole group —
// row and threads — lifts and follows the pointer while the groups it passes slide aside; drop it and the
// machine-wide order is rewritten (`projectsReorder`), so every surface that reads it moves as one.
// A drag stays inside its run — the busy projects, or the quiet ones under them — because busy-ness, not
// the order, decides which run a project is in: a busy project dropped among the quiet ones would
// only jump back. Alt+Arrow on a focused row moves it one place, for anyone not using a mouse.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as KeyboardEvent_, type PointerEvent as PointerEvent_, type ReactNode } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { ChevronRight, Ellipsis, Plus } from "lucide-react"
import { useLocation, useNavigate } from "react-router"
import { useSnapshot } from "valtio"
import type { BoardSnapshot, ProjectCard, ThreadView } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { ThreadProjectScope } from "../api/threadApi.tsx"
import { externalThreads, isPinned, queued, sectionThreads } from "../groups.ts"
import { useBoard } from "../hooks.ts"
import { threadKey, type QueuesProject } from "../lib/allQueues.ts"
import { projectSlug } from "../lib/base-path.ts"
import { bandKey, rememberCrossProjectFocus, setBandOpen, setBandsOpen, setProjectCollapsed, useCollapsedProjects, useOpenBands, type QuietBandKey } from "../lib/crossProject.ts"
import { ALL_PROJECTS, projectViewHref, usePageView, viewHref } from "../lib/pageView.ts"
import { useArchivingAt } from "../lib/optimisticArchive.ts"
import { holdLayout, type HeldSection, type HeldSlot } from "../lib/heldLayout.ts"
import { actedOnHere } from "../lib/humanActs.ts"
import { useListHold } from "../lib/listHold.ts"
import { listOverlay, loudBands, type LoudBands } from "../lib/listBands.ts"
import { prefetchProjectBoard, projectBoardKey, useProjectBoard } from "../lib/projectBoards.ts"
import { edgeScrollVelocity, listDropIndex, listPitch, placeAmong, shiftFor, type ListBox } from "../lib/railReorder.ts"
import { useSteeredAt } from "../lib/steering.ts"
import { drawerThreadSlug, store } from "../store.ts"
import { useOpenThreadInPlace } from "./AllQueuesCard.tsx"
import { BAND_LABEL_TYPE, BANDS, BandCount, type BandKey } from "./BandLabel.tsx"
import { ProjectMenu, useAddProject } from "./ProjectActions.tsx"
import { QueueBadge } from "./ProjectSwitcher.tsx"
import { ProjectSquare } from "./ProjectSquare.tsx"
import { ROW_ACTION_CLASS, RailRow, type RowScope } from "./Sidebar.tsx"
import { glideTo } from "../lib/viewportLock.ts"

// The board sidebar's row geometry, verbatim (Sidebar.tsx ThreadRow), so a project's row and its threads'
// rows are one list: the hover wash, the 20px indicator gutter, the title's 13/19 type.
const ROW_CLASS =
  "group relative flex min-w-0 items-start rounded-md transition-[color,opacity] after:pointer-events-none after:absolute after:inset-0 after:rounded-md after:bg-hover after:opacity-0 after:transition-opacity hover:after:opacity-100"
const ROW_BUTTON_CLASS = "flex min-w-0 flex-1 items-start gap-2 pb-1 pl-5 pr-1.5 pt-1 text-left outline-none focus-visible:ring-1 focus-visible:ring-focus-ink-60 rounded-md"
const INDICATOR_SLOT = "flex h-[19px] w-4 shrink-0 items-center justify-center"
/** A project's own row: the thread row's 19px line, 2px of padding a side rather than 4 — see ProjectGroup. */
const HEAD_BUTTON_CLASS = "flex min-w-0 flex-1 items-start gap-2 py-0.5 pl-5 pr-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-focus-ink-60 rounded-md"
/** The space above every project's group but the first — see ProjectGroup. */
const GROUP_GAP = "mt-1.5"
/** A row whose "…" menu is open wears the rail's hover wash, held. */
const SELECTED_ROW = "after:!opacity-100"
/** Done rows listed per page: the band grows without bound, and a project opens on its most recent. */
const DONE_PAGE = 10
/** How long the page must be idle before the list reads every project's board ahead of a click. */
const PREFETCH_IDLE_MS = 1_500

/**
 * Every project on the machine — the page's navigator, and the only place a project is managed from.
 *
 * Projects with work in flight come first, in the machine-wide order, each followed by its threads; every other
 * project is one line under them. They are separated by space, not rules: the project's own square already
 * starts each group, and a rule would say it twice.
 */
export function ProjectList({
  projects,
  home,
  activeKey,
  hidden,
  onQueuedRow,
}: {
  projects: QueuesProject[]
  home: string | undefined
  activeKey: string | null
  hidden: (key: string) => boolean
  /** Bring a Ready card into view: its scroll offset, or null when the queue is not showing it. */
  onQueuedRow: (key: string) => number | null
}) {
  const collapsed = useCollapsedProjects()
  const openBands = useOpenBands()
  const view = usePageView()
  useReadAhead(projects)
  const steeredAt = useSteeredAt()
  const archivingAt = useArchivingAt()
  const focus = projectSlug(useLocation().pathname)
  const live = useBoard()
  const reorder = useListReorder(projects)
  const held = useListHold()
  const groups = reorder.ordered.map((project) => {
    const onPage = project.slug === focus && live?.projectSlug === project.slug
    // What THIS TAB just did to one of the project's threads: a row the human moved goes where it now
    // belongs even while the list is held (lib/heldLayout.ts) — the act's own record (lib/humanActs.ts),
    // the card being finished, and the optimistic steer and archive that move the row before the RPC does.
    const moved = (slug: string) =>
      actedOnHere(slug) ||
      hidden(threadKey(project.id, slug)) ||
      steeredAt[threadKey(project.id, slug)] !== undefined ||
      (onPage && (steeredAt[slug] !== undefined || archivingAt[slug] !== undefined))
    return { project, bands: loudBands(project, hidden, listOverlay(project.id, onPage, steeredAt, archivingAt)), moved }
  })
  // A folded project keeps its place: it is still busy, only quieter to look at. And while the list is
  // held, a project keeps the run and the place it was drawn in — one that has just gone quiet stays among
  // the busy ones, so the projects under it do not move up (lib/listHold.ts).
  const drawnRuns = useRef<HeldSection<(typeof groups)[number]>[]>([])
  const runs = holdLayout({
    prev: drawnRuns.current,
    target: [
      { id: "busy", items: groups.filter((group) => group.bands.rows > 0) },
      { id: "quiet", items: groups.filter((group) => group.bands.rows === 0) },
    ],
    keyOf: (entry) => entry.project.id,
    frozen: held,
    moved: () => false,
  })
  drawnRuns.current = runs
  const run = (id: string) => (runs.find((section) => section.id === id)?.slots ?? []).map((slot) => slot.item)
  const busy = run("busy")
  const quiet = run("quiet")
  const grip = reorder.grips([busy.map((entry) => entry.project), quiet.map((entry) => entry.project)])
  const group = (entry: (typeof groups)[number], spaced: boolean) => (
    <ProjectGroup
      key={entry.project.id}
      project={entry.project}
      grip={grip(entry.project.id)}
      loud={entry.bands}
      moved={entry.moved}
      // A FOCUSED project never folds, whatever the list remembers: its row there has no fold button
      // (ProjectRow), so a fold set from All projects hid every thread on the project's own page with
      // nothing to bring them back but the yellow count (maintainer 2026-09-30).
      collapsed={collapsed.has(entry.project.id) && !(view.kind === "project" && view.slug === entry.project.slug)}
      open={openBands}
      spaced={spaced}
      home={home}
      activeKey={activeKey}
      onQueuedRow={onQueuedRow}
    />
  )
  return (
    <>
      {busy.map((entry, index) => group(entry, index > 0))}
      {/* Always listed, one line each, under the busy ones — until one is opened, when it lists the rest of
          itself under its name like any other. They sat behind a collapsed "Quiet" fold until 2026-09-24,
          which cost a click to reach a project whose row is already about as quiet as a row can be
          (maintainer: "if I want to navigate to them I shouldn't have to expand"). */}
      {quiet.length > 0 && (
        <section aria-label="Quiet projects" className={busy.length > 0 ? GROUP_GAP : ""}>
          {quiet.map((entry) => group(entry, false))}
        </section>
      )}
    </>
  )
}


/** What a group needs to be dragged: its element, its displacement, and its row's handlers. */
interface Grip {
  ref: (element: HTMLElement | null) => void
  /** Px to translate the group by: the pointer's travel when held, a slide aside when passed over. */
  offset: number
  held: boolean
  /** Whether ANY group is held — the others animate only then, so a re-sort after a drop does not glide. */
  dragging: boolean
  onPointerDown: (event: PointerEvent_<HTMLButtonElement>) => void
  onKeyDown: (event: KeyboardEvent_<HTMLButtonElement>) => void
}

/** A drag in flight, within one run. `toIndex` is derived from `deltaY` every move (lib/railReorder.ts). */
interface ListDrag {
  run: readonly string[]
  fromIndex: number
  toIndex: number
  deltaY: number
  pitch: number
}

/** The row is a fold first, so a drag starts only past a press. */
const DRAG_THRESHOLD_PX = 4

/**
 * The click a drag ends with is swallowed, and nothing later — a module-scoped stamp rather than state,
 * so it survives the re-render the drop causes without adding one of its own.
 */
let lastDragEndedAt = 0
function justDragged(): boolean {
  return Date.now() - lastDragEndedAt < 250
}

/** A project that can hold a place in the order: a registered one. Home has no registry entry to hold one. */
function orderable(project: QueuesProject): boolean {
  return project.card !== undefined && !project.card.home
}

/**
 * The list's drag and keyboard reorder, writing the machine-wide order.
 *
 * TWO COPIES OF THE NEW ORDER, for two readers. The list holds its own (`pending`) from the drop until
 * the projects it is handed agree with it: it is set in the same React batch that lets go of the drag,
 * so the group lands where it was dropped with no frame back in its old slot. And the `projectsList`
 * cache is rewritten at once, so every reader moves with it before the server answers; the server's answer
 * replaces that, and a failure puts back what was there.
 */
function useListReorder(projects: readonly QueuesProject[]) {
  const queryClient = useQueryClient()
  const [drag, setDrag] = useState<ListDrag | null>(null)
  const [pending, setPending] = useState<string[] | null>(null)
  const elements = useRef(new Map<string, HTMLElement>())
  const refs = useRef(new Map<string, (element: HTMLElement | null) => void>())
  const reorder = useMutation({
    mutationFn: ({ ids }: { ids: string[]; before: ProjectCard[] | undefined }) => rpc.projectsReorder({ ids }),
    onSuccess: (cards) => queryClient.setQueryData(["projectsList"], cards),
    onSettled: () => setPending(null),
    onError: (_error, { before }) => {
      if (before) queryClient.setQueryData(["projectsList"], before)
      void queryClient.invalidateQueries({ queryKey: ["projectsList"] })
    },
  })
  const ordered = useMemo(() => (pending ? byOrder(projects, pending, (project) => project.id) : projects), [projects, pending])
  const order = ordered.filter(orderable).map((project) => project.id)
  const handed = projects.filter(orderable).map((project) => project.id).join()
  // Let go of the list's copy once the projects it is handed say the same thing — which is at once, since
  // the cache was rewritten with it. `onSettled` lets go regardless, for a list that moved on meanwhile.
  useEffect(() => {
    if (pending && handed === pending.join()) setPending(null)
  }, [handed, pending])

  const commit = (run: readonly string[], fromIndex: number, toIndex: number) => {
    const next = placeAmong(order, run, fromIndex, toIndex)
    if (next.join() === order.join()) return
    setPending(next)
    void queryClient.cancelQueries({ queryKey: ["projectsList"] })
    const before = queryClient.getQueryData<ProjectCard[]>(["projectsList"])
    if (before) queryClient.setQueryData(["projectsList"], byOrder(before, next, (card) => card.id))
    reorder.mutate({ ids: next, before })
  }

  const ref = (id: string) => {
    let bound = refs.current.get(id)
    if (!bound) {
      bound = (element) => {
        if (element) elements.current.set(id, element)
        else elements.current.delete(id)
      }
      refs.current.set(id, bound)
    }
    return bound
  }

  /** The grip for each project, given the runs the list drew — busy, then quiet — in its order. */
  const grips = (groups: readonly (readonly QueuesProject[])[]) => {
    const runs = groups.map((group) => group.filter(orderable).map((project) => project.id))
    const runOf = (id: string) => runs.find((run) => run.includes(id))

    const onPointerDown = (id: string) => (event: PointerEvent_<HTMLButtonElement>) => {
      // Left button only, never modified: those clicks are someone else's.
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const run = runOf(id)
      if (!run || run.length < 2) return
      const fromIndex = run.indexOf(id)
      const button = event.currentTarget
      // The list's own scroll box when it has one; stacked under the queue, the page scrolls instead.
      const scroller = button.closest<HTMLElement>("[data-xq-rail]")
      const scrollTop = () => scroller?.scrollTop ?? window.scrollY
      const startY = event.clientY
      const startScroll = scrollTop()
      let boxes: ListBox[] = []
      let started = false
      let latest: ListDrag | null = null
      let frame = 0

      const apply = (clientY: number) => {
        // Auto-scroll near the scroll box's edges, folding the scroll into the delta — a list longer than
        // its column is otherwise reorderable only within one screen of itself.
        if (scroller) {
          const velocity = edgeScrollVelocity(clientY, scroller.getBoundingClientRect())
          if (velocity) scroller.scrollTop += velocity
        }
        const deltaY = clientY - startY + scrollTop() - startScroll
        latest = { run, fromIndex, toIndex: listDropIndex(boxes, fromIndex, deltaY), deltaY, pitch: listPitch(boxes, fromIndex) }
        setDrag(latest)
      }

      const onMove = (moveEvent: PointerEvent) => {
        if (!started) {
          if (Math.abs(moveEvent.clientY - startY) < DRAG_THRESHOLD_PX) return
          started = true
          button.setPointerCapture(moveEvent.pointerId)
          // Measured ONCE, as laid out before anything moved: the transforms that follow would skew any
          // later reading, and this snapshot is what every hit-test is against.
          boxes = run.map((runId) => {
            const box = elements.current.get(runId)?.getBoundingClientRect()
            return { top: box?.top ?? 0, height: box?.height ?? 0 }
          })
        }
        moveEvent.preventDefault()
        const clientY = moveEvent.clientY
        // One update per frame, and the loop keeps running while the pointer is HELD STILL in the edge
        // zone, which a move-driven update alone never would.
        cancelAnimationFrame(frame)
        const tick = () => {
          apply(clientY)
          if (scroller && edgeScrollVelocity(clientY, scroller.getBoundingClientRect())) frame = requestAnimationFrame(tick)
        }
        frame = requestAnimationFrame(tick)
      }

      const onUp = () => {
        cancelAnimationFrame(frame)
        window.removeEventListener("pointermove", onMove)
        window.removeEventListener("pointerup", onUp)
        window.removeEventListener("pointercancel", onUp)
        setDrag(null)
        if (!started || !latest) return
        lastDragEndedAt = Date.now()
        commit(run, latest.fromIndex, latest.toIndex)
      }

      window.addEventListener("pointermove", onMove, { passive: false })
      window.addEventListener("pointerup", onUp)
      window.addEventListener("pointercancel", onUp)
    }

    // Alt+Arrow, not bare arrows: a bare arrow on a focused button is how the page scrolls. The row's
    // button is the same element after the move (keyed by project), so focus rides along with it.
    const onKeyDown = (id: string) => (event: KeyboardEvent_<HTMLButtonElement>) => {
      if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return
      const run = runOf(id)
      if (!run) return
      const fromIndex = run.indexOf(id)
      const toIndex = fromIndex + (event.key === "ArrowUp" ? -1 : 1)
      // Claimed even at either end, where it moves nothing: unclaimed, the page would hear ⌥↑/⌥↓ as a
      // step to another project (AllQueues.tsx) on a row that is being reordered.
      event.preventDefault()
      if (toIndex < 0 || toIndex >= run.length) return
      commit(run, fromIndex, toIndex)
    }

    return (id: string): Grip | undefined => {
      if (!runOf(id)) return undefined
      const index = drag ? drag.run.indexOf(id) : -1
      const held = drag !== null && index === drag.fromIndex
      // The held group follows the pointer; the ones it has passed slide one pitch towards its old slot.
      const offset = !drag || index < 0 ? 0 : held ? drag.deltaY : shiftFor(index, drag.fromIndex, drag.toIndex, drag.pitch)
      return { ref: ref(id), offset, held, dragging: drag !== null, onPointerDown: onPointerDown(id), onKeyDown: onKeyDown(id) }
    }
  }

  return { ordered, grips }
}

/** `list` in `ids`' order; anything `ids` does not name keeps its relative place, after them. */
function byOrder<T>(list: readonly T[], ids: readonly string[], idOf: (item: T) => string): T[] {
  const rank = new Map(ids.map((id, index) => [id, index]))
  const at = (item: T) => rank.get(idOf(item)) ?? ids.length
  return [...list].sort((a, b) => at(a) - at(b))
}

/**
 * READ EVERY PROJECT'S BOARD AHEAD, once the page is idle, so opening one never waits on a round trip
 * (lib/projectBoards.ts). And when a project's Done count moves in the poll — a thread finished or reopened
 * anywhere — its cached board is stale, so it is dropped; an open project's live query refetches at once.
 */
function useReadAhead(projects: QueuesProject[]) {
  const queryClient = useQueryClient()
  const ids = projects.filter((project) => project.open && !project.stale).map((project) => project.id)
  const signature = ids.join(",")
  useEffect(() => {
    if (!signature) return
    const timer = window.setTimeout(() => {
      for (const id of signature.split(",")) prefetchProjectBoard(queryClient, id)
    }, PREFETCH_IDLE_MS)
    return () => window.clearTimeout(timer)
  }, [signature, queryClient])
  const counts = useRef(new Map<string, number>())
  useEffect(() => {
    for (const project of projects) {
      const before = counts.current.get(project.id)
      counts.current.set(project.id, project.doneCount)
      if (before !== undefined && before !== project.doneCount) {
        void queryClient.invalidateQueries({ queryKey: projectBoardKey(project.id) })
      }
    }
  }, [projects, queryClient])
}

/**
 * One project: its row, its work in flight in its named bands, the counts of the rest, and whichever of
 * the rest is open; folded away, only its row.
 *
 * ITS COST BEYOND ITS OWN ROWS is what Colin's sidebar was tuned for and what this group is held to — the
 * whole group has to read as its threads, with a name over them, and not as a frame the threads sit in.
 * Measured on a seeded stack (sans, a busy project with pinned, ready and working rows and all three quiet
 * bands; scripts/seed-focus-mode.mjs):
 *
 *   the project's row          23px  (27 until 2026-09-29: 2px of padding a side, not 4 — the 16px square
 *                                     still has 3.5px around it, and nothing wraps in it)
 *   a band's name, per band    15px  (BAND_LABEL — Colin's was a 23.7px header under a 25px rule)
 *   the space before the next   6px  (12)
 *
 * so a busy project costs 23 + 6 = 29px beyond its rows now that no loud band is named (59 while both were, 80 while the quiet counts sat on a 21px line of their own under the
 * threads, 2026-09-29 only), against 66px before its bands had names — and the same project in Colin's sidebar, one project per page, cost
 * 267px for its six headers and five rules.
 *
 * Its FOCUS project (the page project, whose board is live in the store) reads the rest from that board;
 * every other reads its board through the cache, which the list read ahead.
 */
function ProjectGroup({
  project,
  grip,
  loud,
  collapsed,
  open,
  spaced,
  home,
  activeKey,
  onQueuedRow,
  moved,
}: {
  project: QueuesProject
  grip: Grip | undefined
  loud: LoudBands
  /** Whether this tab just moved the thread — its row is not held (lib/heldLayout.ts). */
  moved: (slug: string) => boolean
  collapsed: boolean
  /** Every project's open quiet bands, as crossProject.ts `bandKey`s. */
  open: ReadonlySet<string>
  spaced: boolean
  home: string | undefined
  activeKey: string | null
  onQueuedRow: (key: string) => number | null
}) {
  const focus = projectSlug(useLocation().pathname)
  const live = useBoard()
  const onPage = project.slug === focus && live?.projectSlug === project.slug
  const opened = collapsed ? [] : QUIET_BANDS.filter((band) => open.has(bandKey(project.id, band)))
  const cached = useProjectBoard(project.id, opened.length > 0 && !onPage && project.open)
  const board = onPage ? live : cached
  const quiet = useMemo(() => quietBands(project, board), [project, board])
  const snap = useSnapshot(store)
  // Only the page project's drawers can be open on this page, so only its rows can be the one up in one.
  const openSlug = onPage ? drawerThreadSlug(snap.drawers) : null
  const scope = useRowScope(project, onPage, onQueuedRow)
  const queryClient = useQueryClient()
  const carded = loud.carded
  // THE BANDS AS DRAWN — live, or held as they were while the pointer is over the list (lib/listHold.ts,
  // lib/heldLayout.ts). Listed fresher-first, so a thread a cached board still lists elsewhere is drawn
  // once, where the poll puts it.
  const held = useListHold()
  const target = [
    { id: "pinned", items: [...loud.pinned, ...quiet.pinnedDone] },
    { id: "ready", items: loud.ready },
    { id: "working", items: loud.working },
    { id: "snoozed", items: quiet.snoozed },
    { id: "done", items: quiet.done ?? [] },
    { id: "external", items: quiet.external },
  ] satisfies { id: ListBand; items: ThreadView[] }[]
  const drawnBands = useRef<HeldSection<ThreadView>[]>([])
  const bands = holdLayout({
    prev: drawnBands.current,
    target,
    keyOf: (t) => t.id,
    frozen: held,
    moved,
    live: (slug) => [...project.queued, ...project.running, ...project.snoozed, ...(board?.threads ?? [])].find((t) => t.id === slug),
  })
  drawnBands.current = bands
  // The band each thread is in NOW: a held row is drawn in its old place but as what it is — a rest time if
  // it is Ready, a spinner if it is working — since only the layout is held, never what a row says.
  const bandNow = new Map(target.flatMap((band) => band.items.map((t) => [t.id, band.id] as const)))
  const slots = (band: ListBand) => bands.find((section) => section.id === band)?.slots ?? []
  const row = (slot: HeldSlot<ThreadView>) => {
    const t = slot.item
    const band = bandNow.get(t.id)
    return (
      <RailRow
        key={t.id}
        t={t}
        active={activeKey === threadKey(project.id, t.id)}
        open={openSlug === t.id}
        restedAge={band === "ready"}
        scope={scope}
        cardKey={carded.has(t.id) ? threadKey(project.id, t.id) : undefined}
        band={band === "pinned" || band === "ready" || band === "working" ? band : undefined}
        held={slot.held}
      />
    )
  }
  return (
    <section
      ref={grip?.ref}
      aria-label={project.name}
      data-xq-rail-project={project.id}
      data-xq-project-collapsed={collapsed || undefined}
      data-xq-project-drilled={opened.length > 0 || undefined}
      data-xq-project-held={grip?.held || undefined}
      // Lifted while held: the page's own colour under it, so the rows it slides over do not show through,
      // and a shadow that says it is off the list. `relative` so the lift stacks above its neighbours.
      className={`${spaced ? GROUP_GAP : ""} ${grip?.held ? "relative z-10 cursor-grabbing rounded-md bg-bg shadow-lg shadow-shadow-ink/50" : ""}`}
      style={{
        transform: grip?.offset ? `translateY(${grip.offset}px)` : undefined,
        // The held group tracks the pointer exactly; the ones it passes are what animate.
        transition: grip?.dragging && !grip.held ? "transform 160ms ease" : undefined,
      }}
      // The rows are in the cache before the click lands (lib/projectBoards.ts).
      onPointerEnter={() => {
        if (!onPage && project.open && !project.stale) prefetchProjectBoard(queryClient, project.id)
      }}
    >
      <ProjectRow
        project={project}
        grip={grip}
        busy={loud.rows > 0}
        working={loud.working.length}
        count={loud.ready.length}
        quiet={quiet}
        opened={opened}
        collapsed={collapsed}
        home={home}
      />
      {!collapsed && (
        <ThreadProjectScope projectId={project.id} projectDir={project.projectDir}>
          {/* The loud bands, UNNAMED: a pinned row wears its pin, a Ready row its rest time and a Working
              row its spinner, so a name over any of them said what the rows already did (maintainer
              2026-09-29: "let the icons show what is working", then Ready, then "just a pin icon next to
              the threads that are pinned"). */}
          {slots("pinned").map(row)}
          {slots("ready").map(row)}
          {slots("working").map(row)}
          {opened.length > 0 && <QuietBands project={project} quiet={quiet} slots={slots} opened={opened} row={row} />}
        </ThreadProjectScope>
      )}
    </section>
  )
}

/** The quiet bands, in the order the list gives them. */
const QUIET_BANDS: readonly QuietBandKey[] = ["snoozed", "done", "external"]

/** Every band a project's rows are drawn in, loud then quiet — the sections lib/heldLayout.ts holds. */
type ListBand = "pinned" | "ready" | "working" | QuietBandKey

/**
 * AN OPEN QUIET BAND'S NAME, over its rows — the rail's legend (BandLabel.tsx BANDS), in the rail header's
 * own face, and the band's collapse (`onToggle`). Its glyph stands in the INDICATOR column, where each
 * row's state glyph stands, so the project's cord strings it like a row (ThreadConnector) and the name
 * starts on the titles' column. The loud bands carry no name (ProjectGroup).
 */
function BandName({ band, count, onToggle }: { band: QuietBandKey; count: number; onToggle: () => void }) {
  const { Icon, label } = BANDS[band]
  const body = (
    <>
      {/* The band table's glyph at the size its names wear it everywhere (BandLabel.tsx BandGlyph). Its
          ink centre sits 0.3px under the name's cap band here (sans) — under the device grid, so it is
          left alone. */}
      <span data-xq-indicator className={BAND_GLYPH_SLOT}>
        <Icon size={11} />
      </span>
      <span>{label}</span>
      <BandCount count={count} />
    </>
  )
  const className = `${BAND_LABEL} ${BAND_LABEL_TYPE}`
  return (
    <button
      type="button"
      data-xq-band-label={band}
      data-xq-reshape
      aria-expanded
      title={`Hide ${label.toLowerCase()}`}
      onClick={onToggle}
      className={`${className} w-full rounded-md text-left outline-none transition-colors hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60`}
    >
      {body}
    </button>
  )
}

/**
 * The band name's line. 15px, MEASURED against the rows either side (sans): the name's 11px capitals are
 * 8px of ink, and a row's 13px title leaves ~7px of its own line box and padding clear above and below its
 * ink, so at 15px the name stands ~10.5px off the row above and ~9.5px off the row below — a gap each way
 * that reads as a break in the list, where 12px left the name touching the titles and 19px (a row's line)
 * read as an empty row. `pl-5` and `gap-2` put the glyph in the indicator column and the name on the
 * titles' column.
 */
const BAND_LABEL = "flex h-[15px] min-w-0 items-center gap-2 pl-5 pr-1.5 pt-1"
/** The glyph's slot: the indicator column's 16px, so the glyph stands where each row's state glyph does. */
const BAND_GLYPH_SLOT = "flex h-full w-4 shrink-0 items-center justify-center"

interface QuietBands {
  /** Pinned threads that are Done: still on the shelf (the pin outranks Done), so listed loud — but only
   *  the board knows them, since the poll carries open threads alone. */
  pinnedDone: ThreadView[]
  snoozed: ThreadView[]
  /** Undefined until the project's board has been read — the COUNT is the poll's, and known at once. */
  done: ThreadView[] | undefined
  doneCount: number
  external: ThreadView[]
}

/**
 * What the project row keeps quiet: its Snoozed rows (from the poll, so always current), its Done rows and
 * its External sessions (from its board). Pinned rows are listed loud whatever their state, so none of
 * them is counted twice.
 */
function quietBands(project: QueuesProject, board: BoardSnapshot | null | undefined): QuietBands {
  const snoozed = project.snoozed.filter((t) => !isPinned(t))
  if (!board) return { pinnedDone: [], snoozed, done: undefined, doneCount: project.doneCount, external: [] }
  const sections = sectionThreads(board.threads)
  const done = sections.inactive
  const pinnedDone = sections.pinned.filter((t) => t.state === "archived")
  return { pinnedDone, snoozed, done, doneCount: done.length, external: externalThreads(board.threads) }
}

/** How many rows a quiet band holds. */
function quietCount(quiet: QuietBands, band: QuietBandKey): number {
  return band === "snoozed" ? quiet.snoozed.length : band === "done" ? quiet.doneCount : quiet.external.length
}

/**
 * Where a row of this project leads — ONE object per project, so the rail's memoized rows are not handed
 * a new scope on every poll. A Ready row brings its card into view when the queue is showing it, and every
 * other click opens the thread's drawer in place, which moves the page to its project for as long as the
 * drawer is open (useOpenThreadInPlace).
 */
function useRowScope(project: QueuesProject, page: boolean, onQueuedRow: (key: string) => number | null): RowScope {
  const openInPlace = useOpenThreadInPlace()
  const slug = project.slug
  const id = project.id
  const open = useCallback(
    (t: ThreadView) => {
      if (queued(t) && onQueuedRow(threadKey(id, t.id)) !== null) return
      openInPlace({ slug }, t.id)
    },
    [id, slug, onQueuedRow, openInPlace],
  )
  return useMemo(() => ({ open, page }), [open, page])
}

/**
 * A project's own row — the same for a busy project heading its threads and a quiet one alone.
 *
 * ITS CLICK FOLDS THE PROJECT (maintainer 2026-09-28: "we need a primary collapse button that would easily
 * allow you to visually filter which projects you're looking at"). A busy project folds away EVERYTHING
 * under its row — its work in flight and, if any is open, the rest — and a second click brings it all
 * back; a quiet project has nothing under it but the rest, so its click opens every quiet band it has,
 * and folds them away again. Nothing navigates. The whole row is the fold's target; only its own controls
 * sit above it.
 *
 * Its right edge carries, in order: the quiet bands' counts — each ITS OWN toggle, always here, folded or
 * not, so opening one never moves the rest (maintainer 2026-09-29, reversing a morning's move of them under
 * the threads: "don't move the done/snooze/external buttons when expanding just always leave them at the
 * top") — then its Ready count: the accent
 * badge, the one number in the list that wants you, which stays when the project is folded so a folded
 * project still says it is waiting. Or, in their place, a note, only when something is wrong: its directory
 * is gone, or this server has not opened it. On hover the badge gives way to the "…" (ProjectActions.tsx
 * ProjectMenu): the page's view, its repo, its icon, rename and delete. The badge's slot is held even when
 * empty, so the counts never slide under the menu.
 */
function ProjectRow({
  project,
  grip,
  busy,
  count,
  quiet,
  opened,
  collapsed,
  working,
  home,
}: {
  project: QueuesProject
  grip: Grip | undefined
  busy: boolean
  count: number
  quiet: QuietBands
  opened: readonly QuietBandKey[]
  collapsed: boolean
  /** Its Working rows — counted on the row while it is folded, the one state that hides them. */
  working: number
  home: string | undefined
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const navigate = useNavigate()
  const view = usePageView()
  const focused = view.kind === "project" && view.slug === project.slug
  const note = project.stale ? "Directory is missing" : !project.open ? "Not open" : null
  const quietBandsHere = QUIET_BANDS.filter((band) => quietCount(quiet, band) > 0)
  // Whether anything is listed under the row: the fold's own state, on either kind of project.
  const unfolded = busy ? !collapsed : opened.length > 0
  const fold = () => {
    if (busy) return setProjectCollapsed(project.id)
    // A quiet project folds only the rest. A fold left over from when it was busy is lifted, so the click
    // always shows what it says it will.
    setProjectCollapsed(project.id, false)
    setBandsOpen(project.id, quietBandsHere, opened.length === 0)
  }
  const foldTitle = busy
    ? `${collapsed ? "Show" : "Collapse"} ${project.name}'s threads`
    : `${opened.length > 0 ? "Hide" : "Show"} everything in ${project.name}`
  return (
    <div
      data-xq-project-row={project.id}
      className={`${ROW_CLASS} ${project.stale ? "opacity-60" : ""} ${menuOpen ? SELECTED_ROW : ""}`}
    >
      {/* FOCUSED, THE PAGE'S TITLE NAMES THE PROJECT (StatusRow.tsx, the switcher), so its row here keeps
          only its counts and "…": the name drawn twice, 180px apart, was the page's one duplicate
          (maintainer 2026-09-29). Nor does it fold — putting away every thread of the only project on the
          page leaves nothing to look at. With no square the cord starts at the first band name instead
          (ThreadConnector ties only rows that carry an indicator). */}
      {focused ? (
        <span className="flex-1" />
      ) : (
        <button
          type="button"
          data-xq-project-fold
          // Folding a project, or dragging it by this row, reshapes the list by the human's own hand
          // (lib/listHold.ts): the list follows it rather than holding what they asked for.
          data-xq-reshape
          onClick={() => {
            // A drag ENDS over the row it lifted, so the browser fires a click on release; that one is not
            // a fold.
            if (justDragged()) return
            fold()
          }}
          onPointerDown={grip?.onPointerDown}
          onKeyDown={grip?.onKeyDown}
          aria-expanded={unfolded}
          aria-label={foldTitle}
          title={foldTitle}
          // The whole row is the target (the `before:` layer), not just the name: the badge and the space
          // around it fold too. The counts and the "…" sit above it. `pr-2` is the gap to the counts.
          className={`${HEAD_BUTTON_CLASS} !pr-2 items-center before:absolute before:inset-0 before:rounded-md before:content-['']`}
        >
          {/* THE DISCLOSURE, in the gutter the rail's scroll marker uses — where the rail's own collapsible
              band headers kept theirs, so the list folds the way the rail did. Only while it means
              something: on hover (and always on touch), and HELD whenever the project is not as it starts —
              a busy project folded away (pointing right), a quiet one showing the rest (turned down). A busy
              project open, the usual case, draws none, so the list is not a column of chevrons. */}
          <span
            aria-hidden
            data-xq-project-chevron
            className={`pointer-events-none absolute left-[4.5px] top-0.5 flex h-[19px] items-center text-muted-60 transition-[opacity,transform] ${unfolded ? "rotate-90" : ""} ${
              (busy ? collapsed : opened.length > 0) ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 [@media(hover:none)]:opacity-100"
            }`}
          >
            <ChevronRight size={11} />
          </span>
          {/* The top of the project's cord, which hangs from this square behind every band name's glyph and
              thread row's indicator under it (ThreadConnector). */}
          <span data-xq-indicator className={`${INDICATOR_SLOT} ${project.stale ? "grayscale" : ""}`}>
            <ProjectSquare project={project.card ?? squareCard(project)} size={16} />
          </span>
          <span className={`flex min-w-0 flex-1 items-baseline text-[13px] leading-[19px] font-semibold ${busy ? "text-fg" : "text-fg/70"}`}>
            <span className="min-w-0 truncate">{project.name}</span>
          </span>
        </button>
      )}
      {/* The right edge, beside the fold rather than inside it: the counts are buttons of their own. On a
          touch screen the "…" never hides, so they step left of it rather than under it. */}
      <div className="flex shrink-0 items-center gap-2 self-stretch pr-1.5 [@media(hover:none)]:pr-7">
        {note ? (
          <span className="text-[10.5px] leading-[19px] text-muted-55">{note}</span>
        ) : (
          <>
            <QuietToggles project={project} quiet={quiet} opened={opened} working={collapsed ? working : 0} />
            {/* The Ready count, in the "…"'s own slot — it gives way to the menu on hover. */}
            {project.card && (
              <span
                className={`flex w-[19px] shrink-0 justify-end transition-opacity group-hover:opacity-0 group-has-[:focus-visible]:opacity-0 ${menuOpen ? "opacity-0" : ""} [@media(hover:none)]:opacity-100`}
              >
                {count > 0 && <QueueBadge count={count} />}
              </span>
            )}
          </>
        )}
      </div>
      {project.card && (
        <div className={`absolute right-1.5 top-0.5 items-center group-hover:flex group-has-[:focus-visible]:flex [@media(hover:none)]:flex ${menuOpen ? "flex" : "hidden"}`}>
          <ProjectMenu
            project={project.card}
            home={home}
            githubRepo={project.githubRepo}
            focused={focused}
            onFocus={() => {
              // Leaving a project for All projects carries it over as the prompt box's pick, as the
              // switcher does (AllQueues.tsx Switcher).
              if (focused) rememberCrossProjectFocus(project.id)
              navigate(focused ? viewHref(ALL_PROJECTS) : projectViewHref(project.slug))
              glideTo(() => 0)
            }}
            onOpenChange={setMenuOpen}
          >
            <button type="button" aria-label={`More actions for ${project.name}`} className={`${ROW_ACTION_CLASS} data-[state=open]:bg-panel-2 data-[state=open]:text-fg data-[state=open]:opacity-100`}>
              <Ellipsis size={13} />
            </button>
          </ProjectMenu>
        </div>
      )}
    </div>
  )
}

/**
 * The rest of a project, before it is shown: one muted count per quiet band, in that band's glyph — the
 * rail's legend (BandLabel.tsx), so "zz 2 · ☑ 43" reads as the Snoozed and Done names they open onto.
 * Quieter than the name and never the accent, which in this product means only "this many want you".
 * A folded project counts its Working rows the same way, first (maintainer 2026-09-29: "when collapsed
 * ... it should also show the number of running/ready threads"); its Ready rows are the accent badge
 * beside these, which already stays through a fold, so they are not counted twice.
 *
 * EACH COUNT IS ITS OWN TOGGLE — Snoozed, Done and External open and close one at a time, all collapsed to
 * start. An open one is a step brighter, and its band lists under the project's threads, named. On a folded
 * project a click unfolds it too, so it always shows what it says; the Working count only unfolds. Each
 * wash hangs 4px past its count's ink (`-mx-1 px-1`), so the ink stays exactly where it sat before the
 * counts were buttons; `relative`, to sit above the fold's whole-row target.
 */
function QuietToggles({ project, quiet, opened, working = 0 }: { project: QueuesProject; quiet: QuietBands; opened: readonly QuietBandKey[]; working?: number }) {
  const entries: { band: BandKey; count: number; noun: string }[] = [
    { band: "working", count: working, noun: "working" },
    ...QUIET_BANDS.map((band) => ({ band, count: quietCount(quiet, band), noun: band })),
  ]
  const shown = entries.filter((entry) => entry.count > 0)
  if (shown.length === 0) return null
  return (
    <span data-xq-quiet-toggles className="flex shrink-0 items-center gap-2">
      {shown.map(({ band, count, noun }) => {
        const { Icon } = BANDS[band]
        const isOpen = band !== "working" && opened.includes(band as QuietBandKey)
        const label = band === "working" ? `Show ${count} working` : `${isOpen ? "Hide" : "Show"} ${count} ${noun}`
        return (
          <button
            key={band}
            type="button"
            data-xq-quiet-count={band}
            data-xq-reshape
            aria-expanded={band === "working" ? undefined : isOpen}
            aria-label={label}
            title={label}
            onClick={() => {
              setProjectCollapsed(project.id, false)
              // To the state the click SAW, not a toggle of whatever the store holds by now: two clicks
              // landing before a render (the row's fold and a count, from a script) must agree.
              if (band !== "working") setBandOpen(project.id, band as QuietBandKey, !isOpen)
            }}
            // The glyph sits on its DIGIT's cap band, not beside its box: box-centred, all three glyphs read
            // 1.5px low (sans, 10.5px). The pair shares one font size, set on the pair, so `cap` resolves
            // against the digit's font; `self-baseline` lands the 10px glyph's bottom on the digit's
            // baseline and the translate lifts its centre to the band's. Every band glyph's ink spans y 3–21
            // of its 24-unit box (SquareCheck, ExternalLink, BandLabel's SnoozeMark, Bot), so the box centre
            // is the ink centre for each.
            className={`relative -mx-1 flex h-[19px] shrink-0 items-baseline gap-[3px] rounded px-1 text-[10.5px] leading-[19px] outline-none transition-colors hover:bg-hover-strong hover:text-fg/80 focus-visible:ring-1 focus-visible:ring-focus-ink-60 ${isOpen ? "text-muted-80" : "text-muted-50"}`}
          >
            <span aria-hidden className="flex self-baseline translate-y-[calc(5px_-_0.5cap)]">
              <Icon size={10} />
            </span>
            <span aria-hidden className="tabular-nums">{count}</span>
          </button>
        )
      })}
    </span>
  )
}

/**
 * The quiet bands that are open, in the rail's own order — Snoozed, then Done (its most recent first, a
 * page at a time), then External, the project's own terminals, which a message takes over — each under its
 * name, which closes it. Off the cord: the cord is the work in flight (ThreadConnector reads only the
 * group's own children, and these sit in a container of their own).
 */
function QuietBands({
  project,
  quiet,
  slots,
  opened,
  row,
}: {
  project: QueuesProject
  quiet: QuietBands
  /** The rows each band DRAWS — held while the pointer is over the list, so a band whose last row left on
   *  its own keeps its name and that row until the hold ends. */
  slots: (band: ListBand) => HeldSlot<ThreadView>[]
  opened: readonly QuietBandKey[]
  row: (slot: HeldSlot<ThreadView>) => ReactNode
}) {
  const [donePage, setDonePage] = useState(DONE_PAGE)
  const shown = opened.filter((band) => slots(band).length > 0 || (band === "done" && quiet.done === undefined && quiet.doneCount > 0))
  const close = (band: QuietBandKey) => () => setBandOpen(project.id, band, false)
  return (
    <div data-xq-drill={project.id} className="flex min-w-0 flex-col">
      {shown.includes("snoozed") && (
        <div data-xq-drill-band="snoozed">
          <BandName band="snoozed" count={quiet.snoozed.length} onToggle={close("snoozed")} />
          {slots("snoozed").map(row)}
        </div>
      )}
      {shown.includes("done") && (
        <div data-xq-drill-band="done">
          <BandName band="done" count={quiet.doneCount} onToggle={close("done")} />
          {slots("done").length > 0 ? (
            <>
              {slots("done").slice(0, donePage).map(row)}
              {slots("done").length > donePage && (
                <button
                  type="button"
                  data-xq-reshape
                  onClick={() => setDonePage((page) => page + DONE_PAGE * 2)}
                  className="rounded-md py-1 pl-[44px] pr-1.5 text-left text-[11.5px] leading-[19px] text-muted-60 outline-none transition-colors hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60"
                >
                  Show {Math.min(DONE_PAGE * 2, slots("done").length - donePage)} more
                </button>
              )}
            </>
          ) : (
            <div aria-busy className="py-1 pl-[44px] text-[11.5px] leading-[19px] text-muted-50">Loading…</div>
          )}
        </div>
      )}
      {shown.includes("external") && (
        <div data-xq-drill-band="external">
          <BandName band="external" count={quiet.external.length} onToggle={close("external")} />
          {slots("external").map(row)}
        </div>
      )}
    </div>
  )
}

/**
 * The last row of the list: a project the machine does not have yet. A dotted squircle, "nothing here yet" — at the row's scale, so it reads as an empty place in the same list rather
 * than a button bolted under it. Muted, and never accent: accent means only "this many want you".
 */
export function AddProjectRow() {
  const add = useAddProject()
  return (
    <div className={`${ROW_CLASS} ${GROUP_GAP}`}>
      <button type="button" data-xq-reshape onClick={add.start} disabled={add.pending} className={`${ROW_BUTTON_CLASS} group/add items-center disabled:opacity-60`}>
        <span className={INDICATOR_SLOT}>
          <span className="flex h-4 w-4 items-center justify-center rounded-[30%] border border-dotted border-border-strong text-muted-70 transition-colors group-hover/add:border-fg/40 group-hover/add:text-fg">
            <Plus size={10} strokeWidth={2.25} />
          </span>
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] leading-[19px] text-muted-70 transition-colors group-hover/add:text-fg">
          {add.pending ? "Choosing a folder…" : "Add a project"}
        </span>
      </button>
    </div>
  )
}

/** A card-shaped stand-in for a project the registry list has not caught up with, for its square. */
function squareCard(project: QueuesProject) {
  return { id: project.id, slug: project.slug, name: project.name, path: project.projectDir ?? "", lastOpenedAt: "", stale: false, iconStatus: "unknown" as const }
}
