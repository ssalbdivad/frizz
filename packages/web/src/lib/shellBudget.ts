import { formatCompactElapsed } from "./durationLabels.ts"

// A BACKGROUND SHELL'S REMAINING BUDGET, as a row reads it — "45m left", "over budget".
//
// A shell ends on a clock only when one was DECLARED (server shell-budget.ts, 2026-09-29): its Bash
// `timeout`, an `extend_shell`, held later by an armed `watch`. The server resolves all three into ONE
// instant, `BgShellView.budgetEndsAt`, with the same function its scheduler enforces with — so this
// reads that instant and never re-derives it. An unbudgeted shell reads NOTHING here: there is no
// default to show, and "no budget" on every dev-server row would be a column of noise. Its age, beside
// it on the row, is what makes a forgotten one visible.
//
// OVER BUDGET is its own word, not "0s left": past the instant the agent has been warned and Frizz
// stops the shell ten minutes later unless it is extended — a state the operator may want to act on.
export function shellBudgetLabel(budgetEndsAt: string | undefined, nowMs: number): string | undefined {
  const ends = Date.parse(budgetEndsAt ?? "")
  if (!Number.isFinite(ends)) return undefined
  const left = ends - nowMs
  if (left <= 0) return "over budget"
  // Minutes, never seconds: the rows re-render on the shared 30s clock (useNowMs), so a seconds reading
  // would sit stale for up to half a minute — "4s left" still on screen 25s after it ran out.
  if (left < 60_000) return "<1m left"
  return `${formatCompactElapsed(left)} left`
}

/** The row's tooltip for that reading — when the clock runs out and what happens then. */
export function shellBudgetTitle(budgetEndsAt: string | undefined, nowMs: number): string | undefined {
  const ends = Date.parse(budgetEndsAt ?? "")
  if (!Number.isFinite(ends)) return undefined
  const at = new Date(ends).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  return ends <= nowMs
    ? `Past its runtime budget (ended ${at}). The agent was warned; Frizz stops it 10m after that unless it is extended.`
    : `Runtime budget ends ${at}. Frizz then warns the agent, and stops the shell 10m later unless it is extended.`
}

/** True once the budget has run out — the one reading that earns the row's danger tone. */
export function shellOverBudget(budgetEndsAt: string | undefined, nowMs: number): boolean {
  const ends = Date.parse(budgetEndsAt ?? "")
  return Number.isFinite(ends) && ends <= nowMs
}

/** All three, in the shape ChildOpRow's `budget` reading takes — undefined for an unbudgeted shell. */
export function shellBudgetReading(budgetEndsAt: string | undefined, nowMs: number): { text: string; title?: string; tone?: "danger" } | undefined {
  const text = shellBudgetLabel(budgetEndsAt, nowMs)
  if (!text) return undefined
  return { text, title: shellBudgetTitle(budgetEndsAt, nowMs), ...(shellOverBudget(budgetEndsAt, nowMs) ? { tone: "danger" as const } : {}) }
}
