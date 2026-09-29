// THE PAGE — one project's list and queue, or every project's: `/`, showing its VIEW (lib/pageView.ts).
//
// FOCUSED ON A PROJECT — the default, `/?project=<slug>` — the list on the left is that project and the
// queue on the right is its cards, and the prompt box dispatches into it. ALL PROJECTS — `/?all`, opt-in
// from the READY header's switcher — is every project's list and ONE queue across all of them. The two are
// the same page drawn from the same parts, not two UIs: the list's bands (ProjectList.tsx) are identical in
// both, and focus mode is All projects with one project in it and the prompt box's picker gone.
//
// It is laid out as a project's own board was, one level up — the board was a floating sidebar beside a
// 720px queue, until 2026-09-28 when this page replaced it. The list on the left is the view's PROJECTS,
// each with its own queue rows and running rows beneath it, in the operator's own rail order
// (ProjectList.tsx). The queue on the right is a column of cards in the order each card entered it; showing
// All projects it is ONE queue across every project (maintainer 2026-09-28: "One queue across all
// projects"), each card wearing its project's chip (AllQueuesCard.tsx ProjectChip). It was one LANE per
// project, in rail order, until then, and a project listed above the one being read put its whole lane
// on top of the card the operator was reading the moment its first thread came to rest.
//
// NOTHING HERE LEAVES THE PAGE. There is no project page to leave for (routes.tsx), and fullscreen is a
// choice in a drawer's own menu (ThreadMenu.tsx), not a door on a card. The page is BOUND to one project
// — the page project: the prompt box at the top of the column dispatches into it, and a thread of it opens
// in the page's drawer stack, in place. Focused, that is the view's project; showing All projects, it is
// the box's own choice (the PICK, chosen in its bottom strip). Opening a thread of ANOTHER project moves
// it to that project for as long as the drawer is open (`/all/<slug>/thread/<t>`, useOpenThreadInPlace),
// so every thread on the page is one click from its full transcript without leaving the page, and closing
// the drawer returns home to the view.
//
// THE DRILL-DOWN, three steps, each one click, none of them leaving:
//   1. the card — the handoff's opening lines, the questions, a reply box, Snooze and Mark as done;
//   2. "Show more" — the whole handoff, in place;
//   3. the card's title (or a rail row) — the thread's drawer, with its whole transcript and composer.
// (A card's ↗ and a project's "…" → Open board were doors to that project's board until 2026-09-28.)
//
// WHAT THE RAIL AND THE CARDS MUST NEVER DO is ask the page which project anything belongs to. The page
// project is only what the page is BOUND to, and they may show every project. Every read they make is either machine-wide
// (`projectsList`, `projectsQueues`) or carries its project explicitly, and every action goes through
// that project's own client (`projectRpc`). See AllQueuesCard.tsx for the card's half of the same rule.
// The prompt box and the drawers are the page project's, which is exactly what they should be.
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, ChevronDown, Inbox } from "lucide-react"
import { useLocation, useNavigate } from "react-router"
import { useSnapshot } from "valtio"
import type { BoardSnapshot, ProjectCard, ProjectQueue } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { isBusy, liveQueue, mergedQueue, overlayQueues, projectMarkdownScope, queuesProjects, threadKey, type QueueEntry, type QueuesProject } from "../lib/allQueues.ts"
import { innerPath, projectSlug } from "../lib/base-path.ts"
import { rememberCrossProjectFocus, stepPick } from "../lib/crossProject.ts"
import { ALL_PROJECTS, homeHref, projectViewHref, usePageView, viewHref, viewKey } from "../lib/pageView.ts"
import { draftKey, draftStore } from "../lib/drafts.ts"
import { QUEUE_CARD_VIEWPORT_TOP, slugsInThreadDrawers, store } from "../store.ts"
import { useBoard } from "../hooks.ts"
import { prefs } from "../lib/prefs.ts"
import { PROMPT_CONTROL_TYPOGRAPHY_CLASS } from "../lib/promptControlTypography.ts"
import { MarkdownScopeContext } from "../lib/useMarkdown.ts"
import { GHOST_LABEL, stableQueue, type QueueSlot } from "../lib/stableQueue.ts"
import { actedOnHere } from "../lib/humanActs.ts"
import { useSteeredAt } from "../lib/steering.ts"
import { glideTo, useViewportLock } from "../lib/viewportLock.ts"
import { registerQueueCursor, releaseAutoOpened } from "../lib/keyboardRuntime.ts"
import { PROJECT_STEP_CHORDS, detectPlatform, formatChord, parseChord } from "../lib/keybindings.ts"
import { AllQueuesCard, ProjectChip, ProjectMark, useOpenThreadInPlace } from "./AllQueuesCard.tsx"
import { CommandQueueCard } from "./CommandQueueCard.tsx"
import { ProjectSquare } from "./ProjectRail.tsx"
import { SIDEBAR_COLUMN_CLASS } from "./Sidebar.tsx"
import { BandLabel } from "./BandLabel.tsx"
import { homeOf, shortPath, useAddProject } from "./ProjectActions.tsx"
import { StatusRow } from "./StatusRow.tsx"
import { ThreadConnector } from "./ThreadConnector.tsx"
import { DispatchForm, type DispatchDirs } from "./NewThreadModal.tsx"
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "./ui/Menu.tsx"
import { ProjectSwitcher, type SwitcherProject } from "./ProjectSwitcher.tsx"
import { AddProjectRow, ProjectList } from "./ProjectList.tsx"
import { ThreadProjectScope } from "../api/threadApi.tsx"

