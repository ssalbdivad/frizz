// A QUEUE CARD'S TRANSCRIPT, IN PLACE — upstream's QueueCard body (TodosView @ 0a3b9139), on the fork's card.
//
// The card opens on the handoff (AllQueuesCard): the human's last turn, the reply, the newest rest. That
// stays its first view. "Show earlier messages" swaps it for THIS: the thread's own transcript from one step
// before the human's last turn, with upstream's folds — each run between that turn and the agent's rest
// behind "N tool calls · Click to expand", and every round in the middle of a long run of rests behind
// "N more rounds · Click to expand" (lib/queueCollapse.ts, restored verbatim) — and "Load earlier messages"
// above it to page further back. The drawer stays one click away on the title, and the header's collapse
// folds the whole card to its header.
//
// David reverted an earlier in-place history on 2026-09-29 (b3872adc) because any history in a card swelled
// it between the reader and the card above. What differs here, and why the plan (upstream-superset §3) asks
// for it anyway: the folds keep a long thread to its asks and its answers rather than every round; nothing
// loads on a scroll, only on a press; and the per-card collapse takes an expanded card back down to its
// header in one click. Whether that is enough is his call — this file is where to change it.
//
// EVERYTHING IS THE CARD'S PROJECT. The messages come from the card's own transcript read
// (hooks/useCardTranscript.ts), earlier pages through projectRpc(card's project) into that same entry, and
// the controls inside — a placed question, a fence's card — through the card's answering state and its
// ThreadProjectScope. The drawer's live machinery reads the PAGE's board through ThreadSlugContext (a
// sub-agent's drill-in, a wake line's terminal, a done fence's Mark as done), so the context is given only
// when the page is focused on the card's project; on All projects those stay read-only, as a
// cross-project card's mentions already do (MentionLinks.tsx).
//
// WHAT STAYS THE CARD'S, NOT THE TRANSCRIPT'S. The tail — the resting card, a registered done, the gates,
// the rested card — is drawn by AllQueuesCard under this in both views, and so is the newest rest's
// ```awaiting fence (CardAwaiting, wired to the card's project): the last message's awaiting block is
// card-owned here (Message `restingCardShown`), exactly as the drawer skips it under its resting card.
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { ChevronsUpDown } from "lucide-react"
import type { RegisteredQuestionView, ThreadView } from "@frizz/shared"
import { projectRpc } from "../api/rpc.ts"
import { ThreadProjectScope } from "../api/threadApi.tsx"
import type { ChatMessage, TranscriptData } from "../hooks.ts"
import { pairAllAnswers, settledAnswerKeys, withoutSettledAnswers } from "../lib/answersMessage.ts"
import { lastHumanTurnIndex } from "../lib/messagePresentation.ts"
import { hasQuestionBlock } from "../lib/questionBlocks.ts"
import { registeredStandingAt } from "../lib/questionShadow.ts"
import type { TranscriptQuestionGroups } from "../lib/queueCardQuestions.ts"
import {
  carriesDoneRegistration,
  collapseMiddleRuns,
  opensQueueSegment,
  queueCollapseSegments,
  segmentFolds,
  supersededAskIndices,
  survivesQueueCollapse,
} from "../lib/queueCollapse.ts"
import { startedSpinoffsKey, withoutSpinoffCalls } from "../lib/spinoffCalls.ts"
import { agentCompletionCall } from "../lib/subAgentCompletion.ts"
import { coalesceToolActivityMessages } from "../lib/toolActivity.ts"
import {
  captureTranscriptViewportAnchor,
  previousUserBoundary,
  prependEarlierPage,
  restoreTranscriptViewportAnchor,
  type PaginatedTranscriptData,
  type TranscriptViewportAnchor,
} from "../lib/transcriptPagination.ts"
import { CheckoutBaseContext } from "../lib/useMarkdown.ts"
import { resumeNativeAnchoring, resumeViewportLock, suspendNativeAnchoring, suspendViewportLock } from "../lib/viewportLock.ts"
import { showToast } from "../store.ts"
import { lastAssistantIndex, Message, messageHasRenderableText, messageHeadIsMeta, messageRendersNothing, messageTailIsMeta, withoutLiveTranscriptBackgroundTools } from "./ChatView.tsx"
import { RegisteredAnsweringContext, RegisteredQuestionStack, SettledQuestionStack, type SettledQuestion } from "./RegisteredQuestionCards.tsx"
import { STEP, VSpace } from "./rhythm.tsx"
import { ThreadSlugContext } from "./threadSlugContext.ts"
import { WakeDivider } from "./WakeDivider.tsx"

