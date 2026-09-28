import { test } from "node:test"
import assert from "node:assert/strict"
import { CROSSING, EDGE_INSET, landing, snapToPixels, subCubic, threadPath, twist } from "./threadConnector.ts"

const VH = 1000

test("a card spanning the row's height takes the thread level with the row", () => {
  assert.equal(landing(300, { top: 130, bottom: 670 }, -Infinity, VH), 300)
})

test("a card above or below the row takes it at the nearest point of its visible stretch, clear of its corners", () => {
  // Card scrolled mostly past the row: the stroke bends up to its lower edge.
  assert.equal(landing(455, { top: -600, bottom: 240 }, -Infinity, VH), 240 - EDGE_INSET)
  // Card still coming up from below: the stroke bends down to its upper edge.
  assert.equal(landing(300, { top: 560, bottom: 1400 }, -Infinity, VH), 560 + EDGE_INSET)
})

test("the lane's sticky header and the window's edges cut the card's visible stretch", () => {
  // The header is stuck over the card's top 38px: the thread lands below it, not under it.
  assert.equal(landing(10, { top: -400, bottom: 900 }, 38, VH), 38 + EDGE_INSET)
  // A card running off the bottom of the window lands above the window's edge.
  assert.equal(landing(990, { top: 100, bottom: 3000 }, -Infinity, VH), VH - EDGE_INSET)
})

test("a card with no visible stretch left sends the thread off the edge it went past", () => {
  assert.equal(landing(400, { top: -900, bottom: 30 }, -Infinity, VH), "above")
  assert.equal(landing(400, { top: 990, bottom: 1600 }, -Infinity, VH), "below")
  // Visible, but by less than the insets at both ends: still no room to land.
  assert.equal(landing(400, { top: 960, bottom: 1600 }, -Infinity, VH), "below")
})

test("the path leaves the row flat and enters the card flat", () => {
  assert.equal(threadPath({ x1: 576, y1: 300.5, x2: 629.5, y2: 300.5 }), "M576 300.5C602.75 300.5 602.75 300.5 629.5 300.5")
  const bent = threadPath({ x1: 0, y1: 455, x2: 50, y2: 218 })
  assert.equal(bent, "M0 455C25 455 25 218 50 218", "both control points share their end's height")
})

test("a flat stroke is moved onto the device-pixel grid", () => {
  // 1x: one device pixel wide, so its centre sits on a pixel centre.
  assert.equal(snapToPixels(300.42, 1), 300.5)
  assert.equal(snapToPixels(300.92, 1), 300.5)
  // 2x: two device pixels wide, so its centre sits on a pixel boundary.
  assert.equal(snapToPixels(300.42, 2), 300.5)
  assert.equal(snapToPixels(300.2, 2), 300)
  // 3x: odd again.
  assert.equal(snapToPixels(300.42, 3), 901.5 / 3)
})

// ---- twist ----

/** Each "M…C…" piece of a strand as its end points, rounded. */
const pieces = (d: string) =>
  [...d.matchAll(/M([\d.-]+) ([\d.-]+)C[\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+ ([\d.-]+) ([\d.-]+)/g)].map((m) =>
    [m[1], m[2], m[3], m[4]].map((n) => Math.round(Number(n) * 100) / 100),
  )

test("the strands cross at every crossing, and which one is on top alternates crossing to crossing", () => {
  const [a, b] = twist([100, 130, 160], [80, 180], 50, 3.5)
  // Four twists (in, two between crossings, out) per strand, cut once at each crossing it passes UNDER.
  const [pa, pb] = [pieces(a), pieces(b)]
  assert.equal(pa.length, 4)
  assert.equal(pb.length, 4)
  // Strand A runs unbroken through the 1st and 3rd crossings and is cut at the 2nd; B the other way.
  const endsAt = (p: number[][], y: number) => p.some((q) => q[3] === y && q[2] === 50)
  assert.ok(endsAt(pa, 100) && !endsAt(pa, 130) && endsAt(pa, 160), "A on top at 100 and 160")
  assert.ok(!endsAt(pb, 100) && endsAt(pb, 130) && !endsAt(pb, 160), "B on top at 130")
  // A cut leaves CROSSING of clear arc either side, so the piece stops short of the crossing.
  const cut = pa.find((q) => q[3] < 130 && q[3] > 100)!
  assert.ok(130 - cut[3] > 0.5 && 130 - cut[3] < CROSSING + 0.01, `stops ${130 - cut[3]} short of the crossing`)
})

test("the strands bow to opposite sides, and meet on the centre line at the span's ends, uncut", () => {
  const [a, b] = twist([100], [86, 114], 50, 3.5)
  const side = (d: string) => Math.sign(Number(d.match(/C([\d.-]+)/)![1]) - 50)
  assert.equal(side(a), -side(b))
  for (const d of [a, b]) {
    const p = pieces(d)
    assert.deepEqual([p[0]![0], p[0]![1]], [50, 86], "starts on the line at the span's top")
    assert.deepEqual([p[p.length - 1]![2], p[p.length - 1]![3]], [50, 114], "ends on the line at the span's bottom")
  }
})

test("no crossings, no cord", () => {
  assert.deepEqual(twist([], [0, 100], 50, 3.5), ["", ""])
})

test("a piece of a cubic starts and ends on the curve", () => {
  const c = [[0, 0], [10, 30], [20, 30], [30, 0]] as const
  assert.deepEqual(subCubic(c, 0, 1), c)
  const piece = subCubic(c, 0.25, 0.75)
  const at = (t: number) => [0, 1].map((i) => (1 - t) ** 3 * c[0][i]! + 3 * (1 - t) ** 2 * t * c[1][i]! + 3 * (1 - t) * t ** 2 * c[2][i]! + t ** 3 * c[3][i]!)
  for (const [p, t] of [[piece[0], 0.25], [piece[3], 0.75]] as const) {
    assert.ok(Math.hypot(p[0] - at(t)[0]!, p[1] - at(t)[1]!) < 1e-9)
  }
})
