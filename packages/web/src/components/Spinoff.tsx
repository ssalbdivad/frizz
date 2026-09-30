import { useEffect, useRef, useState, type ReactNode } from "react"
import { Loader2, Split } from "lucide-react"
import { SPINOFF_INSTRUCTIONS_MAX, type SpinoffView, type ThreadView } from "@frizz/shared"
import { useThreadApi, useThreadProjectDir } from "../api/threadApi.tsx"
import { displayTitle } from "../groups.ts"
import { useBoard } from "../hooks.ts"
import { draftKey, useDraft } from "../lib/drafts.ts"
import { openThread, threadBySlug } from "../store.ts"
import { Dialog } from "./ui/Dialog.tsx"
import { Tooltip } from "./Tooltip.tsx"
import { BLOCK_RADIUS } from "./TranscriptCard.tsx"

// SPINOFFS — a new thread the human asks for from this one ("fix this", "investigate perf"), with this
// thread supplying the context. Three surfaces, one concept:
//
//   · SpinoffButton — the icon in every thread header: each queue card's, and the drawer's and /full's.
//     It opens the one-field dialog, and the request goes to this thread's worker (the `spinoff` RPC),
//     which briefs and dispatches the new one.
//   · SpinoffBubble — the request, in this thread's timeline where the human sent it, and the link to the
//     thread it became once the worker has started it.
//   · SpinoffOf — the child's way back, on its header's second line.
//
// A spinoff belongs to the THREAD. On its first day (2026-09-29) it was a hover action on every message,
// quoting the one it was clicked from; the maintainer moved it to the thread that evening. The human
// writes instructions either way, and those say what to spin off — so a control on every row bought
// only a quote. It went into the ⋯ menu first, then straight out onto the header strip (maintainer:
// "spinoff should appear on every card and in the drawer without having to expand"). "Spinoff" is one
// word, verb and noun alike.
//
// The server holds the edge (`thread_spinoff`, carried on ThreadView.spinoffs at both ends), so every
// surface reads the same row and none of them has to find the other thread in a transcript.

/** The mark every spinoff surface wears: lucide's Split turned to branch sideways. */
function SpinoffMark({ size, className = "" }: { size: number; className?: string }) {
  return <Split size={size} strokeWidth={2} aria-hidden className={`shrink-0 rotate-90 ${className}`} />
}

/** Whether a thread can be asked for a spinoff: a live Frizz session, whose worker is the one that briefs
 *  the new thread. A foreign row has no worker of ours. */
function canSpinoff(thread: ThreadView | undefined): thread is ThreadView & { sessionId: string } {
  return Boolean(thread && thread.kind === "session" && thread.foreign !== true && thread.sessionId)
}

/** The Spinoff icon in a thread's header strip, and its dialog; nothing for a thread that cannot take one.
 *  `className` is the strip's own icon class (HEADER_ICON_CLASS, plus whatever trim its place asks for).
 *  A queue card of another project must render this inside that project's ThreadProjectScope, or the
 *  request would go to the focused project's thread of the same slug. */
export function SpinoffButton({ thread, className }: { thread: ThreadView; className: string }) {
  const [open, setOpen] = useState(false)
  if (!canSpinoff(thread)) return null
  return (
    <>
      <SpinoffDialog thread={thread} open={open} onOpenChange={setOpen} />
      <Tooltip label="Spinoff a new thread from this one">
        <button
          type="button"
          aria-label="Spinoff"
          data-spinoff-button={thread.id}
          // The strip's shared focus behaviour: a click here must not take the keyboard away from the
          // prompt box below it.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setOpen(true)}
          className={className}
        >
          <SpinoffMark size={14} />
        </button>
      </Tooltip>
    </>
  )
}

/** The dialog behind SpinoffButton: one field, the instructions. The draft is kept per thread, so a
 *  dialog closed by accident reopens on what was typed. */
