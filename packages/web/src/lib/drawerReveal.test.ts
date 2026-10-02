import assert from "node:assert/strict"
import test from "node:test"
import { JUMP_CLEARANCE_PX, nearestScrollDelta, revealInDrawerTranscript } from "./drawerReveal.ts"

const viewport = { top: 100, bottom: 700 }

test("a part already in view, clearance included, does not move the transcript", () => {
  assert.equal(nearestScrollDelta({ top: 200, bottom: 600 }, viewport, JUMP_CLEARANCE_PX), 0)
  assert.equal(nearestScrollDelta({ top: 100, bottom: 644 }, viewport, JUMP_CLEARANCE_PX), 0)
})

test("a part grown below the fold scrolls down until its bottom clears the jump control", () => {
  // Bottom at 690: in the viewport, but under the 56px the control occupies.
  assert.equal(nearestScrollDelta({ top: 500, bottom: 690 }, viewport, JUMP_CLEARANCE_PX), 46)
  assert.equal(nearestScrollDelta({ top: 650, bottom: 800 }, viewport, JUMP_CLEARANCE_PX), 156)
})

test("a part taller than the room is aligned by its TOP, never scrolled past it", () => {
  // 900px of follow-up below 650: scrolling its bottom into view would push its top 400px off screen.
  assert.equal(nearestScrollDelta({ top: 650, bottom: 1550 }, viewport, JUMP_CLEARANCE_PX), 550)
})

test("a part above the viewport scrolls up to its top", () => {
  assert.equal(nearestScrollDelta({ top: 40, bottom: 140 }, viewport, JUMP_CLEARANCE_PX), -60)
})

test("outside a drawer transcript nothing is scrolled", () => {
  const el = { closest: () => null, getBoundingClientRect: () => ({ top: 0, bottom: 0 }) } as unknown as Element
  assert.equal(revealInDrawerTranscript(el), false)
  assert.equal(revealInDrawerTranscript(null), false)
})

test("inside one, ONLY that scroller moves, by the nearest delta", () => {
  const scroller = { scrollTop: 300, getBoundingClientRect: () => viewport }
  const el = { closest: (sel: string) => (sel === "[data-drawer-transcript-scroll]" ? scroller : null), getBoundingClientRect: () => ({ top: 650, bottom: 800 }) } as unknown as Element
  assert.equal(revealInDrawerTranscript(el), true)
  assert.equal(scroller.scrollTop, 456)
})

test("several parts opened together are revealed as one span, so the first stays in view", () => {
  const scroller = { scrollTop: 0, getBoundingClientRect: () => viewport }
  const at = (top: number, bottom: number) => ({ closest: () => scroller, getBoundingClientRect: () => ({ top, bottom }) }) as unknown as Element
  // Two follow-ups, 650-900 and 910-1200: revealing the second alone would scroll 556 and push the first
  // (top 650) above the viewport; the span scrolls 550, its top, and the first follow-up leads.
  assert.equal(revealInDrawerTranscript([at(650, 900), at(910, 1200)]), true)
  assert.equal(scroller.scrollTop, 550)
  assert.equal(revealInDrawerTranscript([]), false)
})
