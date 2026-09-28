// THE PROJECT LIST — Everything's left column under the prompt box: every project on the machine, its
// work in flight listed under its name, and the rest of it one click away, in place.
//
// It is the project view's rail, folded into the one page (maintainer 2026-09-28: "does there need to be a
// project specific view at all or can we do enough with the main project view to just focus on what
// people are currently working on and make things expandable?", and then "ensure detailed drill down like
// `done` or other statuses for each project is still visible somehow just deemphasize it creatively all
// functionality must still be available without a project-specific view"). So every band that rail had is
// here, for every project at once, at two volumes:
//
//   LOUD  — Pinned, Ready and Working: the work in flight, listed under its project unless it is folded.
//   QUIET — Snoozed, Done and External: a muted count per band at the end of the project's own row, in the
//           band's own glyph (the rail's legend, BandLabel.tsx), readable at a glance and never louder than
//           the name. The counts are their own toggle, and those bands list under the project with the
//           rail's own headers, rows and verbs.
//
// And the row itself FOLDS its project: one click and everything under it goes, work in flight included,
// so the list shows only the projects being looked at (lib/crossProject.ts has the two folds).
//
// THE LIST IS NEVER FILTERED. The queue filter (lib/crossProject.ts) picks which cards the right side shows
// and nothing else; folding or opening a project here changes this list and nothing else. Two controls,
// two columns, and neither reaches across.
//
// EVERY ROW IS ITS PROJECT'S. The page project is the prompt box's pick, which is usually another project,
// so each group sits in a ThreadProjectScope: pin, reopen, Retry and a sub-agent's × go through the row's
// own project's client, and a click opens its card or its drawer in place (RowScope). The row itself is
// the rail's (Sidebar.tsx RailRow) — the same anatomy, hover strip and marks the project view drew,
// measured once, not a second copy of them.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { ChevronRight, Ellipsis, ListFilter, Plus } from "lucide-react"
import { useLocation } from "react-router"
import { useSnapshot } from "valtio"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import { ThreadProjectScope } from "../api/threadApi.tsx"
import { externalThreads, isPinned, queued, sectionThreads } from "../groups.ts"
import { useBoard } from "../hooks.ts"
import { threadKey, type QueuesProject } from "../lib/allQueues.ts"
import { projectSlug } from "../lib/base-path.ts"
import { setProjectCollapsed, setProjectDrilled, setQueueFilter, useCollapsedProjects, useDrilledProjects, useQueueFilter } from "../lib/crossProject.ts"
import { prefetchProjectBoard, projectBoardKey, useProjectBoard } from "../lib/projectBoards.ts"
import { drawerThreadSlug, store } from "../store.ts"
import { useOpenThreadInPlace } from "./AllQueuesCard.tsx"
import { BANDS, type BandKey } from "./BandLabel.tsx"
import { ProjectMenu, useAddProject } from "./ProjectActions.tsx"
import { QueueBadge } from "./ProjectFilter.tsx"
import { ProjectSquare } from "./ProjectRail.tsx"
import { ROW_ACTION_CLASS, RailRow, SectionHeader, type RowScope } from "./Sidebar.tsx"
import { glideTo } from "../lib/viewportLock.ts"

// The board sidebar's row geometry, verbatim (Sidebar.tsx ThreadRow), so a project's row and its threads'
// rows are one list: the hover wash, the 20px indicator gutter, the title's 13/19 type.
const ROW_CLASS =
  "group relative flex min-w-0 items-start rounded-md transition-[color,opacity] after:pointer-events-none after:absolute after:inset-0 after:rounded-md after:bg-hover after:opacity-0 after:transition-opacity hover:after:opacity-100"
const ROW_BUTTON_CLASS = "flex min-w-0 flex-1 items-start gap-2 pb-1 pl-5 pr-1.5 pt-1 text-left outline-none focus-visible:ring-1 focus-visible:ring-focus-ink-60 rounded-md"
const INDICATOR_SLOT = "flex h-[19px] w-4 shrink-0 items-center justify-center"
/** A row whose "…" menu is open wears the rail's hover wash, held. */
const SELECTED_ROW = "after:!opacity-100"
/** Done rows listed per page: the band grows without bound, and a project opens on its most recent. */
const DONE_PAGE = 10
/** How long the page must be idle before the list reads every project's board ahead of a click. */
const PREFETCH_IDLE_MS = 1_500

