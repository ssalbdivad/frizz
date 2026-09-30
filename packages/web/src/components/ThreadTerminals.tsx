import { lazy, Suspense, useEffect, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Bot, Loader2, SquareTerminal, X } from "lucide-react"
import type { BgShellView, ThreadView, ThreadWorkingDir, WorkCheckout } from "@frizz/shared"
import { useThreadApi, useThreadApiBase, useThreadProjectDir } from "../api/threadApi.tsx"
import type { Api } from "../api/rpc.ts"
import { useBackgroundShellLines, useBoard } from "../hooks.ts"
import { AGENT_GLYPH_STROKE, CHILD_ARROW, CHILD_ARROW_CLASS, CHILD_DISMISS_TITLE, CHILD_KIND_TAG_CLASS, CHILD_MARK_SLOT_CLASS, shellLinesLabel, type TranscriptShellRecord } from "../lib/childOps.ts"
import { childOpDismisser } from "../lib/dismissChildOp.ts"
import { PRIMER } from "../lib/primer.ts"
import { humanProcess, processIsLive, threadProcesses, type ProcessState, type ThreadProcess } from "../lib/threadProcesses.ts"
import { liveAgeSince } from "../lib/durationLabels.ts"
import { draftKey, useDraft } from "../lib/drafts.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { abbreviateHome } from "../lib/paths.ts"
import { promptingTerminal, runningTerminals, terminalStateLabel } from "../lib/threadTerminals.ts"
import { projectSlug } from "../lib/base-path.ts"
import { pushBackgroundShellDrawer, pushTerminalDrawer, showToast, store } from "../store.ts"
import { Dialog } from "./ui/Dialog.tsx"

// A THREAD'S TERMINALS, drawn inside the thread (server thread-terminals.ts; lib/threadTerminals.ts). A
// terminal is opened ON a thread — the drawer's ⋯ menu, `t`, or a `$ cmd` line in its prompt box — and
// runs in the folder that thread's agent is working in. It never gets a row or a card of its own (the
// sidebar is a column of thread NAMES, and Colin's rule upstream is density): it shows as a line in its
// thread's strip, and as one small mark on its thread's row.
//
// LAZY for the same reason every xterm consumer is: @xterm/xterm is browser-only, and node (tests)
// imports these components transitively.
const TerminalPane = lazy(() => import("./TerminalPane.tsx").then((m) => ({ default: m.TerminalPane })))

// ── one strip for every process on the thread ─────────────────────────────────────────────────────

// THE ROW'S BOX IS THE OPS STRIP'S ROW BOX (ChildOpRow's sheet density): the same arrow, the same 9px mark
// slot, the same fixed kind-tag track, 11.5px throughout — so a terminal line sits in the drawer's strip
// under the ⤷ AGENT lines and the eye runs down ONE label column. Written out here rather than added as a
// fifth ChildOpRow kind because that row's states are liveness states only ("there is deliberately NO
// finished glyph"), and a terminal's finished run is worth a line: its exit code is the reason the human
// opened it.
const ROW = "flex min-w-0 items-center gap-1.5 text-[11.5px]"
const IDENTITY = "group flex min-w-0 max-w-[70%] items-center gap-1.5 overflow-hidden text-left outline-none rounded-sm focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus-ink-60"

