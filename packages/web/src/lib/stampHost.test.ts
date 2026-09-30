import assert from "node:assert/strict"
import test from "node:test"
import { stampHostFor, type BubbleMessageLike } from "./stampHost.ts"

// THE HOVER READING'S OFFSET, and the proxy that got it wrong. The transcript chose between two
// constants 7px apart on `role === "user"` until 2026-08-31 — but the role records which SIDE a turn
// was recorded on, and three shapes recorded as the human's render a hairline divider rather than a
// bubble. The commonest of them, a frizz wake, is on nearly every driven thread.
//
// Every case here is a row shape `Message` actually draws; the table is this file's whole point,
// because the predicate mirrors a branch in another file and the two can only be kept in step by
// something that fails when they drift.

const msg = (over: Partial<BubbleMessageLike> = {}): BubbleMessageLike => ({ role: "user", text: "hello", ...over })

test("the human's own bubble takes the bubble offset", () => {
  assert.equal(stampHostFor(msg()), "bubble")
})

test("agent prose takes the prose offset", () => {
  assert.equal(stampHostFor(msg({ role: "assistant", text: "On it." })), "prose")
})

test("a frizz wake is recorded as a user turn and still reads as prose", () => {
  // The scheduler's delivery is pasted into the worker's composer, so it lands on the user side —
  // and renders as a hairline divider, which is what the offset has to follow.
  assert.equal(stampHostFor(msg({ wake: true, text: "You rested without a fence." })), "prose")
})

test("a recurring prompt is a wake, so it reads as prose by the same test", () => {
  assert.equal(stampHostFor(msg({ wake: true, text: "Recurring prompt · every 15m\n\nkeep going" })), "prose")
})

test("a sub-agent's report up to its parent reads as prose", () => {
  assert.equal(stampHostFor(msg({ peerFrom: "reviewer", text: "Found the root cause." })), "prose")
})

test("an event or reasoning row reads as prose whichever side it is recorded on", () => {
  assert.equal(stampHostFor(msg({ kind: "event", text: "Agent rested" })), "prose")
  assert.equal(stampHostFor(msg({ kind: "reasoning", text: "Thought for 33s" })), "prose")
  assert.equal(stampHostFor(msg({ role: "assistant", kind: "event", text: "Agent rested" })), "prose")
})

test("an answers card keeps the bubble offset — bordered and filled is the same hard edge", () => {
  const answered = msg({ text: "Answers:\n1. A" })
  // Both routes Message takes to the card: the caller's already-parsed pairing, and the fallback parse
  // of the wire form. `null` is a computed "not an answers message" and must not be read as "unknown".
  assert.equal(stampHostFor(answered, [{ n: 1, answer: "A" }] as never), "bubble")
  assert.equal(stampHostFor(msg({ text: "just words" }), null), "bubble")
  assert.equal(stampHostFor(answered), "bubble")
})

test("a wake that also parses as answers is still a wake", () => {
  // Order matters only where two tests can both fire. Frizz's own trailer is the tell for a wake, so a
  // delivery whose body happens to look like the answers wire form must not take the card's edge.
  assert.equal(stampHostFor(msg({ wake: true, text: "Answers:\n1. A" }), null), "prose")
})

test("displayText wins over text, as it does everywhere the transcript reads a message", () => {
  assert.equal(stampHostFor(msg({ text: "raw", displayText: "Answers:\n1. A" })), "bubble")
})

test("both spinoff cards end on a hard edge, the request and a child's first turn alike", () => {
  // Outlined rather than filled (components/Spinoff.tsx), but an outline is as hard an edge as a fill.
  const envelope = '<spinoff-request id="spn_0123456789abcdef">\n…\n</spinoff-request>'
  assert.equal(stampHostFor(msg({ text: envelope, displayText: "Profile the cold start." })), "bubble")
  assert.equal(stampHostFor(msg({ text: "A spinoff of @parent, at the human's request.", displayText: "Profile the cold start." })), "bubble")
})
