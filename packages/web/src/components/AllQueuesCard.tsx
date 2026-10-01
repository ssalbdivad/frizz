// ONE QUEUE CARD ON THE CROSS-PROJECT PAGE — a thread of ANY project, in either of the page's views:
// focused on one project, or All projects, where the cards of every project share one queue.
//
// It wears the queue card a project's own board drew until 2026-09-28 (TodosView QueueCard): the same
// bordered, shadowed shell, the same header with the title and its rest time, the human's last message
// as their bubble, the handoff as prose with its ```done card (fenced or registered), the thread's registered questions, a reply box, and the lifecycle footer's
// Snooze and Mark as done. What it deliberately does NOT carry is the transcript — the tool calls, the
// earlier rounds, the sub-agent rows. That is the next level down, one click away IN PLACE — the title,
// and "Show earlier messages" at the card's top, open the thread's own drawer on this page
// (useOpenThreadInPlace) — and it is what makes a page of
// every project's queue readable at all. The ↗ into a project's view went on 2026-09-28 (maintainer: "too
// many places in the ui where it is easy to navigate to a ui which is not the primary home ui"); the ⤢
// into /full went with it and came back on 2026-09-29 (ExpandThreadLink), restoring Colin's card.
//
// THE CARD NEVER ASKS THE PAGE WHICH PROJECT IT IS. Everything that could — the RPC client, the query
// cache, the markdown's repo and paths, the lifecycle buttons, the question drafts — is handed the
// card's own project explicitly (see the provider stack at the bottom). The board's queue card could not
// be reused here for exactly that reason: it read its project from the address bar, the store and the
// page's socket, and on this page all three name the FOCUSED project, which is usually not the card's.
import { memo, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, ChevronRight, Hourglass, RotateCcw } from "lucide-react"
import { useLocation, useNavigate } from "react-router"
import { questionsOwed, type AccountBackend, type ThreadView } from "@frizz/shared"
import { projectApiBase, projectRpc } from "../api/rpc.ts"
import { ThreadProjectScope } from "../api/threadApi.tsx"
import { ThreadMenu, ThreadTerminalButton } from "./ThreadMenu.tsx"
import { displayTitle, offersRetry, queueLabelAt, queueLabelWord } from "../groups.ts"
import { useMentionCandidates, useOwnMention } from "../hooks/useMentionCandidates.ts"
import { answerProse, handoffParts, projectMarkdownScope, sameProjectAddress, squareCard, threadKey, type QueuesProject } from "../lib/allQueues.ts"
import { draftKey, draftStore, useDraftValues } from "../lib/drafts.ts"
import { buildMessageWithContext, type ComposerContextItem } from "../lib/composerContext.ts"
import { restoreContextItems, takeContextItems, useStagedContextSources, useStagedContextTokens } from "../lib/stagedContext.ts"
import { rememberFullscreenOrigin } from "../lib/fullscreenHandoff.ts"
import { openLocalPath } from "../lib/local-file-links.ts"
import { pageUnloading } from "../lib/pendingSends.ts"
import { deliverProjectFollowUp } from "../lib/projectFollowUp.ts"
import { STALLED_RETRY_MESSAGE } from "../lib/retrySession.ts"
import { parseAccountAlias } from "../lib/signIn.ts"
import { TRANSCRIPT_META_LABEL_CLASS, transcriptMetaChevronClass } from "../lib/transcriptMetaLabels.ts"
import { isPlainLeftClick } from "../lib/standaloneThreadRoute.ts"
import { useMarkdownHtml } from "../lib/useMarkdown.ts"
import { IN_PLACE_OPEN_STATE, openThread, showToast, store } from "../store.ts"
import { crossProjectHref, innerPath, projectSlug } from "../lib/base-path.ts"
import { QueueDismissContext, TerminalNetCard } from "./ChatView.tsx"
import { useCopyTerminalCommand } from "./ExternalTerminalCommand.tsx"
import { showsRegisteredDoneCard } from "../lib/registeredDone.ts"
import { ThreadStatusLine } from "./ThreadStatusLine.tsx"
import { Composer } from "./Composer.tsx"
import { InteractionStack } from "./InteractionCards.tsx"
import { AwaitingSubAgentsCard, SubAgentWaitSnoozeItems } from "./AwaitingSubAgentsCard.tsx"
import { drawsSubAgentWaitCard, showsSubAgentWait } from "../lib/subAgentWait.ts"
import { useThreadComposerControls } from "../hooks/useThreadComposerControls.tsx"
import { ExpandThreadLink } from "./ExpandThreadLink.tsx"
import { SpinoffButton, SpinoffOf } from "./Spinoff.tsx"
import { HEADER_ICON_CLASS } from "../lib/headerIcon.ts"
import { LastActive } from "./LastActive.tsx"
import { LazyThreadBox } from "./LazyThreadBox.tsx"
import { ProjectSquare } from "./ProjectSquare.tsx"
import { LinkedHtml } from "./LinkedHtml.tsx"
import { QuestionBlockCard } from "./QuestionBlockCard.tsx"
import { RegisteredAnsweringContext, RegisteredAnsweringProvider, RegisteredQuestionStack } from "./RegisteredQuestionCards.tsx"
import { RestedCard, showsRestedCard } from "./RestedCard.tsx"
import { LogoutConfirmModal, SignInModal } from "./SignInModal.tsx"
import { QuietTurnCard, showsQuietTurnCard } from "./QuietTurnCard.tsx"
import { QueueChildOps } from "./QueueChildOps.tsx"
import { SnoozeButton } from "./SnoozeButton.tsx"
import { StateButton } from "./ThreadLifecycleFooter.tsx"
import { cardProcesses, focusedProject, openProcessDrawer, TerminalPromptPane, ThreadProcessStrip } from "./ThreadTerminals.tsx"
import type { ThreadProcess } from "../lib/threadProcesses.ts"
import { ThreadCheckoutToken } from "./ThreadCheckoutToken.tsx"
import { Tooltip } from "./Tooltip.tsx"
import { BLOCK_RADIUS, BLOCK_RADIUS_INNER_BOTTOM, QUEUE_WRAP, TranscriptCard } from "./TranscriptCard.tsx"