/** How often the page re-reads every project. The rail's badges poll at 5s; this is the page the
 *  operator is looking AT, so it runs a little faster — the read is the servers' cached snapshots. */
const POLL_MS = 3_000
/** The card's exit fade (styles.css `.frizz-card-slot`, which must stay in step with it). */
const EXIT_MS = 200
/**
 * How long an acted-on card stays gone while the server catches up. Past this, a thread that is STILL
 * queued comes back — the action evidently did not take — rather than staying hidden on the strength of
 * a click.
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
  const focusProject = projects.find((project) => project.slug === focus)
  // THE VIEW (lib/pageView.ts): one project, or every project. Focused, the list and the queue are that
  // project's alone and the prompt box is its; showing All projects, they are every project's.
  const view = usePageView()
  const viewed = view.kind === "project" ? projects.find((project) => project.slug === view.slug) : undefined
  const focused = view.kind === "project"
  const navigate = useNavigate()
  // The directories the prompt box is keyed by — and so the ones a choice of project carries its draft
  // OUT of, which the store's board cannot say while a quick run of ⌥↓ is ahead of the feed.
  const dirs = composerDirs(focus, board, focusProject)
  const pickProject = usePickProject()
  // Set by a choice of project — in the picker, or ⌥↑/⌥↓ in the box — so the prompt box it just re-aimed
  // takes the keyboard when it lands, with the caret where it was in the box it replaced.
  const [focusComposerFor, setFocusComposerFor] = useState<{ slug: string; caret?: Caret } | null>(null)
  const clearFocusComposerFor = useCallback(() => setFocusComposerFor(null), [])
  // ⌥↓ / ⌥↑ IN THE BOX — the next or previous project (lib/crossProject.ts stepPick), without leaving the
  // box: the draft goes with it as it does with a pick, and the caret stays put. Heard on the column head,
  // below which both of the box's tabs sit; anywhere else, and with nowhere else to go, the key is the
  // browser's.
  const onColumnKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const box = event.target
    const step = projectStep(event)
    if (!step || !(box instanceof HTMLTextAreaElement) || !box.matches(NEW_THREAD_BOXES)) return
    const next = stepPick(pickOrder(projects), focus, step)
    if (!next) return
    event.preventDefault()
    setFocusComposerFor({
      slug: next.slug,
      caret: { value: box.value, start: box.selectionStart ?? box.value.length, end: box.selectionEnd ?? box.value.length, direction: box.selectionDirection ?? "none" },
    })
    // Focused, the box's project IS the page's, so stepping it moves the page: the next project, with
    // what was typed carried along as a pick carries it.
    if (focused) {
      carryDraft(draftKey.dispatch, dirs?.projectDir, next.projectDir)
      carryDraft(draftKey.command, dirs?.projectDir, next.projectDir)
      navigate(projectViewHref(next.slug))
    } else pickProject(next, dirs?.projectDir)
  }


  const leaving = useLeavingCards(projects)
  // A thread whose drawer is open is read THERE, so its card goes INERT — a second live copy of the same
  // questions and reply box under the sheet would take keys and clicks meant for the drawer (store.ts
  // slugsInThreadDrawers). Drawers belong to the page project, so only the focus's cards can be. It
  // STAYS IN THE QUEUE: drawn where it was, and counted in READY and the filter, because opening a
  // thread to read it is not taking it off the queue (maintainer 2026-09-29: "it shouldn't move it out
  // of the queue though it should be displayed on below and non interactable and ready should still
  // include it"). It was hidden and uncounted until then.
  const focusId = focusProject?.id
  const inDrawer = new Set(focusId === undefined ? [] : [...slugsInThreadDrawers(snap.drawers)].map((slug) => threadKey(focusId, slug)))
  const hidden = (key: string) => leaving.hidden(key)
  // Registered projects this server has not opened (still being opened after a boot, served by another
  // Frizz, or failed to open): their queues are unknown, so "nothing in any queue" would be a claim.
  const unopened = projects.filter((project) => !project.open && !project.stale).length
  // What the view shows, in the list and the queue alike: its one project, or every project. A view
  // naming a project this machine does not list is the route's to correct (routes.tsx), so for the moment
  // before it does, the page shows nothing rather than every project.
  const shown = focused ? (viewed ? [viewed] : []) : projects
  const [, repaint] = useState(0)
  // THE VIEWPORT LOCK (lib/viewportLock.ts), and the one thing it asks back: a render once the page is
  // still, when a ghost has scrolled off screen (it can go now that nobody sees it go) or the cards on
  // screen have changed (the ones held back for them can take their places).
  const lock = useViewportLock("[data-xq-card]", xqCardKey, useCallback(() => repaint((n) => n + 1), []))
  const steeredAt = useSteeredAt()
  // The ONE queue in lib/stableQueue.ts's STABLE order: the queue's own order off screen; on screen
  // exactly as last drawn (maintainer 2026-09-28: "it needs to be guaranteed that cards that I'm
  // currently viewing on the screen don't move in their position"). A card whose thread left the queue
  // by any hand but the human's in THIS tab (lib/humanActs.ts) — its agent woke itself, it was answered
  // from the phone, its project closed — is held there as a ghost; one the human put away from here —
  // finished, replied to, snoozed — leaves the ordinary way, held only while it fades. Re-sorting or
  // re-filtering is the human choosing a different queue, so it starts over from the queue's own order.
  const ordered = mergedQueue(shown, direction).filter(({ project, thread }) => !leaving.hidden(threadKey(project.id, thread.id)))
  const prevSlots = useRef<QueueSlot<QueueEntry>[]>([])
  const orderedAs = useRef(`${direction}|${viewKey(view)}`)
  if (orderedAs.current !== `${direction}|${viewKey(view)}`) {
    orderedAs.current = `${direction}|${viewKey(view)}`
    prevSlots.current = []
  }
  const mayGhost = (key: string): boolean => {
    if (leaving.isLeaving(key)) return false
    const was = prevSlots.current.find((slot) => slot.key === key)?.item
    return was !== undefined && steeredAt[was.thread.id] === undefined && !actedOnHere(was.thread.id)
  }
  const queue = stableQueue({
    prev: prevSlots.current,
    target: ordered,
    keyOf: entryKey,
    onScreen: lock.onScreen.current,
    mayGhost,
    keep: new Set(prevSlots.current.map((slot) => slot.key).filter((key) => leaving.isLeaving(key) && !leaving.hidden(key))),
  })
  prevSlots.current = queue
  // Counted from what the page SHOWS: a card the operator just finished is gone from the count at once,
  // and a header still counting it read "1 in the queue" over an empty page until the next poll. A ghost
  // is not waiting on anyone. A card whose drawer is open still is, and still counts.
  const ready = queue.filter((slot) => !slot.ghost && !leaving.isLeaving(slot.key)).length
  const scrollToCard = useScrollToCard()
  const activeKey = useQueueKeys(useScrollspy(queue), scrollToCard)
  const loading = (cards.isPending || queues.isPending) && !queues.data
  // Below the page's stacking point the columns are one above the other, so the list follows the queue
  // rather than sitting between the prompt box and the queue it indexes.
  const stacked = useStacked()
  const home = homeOf(cards.data)
  // The list drops a row only with a card being FINISHED. A thread open in a drawer keeps its row, marked
  // open: the card steps aside because the drawer is the same thread, but the list is where the reader
  // finds their place, and a row that vanished when clicked left them nothing to find. Focused, it is the
  // one project, and adding another is the switcher's (its last item) rather than a row of this list.
  const list = (
    <>
      <ProjectList projects={shown} home={home} activeKey={activeKey} hidden={leaving.hidden} onQueuedRow={scrollToCard} />
      {!focused && <AddProjectRow />}
    </>
  )

  return (
    <div className="flex min-h-screen justify-center gap-[clamp(28px,3.4vw,52px)] bg-bg px-5 text-sm text-fg max-[800px]:flex-col max-[800px]:justify-start max-[800px]:gap-0 max-[800px]:px-3">
      {/* TOP-anchored, where the project board centred its column: a click here changes the list's height (narrowing
          folds every other project to one line), and a centred column moved the prompt box and the row just
          clicked out from under the pointer — by 110-200px with five projects. 48px sets the status row's middle
          level with the READY header's across the gutter (64 vs 59.85px at 52px). */}
      <aside aria-label="Projects" className={`${SIDEBAR_COLUMN_CLASS} !justify-start pt-[48px] max-[800px]:!pt-5`}>
        <div className="flex max-h-[calc(100vh-68px)] min-h-0 min-w-0 w-full flex-col max-[800px]:max-h-none">
          {/* The column head: the status row, and the prompt box under it — a new thread without leaving.
              Focused, it starts in the view's project; showing All projects, in the project chosen in the
              box's own bottom strip, beside the model. */}
          <div className="mb-5 shrink-0 px-0.5" onKeyDown={onColumnKeyDown}>
            <StatusRow />
            <FocusedComposer
              focus={focus}
              project={focusProject}
              dirs={dirs}
              autoFocus={focusComposerFor !== null && focusComposerFor.slug === focus}
              caret={focusComposerFor?.caret}
              onFocused={clearFocusComposerFor}
              target={
                focused ? undefined : (
                  <ProjectPicker
                    projects={projects}
                    focus={focus}
                    onPick={(project) => {
                      setFocusComposerFor({ slug: project.slug })
                      pickProject(project, dirs?.projectDir)
                    }}
                  />
                )
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
        aria-label="Queue"
        className="flex min-h-screen w-[720px] max-w-[62vw] min-w-0 flex-col py-5 max-[800px]:min-h-0 max-[800px]:w-full max-[800px]:max-w-none"
      >
        {loading ? (
          <div className="flex flex-1 items-center justify-center">
            <span className="block h-5 w-5 animate-spin rounded-full border-2 border-muted/50 border-t-transparent" />
          </div>
        ) : queues.error && !queues.data ? (
          <p className="my-auto text-center text-[13px] text-muted">Could not read the queues: {String(queues.error)}</p>
        ) : (
          <div className="flex w-full min-w-0 flex-col py-8 max-[800px]:pt-2">
            {/* THE INBOX, NAMED — every card below is a Ready thread — and at its right end the one control
                that says what the page shows: which project, or All projects. Always drawn, empty queue or
                not, since it is also the way to every other project. `pl-[21px]` stands the glyph over the
                card titles, and `pr-[21px]` stands the switcher over the cards' own right-hand controls. */}
            <div data-inbox-header className="mb-3 flex min-w-0 items-center gap-3 pl-[21px] pr-[21px]">
              <h2 className="flex shrink-0">
                <BandLabel band="ready" count={ready} />
              </h2>
              <div className="ml-auto flex min-w-0 text-[12px]">
                <Switcher projects={projects} hidden={hidden} current={viewed} />
              </div>
            </div>
            {queue.length > 0 ? (
              queue.map((slot, index) => (
                <Fragment key={slot.key}>
                  <QueueCardOf entry={slot.item} ghost={slot.ghost ? ghostLabel(projects, slot.item) : undefined} concealed={inDrawer.has(slot.key)} leaving={leaving} chip={!focused} />
                  {/* The rule between two cards: a sibling that FOLLOWS its card, so
                      styles.css fades it with the card when that one leaves. */}
                  {index < queue.length - 1 && <hr className="my-10 border-0 border-t border-border/60" />}
                </Fragment>
              ))
            ) : focused ? (
              <p data-xq-focus-empty className="mt-16 text-center text-[13px] text-muted">
                Nothing in {viewed?.name ?? "this project"} is waiting on you.
              </p>
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
      {!stacked && <ThreadConnector activeKey={activeKey} />}
    </div>
  )
}

/**
 * The READY header's project switcher (ProjectSwitcher.tsx): the project the page is focused on, or All
 * projects. Choosing is a navigation to that view (lib/pageView.ts), so Back returns to the one before.
 * Leaving a project for All projects carries it over as the prompt box's pick, so the box there starts
 * where the operator just was.
 */
function Switcher({ projects, hidden, current }: { projects: QueuesProject[]; hidden: (key: string) => boolean; current: QueuesProject | undefined }) {
  const navigate = useNavigate()
  const add = useAddProject()
  // The list's own order (ProjectList): busy projects first, then the quiet ones; Home last, on its own.
  const listed = projects.filter((project) => !project.card?.home)
  const ordered = [...listed.filter(isBusy), ...listed.filter((project) => !isBusy(project))]
  const item = (project: QueuesProject): SwitcherProject => ({
    id: project.id,
    slug: project.slug,
    name: project.name,
    card: project.card ?? fallbackCard(project),
    ready: project.queued.filter((t) => !hidden(threadKey(project.id, t.id))).length,
    note: project.stale ? "Missing" : undefined,
  })
  const homeProject = projects.find((project) => project.card?.home)
  const items = ordered.map(item)
  const home = homeProject && item(homeProject)
  // A different set of cards is a different page to read, so it is read from its top.
  const go = (href: string) => {
    navigate(href)
    glideTo(() => 0)
  }
  return (
    <ProjectSwitcher
      projects={items}
      home={home}
      homeHint={homeProject?.card && shortPath(homeProject.card.path, homeProject.homeDir)}
      current={current && (current.card?.home ? home : items.find((entry) => entry.id === current.id))}
      onAll={() => {
        if (current) rememberCrossProjectFocus(current.id)
        go(viewHref(ALL_PROJECTS))
      }}
      onProject={(project) => go(projectViewHref(project.slug))}
      onAdd={add.start}
    />
  )
}

// ---- The column head --------------------------------------------------------------------------------

/**
 * WHICH PROJECT A NEW THREAD GOES TO, while the page shows All projects — the first pill in the prompt
 * box's bottom strip, beside the model (NewThreadModal.tsx DispatchForm `target`), drawn as that pill is: a
 * setting of the thread about to start, not a view. Choosing one makes it the PICK (lib/crossProject.ts),
 * which All projects is bound to and the box dispatches into — remembered, never in the address. ⌥↓ and ⌥↑
 * in the box step it down and up this menu (AllQueuesPage), which its tooltip says wherever there is
 * another to step to. Focused on a project there is no picker: the box starts in the page's project, and
 * ⌥↓/⌥↑ step the page itself.
 */
function ProjectPicker({ projects, focus, onPick }: { projects: QueuesProject[]; focus: string | undefined; onPick: (project: QueuesProject) => void }) {
  const current = projects.find((project) => project.slug === focus)
  const name = current?.name ?? focus ?? "a project"
  // A project whose directory is gone cannot take a thread; it stays on the rail, saying why.
  const choices = projects.filter((project) => !project.stale && !project.card?.home)
  const steps = stepPick(pickOrder(projects), focus, 1) !== undefined
  // The Home workspace, for the work that belongs to no project yet: last, under a rule, with the folder
  // it runs in, because "Home" alone does not say that its agents start outside every project. Last is
  // also where stepping from the box reaches it (pickOrder).
  const homeChoice = projects.find((project) => !project.stale && project.card?.home)
  const choice = (project: QueuesProject, hint?: string) => (
    <MenuItem key={project.id} value={project.slug} onSelect={() => onPick(project)} icon={<ProjectSquare project={project.card ?? fallbackCard(project)} size={14} />}>
      <span className={`min-w-0 flex-1 truncate ${project.slug === focus ? "text-fg" : ""}`}>{project.name}</span>
      {hint && <span className="min-w-0 shrink truncate font-mono text-[10.5px] text-muted-55">{hint}</span>}
      {/* Choosable — opening its board may be exactly what brings it up — but not a surprise. */}
      {!project.open && <span className="shrink-0 text-[10.5px] text-muted-55">Not open</span>}
      {project.slug === focus && <Check size={12} aria-label="Current" className="shrink-0 text-fg" />}
    </MenuItem>
  )
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          data-xq-project-picker
          title={steps ? `New threads start in ${name} (${PROJECT_STEP_KEYS})` : `New threads start in ${name}`}
          aria-label={`New threads start in ${name}. Choose a project`}
          // The model pill's own chrome and type (ProfileGridSelector's trigger), so the strip reads as one
          // row of settings for the next thread.
          className={`group inline-flex min-w-0 max-w-[min(14rem,45%)] cursor-pointer items-center gap-[5px] rounded-md border border-border/50 bg-transparent px-2 py-1 text-left text-muted outline-none transition-colors hover:border-border hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60 data-[state=open]:border-border data-[state=open]:bg-panel-2 ${PROMPT_CONTROL_TYPOGRAPHY_CLASS}`}
        >
          {/* Ink gaps (sans, scripts/ink-gaps.mjs): square→name 5.00px; name→chevron 6.00px against the model
              pill's own 6.12px, which `-ml-[3px]` buys back from the chevron's dead box. */}
          {current && <ProjectSquare project={current.card ?? fallbackCard(current)} size={12} />}
          <span data-xq-picker-name className="min-w-0 flex-1 truncate">{name}</span>
          <ChevronDown size={13} aria-hidden className="-ml-[3px] shrink-0 text-fg/65 transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </MenuTrigger>
      <MenuContent align="start">
        <div className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-medium text-muted-55">Start in</div>
        <div className="max-h-[min(60vh,420px)] overflow-y-auto">
          {choices.map((project) => choice(project))}
        </div>
        {homeChoice && (
          <>
            {choices.length > 0 && <MenuSeparator />}
            {/* Outside the scrolling list, so it never scrolls away — and inset by the scrollbar gutter that
                list reserves (styles.css `scrollbar-gutter: stable`), or its hint ended 7px right of the
                check marks above it. */}
            <div className="pr-[var(--sbw)]">
              {choice(homeChoice, homeChoice.card && shortPath(homeChoice.card.path, homeChoice.homeDir))}
            </div>
          </>
        )}
      </MenuContent>
    </Menu>
  )
}

/**
 * CHOOSE the project a new thread goes to while the page shows All projects, in the prompt box's picker
 * or with ⌥↑/⌥↓ in the box. Remembered as the pick (lib/crossProject.ts), which All projects is bound to.
 *
 * What was typed in the prompt box goes WITH the choice. The box is one box whose target just changed,
 * and the commonest reason to change it is noticing, mid-prompt, that it pointed at the wrong project —
 * a draft left filed under the old one looked like the text had been lost. It moves only into an empty
 * box, so a draft already waiting in the chosen project is never overwritten. `from` is the directory
 * the box's draft is filed under now (composerDirs): the store's board lags a quick run of choices, and
 * reading the source there stranded the draft in whichever project the run passed through last.
 */
function usePickProject(): (project: QueuesProject, from: string | undefined) => void {
  const navigate = useNavigate()
  return useCallback(
    (project: QueuesProject, from: string | undefined) => {
      carryDraft(draftKey.dispatch, from, project.projectDir)
      carryDraft(draftKey.command, from, project.projectDir)
      rememberCrossProjectFocus(project.id)
      // A drawer open on the page has it bound to the drawer's project, and the box follows the binding,
      // so aiming the box closes the drawers: home, where the binding is the pick.
      if (innerPath() !== "/") navigate(homeHref(), { replace: true })
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
 * The new-thread prompt box, bound to the focused project — the page project. It is the same
 * DispatchForm the new-thread modal draws, drafts, GitHub picker and agent settings included.
 *
 * Only once the box knows WHICH DIRECTORY is the focus's: its drafts are keyed by it, and without one the
 * form would file what was typed under a shared "unresolved" bucket (lib/drafts.ts), from which it jumped
 * to another box when the board landed. The focus's own board says, once it lands; before that, the poll
 * says for any project this server has open — the same snapshot's directory (router.ts projectsQueues) —
 * so a box re-aimed at an open project is that project's box AT ONCE. It waited for the feed until
 * 2026-09-28, which blanked the box on every choice of project: harmless once from the menu, but ⌥↓
 * steps through projects, and a box that blinked out on each press dropped whatever was typed in the gap.
 * The stand-in holds the box's place for the rest — a project the poll has not seen open — so the column
 * does not jump, and says so if the board never comes, which is what a project this server cannot open
 * looks like from here.
 */
function FocusedComposer({
  focus,
  project,
  dirs,
  target,
  autoFocus,
  caret,
  onFocused,
}: {
  focus: string | undefined
  project: QueuesProject | undefined
  /** composerDirs — undefined while neither the focus's board nor the poll can say. */
  dirs: DispatchDirs | undefined
  target: ReactNode
  autoFocus: boolean
  caret: Caret | undefined
  onFocused: () => void
}) {
  const ready = dirs !== undefined
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    setSlow(false)
    if (ready) return
    const timer = window.setTimeout(() => setSlow(true), COMPOSER_WAIT_MS)
    return () => window.clearTimeout(timer)
  }, [ready, focus])
  // A LAYOUT effect, so the caret is back before the next key lands: the new box took the keyboard as it
  // mounted (autoFocus, which runs before this parent's effects).
  useLayoutEffect(() => {
    if (!ready || !autoFocus) return
    const box = document.activeElement
    if (box instanceof HTMLTextAreaElement && box.matches(NEW_THREAD_BOXES)) placeCaret(box, caret)
    onFocused()
  }, [ready, autoFocus, caret, onFocused])
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
              {project && !project.open ? `${project.name} is not open on this server.` : `${project?.name ?? focus ?? "This project"} has not answered yet.`}
            </span>
          )}
        </div>
      </div>
    )
  }
  return <DispatchForm key={focus} autoFocus={autoFocus} target={target} dirs={dirs} />
}