function SpinoffDialog({ thread, open, onOpenChange }: { thread: ThreadView & { sessionId: string }; open: boolean; onOpenChange: (open: boolean) => void }) {
  const api = useThreadApi()
  const projectDir = useThreadProjectDir()
  const [instructions, setInstructions, clearInstructions] = useDraft(draftKey.spinoff(projectDir, thread.id))
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (!open) setError(null)
  }, [open])

  function submit() {
    const text = instructions.trim()
    if (!text || pending) return
    setPending(true)
    setError(null)
    api.spinoff({ slug: thread.id, sessionId: thread.sessionId, instructions: text })
      .then(() => {
        clearInstructions()
        onOpenChange(false)
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setPending(false))
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!pending) onOpenChange(next) }}
      title="Spinoff"
      className="w-[460px] max-w-[92vw]"
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        fieldRef.current?.focus()
      }}
      footer={
        <>
          <button
            type="button"
            disabled={pending}
            onClick={() => onOpenChange(false)}
            className="button-outline rounded-md px-3 py-1.5 text-[12px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-45"
          >
            Cancel
          </button>
          <button
            type="button"
            data-spinoff-submit
            disabled={pending || !instructions.trim()}
            onClick={submit}
            className="button-outline flex items-center gap-1.5 rounded-md bg-fg px-3 py-1.5 text-[12px] font-medium text-bg outline-none transition-opacity hover:opacity-90 disabled:opacity-45"
          >
            {pending && <Loader2 size={12} className="animate-spin" />}
            Spinoff
          </button>
        </>
      }
    >
      <div data-spinoff-dialog className="flex flex-col gap-1.5 p-4">
        <textarea
          ref={fieldRef}
          data-spinoff-instructions
          value={instructions}
          maxLength={SPINOFF_INSTRUCTIONS_MAX}
          onChange={(e) => setInstructions(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          rows={3}
          placeholder="What should the new thread do?"
          aria-label="What the new thread should do"
          data-1p-ignore
          className={`w-full resize-none ${BLOCK_RADIUS} border border-border bg-bg px-3 py-2 text-[13px] leading-5 text-fg outline-none transition-colors placeholder:text-muted focus:border-accent`}
        />
        {error
          ? <p role="alert" className="text-[11px] leading-4 text-danger">{error}</p>
          : <p className="text-[11px] leading-4 text-muted-60">It starts with this thread's context.</p>}
      </div>
    </Dialog>
  )
}

/** The request as it sits in the parent's timeline: the human's instructions, right-aligned like
 *  anything else they sent, with the thread it became beneath. */
export function SpinoffBubble({ id, instructions, spinoffs, sourceId }: { id: string; instructions: string; spinoffs: readonly SpinoffView[] | undefined; sourceId?: string }) {
  const board = useBoard()
  const edge = spinoffs?.find((o) => o.id === id)
  const child = edge?.childSlug ? threadBySlug(board, edge.childSlug) : undefined
  const childLabel = child ? displayTitle(child) : edge?.childSlug
  return (
    <div data-frizz-msg={sourceId} data-spinoff={id} className="self-end flex max-w-[85%] flex-col items-end gap-1">
      <div className={`${BLOCK_RADIUS} rounded-br-sm bg-user-bubble px-3.5 py-3 text-[14px] text-user-bubble-fg`}>
        <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{instructions}</p>
      </div>
      <div className="flex min-w-0 max-w-full items-baseline gap-1 text-[11px] leading-4 text-muted-75">
        <SpinoffMark size={11} className="translate-y-[calc(0.5em_-_0.5cap)] self-baseline" />
        {edge?.childSlug ? (
          <>
            <span className="shrink-0">Spinoff</span>
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
        ) : (
          <span>{edge ? "Spinoff starting…" : "Spinoff"}</span>
        )}
      </div>
    </div>
  )
}

/** The child's header line back to the thread it came from, or nothing. */
export function SpinoffOf({ thread, lead }: { thread: ThreadView; lead?: ReactNode }) {
  const board = useBoard()
  const edge = thread.spinoffs?.find((o) => o.childSlug === thread.id)
  if (!edge) return null
  const parent = threadBySlug(board, edge.parentSlug)
  return (
    <>
      {lead}
      <span className="min-w-0 truncate">
        Spinoff of{" "}
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
