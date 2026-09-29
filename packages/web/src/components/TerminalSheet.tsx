import { lazy, Suspense, useRef, useState, type ReactNode } from "react"
import { Bot, Copy, RotateCcw, SquareTerminal, Trash2 } from "lucide-react"
import type { BackgroundShellOutputResult, ThreadTerminal, WorkCheckout } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { showToast, threadBySlug } from "../store.ts"
import { useBoard, useShellLog } from "../hooks.ts"
import { copyTextToClipboard } from "../lib/clipboard.ts"
import { dismissChildOp } from "../lib/dismissChildOp.ts"
import { compactElapsedSince } from "../lib/durationLabels.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { abbreviateHome } from "../lib/paths.ts"
import { shellBudgetLabel } from "../lib/shellBudget.ts"
import { terminalFailed, terminalOf, terminalStateLabel } from "../lib/threadTerminals.ts"
import { Sheet } from "./ui/Sheet.tsx"
import { SheetHeader } from "./ui/SheetHeader.tsx"
import { TerminalFollowUp } from "./TerminalFollowUp.tsx"

// LAZY for the same reason as every xterm consumer: @xterm/xterm is browser-only, and node (tests)
// imports the drawer stack transitively.
const TerminalPane = lazy(() => import("./TerminalPane.tsx").then((m) => ({ default: m.TerminalPane })))
const ShellLogPane = lazy(() => import("./ShellLogPane.tsx").then((m) => ({ default: m.ShellLogPane })))

const actionClass = "rounded-md border border-border-strong bg-panel-2/60 px-2.5 py-1 text-[12px] text-fg/80 transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-50"
const stopClass = `${actionClass} hover:border-danger/40 hover:bg-danger/10 hover:text-danger-soft`
const EMPTY = "flex flex-1 items-center justify-center px-8 text-center text-[13px] text-muted"

/** Whose terminal a drawer shows: yours (a pty over /term/<id>), or the agent's (its log, read-only). */
export type TerminalSource = { owner: "human"; terminalId: string } | { owner: "agent"; shellId: string }

// THE ONE TERMINAL DRAWER, for both owners (maintainer 2026-09-29: an agent's terminal "introspectable the
// same way" as yours). Stacked over the thread it belongs to; the same header anatomy either way — the
// owner's glyph, what it runs, the folder it started in (with `· worktree` when that is a linked worktree),
// how it stands — and an xterm body. What differs is what is honest for each:
//   · YOURS is the live pty. It takes keystrokes itself, so answering a prompt or pressing Ctrl-C happens
//     right in it; Stop, Restart and Remove sit in the header; once it has finished, the foot is the next
//     command line (TerminalFollowUp), the way a rested thread's foot is its next prompt.
//   · THE AGENT'S is read-only. Its output is the log file the harness writes (no pty), streamed by offset
//     into the same xterm so colour and progress bars render; typing does nothing. The header offers Copy
//     command and Stop, and the foot says whose it is.
// There is no Done here: a terminal is not a thread, and it ends with the thread it belongs to (marking the
// thread done stops yours) or on its own Stop / Remove.
export function TerminalSheet({ id, slug, source, label, startedAt, depth, widthDepth }: {
  id: number
  slug: string
  source: TerminalSource
  /** The row's own name for it, shown until the first read answers. */
  label?: string
  startedAt?: string
  depth: number
  widthDepth: number
}) {
  return source.owner === "human"
    ? <HumanTerminalSheet id={id} slug={slug} terminalId={source.terminalId} depth={depth} widthDepth={widthDepth} />
    : <AgentTerminalSheet id={id} slug={slug} shellId={source.shellId} label={label} startedAt={startedAt} depth={depth} widthDepth={widthDepth} />
}

/** The header's second line: the folder, and whether it is a worktree. */
export function terminalSubtitle(cwd: string | undefined, checkout: WorkCheckout | null | undefined, homeDir: string | undefined): string | undefined {
  if (!cwd) return undefined
  return `${abbreviateHome(cwd, homeDir)}${checkout?.kind === "worktree" ? " · worktree" : ""}`
}