// THE OWNER MARK sits IN THE MARK SLOT — the 9px column the liveness dot used to fill — and its hue is the
// row's liveness. Not a glyph slot of its own beside the tag: `.frizz-kind-tag` is a fixed track so every
// label on the strip starts at one x, and a second slot would push these labels 14px right of the AGENT
// and WATCH rows around them (the drift the maintainer caught on 2026-09-11, "The label is further to the
// right. Why?"). The slot is 9px and the glyph 1em (11.5px), so it overflows 1.25px a side into the row's
// gaps, exactly as the saved-reference icons always have.
//
// `Bot` for the agent's, `SquareTerminal` for yours. A human head was tried for "yours" and dropped
// (BandLabel.tsx: at 11px a round head reads as an emoji), and the terminal glyph is the one your own
// terminals already wore.
//
// GEOMETRY: CENTRED, like the dot it replaces. Every mark on this row — arrow, glyph, tag, ×, readings —
// is centred on the one flex line, which is where a sans 11.5px label's cap band sits. Both glyphs ink
// their 24-unit viewBox symmetrically (lucide's bot y 3–21 with its stroke, antenna to chin; the terminal
// square y 2–22), so a centred box is a centred ink. That only holds because the LABEL is put on that line
// too — see LABEL.
//
// MEASURED, label cap-band centre minus each mark's ink centre (negative = the mark sits lower), on the
// live stack in sans at dsf 6, 2026-09-29 (canvas cap band at 10× size — the 1× metrics round the cap
// ascent to a whole pixel on this box and read every mark ~0.35px lower than it is):
//     centred:  arrow −0.05 · owner glyph −0.41 · TERM tag −0.17 · × −0.40   (sans description label)
//               arrow +0.10 · owner glyph −0.25 · TERM tag −0.02 · × −0.25   (mono command label)
// A centred 1em box sits a hair under the sans cap band, so the glyph and the × are LIFTED by one
// measured constant, MARK_LIFT: −0.03em = 0.35px at 11.5px, which leaves both label fonts within 0.1px
// (sans −0.06, mono +0.10) — one lift, because the owner mark must not change height between an agent
// row and yours. The arrow, the tag and the readings are text on the same line and need none. The AGENT
// row (ChildOpRow) keeps its own dot and ×, measured the same −0.40 and untouched here: that row is every
// other surface's too, and its own reviewer. Re-measure if the row's size or line-height moves.
const MARK_LIFT = "-translate-y-[0.03em]"
const OWNER_GLYPH = { agent: Bot, human: SquareTerminal } as const
const OWNER_SLOT = `${CHILD_MARK_SLOT_CLASS} items-center`
// Both glyphs at the square's 1em box; the bot's weight is its pen, not its size — AGENT_GLYPH_STROKE.
const OWNER_ICON = `h-[1em] w-[1em] shrink-0 ${MARK_LIFT}`
const OWNER_STROKE = { agent: AGENT_GLYPH_STROKE, human: 2 } as const

// THE LABEL, ON THE STRIP'S ONE LINE. The agent's is the tool call's own DESCRIPTION — prose, "Test watch in
// the probe worktree" — so it is set as every ops-strip label is, in the row's sans (it was mono for one
// commit, and prose in mono read as a command line and cost a third of the label at 390px). Yours is the
// COMMAND you typed, so it keeps the mono it has always had.
//
// A mono label set on its own in this sans row rode HIGH: two fonts' boxes centred on one flex line put
// their baselines where each font's ascent/descent balance says, and the mono cap band measured 2.34px
// above the × and 1.84px above the arrow beside it (live stack, sans UI, dsf geometry, 2026-09-29) — the
// same fault the old TERM line always had. The fix is the label's, not one more constant per mark: the
// command sits INSIDE a sans line (`LABEL`, 11.5px, the row's own font), as a `leading-none` inline run.
// A line box is sized by its strut — the sans line — and the mono run's 1em box fits inside it, so the
// run is placed on the SANS baseline, exactly where an AGENT row's text sits. Nothing is measured, so
// nothing is re-measured when a font or the type scale moves; the marks all stay plain `items-center`.
const LABEL = "min-w-0 truncate text-muted-70"
const COMMAND_RUN = "font-mono-keep text-[11px] leading-none"

// Liveness in the rail mark's vocabulary: the shell's azure while it runs (pulsing on the dot's own
// 1.25s cadence), breathing when quiet, the attention yellow and STILL at a prompt, muted once finished,
// red when it failed on its own. The two motions live in styles.css beside the dots they mirror. The red
// is the ops strip's own (PRIMER.fgDanger — ChildOpRow's "failed" and "over budget"), so "this went wrong"
// is one colour down the strip's readings column, whichever row says it.
const DANGER = "text-[color:var(--gh-fg-danger)]"
const PROCESS_HUE: Record<ProcessState, string> = {
  running: "text-shell frizz-live-glyph",
  quiet: "text-shell frizz-live-glyph-quiet",
  prompt: "text-attention",
  finished: "text-muted-45",
  failed: DANGER,
}
// The indicator attributes the live-row selectors (e2e checks, verify scripts) already key on.
const RUNNING_INDICATOR: Partial<Record<ProcessState, string>> = { running: "operation", quiet: "operation-quiet", prompt: "prompt" }

const DISMISS = "shrink-0 rounded-sm p-0.5 text-muted-45 outline-none transition-colors hover:text-fg focus-visible:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:opacity-50"

function folderName(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? dir
}

/** What a row's identity button says on hover — who owns it, what it runs, where, and (when it has gone
 *  quiet) what the breathing mark means. The old SHELL row's quiet dot carried that in its own title, as
 *  "running — no recent output"; the reading behind it is the OS's (tailer.ts shellIsGone: no process
 *  holds the shell's log any more), so the line says that, rather than that it is still running.
 *
 *  "Runs in", not "Started in": while an agent shell runs, its folder is the OS's answer for where its
 *  process is NOW (server shell-cwd-probe.ts), which a `cd` inside the command moves; "Ran in" once it
 *  has gone quiet, the last place it was seen. */
