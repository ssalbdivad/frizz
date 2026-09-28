import assert from "node:assert/strict"
import { test } from "node:test"
import { fitSize } from "./ImageViewer.tsx"

test("a picture is fitted into the stage at its own aspect, never enlarged past its own size", () => {
  // A 2x capture of a 1440×900 page, into a 1392×804 stage: height binds.
  const wide = fitSize({ width: 2880, height: 1800 }, { width: 1392, height: 804 })
  assert.equal(wide.height, 804)
  assert.equal(wide.scale, 804 / 1800)
  assert.ok(Math.abs(wide.width - 1286.4) < 1e-9)
  // A small crop — or a small diagram — stays at its own size: a 240px drawing blown up to the viewport
  // drew its 2px strokes 12px thick.
  assert.deepEqual(fitSize({ width: 240, height: 120 }, { width: 1392, height: 804 }), { width: 240, height: 120, scale: 1 })
})

test("a picture that reports no size at all takes the stage's box rather than dividing by zero", () => {
  assert.deepEqual(fitSize({ width: 0, height: 0 }, { width: 800, height: 600 }), { width: 800, height: 600, scale: 1 })
})
