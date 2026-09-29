import { lazy, Suspense, useEffect, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Bot, Loader2, SquareTerminal, X } from "lucide-react"
import type { BgShellView, ThreadTerminal, ThreadView } from "@frizz/shared"
import { useThreadApi, useThreadApiBase, useThreadProjectDir } from "../api/threadApi.tsx"
import type { Api } from "../api/rpc.ts"
import { useBackgroundShellLines, useBoard } from "../hooks.ts"
import { CHILD_ARROW, CHILD_ARROW_CLASS, CHILD_DISMISS_TITLE, CHILD_KIND_TAG_CLASS, CHILD_MARK_SLOT_CLASS, shellLinesLabel, type TranscriptShellRecord } from "../lib/childOps.ts"
import { childOpDismisser } from "../lib/dismissChildOp.ts"
import { PRIMER } from "../lib/primer.ts"
import { threadProcesses, type ProcessState, type ThreadProcess } from "../lib/threadProcesses.ts"
import { compactElapsedSince } from "../lib/durationLabels.ts"
import { draftKey, useDraft } from "../lib/drafts.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { abbreviateHome } from "../lib/paths.ts"
import { promptingTerminal, runningTerminals, terminalFailed, terminalLive, terminalStateLabel } from "../lib/threadTerminals.ts"
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

// ── the strip ─────────────────────────────────────────────────────────────────────────────────────────

// THE ROW'S BOX IS THE OPS STRIP'S ROW BOX (ChildOpRow's sheet density): the same arrow, the same 9px mark
// slot, the same fixed kind-tag track, 11.5px throughout — so a terminal line sits in the drawer's strip
// under the ⤷ AGENT / ⤷ SHELL lines and the eye runs down ONE label column. Written out here rather than
// added as a fifth ChildOpRow kind because that row's states are liveness states only ("there is
// deliberately NO finished glyph"), and a terminal's finished run is worth a line: its exit code is the
// reason the human opened it.
const ROW = "flex min-w-0 items-center gap-1.5 text-[11.5px]"
const IDENTITY = "group flex min-w-0 max-w-[70%] items-center gap-1.5 overflow-hidden text-left outline-none rounded-sm focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus-ink-60"
// A finished run's mark, in the slot the live dot takes: the terminal glyph, 1em, centred on the label's
// cap band by the browser's own `cap` unit (the ThreadLinks icon's correction, which measured 0px in both
// fonts). The slot is 9px and the glyph ~11.5px; it overflows the slot symmetrically, as the links' does.
const DONE_ICON = "h-[1em] w-[1em] shrink-0 translate-y-[calc(0.5em_-_0.5cap)]"

/** The terminals strip of one thread: a line per open terminal. `surface="card"` is a queue card's copy,
 *  which also draws a terminal waiting at a prompt as its live pane, so the answer is typed right there —
 *  the prompt is WHY the card is in the queue. Renders nothing when the thread has none. */
export function ThreadTerminalsStrip({
  thread,
  surface,
  onOpen,
  className,
}: {
  thread: Pick<ThreadView, "id" | "terminals">
  surface: "drawer" | "card"
  /** What opening a line does. Absent ⇒ the terminal's own drawer, over this thread's. */
  onOpen?: (terminal: ThreadTerminal) => void
  className?: string
}) {
  const terminals = thread.terminals ?? []
  const prompting = surface === "card" ? promptingTerminal(thread) : undefined
  const base = useThreadApiBase()
  if (terminals.length === 0) return null
  const open = onOpen ?? ((terminal: ThreadTerminal) => pushTerminalDrawer(thread.id, terminal.id, { label: terminal.command }))
  return (
    <div data-thread-terminals={surface} className={`flex min-w-0 flex-col gap-0.5 ${className ?? ""}`}>
      {terminals.map((terminal) => (
        <TerminalLine key={terminal.id} terminal={terminal} onOpen={() => open(terminal)} />
      ))}
      {prompting && (
        // Its live screen, a few rows tall: enough for the prompt and the lines above it. Keyed on the RUN,
        // like the drawer's pane, so a restart is a fresh screen. No focus grab — a card is one of many.
        <div data-terminal-prompt-pane={prompting.id} className="mt-1.5 flex h-[168px] min-w-0 overflow-hidden rounded-md border border-attention/40">
          <Suspense fallback={<div className="flex-1 bg-bg" />}>
            <TerminalPane key={`${prompting.id}:${prompting.runId}`} id={prompting.id} base={base} focusOnMount={false} exitedStatus={() => null} />
          </Suspense>
        </div>
      )}
    </div>
  )
}

