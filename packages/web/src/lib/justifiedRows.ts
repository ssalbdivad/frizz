// Lay a gallery out in JUSTIFIED ROWS: every picture in a row shares one height, each keeps its own
// aspect ratio, and the row spans the full width. Nothing is cropped and nothing is letterboxed, which is
// the property that matters for screenshots — a 375px phone shot and a 1440px desktop shot sit side by
// side at their real shapes, where a uniform grid of square cells would either crop the evidence or
// float it in a box of dead space.
//
// The PARTITION — which pictures share a row — is the only real decision, and a greedy fill gets it wrong
// for exactly the small sets workers post: three equal shots at a target height would fill a row with two
// and strand the third alone, blown up to full width. So rows are chosen by a small dynamic program that
// minimises the squared distance of every row's height from `target`; the last row is held to the same
// standard as the rest, so a set of three reads as one row of three. Ties go to the FULLER early rows, the
// way text wraps.
//
// A row whose justified height would exceed `maxHeight` (a couple of portrait phone shots) is capped
// there, narrowed to match, and centered by the caller — the same 420px ceiling every framed picture in the
// transcript already observes (components/ImageFrame FRAMED_IMAGE).

export interface JustifiedRow {
  /** Index of the row's first picture. */
  start: number
  /** One past the row's last picture. */
  end: number
  /** The pictures' shared height, px. */
  height: number
  /** The row's width, px: the full width, unless the height hit its cap and the row is narrower. */
  width: number
}

export interface JustifyOptions {
  /** The gutter between two pictures in a row, px. */
  gap: number
  /** The row height the partition aims for, px. */
  target: number
  /** No row is taller than this, px. */
  maxHeight: number
  /** The most pictures one row may hold. */
  maxPerRow: number
}

export function justifyRows(ratios: readonly number[], width: number, opts: JustifyOptions): JustifiedRow[] {
  const n = ratios.length
  if (n === 0 || !(width > 0)) return []
  const { gap, target, maxHeight, maxPerRow } = opts
  const sumOf = (start: number, end: number) => {
    let sum = 0
    for (let i = start; i < end; i++) sum += ratios[i]
    return sum
  }
  // The height at which pictures [start, end) exactly fill the width, gutters included.
  const fitHeight = (start: number, end: number) => Math.max(0, width - gap * (end - start - 1)) / sumOf(start, end)

  const cost = new Array<number>(n + 1).fill(Infinity)
  const cut = new Array<number>(n + 1).fill(0)
  cost[0] = 0
  for (let end = 1; end <= n; end++) {
    // Ascending row size with a strict `<`: on a tie the LAST row stays the smaller one.
    for (let size = 1; size <= Math.min(maxPerRow, end); size++) {
      const start = end - size
      const total = cost[start] + (fitHeight(start, end) - target) ** 2
      if (total < cost[end]) {
        cost[end] = total
        cut[end] = start
      }
    }
  }

  const rows: JustifiedRow[] = []
  for (let end = n; end > 0; end = cut[end]) {
    const start = cut[end]
    const fit = fitHeight(start, end)
    const height = Math.min(fit, maxHeight)
    rows.unshift({
      start,
      end,
      height,
      width: height < fit ? height * sumOf(start, end) + gap * (end - start - 1) : width,
    })
  }
  return rows
}
