import { formatElapsed } from "@frizz/shared"
import type { ShellBudgetRow, Storage } from "./storage.ts"

// THE BACKGROUND-SHELL RUNTIME BUDGET — every shell a worker backgrounds gets an end time.
//
// Maintainer 2026-09-29: "background shells running for 16 hours makes no sense. there needs to be
// built in reasonable defaults to avoid this and if an agent needs to run a tool longer it should
// probably be a prompt ahead of time or in the moment if unexpected".
//
// Until then a background shell had NO clock at all — tailer.bgShellViews says so on purpose: frizz
// cannot tell a CI watcher from a dev server, so no age rule could be right for both, and a shell only
// ever left the board on its own terminal signal or on its owner's death. That was the right call for
// DISPLAY, and it is still how the board reads a shell. What it left out is that the WORKER can tell the
// two apart, and nothing ever asked it to. The budget is that question, asked twice:
//
//  · AHEAD OF TIME. A Claude worker sizes a shell when it launches it, with the Bash tool's own
//    `timeout` on the `run_in_background` call — the knob it already has, already in milliseconds,
//    already capped at 24h by BASH_MAX_TIMEOUT_MS (backend/types.ts). No `timeout` ⇒ the default.
//  · IN THE MOMENT. A shell still running past its budget earns its worker ONE wake (scheduler SOURCE
//    13), delivered mid-turn if it is busy: keep it (`mcp__frizz__extend_shell`) or stop it. Silence
//    for SHELL_BUDGET_GRACE_MS after that wake ends it through the operator's own × path.
//
// The three numbers:
//  · DEFAULT 1h. Long enough that an ordinary build, test gate, or CI watch finishes inside it without
//    anyone thinking about budgets; short enough that a forgotten dev server is asked about within the
//    hour instead of running overnight.
//  · GRACE 10m after the warning is queued, not after the deadline: a server that was down across the
//    deadline must still give the worker its ten minutes to answer before anything is killed.
//  · MAX 24h per declaration — the same ceiling as BASH_MAX_TIMEOUT_MS and a `watch`'s `for:`
//    (AWAITING_FOR_MAX_MS). A shell that must outlive a day is re-declared, one day at a time.
//
// A `Monitor` carries NO budget: a persistent one is itself a declaration that it runs for the
// session, and a non-persistent one ends at its own `timeout_ms` (Claude caps it at an hour).
export const SHELL_BUDGET_DEFAULT_MS = 60 * 60_000
export const SHELL_BUDGET_GRACE_MS = 10 * 60_000
export const SHELL_BUDGET_MAX_MS = 24 * 60 * 60_000
/** The floor on a DECLARED budget. The scheduler resolves budgets at its tick (10s), so a budget of
 *  seconds is not a budget it can keep, and it is always a mis-sized `timeout` rather than intent. */
export const SHELL_BUDGET_MIN_MS = 60_000

/** The budget a launch DECLARED through the Bash tool's `timeout`, clamped — or undefined when the
 *  call carried none (or something that is not a positive number), which means the default. */
export function declaredShellBudgetMs(timeout: unknown): number | undefined {
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) return undefined
  return Math.min(SHELL_BUDGET_MAX_MS, Math.max(SHELL_BUDGET_MIN_MS, Math.round(timeout)))
}

/** The budget a shell launch carries: its declared one, else the default. */
export function shellLaunchBudgetMs(timeout: unknown): number {
  return declaredShellBudgetMs(timeout) ?? SHELL_BUDGET_DEFAULT_MS
}

/** A durable budget row (storage `shell_budget`) as the deadline needs it. `startedAt` is the shell's own
 *  launch instant, and a row whose `startedAt` disagrees with the live shell's belongs to a DIFFERENT
 *  shell that reused the id (a codex `processId` can recur across sessions) — it is ignored. */
export interface ShellBudgetRecord {
  startedAt: string
  deadlineAtMs: number | null
  warnedAtMs: number | null
  warnedDeadlineMs: number | null
}

/** When this shell's budget runs out: an `extend_shell` deadline if one is recorded for THIS shell,
 *  else launch + its launch budget. NaN when the launch instant is unreadable — never fires. */
export function shellBudgetDeadlineMs(
  shell: { startedAt: string; budgetMs: number },
  record?: ShellBudgetRecord | null,
): number {
  if (record && record.startedAt === shell.startedAt && record.deadlineAtMs !== null) return record.deadlineAtMs
  return Date.parse(shell.startedAt) + shell.budgetMs
}