/**
 * Every project on the machine — the page's navigator, and the only place a project is managed from.
 *
 * Projects with work in flight come first, in the rail's order, each followed by its threads; every other
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
  const drilled = useDrilledProjects()
  useReadAhead(projects)
  const groups = projects.map((project) => ({ project, bands: loudBands(project, hidden) }))
  // A folded project keeps its place: it is still busy, only quieter to look at.
  const busy = groups.filter((group) => group.bands.rows > 0)
  const quiet = groups.filter((group) => group.bands.rows === 0)
  const group = (entry: (typeof groups)[number], spaced: boolean) => (
    <ProjectGroup
      key={entry.project.id}
      project={entry.project}
      loud={entry.bands}
      collapsed={collapsed.has(entry.project.id)}
      drilled={drilled.has(entry.project.id)}
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
        <section aria-label="Quiet projects" className={busy.length > 0 ? "mt-3" : ""}>
          {quiet.map((entry) => group(entry, false))}
        </section>
      )}
    </>
  )
}

interface LoudBands {
  /** Every pinned thread, whatever its state: the pin is the human's shelf, and it outranks Done. */
  pinned: ThreadView[]
  ready: ThreadView[]
  working: ThreadView[]
  rows: number
}

/**
 * A project's work in flight, as its rail banded it: Pinned first (the pin diverts a thread out of every
 * other band, groups.ts sectionThreads), then Ready in queue order, then Working. A Ready card being
 * finished leaves its row with it (`hidden`); one open in a drawer keeps its row, marked open.
 */
