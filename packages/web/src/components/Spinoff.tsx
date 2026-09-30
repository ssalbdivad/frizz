import { useContext, useEffect, useId, useRef, useState, type ReactNode } from "react"
import { ChevronRight, Loader2, Split } from "lucide-react"
import { SPINOFF_INSTRUCTIONS_MAX, type SpinoffView, type ThreadView } from "@frizz/shared"
import { useThreadApi, useThreadProjectDir } from "../api/threadApi.tsx"
import { displayTitle, threadHandleOf } from "../groups.ts"
import { useBoard } from "../hooks.ts"
import { draftKey, useDraft } from "../lib/drafts.ts"
import { transcriptMetaChevronClass } from "../lib/transcriptMetaLabels.ts"
import { threadBySlug } from "../store.ts"
import { ThreadHandleLink } from "./MentionLinks.tsx"
import { ThreadSlugContext } from "./threadSlugContext.ts"
import { Dialog } from "./ui/Dialog.tsx"
import { Tooltip } from "./Tooltip.tsx"
import { BLOCK_RADIUS } from "./TranscriptCard.tsx"

// SPINOFFS — a new thread the human asks for from this one ("fix this", "investigate perf"), with this
// thread supplying the context. Three surfaces, one concept:
//
//   · SpinoffButton — the icon in every thread header: each queue card's, and the drawer's and /full's.
//     It opens the one-field dialog, and the request goes to this thread's worker (the `spinoff` RPC),
//     which briefs and dispatches the new one.
//   · SpinoffCard — the request, in this thread's timeline where the human sent it: the human's
//     instructions under the `@handle` of the thread it became.
//   · SpinoffOriginCard — the same card at the other end, heading the new thread: whose spinoff it is,
//     the human's instructions, and the context the parent's worker wrote folded beneath them.
//   · SpinoffOf — the child's way back, on its header's second line (and its queue card's meta line).
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

// ── The two ends of a spinoff, as cards ────────────────────────────────────────────────────────────
//
// A DEDICATED CARD, NOT THE HUMAN'S BUBBLE (maintainer 2026-09-30, on both ends at once: "there needs to
// be a special UI affordance for referencing spinoff context … Make a dedicated spinoff header UI", and
// of the parent, "dedicated UI and link to the spinoff, much cleaner"). The request drew as the human's
// filled bubble with a small caption under it, and the child's first turn as one giant bubble holding
// the whole brief — the parent worker's words wearing the human's voice.
//
// So both ends wear one card, and it borrows exactly half of the bubble: its PLACE (right-aligned, 85%,
// the tail corner — the human asked for this) and its type size, but an OUTLINE where the bubble has a
// fill, so it reads as an action taken rather than a thing said. The two ends share the shell and the
// header row, so a reader who has seen one recognises the other as the same feature.

/** The card shell both ends share. `data-spinoff-card` names which end. */
const CARD_SHELL = `${BLOCK_RADIUS} rounded-br-sm border border-border-strong px-3.5 py-3 text-[14px] text-fg`

// THE HEADER ROW: the mark, the word, the other thread. 13px — one step under the instructions it heads
// (14px, the bubble's own size), so the human's words stay the body and the row reads as their label.
//
// `items-baseline` + the glyph's `self-baseline translate-y-[calc(0.5em_-_0.5cap)]` puts a symmetric 1em
// glyph's ink on the text's cap band in whatever font resolved (lib/transcriptMetaLabels.ts carries the
// derivation); the negative top margin stops the 1em box, which reaches above the text's ascent, from
// growing the row. The same rule every mark-beside-text in the transcript uses. Measured ink-to-cap-band
// residual, sans at 13px: -0.26px for the Split mark, the spinner and the disclosure chevron alike —
// under the device grid, so left alone.
//
// HORIZONTAL: `gap-1.5` is a BOX distance. Between "Spinoff" and the handle it draws 5.3–5.5px of ink (a
// word space, which is what it should read as), but between the mark and "Spinoff" it drew 8.25px — the
// glyph's own 1px of dead box on its right plus the S's side bearing — so the mark floated off the word
// it labels. `-mr-[0.2em]` takes the difference back, putting the three marks of the row on one even
// rhythm (scripts/ink-gaps.mjs, dsf 4, sans, 2026-09-30; the spinner in the same slot measured the same).
const HEADER_ROW = "flex min-w-0 items-baseline gap-1.5 text-[13px] leading-5 text-muted"
const HEADER_GLYPH = "size-[1em] shrink-0 self-baseline -mt-[calc(1em_-_1cap)] -mr-[0.2em] translate-y-[calc(0.5em_-_0.5cap)]"
// The other thread is the row's prominent element — the thing the card exists to point at.
const HEADER_LINK = "min-w-0 truncate rounded-sm font-medium text-fg underline decoration-muted/40 underline-offset-2 outline-none hover:decoration-fg/70 focus-visible:ring-1 focus-visible:ring-focus-ink-60"
// The instructions: verbatim, so their line breaks survive, and never allowed to push the card wide.
const BODY = "mt-1.5 whitespace-pre-wrap [overflow-wrap:anywhere]"

