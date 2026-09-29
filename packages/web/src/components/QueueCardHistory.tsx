// A QUEUE CARD'S HISTORY, read in the card — everything the thread said before the exchange the card
// shows. The card is deliberately the handoff and nothing else (AllQueuesCard.tsx), which left no way to
// scroll up through a thread without opening its drawer; the board's queue card it replaced had carried
// "Load earlier messages" at its top, and losing it read as a regression (maintainer 2026-09-29: "can i
// no longer scroll up directly in a thread card to see its history?"). So the card grows UPWARD as the
// reader scrolls up into it: it reads the thread's transcript and draws what came before the human's
// last message, and then pages further back the way the drawer does.
//
// SCROLLING UP IS THE ASK (maintainer 2026-09-29: "why not implement dynamic load scroll when a user
// scrolls up on a thread? there shouldnt be that many thread cards active at once"). A page is read when
// the reader moves UP — the page scrolling up, or a wheel/swipe up over the card when the page cannot
// scroll any higher — while the card's top is on screen or within NEAR_PX above it. Never merely because
// the top is visible: every card's top is visible at first paint, and a load then would grow every card
// upward and push its header off the screen before anyone asked. The control stays, as the thing the
// load is seen happening on and for a reader without a wheel.
//
// SCOPED TO THE CARD'S PROJECT, never the page's: the drawer's transcript cache is keyed by slug alone
// and read through the FOCUSED project's client (hooks.ts useTranscript), which on this page is usually
// another project. This reads through the card's own client into its own local state, and nothing is
// live — a queued thread is at rest, and the card re-mounts this when it rests again (the reset key).
//
// A LANDED PAGE GROWS UPWARD. The card's own exchange — the bubble and the handoff under this — stays
// exactly where it was on screen and the page scrolls by what was added, so the message just before it
// is right above it and reading back is scrolling up. Left to the page's viewport lock
// (lib/viewportLock.ts), which holds the card's first node on screen, the history grew DOWNWARD out of
// the control instead: a press on a long thread put its OLDEST loaded round in front of the reader, with
// the one they wanted a screenful of scrolling below. So the lock stands aside for the landing and
// re-takes its anchor from wherever this leaves the page.
//
// And the page may be too SHORT to hold it: the last card on a page has nothing under it to scroll into,
// so the browser clamps the correction (measured: 13,197px asked, 12,807 given, the exchange dropped
// 391px). The card is asked for the shortfall as blank space beneath it (`onShortfall`), as the board's
// queue card once reserved it, and the next frame's correction lands exactly.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { ThreadHandoff, TranscriptPage } from "@frizz/shared"
import type { Api } from "../api/rpc.ts"
import type { ChatMessage } from "../hooks.ts"
import { historyCut } from "../lib/queueCardHistory.ts"
import { coalesceToolActivityMessages } from "../lib/toolActivity.ts"
import { prependEarlierPage, type PaginatedTranscriptData } from "../lib/transcriptPagination.ts"
import { resumeViewportLock, suspendViewportLock } from "../lib/viewportLock.ts"
import { Message, ThreadSlugContext, withMessageSpacers } from "./ChatView.tsx"

/** How far above the viewport the card's top may be and still be loaded into — a page's worth of lead,
 *  so a reader scrolling up steadily meets history that has already landed. */
const NEAR_PX = 800

/** What says a scroll is the reader's own, and for how long after it (a wheel's smooth scroll runs on). */
const GESTURES = ["wheel", "touchmove", "pointerdown", "keydown"] as const
const GESTURE_MS = 1_000

/** How many messages one load reaches back for, at least. */
const PRESS_MESSAGES = 40

const CONTROL_CLASS =
  "self-center rounded-md border border-border px-2 py-0.5 text-[11px] text-muted transition-colors outline-none hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-border-strong disabled:opacity-60"

