// THE CROSS-PROJECT PAGE ("Everything") — every project's queue on one page, and the default mode: `/`
// lands here, focused on a project the address does not name (see routes.tsx CrossProjectPage).
//
// It is the board, one level up, and it is laid out as one. The board is a floating sidebar beside a
// 720px queue; so is this. The board's sidebar lists a project's threads in bands (Queue, Running,
// Snoozed); this one lists every PROJECT, each with its own queue rows and running rows beneath it, in
// the operator's own rail order. The board's queue is a column of cards; so is this one — ONE queue
// across every project, in the order each card entered it (maintainer 2026-09-28: "One queue across all
// projects"), each card wearing its project's chip (AllQueuesCard.tsx ProjectChip). It was one LANE per
// project, in rail order, until then, and a project listed above the one being read put its whole lane
// on top of the card the operator was reading the moment its first thread came to rest.
//
// NOTHING HERE THROWS THE OPERATOR INTO A PROJECT'S BOARD (single-project mode) except a door that says
// so. The page has a FOCUS — one project — and the focus is the page project: the prompt box at the top
// of the column dispatches into it, and a thread of it opens in the board's own drawer, in place. At `/`
// the focus is the box's own choice (the PICK, chosen in its bottom strip); opening a thread of ANOTHER
// project moves it to that project for as long as the drawer is open (`/all/<slug>/thread/<t>`,
// useOpenThreadInPlace), so every thread on the page is one click from its full transcript without
// leaving the page, and closing the drawer returns home to the pick.
//
// THE DRILL-DOWN, three steps, each one click, none of them leaving:
//   1. the card — the handoff's opening lines, the questions, a reply box, Snooze and Mark as done;
//   2. "Show more" — the whole handoff, in place;
//   3. the card's title (or a rail row) — the thread's drawer, with its whole transcript and composer.
// A card's ↗ and a project's "…" → Open board are the explicit doors to a board.
//
// WHAT THE RAIL AND THE CARDS MUST NEVER DO is ask the page which project anything belongs to. The page
// project is the FOCUS, and they show every project. Every read they make is either machine-wide
// (`projectsList`, `projectsQueues`) or carries its project explicitly, and every action goes through
// that project's own client (`projectRpc`). See AllQueuesCard.tsx for the card's half of the same rule.
// The prompt box and the drawers are the page project's, which is exactly what they should be.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowUpRight, Check, ChevronDown, Ellipsis, Inbox, Plus, TerminalSquare } from "lucide-react"
import { Link, useLocation, useNavigate } from "react-router"
import { useSnapshot } from "valtio"
import type { ProjectCard, ProjectQueue, ThreadView } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { displayTitle } from "../groups.ts"
import { isBusy, liveQueue, mergedQueue, overlayQueues, queuesProjects, squareCard, threadKey, type QueueEntry, type QueuesProject } from "../lib/allQueues.ts"
import { crossProjectHref, innerPath, projectHref, projectSlug } from "../lib/base-path.ts"
import { rememberCrossProjectFocus } from "../lib/crossProject.ts"
import { draftKey, draftStore } from "../lib/drafts.ts"
import { QUEUE_CARD_VIEWPORT_TOP, slugsInThreadDrawers, store } from "../store.ts"
import { useBoard } from "../hooks.ts"
import { commandFailed, commandLive, commandStateLabel } from "../lib/commandThreads.ts"
import { prefs } from "../lib/prefs.ts"
import { PROMPT_CONTROL_TYPOGRAPHY_CLASS } from "../lib/promptControlTypography.ts"
import { MarkdownScopeContext } from "../lib/useMarkdown.ts"
import { GHOST_LABEL, stableQueue, type QueueSlot } from "../lib/stableQueue.ts"
import { actedOnHere } from "../lib/humanActs.ts"
import { useSteeredAt } from "../lib/steering.ts"
import { glideTo, useViewportLock } from "../lib/viewportLock.ts"
import { registerQueueCursor } from "../lib/keyboardRuntime.ts"
import { AllQueuesCard, ProjectChip, useOpenThreadInPlace } from "./AllQueuesCard.tsx"
import { CommandQueueCard } from "./CommandQueueCard.tsx"
import { ProjectSquare } from "./ProjectRail.tsx"
import { ProviderMark } from "./ProviderMark.tsx"
import { ROW_ACTION_CLASS, RestedAge, SIDEBAR_COLUMN_CLASS, ThreadIndicator, TitleWithTrailers } from "./Sidebar.tsx"
import { BandLabel } from "./BandLabel.tsx"
import { ProjectMenu, homeOf, useAddProject } from "./ProjectActions.tsx"
import { StatusRow } from "./StatusRow.tsx"
import { DispatchForm } from "./NewThreadModal.tsx"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "./ui/Menu.tsx"
import { ProjectFilter, QueueBadge } from "./ProjectFilter.tsx"
import { ThreadProjectScope } from "../api/threadApi.tsx"

/** How often the page re-reads every project. The rail's badges poll at 5s; this is the page the
 *  operator is looking AT, so it runs a little faster — the read is the servers' cached snapshots. */
const POLL_MS = 3_000
/** The card's exit fade — the board's (styles.css `.frizz-card-slot`, TodosView QUEUE_EXIT_MS). */
const EXIT_MS = 200
/**
 * How long an acted-on card stays gone while the server catches up. Past this, a thread that is STILL
 * queued comes back — the action evidently did not take — rather than staying hidden on the strength of
 * a click. The board's queue keeps the same guard.
 */
const REAPPEAR_MS = 8_000
/** How long the prompt box's stand-in waits for the focused project's board before saying so. */
const COMPOSER_WAIT_MS = 6_000

