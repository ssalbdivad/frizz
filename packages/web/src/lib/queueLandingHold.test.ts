import assert from "node:assert/strict"
import test from "node:test"
import { landingScrollCause, type LandingSample } from "./queueLandingHold.ts"

// The hold's whole safety rests on this one reading: a scroll the LAYOUT explains is re-landed, a scroll
// nothing in the layout explains is the reader's and ends the hold. The browser half (input events,
// the ResizeObserver, the clamp) was pinned upstream by queueLandingHold.e2e.test.ts on its board; here
// it is driven on a real stack (store.ts resolveRoutedThread, AllQueues.tsx useRoutedLanding).
const pinned: LandingSample = { cardOffset: 1859, docHeight: 3638, scrollY: 1819 }

test("only scrollY moving is the reader's scroll", () => {
  assert.equal(landingScrollCause(pinned, { ...pinned, scrollY: 1119 }), "reader")
})

test("content growing above the card is layout, whether or not something already moved the scroll with it", () => {
  // No anchoring: the card's document offset moved and scrollY did not.
  assert.equal(landingScrollCause(pinned, { ...pinned, cardOffset: 3259, docHeight: 5038 }), "layout")
  // Compensated (native anchoring upstream, the viewport lock here): scrollY moved too, but the card's offset says why.
  assert.equal(landingScrollCause(pinned, { cardOffset: 3259, docHeight: 5038, scrollY: 3219 }), "layout")
})

test("a clamp from the document shrinking is layout, not the reader", () => {
  assert.equal(landingScrollCause(pinned, { ...pinned, docHeight: 2400, scrollY: 1500 }), "layout")
})

test("the echo of the hold's own scroll, and sub-pixel rounding, are nothing", () => {
  assert.equal(landingScrollCause(pinned, { ...pinned }), "none")
  assert.equal(landingScrollCause(pinned, { cardOffset: 1859.4, docHeight: 3638.3, scrollY: 1819.5 }), "none")
})