export function processTitle(p: ThreadProcess, homeDir: string | undefined, watched = false): string {
  const where = p.cwd ? abbreviateHome(p.cwd, homeDir) : undefined
  if (p.owner === "human") return where ? `Your terminal — ${p.label}\n${where}` : `Your terminal — ${p.label}`
  const head = `${p.monitor ? "Agent monitor" : "Agent terminal"} — ${p.label}`
  const lines = [
    head,
    ...(p.state === "quiet" ? [QUIET_TITLE] : []),
    ...(where ? [`${p.state === "quiet" ? "Ran" : "Runs"} in ${where}`] : []),
    ...(watched ? ["Watched — this thread wakes when it finishes"] : []),
  ]
  return lines.join("\n")
}

export const QUIET_TITLE = "Quiet — no process is writing its output, so it has probably ended"

/** The word for the project's own checkout, on a row that runs there while the header says the agent is
 *  somewhere else. Git's own name for it ("the main worktree") and the maintainer's ("a worktree instead of
 *  main"). Not `root`: beside `tail -f /dev/null` that read as "running as root". Not a path: a path is the
 *  width the hint exists to save, and it is in the hint's tooltip. */
export const MAIN_CHECKOUT_WORD = "main"

export interface ProcessFolderHint {
  text: string
  kind: WorkCheckout["kind"] | "main"
  /** The checkout's folder. Absent for `main`, whose folder is the project's (the tooltip reads it). */
  dir?: string
}

/**
 * THE ROW'S FOLDER HINT: named ONLY when a row runs somewhere OTHER than where the header says the agent is
 * working (`here`, the thread's checkout — ThreadCheckoutToken, absent at the project root). So a strip whose
 * rows all run in the thread's current checkout shows no hint at all, wherever that checkout is: the header
 * token already said it once. When the agent is in `probe`, a row still in the project's own checkout says
 * `main`; when it is back at the root, a row left in `probe` says `probe`.
 *
 * Measured against the ROW ALONE for one round (a hint iff the row is off the project root), `probe` then
 * repeated down the strip whenever the agent was in a worktree — 5 of 11 rows in one verifier's drawer,
 * since a new terminal opens where the agent works — and, being never allowed to give way, it cost the
 * label its width at 390px ("Test wat…" beside `probe · 415 lines`). The rule is now one line, both owners:
 * a hint says "not where the header says". It reads against the header directly above it, the one place
 * `here` is spelled out.
 *
 * `checkout` is the server's lift (thread-cwd.ts liftCheckout), absent at the root, so a terminal in
 * `packages/web` is in the root checkout. A row the server did not PLACE (a transcript-only shell: a
 * sub-agent's, a Codex tool call's raw `workdir`) claims nothing either way.
 */
export function processFolderHint(p: ThreadProcess, here: WorkCheckout | null | undefined): ProcessFolderHint | undefined {
  if (!p.placed) return undefined
  if ((p.checkout?.dir ?? null) === (here?.dir ?? null)) return undefined
  return p.checkout ? { text: folderName(p.checkout.dir), kind: p.checkout.kind, dir: p.checkout.dir } : { text: MAIN_CHECKOUT_WORD, kind: "main" }
}

/** The hint's tooltip: where, in full — and for `main`, what the word means. */
function folderHintTitle(hint: ProcessFolderHint, projectDir: string | undefined, homeDir: string | undefined): string {
  if (hint.kind !== "main") return abbreviateHome(hint.dir!, homeDir)
  return projectDir ? `The project's main checkout\n${abbreviateHome(projectDir, homeDir)}` : "The project's main checkout"
}

// THE HINT GIVES WAY FIRST. It is a flex item of its own, before the readings, that shrinks ahead of
// everything else on the row (`shrink-[999]` against the label's 1) and WRAPS rather than truncating: its
// line is one line tall and clips, and a zero-width strut holds that first line, so a hint that no longer
// fits in full drops to the clipped second line — gone, not "pr…". Only then does the label start to
// truncate. The readings stay whole (`shrink-0`): a budget and an age are the row's live state.
const HINT_BOX = "ml-auto flex h-[1lh] min-w-0 shrink-[999] flex-wrap items-center overflow-hidden pl-1.5 text-muted-40"