function TerminalLine({ terminal, onOpen }: { terminal: ThreadTerminal; onOpen: () => void }) {
  const api = useThreadApi()
  const board = useBoard()
  const now = useNowMs()
  const [busy, setBusy] = useState(false)
  const running = terminal.state === "running"
  const failed = terminalFailed(terminal)
  const label = terminal.command
  // Where it runs, when that is not simply the project: the worktree's own name is what tells two
  // terminals on two checkouts apart at a glance. The full path is in the tooltip.
  const folder = terminal.cwd && terminal.cwd !== board?.projectDir ? terminal.cwd.split(/[\\/]/).filter(Boolean).pop() : undefined
  const reading = running && !terminal.awaitingInput ? compactElapsedSince(terminal.startedAt, now) : undefined
  const stateText = running && !terminal.awaitingInput ? undefined : terminalStateLabel(terminal)
  const where = terminal.cwd ? abbreviateHome(terminal.cwd, board?.homeDir) : undefined
  // The × is Stop while it runs and Remove once it has ended — the two honest meanings ChildOpRow's × has.
  const dismiss = () => {
    if (busy) return
    setBusy(true)
    const call = running ? api.terminalStop({ id: terminal.id }) : api.terminalRemove({ id: terminal.id })
    call
      .catch((error: unknown) => showToast(error instanceof Error ? error.message : `Could not ${running ? "stop" : "remove"} this terminal`))
      .finally(() => setBusy(false))
  }
  return (
    <div className={ROW} data-terminal-row={terminal.id} data-terminal-state={terminal.awaitingInput ? "prompt" : terminal.state}>
      <button
        type="button"
        onClick={onOpen}
        // The strip sits inside a card or drawer whose own mousedown handler would otherwise act on it.
        onMouseDown={(event) => event.stopPropagation()}
        title={where ? `Open terminal — ${label}\n${where}` : `Open terminal — ${label}`}
        aria-label={`Open terminal: ${label}`}
        className={`${IDENTITY} cursor-pointer`}
      >
        <span aria-hidden className={CHILD_ARROW_CLASS}>{CHILD_ARROW}</span>
        <span className={`frizz-op-dot-slot ${CHILD_MARK_SLOT_CLASS}`}>
          {terminalLive(terminal) ? (
            // A live run pulses the shell's azure: it is a shell process, the human's own.
            <span aria-hidden className="frizz-live-dot frizz-live-dot--shell" data-running-indicator="operation" />
          ) : terminal.awaitingInput ? (
            <span aria-hidden className="frizz-live-dot frizz-live-dot--attention" data-running-indicator="prompt" />
          ) : (
            <SquareTerminal aria-hidden className={`${DONE_ICON} ${failed ? "text-danger-soft" : "text-muted-45"}`} />
          )}
        </span>
        <span className={CHILD_KIND_TAG_CLASS}>TERM</span>
        <span className="font-mono-keep min-w-0 truncate text-[11px] text-muted-70 group-hover:text-fg/80 group-hover:underline">{label}</span>
      </button>
      <button
        type="button"
        onClick={dismiss}
        onMouseDown={(event) => event.stopPropagation()}
        disabled={busy}
        title={running ? "Stop — end this terminal's process" : "Remove — forget this finished terminal"}
        aria-label={`${running ? "Stop" : "Remove"} terminal: ${label}`}
        className="shrink-0 rounded-sm p-0.5 text-muted-45 outline-none transition-colors hover:text-fg focus-visible:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:opacity-50"
      >
        {busy ? <Loader2 size={11} className="animate-spin" /> : <X size={11} />}
      </button>
      <span className="ml-auto flex min-w-0 shrink-0 items-center gap-1 pl-1.5 text-muted-40">
        {folder && <span data-terminal-folder className="min-w-0 max-w-[12ch] truncate" title={where}>{folder}</span>}
        {folder && (stateText || reading) && <span aria-hidden className="text-muted-25">·</span>}
        {stateText && (
          <span className={terminal.awaitingInput ? "text-attention" : failed ? "text-danger-soft" : undefined}>{stateText}</span>
        )}
        {reading && <span title={`Running for ${reading}`}>{reading}</span>}
      </span>
    </div>
  )
}

// ── one strip for every process on the thread ─────────────────────────────────────────────────────