// THE SAME LINE, laid out so a narrow drawer loses the right part of it. A path truncated at its END cut
// away both the folder that names the worktree and the ` · worktree` after it — at 420px the one place the
// drawer said so was gone (`/tmp/tu-v-repo/.frizz/worktr…`). So the path truncates at its START
// (`…/.frizz/worktrees/probe`), by the right-to-left overflow idiom around an isolated left-to-right run
// (so the slashes stay where they are), and the kind is its own run that never shrinks.
function TerminalSubtitle({ cwd, checkout, homeDir }: { cwd: string; checkout: WorkCheckout | null | undefined; homeDir: string | undefined }): ReactNode {
  return (
    <span data-terminal-subtitle className="flex min-w-0" title={terminalSubtitle(cwd, checkout, homeDir)}>
      <span dir="rtl" className="min-w-0 truncate text-left"><bdi>{abbreviateHome(cwd, homeDir)}</bdi></span>
      {checkout?.kind === "worktree" ? <span className="shrink-0 whitespace-pre"> · worktree</span> : null}
    </span>
  )
}

// A HEADER ACTION'S LABEL: the words where there is room, the glyph where there is not. Both drawers'
// headers are size containers (the wrapper around each SheetHeader), and under 28rem — a phone, or a
// narrow split — two or three worded buttons took all the width and left the TITLE 0px wide beside them
// (verified at 420px, 2026-09-29). Stop keeps its word at every width: it is the one action that ends
// something, and the one a glyph would make easiest to hit by mistake.
function NarrowGlyph({ icon: Icon, text }: { icon: typeof Copy; text: string }) {
  return (
    <>
      <span className="@max-[28rem]:hidden">{text}</span>
      <Icon aria-hidden size={13} className="hidden @max-[28rem]:block" />
    </>
  )
}

/** A terminal's state, its age while it runs, and (the agent's) what is left of its budget — the same
 *  reading in both drawers' headers, joined the way every reading in the app is. */
function StateReading({ state, age, budget, tone, attr }: { state: string; age?: string; budget?: string; tone?: "attention" | "danger"; attr: Record<string, string | undefined> }) {
  return (
    // min-w-0 + truncate: the reading gives way beside a long title rather than squeezing it to nothing
    // (a `shrink-0` reading plus two header buttons left the agent drawer's title 0px wide at 420px).
    // `shrink-[2]`: when both must give, the reading gives twice as fast — the title is which terminal
    // this is, and the reading is repeated on its strip row.
    <span {...attr} className="min-w-0 shrink-[2] truncate whitespace-nowrap text-[11.5px] text-muted-60">
      <span className={tone === "attention" ? "text-attention" : tone === "danger" ? "text-danger-soft" : undefined}>{state}</span>
      {age ? ` · ${age}` : ""}
      {budget ? ` · ${budget}` : ""}
    </span>
  )
}

// The pane is keyed on the RUN, not the terminal: Restart starts a fresh process, and the browser should
// see a fresh screen rather than the new process's output appended under the old one's.
function HumanTerminalSheet({ id, slug, terminalId, depth, widthDepth }: { id: number; slug: string; terminalId: string; depth: number; widthDepth: number }) {
  const board = useBoard()
  const thread = threadBySlug(board, slug)
  const terminal = terminalOf(thread, terminalId)
  // The drawer opens the moment the start RPC answers, which can beat the board delta carrying the
  // terminal. Until it has been seen once, its absence means "starting", not "gone".
  const seen = useRef(false)
  if (terminal) seen.current = true
  const [pending, setPending] = useState<"stop" | "restart" | "remove" | null>(null)

  function act(kind: "stop" | "restart" | "remove", close: () => void) {
    if (pending) return
    setPending(kind)
    const call = kind === "stop" ? rpc.terminalStop({ id: terminalId }) : kind === "restart" ? rpc.terminalRestart({ id: terminalId }) : rpc.terminalRemove({ id: terminalId })
    call
      .then(() => {
        if (kind === "remove") close()
      })
      .catch((error: unknown) => showToast(error instanceof Error ? error.message : `Could not ${kind} this terminal`))
      .finally(() => setPending(null))
  }

  return (
    <Sheet id={id} depth={depth} widthDepth={widthDepth}>
      {(close) => (
        <>
          {/* A size container, so the header's secondary actions fold to glyphs when the drawer is narrow. */}
          <div className="@container shrink-0">
            <SheetHeader
              title={terminal?.command ?? "Terminal"}
              subtitle={terminal?.cwd ? <TerminalSubtitle cwd={terminal.cwd} checkout={terminal.checkout} homeDir={board?.homeDir} /> : thread?.title}
              icon={<SquareTerminal aria-hidden size={14} className="shrink-0 text-muted-60" data-terminal-owner="human" />}
              meta={terminal ? <TerminalStateMeta terminal={terminal} /> : undefined}
              actions={terminal ? (
                <div className="flex shrink-0 items-center gap-1.5">
                  {terminal.state === "running" ? (
                    <button type="button" data-terminal-stop disabled={pending !== null} onClick={() => act("stop", close)} className={stopClass}>
                      {pending === "stop" ? "Stopping…" : "Stop"}
                    </button>
                  ) : null}
                  <button type="button" data-terminal-restart disabled={pending !== null} onClick={() => act("restart", close)} title="Restart" aria-label="Restart" className={actionClass}>
                    <NarrowGlyph icon={RotateCcw} text={pending === "restart" ? "Restarting…" : "Restart"} />
                  </button>
                  <button type="button" data-terminal-remove disabled={pending !== null} onClick={() => act("remove", close)} title="Remove" aria-label="Remove" className={actionClass}>
                    <NarrowGlyph icon={Trash2} text={pending === "remove" ? "Removing…" : "Remove"} />
                  </button>
                </div>
              ) : undefined}
              onClose={close}
            />
          </div>
          {terminal ? (
            <>
              <Suspense fallback={<div className="flex-1 bg-bg" />}>
                {/* No exited bar: the header states how the run ended and carries Restart, and the foot
                    below is where the next command goes. */}
                <TerminalPane key={`${terminalId}:${terminal.runId}`} id={terminalId} focusOnMount={terminal.state === "running"} exitedStatus={() => null} />
              </Suspense>
              {terminal.state === "exited" ? (
                <div className="shrink-0 border-t border-border/70 bg-panel px-3 py-2.5">
                  {/* Keyed on the run, so each finished run takes focus afresh — straight from the terminal
                      the human was just typing into, or on opening a finished one. */}
                  <TerminalFollowUp key={terminal.runId} id={terminalId} lastCommand={terminal.shell ? "" : terminal.command} autoFocus />
                </div>
              ) : null}
            </>
          ) : (
            <div className={EMPTY}>{seen.current || !thread ? "This terminal is closed." : "Starting…"}</div>
          )}
        </>
      )}
    </Sheet>
  )
}

