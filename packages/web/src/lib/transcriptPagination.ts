import type { TranscriptMessage, TranscriptPage } from "@frizz/shared"

export type PaginatedTranscriptData = TranscriptPage & { historyLoaded?: boolean }

// The next click starts at the immediately-previous projected user message. When no earlier user exists
// in the in-memory window, reveal its whole remaining prefix in one step; the caller consults the server
// cursor first when history exists beyond that prefix.
export function previousUserBoundary(messages: readonly TranscriptMessage[], currentStart: number): number | null {
  const start = Math.max(0, Math.min(messages.length, currentStart))
  for (let i = start - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i
  }
  return start > 0 ? 0 : null
}

// Where a queue card's visible window starts, given the message the reader explicitly expanded back to.
//
// The subtlety is the message going MISSING. The server's latest window is bounded — MAX_MESSAGES, reaching
// further back only as far as the human's last message (latestWindowStart) — so on a long enough thread
// every new message pushes one off the head of the window, and "View more" walks back INSIDE that window
// without fetching (so nothing marks the prefix as loaded history, which is what would make a push retain
// it). The reader's chosen start can therefore be trimmed away underneath them, and falling
// back to `lastUserIdx` there silently collapses the card they had just expanded, all the way back to the
// latest turn. Keep the intent instead: they asked to see further back, so show everything still held.
export function resolveVisibleStart(
  messages: readonly TranscriptMessage[],
  visibleStartId: string | null,
  lastUserIdx: number,
): number {
  if (!visibleStartId) return lastUserIdx
  const explicit = messages.findIndex((message) => message.sourceId === visibleStartId)
  return explicit >= 0 ? explicit : 0
}

function firstOverlap(
  previous: readonly TranscriptMessage[],
  incoming: readonly TranscriptMessage[],
): { previousIndex: number; incomingIndex: number } | undefined {
  const priorIds = new Map<string, number>()
  previous.forEach((message, index) => {
    if (message.sourceId) priorIds.set(message.sourceId, index)
  })
  for (let incomingIndex = 0; incomingIndex < incoming.length; incomingIndex++) {
    const id = incoming[incomingIndex].sourceId
    const previousIndex = id ? priorIds.get(id) : undefined
    if (previousIndex !== undefined) return { previousIndex, incomingIndex }
  }
  return undefined
}

// Reconcile a fresh latest-window pull/push with history already fetched by the user. The overlap's
// current server copies win (tool statuses can finalize), while the older prefix and its cursor remain.
// No overlap means a transcript/session replacement: discard the old window instead of splicing worlds.
export function reconcileLatestPage(
  previous: PaginatedTranscriptData | undefined,
  incoming: TranscriptPage,
): PaginatedTranscriptData {
  if (!previous?.historyLoaded || previous.transcriptKey !== incoming.transcriptKey) return incoming
  const overlap = firstOverlap(previous.messages, incoming.messages)
  if (!overlap) return incoming
  return {
    ...incoming,
    messages: [
      ...previous.messages.slice(0, overlap.previousIndex).filter((message) => !message.pinnedFromSourceId),
      ...incoming.messages.slice(overlap.incomingIndex),
    ],
    beforeCursor: previous.beforeCursor,
    hasEarlier: previous.hasEarlier,
    reachedTurnBoundary: previous.reachedTurnBoundary,
    historyLoaded: true,
  }
}

// A live push carries MESSAGES ONLY — never a page envelope — so the envelope can only come from what we
// already hold. Overlapping source ids mean it is the same transcript, whatever else moved.
//
// `previousIndex > 0` is the SLID WINDOW: the server's latest window is bounded (see latestWindowStart), so
// on a long enough thread every new message also pushes one off the HEAD, and the push's first message is
// one we already have further in. That is an ordinary live update on a long thread — not a session replacement —
// and dropping the envelope there was destroying `hasEarlier`/`beforeCursor`/`transcriptKey` on the FIRST
// push of any thread past the cap, which removed the "Load earlier messages" affordance outright (and
// with it the only route back to the history the slide had just trimmed away, since loadEarlier needs
// both the cursor and the key). Only a genuine no-overlap replacement discards what we hold.
export function reconcileLiveMessages(
  previous: PaginatedTranscriptData | undefined,
  incoming: readonly TranscriptMessage[],
): PaginatedTranscriptData | { messages: TranscriptMessage[] } {
  if (!previous) return { messages: [...incoming] }
  const overlap = firstOverlap(previous.messages, incoming)
  if (!overlap) return { messages: [...incoming] }
  if (!previous.historyLoaded) return { ...previous, messages: [...incoming] }
  return {
    ...previous,
    messages: [
      ...previous.messages.slice(0, overlap.previousIndex).filter((message) => !message.pinnedFromSourceId),
      ...incoming.slice(overlap.incomingIndex),
    ],
  }
}

