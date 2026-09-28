// THE SCROLL HALF of "the queue never moves a card the human is looking at" (maintainer 2026-09-28:
// "it needs to be guaranteed that cards that I'm currently viewing on the screen don't move in their
// position"). lib/stableQueue.ts decides the ORDER — nothing is inserted between the cards on screen and
// none of them leaves on its own — which leaves every change either BELOW them, where it moves nothing,
// or ABOVE them, where it moves them in the document. This scrolls by exactly that much, before the
// frame paints, so on screen they have not moved.
//
// WHY NOT THE BROWSER'S OWN SCROLL ANCHORING, which exists to do exactly this: it fails in the places the
// queue puts the reader. Chrome does not anchor at scroll offset 0 — where the first card lands after
// every dismissal and every rail click to it — and it anchors on the first visible node in DOM order,
// which near the top is the READY header, ABOVE the insertion point. Both were probed (a card inserted
// above the reader moved it 840px in each), and FIFO puts the reader on the first card, so its normal
// working position was the one where anchoring never ran. So native anchoring is switched off on the
// document while a queue is on screen, and this does its job in every position.
//
// THE ANCHOR is the card the human is engaged with, in order: the one holding the keyboard focus (they
// are typing in it — the focused element itself is held, so the caret does not move), the one under
// the pointer (they are about to click something in it — the element under the pointer is held), else
// the one at the reading line a third of the way down the viewport (they are reading it — its first
// node visible from the top of the viewport is held, as the browser's own anchoring picks one). It is
// re-taken on every scroll, pointer move and focus change, and after every correction, so it always
// describes the page as the human last saw it; a change is measured against it and undone.
//
// It runs after every render of the queue (a layout effect: after the DOM changed, before paint) and
// whenever the document's size changes (a ResizeObserver: a card that fetched its transcript, an image
// that loaded — also before paint). A human's own scroll is never fought: it re-takes the anchor.
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react"
import { isPageScrollLocked, pageScrollY } from "./pageScrollLock.ts"

// ---- native anchoring: one owner ------------------------------------------------------------------

// Reference-counted, because more than one machinery suspends native anchoring around a deliberate
// correction (this lock for as long as a queue is mounted, the dismissal landing and the load-earlier
// dance in TodosView around theirs): if each captured the prior value on its own, one could catch
// another's "none" as the value to restore and leave anchoring off for the rest of the session. The
// FIRST suspend captures the real prior policy, the LAST release restores it.
let anchorSuspendCount = 0
let anchorPrevPolicy = ""
export function suspendNativeAnchoring(): void {
  if (anchorSuspendCount++ === 0) {
    anchorPrevPolicy = document.documentElement.style.overflowAnchor
    document.documentElement.style.overflowAnchor = "none"
  }
}
export function resumeNativeAnchoring(): void {
  if (anchorSuspendCount > 0 && --anchorSuspendCount === 0) {
    document.documentElement.style.overflowAnchor = anchorPrevPolicy
  }
}

// ---- deliberate moves: the lock stands aside ------------------------------------------------------

// A move the HUMAN asked for — the dismissal landing that brings the next card to the top after they
// finish one — must not be undone as if it were drift. It brackets itself with these; on the last
// release every mounted lock re-takes its anchor from wherever the move left the page.
let lockSuspendCount = 0
const resumeListeners = new Set<() => void>()
export function suspendViewportLock(): void {
  lockSuspendCount++
}
export function resumeViewportLock(): void {
  if (lockSuspendCount > 0 && --lockSuspendCount === 0) for (const listener of resumeListeners) listener()
}

// ---- geometry ---------------------------------------------------------------------------------------

interface Anchor {
  /** The element held still. */
  node: Element
  top: number
  /** Its card: held instead if the node itself is replaced by a re-render. */
  slot: HTMLElement
  slotTop: number
  /**
   * The page offset when it was taken. The anchor is re-taken a frame after a scroll, so a render can
   * land between the human's scroll and the re-take: measured against the offset, their scroll is theirs
   * and only what moved the content under them is undone.
   */
  scrollY: number
}

const onScreen = (rect: DOMRect, viewport: number): boolean => rect.bottom > 0 && rect.top < viewport

// Stuck to the viewport rather than carried by the content, so useless as an anchor: a card's sticky
// header stays at the top of the window while the card scrolls under it.
function pinned(element: Element): boolean {
  const position = getComputedStyle(element).position
  return position === "sticky" || position === "fixed" || position === "absolute"
}
function insidePinned(element: Element, slot: Element): boolean {
  for (let node: Element | null = element; node && node !== slot; node = node.parentElement) if (pinned(node)) return true
  return false
}

// The browser's own pick, done where it would not: descend to the first element whose top is visible,
// passing over anything pinned or empty. Children in block flow are in vertical order, so the scan
// stops at the first one reaching into the viewport.
function firstVisibleNode(slot: HTMLElement): Element {
  let node: Element = slot
  for (let depth = 0; depth < 32; depth++) {
    let next: Element | null = null
    for (const child of node.children) {
      const rect = child.getBoundingClientRect()
      if (rect.height === 0 || rect.bottom <= 0) continue
      if (pinned(child)) continue
      next = child
      break
    }
    if (!next) return node
    if (next.getBoundingClientRect().top >= 0) return next
    node = next
  }
  return node
}