/** The wake a shell earns by outliving its budget. Written for the model, which has no clock of its own
 *  (see wakeTimeHeader): it says how long the shell has run, what it was allowed, and the two verbs that
 *  answer it — with the exact argument to pass, because a worker that has to look the id up first is a
 *  worker that spends its grace doing it. `stoppable:false` is a shell frizz holds no handle for (a
 *  pre-broker row); it is warned and never killed, so the message must not threaten a kill that will not
 *  come. Durations in the house grammar (`1h 5m`), via the same formatter as the wake's clock line. */
export function shellBudgetWarningMessage(input: {
  handle: string
  label: string
  ranMs: number
  budgetMs: number
  stoppable: boolean
  backend: "claude" | "codex" | "other"
}): string {
  const { handle, label } = input
  const stopVerb = input.backend === "claude"
    ? `\`TaskStop\` with task id \`${handle}\``
    : input.backend === "codex" ? "end its process yourself" : "kill it yourself"
  const consequence = input.stoppable
    ? ` Frizz stops it in ${formatElapsed(SHELL_BUDGET_GRACE_MS)} unless you extend it.`
    : " Frizz cannot stop this one for you, so it keeps running until you do."
  return (
    `\u23f0 Your background shell \`${handle}\` (${label}) has been running ${formatElapsed(input.ranMs)}, past its ` +
    `${formatElapsed(input.budgetMs)} budget.${consequence}\n\n` +
    `If it must keep running, call \`mcp__frizz__extend_shell\` with \`shell: "${handle}"\` and a \`for\` duration ` +
    `(\`30m\`, \`2h\`, max 24h). If you no longer need it, stop it now (${stopVerb}).`
  )
}

/** Why a shell was stopped — the one thing the kill notice must get right, because the worker reads it
 *  cold and decides from it whether to relaunch. */
export type ShellStopReason =
  | { kind: "operator" }
  | { kind: "budget"; ranMs: number; budgetMs: number }

/** What the worker is told when frizz kills one of its background commands. Neither provider tells its
 *  agent (see router.noticeShellStopped / codex terminateBackgroundExec for the measurements), so this
 *  is the only account of the kill it will ever get. `[frizz]` keeps it out of the human's chat
 *  (transcript.ts NOISE_PREFIXES). */
export function shellStopNotice(label: string, reason: ShellStopReason = { kind: "operator" }): string {
  const tail = "It is no longer running and will never report a result — do not wait on it or poll it again."
  if (reason.kind === "operator") {
    return `[frizz] The operator stopped your background command ${JSON.stringify(label)} from the Frizz dashboard. ${tail}`
  }
  return (
    `[frizz] Frizz stopped your background command ${JSON.stringify(label)} after ${formatElapsed(reason.ranMs)}: it ran ` +
    `past its ${formatElapsed(reason.budgetMs)} budget and was not extended with \`mcp__frizz__extend_shell\` after the ` +
    `warning. ${tail} If you still need it, relaunch it with a Bash \`timeout\` sized for how long it must run.`
  )
}

/** The durable row, in the shape the deadline reads — see ShellBudgetRecord. */
export function shellBudgetRecordOf(row: ShellBudgetRow | undefined): ShellBudgetRecord | undefined {
  if (!row) return undefined
  return { startedAt: row.started_at, deadlineAtMs: row.deadline_at, warnedAtMs: row.warned_at, warnedDeadlineMs: row.warned_deadline }
}

/** One live shell's budget as every reader needs it — the scheduler, `activity`, `extend_shell` — so the
 *  three can never disagree about when a shell's time is up. Undefined for an unbudgeted shell (a
 *  Monitor) or one with no stable id. */
export function liveShellBudget(
  storage: Pick<Storage, "getShellBudget">,
  slug: string,
  shell: { id?: string; startedAt: string; budgetMs?: number },
): { shellId: string; deadlineMs: number; record?: ShellBudgetRecord } | undefined {
  if (shell.budgetMs === undefined || !shell.id) return undefined
  const record = shellBudgetRecordOf(storage.getShellBudget(slug, shell.id))
  const deadlineMs = shellBudgetDeadlineMs({ startedAt: shell.startedAt, budgetMs: shell.budgetMs }, record)
  if (!Number.isFinite(deadlineMs)) return undefined
  return { shellId: shell.id, deadlineMs, ...(record && record.startedAt === shell.startedAt ? { record } : {}) }
}
