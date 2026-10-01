import { test } from "node:test"
import assert from "node:assert/strict"
import { createListHold, PRESS_GRACE_MS, RESHAPE_SETTLE_MS, type HoldClock } from "./listHold.ts"

/** A clock the test moves by hand, firing whatever falls due. */
function fakeClock() {
  let now = 0
  let timers: { at: number; fn: () => void }[] = []
  const clock: HoldClock = {
    now: () => now,
    later: (fn, ms) => {
      const timer = { at: now + ms, fn }
      timers.push(timer)
      return () => {
        timers = timers.filter((t) => t !== timer)
      }
    },
  }
  const advance = (ms: number) => {
    now += ms
    for (const timer of timers.filter((t) => t.at <= now)) {
      timers = timers.filter((t) => t !== timer)
      timer.fn()
    }
  }
  return { clock, advance }
}

function setup() {
  const { clock, advance } = fakeClock()
  const changes: boolean[] = []
  const hold = createListHold((held) => changes.push(held), clock)
  return { hold, advance, changes }
}

test("held while the pointer is over the list, released when it leaves", () => {
  const { hold, changes } = setup()
  hold.over(true)
  assert.equal(hold.held(), true)
  hold.over(true)
  hold.over(false)
  assert.equal(hold.held(), false)
  assert.deepEqual(changes, [true, false])
})

test("a press in the list holds through a pointer that leaves as it lets go, for the grace", () => {
  const { hold, advance } = setup()
  hold.over(true)
  hold.down(true, false)
  hold.over(false)
  assert.equal(hold.held(), true, "the button is still down")
  hold.up()
  assert.equal(hold.held(), true, "the click is still landing")
  advance(PRESS_GRACE_MS - 1)
  assert.equal(hold.held(), true)
  advance(1)
  assert.equal(hold.held(), false)
})

test("a still pointer over the list keeps the hold — no idle release", () => {
  const { hold, advance } = setup()
  hold.over(true)
  advance(10 * 60_000)
  assert.equal(hold.held(), true)
})

test("a press outside the list does not hold it", () => {
  const { hold } = setup()
  hold.down(false, false)
  hold.up()
  assert.equal(hold.held(), false)
})

test("reshaping the list releases the hold at once, and it returns once the change has landed", () => {
  const { hold, advance } = setup()
  hold.over(true)
  hold.down(true, true)
  assert.equal(hold.held(), false, "a drag or fold in progress follows the live layout")
  hold.up()
  assert.equal(hold.held(), false)
  advance(RESHAPE_SETTLE_MS)
  assert.equal(hold.held(), true, "the pointer is still over the list")
})

test("a key on a reshaping control releases the hold for the settle", () => {
  const { hold, advance } = setup()
  hold.over(true)
  hold.reshapeKey()
  assert.equal(hold.held(), false)
  advance(RESHAPE_SETTLE_MS)
  assert.equal(hold.held(), true)
})

test("leaving the window releases the hold, grace and all", () => {
  const { hold } = setup()
  hold.over(true)
  hold.down(true, false)
  hold.away()
  assert.equal(hold.held(), false)
})
