import { useContext, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react"
import { ArrowRight, Check, ChevronDown, ChevronRight, Loader2, Split } from "lucide-react"
import { useQuery } from "@tanstack/react-query"
import { type ProjectCard, type SpinoffView, type ThreadView } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { readProjectsQueues } from "../lib/projectsQueuesRead.ts"
import { useThreadApi, useThreadProjectDir } from "../api/threadApi.tsx"
import { stepPick } from "../lib/crossProject.ts"
import { useShortcutLabel, withShortcut } from "../lib/keyboardRuntime.ts"
import { PROJECT_STEP_CHORDS, detectPlatform, formatChord, parseChord } from "../lib/keybindings.ts"
import { mentionHref } from "../lib/mentionAutolink.ts"
import { spaNavigate } from "../lib/router.ts"
import { displayTitle, threadHandleOf } from "../groups.ts"
import { useBoard } from "../hooks.ts"
import { draftKey, draftStore, useDraft } from "../lib/drafts.ts"
import { useUnqueueFollowUp, useUnqueueSupported } from "../lib/unqueueFollowUp.ts"
import { transcriptMetaChevronClass } from "../lib/transcriptMetaLabels.ts"
import { showToast, threadBySlug } from "../store.ts"
import { ThreadHandleLink } from "./MentionLinks.tsx"
import { ThreadSlugContext } from "./threadSlugContext.ts"
import { ProjectSquare } from "./ProjectSquare.tsx"
import { Dialog } from "./ui/Dialog.tsx"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "./ui/Menu.tsx"
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
 *  the new thread. A foreign row has no worker of ours, and neither does a lazy thread that has not started. */
function canSpinoff(thread: ThreadView | undefined): thread is ThreadView & { sessionId: string } {
  return Boolean(thread && thread.kind === "session" && thread.foreign !== true && thread.lazyPrompt === undefined && thread.sessionId)
}

/** The Spinoff icon in a thread's header strip, and its dialog; nothing for a thread that cannot take one.
 *  `className` is the strip's own icon class (HEADER_ICON_CLASS, plus whatever trim its place asks for).
 *  A queue card of another project must render this inside that project's ThreadProjectScope, or the
 *  request would go to the focused project's thread of the same slug. */
export function SpinoffButton({ thread, className }: { thread: ThreadView; className: string }) {
  const [open, setOpen] = useState(false)
  const keys = useShortcutLabel("thread.spinoff")
  if (!canSpinoff(thread)) return null
  return (
    <>
      <SpinoffDialog thread={thread} open={open} onOpenChange={setOpen} />
      <Tooltip label={withShortcut("Spinoff a new thread from this one", keys)}>
        <button
          type="button"
          aria-label="Spinoff"
          data-spinoff-button={thread.id}
          // `→` on this surface presses it (lib/keyboardRuntime.ts).
          data-command="spinoff"
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
  // WHERE THE NEW THREAD STARTS (2026-09-30: "spinoff threads should be able to be created cross
  // project"). This thread's project unless the human picks another open one; undefined is "here".
  const projects = useOpenProjects(open)
  const home = projects.find((p) => p.dir === projectDir)
  const [targetId, setTargetId] = useState<string | undefined>(undefined)
  const target = targetId && targetId !== home?.id ? projects.find((p) => p.id === targetId) : undefined
  useEffect(() => {
    if (!open) {
      setError(null)
      setTargetId(undefined)
    }
  }, [open])

  // ⌥↓ / ⌥↑ — the next or previous project, as in the new-thread box (AllQueues.tsx onColumnKeyDown):
  // the same list order, wrapping at either end, and the key stays the browser's when there is nowhere
  // else to go. Read off the document for as long as the dialog is up, not off the field, so the chord
  // still steps after a click has moved focus to a footer button or the dialog's own body. Capture
  // phase, and stopped there, so nothing behind the modal reads the same chord.
  useEffect(() => {
    if (!open || !home || pending || projects.length < 2) return
    const from = (target ?? home).slug
    function onKeyDown(event: KeyboardEvent) {
      const step = projectStep(event)
      if (!step) return
      const next = stepPick(projects.map((p) => ({ ...p, open: true, stale: false })), from, step)
      if (!next) return
      event.preventDefault()
      event.stopPropagation()
      setTargetId(next.id)
    }
    document.addEventListener("keydown", onKeyDown, true)
    return () => document.removeEventListener("keydown", onKeyDown, true)
  }, [open, home, pending, projects, target])

  function submit() {
    const text = instructions.trim()
    if (!text || pending) return
    setPending(true)
    setError(null)
    api.spinoff({ slug: thread.id, sessionId: thread.sessionId, instructions: text, ...(target ? { project: target.id } : {}) })
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
          {/* Only where there is somewhere else to start: one open project has nothing to choose. */}
          {home && projects.length > 1 && (
            <SpinoffProjectRoute from={home} projects={projects} current={target ?? home} disabled={pending} onPick={(p) => setTargetId(p.id)} />
          )}
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
          : <p className="text-[11px] leading-4 text-muted-60">{target ? `It starts in ${target.name}, with this thread's context.` : "It starts with this thread's context."}</p>}
      </div>
    </Dialog>
  )
}

const PROJECT_STEP_KEYS = [PROJECT_STEP_CHORDS.previous, PROJECT_STEP_CHORDS.next].map((chord) => formatChord(parseChord(chord)!, detectPlatform())).join("/")

/** ⌥↓ is a step down the project menu, ⌥↑ one up; 0 for any other key. The new-thread box's own reading
 *  of the chord (AllQueues.tsx projectStep). */
function projectStep(event: KeyboardEvent): 1 | -1 | 0 {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing || event.defaultPrevented) return 0
  return event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0
}