/** Where a spinoff request stands, as its card shows it. */
export type SpinoffCardState = "started" | "starting" | "unstarted"

/** A request with a child has started. One without is STARTING while it can still become one — its
 *  delivery is still queued, or the worker is at work (on it, or on whatever it was doing first) — and
 *  UNSTARTED once the worker has come to rest without starting it: nothing will now, and the worker's own
 *  words about why sit in the chat under the card. */
export function spinoffCardState(edge: SpinoffView | undefined, opts: { queued?: boolean; working?: boolean }): SpinoffCardState {
  if (edge?.childSlug) return "started"
  return opts.queued || opts.working ? "starting" : "unstarted"
}

/** The thread a transcript belongs to, off the board — the card's own read of the edge and of whether the
 *  worker is at work, so Message passes nothing through for it and its memo holds on every board tick. */
function useTranscriptThread(): ThreadView | undefined {
  const board = useBoard()
  return threadBySlug(board, useContext(ThreadSlugContext))
}

/** The request as it sits in the parent's timeline where the human sent it: the thread it became, and
 *  the human's instructions under it. `queued` is a delivery the worker has not read yet (the ledger's
 *  echo of the send, before the transcript has it). */
export function SpinoffCard({ id, instructions, queued, sourceId }: { id: string; instructions: string; queued?: boolean; sourceId?: string }) {
  const thread = useTranscriptThread()
  const edge = thread?.spinoffs?.find((o) => o.id === id)
  const state = spinoffCardState(edge, { queued, working: thread?.runtime === "running" || thread?.runtime === "spawning" })
  return (
    <div data-frizz-msg={sourceId} data-spinoff={id} data-spinoff-card="request" data-spinoff-state={state} className="self-end flex min-w-0 max-w-[85%] flex-col">
      <div className={CARD_SHELL}>
        <div className={HEADER_ROW}>
          {/* STARTING, the mark's own slot spins — one glyph that changes, rather than a spinner added
              beside the mark that then has to be spaced and aligned against it. */}
          {state === "starting"
            ? <Loader2 aria-hidden className={`${HEADER_GLYPH} animate-spin`} />
            : <SpinoffMark size={14} className={HEADER_GLYPH} />}
          <span className="shrink-0">Spinoff</span>
          {state === "started" ? (
            <ThreadHandleLink slug={edge!.childSlug!} className={HEADER_LINK} />
          ) : (
            <span data-spinoff-pending className="min-w-0 truncate text-muted-70">{state === "starting" ? "starting…" : "didn't start"}</span>
          )}
        </div>
        <p className={BODY}>{instructions}</p>
      </div>
    </div>
  )
}

/** The head of a spinoff child's transcript: whose spinoff it is, what the human asked for, and — folded,
 *  one click away — the context the parent's worker gathered. `context` is that brief already rendered
 *  (the transcript's markdown renderer, which lives in ChatView). */