/**
 * WHOSE CARD THIS IS, on its meta line — in All projects the page's one queue holds every project's
 * threads, and the lanes that used to say whose they were are gone (lib/allQueues.ts mergedQueue). A
 * focused view shows one project's cards, so it draws no chip (AllQueues.tsx passes `chip={!focused}`).
 * Given `onChoose` it is a button that focuses the page on the project — navigates to its
 * `/?project=<slug>` view (lib/pageView.ts projectViewHref), the same place the READY header's switcher
 * goes; it filtered the queue in place until focus mode retired the queue filter on 2026-09-29.
 * Without it, plain text, for a line that already sits inside a control (the command card's open button).
 * `square: false` drops its 12px square, for a card that already leads with the project's ProjectMark.
 */
export function ProjectChip({ project, onChoose, square = true }: { project: QueuesProject; onChoose?: (project: QueuesProject) => void; square?: boolean }) {
  const body = (
    <>
      {/* ON THE NAME'S CAP BAND: a filled square has no baseline of its own, so it sits ON the name's and is
          lowered by half its height less half a cap — computed by the browser, right in any font at any
          size (the prompt box's project picker places its square the same way). */}
      {square && (
        <span className="flex shrink-0 self-baseline translate-y-[calc(6px_-_0.5cap)]">
          <ProjectSquare project={squareCard(project)} size={12} />
        </span>
      )}
      <span className="min-w-0 truncate">{project.name}</span>
    </>
  )
  // Beside a mark the name is the card's second project signal, set a step above the grey time it leads.
  const className = `flex min-w-0 shrink items-baseline gap-1.5 ${square ? "text-fg/80" : "font-medium text-fg/90"}`
  if (!onChoose) return <span data-xq-chip={project.id} className={className}>{body}</span>
  return (
    <button
      type="button"
      title={`Show only ${project.name}`}
      data-xq-chip={project.id}
      onClick={() => onChoose(project)}
      className={`${className} cursor-pointer rounded-sm border-0 bg-transparent p-0 text-left underline-offset-2 outline-none transition-colors hover:text-fg hover:underline focus-visible:ring-1 focus-visible:ring-border-strong`}
    >
      {body}
    </button>
  )
}

/**
 * THE PROJECT'S LOGO, leading a card's header on a queue that holds several projects — its icon, or its
 * monogram tile, small (ProjectSquare.tsx). The 12px square on
 * the meta line said whose a card was only to someone reading that line; a column of cards is scanned
 * down its left edge, so that is where the mark sits, big enough to pick one project's cards out of a
 * page of them without reading a word (maintainer 2026-09-29: "a more visible indicator of the project
 * name/logo … so users can easily visually filter through"). Given `onChoose` it focuses the page on the
 * project, as the chip beside it does; it is out of the tab order because that chip is the same control.
 */
export function ProjectMark({ project, onChoose }: { project: QueuesProject; onChoose?: (project: QueuesProject) => void }) {
  const square = <ProjectSquare project={squareCard(project)} size={PROJECT_MARK_PX} />
  if (!onChoose) return <span data-xq-mark={project.id} aria-hidden className="flex shrink-0">{square}</span>
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-hidden
      title={`Show only ${project.name}`}
      data-xq-mark={project.id}
      onClick={() => onChoose(project)}
      className="flex shrink-0 cursor-pointer rounded-[30%] border-0 bg-transparent p-0 transition-opacity hover:opacity-80"
    >
      {square}
    </button>
  )
}

/** The mark's side: the header's two lines (a 15px title over the 11px meta line) are ~36px of type. */
const PROJECT_MARK_PX = 32

/** A thread opened IN PLACE on the cross-project page: the page focused on its project, its drawer open. */
export function crossProjectThreadHref(project: Pick<QueuesProject, "slug">, slug: string): string {
  return `${crossProjectHref(encodeURIComponent(project.slug))}/thread/${encodeURIComponent(slug)}`
}

/**
 * Open a thread of ANY project in place — the cross-project page's one verb for "show me this thread".
 *
 * A thread of the focused project whose board is already in the store opens the way its row in the
 * project list opens one (`openThread`: the drawer animates in and the store writes the URL). Any other thread moves
 * the focus there by URL, which rebinds the page project and opens the drawer once its board lands
 * (routes.tsx CrossProjectPage → store.resolveRoutedThread).
 */
export function useOpenThreadInPlace(): (project: Pick<QueuesProject, "slug">, slug: string) => void {
  const navigate = useNavigate()
  return useCallback(
    (project, slug) => {
      // The focus AS OF THE CLICK, read off the address bar — never the one this component last rendered
      // with. react-router renders a location change as a transition, and under load the page it leads to
      // took up to 1.8s to commit, so for that long the page on screen was the one BEFORE it, clickable,
      // its render-time focus naming the project of a drawer that had just closed. A click on that
      // project's card then took the store-first open below on a page already rebinding to the pick: the
      // address writer refused to name a board the page no longer owned, the rebind swept the drawer away,
      // and the click did nothing. The address has moved on the moment the router has, so it cannot lag.
      const focus = projectSlug()
      if (project.slug === focus && store.board?.projectSlug === focus) openThread(slug)
      else navigate(crossProjectThreadHref(project, slug), { state: IN_PLACE_OPEN_STATE })
    },
    [navigate],
  )
}

/** A thread of a queue card's project by slug, for a line that names another thread of it (SpinoffOf): the
 *  project's own open rows, then the page's board when the page is showing that project (a done thread is
 *  on the board and in no queue). Never another project's board — a same-named slug there is not this. */
function queueThread(project: QueuesProject, slug: string): ThreadView | undefined {
  return project.queued.find((t) => t.id === slug)
    ?? project.running.find((t) => t.id === slug)
    ?? project.snoozed.find((t) => t.id === slug)
    ?? (store.board?.projectSlug === project.slug ? store.board.threads.find((t) => t.id === slug) : undefined)
}