/** A project this server has OPEN — the only kind a spinoff can start in (the server refuses the rest). */
interface OpenProject { id: string; slug: string; name: string; dir: string; card: ProjectCard; threads: readonly ThreadView[] }

/** Every open project, from the machine-wide polls the All projects page already runs (same keys, so
 *  one fetch serves both). Joined with the project list for each one's icon; the Home workspace last. */
function useOpenProjects(enabled: boolean): OpenProject[] {
  const queues = useQuery({ queryKey: ["projectsQueues"], queryFn: readProjectsQueues, enabled, staleTime: 5_000 })
  const cards = useQuery({ queryKey: ["projectsList"], queryFn: () => rpc.projectsList(), enabled })
  const out: OpenProject[] = []
  for (const q of queues.data ?? []) {
    const card = cards.data?.find((c) => c.id === q.projectId)
    if (card?.stale) continue
    out.push({
      id: q.projectId, slug: q.projectSlug, name: card?.name ?? q.projectName, dir: q.projectDir, threads: q.threads,
      card: card ?? { id: q.projectId, slug: q.projectSlug, name: q.projectName, path: q.projectDir, lastOpenedAt: "", stale: false, iconStatus: "unknown" },
    })
  }
  // The project list's own order — the prompt box's picker and its ⌥↑/⌥↓ walk the same one.
  const rank = (p: OpenProject) => { const i = cards.data?.findIndex((c) => c.id === p.id) ?? -1; return i === -1 ? Infinity : i }
  out.sort((a, b) => rank(a) - rank(b))
  return [...out.filter((p) => !p.card.home), ...out.filter((p) => p.card.home)]
}

/** The dialog's "start in" pill: the footer's left end, in the footer buttons' own chrome and size, so it
 *  reads as a setting of the request rather than a third action. Ink gaps (sans 12px, scripts/ink-gaps.mjs,
 *  2026-09-30): square→name at `gap-[5px]` to match the prompt box's project picker (it drew 6.50px at
 *  `gap-1.5`); name→chevron 6.31px against that picker's 6.00px, left alone. */
/** FROM → INTO, at the footer's left end: this thread's project, then where the new thread starts (the
 *  picker, this project by default). A spinoff carries context ONE way, out of this thread into the new
 *  one, so the arrow points at the destination — the reading order, source first. A left-pointing merge
 *  arrow (GitHub's `base ← compare`) would say the chosen project flows back into this one. The source is
 *  plain text, not a control: it is a fact about this thread, and only the destination is a choice. */
function SpinoffProjectRoute({ from, ...picker }: { from: OpenProject } & Parameters<typeof SpinoffProjectPicker>[0]) {
  return (
    <div data-spinoff-route className="flex min-w-0 flex-1 items-center gap-1.5 text-[12px] text-muted">
      <span data-spinoff-from={from.slug} title={`From ${from.name}`} className="flex min-w-0 max-w-[45%] shrink-0 items-center gap-[5px]">
        <ProjectSquare project={from.card} size={12} />
        <span className="min-w-0 truncate">{from.name}</span>
      </span>
      {/* The arrow's box is mostly dead space: at `gap-1.5` alone it drew 9.06px of ink after the name and
          8.00px before the pill's border (scripts/ink-gaps.mjs, sans 12px, 2026-09-30). The margins take
          both to ~6px, so it sits evenly between the two ends it joins. */}
      <ArrowRight size={12} aria-label="into" className="-ml-[0.25em] -mr-[0.17em] shrink-0 text-muted-60" />
      <SpinoffProjectPicker {...picker} />
    </div>
  )
}

