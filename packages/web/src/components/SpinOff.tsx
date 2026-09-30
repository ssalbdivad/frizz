import { useRef, useState, type ReactNode } from "react"
import { Split } from "lucide-react"
import { SPIN_OFF_EXCERPT_MAX, SPIN_OFF_INSTRUCTIONS_MAX, type SpinOffView, type ThreadView } from "@frizz/shared"
import { useThreadApi } from "../api/threadApi.tsx"
import { displayTitle } from "../groups.ts"
import { useBoard } from "../hooks.ts"
import { openThread, showToast, threadBySlug } from "../store.ts"
import { Dialog } from "./ui/Dialog.tsx"
import { BLOCK_RADIUS } from "./TranscriptCard.tsx"

// SPIN-OFFS — a new thread the human asks for from ONE message of this one ("fix this", "investigate
// perf"), with this thread supplying the context. Three surfaces, one concept:
//
//   · SpinOffButton — the hover action on a message, and the dialog that takes the instructions. The
//     request goes to this thread's worker (the `spinOff` RPC), which briefs and dispatches the new one.
//   · SpinOffBubble — the request, in this thread's timeline where the human sent it, and the link to the
//     thread it became once the worker has started it.
//   · SpunOffFrom — the child's way back, on its header's second line.
//
// The server holds the edge (`thread_spinoff`, carried on ThreadView.spinOffs at both ends), so every
// surface reads the same row and none of them has to find the other thread in a transcript.

/** The hover action on one message. `excerpt` is the text the human sees in that message — sent along so
 *  the request can quote it even after the transcript has paged it out of the worker's reach. */
export function SpinOffButton({ thread, sourceId, excerpt }: { thread: ThreadView; sourceId: string; excerpt: string }) {
  const api = useThreadApi()
  const [open, setOpen] = useState(false)
  const [instructions, setInstructions] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  const quoted = excerpt.trim().slice(0, SPIN_OFF_EXCERPT_MAX)

  const submit = async () => {
    const text = instructions.trim()
    if (!text || busy) return
    setBusy(true)
    setError("")
    try {
      await api.spinOff({ slug: thread.id, sessionId: thread.sessionId ?? "", sourceId, excerpt: quoted, instructions: text })
      setOpen(false)
      setInstructions("")
      showToast("Starting a new thread", { detail: "This thread is gathering its context." })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Spin off a new thread from this message"
        aria-label="Spin off a new thread from this message"
        data-spin-off-action
        // In the row's right GUTTER (MessageRow's px-6), so it covers no text and costs the row no
        // height — the virtualizer measures every row, and a control that grew one on hover would shove
        // the scroll position out from under the pointer. Hidden until the row is hovered or it is
        // focused from the keyboard.
        className="icon-hover-outline absolute right-0.5 flex h-5 w-5 items-center justify-center rounded-md text-muted opacity-0 outline-none transition-[opacity,color,background-color] hover:bg-panel-2 hover:text-fg focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-focus-ink-60 group-hover/ts:opacity-100"
      >
        <Split size={13} strokeWidth={2} className="rotate-90" />
      </button>
      <Dialog
        open={open}
        onOpenChange={(next) => { if (!busy) setOpen(next) }}
        title="New thread from this message"
        className="w-[560px] max-w-[92vw] max-h-[82vh]"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          fieldRef.current?.focus()
        }}
        footer={
          <>
            <button type="button" onClick={() => setOpen(false)} disabled={busy} className="button-outline rounded-md px-3 py-1.5 text-[12px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-45">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy || !instructions.trim()}
              className="button-outline flex items-center gap-1.5 rounded-md bg-fg px-3 py-1.5 text-[12px] font-medium text-bg outline-none transition-opacity hover:opacity-90 disabled:opacity-45"
            >
              {busy ? "Sending…" : "Start thread"}
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-3 px-4 py-3">
          {quoted && (
            <blockquote className="line-clamp-5 whitespace-pre-wrap border-l-2 border-border-strong pl-3 text-[12px] leading-5 text-muted [overflow-wrap:anywhere]">
              {quoted}
            </blockquote>
          )}
          <textarea
            ref={fieldRef}
            value={instructions}
            maxLength={SPIN_OFF_INSTRUCTIONS_MAX}
            onChange={(e) => setInstructions(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void submit()
              }
            }}
            rows={3}
            placeholder="What should the new thread do? Fix this, investigate perf…"
            aria-label="Instructions for the new thread"
            data-1p-ignore
            className={`w-full resize-none ${BLOCK_RADIUS} border border-border bg-bg px-3 py-2 text-[13px] leading-5 text-fg outline-none placeholder:text-muted-70 focus:border-border-strong`}
          />
          <p className="text-[11px] leading-4 text-muted-75">
            This thread gathers the context from the conversation and starts the new one.
          </p>
          {error && <p role="alert" className="text-[12px] leading-4 text-danger">{error}</p>}
        </div>
      </Dialog>
    </>
  )
}

