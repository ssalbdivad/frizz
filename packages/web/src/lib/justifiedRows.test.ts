import { test } from "node:test"
import assert from "node:assert/strict"
import { justifyRows, type JustifiedRow } from "./justifiedRows.ts"

const OPTS = { gap: 6, target: 180, maxHeight: 420, maxPerRow: 8 }
const WIDE = 16 / 10
const PHONE = 375 / 812

const sizes = (rows: JustifiedRow[]) => rows.map((row) => row.end - row.start)

test("equal screenshots fill rows of two or three, never stranding one alone", () => {
  const partition = (n: number) => sizes(justifyRows(Array(n).fill(WIDE), 720, OPTS))
  assert.deepEqual(partition(1), [1])
  assert.deepEqual(partition(2), [2])
  // Greedy filling would stop at two and blow the third up to the full width.
  assert.deepEqual(partition(3), [3])
  assert.deepEqual(partition(4), [2, 2])
  // On a tie the fuller row comes first, the way text wraps.
  assert.deepEqual(partition(5), [3, 2])
  assert.deepEqual(partition(6), [3, 3])
})

test("every uncapped row spans the width exactly, its pictures at one shared height", () => {
  const ratios = [WIDE, PHONE, 4 / 3, WIDE, 1, WIDE, PHONE]
  const rows = justifyRows(ratios, 720, OPTS)
  assert.equal(rows[0].start, 0)
  assert.equal(rows.at(-1)!.end, ratios.length)
  for (const [i, row] of rows.entries()) {
    if (i > 0) assert.equal(row.start, rows[i - 1].end, "rows are contiguous")
    if (row.height === OPTS.maxHeight) continue
    const drawn = ratios.slice(row.start, row.end).reduce((sum, ratio) => sum + ratio * row.height, 0) + OPTS.gap * (row.end - row.start - 1)
    assert.ok(Math.abs(drawn - 720) < 1e-6, `row ${i} draws ${drawn}px of 720`)
    assert.equal(row.width, 720)
  }
})

test("a row too tall for the cap is held at the cap and narrowed to match", () => {
  const [row] = justifyRows([PHONE, PHONE], 720, OPTS)
  assert.deepEqual(sizes([row]), [2])
  assert.equal(row.height, 420)
  assert.ok(Math.abs(row.width - (420 * PHONE * 2 + 6)) < 1e-6)
})

test("phone screenshots share a row more readily than wide ones", () => {
  // Eight phone shots read as one contact-sheet row; eight desktop shots would be slivers in one.
  assert.deepEqual(sizes(justifyRows(Array(8).fill(PHONE), 720, OPTS)), [8])
  assert.ok(justifyRows(Array(8).fill(WIDE), 720, OPTS).length > 1)
})

test("nothing to lay out, or no width yet, is no rows", () => {
  assert.deepEqual(justifyRows([], 720, OPTS), [])
  assert.deepEqual(justifyRows([WIDE], 0, OPTS), [])
})