/**
 * The picker's own order, which ⌥↓ and ⌥↑ in the box step through: every project in the list's order,
 * then Home, which the menu draws last under its own rule.
 */
function pickOrder(projects: QueuesProject[]): QueuesProject[] {
  return [...projects.filter((project) => !project.card?.home), ...projects.filter((project) => project.card?.home)]
}

/**
 * The directories the prompt box's drafts are keyed by: the focus's own board once it has landed, and
 * before that the poll's reading of the same snapshot (router.ts projectsQueues) for a project this
 * server has open. Undefined while neither knows, and the box waits (FocusedComposer).
 */
function composerDirs(focus: string | undefined, board: BoardSnapshot | null, project: QueuesProject | undefined): DispatchDirs | undefined {
  if (focus && board?.projectSlug === focus) return { projectDir: board.projectDir, homeDir: board.homeDir }
  if (project?.open && project.projectDir) return { projectDir: project.projectDir, homeDir: project.homeDir }
  return undefined
}

/** The new-thread box's two textareas — its Prompt tab and its Terminal tab. */
const NEW_THREAD_BOXES = '[data-surface="newComposer"], [data-surface="commandComposer"]'

const PROJECT_STEP_KEYS = [PROJECT_STEP_CHORDS.previous, PROJECT_STEP_CHORDS.next].map((chord) => formatChord(parseChord(chord)!, detectPlatform())).join("/")

