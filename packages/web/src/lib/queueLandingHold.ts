// THE LANDING HOLD: a queue card a cold link landed on STAYS where it landed while the queue above it is
// still finding its height, and lets go the moment the reader takes the scroll. Upstream's
// lib/queueLandingHold.ts (aad5298d), ported to this page's cards (`[data-xq-card]`, AllQueues.tsx) and
// to its viewport lock.
//
// A landing is a one-shot measurement, and a one-shot measurement is only right if the document has
// stopped moving. On a cold deep link it has not. Upstream measured it on 2026-10-05 against a real stack,
// `/thread/route-b` at 1440×900 with route-a's card above it: the landing ran when the whole document was
// still 900px tall (both cards were skeletons waiting on their transcripts), so it asked for scrollY 450
// and the browser clamped it to 0. The transcripts then arrived and route-a's pictures loaded, the
// document grew to 3,638px, and route-b's card slid 491 → 1,127 → 1,957 with nothing left to bring it
// back — the reader saw "Route A thread" under a URL that named route-b. Here the cards far down the page
// are not even built until they come near the screen (lib/cardVisibility.ts), so the cards above a landing
// lay out at their real height only after it.
//
// THIS PAGE'S VIEWPORT LOCK (lib/viewportLock.ts) cannot rescue it either: it holds the card the reader
// is ENGAGED with, which on a clamped landing is whichever card the clamp left at the reading line, not
// the one the address named. So the lock stands aside while the hold is armed (suspendViewportLock, the
// bracket glideTo uses for the same reason — a move the reader asked for is not drift), and re-takes its
// anchor from wherever the hold leaves the page.
//
// So the landing is HELD rather than taken once: every time the layout moves, re-land the card. What
// makes that safe is telling a LAYOUT shift from a READER's scroll, and two signals do it:
//   · INPUT. A wheel, a touch, a pointer press or a key on this page means a person is acting on it,
//     and the hold ends on the spot — before the scroll that input produces has even been dispatched.
//   · GEOMETRY, for a scroll with no input event behind it (dragging the page's own scrollbar sends
//     none). A scroll that moved scrollY while the card's DOCUMENT offset and the document height
//     both stayed put cannot have been caused by layout — content moving above the card changes the
//     first, a clamp changes the second — so it is the reader's, and the hold ends (landingScrollCause).
// And it is bounded: QUEUE_LANDING_HOLD_MS after it was armed it releases on its own, and the lock takes
// over again.
//
// Corrections run in a ResizeObserver callback, which the browser delivers after layout and BEFORE
// paint, so a card that builds above the landing never paints a frame with the landed card displaced.

import { isPageScrollLocked, pageScrollY } from "./pageScrollLock.ts"
import { resumeViewportLock, suspendViewportLock } from "./viewportLock.ts"

// Long enough to outlast a cold page's transcript fetches and picture decodes over a slow tunnel
// (upstream's measured cold load settled at ~3.9s, most of it the dev server compiling); short enough
// that a hold nobody released by touching the page still ends. Any input ends it far sooner.
export const QUEUE_LANDING_HOLD_MS = 10_000

// Where the held card and the document stood the last time the hold set the scroll.
export type LandingSample = {
  // The card's top in DOCUMENT coordinates (scrollY + its viewport top). Content above the card
  // changing height moves this; a scroll does not.
  cardOffset: number
  docHeight: number
  scrollY: number
}

// Below this a difference is sub-pixel rounding, not movement.
const EPSILON = 0.5

// Why the page moved since `pinned`, decided from geometry alone:
//   "layout" — the card's place in the document or the document's height changed, so whatever else
//              happened, the landing has to be re-applied;
//   "reader" — only scrollY changed: nothing in the layout can explain it, so a person scrolled;
//   "none"   — nothing moved (our own scrollTo's echo, or a repeat event).
// Layout wins a tie on purpose: if a card builds in the same frame as a reader's scrollbar drag, one
// frame of re-landing is the cost, and the drag's next frame (layout now still) releases the hold.
export function landingScrollCause(pinned: LandingSample, now: LandingSample): "layout" | "reader" | "none" {
  if (Math.abs(now.cardOffset - pinned.cardOffset) > EPSILON || Math.abs(now.docHeight - pinned.docHeight) > EPSILON) return "layout"
  if (Math.abs(now.scrollY - pinned.scrollY) > EPSILON) return "reader"
  return "none"
}

// Every event a person produces when they take the scroll for themselves. Listened for on the WINDOW in
// the capture phase, so no component's stopPropagation can hide one from the hold.
const READER_INPUT = ["wheel", "touchstart", "pointerdown", "keydown"] as const

let releaseCurrent: (() => void) | null = null

/** End the hold, if one is armed. */
export function releaseQueueLandingHold(): void {
  releaseCurrent?.()
}

/**
 * Arm a hold for the card `card()` resolves to, landing it at the page offset `targetY()`. Both are
 * getters because the card can re-render into a new element and the target moves with the layout.
 * Replaces any earlier hold: the newest landing wins.
 */
export function holdQueueCardLanding(card: () => HTMLElement | null, targetY: () => number | null): void {
  releaseQueueLandingHold()
  if (typeof window === "undefined" || typeof window.addEventListener !== "function" || typeof ResizeObserver === "undefined") return

  let pinned: LandingSample | null = null
  let released = false

  const sample = (el: HTMLElement): LandingSample => {
    const scrollY = pageScrollY()
    return { cardOffset: scrollY + el.getBoundingClientRect().top, docHeight: document.documentElement.scrollHeight, scrollY }
  }

  const reland = () => {
    if (released) return
    // While a drawer holds the page lock the lock owns the offset (a scroll would be clamped, then
    // overwritten by the unlock — lib/pageScrollLock). Forget the sample; the unlock's own scroll
    // event re-lands from scratch.
    if (isPageScrollLocked()) {
      pinned = null
      return
    }
    const el = card()
    const y = targetY()
    if (!el || y === null) return release()
    if (Math.abs(window.scrollY - y) > EPSILON) window.scrollTo({ top: y, left: 0, behavior: "instant" })
    // Sampled AFTER the scroll, and from the browser, not from `y`: when the document is still too short
    // for the landing the scroll is clamped, and the clamped offset is the one a later echo reports.
    pinned = sample(el)
  }

  const onScroll = () => {
    if (released || isPageScrollLocked()) return
    const el = card()
    if (!el) return release()
    if (!pinned) return reland()
    const cause = landingScrollCause(pinned, sample(el))
    if (cause === "reader") release()
    else if (cause === "layout") reland()
  }

  const onInput = () => release()

  // The document's height is what a card growing above changes, so the BODY is the main subject. The
  // queue's slots are observed as well, which catches a card above growing while another shrinks by
  // the same amount — a change the body's height alone would not show.
  const observer = new ResizeObserver(reland)
  observer.observe(document.body)
  for (const slot of document.querySelectorAll<HTMLElement>("[data-xq-card]")) observer.observe(slot)

  suspendViewportLock()
  const timer = window.setTimeout(() => release(), QUEUE_LANDING_HOLD_MS)
  window.addEventListener("scroll", onScroll, { passive: true })
  for (const type of READER_INPUT) window.addEventListener(type, onInput, { capture: true, passive: true })

  function release(): void {
    if (released) return
    released = true
    observer.disconnect()
    window.clearTimeout(timer)
    window.removeEventListener("scroll", onScroll)
    for (const type of READER_INPUT) window.removeEventListener(type, onInput, { capture: true })
    if (releaseCurrent === release) releaseCurrent = null
    resumeViewportLock()
  }
  releaseCurrent = release
  reland()
}
