// The lightbox viewer's zoom (components/Lightbox.tsx), as pure geometry: a picture laid out at its FITTED
// size, then magnified and moved by one CSS transform. Every gesture — a click, a double tap, a pinch, a
// trackpad pinch, a wheel, a drag, a key, a button — is one of the three moves below, so a mouse and a
// finger zoom the same way and the tests pin the arithmetic without a browser.
//
// Coordinates are CSS px relative to the CENTRE of the fitted picture's layout box (the transform origin):
// `x`/`y` is how far the magnified picture's centre has moved from there.

export interface ZoomState {
  scale: number
  x: number
  y: number
}

export interface ZoomBounds {
  /** The fitted picture's layout size — the box the transform scales. */
  width: number
  height: number
  /** The stage's edges, relative to the fitted picture's centre (`left`/`top` are negative). */
  left: number
  right: number
  top: number
  bottom: number
  /** The most the picture may be magnified. */
  max: number
}

export const FIT: ZoomState = { scale: 1, x: 0, y: 0 }

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

// One axis of a magnified picture: wherever it is bigger than the stage it must still COVER the stage (no
// empty band can be dragged into view), and where it is not it stays where it was laid out.
function axis(t: number, size: number, scale: number, lo: number, hi: number): number {
  const half = (size * scale) / 2
  return 2 * half <= hi - lo ? clamp(0, lo + half, hi - half) : clamp(t, hi - half, lo + half)
}

/** The nearest state the picture may actually be in: magnification within [1, max], position covered. */
export function clampZoom(state: ZoomState, b: ZoomBounds): ZoomState {
  const scale = clamp(state.scale, 1, b.max)
  if (scale === 1) return FIT
  return { scale, x: axis(state.x, b.width, scale, b.left, b.right), y: axis(state.y, b.height, scale, b.top, b.bottom) }
}

/** Magnify by `factor` about `point`, keeping the pixel under the point where it is. */
export function zoomAbout(state: ZoomState, factor: number, point: { x: number; y: number }, b: ZoomBounds): ZoomState {
  const scale = clamp(state.scale * factor, 1, b.max)
  const k = scale / state.scale
  return clampZoom({ scale, x: point.x - (point.x - state.x) * k, y: point.y - (point.y - state.y) * k }, b)
}

/** Move a magnified picture by a drag or a scroll. */
export function panBy(state: ZoomState, dx: number, dy: number, b: ZoomBounds): ZoomState {
  return clampZoom({ scale: state.scale, x: state.x + dx, y: state.y + dy }, b)
}

/**
 * A two-finger pinch, from where it started: the pixel that was under the fingers' midpoint follows the
 * midpoint, and the magnification follows the distance between them — so a pinch zooms and pans at once.
 */
export function pinch(start: ZoomState, startMid: { x: number; y: number }, startDistance: number, mid: { x: number; y: number }, distance: number, b: ZoomBounds): ZoomState {
  const scale = clamp(start.scale * (distance / Math.max(startDistance, 1)), 1, b.max)
  const k = scale / start.scale
  return clampZoom({ scale, x: mid.x - (startMid.x - start.x) * k, y: mid.y - (startMid.y - start.y) * k }, b)
}

/**
 * The magnification one click or double tap jumps to: the picture's ACTUAL pixels (one file pixel per
 * CSS pixel, what a browser tab shows an image at), held between 2× — so a picture that already fits at
 * nearly full size still visibly zooms — and 4×, so a huge capture on a phone does not land on one corner.
 */
export function detailScale(fittedWidth: number, naturalWidth: number): number {
  return clamp(naturalWidth / Math.max(fittedWidth, 1), 2, 4)
}

/** How far a pinch or the + key may go: twice the actual pixels, never less than 4× nor more than 12×. */
export function maxScale(fittedWidth: number, naturalWidth: number): number {
  return clamp((2 * naturalWidth) / Math.max(fittedWidth, 1), 4, 12)
}
