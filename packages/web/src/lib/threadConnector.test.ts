import { test } from "node:test"
import assert from "node:assert/strict"
import { EDGE_INSET, landing, snapToPixels, threadPath } from "./threadConnector.ts"

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
