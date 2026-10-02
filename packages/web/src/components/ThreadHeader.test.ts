import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { PANE_HEADER_HEIGHT_CLASS } from "../lib/paneHeaderHeight.ts"
import { THREAD_HEADER_CLASS, THREAD_HEADER_CONTAINER_CLASS, THREAD_HEADER_CONTROLS_CLASS, THREAD_HEADER_NARROW, THREAD_HEADER_TITLE_CLASS } from "../lib/threadHeaderLayout.ts"

const tokens = (classes: string) => classes.split(/\s+/).filter(Boolean)
const narrowPrefix = `${THREAD_HEADER_NARROW}:`
// Any responsive variant at all — a viewport breakpoint (`max-[640px]:`, `sm:`) or a container one.
const RESPONSIVE = /^(?:@?(?:max-)?(?:\[[^\]]+\]|xs|sm|md|lg|xl|2xl|3xs|2xs)(?:\/[\w-]+)?):/

// The thread header is the one pane header not drawn by ui/SheetHeader, so it is the one that can
// drift: it measured 52.75px beside the file viewer's 48 when it carried a minimum plus padding. One
// row wide it is the shared fixed height, bare of vertical padding; only the narrow two-row wrap goes auto.
test("thread header is the fixed pane-header height, and only the two-row wrap may exceed it", () => {
  const wide = tokens(THREAD_HEADER_CLASS).filter((token) => !token.startsWith(narrowPrefix))
  assert.ok(wide.includes(PANE_HEADER_HEIGHT_CLASS), `wide tokens carry ${PANE_HEADER_HEIGHT_CLASS}: ${wide.join(" ")}`)
  assert.equal(wide.find((token) => /^(min-h-|py-|pt-|pb-)/.test(token)), undefined)
  assert.ok(tokens(THREAD_HEADER_CLASS).includes(`${narrowPrefix}h-auto`))
  assert.ok(tokens(THREAD_HEADER_CLASS).includes(`${narrowPrefix}min-h-12`))
})

test("drawer thread header reserves a separate, unbroken control row before the sheet becomes cramped", () => {
  assert.ok(tokens(THREAD_HEADER_CLASS).includes(`${narrowPrefix}flex-wrap`))
  assert.ok(tokens(THREAD_HEADER_CLASS).includes(`${narrowPrefix}gap-y-2`))
  assert.ok(tokens(THREAD_HEADER_TITLE_CLASS).includes("min-w-0"))
  assert.ok(tokens(THREAD_HEADER_TITLE_CLASS).includes(`${narrowPrefix}basis-full`))
  assert.ok(tokens(THREAD_HEADER_CONTROLS_CLASS).includes(`${narrowPrefix}w-full`))
  assert.ok(tokens(THREAD_HEADER_CONTROLS_CLASS).includes(`${narrowPrefix}justify-between`))
  assert.doesNotMatch(THREAD_HEADER_CLASS, /provider/i)
})

// The wrap is the DRAWER's call, not the window's. A viewport variant (`max-[640px]`) always applied
// inside VS Code's sidebar, whose frame IS the window, so a 450px sidebar drew 92px of two-row header
// for a row that fits. Every responsive token here must be the one container condition, and the
// container must be the header's own wrapper, named so nothing between them can answer instead.
test("the two-row wrap keys on the header's own container, never on the viewport", () => {
  assert.match(THREAD_HEADER_NARROW, /^@max-\[[\d.]+rem\]\/thread-header$/)
  assert.ok(tokens(THREAD_HEADER_CONTAINER_CLASS).includes("@container/thread-header"))
  for (const classes of [THREAD_HEADER_CLASS, THREAD_HEADER_TITLE_CLASS, THREAD_HEADER_CONTROLS_CLASS]) {
    for (const token of tokens(classes).filter((t) => RESPONSIVE.test(t))) {
      assert.ok(token.startsWith(narrowPrefix), `${token} keys on ${narrowPrefix.slice(0, -1)}`)
    }
  }
  // Negative control: the old viewport spelling is caught by the same predicate.
  assert.ok(RESPONSIVE.test("max-[640px]:h-auto") && !"max-[640px]:h-auto".startsWith(narrowPrefix))
  // The header wears the wrapper, and the bar's drawing (border, fill, height) stays on the header.
  const chat = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")
  assert.match(chat, /<div className=\{THREAD_HEADER_CONTAINER_CLASS\}>\s*<header\s+data-thread-header\s+className=\{THREAD_HEADER_CLASS\}/)
  assert.doesNotMatch(THREAD_HEADER_CONTAINER_CLASS, /border|bg-|h-12|px-|py-/)
})

// The title wraps to two lines on the SAME condition, so it can only ever do it in the two-row header,
// where it has a row to itself. Tailwind generates a class from its literal text, so ThreadTitle spells
// the condition out — this keeps the two spellings one.
test("the title's narrow wrap uses the header's one condition", () => {
  const title = readFileSync(new URL("./ThreadTitle.tsx", import.meta.url), "utf8")
  const variants = [...title.matchAll(/@max-\[[^\]]+\]\/[\w-]+:/g)].map((m) => m[0])
  assert.ok(variants.length >= 2, "ThreadTitle wraps its name in the narrow header")
  for (const variant of variants) assert.equal(variant, narrowPrefix)
  assert.ok(title.includes(`${narrowPrefix}line-clamp-2`))
})
