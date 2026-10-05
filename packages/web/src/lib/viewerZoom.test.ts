import { test } from "node:test"
import assert from "node:assert/strict"
import { FIT, clampZoom, detailScale, maxScale, panBy, pinch, zoomAbout, type ZoomBounds } from "./viewerZoom.ts"

// A 400×250 fitted picture centred in an 800×600 stage.
const b: ZoomBounds = { width: 400, height: 250, left: -400, right: 400, top: -300, bottom: 300, max: 8 }

test("zooming about a point keeps the pixel under it in place", () => {
  const point = { x: 100, y: 20 }
  const z = zoomAbout(FIT, 3, point, b)
  assert.deepEqual(z, { scale: 3, x: -200, y: -40 })
  // The picture pixel under `point` at fit (100, 20 from the centre) is drawn at (x + 100·3, y + 20·3): still the point.
  assert.deepEqual({ x: z.x + 100 * z.scale, y: z.y + 20 * z.scale }, point)
})

test("magnification stays between fit and the maximum, and fit is always centred", () => {
  assert.deepEqual(zoomAbout(FIT, 0.5, { x: 120, y: 40 }, b), FIT)
  assert.equal(zoomAbout(FIT, 100, { x: 0, y: 0 }, b).scale, 8)
  assert.deepEqual(zoomAbout({ scale: 2, x: -100, y: -50 }, 0.5, { x: 300, y: 200 }, b), FIT)
})

test("a magnified picture always covers the stage where it is bigger than it, and stays put where it is not", () => {
  // At 3× the picture is 1200×750: wider and taller than the stage, so it may move only until its edge meets the stage's.
  assert.deepEqual(panBy({ scale: 3, x: 0, y: 0 }, 10_000, -10_000, b), { scale: 3, x: 200, y: -75 })
  // At 1.5× it is 600×375: narrower and shorter than the stage, so a drag cannot move it at all.
  assert.deepEqual(panBy({ scale: 1.5, x: 0, y: 0 }, 150, 90, b), { scale: 1.5, x: 0, y: 0 })
  assert.deepEqual(clampZoom({ scale: 1, x: 40, y: 40 }, b), FIT)
})

test("a pinch zooms by the change in finger distance and carries the picture with the midpoint", () => {
  const start = { scale: 3, x: 0, y: 0 }
  // Fingers twice as far apart, midpoint unmoved: twice the magnification about the midpoint.
  assert.deepEqual(pinch(start, { x: 50, y: 0 }, 100, { x: 50, y: 0 }, 200, b), { scale: 6, x: -50, y: 0 })
  assert.deepEqual(pinch(start, { x: 50, y: 0 }, 100, { x: 50, y: 0 }, 200, b), zoomAbout(start, 2, { x: 50, y: 0 }, b))
  // Same distance, midpoint moved: a pure pan.
  assert.deepEqual(pinch(start, { x: 0, y: 0 }, 100, { x: 30, y: -20 }, 100, b), { scale: 3, x: 30, y: -20 })
  assert.deepEqual(pinch(start, { x: 0, y: 0 }, 100, { x: 30, y: -20 }, 100, b), panBy(start, 30, -20, b))
})

test("one click lands on the picture's actual pixels, within 2× and 4×; a pinch may go to twice that", () => {
  assert.equal(detailScale(1312, 2880), 2880 / 1312) // a retina desktop shot on a desktop: its own pixels
  assert.equal(detailScale(1312, 1440), 2) // nearly full size already: still a visible step
  assert.equal(detailScale(383, 2880), 4) // a huge capture on a phone
  assert.equal(maxScale(1312, 2880), (2 * 2880) / 1312)
  assert.equal(maxScale(1312, 1440), 4)
  assert.equal(maxScale(383, 2880), 12)
})