/** A follow-up into another project's thread (lib/projectFollowUp.ts, which the project list's Retry shares). */
function deliverFollowUp(project: QueuesProject, thread: ThreadView, message: string): Promise<void> {
  return deliverProjectFollowUp({ projectId: project.id, projectDir: project.projectDir, slug: thread.id, sessionId: thread.sessionId }, message)
}

const noop = () => {}

/** The collapsed body's height: enough for a verdict line and the paragraph under it, never a wall. */
const CLAMP_PX = 188

interface AllQueuesCardProps {
  project: QueuesProject
  thread: ThreadView
  leaving: boolean
  /**
   * Its thread left the queue while the card was on screen, and not by the human's hand in this tab
   * (lib/stableQueue.ts): the card holds its place as an empty gap of its own height, out of reach of
   * the pointer and the keyboard, until it is closed (AllQueues.tsx) or the thread rests again.
   */
  ghost?: boolean
  /** Said on the meta line in place of the time the card was ready, WITHOUT a ghost's dimming: a held
   *  card (`onHold`) whose worker is at work on the answer it sent. */
  status?: string
  /**
   * Its drawer is open, where it is read: the card stays drawn in its place in the queue, inert — out of
   * the tab order and out of reach of a click — so the drawer is the one live copy (AllQueues.tsx).
   */
  concealed?: boolean
  /** The card has been acted on — answered, replied to, snoozed or finished — so it fades out now. */
  onLeave: () => void
  /** The action failed after the card had already faded: put it back. */
  onReturn: () => void
  /** A reply, Retry or Mark as done went out: the card leaves, and stays gone while it is on the wire.
   *  `onLeave` when absent. */
  onSent?: () => void
  /** It landed, so the wait for its thread to leave the queue starts now (AllQueues useLeavingCards). */
  onLanded?: () => void
  /** A question on the card was answered and the worker went to work on it, while the card still asks
   *  more: keep it where it is, live, although its thread leaves the queue (AllQueues useLeavingCards). */
  onHold?: () => void
  /** Lead the meta line under the title with the card's project, on a queue that holds several
   *  (ProjectChip) — a flag and a stable chooser rather than the element, which would be a new object on
   *  every render of the queue and so re-render the card every time (sameCard). */
  chip?: boolean
  /** What choosing the chip does: focus the page on the card's project (its `/?project=<slug>` view). */
  onChoose?: (project: QueuesProject) => void
}