const entryKey = ({ project, thread }: QueueEntry): string => threadKey(project.id, thread.id)
const xqCardKey = (slot: HTMLElement): string | undefined => slot.dataset.xqCard

// Where a ghost's thread went, as far as the page can see (lib/stableQueue.ts GHOST_LABEL).
function ghostLabel(projects: readonly QueuesProject[], { project, thread }: QueueEntry): string {
  const now = projects.find((candidate) => candidate.id === project.id)
  if (now?.running.some((t) => t.id === thread.id)) return GHOST_LABEL.working
  if (now?.snoozed.some((t) => t.id === thread.id)) return GHOST_LABEL.snoozed
  return GHOST_LABEL.gone
}

export function AllQueuesPage() {
  const cards = useQuery({ queryKey: ["projectsList"], queryFn: () => rpc.projectsList() })
  const queues = useQuery({
    queryKey: ["projectsQueues"],
    queryFn: () => rpc.projectsQueues(),
    refetchInterval: POLL_MS,
  })
  const direction = useSnapshot(prefs).queueOrder
  // The FOCUS — the page project (routes.tsx CrossProjectPage). Its board is live in the store, so it
  // is drawn from that rather than from the poll, and so is the project the focus just LEFT, until the
  // poll has caught up with what was done there (useDepartedQueue).
  const focus = projectSlug(useLocation().pathname)
  const board = useBoard()
  const snap = useSnapshot(store)
  const polled = useLastKnownQueues(queues.data, cards.data)
  const live = useMemo(() => liveQueue(polled, board, focus), [polled, board, focus])
  const departed = useDepartedQueue(live, queues.dataUpdatedAt)
  const base = useMemo(() => queuesProjects(cards.data, polled, direction), [cards.data, polled, direction])
  const projects = useMemo(() => overlayQueues(base, [live, departed], direction), [base, live, departed, direction])
  const pickProject = usePickProject()
  // Set by a choice in the picker, so the prompt box it just re-aimed takes the keyboard when it lands.
  const [focusComposerFor, setFocusComposerFor] = useState<string | null>(null)


  const leaving = useLeavingCards(projects)
  // A thread whose drawer is open is read THERE: its card would be a second copy of the same questions
  // and reply box under the sheet (the board's rule, store.ts slugsInThreadDrawers). Drawers belong to
  // the page project, so only the focus's cards can be hidden this way. HIDDEN, NOT REMOVED: the card
  // keeps its space (QueueCardOf `concealed`), so opening its drawer and closing it again moves nothing
  // under the sheet or after it.
  const focusId = projects.find((project) => project.slug === focus)?.id
  const inDrawer = new Set(focusId === undefined ? [] : [...slugsInThreadDrawers(snap.drawers)].map((slug) => threadKey(focusId, slug)))
  const hidden = (key: string) => leaving.hidden(key) || inDrawer.has(key)
  const [, repaint] = useState(0)
  // THE VIEWPORT LOCK (lib/viewportLock.ts), and the one thing it asks back: a render once the page is
  // still, when a ghost has scrolled off screen (it can go now that nobody sees it go) or the cards on
  // screen have changed (the ones held back for them can take their places).
  const lock = useViewportLock("[data-xq-card]", xqCardKey, useCallback(() => repaint((n) => n + 1), []))
  const steeredAt = useSteeredAt()
  // Registered projects this server has not opened (still being opened after a boot, served by another
  // Frizz, or failed to open): their queues are unknown, so "nothing in any queue" would be a claim.
  const unopened = projects.filter((project) => !project.open && !project.stale).length
  // The ONE queue in lib/stableQueue.ts's STABLE order: the queue's own order off screen; on screen
  // exactly as last drawn (maintainer 2026-09-28: "it needs to be guaranteed that cards that I'm
  // currently viewing on the screen don't move in their position"). A card whose thread left the queue
  // by any hand but the human's in THIS tab (lib/humanActs.ts) — its agent woke itself, it was answered
  // from the phone, its project closed — is held there as a ghost; one the human put away from here —
  // finished, replied to, snoozed — leaves the ordinary way, held only while it fades. Re-sorting is the
  // human choosing a different order, so it starts over from the queue's own.
  const ordered = mergedQueue(projects, direction).filter(({ project, thread }) => !leaving.hidden(threadKey(project.id, thread.id)))
  const prevSlots = useRef<QueueSlot<QueueEntry>[]>([])
  const orderedAs = useRef(direction)
  if (orderedAs.current !== direction) {
    orderedAs.current = direction
    prevSlots.current = []
  }
  const mayGhost = (key: string): boolean => {
    if (leaving.isLeaving(key)) return false
    const was = prevSlots.current.find((slot) => slot.key === key)?.item
    return was !== undefined && steeredAt[was.thread.id] === undefined && !actedOnHere(was.thread.id)
  }
  const slots = stableQueue({
    prev: prevSlots.current,
    target: ordered,
    keyOf: entryKey,
    onScreen: lock.onScreen.current,
    mayGhost,
    keep: new Set(prevSlots.current.map((slot) => slot.key).filter((key) => leaving.isLeaving(key) && !leaving.hidden(key))),
  })
  prevSlots.current = slots
  const queue = slots
  // Counted from what the page SHOWS: a card the operator just finished is gone from the count at once,
  // and a header still counting it read "1 in the queue" over an empty page until the next poll. A ghost
  // is not waiting on anyone, and a card whose drawer is open is being read there.
  const ready = queue.filter((slot) => !slot.ghost && !leaving.isLeaving(slot.key) && !inDrawer.has(slot.key)).length
  const scrollToCard = useScrollToCard()
  const activeKey = useScrollspy(queue)
  useQueueKeys(activeKey, scrollToCard)
  const loading = (cards.isPending || queues.isPending) && !queues.data
  // Below the page's stacking point the columns are one above the other, so the list follows the queue
  // rather than sitting between the prompt box and the queue it indexes.
  const stacked = useStacked()
  const home = homeOf(cards.data)
  const list = (
    <>
      <ProjectList projects={projects} home={home} activeKey={activeKey} hidden={hidden} onQueuedRow={scrollToCard} />
      <AddProjectRow />
    </>
  )

  return (
    <div className="flex min-h-screen justify-center gap-[clamp(28px,3.4vw,52px)] bg-bg px-5 text-sm text-fg max-[800px]:flex-col max-[800px]:justify-start max-[800px]:gap-0 max-[800px]:px-3">
      {/* TOP-anchored, where the board centres its column: a click here changes the list's height (narrowing
          folds every other project to one line), and a centred column moved the prompt box and the row just
          clicked out from under the pointer — by 110-200px with five projects. 48px sets the status row's middle
          level with the READY header's across the gutter (64 vs 59.85px at 52px). */}
      <aside aria-label="Projects" className={`${SIDEBAR_COLUMN_CLASS} !justify-start pt-[48px] max-[800px]:!pt-5`}>
        <div className="flex max-h-[calc(100vh-68px)] min-h-0 min-w-0 w-full flex-col max-[800px]:max-h-none">
          {/* The board's own column head, one level up: the status row — naming what the page shows —
              and the prompt box under it: a new thread in any project without leaving, the project chosen
              in the box's own bottom strip, beside the model. */}
          <div className="mb-5 shrink-0 px-0.5">
            <StatusRow crossProject view={<ViewFilter projects={projects} hidden={hidden} />} />
            <FocusedComposer
              focus={focus}
              project={projects.find((project) => project.slug === focus)}
              autoFocus={focusComposerFor !== null && focusComposerFor === focus}
              onFocused={() => setFocusComposerFor(null)}
              target={
                <ProjectPicker
                  projects={projects}
                  focus={focus}
                  onPick={(project) => {
                    setFocusComposerFor(project.slug)
                    pickProject(project)
                  }}
                />
              }
            />
          </div>
          {!stacked && (
            <div data-xq-rail className="min-h-0 min-w-0 overflow-y-auto overflow-x-hidden">
              {list}
            </div>
          )}
        </div>
      </aside>
      <main
        id="workpane"
        aria-label="Everything"
        className="flex min-h-screen w-[720px] max-w-[62vw] min-w-0 flex-col py-5 max-[800px]:min-h-0 max-[800px]:w-full max-[800px]:max-w-none"
      >
        {loading ? (
          <div className="flex flex-1 items-center justify-center">
            <span className="block h-5 w-5 animate-spin rounded-full border-2 border-muted/50 border-t-transparent" />
          </div>
        ) : queues.error && !queues.data ? (
          <p className="my-auto text-center text-[13px] text-muted">Could not read the queues: {String(queues.error)}</p>
        ) : (
          <div className={`${queue.length > 0 ? "" : "my-auto "}flex w-full min-w-0 flex-col py-8 max-[800px]:pt-2`}>
            {queue.length > 0 ? (
              <>
                {/* THE INBOX, NAMED — the board's own header over its cards (TodosView), one level up: every
                    card below is a Ready thread, whichever project it is from. `pl-[21px]` stands the glyph
                    over the card titles. */}
                <h2 data-inbox-header className="mb-3 flex pl-[21px]">
                  <BandLabel band="ready" count={ready} />
                </h2>
                {queue.map((slot, index) => (
                  <Fragment key={slot.key}>
                    <QueueCardOf entry={slot.item} ghost={slot.ghost ? ghostLabel(projects, slot.item) : undefined} concealed={inDrawer.has(slot.key)} leaving={leaving} />
                    {/* The rule between two cards, as on the board (TodosView): a sibling that FOLLOWS its
                        card, so styles.css fades it with the card when that one leaves. */}
                    {index < queue.length - 1 && <hr className="my-10 border-0 border-t border-border/60" />}
                  </Fragment>
                ))}
              </>
            ) : (
              <EmptyQueues unopened={unopened} />
            )}
          </div>
        )}
        {stacked && (
          <div data-xq-rail="stacked" className="min-w-0 border-t border-border/60 pt-5">
            {list}
          </div>
        )}
      </main>
    </div>
  )
}