function loudBands(project: QueuesProject, hidden: (key: string) => boolean): LoudBands {
  const pinned = [...project.queued, ...project.running, ...project.snoozed].filter(isPinned)
  pinned.sort((a, b) => (a.pinnedAt ?? "").localeCompare(b.pinnedAt ?? "") || a.id.localeCompare(b.id))
  const ready = project.queued.filter((t) => !isPinned(t) && !hidden(threadKey(project.id, t.id)))
  const working = project.running.filter((t) => !isPinned(t))
  return { pinned, ready, working, rows: pinned.length + ready.length + working.length }
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
 * One project: its row, its work in flight, and — drilled — the rest of it; folded away, only its row.
 *
 * Its FOCUS project (the page project, whose board is live in the store) reads the rest from that board;
 * every other reads its board through the cache, which the list read ahead.
 */
function ProjectGroup({
  project,
  loud,
  collapsed,
  drilled,
  spaced,
  home,
  activeKey,
  onQueuedRow,
}: {
  project: QueuesProject
  loud: LoudBands
  collapsed: boolean
  drilled: boolean
  spaced: boolean
  home: string | undefined
  activeKey: string | null
  onQueuedRow: (key: string) => number | null
}) {
  const focus = projectSlug(useLocation().pathname)
  const live = useBoard()
  const onPage = project.slug === focus && live?.projectSlug === project.slug
  const showsRest = drilled && !collapsed
  const cached = useProjectBoard(project.id, showsRest && !onPage && project.open)
  const board = onPage ? live : cached
  const quiet = useMemo(() => quietBands(project, board), [project, board])
  const snap = useSnapshot(store)
  // Only the page project's drawers can be open on this page, so only its rows can be the one up in one.
  const openSlug = onPage ? drawerThreadSlug(snap.drawers) : null
  const scope = useRowScope(project, onPage, onQueuedRow)
  const queryClient = useQueryClient()
  // The threads with a card in the queue — a Ready row, or a pinned one that is Ready — which the thread
  // across the gutter ties to that card (ThreadConnector).
  const carded = new Set(project.queued.map((t) => t.id))
  const row = (restedAge: boolean) => (t: ThreadView) => (
    <RailRow
      key={t.id}
      t={t}
      active={activeKey === threadKey(project.id, t.id)}
      open={openSlug === t.id}
      restedAge={restedAge}
      scope={scope}
      cardKey={carded.has(t.id) ? threadKey(project.id, t.id) : undefined}
    />
  )
  return (
    <section
      aria-label={project.name}
      data-xq-rail-project={project.id}
      data-xq-project-collapsed={collapsed || undefined}
      data-xq-project-drilled={showsRest || undefined}
      className={spaced ? "mt-3" : ""}
      // The rows are in the cache before the click lands (lib/projectBoards.ts).
      onPointerEnter={() => {
        if (!onPage && project.open && !project.stale) prefetchProjectBoard(queryClient, project.id)
      }}
    >
      <ProjectRow
        project={project}
        busy={loud.rows > 0}
        count={loud.ready.length}
        quiet={quiet}
        collapsed={collapsed}
        showsRest={showsRest}
        home={home}
      />
      {!collapsed && (
        <ThreadProjectScope projectId={project.id} projectDir={project.projectDir}>
          {loud.pinned.map(row(false))}
          {quiet.pinnedDone.map(row(false))}
          {loud.ready.map(row(true))}
          {loud.working.map(row(false))}
          {drilled && <ProjectDrill project={project} quiet={quiet} row={row(false)} />}
        </ThreadProjectScope>
      )}
    </section>
  )
}

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
 * under its row — its work in flight and, if it is showing it, the rest — and a second click brings it all
 * back; a quiet project has nothing under it but the rest, so its click brings that out, and folds it away
 * again. Nothing navigates — the project view it used to open is gone. The whole row is the fold's target;
 * only its own controls sit above it.
 *
 * Its right edge carries, in order: the quiet bands' counts — THEIR OWN toggle, the "sub button" that shows
 * or hides the rest (Snoozed, Done, External) without touching the fold — then its Ready count: the accent
 * badge, the one number in the list that wants you, which stays when the project is folded so a folded
 * project still says it is waiting. Or, in their place, a note, only when something is wrong: its directory
 * is gone, or this server has not opened it. On hover the badge gives way to the "…" (ProjectActions.tsx
 * ProjectMenu): the queue filter, its repo, its icon, rename and delete. The badge's slot is held even when
 * empty, so the counts never slide under the menu.
 */
function ProjectRow({
  project,
  busy,
  count,
  quiet,
  collapsed,
  showsRest,
  home,
}: {
  project: QueuesProject
  busy: boolean
  count: number
  quiet: QuietBands
  collapsed: boolean
  showsRest: boolean
  home: string | undefined
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  // The list is never filtered, but it SAYS so when the queue is: the filtered project wears the filter's
  // own glyph beside its name — the READY header's pill, echoed on the row it names.
  const filtered = useQueueFilter() === project.id
  const note = project.stale ? "Directory is missing" : !project.open ? "Not open" : null
  // Whether anything is listed under the row: the fold's own state, on either kind of project.
  const unfolded = busy ? !collapsed : showsRest
  const fold = () => {
    if (busy) return setProjectCollapsed(project.id)
    // A quiet project folds only the rest. A fold left over from when it was busy is lifted, so the click
    // always shows what it says it will.
    setProjectCollapsed(project.id, false)
    setProjectDrilled(project.id, !showsRest)
  }
  const foldTitle = busy
    ? `${collapsed ? "Show" : "Collapse"} ${project.name}'s threads`
    : `${showsRest ? "Hide" : "Show"} everything in ${project.name}`
  return (
    <div
      data-xq-project-row={project.id}
      className={`${ROW_CLASS} ${project.stale ? "opacity-60" : ""} ${menuOpen ? SELECTED_ROW : ""}`}
    >
      <button
        type="button"
        data-xq-project-fold
        onClick={fold}
        aria-expanded={unfolded}
        aria-label={foldTitle}
        title={foldTitle}
        // The whole row is the target (the `before:` layer), not just the name: the badge and the space
        // around it fold too. The counts and the "…" sit above it. `pr-2` is the gap to the counts.
        className={`${ROW_BUTTON_CLASS} !pr-2 items-center before:absolute before:inset-0 before:rounded-md before:content-['']`}
      >
        {/* THE DISCLOSURE, in the gutter the rail's scroll marker uses — where the rail's own collapsible
            band headers keep theirs (Sidebar.tsx SectionHeader), so the list folds the way the rail did.
            Only while it means something: on hover (and always on touch), and HELD whenever the project is
            not as it starts — a busy project folded away (pointing right), a quiet one showing the rest
            (turned down). A busy project open, the usual case, draws none, so the list is not a column of
            chevrons. */}
        <span
          aria-hidden
          data-xq-project-chevron
          className={`pointer-events-none absolute left-[4.5px] top-1 flex h-[19px] items-center text-muted-60 transition-[opacity,transform] ${unfolded ? "rotate-90" : ""} ${
            (busy ? collapsed : showsRest) ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 [@media(hover:none)]:opacity-100"
          }`}
        >
          <ChevronRight size={11} />
        </span>
        {/* The top of the project's cord, which hangs from this square behind every thread row's indicator
            under it (ThreadConnector). */}
        <span data-xq-indicator className={`${INDICATOR_SLOT} ${project.stale ? "grayscale" : ""}`}>
          <ProjectSquare project={project.card ?? squareCard(project)} size={16} />
        </span>
        {/* Baseline-aligned so the filter mark can sit on the NAME's cap band rather than centre its box:
            the box-centred mark read 0.5px low in sans. `self-baseline` puts the 11px glyph's bottom on
            the baseline and the translate lifts its centre to the cap band's, computed by the browser from
            the resolved font (the same correction ProjectFilter.tsx gives its glyphs); lucide's list-filter
            ink is symmetric in its box, so the box centre is the ink centre. */}
        <span className={`flex min-w-0 flex-1 items-baseline gap-1.5 text-[12.5px] leading-[19px] ${busy ? "font-medium text-fg/90" : "text-fg/75"}`}>
          <span className="min-w-0 truncate">{project.name}</span>
          {filtered && (
            <span data-xq-project-filtered title="The queue shows only this project" className="flex shrink-0 self-baseline translate-y-[calc(5.5px_-_0.5cap)] text-muted-60">
              <ListFilter size={11} aria-label="The queue shows only this project" />
            </span>
          )}
        </span>
      </button>
      {/* The right edge, beside the fold rather than inside it: the counts are a button of their own. On a
          touch screen the "…" never hides, so they step left of it rather than under it. */}
      <div className="flex shrink-0 items-center gap-2 self-stretch pr-1.5 [@media(hover:none)]:pr-7">
        {note ? (
          <span className="text-[10.5px] leading-[19px] text-muted-55">{note}</span>
        ) : (
          <>
            <QuietToggle project={project} quiet={quiet} showsRest={showsRest} />
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
        <div className={`absolute right-1.5 top-1 items-center group-hover:flex group-has-[:focus-visible]:flex [@media(hover:none)]:flex ${menuOpen ? "flex" : "hidden"}`}>
          <ProjectMenu
            project={project.card}
            home={home}
            githubRepo={project.githubRepo}
            filtered={filtered}
            onFilter={() => {
              setQueueFilter(filtered ? null : project.id)
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
 * rail's legend (BandLabel.tsx), so "zz 2 · ☑ 43" reads as the Snoozed and Done headers it opens onto.
 * Quieter than the name and never the accent, which in this product means only "this many want you".
 *
 * And the toggle for them — the "sub button" beside the row's fold: it shows or hides the rest without
 * folding anything else, and on a folded project it unfolds it too, so its click always shows what it
 * says. `relative`, to sit above the fold's whole-row target; its wash hangs 4px past the counts' ink
 * (`-mx-1 px-1`), so the ink stays exactly where it sat before it was a button.
 */
function QuietToggle({ project, quiet, showsRest }: { project: QueuesProject; quiet: QuietBands; showsRest: boolean }) {
  const entries: { band: BandKey; count: number; noun: string }[] = [
    { band: "snoozed", count: quiet.snoozed.length, noun: "snoozed" },
    { band: "done", count: quiet.doneCount, noun: "done" },
    { band: "external", count: quiet.external.length, noun: "external" },
  ]
  const shown = entries.filter((entry) => entry.count > 0)
  if (shown.length === 0) return null
  const counts = shown.map(({ count, noun }) => `${count} ${noun}`)
  const label = `${showsRest ? "Hide" : "Show"} ${counts.length > 1 ? `${counts.slice(0, -1).join(", ")} and ${counts.at(-1)}` : counts[0]}`
  return (
    <button
      type="button"
      data-xq-quiet-toggle
      aria-expanded={showsRest}
      aria-label={label}
      title={label}
      onClick={() => {
        setProjectCollapsed(project.id, false)
        setProjectDrilled(project.id, !showsRest)
      }}
      className={`relative -mx-1 flex h-[19px] shrink-0 items-center gap-2 rounded px-1 outline-none transition-colors hover:bg-hover-strong hover:text-fg/80 focus-visible:ring-1 focus-visible:ring-focus-ink-60 ${showsRest ? "text-muted-70" : "text-muted-50"}`}
    >
      {shown.map(({ band, count }) => {
        const { Icon } = BANDS[band]
        return (
          // The glyph sits on its DIGIT's cap band, not beside its box: box-centred, all three glyphs read
          // 1.5px low (sans, 10.5px). The pair shares one font size, set on the pair, so `cap` resolves
          // against the digit's font; `self-baseline` lands the 10px glyph's bottom on the digit's
          // baseline and the translate lifts its centre to the band's. Every band glyph's ink spans y 3–21
          // of its 24-unit box (SquareCheck, ExternalLink, BandLabel's SnoozeMark), so the box centre is
          // the ink centre for each.
          <span key={band} data-xq-quiet-count={band} aria-hidden className="flex items-baseline gap-[3px] text-[10.5px] leading-[19px]">
            <span className="flex self-baseline translate-y-[calc(5px_-_0.5cap)]">
              <Icon size={10} />
            </span>
            <span className="tabular-nums">{count}</span>
          </span>
        )
      })}
    </button>
  )
}

/**
 * The rest of an opened project, in its rail's own bands and order: Snoozed, then Done (its most recent
 * first, a page at a time), then External — the project's own terminals, which a message takes over.
 */
function ProjectDrill({ project, quiet, row }: { project: QueuesProject; quiet: QuietBands; row: (t: ThreadView) => ReactNode }) {
  const [donePage, setDonePage] = useState(DONE_PAGE)
  const nothing = quiet.snoozed.length === 0 && quiet.doneCount === 0 && quiet.external.length === 0
  return (
    <div data-xq-drill={project.id} className="flex min-w-0 flex-col">
      {quiet.snoozed.length > 0 && (
        <div data-xq-drill-band="snoozed">
          <SectionHeader band="snoozed" count={quiet.snoozed.length} />
          {quiet.snoozed.map(row)}
        </div>
      )}
      {quiet.doneCount > 0 && (
        <div data-xq-drill-band="done">
          <SectionHeader band="done" count={quiet.doneCount} />
          {quiet.done ? (
            <>
              {quiet.done.slice(0, donePage).map(row)}
              {quiet.done.length > donePage && (
                <button
                  type="button"
                  onClick={() => setDonePage((page) => page + DONE_PAGE * 2)}
                  className="rounded-md py-1 pl-[44px] pr-1.5 text-left text-[11.5px] leading-[19px] text-muted-60 outline-none transition-colors hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60"
                >
                  Show {Math.min(DONE_PAGE * 2, quiet.done.length - donePage)} more
                </button>
              )}
            </>
          ) : (
            <div aria-busy className="py-1 pl-[44px] text-[11.5px] leading-[19px] text-muted-50">Loading…</div>
          )}
        </div>
      )}
      {quiet.external.length > 0 && (
        <div data-xq-drill-band="external">
          <SectionHeader band="external" count={quiet.external.length} />
          {quiet.external.map(row)}
        </div>
      )}
      {nothing && (
        // Where the rail said "No open threads": pl-5 plus the indicator column, so it starts under the
        // titles it stands in for.
        <div className="py-1 pl-[44px] pr-1.5 text-[11.5px] leading-[19px] text-muted-50">Nothing snoozed or done</div>
      )}
    </div>
  )
}

/**
 * The last row of the list: a project the machine does not have yet. The rail's own add slot — a dotted
 * squircle, "nothing here yet" — at the row's scale, so it reads as an empty place in the same list rather
 * than a button bolted under it. Muted, and never accent: accent means only "this many want you".
 */
export function AddProjectRow() {
  const add = useAddProject()
  return (
    <div className={`${ROW_CLASS} mt-3`}>
      <button type="button" onClick={add.start} disabled={add.pending} className={`${ROW_BUTTON_CLASS} group/add items-center disabled:opacity-60`}>
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