function SpinoffProjectPicker({ projects, current, disabled, onPick }: {
  projects: OpenProject[]
  current: OpenProject
  disabled: boolean
  onPick: (project: OpenProject) => void
}) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          data-spinoff-project={current.slug}
          aria-label={`The new thread starts in ${current.name}. Choose a project`}
          title={`The new thread starts in ${current.name} (${PROJECT_STEP_KEYS} in the field)`}
          className="button-outline flex min-w-0 shrink items-center gap-[5px] rounded-md px-2.5 py-1.5 text-[12px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-45 data-[state=open]:bg-panel-2 data-[state=open]:text-fg"
        >
          <ProjectSquare project={current.card} size={12} />
          <span className="min-w-0 truncate">{current.name}</span>
          <ChevronDown size={12} aria-hidden className="-ml-[3px] shrink-0 text-fg/65" />
        </button>
      </MenuTrigger>
      <MenuContent align="start" aboveDialog>
        <div className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-medium text-muted-55">Start in</div>
        <div className="max-h-[min(60vh,420px)] overflow-y-auto">
          {projects.map((project) => (
            <MenuItem key={project.id} value={project.slug} onSelect={() => onPick(project)} icon={<ProjectSquare project={project.card} size={14} />}>
              <span className={`min-w-0 flex-1 truncate ${project.id === current.id ? "text-fg" : ""}`}>{project.name}</span>
              {project.id === current.id && <Check size={12} aria-label="Current" className="shrink-0 text-fg" />}
            </MenuItem>
          ))}
        </div>
      </MenuContent>
    </Menu>
  )
}

type FarEnd = NonNullable<ReturnType<typeof useFarEnd>>

/** What a far end is called when its thread is not among the open threads the poll carries (it is done,
 *  or the poll has not landed yet). */
function farFallback(far: FarEnd): string {
  return far.projectName ? `a thread in ${far.projectName}` : "a thread in another project"
}

/** A spinoff's other thread: the board's own link for an end in this project (`projectId` undefined); for
 *  one in another, that project's thread and address (CrossProjectEnd). */
function SpinoffEndLink({ slug, projectId, className = HEADER_LINK, named = true }: { slug: string; projectId: string | undefined; className?: string; named?: boolean }) {
  return projectId
    ? <CrossProjectEnd slug={slug} projectId={projectId} className={className} named={named} />
    : <ThreadHandleLink slug={slug} className={className} />
}

/** Its own component so the machine-wide lookup mounts only for a cross-project edge — a surface drawing a
 *  same-project one may have no query client. The project is named after a resolved handle, since the
 *  handle alone could be a thread of this one; a project not open here has no address, so it is text. */
function CrossProjectEnd({ slug, projectId, className, named }: { slug: string; projectId: string; className: string; named: boolean }) {
  const far = useFarEnd(projectId, slug)!
  if (!far.href) return <span className="min-w-0 truncate">{farFallback(far)}</span>
  return (
    <>
      <ThreadHandleLink slug={slug} thread={far.thread} href={far.href} onOpen={far.onOpen} fallback={farFallback(far)} className={className} />
      {/* The underlined link's ink runs to its box edge, so the row's gap drew 6.98px of ink before "in"
          where the row's other word spaces draw ~5.4px; the margin takes the difference back. */}
      {named && far.thread && <span className="-ml-[0.115em] min-w-0 shrink truncate">in {far.projectName}</span>}
    </>
  )
}

/** The link to a spinoff's far end when it is in ANOTHER project (SpinoffView.parentProjectId /
 *  childProjectId): that project's thread off the machine-wide poll, and its address there, opened in
 *  place as a cross-project mention is. Undefined for an end in this project. */
