import { useSyncExternalStore } from "react"
import { isDirectSubAgent } from "@frizz/shared"
import { subAgentName } from "../groups.ts"

// ── THE RAIL'S SUB-AGENT FOLD — one line per thread in place of one line per child ──────────────────
//
// The rail drew every live child of every thread as a row of its own, under its parent. A child's name
// is whatever its dispatcher typed — "fix:r1", "impl:W3", "review" — so a thread fanned out five ways put
// five lines of that under its title, and a rail of busy threads read as a wall of script labels
// (maintainer 2026-09-29: "the subagents often have dumb names … maybe showing them by default in the
// sidebar is not great?"). Now each thread gets ONE indented line, "3 sub-agents", which opens to the
// rows it stands for. The line still spins while any of them runs, so live work never leaves the rail —
// only the names wait for a click.
//
// The line carries NO age. Its thread's row sits directly above it with its own time in the same
// right-hand column, and the batch's age landed within a minute of it on every seeded thread (25m under
// 24m, 22m under 22m) — a second column of nearly the same number. Each child's own age is one click in.
//
// Only the RAIL folds. A queue card lists its children openly (QueueChildOps), because a card is the
// thread you are reading; the drawer's ops strip does too. The rail is the overview.

/** What one fold line says about the children it stands for. */
export interface SubAgentFold {
  /** "5 sub-agents" — every row the fold opens to, recursively, a workflow's row and its agents alike. */
  label: string
  /** Spins while ANY row under it runs, at any depth, since the fold is all the rail shows of them. */
  state: "running" | "stale"
  /** The names the fold hides, for its tooltip — as the handles the rows it opens to show. */
  names: string
}

type FoldChild = { readonly state: string; readonly depth?: number; readonly workflow?: boolean; readonly label: string }

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`

export function subAgentFold(children: readonly FoldChild[]): SubAgentFold {
  // The tooltip names the DIRECT children; a descendant with no direct parent listed names itself.
  const direct = children.some(isDirectSubAgent) ? children.filter(isDirectSubAgent) : children
  return {
    // EVERY row the fold opens to, at every depth (maintainer 2026-10-01: "show the total number of
    // subagents (recursively) that will appear if you expand"). It used to count direct children by
    // kind — "1 workflow" — which named the one row that matters least and hid the four under it.
    label: plural(children.length, "sub-agent"),
    state: children.some((child) => child.state === "running") ? "running" : "stale",
    names: direct.map((child) => subAgentName(child.label)).join(", "),
  }
}

// Which threads' folds are open. In memory, not localStorage: opening one is a glance at what a batch is
// doing, not an arrangement of the desk, and a persisted set would keep every thread id anyone ever
// peeked at. A reload folds everything back, which is the resting state anyway.
let open: ReadonlySet<string> = new Set()
const listeners = new Set<() => void>()

export function toggleSubAgentFold(threadId: string): void {
  const next = new Set(open)
  if (next.has(threadId)) next.delete(threadId)
  else next.add(threadId)
  open = next
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useSubAgentFoldOpen(threadId: string): boolean {
  const isOpen = () => open.has(threadId)
  return useSyncExternalStore(subscribe, isOpen, isOpen)
}