/**
 * ONE ROW for one process, whoever started it. The ops strip's row box (ChildOpRow's sheet density):
 *
 *   ⤷ [owner glyph, hue = state] TERM  label ……  × [checkout ·] [N lines ·] [45m left | state] · 12m
 *
 * The tag is `TERM` for every row: the owner is the glyph's job, and the tag's word is the kind of thing
 * this is — a terminal, whether its output streams from a pty (yours) or from the file the harness writes
 * (the agent's). Every row opens the same drawer.
 */
export function ProcessRow({ process: p, slug, here, lines, watched, onOpen }: {
  process: ThreadProcess
  slug: string
  /** Where the header says the thread's agent is working (thread.checkout) — the folder hint's reference. */
  here?: WorkCheckout | null
  /** The agent row's live line count, when the surface polls for one (the drawer does, a card does not). */
  lines?: number
  watched?: boolean
  /** Absent ⇒ a non-interactive row (a transcript-only shell with nothing to open). */
  onOpen?: () => void
}) {
  const api = useThreadApi()
  const board = useBoard()
  const projectDir = useThreadProjectDir()
  const now = useNowMs()
  const [busy, setBusy] = useState(false)
  const Glyph = OWNER_GLYPH[p.owner]
  const terminal = p.terminal
  const human = p.owner === "human"
  const live = p.state === "running" || p.state === "quiet"
  const age = live ? liveAgeSince(p.startedAt, now) : undefined
  const stateText = human && !live && terminal ? terminalStateLabel(terminal) : undefined
  const counter = !human && p.shell?.id && !p.outputUnavailable ? shellLinesLabel(lines) : undefined
  const hint = processFolderHint(p, here)
  // A COMMAND is set in mono, whoever ran it: yours always is one, and so is an agent row whose label IS
  // its command (a Codex exec with no description — its board row carries the command as its label). The
  // same text changing typeface from one row to the next read as two kinds of thing.
  const commandLabel = human || (p.shell?.command !== undefined && p.shell.command === p.label)
  const title = processTitle(p, board?.homeDir, watched)
  const noun = human ? "your terminal" : p.monitor ? "agent monitor" : "agent terminal"

  // The × is Stop while yours runs and Remove once it has ended; on the agent's it is the ops strip's own
  // × (childOpDismisser): offered only when the server says the shell can really be stopped.
  const agentDismiss = !human && p.shell ? childOpDismisser(slug, p.shell, p.monitor ? "MONITOR" : "SHELL", api) : undefined
  const humanDismiss = human && terminal ? () => {
    if (busy) return
    setBusy(true)
    const running = terminal.state === "running"
    const call = running ? api.terminalStop({ id: terminal.id }) : api.terminalRemove({ id: terminal.id })
    call
      .catch((error: unknown) => showToast(error instanceof Error ? error.message : `Could not ${running ? "stop" : "remove"} this terminal`))
      .finally(() => setBusy(false))
  } : undefined
  const dismiss = humanDismiss ?? agentDismiss
  const dismissTitle = human
    ? terminal?.state === "running" ? "Stop — end this terminal's process" : "Remove — forget this finished terminal"
    : CHILD_DISMISS_TITLE[p.state === "running" ? "running" : "settled"]
  const dismissVerb = human ? (terminal?.state === "running" ? "Stop" : "Remove") : p.state === "running" ? "Stop" : "Clear"

  const identity = (
    <>
      <span aria-hidden className={CHILD_ARROW_CLASS}>{CHILD_ARROW}</span>
      <span className={OWNER_SLOT}>
        <Glyph aria-hidden strokeWidth={OWNER_STROKE[p.owner]} className={`${OWNER_ICON} ${PROCESS_HUE[p.state]}`} data-process-mark={p.owner} data-running-indicator={RUNNING_INDICATOR[p.state]} />
      </span>
      <span className={CHILD_KIND_TAG_CLASS}>TERM</span>
      <span data-process-label className={onOpen ? `${LABEL} group-hover:text-fg/80 group-hover:underline` : LABEL}>
        {commandLabel ? <span className={COMMAND_RUN}>{p.label}</span> : p.label}
      </span>
    </>
  )
  const readings = [
    counter ? <span key="lines" data-child-op-counter title="Lines of output so far — open the row to read them">{counter}</span> : null,
    p.budget ? <span key="budget" data-child-op-budget title={p.budget.title} style={p.budget.tone === "danger" ? { color: PRIMER.fgDanger } : undefined}>{p.budget.text}</span> : null,
    stateText ? <span key="state" className={p.state === "prompt" ? "text-attention" : p.state === "failed" ? DANGER : undefined}>{stateText}</span> : null,
    age ? <span key="age" title={`Running for ${age}`}>{age}</span> : null,
  ].filter((node) => node !== null)

  return (
    <div
      className={ROW}
      data-process-row={p.key}
      data-process-owner={p.owner}
      data-process-state={p.state}
      data-terminal-row={terminal?.id}
      data-terminal-state={terminal ? (terminal.awaitingInput ? "prompt" : terminal.state) : undefined}
      data-op-row={dismiss ? "" : undefined}
    >
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          // The strip sits inside a card or drawer whose own mousedown handler would otherwise act on it.
          onMouseDown={(event) => event.stopPropagation()}
          title={title}
          aria-label={`Open ${noun}: ${p.label}`}
          className={`${IDENTITY} cursor-pointer`}
        >
          {identity}
        </button>
      ) : (
        <div title={title} className={IDENTITY}>{identity}</div>
      )}
      {dismiss && (
        <button
          type="button"
          onClick={dismiss}
          onMouseDown={(event) => event.stopPropagation()}
          disabled={busy}
          title={dismissTitle}
          aria-label={`${dismissVerb} ${noun}: ${p.label}`}
          className={DISMISS}
        >
          {busy ? <Loader2 size={11} className={`animate-spin ${MARK_LIFT}`} /> : <X size={11} className={MARK_LIFT} />}
        </button>
      )}
      {hint && (
        <span data-process-checkout={hint.kind} title={folderHintTitle(hint, projectDir ?? board?.projectDir, board?.homeDir)} className={HINT_BOX}>
          <span aria-hidden className="h-[1lh] w-0" />
          <span className="flex shrink-0 items-center gap-1">
            <span className="max-w-[12ch] truncate">{hint.text}</span>
            {readings.length > 0 && <span aria-hidden className="text-muted-25">·</span>}
          </span>
        </span>
      )}
      {readings.length > 0 && (
        // The readings are the row's sans, on the same line as the label (see LABEL), so they need no lift.
        // After a hint, the row's own 6px gap is what separates them; `-ml-0.5` brings that to the 4px the
        // readings keep between themselves, so the hint's `·` sits evenly between its neighbours.
        <span className={`flex shrink-0 items-center gap-1 text-muted-40 ${hint ? "-ml-0.5" : "ml-auto pl-1.5"}`}>
          {readings.flatMap((node, i) => (i === 0 ? [node] : [<span key={`sep${i}`} aria-hidden className="text-muted-25">·</span>, node]))}
        </span>
      )}
    </div>
  )
}