/**
 * The page's side of the status row's filter (ProjectFilter.tsx): Everything is this page, and choosing a
 * project opens its PROJECT VIEW — the same layout, showing only that project and more of it.
 */
function ViewFilter({ projects, hidden }: { projects: QueuesProject[]; hidden: (key: string) => boolean }) {
  const navigate = useNavigate()
  // The list's own order (ProjectList): busy projects first, then the quiet ones.
  const ordered = [...projects.filter(isBusy), ...projects.filter((project) => !isBusy(project))]
  const items = ordered.map((project) => ({
    id: project.id,
    slug: project.slug,
    name: project.name,
    card: squareCard(project),
    ready: project.queued.filter((t) => !hidden(threadKey(project.id, t.id))).length,
  }))
  return (
    <ProjectFilter
      projects={items}
      current={undefined}
      onEverything={() => glideTo(() => 0)}
      onProject={(project) => navigate(projectHref(encodeURIComponent(project.slug)))}
      onClear={() => {}}
    />
  )
}

// ---- The column head --------------------------------------------------------------------------------

/**
 * WHICH PROJECT A NEW THREAD GOES TO — the first pill in the prompt box's bottom strip, beside the model
 * (NewThreadModal.tsx DispatchForm `target`), drawn as that pill is: a setting of the thread about to
 * start, not a view. Choosing one makes it the PICK (lib/crossProject.ts), which `/` is focused on and
 * the box dispatches into — remembered, never in the address.
 */
