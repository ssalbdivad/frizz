import { test } from "node:test"
import assert from "node:assert/strict"
import { holdLayout, type HeldSection, type LiveSection } from "./heldLayout.ts"

// An item is `key` or `key@version`: the key is its identity, the version stands for what the row SAYS
// (a spinner, a status), which must stay live while the layout is held.
const keyOf = (item: string) => item.split("@")[0]!

/** "ready: a b | working: c" — the layout as a reader sees it; a held slot in parentheses. */
function drawn(sections: HeldSection<string>[]): string {
  return sections
    .filter((section) => section.slots.length > 0)
    .map((section) => `${section.id}: ${section.slots.map((slot) => (slot.held ? `(${slot.item})` : slot.item)).join(" ")}`)
    .join(" | ")
}

/** The inverse of `drawn`, for a target: "ready: a b | working: c". */
function live(text: string): LiveSection<string>[] {
  return text.split(" | ").map((part) => {
    const [id, items] = part.split(": ")
    return { id: id!, items: items ? items.split(" ").filter(Boolean) : [] }
  })
}

function hold(prev: HeldSection<string>[], target: string, opts: { frozen?: boolean; moved?: string[]; live?: Record<string, string> } = {}) {
  const moved = new Set(opts.moved ?? [])
  return holdLayout({
    prev,
    target: live(target),
    keyOf,
    frozen: opts.frozen ?? true,
    moved: (key) => moved.has(key),
    live: (key) => opts.live?.[key],
  })
}

const first = (target: string) => hold([], target, { frozen: false })

test("not held, the live layout is drawn as it is", () => {
  const before = first("ready: a b | working: c")
  assert.equal(drawn(hold(before, "ready: b | working: a c", { frozen: false })), "ready: b | working: a c")
})

test("a first draw is the live layout, held or not", () => {
  assert.equal(drawn(hold([], "ready: a b | working: c")), "ready: a b | working: c")
})

test("held, a thread that changes band keeps its place — drawn as it is now", () => {
  const before = first("ready: a b | working: c")
  // `a` woke itself: the live layout puts it under Working, the list keeps it where the pointer saw it.
  assert.equal(drawn(hold(before, "ready: b | working: a@running c")), "ready: (a@running) b | working: c")
})

test("held, rows keep their order within a band when the live order changes", () => {
  const before = first("working: a b c")
  assert.equal(drawn(hold(before, "working: c@2 a b")), "working: a b c@2")
})

test("held, a row's contents stay live in place", () => {
  const before = first("ready: a b")
  assert.equal(drawn(hold(before, "ready: a@2 b@3")), "ready: a@2 b@3")
})

test("held, a thread that leaves the list entirely holds its slot, as it is now if known, else as last drawn", () => {
  const before = first("ready: a b c")
  assert.equal(drawn(hold(before, "ready: a c", { live: { b: "b@done" } })), "ready: a (b@done) c")
  assert.equal(drawn(hold(before, "ready: a c")), "ready: a (b) c")
})

test("held, an arrival waits for the hold to end — nothing is pushed down", () => {
  const before = first("ready: a | working: b")
  assert.equal(drawn(hold(before, "ready: n a | working: b m")), "ready: a | working: b")
})

test("held, a thread that moves INTO a band is not drawn twice", () => {
  const before = first("ready: a | working: b | snoozed: ")
  const after = hold(before, "ready: a | working: | snoozed: b@parked")
  assert.equal(drawn(after), "ready: a | working: (b@parked)")
  assert.equal(after.flatMap((section) => section.slots).filter((slot) => slot.key === "b").length, 1)
})

test("the hold ending draws every waiting move at once", () => {
  const before = first("ready: a b | working: c")
  const held = hold(before, "ready: b n | working: a c")
  assert.equal(drawn(held), "ready: (a) b | working: c")
  assert.equal(drawn(hold(held, "ready: b n | working: a c", { frozen: false })), "ready: b n | working: a c")
})

