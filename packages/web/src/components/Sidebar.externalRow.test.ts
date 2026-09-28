import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ThreadView } from "@frizz/shared"
import { ThreadRow } from "./Sidebar.tsx"
import { TooltipProvider } from "./Tooltip.tsx"

// An EXTERNAL row (the human's own `claude`/`codex` session) once wore a `terminal` pill. Since the
// prompt box's Terminal tab, "terminal" names a command thread — a different kind of row with a live
// pty behind it — so the pill claimed a kind the row is not. The External band's header already says
// where the row came from, so the row carries no tag of its own.

function row(extra: Partial<ThreadView>) {
  const t = { kind: "session", backend: "claude", title: "A thread", status: "active", runtime: "turn-idle", subAgents: [], id: "thread", ...extra } as unknown as ThreadView
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(TooltipProvider, null, createElement(ThreadRow, { t })),
    ),
  )
}

test("an external row is not labelled a terminal", () => {
  const html = row({ foreign: true })
  assert.match(html, /data-xq-thread-row/)
  assert.doesNotMatch(html, />\s*terminal\s*</i)
})