function ProjectPicker({ projects, focus, onPick }: { projects: QueuesProject[]; focus: string | undefined; onPick: (project: QueuesProject) => void }) {
  const current = projects.find((project) => project.slug === focus)
  const name = current?.name ?? focus ?? "a project"
  // A project whose directory is gone cannot take a thread; it stays on the rail, saying why.
  const choices = projects.filter((project) => !project.stale)
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          data-xq-project-picker
          title={`New threads start in ${name}`}
          aria-label={`New threads start in ${name}. Choose a project`}
          // The model pill's own chrome and type (ProfileGridSelector's trigger), so the strip reads as one
          // row of settings for the next thread.
          className={`group inline-flex min-w-0 max-w-[min(14rem,45%)] cursor-pointer items-center gap-[5px] rounded-md border border-border/50 bg-transparent px-2 py-1 text-left text-muted outline-none transition-colors hover:border-border hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60 data-[state=open]:border-border data-[state=open]:bg-panel-2 ${PROMPT_CONTROL_TYPOGRAPHY_CLASS}`}
        >
          {/* Ink gaps (sans, scripts/ink-gaps.mjs): square→name 5.00px; name→chevron 6.00px against the model
              pill's own 6.12px, which `-ml-[3px]` buys back from the chevron's dead box. */}
          {current && <ProjectSquare project={squareCard(current)} size={12} />}
          <span data-xq-picker-name className="min-w-0 flex-1 truncate">{name}</span>
          <ChevronDown size={13} aria-hidden className="-ml-[3px] shrink-0 text-fg/65 transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </MenuTrigger>
      <MenuContent align="start">
        <div className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-medium text-muted-55">Start in</div>
        <div className="max-h-[min(60vh,420px)] overflow-y-auto">
          {choices.map((project) => (
            <MenuItem key={project.id} onSelect={() => onPick(project)} icon={<ProjectSquare project={squareCard(project)} size={14} />}>
              <span className={`min-w-0 flex-1 truncate ${project.slug === focus ? "text-fg" : ""}`}>{project.name}</span>
              {/* Choosable — opening its board may be exactly what brings it up — but not a surprise. */}
              {!project.open && <span className="shrink-0 text-[10.5px] text-muted-55">Not open</span>}
              {project.slug === focus && <Check size={12} aria-label="Current" className="shrink-0 text-fg" />}
            </MenuItem>
          ))}
        </div>
      </MenuContent>
    </Menu>
  )
}

/**
 * CHOOSE the project a new thread goes to, in the prompt box's picker. Remembered as the pick
 * (lib/crossProject.ts), which `/` is focused on.
 *
 * What was typed in the prompt box goes WITH the choice. The box is one box whose target just changed,
 * and the commonest reason to change it is noticing, mid-prompt, that it pointed at the wrong project —
 * a draft left filed under the old one looked like the text had been lost. It moves only into an empty
 * box, so a draft already waiting in the chosen project is never overwritten.
 */
function usePickProject(): (project: QueuesProject) => void {
  const navigate = useNavigate()
  return useCallback(
    (project: QueuesProject) => {
      carryDraft(draftKey.dispatch, store.board?.projectDir, project.projectDir)
      carryDraft(draftKey.command, store.board?.projectDir, project.projectDir)
      rememberCrossProjectFocus(project.id)
      // A drawer open on the page has it focused on the drawer's project, and the box follows the focus,
      // so aiming the box closes the drawers: home, where the focus is the pick.
      if (innerPath() !== "/") navigate("/", { replace: true })
    },
    [navigate],
  )
}

function carryDraft(key: (projectDir: string | undefined) => string, from: string | undefined, to: string | undefined) {
  if (!from || !to || from === to) return
  const text = draftStore.get(key(from))
  if (!text || draftStore.get(key(to))) return
  draftStore.set(key(to), text)
  draftStore.clear(key(from))
}

/**
 * The project the focus just LEFT, drawn from its last live board until the poll has caught up.
 *
 * Its live board goes with the focus, and the poll behind it can be a few seconds old — so a card
 * marked done in its drawer a moment ago came back, from the poll, the instant the operator opened
 * something in another project. Held only until a read that STARTED after the departure lands, and
 * that read is asked for at once rather than left to the next tick.
 */
/** How long a project the server has stopped serving keeps its last queue on the page (useLastKnownQueues). */
const UNOPENED_HOLD_MS = 60_000

/**
 * The poll's queues, with a project that DROPPED OUT of it held as it last was, for up to a minute.
 *
 * The poll carries only the projects the server has open, and a restarted server opens them again one
 * by one: for those seconds every other project's cards vanished and came back, moving each card below
 * them on the reader's screen. Held here instead, they wait where they were. Only a project still
 * registered and not stale: one removed or whose directory is gone has really left. Past the minute a
 * project that has still not come back (another Frizz serves it, it failed to open) is shown as it is.
 */
function useLastKnownQueues(queues: readonly ProjectQueue[] | undefined, cards: readonly ProjectCard[] | undefined): readonly ProjectQueue[] | undefined {
  const seen = useRef(new Map<string, { queue: ProjectQueue; at: number }>())
  return useMemo(() => {
    if (!queues) return queues
    const now = Date.now()
    for (const queue of queues) seen.current.set(queue.projectId, { queue, at: now })
    const present = new Set(queues.map((queue) => queue.projectId))
    const held: ProjectQueue[] = []
    for (const card of cards ?? []) {
      if (present.has(card.id) || card.stale) continue
      const last = seen.current.get(card.id)
      if (last && now - last.at < UNOPENED_HOLD_MS) held.push(last.queue)
    }
    return held.length > 0 ? [...queues, ...held] : queues
  }, [queues, cards])
}