/** Open a process's drawer over its thread's: the pty for yours, the log for the agent's. */
export function openProcessDrawer(slug: string, p: ThreadProcess): void {
  if (p.terminal) pushTerminalDrawer(slug, p.terminal.id, { label: p.terminal.command })
  else if (p.shell?.id) pushBackgroundShellDrawer(slug, p.shell.id, { label: p.label, startedAt: p.startedAt })
}

/** Whether a row has anything to open: every terminal of yours, and every agent shell the board tracks. */
export function processOpenable(p: ThreadProcess): boolean {
  return Boolean(p.terminal || p.shell?.id)
}

/**
 * EVERY PROCESS ON THE THREAD, in one strip (lib/threadProcesses.ts): your terminals and the agent's, one
 * row shape, one label column, one drawer. `surface="drawer"` polls the agent rows' line counters (the
 * page's own project, which a drawer always is); a card's rows carry their age and budget alone.
 *
 * A CARD LISTS ONLY WHAT IS LIVE (cardProcesses). Your finished terminals stay in the drawer's strip until
 * removed, where their exit is worth a line; on a card they only grew it — ten rows and a 959px card at
 * 420px in one verifier's session (2026-09-29), three of them runs long over. The agent's finished shells
 * already left every surface, so on the card the two owners now follow one rule.
 */