/** ⌥↓ is a step down the picker, ⌥↑ one up (lib/keybindings.ts PROJECT_STEP_CHORDS); 0 for any other key. */
function projectStep(event: KeyboardEvent): 1 | -1 | 0 {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing || event.defaultPrevented) return 0
  return event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0
}

/** Where the caret sat in the box a choice of project replaced, and over which text. */
interface Caret {
  value: string
  start: number
  end: number
  direction: "forward" | "backward" | "none"
}

/**
 * The caret in a box just re-aimed at another project: where it was, when the text came along with it (a
 * draft moves only into an empty box — usePickProject), else after the text the new project's box holds.
 */
function placeCaret(box: HTMLTextAreaElement, caret: Caret | undefined): void {
  if (caret && caret.value === box.value) box.setSelectionRange(caret.start, caret.end, caret.direction)
  else box.setSelectionRange(box.value.length, box.value.length)
}

// ---- The queue (the workpane) -----------------------------------------------------------------------

/**
 * One card of the queue, whichever project it is from — showing All projects, wearing that project's chip
 * on its meta line, which focuses the page on that project.
 *
 * EVERYTHING INSIDE RENDERS AS ITS PROJECT. The markdown scope points a `#123` at the card's repo, a
 * relative path at its directory and a `/thread/<slug>` link at that thread on THIS page (opened in
 * place) — never at the page's focus, which is usually another project.
 */