export const AllQueuesCard = memo(function AllQueuesCard({
  project,
  thread,
  leaving,
  onLeave,
  onReturn,
  onSent = onLeave,
  onLanded = noop,
  onHold,
  chip = false,
  onChoose,
  ghost,
  status,
  concealed = false,
}: AllQueuesCardProps) {
  const api = projectRpc(project.id)
  const key = threadKey(project.id, thread.id)
  const chipNode = chip ? <ProjectChip project={project} onChoose={onChoose} square={false} /> : undefined
  const openInPlace = useOpenThreadInPlace()
  // KEYED ON THE REST, so a thread that rests again fetches its new handoff, and one that has not moved
  // is read exactly once however often the page polls. The previous handoff stays on screen while the
  // next one loads rather than blanking the card.
  const handoff = useQuery({
    queryKey: ["ofProject", project.id, "handoff", thread.id, thread.lastAssistantAt ?? ""],
    queryFn: () => api.threadHandoff({ slug: thread.id }),
    staleTime: Infinity,
    placeholderData: (previous) => previous,
  })
  const text = handoff.data?.text
  const parts = useMemo(() => (text ? handoffParts(text, thread.questions) : null), [text, thread.questions])
  // The reply to the human's message when wakes rested after it (router handoffOf): its prose alone, since
  // its fences were superseded by the newest rest's — and none of it under a done, which says it all.
  const answer = handoff.data?.answer
  const registeredDone = showsRegisteredDoneCard(thread, text)
  const answered = useMemo(() => answerProse(answer, parts, registeredDone, thread.questions), [answer, parts, registeredDone, thread.questions])
  // Does the awaiting card list the children, or the ops column under the reply box (QueueChildOps)?
  const drawsSubAgentWait = drawsSubAgentWaitCard(thread, parts?.fences)
  // THIS CARD IS THE NEWEST HANDOFF, and every CURRENT question rides to the bottom of the newest handoff
  // (lib/questionAnchor). One the human typed past is set aside — it stays in the thread's history until
  // the worker `keep`s it — so it is not this handoff's ask.
  const owedQuestions = useMemo(() => questionsOwed(thread.questions), [thread.questions])
  const placeHref = crossProjectThreadHref(project, thread.id)
  const dismiss = useMemo(() => ({ dismiss: onLeave, cancel: onReturn, hold: onHold }), [onLeave, onReturn, onHold])
  const queryClient = useQueryClient()
  // The snooze toast's Undo: the card comes back, and the page re-reads the queues now rather than at
  // the next poll, which left the card missing for up to 3s after the click.
  const onUnsnoozed = () => {
    onReturn()
    void queryClient.invalidateQueries({ queryKey: ["projectsQueues"] })
  }
  const answeringScope = useMemo(() => ({ api, projectDir: project.projectDir, projectId: project.id }), [api, project.projectDir, project.id])

  // A terminal row on the card — in the strip, or the caption over a prompt's screen — opens the thread,
  // then that terminal's drawer over it when the thread's project is the one in focus (the drawer stack is
  // that project's); otherwise the thread's drawer carries it.
  const openProcess = (process: ThreadProcess) => {
    const here = focusedProject(project.slug)
    openInPlace(project, thread.id)
    if (here) openProcessDrawer(thread.id, process)
  }

  const openHere = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (!isPlainLeftClick(event)) return
    event.preventDefault()
    openInPlace(project, thread.id)
  }

  return (
    <div data-xq-card={key} data-queue-leaving={leaving} data-queue-ghost={ghost || undefined} aria-hidden={ghost || undefined} data-queue-concealed={concealed || undefined} inert={concealed || ghost} className="frizz-card-slot min-w-0">
      <div className="frizz-card-clip min-h-0 min-w-0">
        <article
          data-xq-card-root
          aria-label={displayTitle(thread)}
          className={`frizz-card-body flex min-w-0 max-w-full flex-col ${BLOCK_RADIUS} border border-border-strong bg-panel shadow-lg shadow-shadow-ink/25`}
        >
          <header className="flex items-center gap-3 rounded-t-xl border-b border-border/60 px-5 py-3.5">
            {chip && <ProjectMark project={project} onChoose={onChoose} />}
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-[15px] font-semibold leading-snug" title={displayTitle(thread)}>
                {/* The card's title is its drawer door, and `o` presses it (lib/keyboardRuntime.ts). Only a
                    queue card carries `open`: in a drawer or on /full the thread is already open. */}
                <a href={placeHref} onClick={openHere} data-command="open" className="rounded-sm outline-none hover:underline hover:underline-offset-2 focus-visible:ring-1 focus-visible:ring-focus-ink-60">
                  {displayTitle(thread)}
                </a>
              </h3>
              <div className="mt-0.5 flex min-w-0 items-baseline gap-1.5 text-[11px] leading-tight text-muted-75">
                {chipNode}
                {status !== undefined ? (
                  <>
                    {chip && <span aria-hidden>·</span>}
                    <span className="min-w-0 truncate">{status}</span>
                  </>
                ) : (
                  <LastActive
                    at={thread.lazyPrompt !== undefined ? thread.spawnedAt : queueLabelAt(thread)}
                    label={thread.lazyPrompt !== undefined ? "Added" : queueLabelWord(thread)}
                    fallbackAt={thread.spawnedAt}
                    lead={chip ? <span aria-hidden>·</span> : undefined}
                    className="min-w-0 truncate"
                  />
                )}
                {/* Where the agent is working, only when that is off the project root (a worktree, or another folder). */}
                <ThreadCheckoutToken checkout={thread.checkout} homeDir={project.homeDir} lead={<span aria-hidden>·</span>} />
                {/* A SPINOFF CHILD says whose, as its drawer header does — ahead of the status line, which
                    takes the rest of the row. Resolved, addressed and opened in the CARD's project: the
                    page's board names the focused one. */}
                <SpinoffOf
                  compact
                  thread={thread}
                  lead={<span aria-hidden>·</span>}
                  resolve={(slug) => queueThread(project, slug)}
                  href={(slug) => crossProjectThreadHref(project, slug)}
                  onOpen={(slug) => openInPlace(project, slug)}
                />
                {/* What the thread is doing NOW, beside the name that stays put (ThreadStatusLine). */}
                <ThreadStatusLine thread={thread} lead={<span aria-hidden>·</span>} />
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              {/* SPINOFF, on every card (Spinoff.tsx), leading the strip as the one verb that starts new
                  work. In the card's OWN project scope: the header sits outside the body's, and the
                  page's api names the focused project. */}
              <ThreadProjectScope projectId={project.id} projectDir={project.projectDir}>
                {/* The drawer header's strip, in its order (ChatView ThreadHeader): terminal, spinoff,
                    fullscreen, ⋯. The terminal carries `t` on the card as it does in the drawer. */}
                <ThreadTerminalButton slug={thread.id} />
                <SpinoffButton thread={thread} className={HEADER_ICON_CLASS} />
              </ThreadProjectScope>
              {/* THE FULLSCREEN DOOR (ExpandThreadLink), before Retry as on Colin's card (TodosView
                  QueueCard @ 7a20f425). Its address carries the CARD's project — the page's own would
                  name the focused project's thread of the same slug — and it owns `f` on this card.
                  The header's LAST mark is the ⋯ menu below, which takes the `-mr-2` trim: a glyph's ink
                  sits well inside a 14px box centred in a 28px square, so untrimmed the last mark drew
                  ~29px in from the card's right border against the project mark's 20.75px on the left
                  (the ⤢ measured 21.0px trimmed, 2026-09-29, ink-gaps.mjs dsf 4, sans). */}
              <ExpandThreadLink
                slug={thread.id}
                href={`${placeHref}/full`}
                command
                className={HEADER_ICON_CLASS}
              />
              {offersRetry(thread) && <RetryButton project={project} thread={thread} onSent={onSent} onLanded={onLanded} onFailed={onReturn} />}
              {/* The ⋯ menu, as the drawer's (ThreadMenu.tsx) minus Restart worker, which only sends to the
                  page's project. */}
              <ThreadProjectScope projectId={project.id} projectDir={project.projectDir}>
                <ThreadMenu thread={thread} restart={false} className={`${HEADER_ICON_CLASS} -mr-2`} />
              </ThreadProjectScope>
            </div>
          </header>

          {/* ONE answering state for the cards AND the reply box, so a reply sent with a pick staged
              carries the pick (ReplyBox) instead of replying past it. */}
          <QueueDismissContext.Provider value={dismiss}>
          <RegisteredAnsweringProvider thread={thread} scope={answeringScope}>
          <ProjectLinkScope project={project}>
            {/* A lazy thread has no conversation, handoff or process to show: its note is the box below. */}
            {thread.lazyPrompt === undefined && (
            <div className="flex min-w-0 flex-col gap-4 px-5 pt-5 pb-4">
              {/* EARLIER MESSAGES OPEN THE DRAWER, never the card. History drawn into the card grew it
                  inside the queue, and the queue is ONE page: whether a page loaded on a press or on a
                  scroll up, the card swelled between the reader and the card above it (tried and
                  reverted 2026-09-29; maintainer: "offer opening the sidebar as a way to see more to not
                  interfere with threads queue"). The drawer is the thread's own scroller, where reading
                  back loads as it goes and the queue under it does not move. */}
              <a
                href={placeHref}
                onClick={openHere}
                title="Open the thread to read back through it"
                className="self-center rounded-md border border-border px-2 py-0.5 text-[11px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-border-strong"
              >
                Show earlier messages
              </a>
              {handoff.data?.asked && <AskedBubble text={handoff.data.asked} />}
              {answered && (
                <ClampedBody resetKey={thread.lastAssistantAt ?? ""}>
                  <Prose md={answered} />
                </ClampedBody>
              )}
              {/* Only the PROSE clamps. The fence card under it is the handoff's ledger — what shipped, or
                  what it is waiting on — and the rested notice is its state; both are the glance. */}
              {parts ? (
                parts.prose && (
                  <ClampedBody resetKey={thread.lastAssistantAt ?? ""}>
                    <Prose md={parts.prose} />
                  </ClampedBody>
                )
              ) : !handoff.data && (thread.lastAssistant || handoff.isError) ? (
                // The server's own 200-character preview (`lastAssistant`), until the whole message lands: a card that shows
                // the gist at once beats one that is blank for a round trip. Only UNTIL it lands: a handoff
                // with no text is a worker that has not answered the human's last turn, and the preview is
                // then the reply to an earlier one.
                <p className="text-[13px] leading-5 text-muted-80">{thread.lastAssistant ?? "The handoff could not be read."}</p>
              ) : null}
              {parts?.questions.map((question, index) => (
                <QuestionBlockCard key={index} raw={question.raw} questionKind={question.questionKind} danger={question.danger} />
              ))}
              {/* A parent resting on its sub-agents states the batch in place of its fence (AwaitingSubAgentsCard). */}
              {parts?.fences.map((fence, index) => fence.kind === "awaiting" && drawsSubAgentWait
                ? <AwaitingSubAgentsCard key={index} project={project} thread={thread} body={fence.body} openThread={() => openInPlace(project, thread.id)} onSnoozed={onLeave} onUndone={onUnsnoozed} />
                : <FenceBody key={index} kind={fence.kind} body={fence.body} />)}
              {/* A DONE THE WORKER REGISTERED (`mcp__frizz__done`) rather than fenced — the sign-off the worker
                  contract now asks for first — is in no message, so the handoff text above carries no fence
                  for it and the card queued a finished thread with no Done card at all. The drawer draws it
                  from the thread (ChatView's "registered-done" rung); this is the same predicate, keyed on
                  the same handoff text, so a worker that fenced AND registered gets one card, the fenced one.
                  Held until the handoff is read, or a fenced done would draw here first and then swap. */}
              {(handoff.data || handoff.isError) && registeredDone && <FenceBody kind="done" body={thread.lastFence!.body} />}
              {/* THE GATE: a turn parked on a request — "Run a command?", a native question, an MCP form —
                  with its real buttons, under the prose that led to it. It is the whole reason such a card
                  is in the queue, and this card drew none of it until 2026-09-28: a thread held on a
                  permission prompt showed its last progress line and a reply box, and read as a
                  notification for nothing. Held until the handoff lands, for the reason the board's card held it: these
                  carry buttons, and the full handoff replacing the preview above would move them out from
                  under a cursor already on its way. Scoped to the card's project like every other control
                  here; the queue context lets a decision take the card out the way a reply does. */}
              {(handoff.data || handoff.isError) && (
                <ThreadProjectScope projectId={project.id} projectDir={project.projectDir}>
                  <QueueDismissContext.Provider value={dismiss}>
                    <InteractionStack thread={thread} />
                    <CardTerminalNet thread={thread} />
                  </QueueDismissContext.Provider>
                </ThreadProjectScope>
              )}
              {/* Not gated on the handoff: a STALL's last record is often a tool call with no prose at
                  all, and its notice is about the process, not the message (showsRestedCard). */}
              {showsRestedCard(thread, text) && <RestedCard thread={thread} />}
              {showsQuietTurnCard(thread) && <QuietTurnCard thread={thread} />}
              {/* A terminal of yours waiting at a prompt — what queued this card — as its live screen under its
                  own row, so the answer is typed right here and the row says which terminal is asking. The
                  strip below lists every other one. */}
              <ThreadProjectScope projectId={project.id} projectDir={project.projectDir}>
                <TerminalPromptPane thread={thread} onOpen={openProcess} />
              </ThreadProjectScope>
            </div>
            )}

            {/* Keyed on the rest: an answered card keeps its slot while the card holds for the worker's
                turn, and a NEW handoff — which says what became of it — starts the stack over. */}
            {owedQuestions.length > 0 && (
              <RegisteredQuestionStack key={handoff.data?.at ?? ""} thread={thread} questions={owedQuestions} keepAnswered className="shrink-0 px-5 pb-4 pt-0" />
            )}
          </ProjectLinkScope>

          <ThreadProjectScope projectId={project.id} projectDir={project.projectDir}>
            {/* A LAZY THREAD's box is its note, and sending it starts the agent (LazyThreadBox). */}
            {thread.lazyPrompt !== undefined
              ? <LazyThreadBox thread={thread} surface="queueComposer" className="shrink-0 px-5 pt-5 pb-3" />
              : <ReplyBox project={project} thread={thread} onSent={onSent} onLanded={onLanded} onFailed={onReturn} />}
            {/* EVERYTHING IT HAS RUNNING, in the drawer's one column (QueueChildOps): its sub-agents and
                Workflows as AGENT / FLOW rows — the awaiting card's to list while it is drawn — then every
                terminal on the thread, yours and the agent's, as the drawer's TERM strip (ThreadTerminals.tsx),
                on one label column. The strip owns every process row, so a shell is drawn once. A shell with
                no budget runs until someone stops it, so the card it rests on is where it must be seen.
                A TERM row opens the thread, then its terminal over it
                when the thread's project is the one in focus (the drawer stack is that project's). The strip
                is gated on the rows it will draw, so a card whose only shell has finished — or whose only
                terminal is the prompt shown above with its own row — draws no empty inset. */}
            <QueueChildOps
              project={project}
              thread={thread}
              api={api}
              agents={!drawsSubAgentWait}
              onOpenThread={() => openInPlace(project, thread.id)}
              after={cardProcesses(thread, Date.now()).length > 0 ? (
                <div data-queue-processes={thread.id} className="min-w-0">
                  <ThreadProcessStrip thread={thread} surface="card" onOpen={openProcess} />
                </div>
              ) : null}
            />
          </ThreadProjectScope>
          </RegisteredAnsweringProvider>
          </QueueDismissContext.Provider>

          <ThreadProjectScope projectId={project.id} projectDir={project.projectDir}>
            <footer className={`${BLOCK_RADIUS_INNER_BOTTOM} flex min-h-10 flex-wrap items-center justify-end gap-3 border-t border-border/70 bg-panel/95 px-3 py-2 text-[12px]`}>
              <SnoozeButton thread={thread} projectName={project.name} onSnoozed={onLeave} onUndone={onUnsnoozed} eventItems={showsSubAgentWait(thread) && <SubAgentWaitSnoozeItems thread={thread} onSnoozed={onLeave} onUndone={onUnsnoozed} />} />
              <StateButton thread={thread} onArchived={onSent} onDismissCancel={onReturn} onCompleted={onLanded} command />
            </footer>
          </ThreadProjectScope>
        </article>
      </div>
    </div>
  )
}, sameCard)

