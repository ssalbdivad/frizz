import { test } from "node:test"
import assert from "node:assert/strict"
import { stableQueue, type QueueSlot } from "./stableQueue.ts"

// Items are their own keys: the order logic never looks inside them.
const keyOf = (key: string) => key
const slots = (...keys: string[]): QueueSlot<string>[] => keys.map((key) => ({ key, item: key, ghost: false }))
const drawn = (list: QueueSlot<string>[]) => list.map((slot) => (slot.ghost ? `(${slot.key})` : slot.key)).join(" ")
const always = () => true
const never = () => false

function next(prev: QueueSlot<string>[], target: string[], onScreen: string[], opts: { mayGhost?: (key: string) => boolean; keep?: string[] } = {}) {
  return stableQueue({ prev, target, keyOf, onScreen: new Set(onScreen), mayGhost: opts.mayGhost ?? always, keep: new Set(opts.keep ?? []) })
}

test("a first draw, or nothing on screen, is exactly the queue's own order", () => {
  assert.equal(drawn(next([], ["a", "b", "c"], [])), "a b c")
  assert.equal(drawn(next(slots("a", "b", "c"), ["c", "a", "b"], [])), "c a b")
})

test("an arrival joins the bottom under FIFO, and the cards on screen stay as drawn", () => {
  assert.equal(drawn(next(slots("a", "b"), ["a", "b", "c"], ["a", "b"])), "a b c")
})

test("an arrival at the top (newest first) goes ABOVE the cards on screen, where the viewport lock hides it", () => {
  assert.equal(drawn(next(slots("a", "b"), ["n", "a", "b"], ["a", "b"])), "n a b")
})

test("a card whose place is BETWEEN two cards on screen waits below them instead of pushing one down", () => {
  // The server's queue clock returns a self-woken thread to its old place in line: here, between a and b.
  assert.equal(drawn(next(slots("a", "b", "c"), ["a", "x", "b", "c"], ["a", "b"])), "a b x c")
  // Once its slot is off screen it takes its real place.
  assert.equal(drawn(next(slots("a", "b", "x", "c"), ["a", "x", "b", "c"], ["c"])), "a x b c")
})

test("a card on screen that leaves on its own stays as a ghost, and is the card again when it comes back", () => {
  const ghosted = next(slots("a", "b", "c"), ["b", "c"], ["a", "b"])
  assert.equal(drawn(ghosted), "(a) b c")
  // Still on screen: still held.
  assert.equal(drawn(next(ghosted, ["b", "c"], ["a", "b"])), "(a) b c")
  // Rests again while held: in the same place, a card again — even though the queue now puts it last.
  assert.equal(drawn(next(ghosted, ["b", "c", "a"], ["a", "b"])), "a b c")
  // Scrolled away while still gone: it goes, and nothing on screen moves (it was above them).
  assert.equal(drawn(next(ghosted, ["b", "c"], ["c"])), "b c")
})

test("a card off screen that leaves simply goes", () => {
  assert.equal(drawn(next(slots("a", "b", "c"), ["b", "c"], ["c"])), "b c")
})

test("a card the human put away leaves the ordinary way, never as a ghost", () => {
  assert.equal(drawn(next(slots("a", "b", "c"), ["b", "c"], ["a", "b"], { mayGhost: never })), "b c")
})

test("a dismissed card keeps its place while it fades on screen, and goes once it is off screen", () => {
  assert.equal(drawn(next(slots("a", "b"), ["b"], ["a", "b"], { mayGhost: never, keep: ["a"] })), "a b")
  assert.equal(drawn(next(slots("a", "b"), ["b"], ["b"], { mayGhost: never, keep: ["a"] })), "b")
})

test("cards on screen never swap, even when the queue's order between them changes", () => {
  assert.equal(drawn(next(slots("a", "b", "c"), ["b", "a", "c"], ["a", "b"])), "a b c")
})

test("off screen the order converges on the queue's own: a card crossing from below to above is allowed", () => {
  // x was drawn below the run but now sorts first: it moves above, which the viewport lock absorbs.
  assert.equal(drawn(next(slots("a", "b", "x"), ["x", "a", "b"], ["a", "b"])), "x a b")
  // …and the cards above and below are each in the queue's order.
  assert.equal(drawn(next(slots("p", "q", "a", "b", "y", "z"), ["q", "p", "a", "b", "z", "y"], ["a", "b"])), "q p a b z y")
})

test("with only ghosts on screen, cards keep their side and a new one goes below", () => {
  const prev: QueueSlot<string>[] = [...slots("p"), { key: "g", item: "g", ghost: true }, ...slots("z")]
  assert.equal(drawn(next(prev, ["p", "n", "z"], ["g"])), "p (g) n z")
})