// Your terminal's reading, in the agent drawer's shape: `running · 12m`, `waiting for input · 3m`,
// `exit 2`. It used to be a live dot and a bare state word, so how long it had run was in one drawer and
// not the other; the header's glyph already says whose it is, and the words say how it stands.
function TerminalStateMeta({ terminal }: { terminal: ThreadTerminal }) {
  const now = useNowMs()
  const tone = terminal.awaitingInput ? "attention" : terminalFailed(terminal) ? "danger" : undefined
  const age = terminal.state === "running" ? compactElapsedSince(terminal.startedAt, now) : undefined
  return <StateReading state={terminalStateLabel(terminal)} age={age} tone={tone} attr={{ "data-terminal-state-reading": terminal.state }} />
}

/**
 * What stands in an agent terminal's pane when there is nothing to draw yet — or ever. Undefined ⇒ the log.
 *
 * `missing` outranks `running`: a log named for this shell that can no longer be read will not start
 * arriving, so "Waiting for the first output…" beside it was a promise nothing would keep. A read that
 * keeps FAILING before any reply says so (the poll retries every 3s) rather than waiting forever on a reply
 * that is not coming. Output already on screen is never replaced by any of these.
 */
export function agentTerminalEmpty(meta: Pick<BackgroundShellOutputResult, "state" | "missing" | "outputUnavailable"> | undefined, error: boolean, received: number): string | undefined {
  if (!meta) return error ? "Could not read this terminal's output. Retrying…" : "Waiting for the first output…"
  if (meta.state === "gone") return "This terminal is closed."
  if (meta.outputUnavailable) return "Codex hands this command's output to the agent when it checks in, so Frizz can't show it here."
  if (received > 0) return undefined
  if (meta.missing) return "The output file is gone."
  return meta.state === "running" ? "Waiting for the first output…" : "No output was captured."
}

