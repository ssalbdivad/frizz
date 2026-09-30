import { test } from "node:test"
import assert from "node:assert/strict"
import { createAwakeClock } from "./awake-clock.ts"

// The measured case (arktype a627551f, 2026-09-30): 68 wall minutes across one Bash call, of which the
// call's own `uptime` saw 9. The process is frozen too, so it sees only the wall clock's jump on waking.
test("a suspension is the wall-clock jump the monotonic clock did not share", () => {
  const c = { wall: Date.parse("2026-09-30T00:02:26.000Z"), mono: 1_000 }
  const clock = createAwakeClock(() => c.wall, () => c.mono)
  clock.sample()
  // Nine awake minutes of ticks…
  for (let i = 0; i < 9 * 6; i++) {
    c.wall += 10_000
    c.mono += 10_000
    clock.sample()
  }
  // …then 59 minutes asleep: the wall jumps, the monotonic clock does not.
  c.wall += 59 * 60_000
  c.mono += 50
  clock.sample()
  const from = Date.parse("2026-09-30T00:02:26.000Z")
  const to = c.wall
  assert.equal(to - from, 68 * 60_000)
  assert.ok(Math.abs(clock.awakeBetween(from, to) - 9 * 60_000) <= 100, `awake ${clock.awakeBetween(from, to)}`)
  // A span wholly after the wake is untouched by it.
  c.wall += 5_000
  c.mono += 5_000
  assert.equal(clock.awakeBetween(to, c.wall), 5_000)
})

test("ordinary ticks, a slow tick and a long idle gap record nothing", () => {
  const c = { wall: 0, mono: 0 }
  const clock = createAwakeClock(() => c.wall, () => c.mono)
  clock.sample()
  c.wall += 10_000; c.mono += 10_000; clock.sample()
  // A blocked event loop: both clocks advance together.
  c.wall += 45_000; c.mono += 45_000; clock.sample()
  // Hours with no sample at all, awake the whole time.
  c.wall += 5 * 60 * 60_000; c.mono += 5 * 60 * 60_000; clock.sample()
  assert.equal(clock.awakeBetween(0, c.wall), c.wall)
  // Jitter under the threshold is noise, not sleep.
  c.wall += 20_000; c.mono += 1_000; clock.sample()
  assert.equal(clock.awakeBetween(0, c.wall), c.wall)
})