test("a hold carries over render to render: what was held stays held until it ends", () => {
  let drawnNow = first("ready: a b c")
  drawnNow = hold(drawnNow, "ready: c b")
  assert.equal(drawn(drawnNow), "ready: (a) b c")
  drawnNow = hold(drawnNow, "ready: c b x")
  assert.equal(drawn(drawnNow), "ready: (a) b c")
  // `a` comes back where it was drawn: not held any more, the same slot.
  drawnNow = hold(drawnNow, "ready: a c b x")
  assert.equal(drawn(drawnNow), "ready: a b c")
})

test("held, a thread the HUMAN moved goes where the live layout puts it at once", () => {
  const before = first("pinned: p | ready: a b c | working: w")
  // The human pinned `b`: it leaves Ready and lands in Pinned, after its live predecessor `p`.
  assert.equal(drawn(hold(before, "pinned: p b | ready: a c | working: w", { moved: ["b"] })), "pinned: p b | ready: a c | working: w")
})

test("held, a thread the human put away (finished, snoozed) leaves at once, and only it", () => {
  const before = first("ready: a b c | working: w")
  // `b` finished from this tab while `w`, on its own, came to rest: only `b` moves.
  assert.equal(drawn(hold(before, "ready: a c w", { moved: ["b"] })), "ready: a c | working: (w)")
})

test("held, a human move lands after its nearest live predecessor that is drawn, else first in its band", () => {
  const before = first("ready: a b | working: x y")
  // Live Working is `n y x b`: `n` is an arrival (not drawn), so `b` lands at Working's top, before `x`.
  assert.equal(drawn(hold(before, "ready: a | working: n b y x", { moved: ["b"] })), "ready: a | working: b x y")
  // Live predecessor `y` is drawn: `b` lands right after it, wherever the held layout has it.
  assert.equal(drawn(hold(before, "ready: a | working: y b x", { moved: ["b"] })), "ready: a | working: x y b")
})

test("held, a thread the human dispatched appears at once; other arrivals still wait", () => {
  const before = first("working: a")
  assert.equal(drawn(hold(before, "working: m n a", { moved: ["n"] })), "working: n a")
})

test("held, a section only the live layout has follows the drawn ones, and takes the human's moves", () => {
  const before = first("busy: p q")
  assert.equal(drawn(hold(before, "quiet: q | busy: p", { moved: [] })), "busy: p (q)")
  assert.equal(drawn(hold(before, "quiet: q | busy: p", { moved: ["q"] })), "busy: p | quiet: q")
})

test("a key listed twice is drawn once, in the first section that lists it", () => {
  assert.equal(drawn(first("snoozed: a | done: a b")), "snoozed: a | done: b")
  const before = first("snoozed: a | done: b")
  assert.equal(drawn(hold(before, "snoozed: a | done: a b")), "snoozed: a | done: b")
})

test("nothing drawn twice and nothing lost: held output is a permutation of last drawn plus the human's arrivals", () => {
  const before = first("pinned: p | ready: a b c | working: d e | snoozed: f")
  const out = hold(before, "pinned: p e | ready: c x | working: a d | snoozed: b f y", { moved: ["e", "y"] })
  const keys = out.flatMap((section) => section.slots.map((slot) => slot.key)).sort()
  assert.deepEqual(keys, ["a", "b", "c", "d", "e", "f", "p", "y"])
  assert.equal(drawn(out), "pinned: p e | ready: (a) (b) c | working: d | snoozed: f y")
})

test("never moved: with nothing moved by the human, every drawn row keeps its index", () => {
  const before = first("ready: a b c | working: d e f")
  const out = hold(before, "ready: f e | working: a | snoozed: b c d", { moved: [] })
  assert.deepEqual(
    out.flatMap((section) => section.slots.map((slot) => slot.key)),
    before.flatMap((section) => section.slots.map((slot) => slot.key)),
  )
})
