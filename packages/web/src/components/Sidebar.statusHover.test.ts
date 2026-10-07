import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ThreadView } from "@frizz/shared"
import { ThreadRow, type RowScope } from "./Sidebar.tsx"
import { TooltipProvider } from "./Tooltip.tsx"
import { prefs } from "../lib/prefs.ts"

// A WORKING ROW'S STATUS: a HOVER on every row by default (a project's board from 2026-10-06, every row
// from 2026-10-07; Colin's standup of 2026-10-01: always-visible status lines are too dense for a
// sidebar), and inline after its name with Settings → Always show status lines (prefs
// `alwaysShowStatusLines`). The task clock stays on the line in both. The hover itself is a Radix
// tooltip, which renders nothing until it opens, so static markup can only pin WHERE it is attached; the
// browser QA reads the opened tip.

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

function row(t: ThreadView, alwaysShowStatusLines = false): string {
  prefs.alwaysShowStatusLines = alwaysShowStatusLines
  try {
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        createElement(TooltipProvider, null, createElement(ThreadRow, { t, scope: ROW_SCOPE })),
      ),
    )
  } finally {
    prefs.alwaysShowStatusLines = false
  }
}

test("by default a working row's status leaves the line for a hover on the title, and the clock stays", () => {
  const html = row(working)
  assert.doesNotMatch(html, /data-rail-status="true"/, "no inline status")
  assert.doesNotMatch(html, /Tracing the cache miss/, "the status text is nowhere on the row until hovered")
  assert.match(html, /data-rail-status-hover=""[^>]*>fix-/, "the title carries the hover")
  assert.match(html, /data-rail-working-age/, "the clock is still on the line")
})

test("with Always show status lines the status is inline after its name, beside its clock", () => {
  const html = row(working, true)
  assert.match(html, /data-rail-status="true"[^>]*>.*Tracing the cache miss/, "the status is on the line")
  assert.doesNotMatch(html, /data-rail-status-hover/, "and not a hover")
  assert.match(html, /data-rail-working-age/, "the clock is on the line")
})

test("a row that is not working has no status anywhere, inline or hover", () => {
  const resting = { ...working, runtime: "turn-idle" } as ThreadView
  for (const always of [false, true]) {
    const html = row(resting, always)
    assert.doesNotMatch(html, /data-rail-status/, `alwaysShowStatusLines=${always}`)
    assert.doesNotMatch(html, /data-rail-working-age/, `alwaysShowStatusLines=${always}`)
  }
})
