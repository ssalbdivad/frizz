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
export function pinPageAt(top: number | null): void {
  document.body.style.top = top === null ? "" : `${top}px`
}

export function isPageScrollLocked(): boolean {
  return typeof document !== "undefined" && document.body?.style.position === "fixed"
}
