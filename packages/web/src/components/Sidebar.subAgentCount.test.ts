import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { SubAgentView, ThreadView } from "@frizz/shared"
import { RailRow, type RowScope } from "./Sidebar.tsx"
import { TooltipProvider } from "./Tooltip.tsx"

// The rail shows a thread's live children as a count on the thread's own row — no line of their own.
// The count is every child the drawer would list, at every depth; the names ride its tooltip.

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

test("a thread's live children are a count on its row, every depth included, and no rows of their own", () => {
  const html = rail("count", CHILDREN)
  assert.match(html, /data-rail-subagents="count" title="fix-r1, fix-r2, impl-flow, impl-w3" aria-label="4 sub-agents"/)
  assert.match(html, /aria-label="4 sub-agents"[^>]*><span aria-hidden="true"[^>]*><svg[\s\S]*?<\/svg><\/span><span class="tabular-nums">4</, "the robot, then the number, as the project row's counts read")
  for (const name of [">fix-r1<", ">impl-flow<", ">impl-w3<"]) assert.ok(!html.includes(name), `${name} is not drawn as a row`)
  assert.ok(!html.includes("data-op-row") && !html.includes("data-subagent-parent"), "no child row renders in the rail")
})

test("one child reads singular", () => {
  assert.match(rail("one", [{ id: "a1", label: "solo" }]), /aria-label="1 sub-agent"/)
})

test("a thread with no live child draws no count", () => {
  assert.ok(!rail("none", []).includes("data-rail-subagents"))
  assert.ok(!rail("gone", [{ id: "done", label: "fix:r9", state: "returned" }]).includes("data-rail-subagents"))
})
