import assert from "node:assert/strict"
import test from "node:test"
import { placeHelpTip } from "./helpTipPlacement.ts"

// A (?) beside a Settings label, 16px square. Sizes measured in the running page (2026-10-01): the widest
// help tooltip is 352px (its max), the tallest — External app's — 197px.
const trigger = (left: number, top: number) => ({ left, right: left + 16, top, bottom: top + 16 })
const inside = (p: { left: number; top: number }, tip: { width: number; height: number }, vp: { width: number; height: number }) =>
  p.left >= 12 && p.top >= 12 && p.left + tip.width <= vp.width - 12 && p.top + tip.height <= vp.height - 12

test("beside the trigger, top-aligned, wherever it fits — the desktop's placement", () => {
  const vp = { width: 1440, height: 900 }
  assert.deepEqual(placeHelpTip(trigger(980, 300), { width: 352, height: 80 }, vp), { left: 1004, top: 294 })
})

test("in a 300px sidebar it never leaves the frame and never covers the label: it drops below", () => {
  const vp = { width: 300, height: 820 }
  const tip = { width: 276, height: 120 }
  const t = trigger(130, 200)
  const p = placeHelpTip(t, tip, vp)
  assert.ok(inside(p, tip, vp), JSON.stringify(p))
  assert.equal(p.top, t.bottom + 6, "below the label's row")
})

test("a tall tooltip near the bottom flips above instead of running off the frame", () => {
  const vp = { width: 450, height: 820 }
  const tip = { width: 352, height: 197 }
  const t = trigger(150, 760)
  const p = placeHelpTip(t, tip, vp)
  assert.ok(inside(p, tip, vp), JSON.stringify(p))
  assert.equal(p.top + tip.height, t.top - 6, "its bottom sits just above the trigger")
})

test("beside the trigger, a tall tooltip is clamped by its real height, not an assumed 96px", () => {
  const vp = { width: 1440, height: 900 }
  const tip = { width: 352, height: 197 }
  const p = placeHelpTip(trigger(980, 830), tip, vp)
  assert.ok(inside(p, tip, vp), JSON.stringify(p))
  assert.equal(p.left, 1004)
})

test("taller than the viewport's room either way, it still starts inside the top edge", () => {
  const vp = { width: 300, height: 300 }
  const tip = { width: 276, height: 260 }
  const p = placeHelpTip(trigger(130, 140), tip, vp)
  assert.ok(p.top >= 12 && p.left >= 12, JSON.stringify(p))
})
