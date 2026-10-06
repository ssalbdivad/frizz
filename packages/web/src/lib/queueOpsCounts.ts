import type { ThreadView } from "@frizz/shared"
import { mergeBackgroundShells, visibleChildOps } from "./childOps.ts"

export type QueueOpsKind = "agent" | "shell" | "pr" | "issue" | "file" | "link"

export interface QueueOpsCount {
  readonly key: QueueOpsKind
  readonly n: number
  readonly one: string
  readonly many: string
  // The states of the rows behind the count, which pick its liveness mark. A parked watcher IS live —
  // its row is always `running` (BackgroundOpsStrip) — so a PR or issue count reads as running.
  readonly states: readonly (string | undefined)[]
}

// The counts on the line above a queue card's docked prompt box (QueueOpsSummary), in display order,
// with the empty kinds dropped. Taken from the same lists the rows in its panel render, by the same
// filters, so the line and the panel cannot disagree about how many there are.
//
// ONLY GITHUB WATCHES COUNT. A shell watch is not a second object: the shell it waits on is already a
// shell, from the board's own shell list, and counting the watch too would name one process twice — the
// double-naming the lifecycle footer's watcher readout was removed for (2026-08-14).
export function queueOpsCounts(thread: ThreadView): QueueOpsCount[] {
  const agents = visibleChildOps(thread.subAgents ?? [], "card")
  const shells = mergeBackgroundShells(thread.bgShells ?? [], [])
  const watches = (thread.watches ?? []).filter((watch) => watch.kind === "github")
  const prs = watches.filter((watch) => watch.subject !== "issue")
  const issues = watches.filter((watch) => watch.subject === "issue")
  const links = thread.links ?? []
  const files = links.filter((link) => link.kind === "file")
  const urls = links.filter((link) => link.kind === "link")
  const counts: QueueOpsCount[] = [
    { key: "agent", n: agents.length, one: "agent", many: "agents", states: agents.map((agent) => agent.state) },
    { key: "shell", n: shells.length, one: "shell", many: "shells", states: shells.map((shell) => shell.state) },
    { key: "pr", n: prs.length, one: "PR", many: "PRs", states: ["running"] },
    { key: "issue", n: issues.length, one: "issue", many: "issues", states: ["running"] },
    { key: "file", n: files.length, one: "file", many: "files", states: [] },
    { key: "link", n: urls.length, one: "link", many: "links", states: [] },
  ]
  return counts.filter((count) => count.n > 0)
}