// THE OWNER MARK sits IN THE MARK SLOT — the 9px column the liveness dot used to fill — and its hue is the
// row's liveness. Not a glyph slot of its own beside the tag: `.frizz-kind-tag` is a fixed track so every
// label on the strip starts at one x, and a second slot would push these labels 14px right of the AGENT
// and WATCH rows around them (the drift the maintainer caught on 2026-09-11, "The label is further to the
// right. Why?"). The slot is 9px and the glyph 1em (11.5px), so it overflows 1.25px a side into the row's
// gaps, exactly as the saved-reference icons and a finished terminal's glyph always have.
//
// `Bot` for the agent's, `SquareTerminal` for yours. A human head was tried for "yours" and dropped
// (BandLabel.tsx: at 11px a round head reads as an emoji), and the terminal glyph is the one your own
// terminals already wore.
//
// GEOMETRY: centred on the label's cap band by the browser's own `cap` unit (DONE_ICON above), which
// needs no per-font constant. Both glyphs fill their 24-unit viewBox symmetrically — lucide's bot inks
// y 4–20 (the antenna to the chin), the terminal square y 3–21 — so the box centre IS the ink centre.
// Measured in the unified-terminals fixture (sans, 11.5px row, dsf 6): see the handoff's optics table.
const OWNER_GLYPH = { agent: Bot, human: SquareTerminal } as const

// Liveness in the rail mark's vocabulary: the shell's azure while it runs (pulsing on the dot's own
// 1.25s cadence), breathing when quiet, the attention yellow and STILL at a prompt, muted once finished,
// red when it failed on its own. The two motions live in styles.css beside the dots they mirror.
const PROCESS_HUE: Record<ProcessState, string> = {
  running: "text-shell frizz-live-glyph",
  quiet: "text-shell frizz-live-glyph-quiet",
  prompt: "text-attention",
  finished: "text-muted-45",
  failed: "text-danger-soft",
}
// The indicator attributes the live-row selectors (e2e checks, verify scripts) already key on.
const RUNNING_INDICATOR: Partial<Record<ProcessState, string>> = { running: "operation", quiet: "operation-quiet", prompt: "prompt" }

const DISMISS = "shrink-0 rounded-sm p-0.5 text-muted-45 outline-none transition-colors hover:text-fg focus-visible:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:opacity-50"

function folderName(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? dir
}

/** What a row's identity button says on hover — who owns it, what it runs, and where. */
export function processTitle(p: ThreadProcess, homeDir: string | undefined, watched = false): string {
  const where = p.cwd ? abbreviateHome(p.cwd, homeDir) : undefined
  if (p.owner === "human") return where ? `Your terminal — ${p.label}\n${where}` : `Your terminal — ${p.label}`
  const head = `${p.monitor ? "Agent monitor" : "Agent terminal"} — ${p.label}`
  const lines = [head, ...(where ? [`Started in ${where}`] : []), ...(watched ? ["Watched — this thread wakes when it finishes"] : [])]
  return lines.join("\n")
}

/**
 * ONE ROW for one process, whoever started it. The ops strip's row box (ChildOpRow's sheet density):
 *
 *   ⤷ [owner glyph, hue = state] TERM  label ……  × [checkout ·] [N lines ·] [45m left | state] · 12m
 *
 * The tag is `TERM` for every row: the owner is the glyph's job, and the tag's word is the kind of thing
 * this is — a terminal, whether its output streams from a pty (yours) or from the file the harness writes
 * (the agent's). Every row opens the same drawer.
 */
