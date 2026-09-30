import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { SubAgentView, ThreadView } from "@frizz/shared"
import { RailRow, type RowScope } from "./Sidebar.tsx"
import { TooltipProvider } from "./Tooltip.tsx"
import { toggleSubAgentFold } from "../lib/subAgentFold.ts"

// The rail folds a thread's live children behind one "N sub-agents" line (lib/subAgentFold.ts). These pin
// the ROW: folded it shows the count and none of the names; open, it lists every child one indent step
// under the fold line.

const ROW_SCOPE: RowScope = { open: () => {}, page: true }
const STARTED = new Date(Date.now() - 5 * 60_000).toISOString()

function rail(id: string, subAgents: Partial<SubAgentView>[]): string {
  const thread = {
    id,
    kind: "session",
    title: "Refactor the resolver",
    titleLocked: true,
    backend: "claude",
    runtime: "turn-idle",
    status: "running",
    subAgents: subAgents.map((s) => ({ state: "running", startedAt: STARTED, ...s })),
  } as unknown as ThreadView
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(TooltipProvider, null, createElement(RailRow, { t: thread, active: false, scope: ROW_SCOPE })),
    ),
  )
}

const CHILDREN: Partial<SubAgentView>[] = [
  { id: "a1", label: "fix:r1" },
  { id: "a2", label: "fix:r2", state: "stale" },
  { id: "wf", label: "impl-flow", workflow: true },
  { id: "wf-1", label: "impl:W3", depth: 2, parentId: "wf" },
]

test("folded, a thread's children are one line naming how many, and none of their names", () => {
  const html = rail("fold-closed", CHILDREN)
  assert.match(html, /aria-label="2 sub-agents, 1 workflow" aria-expanded="false"/)
  assert.match(html, /title="fix:r1, fix:r2, impl-flow"/, "the names ride the tooltip")
  for (const name of [">fix:r1<", ">fix:r2<", ">impl:W3<"]) assert.ok(!html.includes(name), `${name} stays folded`)
  assert.match(html, /data-rail-subagents="fold-closed"/)
  // A running child spins the fold, so live work never leaves the rail.
  assert.match(html, /data-rail-subagents="fold-closed"[\s\S]*viewBox="0 0 15 15"/)
  // No age on the fold: the thread row above it already reads a time in that column.
  assert.ok(!/data-rail-subagents="fold-closed"[\s\S]*Working for/.test(html), "the folded line reads no age")
})

test("open, every child is listed one indent step under the fold line", () => {
  toggleSubAgentFold("fold-open")
  const html = rail("fold-open", CHILDREN)
  assert.match(html, /aria-label="2 sub-agents, 1 workflow" aria-expanded="true"/)
  for (const name of ["fix:r1", "fix:r2", "impl-flow", "impl:W3"]) assert.ok(html.includes(`>${name}<`), `${name} is listed`)
  // 26px clears the parent row's indicator column; each level under the fold steps 13px further.
  assert.match(html, /padding-left:39px[^>]*>[\s\S]*?>fix:r1</, "a direct child sits one step under the fold")
  assert.match(html, /padding-left:52px[^>]*>[\s\S]*?>impl:W3</, "a workflow's agent sits one step under its workflow")
  toggleSubAgentFold("fold-open")
})

test("a thread with no live child draws no fold", () => {
  assert.ok(!rail("fold-none", []).includes("data-rail-subagents"))
  assert.ok(!rail("fold-gone", [{ id: "done", label: "fix:r9", state: "returned" }]).includes("data-rail-subagents"))
})