function scrollPage(delta: number): void {
  if (isPageScrollLocked()) {
    // A drawer holds the page with the body pinned at `top: -y` (App.tsx); the page's real offset is that
    // top, and App's unlock restores whatever it reads there — so the correction lands after the drawer
    // closes too, instead of the unlock returning to an offset the content has since moved away from.
    const top = Number.parseFloat(document.body.style.top) || 0
    document.body.style.top = `${top - delta}px`
    return
  }
  window.scrollBy({ top: delta, left: 0, behavior: "instant" })
}

export interface ViewportLock {
  /** Keys of the cards on screen at the last measurement — lib/stableQueue.ts's `onScreen`. */
  onScreen: RefObject<ReadonlySet<string>>
}

/**
 * Hold the queue's cards still on screen. `slots` selects every card slot of this queue; `keyOf` reads a
 * slot's key (the one lib/stableQueue.ts orders by). `onGhostGone` is called when a ghost slot
 * (`data-queue-ghost`) has left the screen, so the owner can drop it now that nobody sees it go.
 */
export function useViewportLock(slots: string, keyOf: (slot: HTMLElement) => string | undefined, onGhostGone: () => void): ViewportLock {
  const onScreenRef = useRef<ReadonlySet<string>>(new Set())
  const anchor = useRef<Anchor | null>(null)
  const pointer = useRef<{ x: number; y: number } | null>(null)
  const latest = useRef({ slots, keyOf, onGhostGone })
  latest.current = { slots, keyOf, onGhostGone }

  // Measure the page as the human sees it now: which cards are on screen, and what to hold still.
  const take = useRef(() => {})
  take.current = () => {
    const { slots, keyOf } = latest.current
    const viewport = window.innerHeight
    const visible: HTMLElement[] = []
    const keys = new Set<string>()
    let ghostGone = false
    for (const slot of document.querySelectorAll<HTMLElement>(slots)) {
      const rect = slot.getBoundingClientRect()
      if (onScreen(rect, viewport)) {
        visible.push(slot)
        const key = keyOf(slot)
        if (key) keys.add(key)
      } else if (slot.hasAttribute("data-queue-ghost")) ghostGone = true
    }
    onScreenRef.current = keys
    anchor.current = pick(visible, viewport)
    if (ghostGone) latest.current.onGhostGone()
  }

  const pick = (visible: HTMLElement[], viewport: number): Anchor | null => {
    if (visible.length === 0) return null
    const scrollY = pageScrollY()
    const hold = (slot: HTMLElement, node: Element): Anchor => ({ node, top: node.getBoundingClientRect().top, slot, slotTop: slot.getBoundingClientRect().top, scrollY })
    const focused = document.activeElement
    if (focused && focused !== document.body) {
      const slot = visible.find((candidate) => candidate.contains(focused))
      if (slot) return hold(slot, focused)
    }
    const at = pointer.current
    if (at) {
      const under = document.elementFromPoint(at.x, at.y)
      const slot = under && visible.find((candidate) => candidate.contains(under))
      if (slot && under) return hold(slot, insidePinned(under, slot) ? slot : under)
    }
    const line = viewport / 3
    const reading = visible.find((slot) => { const rect = slot.getBoundingClientRect(); return rect.top <= line && rect.bottom >= line }) ?? visible[0]!
    return hold(reading, firstVisibleNode(reading))
  }

  // Undo whatever moved the anchor since it was taken.
  const hold = useRef(() => {})
  hold.current = () => {
    const held = anchor.current
    if (!held || lockSuspendCount > 0) return
    const scrolled = pageScrollY() - held.scrollY
    let delta = 0
    if (held.node.isConnected) delta = held.node.getBoundingClientRect().top - (held.top - scrolled)
    else if (held.slot.isConnected) delta = held.slot.getBoundingClientRect().top - (held.slotTop - scrolled)
    // The card itself is gone — the human put it away, and the dismissal landing owns what comes next.
    else return
    if (Math.abs(delta) > 0.5) scrollPage(delta)
  }

  // After every render of the queue: the DOM has changed, the frame has not painted.
  useLayoutEffect(() => {
    hold.current()
    take.current()
  })

  useEffect(() => {
    suspendNativeAnchoring()
    let frame = 0
    const retake = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => take.current())
    }
    const onPointer = (event: PointerEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY }
      retake()
    }
    const onLeave = () => {
      pointer.current = null
      retake()
    }
    // Layout that changed without the queue re-rendering: a card's own transcript arriving, an image.
    // ResizeObserver delivers after layout and before paint, so the correction is never seen.
    const observer = new ResizeObserver(() => {
      hold.current()
      take.current()
    })
    observer.observe(document.body)
    const onResume = () => take.current()
    resumeListeners.add(onResume)
    window.addEventListener("scroll", retake, { passive: true })
    window.addEventListener("resize", retake)
    document.addEventListener("pointermove", onPointer, { passive: true })
    document.documentElement.addEventListener("pointerleave", onLeave)
    window.addEventListener("blur", onLeave)
    document.addEventListener("focusin", retake)
    document.addEventListener("focusout", retake)
    take.current()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      resumeListeners.delete(onResume)
      window.removeEventListener("scroll", retake)
      window.removeEventListener("resize", retake)
      document.removeEventListener("pointermove", onPointer)
      document.documentElement.removeEventListener("pointerleave", onLeave)
      window.removeEventListener("blur", onLeave)
      document.removeEventListener("focusin", retake)
      document.removeEventListener("focusout", retake)
      resumeNativeAnchoring()
    }
  }, [])

  return { onScreen: onScreenRef }
}
