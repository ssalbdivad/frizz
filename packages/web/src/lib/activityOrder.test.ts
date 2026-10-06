import { test } from "node:test"
import assert from "node:assert/strict"
import { byActivity, settleCounts, tiersOf, type Settled } from "./activityOrder.ts"

const SETTLE = 1_000

/** Steps the settle through `[at, counts]` readings, returning what each one ranks by. */
function replay(readings: [number, Record<string, number>][]): Record<string, number>[] {
  let prev = new Map<string, Settled>()
  return readings.map(([at, counts]) => {
    const { settled } = settleCounts(prev, new Map(Object.entries(counts)), at, SETTLE)
    prev = settled
    return Object.fromEntries([...settled].map(([id, entry]) => [id, entry.ranked]))
  })
}

test("a project seen for the first time ranks by its live count at once", () => {
  assert.deepEqual(replay([[0, { a: 2, b: 0 }]]), [{ a: 2, b: 0 }])
})

test("a count ranks only once it has held for the settle", () => {
  assert.deepEqual(
    replay([
      [0, { a: 2 }],
      [10, { a: 1 }],
      [500, { a: 1 }],
      [1_010, { a: 1 }],
    ]).map((ranked) => ranked.a),
    [2, 2, 2, 1],
  )
})

test("a blip — rest then wake inside the settle — never moves the rank", () => {
  assert.deepEqual(
    replay([
      [0, { a: 1 }],
      [100, { a: 0 }],
      [900, { a: 1 }],
      [5_000, { a: 1 }],
    ]).map((ranked) => ranked.a),
    [1, 1, 1, 1],
  )
})

test("a count that changes again restarts its settle", () => {
  assert.deepEqual(
    replay([
      [0, { a: 0 }],
      [100, { a: 1 }],
      [900, { a: 2 }],
      [1_200, { a: 2 }],
      [1_900, { a: 2 }],
    ]).map((ranked) => ranked.a),
    [0, 0, 0, 0, 2],
  )
})

test("a project no longer listed is forgotten, and ranks fresh when it returns", () => {
  assert.deepEqual(replay([[0, { a: 3 }], [10, {}], [20, { a: 1 }]]), [{ a: 3 }, {}, { a: 1 }])
})

test("wakeAt is the earliest pending settle, and null when nothing is pending", () => {
  const first = settleCounts(new Map(), new Map([["a", 1], ["b", 1]]), 0, SETTLE)
  assert.equal(first.wakeAt, null)
  const second = settleCounts(first.settled, new Map([["a", 2], ["b", 1]]), 200, SETTLE)
  const third = settleCounts(second.settled, new Map([["a", 2], ["b", 0]]), 300, SETTLE)
  assert.equal(third.wakeAt, 1_200)
})

test("busiest first, the given order breaking ties", () => {
  const rank: Record<string, number> = { a: 0, b: 2, c: 1, d: 2, e: 0 }
  assert.deepEqual(byActivity(["a", "b", "c", "d", "e"], (id) => rank[id]!), ["b", "d", "c", "a", "e"])
})

test("tiers are the runs of equal rank as drawn, never re-sorted", () => {
  const rank: Record<string, number> = { a: 0, b: 2, c: 1, d: 2, e: 0 }
  assert.deepEqual(tiersOf(["b", "d", "c", "a", "e"], (id) => rank[id]!), [["b", "d"], ["c"], ["a", "e"]])
  // Held, a project can be drawn where its rank has left: it parts the run it sits in.
  assert.deepEqual(tiersOf(["b", "a", "d"], (id) => rank[id]!), [["b"], ["a"], ["d"]])
  assert.deepEqual(tiersOf([], () => 0), [])
})