function useDepartedQueue(live: ProjectQueue | undefined, polledAt: number): ProjectQueue | undefined {
  const queryClient = useQueryClient()
  const last = useRef<ProjectQueue | undefined>(undefined)
  const [departed, setDeparted] = useState<{ queue: ProjectQueue; at: number } | null>(null)
  useEffect(() => {
    const previous = last.current
    last.current = live
    if (!previous || previous.projectId === live?.projectId) return
    setDeparted({ queue: previous, at: Date.now() })
    void queryClient.invalidateQueries({ queryKey: ["projectsQueues"] })
  }, [live, queryClient])
  if (!departed || departed.queue.projectId === live?.projectId || polledAt > departed.at) return undefined
  return departed.queue
}

/**
 * The board's own prompt box, bound to the focused project — the page project, so it is exactly the
 * board's DispatchForm, drafts, GitHub picker and agent settings included.
 *
 * Only once the store's board IS the focus's. A focus change clears the store and refills it from the
 * new project's feed; in between, the form would key its draft on no project (lib/drafts.ts files that
 * under a shared "unresolved" bucket) and what was typed would jump to another box when the board
 * landed. The stand-in holds the box's place so the column does not jump either — and says so if the
 * board never comes, which is what a project this server cannot open looks like from here.
 */
function FocusedComposer({
  focus,
  project,
  target,
  autoFocus,
  onFocused,
}: {
  focus: string | undefined
  project: QueuesProject | undefined
  target: ReactNode
  autoFocus: boolean
  onFocused: () => void
}) {
  const board = useBoard()
  const ready = Boolean(focus) && board?.projectSlug === focus
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    setSlow(false)
    if (ready) return
    const timer = window.setTimeout(() => setSlow(true), COMPOSER_WAIT_MS)
    return () => window.clearTimeout(timer)
  }, [ready, focus])
  useEffect(() => {
    if (ready && autoFocus) onFocused()
  }, [ready, autoFocus, onFocused])
  if (!ready) {
    // The form's own two rows — the tab row and the box — at the form's heights (measured in sans, the
    // prompt tab at rest: 23.42 + 6 + 130 = 159.42px), so nothing below moves when the real form replaces
    // it. The picker keeps its spot in the box's bottom strip, so the operator can always aim elsewhere.
    return (
      <div data-xq-composer-pending className="flex w-full flex-col gap-1.5">
        <div className="h-[23.42px]" />
        <div className="relative flex h-[130px] items-center justify-center rounded-xl border border-border/60 bg-bg px-6 text-center text-[12px] leading-snug text-muted-70">
          <div className="absolute bottom-1.5 left-1.5 flex min-w-0 max-w-[calc(100%-12px)]">{target}</div>
          {slow && (
            <span>
              {project && !project.open ? `${project.name} is not open on this server. ` : `${project?.name ?? focus ?? "This project"} has not answered yet. `}
              <Link to={projectHref(encodeURIComponent(focus ?? ""))} className="text-fg/90 underline decoration-muted/40 underline-offset-2 hover:decoration-fg">
                Open its project view
              </Link>
            </span>
          )}
        </div>
      </div>
    )
  }
  return <DispatchForm key={focus} autoFocus={autoFocus} target={target} />
}

// ---- The machine rail (left column) -----------------------------------------------------------------

// The board sidebar's row geometry, verbatim (Sidebar.tsx ThreadRow), so a row here and a row there are
// the same row: the hover wash, the 20px indicator gutter, the title's 13/19 type.
const ROW_CLASS =
  "group relative flex min-w-0 items-start rounded-md transition-[color,opacity] after:pointer-events-none after:absolute after:inset-0 after:rounded-md after:bg-hover after:opacity-0 after:transition-opacity hover:after:opacity-100"
const ROW_BUTTON_CLASS = "flex min-w-0 flex-1 items-start gap-2 pb-1 pl-5 pr-1.5 pt-1 text-left outline-none focus-visible:ring-1 focus-visible:ring-focus-ink-60 rounded-md"
const INDICATOR_SLOT = "flex h-[19px] w-4 shrink-0 items-center justify-center"

/**
 * Every project on the machine — the page's navigator, and the only place a project is managed from.
 *
 * Projects with something the operator can see — a Ready card, or live work — come first, in the rail's
 * order, each followed by its threads; every other project is one line under them. They are separated
 * by space, not rules: the project's own square already starts each group, and a rule would say it twice.
 */
function ProjectList({
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
  onQueuedRow: (key: string) => void
}) {
  const busy = projects.filter(isBusy)
  const quiet = projects.filter((project) => !isBusy(project))
  return (
    <>
      {busy.map((project, index) => (
        <ProjectGroup
          key={project.id}
          project={project}
          spaced={index > 0}
          home={home}
          activeKey={activeKey}
          hidden={hidden}
          onQueuedRow={onQueuedRow}
        />
      ))}
      {/* Always listed, one line each, under the busy ones. They sat behind a collapsed "Quiet" fold until
          2026-09-24, which cost a click to reach a project whose row is already about as quiet as a row
          can be (maintainer: "if I want to navigate to them I shouldn't have to expand"). */}
      {quiet.length > 0 && (
        <section aria-label="Quiet projects" className={busy.length > 0 ? "mt-3" : ""}>
          {quiet.map((project) => (
            <ProjectRow key={project.id} project={project} busy={false} home={home} />
          ))}
        </section>
      )}
    </>
  )
}

/**
 * One busy project: its row, then its Ready rows, each opposite its card the way a project view's cue row
 * faces its queue card, then its Working rows. Parked work (Snoozed) is not listed here: it is waiting on
 * nobody, and the project view keeps it.
 */