export function ThreadProcessStrip({
  thread,
  surface,
  transcriptShells = [],
  scopedToSubAgent = false,
  onOpen,
  className,
}: {
  thread: Pick<ThreadView, "id" | "terminals" | "bgShells" | "watches" | "checkout">
  surface: "drawer" | "card"
  /** The transcript's copy of the agent's shells (Codex's live execs, a sub-agent's own shells). */
  transcriptShells?: readonly (BgShellView & TranscriptShellRecord)[]
  /** A sub-agent drawer's strip: only that child's transcript shells, and none of yours. */
  scopedToSubAgent?: boolean
  /** What opening a row does. Absent ⇒ the process's own drawer, over this thread's. */
  onOpen?: (process: ThreadProcess) => void
  className?: string
}) {
  const now = useNowMs()
  const all = threadProcesses(thread, transcriptShells, { scopedToSubAgent, now })
  const processes = surface === "card" ? all.filter(onCard(thread)) : all
  const polled = surface === "drawer" ? processes.flatMap((p) => (p.owner === "agent" && p.shell?.id && !p.outputUnavailable ? [p.shell.id] : [])) : []
  const lines = useBackgroundShellLines(thread.id, polled)
  // IS A WATCHER ARMED ON THIS SHELL? A `shell` watch is a property of the row already here, never a row
  // of its own (maintainer 2026-08-14), so it rides that row's tooltip. It matters because the runtime's
  // own completion notice does not survive the worker resting (1191 of 1601 such shells in the corpus
  // never got one); a watch is what makes "will this thread hear about it" a yes.
  const watchedTargets = new Set((thread.watches ?? []).filter((w) => w.kind === "shell" && w.state === "armed").map((w) => w.target))
  const isWatched = (p: ThreadProcess) =>
    p.owner === "agent" && (watchedTargets.has(p.shell?.taskId ?? "") || watchedTargets.has(p.shell?.id ?? "") || watchedTargets.has(p.label))
  if (processes.length === 0) return null
  const open = onOpen ?? ((p: ThreadProcess) => openProcessDrawer(thread.id, p))
  return (
    <div data-thread-processes={surface} className={`flex min-w-0 flex-col gap-0.5 ${className ?? ""}`}>
      {processes.map((p) => (
        <ProcessRow
          key={p.key}
          process={p}
          slug={thread.id}
          here={thread.checkout}
          lines={p.shell?.id ? lines.get(p.shell.id) : undefined}
          watched={isWatched(p)}
          onOpen={processOpenable(p) ? () => open(p) : undefined}
        />
      ))}
    </div>
  )
}

/**
 * The live screen of the terminal a thread is queued on — a card's copy, so the answer is typed right there
 * — under ITS OWN ROW, the same row anatomy as the strip's, as its caption: which terminal is asking, what
 * it runs, where. The row is not listed again in the card's strip (onCard). Split apart for one round, the
 * pane sat above the reply box with no header and its row ~150px below in the strip, so with several
 * terminals nothing said which one was asking (main had the row directly above the pane, as here).
 *
 * A few rows tall: the prompt and the lines above it. Keyed on the RUN, like the drawer's pane, so a restart
 * is a fresh screen; no focus grab, because a card is one of many. Renders nothing otherwise.
 */
export function TerminalPromptPane({ thread, base, onOpen }: {
  thread: Pick<ThreadView, "id" | "terminals" | "checkout">
  base?: string
  /** What opening the caption row does. Absent ⇒ the terminal's own drawer, over this thread's. */
  onOpen?: (process: ThreadProcess) => void
}) {
  const prompting = promptingTerminal(thread)
  const fallback = useThreadApiBase()
  if (!prompting) return null
  const process = humanProcess(prompting)
  const open = onOpen ?? ((p: ThreadProcess) => openProcessDrawer(thread.id, p))
  return (
    <div data-terminal-prompt={prompting.id} className="flex min-w-0 flex-col">
      {/* `px-1`: the strip's own inset (AllQueuesCard), so this row's arrow and label sit in the one column
          the rows under the reply box use, and its screen's border is the box edge, as the reply box is theirs. */}
      <div className="px-1">
        <ProcessRow process={process} slug={thread.id} here={thread.checkout} onOpen={() => open(process)} />
      </div>
      <div data-terminal-prompt-pane={prompting.id} className="mt-1.5 flex h-[168px] min-w-0 overflow-hidden rounded-md border border-attention/40">
        <Suspense fallback={<div className="flex-1 bg-bg" />}>
          <TerminalPane key={`${prompting.id}:${prompting.runId}`} id={prompting.id} base={base ?? fallback} focusOnMount={false} exitedStatus={() => null} />
        </Suspense>
      </div>
    </div>
  )
}

// ── the row's mark ────────────────────────────────────────────────────────────────────────────────────