function QueueCardOf({ entry, ghost, concealed, leaving, chip }: { entry: QueueEntry; ghost: string | undefined; concealed: boolean; leaving: LeavingCards; chip: boolean }) {
  const { project, thread } = entry
  // The card's project, chosen from its chip or mark: the page focused on it, read from its top.
  const navigate = useNavigate()
  const choose = useCallback((to: QueuesProject) => {
    navigate(projectViewHref(to.slug))
    glideTo(() => 0)
  }, [navigate])
  const openInPlace = useOpenThreadInPlace()
  const scope = useMemo(
    () => projectMarkdownScope(project),
    [project.id, project.githubRepo, project.slug, project.projectDir, project.homeDir],
  )
  const key = threadKey(project.id, thread.id)
  return (
    <MarkdownScopeContext.Provider value={scope}>
      {thread.kind === "command" ? (
        // A finished terminal command takes its own command card, scoped to its project: its
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
                  lead={chip ? <ProjectChip project={project} square={false} /> : undefined}
                  mark={chip ? <ProjectMark project={project} onChoose={choose} /> : undefined}
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
          chip={chip}
          onChoose={choose}
          ghost={ghost}
          concealed={concealed}
        />
      )}
    </MarkdownScopeContext.Provider>
  )
}

/**
 * Inbox zero, showing All projects — the queue empty in every project, admitting the ones this server has
 * not opened, whose queues it cannot see.
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

/** Below the page's stacking point (`max-[800px]`), where the columns stack. */
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
 * A queue row's click: bring its card to the top of the window and ring it, for a page whose cards are
 * keyed by project. (The project board had its own, store.ts scrollToQueueCard, until 2026-09-28.) Returns
 * the scroll offset it landed on (null when the card is gone), which the keyboard's cursor holds on to.
 */
