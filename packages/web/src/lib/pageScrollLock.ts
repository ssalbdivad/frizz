// The PAGE scroll lock and the one thing that has to survive it.
//
// While any overlay is open, App pins the page with the body-fixed dance (`body{position:fixed;
// top:-y}` — see App.tsx for why it isn't `overflow:hidden`). Two consequences bite anything that
// wants to scroll the page WHILE a drawer is on screen or sliding out:
//
//   1. `window.scrollY` reads 0 and the document collapses to viewport height, so `window.scrollTo`
//      is silently clamped to a no-op. Every measurement has to come off the lock's own offset.
//   2. The unlock RESTORES the captured offset, so even a scroll that did land would be undone.
//
// So every measurement goes through pageScrollY below, and a correction made under the lock moves the
// body's pinned top rather than the window (lib/viewportLock.ts), which App's unlock then restores.
// (Until 2026-09-28 a scroll could also PARK its landing here for the unlock to honour, so the project
// board's queued row could dismiss the open drawer and still auto-scroll to its card; nothing parks one
// on Everything, and requestScrollAfterUnlock / takeScrollAfterUnlock went with that board.)

// The document scroll offset, whether or not the page is locked. Under the lock the body is shifted
// up by the captured offset, so `-body.style.top` is the real scrollY and every getBoundingClientRect
// is already relative to it.
export function pageScrollY(): number {
  if (typeof document === "undefined" || !document.body) return typeof window === "undefined" ? 0 : window.scrollY
  const top = isPageScrollLocked() ? Number.parseFloat(document.body.style.top) : Number.NaN
  return Number.isNaN(top) ? window.scrollY : -top
}

// THE ONE WRITER OF THE PINNED OFFSET (null unpins). It also publishes the offset as
// `--page-lock-offset`, which the desktop page adds to its `min-height` (AllQueues.tsx), and that is what
// keeps the left column on screen. The column is `position: sticky`, and sticky can never carry a box
// past the bottom of its container. Unlocked, the browser clamps scrollY whenever the document shrinks,
// so the container always reaches the fold; pinned, nothing clamps `top`. Dismiss cards under an open
// drawer (or let viewportLock move the pin) until the page is shorter than `-top + 100vh`, and the
// container ends above the fold and drags the column up with it — half the sidebar, or all of it, gone
// until the drawer closed (reproduced 2026-10-07: scrolled 1200px, shrink the queue under a drawer,
// aside at top -1200). With the page held at least that tall the container always reaches the fold;
// the unlock's own scrollTo clamps the offset back to the real document.
export function pinPageAt(top: number | null): void {
  const body = document.body
  const root = document.documentElement
  if (top === null) {
    body.style.top = ""
    root.style.removeProperty("--page-lock-offset")
    return
  }
  body.style.top = `${top}px`
  root.style.setProperty("--page-lock-offset", `${Math.max(0, -top)}px`)
}

export function isPageScrollLocked(): boolean {
  return typeof document !== "undefined" && document.body?.style.position === "fixed"
}
