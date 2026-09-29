import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ThreadStatusLine } from "./ThreadStatusLine.tsx"

// The live status sits at the end of a header's metadata line, beside a name that stays put. With no
// status it renders NOTHING — not a dangling separator; with one, it takes only the room left (`flex-1`)
// and truncates there, so nothing before it on the line gives up width.

test("no status renders nothing", () => {
  assert.equal(renderToStaticMarkup(createElement(ThreadStatusLine, { status: undefined, lead: "·" })), "")
  assert.equal(renderToStaticMarkup(createElement(ThreadStatusLine, { status: "   ", lead: "·" })), "")
})

test("a status renders after its separator, truncating, with the whole line on hover", () => {
  const html = renderToStaticMarkup(createElement(ThreadStatusLine, { status: "Waiting on CI for the budget fix", lead: createElement("span", { "aria-hidden": true }, "·") }))
  assert.match(html, /^<span aria-hidden="true">·<\/span><span data-thread-status="true" class="min-w-0 flex-1 truncate[^"]*" title="Waiting on CI for the budget fix">Waiting on CI for the budget fix<\/span>$/)
})