export function ProcessRow({ process: p, slug, lines, watched, onOpen }: {
  process: ThreadProcess
  slug: string
  /** The agent row's live line count, when the surface polls for one (the drawer does, a card does not). */
  lines?: number
  watched?: boolean
  /** Absent ⇒ a non-interactive row (a transcript-only shell with nothing to open). */
  onOpen?: () => void
}) {
  const api = useThreadApi()
  const board = useBoard()
  const now = useNowMs()
  const [busy, setBusy] = useState(false)
  const Glyph = OWNER_GLYPH[p.owner]
  const terminal = p.terminal
  const human = p.owner === "human"
  const live = p.state === "running" || p.state === "quiet"
  const age = live ? compactElapsedSince(p.startedAt, now) : undefined
  const stateText = human && !live && terminal ? terminalStateLabel(terminal) : undefined
  const counter = !human && p.shell?.id && !p.outputUnavailable ? shellLinesLabel(lines) : undefined
  const checkoutName = p.checkout ? folderName(p.checkout.dir) : undefined
  const title = processTitle(p, board?.homeDir, watched)
  const noun = human ? "your terminal" : p.monitor ? "agent monitor" : "agent terminal"

  // The × is Stop while yours runs and Remove once it has ended; on the agent's it is the ops strip's own
  // × (childOpDismisser): offered only when the server says the shell can really be stopped.
  const agentDismiss = !human && p.shell ? childOpDismisser(slug, p.shell, "SHELL", api) : undefined
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
      <span className={CHILD_MARK_SLOT_CLASS}>
        <Glyph aria-hidden className={`${DONE_ICON} ${PROCESS_HUE[p.state]}`} data-process-mark={p.owner} data-running-indicator={RUNNING_INDICATOR[p.state]} />
      </span>
      <span className={CHILD_KIND_TAG_CLASS}>TERM</span>
      <span className={`font-mono-keep min-w-0 truncate text-[11px] text-muted-70 ${onOpen ? "group-hover:text-fg/80 group-hover:underline" : ""}`}>{p.label}</span>
    </>
  )
  const readings = [
    checkoutName ? <span key="checkout" data-process-checkout={p.checkout?.kind} className="min-w-0 max-w-[12ch] truncate" title={p.checkout?.dir ? abbreviateHome(p.checkout.dir, board?.homeDir) : undefined}>{checkoutName}</span> : null,
    counter ? <span key="lines" data-child-op-counter title="Lines of output so far — open the row to read them">{counter}</span> : null,
    p.budget ? <span key="budget" data-child-op-budget title={p.budget.title} style={p.budget.tone === "danger" ? { color: PRIMER.fgDanger } : undefined}>{p.budget.text}</span> : null,
    stateText ? <span key="state" className={p.state === "prompt" ? "text-attention" : p.state === "failed" ? "text-danger-soft" : undefined}>{stateText}</span> : null,
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
          {busy ? <Loader2 size={11} className="animate-spin" /> : <X size={11} />}
        </button>
      )}
      {readings.length > 0 && (
        <span className="ml-auto flex min-w-0 shrink-0 items-center gap-1 pl-1.5 text-muted-40">
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
 */
export function ThreadProcessStrip({
  thread,
  surface,
  transcriptShells = [],
  scopedToSubAgent = false,
  onOpen,
  className,
}: {
  thread: Pick<ThreadView, "id" | "terminals" | "bgShells" | "watches">
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
  const processes = threadProcesses(thread, transcriptShells, { scopedToSubAgent, now })
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
          lines={p.shell?.id ? lines.get(p.shell.id) : undefined}
          watched={isWatched(p)}
          onOpen={processOpenable(p) ? () => open(p) : undefined}
        />
      ))}
    </div>
  )
}

/** The live screen of the terminal a thread is queued on — a card's copy, so the answer is typed right
 *  there. A few rows tall: the prompt and the lines above it. Keyed on the RUN, like the drawer's pane, so
 *  a restart is a fresh screen; no focus grab, because a card is one of many. Renders nothing otherwise. */
export function TerminalPromptPane({ thread, base }: { thread: Pick<ThreadView, "terminals">; base?: string }) {
  const prompting = promptingTerminal(thread)
  const fallback = useThreadApiBase()
  if (!prompting) return null
  return (
    <div data-terminal-prompt-pane={prompting.id} className="mt-1.5 flex h-[168px] min-w-0 overflow-hidden rounded-md border border-attention/40">
      <Suspense fallback={<div className="flex-1 bg-bg" />}>
        <TerminalPane key={`${prompting.id}:${prompting.runId}`} id={prompting.id} base={base ?? fallback} focusOnMount={false} exitedStatus={() => null} />
      </Suspense>
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
  const prompting = running.some((terminal) => terminal.awaitingInput)
  const names = running.map((terminal) => terminal.command).join(", ")
  const parts: string[] = []
  if (prompting) parts.push(`Terminal waiting for input: ${promptingTerminal(thread)?.command ?? names}`)
  else if (running.length > 0) parts.push(`${running.length === 1 ? "Terminal" : `${running.length} terminals`} running: ${names}`)
  if (agents.length > 0) parts.push(`${agents.length === 1 ? "1 agent terminal" : `${agents.length} agent terminals`} running: ${agents.map((shell) => shell.label).join(", ")}`)
  const label = parts.join(" · ")
  const tone = prompting ? "prompt" : running.length > 0 ? "running" : "agent"
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

// What the folder above is, in the dialog's own words.
const SOURCE_HINT = {
  transcript: "Where the agent is working now.",
  session: "The folder the agent's session started in.",
  project: "The project root.",
} as const

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
            {where.data && !touched ? SOURCE_HINT[where.data.source] : where.isError ? "Could not tell where the agent is working." : " "}
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

/** Whether a card's thread is the page's focused project's, so its terminal can open over its drawer here. */
export function focusedProject(slug: string | undefined): boolean {
  const focus = projectSlug()
  return slug === focus && store.board?.projectSlug === focus
}