function useFarEnd(projectId: string | undefined, slug: string | null | undefined) {
  const projects = useOpenProjects(projectId !== undefined)
  if (!projectId || !slug) return undefined
  const project = projects.find((p) => p.id === projectId)
  if (!project) return { thread: null, projectName: undefined, href: undefined, onOpen: undefined }
  const href = mentionHref(slug, undefined, project.slug)
  return { thread: project.threads.find((t) => t.id === slug) ?? null, projectName: project.name, href, onOpen: () => spaNavigate(href) }
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
export type SpinoffCardState = "started" | "starting" | "waiting" | "unconfirmed" | "unstarted" | "detached"

/** What the card reads a request's standing from: the edge, the delivery ledger's state for the send
 *  (while the ledger still holds it), and the parent thread's live reading. */
export interface SpinoffCardInputs {
  /** The ledger's state for the send, present only until the transcript's own record takes over. */
  deliveryState?: "pending" | "enqueued" | "delivered" | "unconfirmed"
  /** The send is still waiting to be read (the ledger's `queued`, or the transcript's enqueue record). */
  queued?: boolean
  runtime?: ThreadView["runtime"]
  /** The turn is paused on a decision only the human can make — a typed interaction or a native ask. */
  blocked?: boolean
  /** A later message reached the thread after this request, so the thread's LIVE reading (running,
   *  blocked) is about some later turn, not the one this request was in. */
  superseded?: boolean
  /** The thread's board row carries its spinoff edges, but none for this request — the row is gone. */
  edgeGone?: boolean
}

/** A request with a child has STARTED. One without says "didn't start" ONLY once the worker has genuinely
 *  finished a turn after receiving it without starting it — every earlier moment is some other state:
 *
 *   · UNCONFIRMED — the ledger found no receipt from the worker inside its window. Nothing is in progress,
 *     and nothing proves it failed either, so it says exactly that, as the human's own bubble does
 *     ("Delivery unconfirmed"). Before 2026-09-30's review this read as STARTING — a spinner for the hour
 *     the ledger keeps an unconfirmed send, then the card simply vanished.
 *   · WAITING — the turn the request is in (or queued behind) is paused on the human: a permission
 *     prompt, a typed interaction, a native ask. Neither "starting…" (nothing is moving) nor "didn't
 *     start" (the turn has not ended — the human may re-request and get two threads). Ahead of the
 *     running check because a Codex approval reads `running` and `actionableInteraction` together.
 *   · STARTING — still able to become one: the ledger holds the send (pending or enqueued, or `delivered`:
 *     the provider took it straight into a turn whose record is not on disk yet, which the tailer still
 *     reads as idle — the "didn't start" flash the review caught), or the worker is at work.
 *  The worker's own words about an unstarted request sit in the chat under the card, and so does the
 *  call it made, when that call failed (lib/spinoffCalls.ts). */
//
//  Two readings sit outside that order (review, 2026-09-30):
//   · SUPERSEDED — a later message reached the thread after this request, so its turn is over and the live
//     runtime is about a LATER turn. An old request with no child is then "didn't start" whatever the
//     thread is doing now; without this, every old unstarted card in the transcript turned "starting…"
//     or "waiting on you" whenever a later turn ran or stopped on an approval.
//   · DETACHED — the board row lists the thread's spinoffs and this request is not among them: the row is
//     gone, which in practice means its child was forgotten (storage drops the edge with the child so a
//     thread that later reuses the slug is not mistaken for it). The card then states only that it was a
//     spinoff — not "didn't start", which would be false, and no link to a thread that no longer exists.
export function spinoffCardState(edge: SpinoffView | undefined, opts: SpinoffCardInputs): SpinoffCardState {
  if (edge?.childSlug) return "started"
  if (opts.deliveryState === "unconfirmed") return "unconfirmed"
  if (opts.queued || opts.deliveryState !== undefined) return opts.blocked || opts.runtime === "perm-prompt" ? "waiting" : "starting"
  if (!edge && opts.edgeGone) return "detached"
  if (opts.superseded) return "unstarted"
  if (opts.blocked || opts.runtime === "perm-prompt") return "waiting"
  return opts.runtime === "running" || opts.runtime === "spawning" ? "starting" : "unstarted"
}

/** The words each state without a child reads. */
const PENDING_LABEL: Record<Exclude<SpinoffCardState, "started">, string> = {
  starting: "starting…",
  waiting: "waiting on you",
  unconfirmed: "delivery unconfirmed",
  unstarted: "didn't start",
  detached: "",
}

/** The thread a transcript belongs to, off the board — the card's own read of the edge and of whether the
 *  worker is at work, so Message passes nothing through for it and its memo holds on every board tick. */
function useTranscriptThread(): ThreadView | undefined {
  const board = useBoard()
  return threadBySlug(board, useContext(ThreadSlugContext))
}

/** The request as it sits in the parent's timeline where the human sent it: the thread it became, and
 *  the human's instructions under it. `queued`, `deliveryState` and `deliveryId` are the delivery ledger's
 *  word on the send (the ledger's echo of it, or the transcript's enqueue record it tagged), and `rawText`
 *  the message's own text, which the transcript cache is keyed on for a take-back. */
export function SpinoffCard({ id, instructions, at, queued, deliveryState, deliveryId, rawText, sourceId }: {
  id: string
  instructions: string
  /** When the request reached the worker (the transcript record's instant); absent while the ledger holds it. */
  at?: string
  queued?: boolean
  deliveryState?: SpinoffCardInputs["deliveryState"]
  deliveryId?: string
  rawText?: string
  sourceId?: string
}) {
  const thread = useTranscriptThread()
  const edge = thread?.spinoffs?.find((o) => o.id === id)
  const state = spinoffCardState(edge, {
    queued,
    deliveryState,
    runtime: thread?.runtime,
    blocked: thread?.actionableInteraction === true || thread?.pendingAsk !== undefined,
    // The request itself reads as the human speaking, so the thread's newest human instant IS this request
    // until something later arrives. ISO instants from the same transcript compare as strings.
    superseded: at !== undefined && thread?.lastUserAt !== undefined && thread.lastUserAt > at,
    edgeGone: thread?.spinoffs !== undefined,
  })
  // TAKE IT BACK (2026-09-30, review). A request still in the parent's queue can be withdrawn exactly as a
  // queued human bubble can (ChatView UserBubble, lib/unqueueFollowUp.ts) — the same gates, the same click,
  // the same truthfulness: the card goes only once the provider confirms the send left its queue, and the
  // server drops the pending request with it (router.ts unqueueFollowUp), so no card is left standing for
  // a request nothing will answer. When the request drew as a gray bubble this came for free; the card
  // took it away, and the server's half had no way in.
  //
  // What differs is where the words go back to: the Spinoff dialog, not the prompt box. From the prompt
  // box they would be sent as an ordinary message to THIS thread, which is not what the human asked for.
  // The dialog they reopen is the header's own (the nearest `[data-spinoff-button]` above the card, the
  // way focusComposerNear finds its composer), resolved at click time because the card unmounts the moment
  // the take-back lands. A surface with no such button gets the words back in the dialog's draft all the
  // same, and a toast says where.
  const slug = useContext(ThreadSlugContext)
  const projectDir = useThreadProjectDir()
  const unqueueSupported = useUnqueueSupported(slug)
  const { unqueue, pending: unqueuePending } = useUnqueueFollowUp(slug)
  const unqueueable = Boolean(queued && deliveryId && slug && unqueueSupported && state !== "started")
  const takeBack = (from: HTMLElement) => {
    if (window.getSelection()?.toString()) return
    const button = spinoffButtonNear(from, slug!)
    unqueue({
      deliveryId: deliveryId!,
      text: instructions,
      rawText: rawText ?? instructions,
      from,
      restore: () => {
        const key = draftKey.spinoff(projectDir, slug!)
        const existing = draftStore.get(key)
        draftStore.set(key, existing && existing !== instructions ? `${instructions}\n\n${existing}` : instructions)
        if (button?.isConnected) button.click()
        else showToast("Spinoff taken back. Its instructions are in the Spinoff dialog.")
      },
    })
  }
  return (
    <div data-frizz-msg={sourceId} data-spinoff={id} data-spinoff-card="request" data-spinoff-state={state} className="self-end flex min-w-0 max-w-[85%] flex-col">
      <div
        {...(unqueueable ? {
          role: "button",
          tabIndex: 0,
          "data-unqueue": deliveryId,
          "aria-label": "Take back this spinoff request",
          title: unqueuePending ? "Taking it back…" : undefined,
          onClick: (e: ReactMouseEvent<HTMLDivElement>) => takeBack(e.currentTarget),
          onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => {
            if (e.key !== "Enter" && e.key !== " ") return
            e.preventDefault()
            takeBack(e.currentTarget)
          },
        } : {})}
        // QUEUED READS AS THE BUBBLE DOES: half opacity is the transcript's one channel for "the worker has
        // not read this yet", and a take-back-able one lifts to full under the pointer — the bubble's own
        // hover language (see UserBubble), so the two things you can take back look alike. Not when
        // UNCONFIRMED: the bubble puts its warning OUTSIDE its dimmed fill, and this card's warning is its
        // own header, which at half opacity read as a muddy olive nobody would take for a warning.
        className={`${CARD_SHELL} ${queued && (state === "starting" || state === "waiting") ? "opacity-50" : ""} ${unqueueable ? "cursor-pointer transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg" : ""} ${unqueuePending ? "!opacity-30" : ""}`}
      >
        <div className={HEADER_ROW}>
          {/* STARTING, the mark's own slot spins — one glyph that changes, rather than a spinner added
              beside the mark that then has to be spaced and aligned against it. */}
          {state === "starting"
            ? <Loader2 aria-hidden className={`${HEADER_GLYPH} animate-spin`} />
            : <SpinoffMark size={14} className={HEADER_GLYPH} />}
          <span className="shrink-0">Spinoff</span>
          {state === "started" ? (
            <SpinoffEndLink slug={edge!.childSlug!} projectId={edge!.childProjectId} />
          ) : state === "detached" ? null : (
            // Unconfirmed wears the attention tone the bubble's own "Delivery unconfirmed" line does: it is
            // the one state the human may need to act on (send it again), and the only one that is a warning.
            <span data-spinoff-pending className={`min-w-0 truncate ${state === "unconfirmed" ? "text-attention-80" : "text-muted-70"}`}>{PENDING_LABEL[state]}</span>
          )}
        </div>
        <p className={BODY}>{instructions}</p>
      </div>
      {/* Only the in-flight take-back gets a line ("did my click land?"), reserving no layout — the bubble's
          rule, for the bubble's reason. */}
      {unqueueable && unqueuePending && (
        <div aria-hidden className="h-0 self-end overflow-visible text-[11px] text-muted">Taking it back…</div>
      )}
    </div>
  )
}

/** The Spinoff button of the surface `from` sits in: the nearest ancestor holding one for `slug`. */
function spinoffButtonNear(from: HTMLElement, slug: string): HTMLButtonElement | null {
  for (let node: HTMLElement | null = from; node; node = node.parentElement) {
    const button = node.querySelector<HTMLButtonElement>(`[data-spinoff-button="${CSS.escape(slug)}"]`)
    if (button) return button
  }
  return null
}

/** The head of a spinoff child's transcript: whose spinoff it is, what the human asked for, and — folded,
 *  one click away — the context the parent's worker gathered. `context` is that brief already rendered
 *  (the transcript's markdown renderer, which lives in ChatView). */
export function SpinoffOriginCard({ instructions, context, sourceId }: { instructions: string; context: ReactNode; sourceId?: string }) {
  const thread = useTranscriptThread()
  const edge = thread?.spinoffs?.find((o) => o.childSlug === thread.id && !o.childProjectId)
  const board = useBoard()
  const parent = edge && !edge.parentProjectId ? threadBySlug(board, edge.parentSlug) : undefined
  const parentHandle = parent ? threadHandleOf(parent) : undefined
  // The disclosure names the parent as TEXT: a link inside the toggle would be a control inside a control,
  // and the header right above it already links the thread. A parent in another project is named by the
  // header alone.
  const parentName = parentHandle ? `@${parentHandle}` : parent ? displayTitle(parent) : edge && !edge.parentProjectId ? edge.parentSlug : undefined
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
              <SpinoffEndLink slug={edge.parentSlug} projectId={edge.parentProjectId} />
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
  const edge = thread.spinoffs?.find((o) => o.childSlug === thread.id && !o.childProjectId)
  if (!edge) return null
  const parentSlug = edge.parentSlug
  const linkClass = `${compact ? "min-w-0 truncate " : ""}rounded-sm underline decoration-muted/30 underline-offset-2 outline-none hover:text-fg hover:decoration-fg/60 focus-visible:ring-1 focus-visible:ring-focus-ink-60`
  // A parent in ANOTHER project is that project's thread wherever this line is drawn, whichever board
  // `resolve` reads.
  const link = edge.parentProjectId ? <SpinoffEndLink slug={parentSlug} projectId={edge.parentProjectId} className={linkClass} named={!compact} /> : (
    <ThreadHandleLink
      slug={parentSlug}
      thread={resolve ? resolve(parentSlug) ?? null : undefined}
      href={href?.(parentSlug)}
      onOpen={onOpen ? () => onOpen(parentSlug) : undefined}
      className={linkClass}
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
