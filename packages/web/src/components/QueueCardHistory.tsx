// A QUEUE CARD'S HISTORY, read in the card — everything the thread said before the exchange the card
// shows. The card is deliberately the handoff and nothing else (AllQueuesCard.tsx), which left no way to
// scroll up through a thread without opening its drawer; the board's queue card it replaced had carried
// "Load earlier messages" at its top, and losing it read as a regression (maintainer 2026-09-29: "can i
// no longer scroll up directly in a thread card to see its history?"). So the card grows UPWARD on
// request: one quiet control at its top, which reads the thread's transcript and draws what came before
// the human's last message, and then pages further back the way the drawer does.
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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { ThreadHandoff, TranscriptPage } from "@frizz/shared"
import type { Api } from "../api/rpc.ts"
import type { ChatMessage } from "../hooks.ts"
import { historyCut } from "../lib/queueCardHistory.ts"
import { coalesceToolActivityMessages } from "../lib/toolActivity.ts"
import { prependEarlierPage, type PaginatedTranscriptData } from "../lib/transcriptPagination.ts"
import { resumeViewportLock, suspendViewportLock } from "../lib/viewportLock.ts"
import { Message, ThreadSlugContext, withMessageSpacers } from "./ChatView.tsx"

/** How many messages one "Load earlier messages" press reaches back for, at least. */
const PRESS_MESSAGES = 40

const CONTROL_CLASS =
  "self-center rounded-md border border-border px-2 py-0.5 text-[11px] text-muted transition-colors outline-none hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-border-strong disabled:opacity-60"

export function QueueCardHistory({ api, slug, handoff }: { api: Api; slug: string; handoff: ThreadHandoff | undefined }) {
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
      const bottom = rootRef.current?.getBoundingClientRect().bottom
      if (bottom !== undefined && bottom !== target) window.scrollBy({ top: bottom - target, left: 0, behavior: "instant" })
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
  }, [page])
  useEffect(() => () => {
    if (heldLock.current) {
      heldLock.current = false
      resumeViewportLock()
    }
  }, [])

  const load = useCallback(async () => {
    if (loading) return
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
      setLoading(false)
    }
  }, [api, loading, page, slug])

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