function useScrollToCard(): (key: string) => number | null {
  return useCallback((key: string) => {
    // Before measuring: a card a key opened, and this row leaves, closes first, and the glide lands on
    // where the card is once it has.
    releaseAutoOpened(key)
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
 *
 * That card also wears an accent border (`data-queue-current`), for as long as it is the one a `d` or `s`
 * would act on — the flash alone faded after a second and left no sign of which card the next key would
 * finish. An open drawer takes the keys (currentThreadSurface), so the border steps off while one is.
 *
 * A CLICK in a card makes it the card being read, held like a key's landing for as long as the page stays
 * put: the scrollspy's line is a third of the way down, so the last card or two — which the page cannot
 * scroll that far — could otherwise never be picked at all. Returns the card being read, which the rail
 * and its connector mark, so they agree with the ring.
 */
function useQueueKeys(activeKey: string | null, scrollToCard: (key: string) => number | null): string | null {
  const reading = useRef(activeKey)
  reading.current = activeKey
  const landing = useRef<{ key: string; y: number; until: number } | null>(null)
  const current = useCallback(() => {
    const held = landing.current
    // A held card that has since been finished or snoozed is not being read any more.
    if (held && document.querySelector(`[data-xq-card="${CSS.escape(held.key)}"][data-queue-leaving="false"]`)) {
      const reachable = Math.min(held.y, Math.max(0, document.documentElement.scrollHeight - window.innerHeight))
      if (performance.now() < held.until || Math.abs(window.scrollY - reachable) <= 2) return held.key
    }
    landing.current = null
    return reading.current
  }, [])
  const root = useCallback((key: string) => {
    const slot = document.querySelector<HTMLElement>(`[data-xq-card="${CSS.escape(key)}"]`)
    return slot?.querySelector<HTMLElement>("[data-xq-card-root], [data-queue-card-root]") ?? slot
  }, [])
  const [ringed, setRinged] = useState<string | null>(null)
  useEffect(() => registerQueueCursor({
    // Not a ghost (lib/stableQueue.ts), whose thread is no longer waiting, nor a card whose drawer is open.
    keys: () => [...document.querySelectorAll<HTMLElement>('[data-xq-card][data-queue-leaving="false"]:not([data-queue-ghost]):not([data-queue-concealed])')]
      .map((slot) => slot.dataset.xqCard ?? "")
      .filter(Boolean),
    current,
    root,
    go: (key) => {
      const y = scrollToCard(key)
      if (y !== null) {
        landing.current = { key, y, until: performance.now() + 700 }
        setRinged(key)
      }
    },
  }), [scrollToCard, current, root])

  // Re-read on every render (a card leaving re-renders the page) and on scroll (which can end a hold);
  // an unchanged key is a bail-out, not a render.
  useEffect(() => setRinged(current()))
  useEffect(() => {
    let frame = 0
    const sync = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setRinged(current()))
    }
    window.addEventListener("scroll", sync, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener("scroll", sync)
    }
  }, [current])

  useEffect(() => {
    const pick = (event: PointerEvent) => {
      if (event.button !== 0 || !(event.target instanceof Element)) return
      const slot = event.target.closest<HTMLElement>(
        '[data-xq-card][data-queue-leaving="false"]:not([data-queue-ghost]):not([data-queue-concealed])',
      )
      const key = slot?.dataset.xqCard
      if (!key) return
      releaseAutoOpened(key)
      landing.current = { key, y: window.scrollY, until: 0 }
      setRinged(key)
    }
    document.addEventListener("pointerdown", pick)
    return () => document.removeEventListener("pointerdown", pick)
  }, [])

  // An ATTRIBUTE set imperatively, like the flash: the roots are two different card components, and React
  // never touches an attribute absent from its props.
  const drawerOpen = useSnapshot(store).drawers.some((drawer) => !drawer.closing)
  const target = drawerOpen ? null : ringed
  useEffect(() => {
    const el = target ? root(target) : null
    el?.setAttribute("data-queue-current", "")
    return () => el?.removeAttribute("data-queue-current")
  }, [target, root])
  return ringed
}

/**
 * Which card is being read — the one crossing the reading line a third of the way down the window — so
 * its row in the list wears the scroll marker (Sidebar.tsx ThreadRow `active`).
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

/** A card-shaped stand-in for a project the registry list has not caught up with, for its square. */
function fallbackCard(project: QueuesProject) {
  return { id: project.id, slug: project.slug, name: project.name, path: project.projectDir ?? "", lastOpenedAt: "", stale: false, iconStatus: "unknown" as const }
}
