// REVEAL SOMETHING THAT JUST GREW, inside a thread drawer's transcript and nowhere else.
//
// An answer card can grow under the human's own click — a pick opens follow-up questions, "Grant for
// session" opens its confirmation — and the growth lands below the fold, where the floating "Jump to
// latest" control sits over it (ChatView JumpToLatest; in a 300px VS Code sidebar that covered "Confirm
// grant for session" and the follow-up rows). The answer is to scroll the new part into view, "nearest",
// clear of that control.
//
// NOT `Element.scrollIntoView`. That scrolls EVERY scrollable ancestor, frames included, and the drawer
// is a fixed layer whose transcript is the one region that should move: in VS Code's sidebar the page is
// a frame inside the editor's own workbench, whose `overflow: hidden` panes are still programmatically
// scrollable. This moves the transcript's scroller and nothing else. Only inside a drawer: the queue page
// owns its own scroll position (lib/viewportLock.ts).

/** Clearance below a revealed element: the jump control's layer pads 16px (p-4) and the control is 28-30px
 *  tall, so 56px keeps the revealed part's last row out from under it. */
export const JUMP_CLEARANCE_PX = 56

const SCROLLER = "[data-drawer-transcript-scroll]"

/** How far to scroll (positive = down) so `target` sits inside `viewport` the "nearest" way, with
 *  `clearance` kept free under it: scroll down until its bottom (plus clearance) is in view, but never so
 *  far that its top leaves the viewport; scroll up until its top is in view. 0 when it already fits. */
export function nearestScrollDelta(
  target: { top: number; bottom: number },
  viewport: { top: number; bottom: number },
  clearance = 0,
): number {
  if (target.top < viewport.top) return target.top - viewport.top
  const overflow = target.bottom + clearance - viewport.bottom
  if (overflow <= 0) return 0
  return Math.max(0, Math.min(overflow, target.top - viewport.top))
}

/** Scroll the drawer transcript that holds `target` so it is in view, clear of the jump control. Several
 *  elements (the follow-ups ONE pick opened) are revealed as one span, first top to last bottom, so the
 *  first of them is never scrolled away to show the last. False (and nothing moved) when the target is not
 *  inside a drawer's transcript. */
export function revealInDrawerTranscript(target: Element | readonly Element[] | null, clearance = JUMP_CLEARANCE_PX): boolean {
  const els = (Array.isArray(target) ? target : target ? [target] : []) as readonly Element[]
  const scroller = els[0]?.closest<HTMLElement>(SCROLLER)
  if (!scroller) return false
  const rects = els.map((el) => el.getBoundingClientRect())
  const span = { top: Math.min(...rects.map((r) => r.top)), bottom: Math.max(...rects.map((r) => r.bottom)) }
  const delta = nearestScrollDelta(span, scroller.getBoundingClientRect(), clearance)
  if (delta !== 0) scroller.scrollTop += delta
  return true
}
