import { lazy, Suspense, useRef, useState } from "react"
import { SquareTerminal } from "lucide-react"
import type { ThreadTerminal } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { showToast, threadBySlug } from "../store.ts"
import { useBoard } from "../hooks.ts"
import { displayTitle } from "../groups.ts"
import { abbreviateHome } from "../lib/paths.ts"
import { terminalFailed, terminalLive, terminalOf, terminalStateLabel } from "../lib/threadTerminals.ts"
import { Sheet } from "./ui/Sheet.tsx"
import { SheetHeader } from "./ui/SheetHeader.tsx"
import { TerminalFollowUp } from "./TerminalFollowUp.tsx"

// LAZY for the same reason as every xterm consumer: @xterm/xterm is browser-only, and node (tests)
// imports the drawer stack transitively.
const TerminalPane = lazy(() => import("./TerminalPane.tsx").then((m) => ({ default: m.TerminalPane })))

const actionClass = "rounded-md border border-border-strong bg-panel-2/60 px-2.5 py-1 text-[12px] text-fg/80 transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-50"

// A THREAD TERMINAL's drawer: the live pty, full height, stacked over the thread it was opened on (its
// drawer entry carries the thread's slug and the terminal's id). The header names the command and the
// folder it runs in; while the run is live there is no composer — the terminal takes keystrokes itself, so
// answering a prompt or pressing Ctrl-C happens right in it. Once it has finished, the drawer's foot is the
// next command line (TerminalFollowUp), the way a rested thread's foot is its next prompt.
//
// There is no Done here: a terminal is not a thread, and it ends with the thread it belongs to (marking the
// thread done stops it) or on its own Stop / Remove.
//
// The pane is keyed on the RUN, not the terminal: Restart starts a fresh process, and the browser should
// see a fresh screen rather than the new process's output appended under the old one's.
export function TerminalSheet({ id, slug, terminalId, depth, widthDepth }: { id: number; slug: string; terminalId: string; depth: number; widthDepth: number }) {
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
          <SheetHeader
            title={terminal?.command ?? "Terminal"}
            subtitle={terminal?.cwd ? abbreviateHome(terminal.cwd, board?.homeDir) : thread ? displayTitle(thread) : undefined}
            icon={<SquareTerminal aria-hidden size={14} className="shrink-0 text-muted-60" />}
            meta={terminal ? <TerminalStateMeta terminal={terminal} /> : undefined}
            actions={terminal ? (
              <div className="flex shrink-0 items-center gap-1.5">
                {terminal.state === "running" ? (
                  <button type="button" data-terminal-stop disabled={pending !== null} onClick={() => act("stop", close)} className={`${actionClass} hover:border-danger/40 hover:bg-danger/10 hover:text-danger-soft`}>
                    {pending === "stop" ? "Stopping…" : "Stop"}
                  </button>
                ) : null}
                <button type="button" data-terminal-restart disabled={pending !== null} onClick={() => act("restart", close)} className={actionClass}>
                  {pending === "restart" ? "Restarting…" : "Restart"}
                </button>
                <button type="button" data-terminal-remove disabled={pending !== null} onClick={() => act("remove", close)} className={actionClass}>
                  {pending === "remove" ? "Removing…" : "Remove"}
                </button>
              </div>
            ) : undefined}
            onClose={close}
          />
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
            <div className="flex flex-1 items-center justify-center px-8 text-center text-[13px] text-muted">
              {seen.current || !thread ? "This terminal is closed." : "Starting…"}
            </div>
          )}
        </>
      )}
    </Sheet>
  )
}

function TerminalStateMeta({ terminal }: { terminal: ThreadTerminal }) {
  const failed = terminalFailed(terminal)
  return (
    <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[11.5px] text-muted-60">
      {terminalLive(terminal) && <span aria-hidden className="frizz-live-dot frizz-live-dot--shell" />}
      {terminal.state === "running" && terminal.awaitingInput && <span aria-hidden className="frizz-live-dot frizz-live-dot--attention" />}
      <span className={terminal.awaitingInput ? "text-attention" : failed ? "text-danger-soft" : undefined}>{terminalStateLabel(terminal)}</span>
    </span>
  )
}
