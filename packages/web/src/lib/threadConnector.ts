// The geometry of the thread drawn between a rail row and its card on the cross-project page
// (components/ThreadConnector.tsx) — pure, so the rules it lands by are pinned without a browser.

/** Nothing lands within this of a card's visible top or bottom: the 12px corner plus room to read as edge. */
export const EDGE_INSET = 22
/** Where a card scrolled out of the window pulls the stroke to — far enough that its end is gone. */
export const OFFSCREEN = 48

export interface ThreadGeometry {
  x1: number
  y1: number
  x2: number
  y2: number
  /** The card's straight left edge, top to bottom, or null when the card is out of the window. */
  edge: readonly [number, number] | null
}

/**
 * Where the thread meets its card. LEVEL WITH THE ROW whenever the card's visible stretch reaches that
 * height — the usual reading, one flat stroke across the gutter — and otherwise the nearest point of that
 * stretch, so the stroke bends only once the card has scrolled past the row. The visible stretch is the
 * card between whatever covers its top (the lane's sticky header, or the window's edge) and the window's
 * bottom, less EDGE_INSET at each end. A card with no such stretch left is off the window: the stroke
 * runs off the top or the bottom edge, whichever the card went past.
 */
export function landing(
  rowY: number,
  card: { top: number; bottom: number },
  coveredTo: number,
  viewportHeight: number,
): number | "above" | "below" {
  const top = Math.max(card.top, coveredTo, 0) + EDGE_INSET
  const bottom = Math.min(card.bottom, viewportHeight) - EDGE_INSET
  if (bottom < top) return card.bottom < viewportHeight / 2 ? "above" : "below"
  return Math.min(Math.max(rowY, top), bottom)
}

/** Flat out of the row, flat into the card: the bend lives in the middle of the gutter. */
export function threadPath({ x1, y1, x2, y2 }: Pick<ThreadGeometry, "x1" | "y1" | "x2" | "y2">): string {
  const k = (x2 - x1) / 2
  return `M${x1} ${y1}C${x1 + k} ${y1} ${x2 - k} ${y2} ${x2} ${y2}`
}

/**
 * A 1px horizontal stroke centred on `y`, moved onto the device-pixel grid so it paints as one crisp row
 * of pixels rather than two soft ones: its centre wants a pixel boundary when the stroke covers an EVEN
 * number of device pixels (2x), and a pixel centre when it covers an odd number (1x, 3x).
 */
export function snapToPixels(y: number, dpr: number): number {
  return (dpr % 2 === 1 ? Math.floor(y * dpr) + 0.5 : Math.round(y * dpr)) / dpr
}