/** The card's top control, the handoff view's "Show earlier messages" link wears the same. */
export const EARLIER_CONTROL_CLASS =
  "self-center rounded-md border border-border px-2 py-0.5 text-[11px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-border-strong disabled:opacity-60"

/**
 * ONE STEP BACK through a card's transcript, from the window starting at `start`: upstream's loadEarlier
 * (TodosView), minus its React state so the handoff view's first press and the transcript's own "Load
 * earlier messages" take the same step. To the previous human or frizz turn the loaded page holds; past the
 * page, one earlier page from the server (prepended into the card's own cache entry); with neither, the
 * whole page. `startId` null means "nothing earlier" — the window stays where it was.
 */
export async function stepEarlier(
  project: { id: string },
  slug: string,
  data: TranscriptData,
  start: number,
): Promise<{ data: TranscriptData; startId: string | null; replaced?: true }> {
  const messages = data.messages
  const boundary = previousUserBoundary(messages, start)
  if (boundary !== null && messages[boundary]?.role === "user") return { data, startId: messages[boundary].sourceId ?? null }
  const cursor = data.beforeCursor
  if (cursor && data.transcriptKey && data.hasEarlier) {
    const earlier = await projectRpc(project.id).threadTranscriptEarlier({ slug, cursor })
    // A replaced session answers with another transcript: the caller starts over from its latest page.
    if (earlier.transcriptKey !== data.transcriptKey) return { data, startId: null, replaced: true }
    const next = prependEarlierPage(data as PaginatedTranscriptData, earlier) as TranscriptData
    return { data: next, startId: earlier.messages[0]?.sourceId ?? next.messages[0]?.sourceId ?? null }
  }
  return { data, startId: start > 0 ? (messages[0]?.sourceId ?? null) : null }
}

/** Where the window starts by default: the human's last turn, as the handoff's bubble. */
export function transcriptBase(messages: readonly ChatMessage[], startId: string | null): number {
  const human = lastHumanTurnIndex(messages)
  if (!startId) return human
  const at = messages.findIndex((m) => m.sourceId === startId)
  // A start the page no longer holds keeps the reader's intent — they asked to see further back — rather
  // than collapsing the card to its latest turn (upstream resolveVisibleStart).
  return at >= 0 ? at : 0
}

// The two fold lines, upstream's verbatim (TodosView MiddleRunsSummary / IntermediateSummary): a wake
// hairline standing for what it hides, one-way — expanding is a commitment to read the full log.
function MiddleRunsSummary({ runs, toolCount, onExpand }: { runs: number; toolCount: number; onExpand: () => void }) {
  const tools = toolCount > 0 ? `${toolCount} tool call${toolCount === 1 ? "" : "s"}` : ""
  const label = `${runs} more round${runs === 1 ? "" : "s"}`
  return (
    <WakeDivider icon={ChevronsUpDown} marker="middle-runs-summary" onClick={onExpand} ariaLabel={`Expand ${label}${tools ? ` and ${tools}` : ""} of intermediate agent activity`}>
      <span className="shrink-0 tabular-nums">{label}</span>
      {tools && (
        <>
          <span aria-hidden="true" className="shrink-0 opacity-50">·</span>
          <span className="shrink-0 tabular-nums">{tools}</span>
        </>
      )}
      <span aria-hidden="true" className="shrink-0 opacity-50">·</span>
      <span className="shrink-0">Click to expand</span>
    </WakeDivider>
  )
}