/**
 * The card's memo: its thread by identity (the poll and the board keep an unchanged thread's object), its
 * project by address (lib/allQueues.ts sameProjectAddress — the lists it is rebuilt around are not the
 * card's), everything else as React would. A card must read nothing from its project beyond what that
 * compares; widen it before reading more.
 */
function sameCard(a: AllQueuesCardProps, b: AllQueuesCardProps): boolean {
  return (
    a.thread === b.thread &&
    a.leaving === b.leaving &&
    a.onLeave === b.onLeave &&
    a.onSent === b.onSent &&
    a.onLanded === b.onLanded &&
    a.onReturn === b.onReturn &&
    a.onHold === b.onHold &&
    a.chip === b.chip &&
    a.onChoose === b.onChoose &&
    a.ghost === b.ghost &&
    a.status === b.status &&
    a.concealed === b.concealed &&
    sameProjectAddress(a.project, b.project)
  )
}

/**
 * The thread header's stall recovery (HeaderActions.tsx RetryButton): the same message through the same
 * follow-up, sent to the thread's own project. The thread goes back to work, so the card leaves.
 */
function RetryButton({ project, thread, onSent, onLanded, onFailed }: { project: QueuesProject; thread: ThreadView; onSent: () => void; onLanded: () => void; onFailed: () => void }) {
  const queryClient = useQueryClient()
  const retry = useMutation({
    mutationFn: () => deliverFollowUp(project, thread, STALLED_RETRY_MESSAGE),
    onMutate: onSent,
    onSuccess: () => {
      onLanded()
      showToast("Retrying…")
      void queryClient.invalidateQueries({ queryKey: ["projectsQueues"] })
    },
    onError: (error) => {
      onFailed()
      showToast(`Retry failed: ${(error instanceof Error ? error.message : "unknown error").slice(0, 80)}`)
    },
  })
  return (
    <Tooltip label="Retry — resume this session where it left off">
      <button
        type="button"
        onClick={() => retry.mutate()}
        disabled={retry.isPending || !thread.sessionId}
        aria-label="Retry exited session"
        onMouseDown={(event) => event.preventDefault()}
        // AN ICON in the header strip's chrome — the same mark as the drawer's Retry
        // (HeaderActions.tsx). It was a labelled accent pill until 2026-09-29, and one worded pill beside
        // the bare ⤢ read as a stray (maintainer: "having a retry button labeled with other non labeled
        // icons looks awful").
        className={HEADER_ICON_CLASS}
      >
        <RotateCcw size={14} strokeWidth={2} />
      </button>
    </Tooltip>
  )
}