/** The request as it sits in the parent's timeline: the human's instructions, right-aligned like
 *  anything else they sent, with the thread it became beneath. */
export function SpinOffBubble({ id, instructions, excerpt, spinOffs, sourceId }: { id: string; instructions: string; excerpt: string; spinOffs: readonly SpinOffView[] | undefined; sourceId?: string }) {
  const board = useBoard()
  const edge = spinOffs?.find((o) => o.id === id)
  const child = edge?.childSlug ? threadBySlug(board, edge.childSlug) : undefined
  const childLabel = child ? displayTitle(child) : edge?.childSlug
  return (
    <div data-frizz-msg={sourceId} data-spin-off={id} className="self-end flex max-w-[85%] flex-col items-end gap-1">
      <div className={`${BLOCK_RADIUS} rounded-br-sm bg-user-bubble px-3.5 py-3 text-[14px] text-user-bubble-fg`}>
        {excerpt.trim() && (
          <p className="mb-1.5 line-clamp-2 border-l-2 border-user-bubble-fg/25 pl-2 text-[12px] leading-4 opacity-70 [overflow-wrap:anywhere]">
            {excerpt.trim()}
          </p>
        )}
        <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{instructions}</p>
      </div>
      <div className="flex items-baseline gap-1 text-[11px] leading-4 text-muted-75">
        <Split size={11} strokeWidth={2} aria-hidden className="shrink-0 translate-y-[calc(0.5em_-_0.5cap)] rotate-90 self-baseline" />
        {edge?.childSlug ? (
          <>
            <span>New thread</span>
            <a
              href={`/thread/${edge.childSlug}`}
              onClick={(e) => {
                if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
                e.preventDefault()
                openThread(edge.childSlug!)
              }}
              className="min-w-0 truncate rounded-sm text-fg/85 underline decoration-muted/30 underline-offset-2 outline-none hover:decoration-fg/60 focus-visible:ring-1 focus-visible:ring-focus-ink-60"
            >
              {childLabel}
            </a>
          </>
        ) : edge ? (
          <span>Gathering context for a new thread…</span>
        ) : (
          <span>New thread requested</span>
        )}
      </div>
    </div>
  )
}

/** The child's header line back to the thread it came from, or nothing. */
export function SpunOffFrom({ thread, lead }: { thread: ThreadView; lead?: ReactNode }) {
  const board = useBoard()
  const edge = thread.spinOffs?.find((o) => o.childSlug === thread.id)
  if (!edge) return null
  const parent = threadBySlug(board, edge.parentSlug)
  return (
    <>
      {lead}
      <span className="min-w-0 truncate">
        Spun off from{" "}
        <a
          href={`/thread/${edge.parentSlug}`}
          onClick={(e) => {
            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
            e.preventDefault()
            openThread(edge.parentSlug)
          }}
          className="rounded-sm underline decoration-muted/30 underline-offset-2 outline-none hover:text-fg hover:decoration-fg/60 focus-visible:ring-1 focus-visible:ring-focus-ink-60"
        >
          {parent ? displayTitle(parent) : edge.parentSlug}
        </a>
      </span>
    </>
  )
}