// Apply one earlier response once. Source ids make retries/stale duplicate responses idempotent.
export function prependEarlierPage(
  current: PaginatedTranscriptData,
  earlier: TranscriptPage,
): PaginatedTranscriptData {
  if (current.transcriptKey !== earlier.transcriptKey) return current
  const incomingCanonical = new Set(earlier.messages.map((message) => message.sourceId).filter(Boolean))
  const retainedCurrent = current.messages.filter(
    (message) => !message.pinnedFromSourceId || !incomingCanonical.has(message.pinnedFromSourceId),
  )
  const present = new Set(retainedCurrent.map((message) => message.sourceId).filter(Boolean))
  const prepend = earlier.messages.filter((message) => !message.sourceId || !present.has(message.sourceId))
  return {
    ...current,
    messages: [...prepend, ...retainedCurrent],
    beforeCursor: earlier.beforeCursor,
    hasEarlier: earlier.hasEarlier,
    reachedTurnBoundary: earlier.reachedTurnBoundary,
    historyLoaded: true,
  }
}

export interface TranscriptViewportAnchor {
  sourceId: string
  top: number
}

// Pick the first old message intersecting the viewport. Its top-edge delta after React prepends the
// page is the exact scroll correction, independent of variable-height markdown/tool cards.
export function captureTranscriptViewportAnchor(
  root: HTMLElement | null,
  viewportTop = 0,
): TranscriptViewportAnchor | null {
  if (!root) return null
  const nodes = [...root.querySelectorAll<HTMLElement>("[data-transcript-source-id]")]
  const node = nodes.find((candidate) => candidate.getBoundingClientRect().bottom > viewportTop) ?? nodes[0]
  const sourceId = node?.dataset.transcriptSourceId
  return node && sourceId ? { sourceId, top: node.getBoundingClientRect().top } : null
}

export function transcriptAnchorScrollDelta(beforeTop: number, afterTop: number): number {
  return afterTop - beforeTop
}

export function restoreTranscriptViewportAnchor(
  root: HTMLElement | null,
  anchor: TranscriptViewportAnchor | null,
  scrollBy: (delta: number) => void,
): boolean {
  if (!root || !anchor) return false
  const node = [...root.querySelectorAll<HTMLElement>("[data-transcript-source-id]")]
    .find((candidate) => candidate.dataset.transcriptSourceId === anchor.sourceId)
  if (!node) return false
  scrollBy(transcriptAnchorScrollDelta(anchor.top, node.getBoundingClientRect().top))
  return true
}

export interface TranscriptAnchorGeometry {
  // Pixels the anchored message is STILL off its captured screen Y after one scrollBy correction.
  remaining: number
  scrollY: number
  // documentElement.scrollHeight - innerHeight, clamped at 0. Zero means the window does not scroll.
  maxScrollY: number
  // Whether this pending anchor already spent its one bottom-reserve growth.
  alreadyReserved: boolean
}

// Decide what a load-earlier viewport correction should do next.
//
// "reserve" — the window is pinned at its bottom with pixels still owed, so there is physically nowhere
//   left to scroll. Grow the reserve below the card by the shortfall and re-run on the next layout pass.
// "settle"  — done, impossible, or not converging. Hand off to the rAF settlement, which finishes with
//   whatever the browser allows and releases the anchor.
//
// THIS FUNCTION EXISTS BECAUSE "reserve" RE-ARMS THE EFFECT THAT CALLS IT, so a state where it can never
// stop saying "reserve" is an infinite render loop. Two guards make that unreachable, and both were real:
//
//   • `maxScrollY > 0`. A SCROLL-LOCKED document (`body{position:fixed}` — what an open thread drawer
//     does to the board behind it) reports maxScrollY 0 and scrollY 0, so the bottom test degenerates to
//     `0 >= -1`: true always. Worse, on a fixed body `window.scrollBy` moves nothing and margin under the
//     card cannot grow scrollHeight, so neither `remaining` nor `maxScrollY` can ever change. Measured
//     before this guard: 52 passes, remaining frozen at 2218.75px, reserve climbing 0 → 110,950px, until
//     React's nested-update limit tore the QueueCard out through the ErrorBoundary.
//   • `!alreadyReserved`. The reserve adds exactly the missing pixels, so ONE growth is by construction
//     enough; a second request means the correction is not converging for some other reason, and settling
//     imperfectly always beats spinning.
export function transcriptAnchorCorrection(geometry: TranscriptAnchorGeometry): "reserve" | "settle" {
  const { remaining, scrollY, maxScrollY, alreadyReserved } = geometry
  if (!(remaining > 0.5)) return "settle" // converged (or a NaN/negative reading — never act on those)
  if (maxScrollY <= 0) return "settle" // the window cannot scroll, so no reserve can buy it room
  if (alreadyReserved) return "settle" // one growth per anchor; a second means it is not converging
  return scrollY >= maxScrollY - 1 ? "reserve" : "settle"
}
