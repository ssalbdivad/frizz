import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { StateReading, agentTerminalEmpty } from "./TerminalSheet.tsx"
import { SheetHeader } from "./ui/SheetHeader.tsx"

// WHAT AN AGENT TERMINAL'S DRAWER SAYS IN PLACE OF ITS LOG. Each of these was a wrong sentence once.

test("a running shell whose named log is gone says so, rather than waiting for output that cannot come", () => {
  // Verified 2026-09-29: tasks/<id>.output deleted under a running shell, the RPC said `missing`, and the
  // drawer promised "Waiting for the first output…" because it asked `running` first.
  assert.equal(agentTerminalEmpty({ state: "running", missing: true }, false, 0), "The output file is gone.")
  assert.equal(agentTerminalEmpty({ state: "done", missing: true }, false, 0), "The output file is gone.")
  // Nothing named yet (between the launch and its ack, or a Monitor that has printed nothing): waiting.
  assert.equal(agentTerminalEmpty({ state: "running" }, false, 0), "Waiting for the first output…")
  assert.equal(agentTerminalEmpty({ state: "done" }, false, 0), "No output was captured.")
})

test("output already on screen is never replaced", () => {
  assert.equal(agentTerminalEmpty({ state: "running", missing: true }, false, 120), undefined, "a vanished log keeps the lines an open pane holds")
  assert.equal(agentTerminalEmpty({ state: "running" }, true, 120), undefined)
  // Not by a later `gone` either (the retired ring moved on, a re-register hid it for a tick): that unmounted
  // the xterm with its log and put "This terminal is closed." in its place.
  assert.equal(agentTerminalEmpty({ state: "gone" }, false, 120), undefined)
})

test("a poll that keeps failing before any reply says so", () => {
  assert.equal(agentTerminalEmpty(undefined, false, 0), "Waiting for the first output…")
  assert.equal(agentTerminalEmpty(undefined, true, 0), "Could not read this terminal's output. Retrying…")
})

test("gone and Codex take their own words", () => {
  assert.equal(agentTerminalEmpty({ state: "gone" }, false, 0), "This terminal is closed.")
  assert.equal(agentTerminalEmpty({ state: "running", outputUnavailable: true }, false, 0), "Codex hands this command's output to the agent when it checks in, so Frizz can't show it here.")
})

// ONE ORDER FOR ONE SHELL'S TWO NUMBERS, on every surface: the budget, then the age (the strip's and the
// rail's). The drawer header read `running · 20m · 39m left` beside a strip reading `39m left · 20m`.
test("the drawer's reading puts the budget before the age, as the strip does", () => {
  const html = renderToStaticMarkup(createElement(StateReading, { state: "running", age: "20m", budget: "39m left", attr: {} }))
  assert.equal(html.replace(/<[^>]*>/g, ""), "running · 39m left · 20m")
  assert.ok(html.indexOf("39m left") < html.indexOf("20m"))
})

// THE READING NEVER BREAKS MID-WORD (2026-09-30: `running · 34m left · 2…` at 390px). Each number is its own
// whole part in a one-line, clipped wrapping box, so a part that does not fit goes whole — and only the state
// word may truncate, alone. `running` beside a Stop says nothing the button does not, and a narrow header
// drops it (with the `·` after it), never the numbers.
test("the reading's parts give way whole, and a narrow header drops a `running` its Stop already says", () => {
  const html = renderToStaticMarkup(createElement(StateReading, { state: "running", age: "34m", budget: "12m left", stopShown: true, attr: { "data-x": "1" } }))
  const box = /<span data-x="1" class="([^"]*)"/.exec(html)?.[1]?.split(" ") ?? []
  for (const cls of ["flex", "flex-wrap", "h-[1lh]", "overflow-hidden", "min-w-0"]) assert.ok(box.includes(cls), `box: ${cls}`)
  assert.ok(!box.includes("truncate"), "the box as a whole never ellipsises a number")
  const parts = [...html.matchAll(/<span data-reading-part="true" class="([^"]*)">/g)].map((m) => m[1])
  assert.deepEqual(parts, ["shrink-0", "shrink-0"], "each number is whole, never shrunk")
  assert.match(html, /<span class="min-w-0 truncate @max-\[28rem\]:hidden ">running<\/span><span data-reading-part="true" class="shrink-0"><span class="@max-\[28rem\]:hidden"> · <\/span>12m left/)
  // No Stop (a finished run, a shell Frizz cannot stop), or a state that is not `running`: the word stays.
  const done = renderToStaticMarkup(createElement(StateReading, { state: "exit 2", tone: "danger", attr: {} }))
  assert.doesNotMatch(done, /@max-\[28rem\]:hidden/)
  const asking = renderToStaticMarkup(createElement(StateReading, { state: "waiting for input", age: "6m", tone: "attention", stopShown: true, attr: {} }))
  assert.doesNotMatch(asking, /@max-\[28rem\]:hidden/)
})

// A COMMAND IS SET IN MONO WHEREVER IT APPEARS: the row you click and the drawer it opens.
test("a terminal's drawer sets its command title in mono; any other title stays sans", () => {
  const mono = renderToStaticMarkup(createElement(SheetHeader, { title: 'read -p "Deploy?" x', titleMono: true, onClose: () => {} }))
  assert.match(mono, /<span class="[^"]*font-mono-keep text-\[12\.5px\] font-normal" title="read -p &quot;Deploy\?&quot; x">/)
  const sans = renderToStaticMarkup(createElement(SheetHeader, { title: "Test watch in the probe worktree", onClose: () => {} }))
  assert.doesNotMatch(sans, /font-mono-keep/)
  assert.match(sans, /text-\[13px\] font-medium/)
})

// ONE HEADER, TWO WIDTHS. Wide, the title and the reading share the first line on one BASELINE (centring them
// seated the agent drawer's reading 1.06px under its title); the title grows from zero to its own width, so a
// long one truncates rather than pushing the reading off the line. Under 28rem the title takes the first line
// alone and the reading leads the second, beside the folder — at 390px the one-line header had drawn `read…`.
test("the header's title and reading share a baseline, and a narrow header puts the reading beside the folder", () => {
  const html = renderToStaticMarkup(createElement(SheetHeader, { title: "Test watch in the probe worktree", subtitle: "~/repo", meta: createElement("span", null, "running"), onClose: () => {} }))
  const block = /<header[^>]*>(?:<[^>]*>)*?<div class="([^"]*)"/.exec(html)?.[1]?.split(" ") ?? []
  for (const cls of ["flex", "flex-wrap", "items-baseline"]) assert.ok(block.includes(cls), `block: ${cls}`)
  assert.ok(!block.includes("items-center"))
  const title = /<span class="([^"]*)" title="Test watch/.exec(html)?.[1]?.split(" ") ?? []
  for (const cls of ["grow", "basis-0", "max-w-max", "truncate", "@max-[28rem]:basis-full", "@max-[28rem]:max-w-full"]) assert.ok(title.includes(cls), `title: ${cls}`)
  const meta = /<span data-sheet-meta="true" class="([^"]*)"/.exec(html)?.[1]?.split(" ") ?? []
  for (const cls of ["shrink-0", "max-w-[70%]", "@max-[28rem]:order-2"]) assert.ok(meta.includes(cls), `meta: ${cls}`)
  const sub = /<span class="([^"]*)">~\/repo/.exec(html)?.[1]?.split(" ") ?? []
  for (const cls of ["basis-full", "@max-[28rem]:order-3", "@max-[28rem]:basis-0", "@max-[28rem]:grow"]) assert.ok(sub.includes(cls), `subtitle: ${cls}`)
})
