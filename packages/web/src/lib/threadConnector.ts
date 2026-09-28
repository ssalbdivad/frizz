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

/** Half the gap cut into a strand where the other passes OVER it: 1px clear either side of a 1px stroke. */
export const CROSSING = 1.5

type Point = readonly [number, number]
type Cubic = readonly [Point, Point, Point, Point]

/**
 * A TWO-STRAND CORD down `x` from `span[0]` to `span[1]`, its strands crossing at each of `crossings` and
 * bowing apart between them, `amplitude` either side of `x`. It is drawn the way a knot diagram draws a
 * crossing — the strand passing UNDER is cut either side of the one on top — and which strand is on top
 * alternates from one crossing to the next, which is what makes two wavy lines read as a twist rather
 * than as a chain of eyes. At the span's ends the strands meet on `x` and stop, uncut.
 */
export function twist(crossings: readonly number[], span: readonly [number, number], x: number, amplitude: number): [string, string] {
  if (crossings.length === 0) return ["", ""]
  const knots = [span[0], ...[...crossings].sort((a, b) => a - b), span[1]]
  // A cubic's bulge peaks at three quarters of its control points' offset.
  const reach = amplitude / 0.75
  const strands: [string, string] = ["", ""]
  for (const strand of [0, 1] as const) {
    for (let k = 1; k < knots.length; k++) {
      const [top, bottom] = [knots[k - 1]!, knots[k]!]
      const side = (k + strand) % 2 === 0 ? 1 : -1
      const third = (bottom - top) / 3
      let seg: Cubic = [[x, top], [x + side * reach, top + third], [x + side * reach, bottom - third], [x, bottom]]
      // Crossing i is the (i + 1)th knot; strand 0 is on top at even crossings, strand 1 at odd ones.
      const under = (knot: number) => knot > 0 && knot < knots.length - 1 && (knot - 1) % 2 !== strand
      const speed = 3 * Math.hypot(reach, third)
      const t0 = under(k - 1) ? CROSSING / speed : 0
      const t1 = under(k) ? 1 - CROSSING / speed : 1
      seg = subCubic(seg, t0, t1)
      strands[strand] += `M${seg[0][0]} ${seg[0][1]}C${seg[1][0]} ${seg[1][1]} ${seg[2][0]} ${seg[2][1]} ${seg[3][0]} ${seg[3][1]}`
    }
  }
  return strands
}

/** The piece of a cubic between parameters t0 and t1 (de Casteljau, twice). */
export function subCubic(c: Cubic, t0: number, t1: number): Cubic {
  const right = split(c, t0)[1]
  return t1 >= 1 ? right : split(right, (t1 - t0) / (1 - t0))[0]
}
function split([a, b, c, d]: Cubic, t: number): [Cubic, Cubic] {
  const at = (p: Point, q: Point): Point => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]
  const ab = at(a, b), bc = at(b, c), cd = at(c, d)
  const abc = at(ab, bc), bcd = at(bc, cd)
  const mid = at(abc, bcd)
  return [[a, ab, abc, mid], [mid, bcd, cd, d]]
}
