import assert from "node:assert/strict"
import test from "node:test"
import { settledQuestionPositions } from "./settledQuestions.ts"

// A transcript as the position reader sees it: roles, kinds, instants, and the text a marker lives in.
const msg = (role: "user" | "assistant", at: string, text = "…", kind?: string) => ({ role, at, text, ...(kind ? { kind } : {}) })
const settled = (id: string, askedAt: string, settledAt: string, pending?: true) => ({ id, askedAt, settledAt, ...(pending ? { pending } : {}) })

test("an answered question stays after the rest it was answered at, not after the answer or the turn it woke", () => {
  const messages = [
    msg("user", "2026-09-25T10:00:00Z"),
    msg("assistant", "2026-09-25T10:01:00Z"),
    msg("assistant", "2026-09-25T10:02:00Z"), // the handoff; the card rendered after this
    msg("user", "2026-09-25T10:06:00Z"), // the delivered answer
    msg("assistant", "2026-09-25T10:07:00Z"), // the turn it woke
  ]
  const anchored = settledQuestionPositions(messages, [settled("qst_a", "2026-09-25T10:01:30Z", "2026-09-25T10:05:00Z")])
  assert.deepEqual([...anchored.keys()], [2])
})

test("a question the human replied past and answered later stays at the rest that asked it", () => {
  // An open question stays at the rest that asked it once the human has replied past it (questionAnchor);
  // the card the human clicked was therefore under the first handoff, not the second.
  const messages = [
    msg("user", "2026-09-25T10:00:00Z"),
    msg("assistant", "2026-09-25T10:02:00Z"), // asked here
    msg("user", "2026-09-25T10:03:00Z"), // replied past it
    msg("assistant", "2026-09-25T10:04:00Z"), // rested again, question still open
    msg("user", "2026-09-25T10:09:00Z"), // the answer
  ]
  const anchored = settledQuestionPositions(messages, [settled("qst_a", "2026-09-25T10:01:30Z", "2026-09-25T10:08:00Z")])
  assert.deepEqual([...anchored.keys()], [1])
})

test("a question answered after frizz woke the worker stays under the newer handoff it was answered under", () => {
  const messages = [
    msg("user", "2026-09-25T10:00:00Z"),
    msg("assistant", "2026-09-25T10:02:00Z"), // asked here
    { ...msg("user", "2026-09-25T10:03:00Z", "⏰ Your watcher has expired"), wake: true },
    msg("assistant", "2026-09-25T10:04:00Z"), // rested again; the open card rode down under this
    msg("user", "2026-09-25T10:09:00Z"), // the answer
  ]
  const anchored = settledQuestionPositions(messages, [settled("qst_a", "2026-09-25T10:01:30Z", "2026-09-25T10:08:00Z")])
  assert.deepEqual([...anchored.keys()], [3])
})

// PLACEMENT IS RETIRED (2026-09-28): a marker in the answered rest no longer draws the settled card into
// its own slot — the greyed card sits under the whole handoff, as the open one did.
test("a mid-prose marker in the answered rest leaves the settled card at the bottom of that rest", () => {
  const messages = [
    msg("user", "2026-09-25T10:00:00Z"),
    msg("assistant", "2026-09-25T10:02:00Z", "Setup.\n\n```question qst_a\n```\n\nEither way."),
    msg("user", "2026-09-25T10:06:00Z"),
  ]
  const anchored = settledQuestionPositions(messages, [settled("qst_a", "2026-09-25T10:01:30Z", "2026-09-25T10:05:00Z")])
  assert.deepEqual([...anchored.keys()], [1])
})

test("a marker the worker writes AFTER the answer cannot move the settled card", () => {
  const messages = [
    msg("user", "2026-09-25T10:00:00Z"),
    msg("assistant", "2026-09-25T10:02:00Z"),
    msg("user", "2026-09-25T10:06:00Z"),
    msg("assistant", "2026-09-25T10:07:00Z", "```question qst_a\n```"),
  ]
  const anchored = settledQuestionPositions(messages, [settled("qst_a", "2026-09-25T10:01:30Z", "2026-09-25T10:05:00Z")])
  assert.deepEqual([...anchored.keys()], [1])
})

test("a card just sent from this tab sits at the tail whatever the browser clock says", () => {
  // Negative control for the clock: a settledAt far in the past would cut the prefix at message 0.
  const messages = [msg("user", "2026-09-25T10:00:00Z"), msg("assistant", "2026-09-25T10:02:00Z")]
  const anchored = settledQuestionPositions(messages, [settled("qst_a", "2026-09-25T10:01:30Z", "2000-01-01T00:00:00Z", true)])
  assert.deepEqual([...anchored.keys()], [1])
  const stale = settledQuestionPositions(messages, [settled("qst_a", "2026-09-25T10:01:30Z", "2000-01-01T00:00:00Z")])
  assert.equal(stale.size, 0)
})

test("a question answered before the loaded window draws nothing rather than hoisting to the top", () => {
  const messages = [msg("user", "2026-09-25T11:00:00Z"), msg("assistant", "2026-09-25T11:01:00Z")]
  const anchored = settledQuestionPositions(messages, [settled("qst_a", "2026-09-25T10:01:30Z", "2026-09-25T10:05:00Z")])
  assert.equal(anchored.size, 0)
})

test("one batch stays together in the order it was asked", () => {
  const messages = [msg("user", "2026-09-25T10:00:00Z"), msg("assistant", "2026-09-25T10:02:00Z"), msg("user", "2026-09-25T10:06:00Z")]
  const anchored = settledQuestionPositions(messages, [
    settled("qst_b", "2026-09-25T10:01:40Z", "2026-09-25T10:05:00Z"),
    settled("qst_a", "2026-09-25T10:01:30Z", "2026-09-25T10:05:00Z"),
  ])
  assert.deepEqual(anchored.get(1)?.map((s) => s.id), ["qst_a", "qst_b"])
})

test("the card stays above the rest divider that closes its rest, not below it", () => {
  // The shape the real tailer produces: a synthetic "Agent rested" event row after every handoff.
  const messages = [
    msg("user", "2026-09-25T10:00:00Z"),
    msg("assistant", "2026-09-25T10:02:00Z"),
    msg("assistant", "2026-09-25T10:02:00Z", "Agent rested", "event"),
    msg("user", "2026-09-25T10:06:00Z"),
  ]
  const anchored = settledQuestionPositions(messages, [settled("qst_a", "2026-09-25T10:01:30Z", "2026-09-25T10:05:00Z")])
  assert.deepEqual([...anchored.keys()], [1])
})