function ProjectGroup({
  project,
  spaced,
  home,
  activeKey,
  hidden,
  onQueuedRow,
}: {
  project: QueuesProject
  spaced: boolean
  home: string | undefined
  activeKey: string | null
  hidden: (key: string) => boolean
  onQueuedRow: (key: string) => void
}) {
  const openInPlace = useOpenThreadInPlace()
  const queued = project.queued.filter((t) => !hidden(threadKey(project.id, t.id)))
  return (
    <section aria-label={project.name} data-xq-rail-project={project.id} className={spaced ? "mt-3" : ""}>
      <ProjectRow project={project} busy count={queued.length} home={home} />
      {queued.map((t) => {
        const key = threadKey(project.id, t.id)
        return <RailRow key={key} t={t} active={activeKey === key} restedAge onClick={() => onQueuedRow(key)} />
      })}
      {project.running.map((t) => (
        <RailRow key={t.id} t={t} onClick={() => openInPlace(project, t.id)} />
      ))}
    </section>
  )
}

/** A row whose "…" menu is open wears the rail's hover wash, held. */
const SELECTED_ROW = "after:!opacity-100"

/**
 * A project's own row — the same for a busy project heading its threads and a quiet one alone.
 *
 * Its click opens the project's PROJECT VIEW — the same layout, that project alone and more of it (its
 * Snoozed, its Done, its terminal) — and the status row's filter pill there is the one click back. Its right edge is its count — the accent badge, when anything is
 * Ready — or a note, only when something is wrong: its directory is gone, or this server has not opened
 * it. Nothing else: "3 done" and "no threads" were words about nothing to do. On hover the count gives
 * way to the "…" (ProjectActions.tsx ProjectMenu): its icon, rename and delete.
 */
