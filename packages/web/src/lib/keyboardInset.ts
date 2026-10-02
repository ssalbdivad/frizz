import { useLayoutEffect, useState, type RefObject } from "react"

// THE SOFTWARE KEYBOARD, and how a phone bottom bar stays on top of it.
//
// Neither phone browser shrinks the page for its keyboard any more. iOS Safari never did, and Android
// Chrome stopped in Chrome 108 (the `interactive-widget` default became `resizes-visual`): the keyboard
// shrinks only the VISUAL viewport, and the layout viewport — the box every `position: fixed; bottom: 0`
// element is pinned to — keeps its full height underneath it. So a bar pinned to the bottom of a fixed
// full-height panel sits behind the keyboard, and the prompt the operator is typing into is the one
// thing they cannot see.
//
// The fix is a measurement, not a guess at the keyboard's height: how far the bottom of the pinned
// panel reaches past the bottom of what is visible. `getBoundingClientRect` reports in layout-viewport
// coordinates on both engines, and `visualViewport.offsetTop + height` is the visible band's bottom in
// the same coordinates, so the difference is exactly the strip the keyboard covers — including the case
// where iOS has also panned the visual viewport to reveal the focused field (offsetTop > 0). The caller
// renders that many pixels of spacer under its bar, INSIDE the pinned panel: the bar rises onto the
// keyboard and the transcript above it shrinks, rather than the bar floating over the transcript.
//
// Measured from the element's own box rather than `innerHeight - visualViewport.height`, because
// `innerHeight` is not the same quantity on both engines — Chrome reports the visual viewport there — so
// that subtraction reads 0 on Android with the keyboard up.
//
// A PINCH ZOOM also shrinks the visual viewport, and it is not a keyboard: while the page is zoomed the
// inset is 0, and the bar stays where the layout put it.

// Below this, the gap is a rounding artefact or a browser toolbar in motion, never a keyboard (the
// smallest phone keyboard is well over 150px).
const KEYBOARD_MIN_PX = 60

export interface ViewportReading {
  // Bottom edge of the pinned box, in layout-viewport (client) coordinates.
  pinnedBottom: number
  // The visual viewport, or null where the browser has none.
  visual: { offsetTop: number; height: number; scale: number } | null
}

/** Pixels of the pinned box's bottom that the keyboard covers. Pure, so it is testable without a phone. */
export function keyboardInsetFrom({ pinnedBottom, visual }: ViewportReading): number {
  if (!visual) return 0
  if (Math.abs(visual.scale - 1) > 0.01) return 0
  const covered = pinnedBottom - (visual.offsetTop + visual.height)
  return covered >= KEYBOARD_MIN_PX ? Math.round(covered) : 0
}

/**
 * The keyboard's inset over `ref`'s box. `ref` must be an element whose BOTTOM is pinned to the bottom
 * of the fixed panel (the bar's own wrapper, with the spacer inside it) — so growing the spacer never
 * moves the edge it measures, and the reading cannot feed back on itself.
 */
export function useKeyboardInset(ref: RefObject<HTMLElement | null>, enabled: boolean): number {
  const [inset, setInset] = useState(0)
  useLayoutEffect(() => {
    if (!enabled || typeof window === "undefined") {
      setInset(0)
      return
    }
    let frame = 0
    const measure = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const el = ref.current
        if (!el) return
        const vv = window.visualViewport
        setInset(keyboardInsetFrom({
          pinnedBottom: el.getBoundingClientRect().bottom,
          visual: vv ? { offsetTop: vv.offsetTop, height: vv.height, scale: vv.scale } : null,
        }))
      })
    }
    measure()
    const vv = window.visualViewport
    vv?.addEventListener("resize", measure)
    vv?.addEventListener("scroll", measure)
    window.addEventListener("resize", measure)
    // The keyboard opens on focus and closes on blur, and on iOS the viewport events for it can trail
    // the focus change by a frame or two; re-reading on both costs nothing.
    window.addEventListener("focusin", measure)
    window.addEventListener("focusout", measure)
    return () => {
      cancelAnimationFrame(frame)
      vv?.removeEventListener("resize", measure)
      vv?.removeEventListener("scroll", measure)
      window.removeEventListener("resize", measure)
      window.removeEventListener("focusin", measure)
      window.removeEventListener("focusout", measure)
    }
  }, [ref, enabled])
  return enabled ? inset : 0
}
