import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { statusElapsed, ThreadStatusLine } from "./ThreadStatusLine.tsx"

// The live status sits at the end of a header's metadata line, beside a name that stays put. With no
// status it renders NOTHING — not a dangling separator; with one, it takes only the room left (`flex-1`)
// and truncates there, so nothing before it on the line gives up width. While the thread works, the
// task's clock follows the text and never truncates.

const NOW = Date.parse("2026-09-29T10:00:00.000Z")
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString()

test("no status renders nothing", () => {
  assert.equal(renderToStaticMarkup(createElement(ThreadStatusLine, { thread: { statusLine: undefined }, lead: "·" })), "")
  assert.equal(renderToStaticMarkup(createElement(ThreadStatusLine, { thread: { statusLine: "   " }, lead: "·" })), "")
})

test("a status renders after its separator, truncating, with the whole line on hover", () => {
  const html = renderToStaticMarkup(createElement(ThreadStatusLine, {
    thread: { statusLine: "Waiting on CI for the budget fix", statusSince: minutesAgo(4), runtime: "turn-idle" },
    lead: createElement("span", { "aria-hidden": true }, "·"),
  }))
  assert.match(html, /^<span aria-hidden="true">·<\/span><span data-thread-status="true" class="[^"]*flex-1[^"]*"><span class="min-w-0 truncate[^"]*" title="Waiting on CI for the budget fix">Waiting on CI for the budget fix<\/span><\/span>$/)
  assert.doesNotMatch(html, /data-thread-status-elapsed/, "a resting thread shows no clock")
})

test("a working thread's status carries how long it has been on that task", () => {
  const working = { statusLine: "Tracing the cache miss", statusSince: minutesAgo(12), runtime: "running" as const }
  assert.equal(statusElapsed(working, NOW), "12m")
  assert.equal(statusElapsed({ ...working, statusSince: minutesAgo(75) }, NOW), "1h 15m")
  assert.equal(statusElapsed({ ...working, statusSince: new Date(NOW - 20_000).toISOString() }, NOW), "<1m")
  assert.equal(statusElapsed({ ...working, runtime: "turn-idle" }, NOW), undefined)
  assert.equal(statusElapsed({ ...working, statusSince: undefined }, NOW), undefined)
  const html = renderToStaticMarkup(createElement(ThreadStatusLine, { thread: { ...working, statusSince: new Date(Date.now() - 12.5 * 60_000).toISOString() } }))
  assert.match(html, /<span data-thread-status-elapsed="true" class="shrink-0[^"]*">12m<\/span>/)
})
