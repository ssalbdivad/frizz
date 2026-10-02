import assert from "node:assert/strict"
import test from "node:test"
import { noteFailedDraftOrigin, takeSupersededFailure } from "./failedDelivery.ts"

// A failed composer send goes back into the prompt box AND stays on the server as a failed bubble. The
// operator's natural next move — edit the draft, send again — must replace that bubble, not leave it
// standing beside the message that re-sent it.
test("a re-send that still carries the failed words supersedes that failure, once", () => {
  const key = "followup:test:a:s"
  noteFailedDraftOrigin(key, { deliveryId: "d-1", text: "please  rebase\nonto main", kept: true })
  assert.equal(takeSupersededFailure(key, "something unrelated"), undefined, "a send without those words supersedes nothing")
  assert.equal(takeSupersededFailure(key, "please rebase onto main\n\nand then run the tests"), "d-1", "whitespace re-flow is the same message")
  assert.equal(takeSupersededFailure(key, "please rebase onto main"), undefined, "consumed")
})

test("the newest matching failure wins, and each draft key keeps its own", () => {
  noteFailedDraftOrigin("k1", { deliveryId: "old", text: "same words", kept: true })
  noteFailedDraftOrigin("k1", { deliveryId: "new", text: "same words", kept: false })
  noteFailedDraftOrigin("k2", { deliveryId: "other", text: "same words", kept: true })
  assert.equal(takeSupersededFailure("k1", "same words"), "new")
  assert.equal(takeSupersededFailure("k1", "same words"), "old")
  assert.equal(takeSupersededFailure("k2", "same words"), "other")
})