function IntermediateSummary({ toolCount, onExpand }: { toolCount: number; onExpand: () => void }) {
  const tools = toolCount > 0 ? `${toolCount} tool call${toolCount === 1 ? "" : "s"}` : ""
  return (
    <WakeDivider icon={ChevronsUpDown} marker="intermediate-summary" onClick={onExpand} ariaLabel={`Expand ${tools ? `${tools} of ` : ""}intermediate agent activity`}>
      {tools && (
        <>
          <span className="shrink-0 tabular-nums">{tools}</span>
          <span aria-hidden="true" className="shrink-0 opacity-50">·</span>
        </>
      )}
      <span className="shrink-0">Click to expand</span>
    </WakeDivider>
  )
}

export function QueueCardTranscript({
  project,
  thread,
  data,
  queryKey,
  base,
  onStart,
  groups,
  open,
  focused,
  foldsOpen,
  onOpenFolds,
}: {
  project: { id: string; projectDir?: string }
  thread: ThreadView
  data: TranscriptData
  /** The card's own cache entry (hooks/useCardTranscript.ts cardTranscriptKey), which earlier pages join. */
  queryKey: readonly unknown[]
  /** The window's first message (transcriptBase), and the setter of the message it starts at. */
  base: number
  onStart: (startId: string | null) => void
  groups: TranscriptQuestionGroups<RegisteredQuestionView, SettledQuestion>
  /** The open questions, for the fold of a fence that restates one (registeredStandingAt). */
  open: readonly RegisteredQuestionView[]
  /** Is the page focused on the card's project, so the drawer's board-reading controls are the card's? */
  focused: boolean
  /** Has the reader opened the folds (one way, upstream's `intermediateExpanded`)? The card's, so folding
   *  the card to its header and back keeps what the reader had open. */
  foldsOpen: boolean
  onOpenFolds: () => void
}) {
  const queryClient = useQueryClient()
  // A question this card's answering state sent is still drawn, greyed, in the very stack it was answered
  // in (RegisteredQuestionStack `keepAnswered`), so the answered stack at that rest leaves it out — the
  // handoff view's rule (AllQueuesCard CardSettledStack).
  const answering = useContext(RegisteredAnsweringContext)
  const sent = answering?.sent
  const raw = data.messages
  // The drawer's presentation filters (ChatView presentationMessages): both map one to one, so every index
  // below addresses the server's list, which is what the question readers were run over.
  const startedSpinoffs = startedSpinoffsKey(thread)
  const messages = useMemo(() => withoutSpinoffCalls(withoutLiveTranscriptBackgroundTools(raw), startedSpinoffs), [raw, startedSpinoffs])
  const lastAgentIdx = useMemo(() => lastAssistantIndex(messages), [messages])
  // Two reasons a fence draws nothing (ChatView): a wait the worker has spoken past is settled, and the
  // newest rest's is the CARD's to draw (see the header) — the second hides even a fence with a body.
  const isStale = (idx: number) => lastAgentIdx >= 0 && idx < lastAgentIdx
  const cardOwned = (idx: number) => idx === lastAgentIdx
  const rendersNothing = (m: ChatMessage, idx: number) => messageRendersNothing(m, isStale(idx), cardOwned(idx))
  const hasText = (m: ChatMessage, idx: number) => messageHasRenderableText(m, isStale(idx), cardOwned(idx))

  const settledKeys = useMemo(
    () => settledAnswerKeys([...groups.settled.anchored.values(), ...groups.settled.placed.values()].flat().map((s) => s.answer)),
    [groups.settled],
  )
  const paired = useMemo(() => pairAllAnswers(messages).map((rows) => withoutSettledAnswers(rows, settledKeys)), [messages, settledKeys])
  const shadowedByMessage = useMemo(() => registeredStandingAt(messages, open), [messages, open])
  const lastUserIdx = useMemo(() => lastHumanTurnIndex(messages), [messages])

  // UPSTREAM'S FOLDS, unchanged (TodosView QueueCard: restTurnStart, landedUserIdx, collapseSteps, the
  // segments and the middle). The reasoning for each lives in lib/queueCollapse.ts beside the walk.
  const restTurnStart = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].boundary !== "rest") continue
      for (let g = i + 1; g < messages.length; g++) {
        const after = messages[g]
        if (after.queued || after.boundary === "rest" || rendersNothing(after, g)) continue
        return i + 1
      }
    }
    return 0
  }, [messages, lastAgentIdx])
  const landedUserIdx = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user" && !messages[i].queued) return i
    return -1
  }, [messages])
  const supersededAsks = useMemo(() => supersededAskIndices(messages), [messages])
  const collapseSteps = useMemo(() => messages.map((m, g) => {
    if (!m || m.queued || rendersNothing(m, g)) return { skip: true }
    if (m.pinnedFromSourceId) return { skip: true }
    if (m.boundary === "rest") return { skip: true, closes: true }
    const completion = agentCompletionCall(m)
    const tools = completion ? 0 : m.tools.length
    const text = hasText(m, g)
    return {
      text,
      tools,
      countable: text || tools > 0 || completion !== undefined || m.kind !== undefined,
      survives: survivesQueueCollapse(m, g, supersededAsks),
      opens: opensQueueSegment(m),
      completion: m.boundary === "wake" || completion !== undefined,
    }
  }), [messages, supersededAsks, lastAgentIdx])
  const allSegments = useMemo(() => queueCollapseSegments(collapseSteps, lastUserIdx + 1), [collapseSteps, lastUserIdx])
  const { kept, middle } = useMemo(() => collapseMiddleRuns(allSegments), [allSegments])
  const segments = useMemo(() => kept.filter(segmentFolds), [kept])
  const segmentAt = useMemo(() => {
    const at = new Map<number, number>()
    segments.forEach((seg, si) => { for (let i = seg.start; i <= seg.end; i++) at.set(i, si) })
    return at
  }, [segments])
  const collapseIntermediate = !foldsOpen && (landedUserIdx >= 0 || restTurnStart > 0) && (segments.length > 0 || middle !== undefined)

  const visible = useMemo(() => messages.slice(base), [messages, base])
  const coalescedVisible = useMemo(
    () => coalesceToolActivityMessages(visible).map((entry) => ({ ...entry, messageIndex: entry.messageIndex + base })),
    [visible, base],
  )
  const hasMore = base > 0 || data.hasEarlier === true

  // LOAD EARLIER HOLDS WHAT THE READER IS LOOKING AT (upstream's viewport anchor): the first message on
  // screen keeps its screen position, and the page that landed grows UPWARD above it. The page's viewport
  // lock would otherwise hold the card's first node and grow it downward out of the control, putting the
  // oldest loaded round in front of the reader (David 2026-09-29, 92672b88) — so it stands aside for the
  // landing, with native anchoring, and re-takes its anchor from wherever this leaves the page.
  const listRef = useRef<HTMLDivElement>(null)
  const pending = useRef<{ anchor: TranscriptViewportAnchor; targetStartId: string } | null>(null)
  const held = useRef(false)
  const release = () => {
    if (!held.current) return
    held.current = false
    resumeNativeAnchoring()
    resumeViewportLock()
  }
  useEffect(() => release, [])
  useLayoutEffect(() => {
    const landing = pending.current
    const root = listRef.current
    if (!landing || !root) return
    // The cache write and the window's start can commit apart; correct on the commit that draws the target.
    if (![...root.querySelectorAll<HTMLElement>("[data-transcript-source-id]")].some((node) => node.dataset.transcriptSourceId === landing.targetStartId)) return
    pending.current = null
    const correct = () => restoreTranscriptViewportAnchor(root, landing.anchor, (delta) => {
      if (delta !== 0) window.scrollBy({ top: delta, left: 0, behavior: "instant" })
    })
    correct()
    // Rows that settle late (markdown, a tool band's measure) get two more corrections before the lock
    // takes the page back. Never cancelled by a re-render, which would leave the lock suspended; a list
    // gone from the page in between is simply not corrected.
    requestAnimationFrame(() => {
      if (root.isConnected) correct()
      requestAnimationFrame(() => {
        if (root.isConnected) correct()
        release()
      })
    })
  })

  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const loadEarlier = async () => {
    if (loadingEarlier || !hasMore) return
    setLoadingEarlier(true)
    try {
      const step = await stepEarlier(project, thread.id, data, base)
      if (step.replaced) {
        await queryClient.invalidateQueries({ queryKey })
        onStart(null)
        showToast("The thread's session changed while loading; showing its newest messages")
        return
      }
      if (!step.startId) return
      const anchor = captureTranscriptViewportAnchor(listRef.current)
      if (anchor) {
        if (!held.current) {
          held.current = true
          suspendViewportLock()
          suspendNativeAnchoring()
        }
        pending.current = { anchor, targetStartId: step.startId }
      }
      if (step.data !== data) queryClient.setQueryData(queryKey, step.data)
      onStart(step.startId)
    } catch (error) {
      release()
      showToast(error instanceof Error ? `Couldn't load earlier messages: ${error.message}` : "Couldn't load earlier messages")
    } finally {
      setLoadingEarlier(false)
    }
  }

  // THE ROWS, upstream's walk (TodosView QueueCard's render loop) with the fork's Message props: a run's
  // opening and closing prose text-only, its middle behind one divider, the middle rounds behind one line,
  // and every registered question flushed after the first drawn row at or past the rest it belongs to.
  const rows = (() => {
    const out: ReactNode[] = []
    let prevTailIsMeta: boolean | null = null
    const pendingOpen = [...groups.byAnchor.entries()].sort((a, b) => a[0] - b[0])
    const pendingSettled = [...groups.settled.anchored.entries()].sort((a, b) => a[0] - b[0])
    const flushSettled = (globalIdx: number) => {
      while (pendingSettled.length > 0 && pendingSettled[0][0] <= globalIdx) {
        const [anchor, group] = pendingSettled.shift()!
        const shown = sent && sent.size > 0 ? group.filter((q) => !sent.has(q.id)) : group
        if (shown.length === 0) continue
        if (prevTailIsMeta !== null) out.push(<VSpace key={`sq-space-${anchor}`} h={STEP} />)
        out.push(<SettledQuestionStack key={`sq-${anchor}`} questions={shown} wrap />)
        prevTailIsMeta = false
      }
    }
    const flushQuestions = (globalIdx: number) => {
      flushSettled(globalIdx)
      while (pendingOpen.length > 0 && pendingOpen[0][0] <= globalIdx) {
        const [anchor, group] = pendingOpen.shift()!
        if (prevTailIsMeta !== null) out.push(<VSpace key={`qa-space-${anchor}`} h={STEP} />)
        out.push(<RegisteredQuestionStack key={`qa-${anchor}`} thread={thread} questions={group} keepAnswered />)
        prevTailIsMeta = false
      }
    }
    // A rest older than the window flushes FIRST: anywhere later would put it under messages it predates.
    flushQuestions(base - 1)
    const props = (m: ChatMessage, globalIdx: number) => ({
      m,
      dense: true,
      paired: paired[globalIdx],
      staleAwaiting: isStale(globalIdx),
      restingCardShown: cardOwned(globalIdx),
      shadowedBy: shadowedByMessage.get(globalIdx),
      placed: groups.placed.get(globalIdx),
      settledPlaced: groups.settled.placed.get(globalIdx),
    })
    const barEmitted = new Set<number>()
    let middleEmitted = false
    coalescedVisible.forEach(({ message: m, messageIndex: globalIdx }, i) => {
      if (m.queued) return
      if (rendersNothing(m, globalIdx)) return
      // "Agent rested" is the card's premise, not news (upstream: the rule restates the frame around it).
      if (m.boundary === "rest") return
      if (collapseIntermediate && middle && globalIdx >= middle.start && globalIdx <= middle.end) {
        if (!middleEmitted) {
          middleEmitted = true
          if (prevTailIsMeta !== null) out.push(<VSpace key="middle-runs-space" h={STEP} />)
          out.push(<MiddleRunsSummary key="middle-runs-summary" runs={middle.runs} toolCount={middle.tools} onExpand={onOpenFolds} />)
          prevTailIsMeta = false
        }
        return
      }
      const segIdx = collapseIntermediate ? segmentAt.get(globalIdx) : undefined
      const seg = segIdx === undefined ? undefined : segments[segIdx]
      const inSpan = seg !== undefined
      const isFirst = seg !== undefined && globalIdx === seg.open
      const isLast = seg !== undefined && globalIdx === seg.close
      const liftedWake = inSpan && !isFirst && !isLast && !hasQuestionBlock(m.text) && !carriesDoneRegistration(m) && survivesQueueCollapse(m, globalIdx, supersededAsks)
      const key = m.sourceId ?? `legacy-${globalIdx}`
      if (seg !== undefined && globalIdx === seg.waker) {
        if (prevTailIsMeta !== null) out.push(<VSpace key={`s${i}`} h={prevTailIsMeta && messageHeadIsMeta(m) ? 6 : STEP} />)
        out.push(
          <div key={key} data-transcript-source-id={key} className="flex flex-col">
            <Message m={m} dense />
          </div>,
        )
        prevTailIsMeta = messageTailIsMeta(m)
        return
      }
      if (inSpan && !liftedWake) {
        if (!isFirst && !isLast && !survivesQueueCollapse(m, globalIdx, supersededAsks)) return
        const loneProse = isFirst && isLast
        const emitBar = () => {
          if (segIdx === undefined || barEmitted.has(segIdx)) return
          if (prevTailIsMeta !== null) out.push(<VSpace key={`im-space-${segIdx}`} h={STEP} />)
          out.push(<IntermediateSummary key={`intermediate-summary-${segIdx}`} toolCount={seg.tools} onExpand={onOpenFolds} />)
          prevTailIsMeta = false
          barEmitted.add(segIdx)
        }
        if (!isFirst || (loneProse && seg.hiddenBeforeOpen)) emitBar()
        if (!hasText(m, globalIdx)) return
        if (prevTailIsMeta !== null) out.push(<VSpace key={`s${i}`} h={STEP} />)
        out.push(
          <div key={key} data-transcript-source-id={key} className="flex flex-col">
            <Message {...props(m, globalIdx)} textOnly />
          </div>,
        )
        prevTailIsMeta = false
        if (loneProse) emitBar()
        flushQuestions(globalIdx)
        return
      }
      if (prevTailIsMeta !== null) out.push(<VSpace key={`s${i}`} h={prevTailIsMeta && messageHeadIsMeta(m) ? 6 : STEP} />)
      out.push(
        <div key={key} data-transcript-source-id={key} className="flex flex-col">
          <Message {...props(m, globalIdx)} />
        </div>,
      )
      prevTailIsMeta = messageTailIsMeta(m)
      flushQuestions(globalIdx)
    })
    // A settled group anchored on a trailing row this card does not draw still belongs in the transcript.
    flushSettled(Number.POSITIVE_INFINITY)
    return out
  })()

  return (
    <ThreadProjectScope projectId={project.id} projectDir={project.projectDir}>
      <ThreadSlugContext.Provider value={focused ? thread.id : null}>
        <CheckoutBaseContext.Provider value={thread.checkout?.dir ?? null}>
          {/* No flex gap: between-message spacing is the explicit spacers above, as in the drawer. */}
          <div ref={listRef} data-xq-transcript={thread.id} className="flex min-w-0 flex-col">
            {hasMore && (
              <button
                type="button"
                data-xq-load-earlier
                className={`mb-3.5 ${EARLIER_CONTROL_CLASS}`}
                onClick={() => void loadEarlier()}
                onMouseDown={(event) => event.preventDefault()}
                disabled={loadingEarlier}
              >
                {loadingEarlier ? "Loading earlier messages…" : data.reachedTurnBoundary === false ? "Continue loading this turn" : "Load earlier messages"}
              </button>
            )}
            {rows}
          </div>
        </CheckoutBaseContext.Provider>
      </ThreadSlugContext.Provider>
    </ThreadProjectScope>
  )
}
