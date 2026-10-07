import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ThreadView } from "@frizz/shared"
import { ThreadRow, type RowScope } from "./Sidebar.tsx"
import { TooltipProvider } from "./Tooltip.tsx"

// A WORKING ROW'S STATUS: inline after its name on All projects, a HOVER on a project's board (2026-10-06,
// Colin's standup of 2026-10-01: always-visible status lines are too dense for a sidebar). The task clock
// stays on the line in both. The hover itself is a Radix tooltip, which renders nothing until it opens,
// so static markup can only pin WHERE it is attached; the browser QA reads the opened tip.

const ROW_SCOPE: RowScope = { open: () => {}, page: true }

const working = {
  kind: "session",
  backend: "claude",
  title: "Fix the parser",
  status: "active",
  runtime: "running",
  subAgents: [],
  id: "thread",
  statusLine: "Tracing the cache miss",
  statusSince: new Date(Date.now() - 254_000).toISOString(),
} as unknown as ThreadView

function row(t: ThreadView, statusOnHover?: boolean): string {
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(TooltipProvider, null, createElement(ThreadRow, { t, scope: ROW_SCOPE, statusOnHover })),
    ),
  )
}

test("on All projects a working row's status is inline after its name, beside its clock", () => {
  const html = row(working)
  assert.match(html, /data-rail-status="true"[^>]*>.*Tracing the cache miss/, "the status is on the line")
  assert.doesNotMatch(html, /data-rail-status-hover/, "and not a hover")
  assert.match(html, /data-rail-working-age/, "the clock is on the line")
})

test("on a board the status leaves the line for a hover on the title, and the clock stays", () => {
  const html = row(working, true)
  assert.doesNotMatch(html, /data-rail-status="true"/, "no inline status")
  assert.doesNotMatch(html, /Tracing the cache miss/, "the status text is nowhere on the row until hovered")
  assert.match(html, /data-rail-status-hover=""[^>]*>fix-/, "the title carries the hover")
  assert.match(html, /data-rail-working-age/, "the clock is still on the line")
})

test("a row that is not working has no status anywhere, inline or hover", () => {
  const resting = { ...working, runtime: "turn-idle" } as ThreadView
  for (const statusOnHover of [false, true]) {
    const html = row(resting, statusOnHover)
    assert.doesNotMatch(html, /data-rail-status/, `statusOnHover=${statusOnHover}`)
    assert.doesNotMatch(html, /data-rail-working-age/, `statusOnHover=${statusOnHover}`)
  }
})