/**
 * Markdown links inside this card, pointed at the card's project.
 *
 * Two delegated listeners on the document act on every rendered link (lib/local-file-links.ts,
 * lib/thread-links.ts), and both act on the PAGE's project: a file link opens through the page's `rpc`,
 * a `/thread/<slug>` link opens a drawer this page does not have. This intercepts both first, in the
 * capture phase, and sends them to the thread's own project — a file to the same viewers every link
 * uses, read or opened through that project, a thread link to that thread's drawer, opened in place.
 */
function ProjectLinkScope({ project, children }: { project: QueuesProject; children: ReactNode }) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const onClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const target = event.target instanceof Element ? event.target : null
    const file = target?.closest<HTMLElement>("[data-local-path]")
    const path = file?.dataset.localPath
    if (file && path) {
      event.preventDefault()
      event.stopPropagation()
      // The one router every file click takes (lib/local-file-links.ts) — the picture viewer, the reader,
      // or the desktop opener — scoped to THIS card's project: its gate reads the file and its opener
      // opens it, since a checkout outside home is inside that project's roots and no other's.
      openLocalPath(path, file, projectMarkdownScope(project))
      return
    }
    const anchor = target?.closest<HTMLAnchorElement>("a[href^='/']")
    const href = anchor?.getAttribute("href")
    if (!anchor || !href || href.startsWith("//") || !isPlainLeftClick(event)) return
    // The markdown scope already pointed every in-app link at this project on this page (`/all/<slug>/…`),
    // and a worker may have spelled one out itself for another project. Either way it is a same-app
    // navigation — done by the router rather than a document load — and a thread link opens the thread
    // in place, on this page. An address from before 2026-09-28 (`/project/<slug>/thread/…`) names no
    // project any more (base-path.ts isRetiredAppPath), so it is left to the browser, which lands it on
    // the page untranslated, like any other retired address.
    const linked = projectSlug(href)
    if (!linked) return
    event.preventDefault()
    event.stopPropagation()
    const inner = innerPath(href)
    // Keyed by the thread the link OPENS, which is not always this card's: a handoff can link another
    // thread's /full, and the way out of that page looks its origin up by its own slug.
    const full = inner.match(/^\/thread\/([^/?#]+)\/full\/?$/)
    if (full) rememberFullscreenOrigin(decodeURIComponent(full[1]!), pathname)
    navigate(inner.startsWith("/thread/") ? `${crossProjectHref(linked)}${inner}` : href)
  }
  return <div className="contents" onClickCapture={onClickCapture}>{children}</div>
}

/**
 * THE TERMINAL NET on the card: a frozen native ask, or the generic permission banner — the two states the
 * server queues a thread on (board.ts deriveNeedsYou) that journal nothing InteractionStack could draw. The
 * card showed only InteractionStack from 2026-09-28, so a session parked on a terminal-only prompt queued
 * with its last progress line and a reply box that cannot land, and never said why. The rungs are the
 * drawer's own (ChatView TerminalNetCard), and they stand down the same way when an answerable
 * interaction is on screen. Its copy reads the thread's command through the caller's ThreadProjectScope
 * (useCopyTerminalCommand → useThreadApi), never the page's `rpc`, which names the FOCUSED project.
 * PermPolicyDenialCard is deliberately absent: a denial already happened, queues nothing, and is one
 * click away in the drawer.
 */
function CardTerminalNet({ thread }: { thread: ThreadView }) {
  const copy = useCopyTerminalCommand(thread.id)
  return <TerminalNetCard thread={thread} onTerminal={() => copy()} />
}

/** The human's last message, as the transcript draws it — their own bubble — clipped to a few lines. */
function AskedBubble({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const [clamps, setClamps] = useState(false)
  const words = useRef<HTMLSpanElement>(null)
  // Only a message the clamp actually cut is a toggle; a short one is plain, selectable text.
  useLayoutEffect(() => {
    const el = words.current
    if (!el || open) return
    const measure = () => setClamps(el.scrollHeight > el.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [open, text])
  const toggle = () => setOpen((value) => !value)
  return (
    <div className="flex max-w-[85%] flex-col items-end gap-0.5 self-end">
      {/* A div with role=button, NOT a <button>: browsers refuse to start a text selection inside a
          <button>, so the human could not copy a word of their own message. The click is ignored while
          a selection is live, because a drag across the words ends in a click on this same node. */}
      <div
        {...(clamps || open ? {
          role: "button",
          tabIndex: 0,
          "aria-expanded": open,
          title: open ? "Show less" : "Show the whole message",
          onClick: () => {
            if (window.getSelection()?.toString()) return
            toggle()
          },
          onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => {
            if (e.key !== "Enter" && e.key !== " ") return
            e.preventDefault()
            toggle()
          },
        } : {})}
        className={`${BLOCK_RADIUS} rounded-br-sm bg-user-bubble px-3.5 py-2.5 text-left text-[13px] leading-5 whitespace-pre-wrap [overflow-wrap:anywhere] text-user-bubble-fg outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg${clamps || open ? " cursor-pointer" : ""}`}
      >
        {/* The clamp sits INSIDE the padding. On the bubble itself, its overflow clip ran to the padding
            edge, so the fourth line showed half its height in the bubble's bottom padding. */}
        <span ref={words} className={open ? "" : "line-clamp-3"}>{text}</span>
      </div>
    </div>
  )
}

function Prose({ md }: { md: string }) {
  const html = useMarkdownHtml(md)
  return <LinkedHtml className={`md-body ${QUEUE_WRAP}`} html={html} />
}

/** A signal fence, drawn as the transcript's fence card — presentation only; the verbs live in the footer. */
function FenceBody({ kind, body }: { kind: "done" | "awaiting"; body: string }) {
  const html = useMarkdownHtml(body)
  return (
    <TranscriptCard icon={kind === "done" ? Check : Hourglass} label={kind === "done" ? "Done" : "Awaiting"}>
      {html && <LinkedHtml className={`md-body ${QUEUE_WRAP}`} html={html} />}
    </TranscriptCard>
  )
}

/**
 * The glance, and the first step of the drill-down: a long handoff is clipped to its opening lines with
 * a fade, and "Show more" opens the rest in place. Short ones are never clipped and show no control.
 */
function ClampedBody({ resetKey, children }: { resetKey: string; children: ReactNode }) {
  const inner = useRef<HTMLDivElement>(null)
  const [overflows, setOverflows] = useState(false)
  const [open, setOpen] = useState(false)
  const [seenKey, setSeenKey] = useState(resetKey)
  // A NEW handoff starts clipped again: opening the last one is not a vote to open every one after it.
  if (seenKey !== resetKey) {
    setSeenKey(resetKey)
    setOpen(false)
  }
  useLayoutEffect(() => {
    const el = inner.current
    if (!el) return
    const measure = () => setOverflows(el.scrollHeight > CLAMP_PX + 24)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const clipped = overflows && !open
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div
        className="relative min-w-0 overflow-hidden"
        style={clipped ? { maxHeight: CLAMP_PX, maskImage: "linear-gradient(to bottom, black 62%, transparent)" } : undefined}
        // KEYBOARD FOCUS OPENS IT. The clipped half still holds links, and tabbing onto one scrolled this
        // overflow box to show it — an overflow:hidden box is still a scroll container — leaving the
        // collapsed card showing the middle of the message. A reader who tabbed in wants the rest.
        onFocus={(event) => {
          if (!clipped || !(event.target instanceof Element) || !event.target.matches(":focus-visible")) return
          event.currentTarget.scrollTop = 0
          setOpen(true)
        }}
      >
        <div ref={inner} className="flex min-w-0 flex-col gap-4">{children}</div>
      </div>
      {overflows && (
        // The transcript's disclosure row ("Ran 3 tool calls ›", ChatView.tsx): its label type, its hover, and
        // its measured chevron (transcriptMetaChevronClass carries the ink trims and the cap-band shift),
        // so this toggle and the transcript's read as one control.
        <button
          type="button"
          data-xq-show-more
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className={`${TRANSCRIPT_META_LABEL_CLASS} group flex items-baseline gap-1.5 self-start rounded outline-none transition-colors hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60`}
        >
          <span>{open ? "Show less" : "Show more"}</span>
          <ChevronRight aria-hidden="true" size={13} className={transcriptMetaChevronClass(open)} />
        </button>
      )}
    </div>
  )
}

/**
 * Reply to the agent, from here — the drawer's own prompt box (`Composer`: the same Enter keys, paste
 * and drop of attachments, auto-growth) with the drawer's model/effort and permission strip under it
 * (useThreadComposerControls, handed this card's thread and scoped to its project by the caller's
 * ThreadProjectScope), so a thread can be re-pointed mid-flight from here without opening its drawer.
 *
 * THE DRAFT IS THE DRAWER'S DRAFT. It is keyed exactly as that thread's composer keys it — its project's
 * directory, its slug, its session — so a reply half-typed here is waiting in the thread's drawer, and
 * the other way round. An attachment uploads to the THREAD's project (`attachBase`), not the page's,
 * which on this page is the focused project.
 */
function ReplyBox({ project, thread, onSent, onLanded, onFailed }: { project: QueuesProject; thread: ThreadView; onSent: () => void; onLanded: () => void; onFailed: () => void }) {
  const queryClient = useQueryClient()
  const key = draftKey.followUp(project.projectDir, thread.id, thread.sessionId)
  const text = useDraftValues([key]).get(key) ?? ""
  const [error, setError] = useState<string>()
  const controls = useThreadComposerControls(thread.id, thread)
  const [signInFor, setSignInFor] = useState<AccountBackend | null>(null)
  const [logoutFor, setLogoutFor] = useState<AccountBackend | null>(null)
  const answering = useContext(RegisteredAnsweringContext)
  // `@` mentions of this card's project's threads — offered only when the page's board IS that project.
  const mentions = useMentionCandidates(thread.id, project.slug)
  const ownMention = useOwnMention(thread.id, project.slug)
  // The drawer's chips, on the drawer's draft: a selection staged in the thread's drawer (⌘I, or sent from
  // an editor) is the same staging here, and rides this box's send the same way (lib/stagedContext.ts).
  const contextTokens = useStagedContextTokens(key, text)
  const contextSources = useStagedContextSources(key, project.projectDir)
  const send = useMutation({
    mutationFn: ({ outgoing }: { outgoing: string; typed: string; staged: ComposerContextItem[] }) => deliverFollowUp(project, thread, outgoing),
    onSuccess: () => {
      onLanded()
      void queryClient.invalidateQueries({ queryKey: ["projectsQueues"] })
    },
    onError: (cause, { typed, staged }) => {
      // A reload aborting the send: the next page replays it (lib/pendingSends.ts), so no rollback.
      if (pageUnloading()) return
      // The card faded on send; the message did not land, so bring it back with the text still in it —
      // unless something new was typed meanwhile, which is not ours to overwrite — and its chips with it.
      if (!draftStore.get(key)) draftStore.set(key, typed)
      restoreContextItems(key, staged)
      onFailed()
      const reason = cause instanceof Error ? cause.message : "The reply could not be sent."
      // A TOAST as well as the inline line: by the time a failure lands the card has usually finished its
      // exit, and the one that comes back is a fresh mount that never saw this error.
      showToast(`Reply failed: ${reason.slice(0, 80)}`)
      setError(reason)
    },
  })
  const submit = () => {
    const message = text.trim()
    if (!message) return
    // `/login` / `/logout` are frizz-owned account actions for this thread's backend, invoked here and
    // never delivered to the worker as a prompt — as the drawer's box does (ThreadComposerBox.tsx). The
    // board's queue card intercepted them too; this card did not, so with the board gone a `/login`
    // typed into a card went into the worker's stdin.
    const alias = parseAccountAlias(message)
    if (alias) {
      draftStore.set(key, "")
      if (thread.backend === "acp") {
        showToast("An ACP agent signs in through its own CLI — Frizz holds no account for it")
        return
      }
      const backend: AccountBackend = thread.backend === "codex" ? "codex" : "claude"
      if (alias === "login") setSignInFor(backend)
      else setLogoutFor(backend)
      return
    }
    if (!thread.sessionId || send.isPending) return
    setError(undefined)
    const deliver = () => {
      // Local truth first, then the network — the order every send on the board's card obeyed.
      const staged = takeContextItems(key)
      draftStore.set(key, "")
      onSent()
      send.mutate({ outgoing: buildMessageWithContext(message, staged, project.projectDir), typed: message, staged })
    }
    // Picked answers ride the reply rather than being replied past — ThreadComposerBox's send has the why.
    if (answering?.slug === thread.id && answering.staged > 0) {
      if (answering.sending) return
      answering.submit(deliver)
      return
    }
    deliver()
  }
  return (
    <div className="shrink-0 px-5 pb-3 pt-0">
      <Composer
        surface="queueComposer"
        contextTokens={contextTokens}
        contextSources={contextSources}
        value={text}
        onChange={(value) => draftStore.set(key, value)}
        onSubmit={submit}
        placeholder={answering?.staged ? "Add a note to your answers…" : questionsOwed(thread.questions).length > 0 ? "Or reply…" : "Reply to the agent…"}
        attachBase={projectApiBase(project.id)}
        mentionCandidates={mentions}
        ownMention={ownMention}
        busy={controls.busy}
        footer={controls.footer}
      />
      {controls.status}
      {error && <div role="alert" className="mt-1.5 break-words text-[11px] leading-snug text-danger-soft">{error}</div>}
      {signInFor && <SignInModal backend={signInFor} onClose={() => setSignInFor(null)} onAuthed={() => setSignInFor(null)} />}
      {logoutFor && <LogoutConfirmModal backend={logoutFor} onClose={() => setLogoutFor(null)} />}
    </div>
  )
}
