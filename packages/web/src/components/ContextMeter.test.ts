import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { ThreadView } from "@frizz/shared"
import { ContextMeter } from "./ContextMeter.tsx"

// The readout has two halves that are easy to break in opposite directions, so both are pinned here.
//
// ABSENCE must cost nothing. The server omits `context` entirely unless it has BOTH halves of the
// fraction, and the client's contract is that an absent reading renders zero bytes — no 0% dial, no empty
// ring, no "—". A regression here is invisible in review and immediately visible in the product, because
// every Claude thread is in exactly that state until its first turn ends.
//
// PRESENCE must stay WORDLESS. The dial is the whole surface — no percentage, no label — and every number
// lives in the hover/screen-reader label instead. And "thinner" must not become "smaller": the stroke was
// thinned from 3 to 2 with r raised to compensate, so the OUTER edge is still 7.5 units.

function thread(context?: { tokens: number; window: number }): ThreadView {
  // Only the field this component reads; the cast keeps the fixture honest about that rather than
  // inventing a whole plausible thread the assertions would not touch.
  return { id: "ctx", kind: "session", context } as unknown as ThreadView
}

// The hover panel (the numbers and "Compact now") is a closed Radix popover here, so it renders no
// markup: what this sees is the dial alone, which is the surface these tests pin.
function render(context?: { tokens: number; window: number }): string {
  return renderToStaticMarkup(createElement(ContextMeter, { thread: thread(context) }))
}

test("an absent reading renders NOTHING — no dial, no placeholder, no box", () => {
  assert.equal(render(undefined), "")
})

test("a meaningless denominator renders nothing rather than a fabricated fraction", () => {
  for (const window of [0, -1]) {
    assert.equal(render({ tokens: 4_000, window }), "", `window ${window} must render nothing`)
  }
})

test("NO numbers on the surface — every reading lives in the label", () => {
  const html = render({ tokens: 237_000, window: 272_000 })
  // The dial carries no text of its own. Anything between tags would be a label this component is
  // deliberately not drawing (a bare "87%" was tried here and dropped).
  assert.ok(!/>[^<]*\d/.test(html), `the surface must render no digits: ${html}`)
  // Both halves of the fraction go to the hover/screen-reader label instead — not away.
  assert.match(html, /aria-label="Context 87% full\s+237,000 of 272,000 tokens"/)
  // The percent is still exposed as data, which is what the e2e/DOM probes assert against.
  assert.match(html, /data-context-percent="87"/)
})

test("the percent is FLOORED — it reads 100% only when the context genuinely is full", () => {
  // 99.9% must not round up to a full dial.
  assert.match(render({ tokens: 271_999, window: 272_000 }), /data-context-percent="99"/)
  assert.match(render({ tokens: 272_000, window: 272_000 }), /data-context-percent="100"/)
})

test("a nearly-empty context still draws a hairline of arc, not a bare ring", () => {
  // The arc uses the UNFLOORED fraction, so a reading that floors to 0% is still visibly non-zero.
  const html = render({ tokens: 1_088, window: 272_000 })
  assert.match(html, /data-context-percent="0"/, "the reading floors to 0")
  const dash = html.match(/stroke-dasharray="([\d.]+)/)
  assert.ok(dash && Number(dash[1]) > 0, "the arc length must be > 0 even at a floored 0%")
})

test("a reading that overshoots its window clamps instead of wrapping past 12 o'clock", () => {
  const html = render({ tokens: 400_000, window: 272_000 })
  assert.match(html, /data-context-percent="100"/)
  const [, filled, circumference] = html.match(/stroke-dasharray="([\d.]+) ([\d.]+)"/)!
  assert.equal(filled, circumference, "an overshoot fills exactly one revolution, never more")
})

test("the ring is drawn with the same PEN as the glyphs beside it, and thinning it did not shrink it", () => {
  const html = render({ tokens: 136_000, window: 272_000 })
  const strokes = [...html.matchAll(/stroke-width="([\d.]+)"/g)].map((m) => Number(m[1]))
  assert.deepEqual(strokes, [1.25, 1.25], "track and arc share one stroke width")
  const radii = [...html.matchAll(/r="([\d.]+)"/g)].map((m) => Number(m[1]))
  assert.deepEqual(radii, [6.875, 6.875], "r rose as the stroke thinned")
  // The invariant that keeps "thinner" from silently becoming "smaller": r + half the stroke is the ring's
  // outer edge, and it must stay at 7.5 of the 16-unit viewBox (0.5 of clearance, centered on 8).
  assert.equal(radii[0]! + strokes[0]! / 2, 7.5, "the outer edge must not move when the stroke changes")
  // WHY 1.25 and not a rounder number. This dial sits between two lucide glyphs that draw at 12px with
  // strokeWidth 2 in a 24-unit viewBox — a 1.0px line. A 16-unit viewBox at the footer's 1.05em (12.6px)
  // scales by 0.7875, so the stroke has to be ~1.27 to paint the same 1px pen. At the old 2 it painted
  // 1.575px and the status cluster read as three different families. Pin the PAINTED width, because that
  // is the property that matters and it is the one a viewBox change would silently break.
  const paintedPx = strokes[0]! * (12.6 / 16)
  assert.ok(Math.abs(paintedPx - 1) < 0.05, `the ring must paint a ~1px line like its neighbours, got ${paintedPx}`)
})

test("the size stays INHERITED — an em-sized svg, never a px one", () => {
  const html = render({ tokens: 136_000, window: 272_000 })
  assert.match(html, /class="h-\[1\.05em\] w-\[1\.05em\][^"]*"/)
  // Anchored on the attribute boundary: an unanchored /(width|height)="\d+"/ matches INSIDE
  // `stroke-width="2"` and fails on a component that is perfectly correct.
  assert.ok(!/\s(width|height)="\d/.test(html), "no px dimensions on the svg")
})