export function QueueCardHistory({ api, slug, handoff, onShortfall }: { api: Api; slug: string; handoff: ThreadHandoff | undefined; onShortfall: (px: number) => void }) {
  const [page, setPage] = useState<PaginatedTranscriptData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  // The history's bottom edge on screen — the top of the card's own exchange — when a page was asked for.
  const holdRef = useRef<number | null>(null)
  const heldLock = useRef(false)

  const land = (next: PaginatedTranscriptData) => {
    const root = rootRef.current
    if (root) {
      holdRef.current = root.getBoundingClientRect().bottom
      if (!heldLock.current) {
        heldLock.current = true
        suspendViewportLock()
      }
    }
    setPage(next)
  }

  // Before paint: put the exchange back where it was. Then once more on each of the next two frames, for
  // rows that settle late (markdown, a tool band's measure), before the lock takes the page back.
  useLayoutEffect(() => {
    const target = holdRef.current
    if (target === null) return
    holdRef.current = null
    const correct = () => {
      const root = rootRef.current
      if (!root) return
      const off = root.getBoundingClientRect().bottom - target
      if (Math.abs(off) < 0.5) return
      window.scrollBy({ top: off, left: 0, behavior: "instant" })
      const short = root.getBoundingClientRect().bottom - target
      if (short >= 0.5) onShortfall(Math.ceil(short))
    }
    correct()
    let frame = requestAnimationFrame(() => {
      correct()
      frame = requestAnimationFrame(() => {
        correct()
        if (heldLock.current) {
          heldLock.current = false
          resumeViewportLock()
        }
      })
    })
    return () => cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs per landed page, never per callback
  }, [page])
  useEffect(() => () => {
    if (heldLock.current) {
      heldLock.current = false
      resumeViewportLock()
    }
  }, [])

  // A ref as well as the state: two scroll events in one frame both read the render's `loading` as false.
  const busy = useRef(false)
  const load = useCallback(async () => {
    if (busy.current) return
    if (page && !page.hasEarlier) return
    busy.current = true
    setLoading(true)
    setError(null)
    try {
      if (!page) {
        land((await api.threadTranscript({ slug })) as PaginatedTranscriptData)
        return
      }
      // An earlier page is ONE TURN (the server cuts them at turn boundaries), which on a thread of short
      // rounds is a press per round. So a press gathers pages until it has a screenful to show.
      let next = page
      while (next.beforeCursor && next.messages.length - page.messages.length < PRESS_MESSAGES) {
        const earlier: TranscriptPage = await api.threadTranscriptEarlier({ slug, cursor: next.beforeCursor })
        // A replaced session answers with another transcript: start over from its latest page.
        if (earlier.transcriptKey !== next.transcriptKey) {
          land((await api.threadTranscript({ slug })) as PaginatedTranscriptData)
          return
        }
        next = prependEarlierPage(next, earlier)
      }
      land(next)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load earlier messages")
    } finally {
      busy.current = false
      setLoading(false)
    }
  }, [api, page, slug])

  const loadRef = useRef(load)
  loadRef.current = load
  const failed = error !== null
  useEffect(() => {
    const root = rootRef.current
    if (!root || failed) return
    const card = root.closest("article") ?? root
    const near = () => {
      const top = root.getBoundingClientRect().top
      return top > -NEAR_PX && top < window.innerHeight
    }
    // Only the HUMAN's scroll: the viewport lock scrolls the page up by itself whenever a card above the
    // reader leaves, and that is not a reader asking for history. A scroll counts inside a beat of a
    // wheel, a touch, a scrollbar drag or a key.
    let gestureAt = 0
    const onGesture = () => { gestureAt = performance.now() }
    let lastY = window.scrollY
    const onScroll = () => {
      const y = window.scrollY
      const up = y < lastY
      lastY = y
      if (up && performance.now() - gestureAt < GESTURE_MS && near()) void loadRef.current()
    }
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0 && near()) void loadRef.current()
    }
    let touchY: number | null = null
    const onTouchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY ?? null }
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY
      // A finger moving DOWN the screen scrolls the page up.
      if (touchY !== null && y !== undefined && y > touchY && near()) void loadRef.current()
    }
    for (const type of GESTURES) window.addEventListener(type, onGesture, { capture: true, passive: true })
    window.addEventListener("scroll", onScroll, { passive: true })
    card.addEventListener("wheel", onWheel as EventListener, { passive: true })
    card.addEventListener("touchstart", onTouchStart as EventListener, { passive: true })
    card.addEventListener("touchmove", onTouchMove as EventListener, { passive: true })
    return () => {
      for (const type of GESTURES) window.removeEventListener(type, onGesture, { capture: true })
      window.removeEventListener("scroll", onScroll)
      card.removeEventListener("wheel", onWheel as EventListener)
      card.removeEventListener("touchstart", onTouchStart as EventListener)
      card.removeEventListener("touchmove", onTouchMove as EventListener)
    }
  }, [failed])

  const history = useMemo(() => {
    if (!page) return []
    const messages = page.messages as ChatMessage[]
    return coalesceToolActivityMessages(messages.slice(0, historyCut(messages, handoff))).map((entry) => entry.message)
  }, [handoff, page])
  const drawn = useMemo(() => withMessageSpacers(history, (m, i) => <Message key={m.sourceId ?? i} m={m} />), [history])

  // A latest page that is ALL the card's own exchange (a long last turn) draws nothing above it; step
  // straight on back rather than leaving the reader a press that seemed to do nothing.
  const empty = page !== null && drawn.length === 0
  useEffect(() => {
    if (empty && page.hasEarlier && !loading && !error) void load()
  }, [empty, error, load, loading, page])

  const label = loading
    ? "Loading earlier messages…"
    : page === null
      ? "Show earlier messages"
      : "Load earlier messages"
  const more = page === null || page.hasEarlier

  return (
    <div ref={rootRef} data-xq-history className="flex min-w-0 flex-col">
      {error ? (
        <div role="status" className="flex flex-wrap items-center justify-center gap-2 text-center text-[11px] text-muted">
          <span>{error}</span>
          <button type="button" className={CONTROL_CLASS} onClick={() => void load()}>Retry</button>
        </div>
      ) : more ? (
        <button type="button" className={CONTROL_CLASS} disabled={loading} onMouseDown={(event) => event.preventDefault()} onClick={() => void load()}>
          {label}
        </button>
      ) : empty ? (
        <p className="self-center text-[11px] text-muted">Nothing earlier in this thread.</p>
      ) : null}
      {drawn.length > 0 && (
        <ThreadSlugContext.Provider value={slug}>
          <div className={`flex min-w-0 flex-col ${more || error ? "pt-4" : ""}`}>{drawn}</div>
        </ThreadSlugContext.Provider>
      )}
    </div>
  )
}
