import type { BgShellView, ThreadTerminal, ThreadView, WorkCheckout } from "@frizz/shared"
import { mergeBackgroundShells, visibleChildOps, type TranscriptShellRecord } from "./childOps.ts"
import { shellBudgetReading } from "./shellBudget.ts"
import { terminalFailed, terminalLive } from "./threadTerminals.ts"

// EVERY PROCESS ON A THREAD, AS ONE LIST — the terminals the human opened (server thread-terminals.ts, a
// pty each) and the ones the agent started (a background `Bash`, a `Monitor`, a Codex background exec;
// server tailer.ts bgShells). Until 2026-09-29 the two rendered as two strips with two row shapes, and only
// the human's opened anything. The maintainer asked for one place, told apart by an owner mark, and every
// row introspectable the same way — so the strip, the card, the rail and the sidebar mark all read this.
//
// An agent's shell is NOT a pty: its output is a file the harness writes, and its drawer reads that file by
// offset (read-only). The human's is the pty itself. The model says which by `owner` and nothing else.

export type ProcessOwner = "agent" | "human"
export type ProcessState = "running" | "quiet" | "prompt" | "finished" | "failed"
export type ShellBudgetReading = NonNullable<ReturnType<typeof shellBudgetReading>>

export interface ThreadProcess {
  /** `t:<terminalId>` for yours, `s:<shellId|launchId|label@startedAt>` for the agent's. */
  key: string
  owner: ProcessOwner
  /** Yours: the command line. The agent's: the tool call's own description of it. */
  label: string
  state: ProcessState
  startedAt?: string
  /** The absolute folder it started in. */
  cwd?: string
  /** That folder's checkout, only when it is off the project root (server liftCheckout). */
  checkout?: WorkCheckout
  /** The SERVER placed this row: it read the row's folder and lifted it (`checkout` off the root, `atRoot`
   *  in it), so an absent `checkout` means the project root rather than "unknown". False when it had no
   *  reading — a folder since removed, a Codex exec whose item named none, a transcript-only row (a
   *  sub-agent's shell, a tool call's own `workdir`) — and such a row claims no place at all. */
  placed: boolean
  /** The agent's only — what is left of the runtime budget it declared. */
  budget?: ShellBudgetReading
  monitor?: boolean
  /** A Codex exec: Codex keeps its output, so the drawer can show everything but that. */
  outputUnavailable?: boolean
  terminal?: ThreadTerminal
  shell?: BgShellView & TranscriptShellRecord
}

type AgentShell = BgShellView & TranscriptShellRecord

function agentProcess(shell: AgentShell, now: number): ThreadProcess {
  const budget = shellBudgetReading(shell.budgetEndsAt, now)
  return {
    key: `s:${shell.id ?? shell.launchId ?? `${shell.label}@${shell.startedAt}`}`,
    owner: "agent",
    label: shell.label,
    // A tracked shell is a live process even when quiet; "stale" is the OS saying nobody holds its log.
    state: shell.state === "running" ? "running" : "quiet",
    startedAt: shell.startedAt,
    ...(shell.cwd ? { cwd: shell.cwd } : {}),
    ...(shell.checkout ? { checkout: shell.checkout } : {}),
    // The server's own reading (bgShellViews/codexBgShellViews), never the folder a transcript copy filled
    // in (mergeBackgroundShells): that one is the tool call's own words, and nothing lifted it. A cwd with
    // neither field is a folder the server could not read — gone, or never named.
    placed: Boolean(shell.checkout || shell.atRoot),
    ...(budget ? { budget } : {}),
    ...(shell.monitor ? { monitor: true } : {}),
    ...(shell.outputUnavailable ? { outputUnavailable: true } : {}),
    shell,
  }
}

function humanState(terminal: ThreadTerminal): ProcessState {
  if (terminal.state === "running" && terminal.awaitingInput) return "prompt"
  if (terminalLive(terminal)) return "running"
  return terminalFailed(terminal) ? "failed" : "finished"
}

export function humanProcess(terminal: ThreadTerminal): ThreadProcess {
  return {
    key: `t:${terminal.id}`,
    owner: "human",
    label: terminal.command,
    state: humanState(terminal),
    startedAt: terminal.startedAt,
    cwd: terminal.cwd,
    ...(terminal.checkout ? { checkout: terminal.checkout } : {}),
    // The board lifts every terminal's folder (board.ts withThreadTerminals); a folder since removed has
    // neither field, and claims nothing.
    placed: Boolean(terminal.checkout || terminal.atRoot),
    terminal,
  }
}

const time = (iso: string | undefined) => {
  const ms = Date.parse(iso ?? "")
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY
}

/**
 * The thread's processes in the order every surface lists them:
 *   1. a terminal of yours waiting at a prompt — the reason a card is in the queue;
 *   2. everything running or quiet, BOTH owners mixed, oldest first — one list, not two;
 *   3. your finished terminals, newest first, until removed (their exit is why you opened them).
 * A finished AGENT shell leaves the list, as it always has; its drawer still resolves from the server's
 * retired ring. `scopedToSubAgent` is a sub-agent drawer's strip: only that child's own transcript shells,
 * and none of yours — nobody opens a terminal on a sub-agent.
 */
export function threadProcesses(
  thread: Pick<ThreadView, "terminals" | "bgShells">,
  transcriptShells: readonly AgentShell[],
  opts: { scopedToSubAgent?: boolean; now: number },
): ThreadProcess[] {
  const shells = opts.scopedToSubAgent ? [...transcriptShells] : mergeBackgroundShells<AgentShell>(thread.bgShells ?? [], transcriptShells)
  const agents = visibleChildOps(shells, "sheet").map((shell) => agentProcess(shell, opts.now))
  const humans = opts.scopedToSubAgent ? [] : (thread.terminals ?? []).map(humanProcess)
  const prompt = humans.filter((p) => p.state === "prompt")
  const live = [...agents, ...humans.filter((p) => p.state === "running")]
    // Stable: equal instants keep their source order (the agent's first, as launched).
    .map((p, i) => ({ p, i }))
    .sort((a, b) => time(a.p.startedAt) - time(b.p.startedAt) || a.i - b.i)
    .map(({ p }) => p)
  const ended = (p: ThreadProcess) => time(p.terminal?.exitedAt ?? p.startedAt)
  const finished = humans
    .filter((p) => p.state === "finished" || p.state === "failed")
    .map((p, i) => ({ p, i }))
    .sort((a, b) => ended(b.p) - ended(a.p) || a.i - b.i)
    .map(({ p }) => p)
  return [...prompt, ...live, ...finished]
}

/** Whether a process is alive — what the sidebar mark and the rail's "Terminals" group count. */
export function processIsLive(p: ThreadProcess): boolean {
  return p.state === "running" || p.state === "quiet" || p.state === "prompt"
}