export function SpinoffOriginCard({ instructions, context, sourceId }: { instructions: string; context: ReactNode; sourceId?: string }) {
  const thread = useTranscriptThread()
  const edge = thread?.spinoffs?.find((o) => o.childSlug === thread.id)
  const board = useBoard()
  const parent = edge ? threadBySlug(board, edge.parentSlug) : undefined
  const parentHandle = parent ? threadHandleOf(parent) : undefined
  // The disclosure names the parent as TEXT: a link inside the toggle would be a control inside a control,
  // and the header right above it already links the thread.
  const parentName = parentHandle ? `@${parentHandle}` : parent ? displayTitle(parent) : edge ? edge.parentSlug : undefined
  const [open, setOpen] = useState(false)
  const contextId = useId()
  return (
    <div data-frizz-msg={sourceId} data-spinoff-card="origin" className="self-end flex min-w-0 max-w-[85%] flex-col">
      <div className={CARD_SHELL}>
        <div className={HEADER_ROW}>
          <SpinoffMark size={14} className={HEADER_GLYPH} />
          {edge ? (
            <>
              <span className="shrink-0">Spinoff of</span>
              <ThreadHandleLink slug={edge.parentSlug} className={HEADER_LINK} />
            </>
          ) : (
            <span className="shrink-0">Spinoff</span>
          )}
        </div>
        <p className={BODY}>{instructions}</p>
        {/* THE BRIEF, FOLDED. It is the parent worker's cold start for this thread — often thousands of
            characters — and the human already knows what it says, having been in that conversation; the
            instructions above are the part they wrote. Collapsed it is one quiet line, the transcript's
            own disclosure (label, then the chevron, as `Ran N tool calls ›` reads); open, the ruled muted
            aside another agent's words wear everywhere else in the chat (PeerSessionMessageLine). A child
            whose parent wrote no brief has nothing to fold, and no disclosure. */}
        {context != null && (
        <div className="mt-2.5 border-t border-border/60 pt-2">
          <button
            type="button"
            data-spinoff-context-toggle
            aria-expanded={open}
            aria-controls={contextId}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setOpen((v) => !v)}
            className="group flex max-w-full min-w-0 items-baseline gap-1.5 rounded-sm text-left text-[13px] leading-5 text-muted outline-none transition-colors hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60"
          >
            <span className="min-w-0 truncate">{parentName ? `Context from ${parentName}` : "Context"}</span>
            <ChevronRight aria-hidden size={13} className={transcriptMetaChevronClass(open)} />
          </button>
          {open ? (
            <div id={contextId} data-spinoff-context className="card-md mt-2 border-l border-border/70 pl-3 text-muted">
              {context}
            </div>
          ) : <div id={contextId} hidden />}
        </div>
        )}
      </div>
    </div>
  )
}

/** The child's header line back to the thread it came from, or nothing. On a queue card of another
 *  project the card passes its own `resolve`, `href` and `onOpen`: the page's board is not that
 *  project's. `compact` is the queue card's form — see below. */
export function SpinoffOf({ thread, lead, resolve, href, onOpen, compact = false }: {
  thread: ThreadView
  lead?: ReactNode
  resolve?: (slug: string) => ThreadView | undefined
  href?: (slug: string) => string
  onOpen?: (slug: string) => void
  compact?: boolean
}) {
  const edge = thread.spinoffs?.find((o) => o.childSlug === thread.id)
  if (!edge) return null
  const parentSlug = edge.parentSlug
  const link = (
    <ThreadHandleLink
      slug={parentSlug}
      thread={resolve ? resolve(parentSlug) ?? null : undefined}
      href={href?.(parentSlug)}
      onOpen={onOpen ? () => onOpen(parentSlug) : undefined}
      className={`${compact ? "min-w-0 truncate " : ""}rounded-sm underline decoration-muted/30 underline-offset-2 outline-none hover:text-fg hover:decoration-fg/60 focus-visible:ring-1 focus-visible:ring-focus-ink-60`}
    />
  )
  return (
    <>
      {lead}
      {/* BEFORE the status line, never after it: that line is `flex-1` so it can take whatever the row
          has left, and anything placed after it was pushed to the far end of the row with a hole in
          front of it. Capped so a long handle truncates before the live status does. */}
      {compact ? (
        // THE QUEUE CARD'S FORM: the mark stands for the words. The card's meta line already carries the
        // ready time and the live status, and at a phone's 420px the full "Spinoff of @handle" left the
        // status one letter and an ellipsis (screenshot 2026-09-30). The mark is the one every spinoff
        // surface wears — the same glyph as the Spinoff button at the other end of this card's header —
        // and the words stay for a screen reader and on hover. The row is `items-baseline`, so the
        // glyph takes the cap-band rule every mark-beside-text uses. Horizontally it keeps MORE room than
        // the cards' header glyph: the handle beside it is underlined from its first pixel, and at the
        // cards' 0.2em trim (3.2px of ink to the `@`) the underline read as touching the mark's arrow.
        // At 0.1em: 4.3px, measured by geometry (the glyph's path boxes against the text's canvas ink),
        // sans 11px, 2026-09-30.
        <span data-spinoff-of={parentSlug} title="Spinoff of" className="flex min-w-0 max-w-[40%] shrink-0 items-baseline gap-1">
          <SpinoffMark size={11} className="size-[1em] self-baseline -mr-[0.1em] translate-y-[calc(0.5em_-_0.5cap)]" />
          <span className="sr-only">Spinoff of </span>
          {link}
        </span>
      ) : (
        <span data-spinoff-of={parentSlug} className="min-w-0 max-w-[50%] shrink-0 truncate">
          Spinoff of {link}
        </span>
      )}
    </>
  )
}