// ONE small glyph after a thread's title in the rail, while any terminal on it is running — yours or the
// agent's — the whole of a terminal's presence in the sidebar (a row is its title, and nothing else, bar
// trailers like the provider mark this sits beside). The same place for both owners, told apart by TONE:
//   · attention-yellow while one of yours waits at a prompt, which is also what put the thread in the queue;
//   · the shell's azure while one of YOURS runs;
//   · muted while only the AGENT's run — a dev server it left up is worth a glance, and nothing more.
// Still the terminal glyph for all three: a 10px bot beside a title would read "this is an agent", which
// every thread is. Absent when nothing runs: a finished terminal is history, read in the thread's strip.
//
// GEOMETRY, measured (visual-review cap-band probe, 13px sans title, dsf 6): see TERMINAL_MARK_CLASS.
export function ThreadTerminalMark({ thread }: { thread: Pick<ThreadView, "terminals" | "bgShells"> }) {
  const running = runningTerminals(thread)
  const agents = (thread.bgShells ?? []).filter((shell) => shell.state === "running")
  if (running.length === 0 && agents.length === 0) return null
  // THE TOOLTIP names every live terminal, in one grammar per owner — "Your terminal …" / "N of your
  // terminals …", "Agent terminal …" / "N agent terminals …" — and a prompt does not hide the rest: the
  // terminals of yours still running beside the one that is asking are listed after it.
  const asking = running.filter((terminal) => terminal.awaitingInput)
  const busy = running.filter((terminal) => !terminal.awaitingInput)
  const yours = (n: number) => (n === 1 ? "Your terminal" : `${n} of your terminals`)
  const parts: string[] = []
  if (asking.length > 0) parts.push(`${yours(asking.length)} waiting for input: ${asking.map((terminal) => terminal.command).join(", ")}`)
  if (busy.length > 0) parts.push(`${yours(busy.length)} running: ${busy.map((terminal) => terminal.command).join(", ")}`)
  if (agents.length > 0) parts.push(`${agents.length === 1 ? "Agent terminal" : `${agents.length} agent terminals`} running: ${agents.map((shell) => shell.label).join(", ")}`)
  const label = parts.join(" · ")
  const tone = asking.length > 0 ? "prompt" : running.length > 0 ? "running" : "agent"
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-thread-terminal-mark={tone}
      className={`${TERMINAL_MARK_CLASS} ${tone === "prompt" ? "text-attention" : tone === "running" ? "text-shell" : "text-muted-50"}`}
    >
      <SquareTerminal aria-hidden="true" focusable="false" className="size-full" strokeWidth={2.25} viewBox="2 2 20 20" />
    </span>
  )
}

// The glyph is lucide's square-terminal CROPPED to its ink (viewBox 2 2 20 20: the 18-unit rounded square
// plus its stroke), so the box IS the ink and `ml-1` is 4px of ink gap, as it is for the provider marks.
// 10px of ink, the codex/ACP marks' size, so the two trailers read as one family.
export const TERMINAL_MARK_CLASS = "ml-1 inline-flex size-[10px] shrink-0"

// ── opening one ───────────────────────────────────────────────────────────────────────────────────────

/** Start a terminal on a thread and show it: the terminal's drawer, over the thread's. */
export async function openThreadTerminal(api: Api, slug: string, input: { command?: string; cwd?: string }): Promise<void> {
  const { id } = await api.terminalStart({ slug, ...input })
  pushTerminalDrawer(slug, id, { label: input.command })
}

/** Open a terminal from the thread composer's `$` line (lib/threadTerminals.ts composerTerminalLine). */
export function startComposerTerminal(api: Api, slug: string, command: string | undefined, onFailed: () => void): void {
  openThreadTerminal(api, slug, { command }).catch((error: unknown) => {
    onFailed()
    showToast(`Could not open a terminal: ${(error instanceof Error ? error.message : String(error)).slice(0, 80)}`)
  })
}

// What the folder above is, in the dialog's own words. Where the agent is working now also says WHICH kind
// of place that is — the same fact the header's checkout token shows (ThreadCheckoutToken), so a worktree
// is never a surprise at the moment a terminal is about to open in it.
const SOURCE_HINT = {
  session: "The folder the agent's session started in.",
  project: "The project root.",
} as const
const WORKING_HINT = {
  worktree: "Where the agent is working now — a worktree.",
  // "folder" is any checkout other than the root and not a linked worktree — a folder outside the project,
  // but also a nested clone inside it, or `~/frizz` in the Home workspace (whose root IS the home folder).
  // "Outside the project" was false for the last two; "another folder" is true of all three.
  folder: "Where the agent is working now — another folder.",
  root: "Where the agent is working now — the project root.",
} as const

export function workingDirHint(where: Pick<ThreadWorkingDir, "source" | "kind">): string {
  if (where.source !== "transcript") return SOURCE_HINT[where.source]
  return where.kind ? WORKING_HINT[where.kind] : "Where the agent is working now."
}