function ProjectRow({
  project,
  busy,
  count = 0,
  home,
}: {
  project: QueuesProject
  busy: boolean
  count?: number
  home: string | undefined
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const note = project.stale ? "Directory is missing" : !project.open ? "Not open" : null
  return (
    <div
      data-xq-project-row={project.id}
      className={`${ROW_CLASS} ${project.stale ? "opacity-60" : ""} ${menuOpen ? SELECTED_ROW : ""}`}
    >
      <Link
        to={projectHref(encodeURIComponent(project.slug))}
        title={`Show only ${project.name}`}
        // On a touch screen the "…" never hides, so the count steps left of it rather than under it.
        className={`${ROW_BUTTON_CLASS} items-center [@media(hover:none)]:pr-7`}
      >
        <span className={`${INDICATOR_SLOT} ${project.stale ? "grayscale" : ""}`}>
          <ProjectSquare project={squareCard(project)} size={16} />
        </span>
        <span className={`min-w-0 flex-1 truncate text-[12.5px] leading-[19px] ${busy ? "font-medium text-fg/90" : "text-fg/75"}`}>
          {project.name}
        </span>
        {/* The rest-time column's spot, and the rest time's manners: it gives way to the menu on hover. */}
        {(count > 0 || note) && (
          <span className={`flex shrink-0 transition-opacity group-hover:opacity-0 group-has-[:focus-visible]:opacity-0 ${menuOpen ? "opacity-0" : ""} [@media(hover:none)]:opacity-100`}>
            {count > 0 ? <QueueBadge count={count} /> : <span className="text-[10.5px] leading-[19px] text-muted-55">{note}</span>}
          </span>
        )}
      </Link>
      {project.card && (
        <div
          className={`absolute right-1.5 top-1 items-center bg-bg group-hover:flex group-has-[:focus-visible]:flex [@media(hover:none)]:flex before:pointer-events-none before:absolute before:inset-y-0 before:right-full before:w-3 before:bg-linear-to-r before:from-transparent before:to-bg ${menuOpen ? "flex" : "hidden"}`}
        >
          <ProjectMenu project={project.card} home={home} onOpenChange={setMenuOpen}>
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
 * The last row of the list: a project the machine does not have yet. The rail's own add slot — a dotted
 * squircle, "nothing here yet" — at the row's scale, so it reads as an empty place in the same list
 * rather than a button bolted under it. Muted, and never accent: accent means only "this many want you".
 */
function AddProjectRow() {
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

/**
 * A thread row — the board sidebar's ThreadRow anatomy, with this page's own click. A Ready row's click
 * brings its card into view and rings it (the card's own title opens the thread); a Working row has no
 * card, so its click opens the thread itself, in place.
 */
function RailRow({
  t,
  active = false,
  restedAge = false,
  onClick,
}: {
  t: ThreadView
  active?: boolean
  restedAge?: boolean
  onClick: () => void
}) {
  return (
    <div className={ROW_CLASS}>
      {/* The board's scroll marker: the card this row faces is the one being read. */}
      {active && <span aria-hidden className="absolute inset-y-0 left-1 w-[2px] rounded-full bg-accent" />}
      <button type="button" onClick={onClick} className={ROW_BUTTON_CLASS} aria-current={active || undefined}>
        {t.kind === "command" && t.command ? (
          <CommandRowBody command={t.command} />
        ) : (
          <>
            <span className={INDICATOR_SLOT}>
              <ThreadIndicator t={t} />
            </span>
            <span className="flex min-w-0 flex-1 items-baseline gap-3">
              <span className="min-w-0 flex-1 break-words text-[13px] leading-[19px] text-fg/90">
                <TitleWithTrailers title={displayTitle(t)}>
                  <ProviderMark backend={t.backend} model={t.model} className="ml-1" />
                </TitleWithTrailers>
              </span>
              {restedAge && <RestedAge t={t} yieldsToRetry />}
            </span>
          </>
        )}
      </button>
    </div>
  )
}

/**
 * A terminal command's row, as the board's rail draws it (Sidebar.tsx CommandRow): the terminal mark or
 * the live dot, the command in mono, and how the run stands where an agent row keeps its rest time.
 */
function CommandRowBody({ command }: { command: NonNullable<ThreadView["command"]> }) {
  const running = commandLive(command)
  const failed = commandFailed(command)
  return (
    <>
      <span className={INDICATOR_SLOT}>
        {running ? (
          <span aria-label="Running" className="frizz-live-dot frizz-live-dot--shell" />
        ) : (
          <TerminalSquare aria-label={commandStateLabel(command)} size={13} className={failed ? "text-danger-soft" : "text-muted-60"} />
        )}
      </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-3">
        <span className="font-mono-keep min-w-0 flex-1 truncate text-[12px] leading-[19px] text-fg/90" title={command.command}>
          {command.command}
        </span>
        {!running && (
          <span className={`shrink-0 tabular-nums text-[10.5px] leading-[19px] ${failed ? "text-danger-soft" : "text-muted-55"}`}>
            {commandStateLabel(command)}
          </span>
        )}
      </span>
    </>
  )
}

/**
 * The rail badge's count (ProjectRail.tsx), laid inline. Accent, and only accent, because the accent
 * means exactly one thing in this product: this many want you.
 */

// ---- The queue (the workpane) -----------------------------------------------------------------------

/**
 * One card of the one queue, whichever project it is from, wearing that project's chip on its meta line.
 *
 * EVERYTHING INSIDE RENDERS AS ITS PROJECT. The markdown scope points a `#123` at the card's repo, a
 * relative path at its directory and a `/thread/<slug>` link at that thread on THIS page (opened in
 * place) — never at the page's focus, which is usually another project.
 */
function QueueCardOf({ entry, ghost, concealed, leaving }: { entry: QueueEntry; ghost: string | undefined; concealed: boolean; leaving: LeavingCards }) {
  const { project, thread } = entry
  const openInPlace = useOpenThreadInPlace()
  const scope = useMemo(
    () => ({
      projectId: project.id,
      repo: project.githubRepo ?? null,
      appPath: crossProjectHref(encodeURIComponent(project.slug)),
      baseDir: project.projectDir,
      homeDir: project.homeDir,
    }),
    [project.id, project.githubRepo, project.slug, project.projectDir, project.homeDir],
  )
  const key = threadKey(project.id, thread.id)
  return (
    <MarkdownScopeContext.Provider value={scope}>
      {thread.kind === "command" ? (
        // A finished terminal command takes the board's own command card, scoped to its project: its
        // pty, its Restart and its Mark as done all belong to the card's project, not the page's.
        <div data-xq-card={key} data-queue-leaving={leaving.isLeaving(key)} data-queue-ghost={ghost === undefined ? undefined : true} data-queue-concealed={concealed || undefined} inert={concealed} className="frizz-card-slot min-w-0">
          <div className="frizz-card-clip min-h-0 min-w-0">
            <div className="frizz-card-body min-w-0">
              <ThreadProjectScope projectId={project.id} projectDir={project.projectDir}>
                <CommandQueueCard
                  thread={thread}
                  leaving={leaving.isLeaving(key)}
                  onResolve={leaving.leave(key)}
                  onUnresolve={leaving.restore(key)}
                  onOpen={() => openInPlace(project, thread.id)}
                  lead={<ProjectChip project={project} />}
                />
              </ThreadProjectScope>
            </div>
          </div>
        </div>
      ) : (
        <AllQueuesCard
          project={project}
          thread={thread}
          leaving={leaving.isLeaving(key)}
          onLeave={leaving.leave(key)}
          onReturn={leaving.restore(key)}
          chip={<ProjectChip project={project} />}
          ghost={ghost}
          concealed={concealed}
        />
      )}
    </MarkdownScopeContext.Provider>
  )
}

/**
 * Inbox zero — a project view's own empty queue, said of every project, admitting the ones this server
 * has not opened, whose queues it cannot see.
 */
function EmptyQueues({ unopened }: { unopened: number }) {
  return (
    <div data-xq-empty className="flex flex-col items-center gap-2 pt-2">
      <Inbox size={40} strokeWidth={1.25} className="text-muted-30" />
      <div className="text-[13px] text-muted-80">
        {unopened > 0 ? "No threads awaiting human input in any open project" : "No threads awaiting human input"}
      </div>
    </div>
  )
}

// ---- Behaviour ---------------------------------------------------------------------------------------

interface LeavingCards {
  isLeaving: (key: string) => boolean
  hidden: (key: string) => boolean
  leave: (key: string) => () => void
  restore: (key: string) => () => void
}

/**
 * The optimistic exit every action on a card shares: the card fades the moment the operator commits
 * (answer, reply, snooze, done), is gone once the fade ends, and stays gone until the server's next read
 * agrees — or comes back, if REAPPEAR_MS pass and the thread is still in its queue.
 *
 * Keyed by `threadKey` (project + slug), never by slug: this page holds several projects' threads, and
 * a slug is unique only within one.
 */
function useLeavingCards(projects: QueuesProject[]): LeavingCards {
  const [since, setSince] = useState<ReadonlyMap<string, number>>(() => new Map())
  const [, tick] = useState(0)
  const callbacks = useRef(new Map<string, { leave: () => void; restore: () => void }>())

  // A card whose thread has left its queue on the server needs no guard any more.
  const stillQueued = useMemo(() => new Set(projects.flatMap((p) => p.queued.map((t) => threadKey(p.id, t.id)))), [projects])
  useEffect(() => {
    setSince((prev) => {
      let changed = false
      const next = new Map(prev)
      for (const key of prev.keys()) if (!stillQueued.has(key)) { next.delete(key); changed = true }
      return changed ? next : prev
    })
  }, [stillQueued])

  const now = Date.now()
  const handles = (key: string) => {
    let entry = callbacks.current.get(key)
    if (!entry) {
      entry = {
        leave: () => {
          setSince((prev) => new Map(prev).set(key, Date.now()))
          // Re-render at the end of the fade (to unmount) and at the reappear deadline (to restore).
          window.setTimeout(() => tick((n) => n + 1), EXIT_MS + 20)
          window.setTimeout(() => tick((n) => n + 1), REAPPEAR_MS + 20)
        },
        restore: () =>
          setSince((prev) => {
            if (!prev.has(key)) return prev
            const next = new Map(prev)
            next.delete(key)
            return next
          }),
      }
      callbacks.current.set(key, entry)
    }
    return entry
  }
  const age = (key: string) => {
    const at = since.get(key)
    return at === undefined ? undefined : now - at
  }
  return {
    isLeaving: (key) => {
      const elapsed = age(key)
      return elapsed !== undefined && elapsed < REAPPEAR_MS
    },
    hidden: (key) => {
      const elapsed = age(key)
      return elapsed !== undefined && elapsed >= EXIT_MS && elapsed < REAPPEAR_MS
    },
    leave: (key) => handles(key).leave,
    restore: (key) => handles(key).restore,
  }
}

/** Below the page's stacking point (`max-[800px]`, the board's own), where the columns stack. */
const STACKED_QUERY = "(max-width: 800px)"
function useStacked(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia?.(STACKED_QUERY)
      media?.addEventListener("change", onChange)
      return () => media?.removeEventListener("change", onChange)
    },
    () => Boolean(window.matchMedia?.(STACKED_QUERY).matches),
    () => false,
  )
}

/**
 * A queue row's click: bring its card to the top of the window and ring it — the board's own
 * scroll-to-card (store.ts scrollToQueueCard), for a page whose cards are keyed by project. Returns
 * the scroll offset it landed on (null when the card is gone), which the keyboard's cursor holds on to.
 */
function useScrollToCard(): (key: string) => number | null {
  return useCallback((key: string) => {
    const slot = document.querySelector<HTMLElement>(`[data-xq-card="${CSS.escape(key)}"]`)
    if (!slot) return null
    // Read again when the glide ends: a card that arrived or left above it meanwhile moved it.
    const top = glideTo(() => slot.getBoundingClientRect().top + window.scrollY - QUEUE_CARD_VIEWPORT_TOP)
    const root = slot.querySelector<HTMLElement>("[data-xq-card-root]")
    if (!root) return top
    root.removeAttribute("data-queue-flash")
    // Re-arm on the next frame so a second click on the same row replays the ring.
    requestAnimationFrame(() => {
      root.setAttribute("data-queue-flash", "")
      window.setTimeout(() => root.removeAttribute("data-queue-flash"), 1100)
    })
    return top
  }, [])
}

/**
 * `j` / `k` and the card commands on this page (lib/keyboardRuntime.ts): the card being read is the one
 * the rail marks, and a key lands on a card exactly as a rail row does. The landing is SMOOTH here, so
 * for the length of the glide — and for as long as the page then stays where it put it — the target is
 * held as the card being read; otherwise a quick `j j` would step twice from the card the glide was
 * leaving and land on the same card again.
 */
function useQueueKeys(activeKey: string | null, scrollToCard: (key: string) => number | null): void {
  const reading = useRef(activeKey)
  reading.current = activeKey
  const landing = useRef<{ key: string; y: number; until: number } | null>(null)
  useEffect(() => registerQueueCursor({
    // Not a ghost (lib/stableQueue.ts): its thread is back at work, so it is no card a key should land on.
    keys: () => [...document.querySelectorAll<HTMLElement>('[data-xq-card][data-queue-leaving="false"]:not([data-queue-ghost]):not([data-queue-concealed])')]
      .map((slot) => slot.dataset.xqCard ?? "")
      .filter(Boolean),
    current: () => {
      const held = landing.current
      // A held card that has since been finished or snoozed is not being read any more.
      if (held && document.querySelector(`[data-xq-card="${CSS.escape(held.key)}"][data-queue-leaving="false"]`)) {
        const reachable = Math.min(held.y, Math.max(0, document.documentElement.scrollHeight - window.innerHeight))
        if (performance.now() < held.until || Math.abs(window.scrollY - reachable) <= 2) return held.key
      }
      landing.current = null
      return reading.current
    },
    root: (key) => {
      const slot = document.querySelector<HTMLElement>(`[data-xq-card="${CSS.escape(key)}"]`)
      return slot?.querySelector<HTMLElement>("[data-xq-card-root], [data-queue-card-root]") ?? slot
    },
    go: (key) => {
      const y = scrollToCard(key)
      if (y !== null) landing.current = { key, y, until: performance.now() + 700 }
    },
  }), [scrollToCard])
}

/**
 * Which card is being read — the one crossing the reading line a third of the way down the window — so
 * its row in the rail wears the board's scroll marker.
 */
function useScrollspy(cards: readonly { key: string }[]): string | null {
  const [active, setActive] = useState<string | null>(null)
  const signature = cards.map((card) => card.key).join(",")
  useEffect(() => {
    let frame = 0
    const sync = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const line = window.innerHeight / 3
        let found: string | null = null
        for (const slot of document.querySelectorAll<HTMLElement>("[data-xq-card]")) {
          const { top, bottom } = slot.getBoundingClientRect()
          if (top <= line && bottom >= line) { found = slot.dataset.xqCard ?? null; break }
          if (top > line) { found ??= slot.dataset.xqCard ?? null; break }
          found = slot.dataset.xqCard ?? null
        }
        setActive(found)
      })
    }
    sync()
    window.addEventListener("scroll", sync, { passive: true })
    window.addEventListener("resize", sync)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener("scroll", sync)
      window.removeEventListener("resize", sync)
    }
  }, [signature])
  return active
}
