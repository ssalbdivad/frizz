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

// THE ONE WRITER OF THE PINNED OFFSET (null unpins). Until 2026-10-08 it also published the offset as
// `--page-lock-offset` for the desktop page's min-height, which kept a STICKY left column's container
// reaching the fold under a pin; the column is fixed to the viewport now (Sidebar.tsx SIDEBAR_COLUMN_CLASS),
// so nothing reads the page's height for it.
//
// Never deeper than the page: a native scroll clamps to the document's end, a pinned top does not. A long
// card leaving the queue under an open drawer (its thread started running) shortened the page by its
// height and left the pin past the end, so the queue showed nothing and the thread out of the rail ran
// off the top of the window to a card above it (2026-10-08). So every write is clamped, and App re-clamps
// whenever the pinned page changes height (`clampPinnedPage`).
export function pinPageAt(top: number | null): void {
  document.body.style.top = top === null ? "" : `${clampPin(top, document.body.getBoundingClientRect().height, window.innerHeight)}px`
}

/** The pinned top (`-y`) held within the page: no deeper than its end, never below 0. */
export function clampPin(top: number, pageHeight: number, viewportHeight: number): number {
  return Math.min(0, Math.max(top, -Math.max(0, pageHeight - viewportHeight))) || 0
}

/** Re-applies the clamp to the current pin, for a page that got shorter under it. */
export function clampPinnedPage(): void {
  if (isPageScrollLocked()) pinPageAt(-pageScrollY())
}

export function isPageScrollLocked(): boolean {
  return typeof document !== "undefined" && document.body?.style.position === "fixed"
}