// THE "OPEN TERMINAL" DIALOG — two fields and a button. The FOLDER opens on where the thread's agent is
// working right now (the server's threadWorkingDir: the newest folder its transcript names, lifted to the
// checkout it lies in — the project root, or the worktree the agent moved into), and the human can
// retarget it before anything runs. The COMMAND is optional: empty opens an interactive shell there.
export function OpenTerminalDialog({ slug, open, onOpenChange }: { slug: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const api = useThreadApi()
  const board = useBoard()
  const projectDir = useThreadProjectDir()
  const [command, setCommand, clearCommand] = useDraft(draftKey.terminalCommand(projectDir, slug))
  const commandRef = useRef<HTMLInputElement>(null)
  const where = useQuery({
    queryKey: ["threadWorkingDir", projectDir, slug],
    queryFn: () => api.threadWorkingDir({ slug }),
    enabled: open,
    // Re-read on every opening: the agent may have moved since.
    staleTime: 0,
  })
  const [folder, setFolder] = useState("")
  const [touched, setTouched] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Fill the folder from the reading until the human edits it; reset both when the dialog reopens.
  useEffect(() => {
    if (!open) {
      setTouched(false)
      setError(null)
      return
    }
    if (!touched && where.data) setFolder(abbreviateHome(where.data.dir, board?.homeDir))
  }, [open, where.data, touched, board?.homeDir])

  function submit() {
    const cwd = folder.trim()
    if (pending || !cwd) return
    setPending(true)
    setError(null)
    const line = command.trim() || undefined
    openThreadTerminal(api, slug, { command: line, cwd: expandHome(cwd, board?.homeDir) })
      .then(() => {
        clearCommand()
        onOpenChange(false)
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setPending(false))
  }

  const field = "font-mono-keep block w-full min-w-0 rounded-md border border-border bg-bg px-2.5 py-1.5 text-[12.5px] text-fg outline-none transition-colors placeholder:font-sans placeholder:text-muted focus:border-accent"
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!pending) onOpenChange(next) }}
      title="Open terminal"
      className="w-[460px] max-w-[92vw]"
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        commandRef.current?.focus()
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
            data-open-terminal-submit
            disabled={pending || !folder.trim()}
            onClick={submit}
            className="button-outline flex items-center gap-1.5 rounded-md bg-fg px-3 py-1.5 text-[12px] font-medium text-bg outline-none transition-opacity hover:opacity-90 disabled:opacity-45"
          >
            {pending && <Loader2 size={12} className="animate-spin" />}
            Open terminal
          </button>
        </>
      }
    >
      <form
        data-open-terminal
        className="flex flex-col gap-3 p-4 text-[12px]"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-muted">Folder</span>
          <input
            data-open-terminal-folder
            value={folder}
            onChange={(event) => {
              setTouched(true)
              setFolder(event.target.value)
            }}
            placeholder={where.isLoading ? "Finding where the agent is working…" : "/path/to/folder"}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            data-1p-ignore
            className={field}
          />
          <span className="text-[11px] text-muted-60">
            {where.data && !touched ? workingDirHint(where.data) : where.isError ? "Could not tell where the agent is working." : " "}
          </span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted">Command</span>
          <div className="relative flex items-center">
            <span aria-hidden className="font-mono-keep pointer-events-none absolute left-2.5 select-none text-[12.5px] text-muted-60">$</span>
            <input
              ref={commandRef}
              data-open-terminal-command
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="Leave empty for a shell"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              data-1p-ignore
              className={`${field} pl-6`}
            />
          </div>
        </label>
        {error && <p role="alert" className="text-[11.5px] text-danger-soft">{error}</p>}
        {/* Enter in either field submits; the hidden button is what makes it a real form submit. */}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

function expandHome(path: string, homeDir: string | undefined): string {
  if (!homeDir) return path
  if (path === "~") return homeDir
  return path.startsWith("~/") ? `${homeDir}/${path.slice(2)}` : path
}

/** Which rows a queue card's strip draws: the live ones (see ThreadProcessStrip), minus the terminal whose
 *  prompt the card already shows with its own row above its screen (TerminalPromptPane). */
function onCard(thread: Pick<ThreadView, "terminals">): (p: ThreadProcess) => boolean {
  const prompting = promptingTerminal(thread)
  return (p) => processIsLive(p) && !(prompting && p.terminal?.id === prompting.id)
}

/** The rows a queue card's strip draws. The card gates its strip's wrapper on this, so a card whose
 *  terminals have all finished — or whose only one is the prompt it shows above — draws no empty inset. */
export function cardProcesses(thread: Pick<ThreadView, "terminals" | "bgShells">, now: number): ThreadProcess[] {
  return threadProcesses(thread, [], { now }).filter(onCard(thread))
}

/** Whether a card's thread is the page's focused project's, so its terminal can open over its drawer here. */
export function focusedProject(slug: string | undefined): boolean {
  const focus = projectSlug()
  return slug === focus && store.board?.projectSlug === focus
}