// AN AGENT'S TERMINAL. Everything the header says comes from the same replies the log streams from (the
// scoped `backgroundShellOutput`, which survives the shell ending — its folder and command stay readable
// in an open drawer), with the board's live row as the fallback until the first reply lands.
function AgentTerminalSheet({ id, slug, shellId, label, startedAt, depth, widthDepth }: {
  id: number
  slug: string
  shellId: string
  label?: string
  startedAt?: string
  depth: number
  widthDepth: number
}) {
  const board = useBoard()
  const row = threadBySlug(board, slug)?.bgShells?.find((shell) => shell.id === shellId)
  const { stream, meta, error, refresh } = useShellLog(slug, shellId)
  const now = useNowMs()
  const [stopping, setStopping] = useState(false)
  const [stopped, setStopped] = useState(false)
  const state = meta?.state
  const running = state === "running"
  const cwd = meta?.cwd ?? row?.cwd
  const checkout = meta ? meta.checkout : row?.checkout
  const monitor = meta?.monitor ?? row?.monitor
  const stateWord = state === "running" ? "running" : state === "done" ? (stopped ? "stopped" : "finished") : state === "gone" ? (stopped ? "stopped" : "unavailable") : undefined
  const noun = monitor ? "Agent monitor" : "Agent terminal"

  // STOP FROM THE DRAWER — where a wedged watcher is actually diagnosed: you only know a shell is stuck
  // AFTER reading its output. A Claude shell stops through `subAgentStop`, which does not force-retire the
  // row this drawer is rendering (the provider's own terminal event clears it a moment later); a Codex exec
  // has no provider task and stops the way its row's × does, through the one shared dismisser (which also
  // owns the toast).
  function stop() {
    if (stopping) return
    setStopping(true)
    if (meta?.outputUnavailable) {
      void dismissChildOp(slug, shellId, monitor ? "MONITOR" : "SHELL").then((killed) => {
        if (killed) setStopped(true)
        setStopping(false)
        refresh()
      })
      return
    }
    rpc.subAgentStop({ slug, id: shellId })
      .then(({ note }) => {
        setStopped(true)
        // A shell has no subtree, so `note` can only be the one failure specific to it: the process is dead
        // but the AGENT could not be told, and may still be waiting on it.
        if (note) showToast(`${noun} stopped. ${note}`, { duration: 7000 })
        else showToast(`${noun} stopped — the agent was told`)
        refresh()
      })
      .catch((error: unknown) => showToast(error instanceof Error ? error.message : "Could not stop this terminal"))
      .finally(() => setStopping(false))
  }

  async function copyCommand() {
    if (!meta?.command) return
    try {
      await copyTextToClipboard(meta.command)
      showToast("Command copied")
    } catch {
      showToast("Could not copy the command")
    }
  }

  const empty = agentTerminalEmpty(meta, error, stream.received)

  return (
    <Sheet id={id} depth={depth} widthDepth={widthDepth}>
      {(close) => (
        <>
          {/* A size container, so the header's secondary actions fold to glyphs when the drawer is narrow. */}
          <div className="@container shrink-0">
            <SheetHeader
              title={row?.label ?? label ?? noun}
              subtitle={cwd ? <TerminalSubtitle cwd={cwd} checkout={checkout} homeDir={board?.homeDir} /> : undefined}
              icon={<Bot aria-hidden size={14} className="shrink-0 text-muted-60" data-terminal-owner="agent" />}
              meta={stateWord ? (
                <StateReading
                  state={stateWord}
                  age={running ? compactElapsedSince(startedAt ?? row?.startedAt, now) : undefined}
                  budget={running ? shellBudgetLabel(row?.budgetEndsAt, now) : undefined}
                  attr={{ "data-agent-terminal-state": state }}
                />
              ) : undefined}
              actions={(
                <div className="flex shrink-0 items-center gap-1.5">
                  {meta?.command ? (
                    <button type="button" data-agent-terminal-copy onClick={() => void copyCommand()} title="Copy command" aria-label="Copy command" className={actionClass}>
                      <NarrowGlyph icon={Copy} text="Copy command" />
                    </button>
                  ) : null}
                  {running && meta?.stoppable ? (
                    <button type="button" data-agent-terminal-stop disabled={stopping} onClick={stop} className={stopClass}>
                      {stopping ? "Stopping…" : "Stop"}
                    </button>
                  ) : null}
                </div>
              )}
              onClose={close}
            />
          </div>
          {empty ? (
            <div data-agent-terminal-empty className={EMPTY}>{empty}</div>
          ) : (
            <Suspense fallback={<div className="flex-1 bg-bg" />}>
              <ShellLogPane stream={stream} />
            </Suspense>
          )}
          {/* Whose it is, said once, at the foot where your own terminal's next command would go. A running
              shell Frizz cannot reach says why instead, because no control and no explanation is what sent
              the maintainer looking for a Stop in the first place. */}
          <footer
            data-agent-terminal-footer
            className="w-full shrink-0 border-t border-border/70 bg-panel/95 px-4 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-[11.5px] text-muted-60"
          >
            {running && meta && !meta.stoppable && meta.stopNote ? meta.stopNote : "Read-only — started by the agent"}
          </footer>
        </>
      )}
    </Sheet>
  )
}
