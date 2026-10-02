import assert from "node:assert/strict"
import test from "node:test"
import { registeredDoneBody, showsRegisteredDoneCard } from "./registeredDone.ts"

// The card this predicate gates exists for ONE case: a completion the worker registered by tool, which
// no message carries and so nothing else on the page draws. Every other shape of lastFence already has
// a renderer, and drawing it here too would be the same ending twice.

test("a registered done with no fence in the final message draws the card", () => {
  const thread = { lastFence: { kind: "done" as const, body: "- **Fixed** it", hints: [], registered: true as const } }
  assert.equal(showsRegisteredDoneCard(thread, "**Fixed** — landed on `main`."), true)
  // No final assistant message at all (a thread whose transcript has not been read yet) still draws it:
  // the registration is the fact, the message is only where a duplicate could come from.
  assert.equal(showsRegisteredDoneCard(thread, undefined), true)
})

test("a FENCED done is drawn by the message that holds it, never here", () => {
  // The board carries a fenced done without the flag — that fence came out of the transcript.
  const fenced = { lastFence: { kind: "done" as const, body: "shipped", hints: [] } }
  assert.equal(showsRegisteredDoneCard(fenced, "```done\nshipped\n```"), false)
  // …and a registered done whose final message ALSO carries a ```done fence yields to the message's
  // card: a worker that said it twice gets one card, in the place the eye already lands.
  const both = { lastFence: { kind: "done" as const, body: "shipped", hints: [], registered: true as const } }
  assert.equal(showsRegisteredDoneCard(both, "Done.\n\n```done\nshipped\n```"), false)
  // An awaiting fence in the message is not a done card, so it does not suppress one.
  assert.equal(showsRegisteredDoneCard(both, "```awaiting\nfor: 2h\n---\nwaiting\n```"), true)
})

test("no fence, an awaiting fence, or no thread draws nothing", () => {
  assert.equal(showsRegisteredDoneCard(undefined, "text"), false)
  assert.equal(showsRegisteredDoneCard({ lastFence: undefined }, "text"), false)
  assert.equal(showsRegisteredDoneCard({ lastFence: { kind: "awaiting", body: "", hints: [], registered: true } }, "text"), false)
})

test("a done the human has written past draws without its ledger", () => {
  assert.equal(registeredDoneBody({ body: "- **Fixed** it" }), "- **Fixed** it")
  assert.equal(registeredDoneBody({ body: "- **Fixed** it", spokenPast: true }), "")
})
