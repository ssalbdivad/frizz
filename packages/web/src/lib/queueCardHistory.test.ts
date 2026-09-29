import { test } from "node:test"
import assert from "node:assert/strict"
import { historyCut } from "./queueCardHistory.ts"

const user = (at: string, extra = {}) => ({ role: "user" as const, at, ...extra })
const agent = (at: string, extra = {}) => ({ role: "assistant" as const, at, ...extra })

test("history ends at the human's last message, the card's own bubble", () => {
  const messages = [user("1"), agent("2"), user("3"), agent("4"), agent("5")]
  assert.equal(historyCut(messages, { askedAt: "3", at: "5" }), 2)
})

test("a queued send with the same stamp is not the bubble", () => {
  const messages = [user("1"), agent("2"), user("3"), user("3", { queued: true })]
  assert.equal(historyCut(messages, { askedAt: "3", at: "2" }), 2)
})

test("with the bubble off the page, history ends at the handoff; an event is never the handoff", () => {
  const messages = [agent("4"), agent("5", { kind: "event" as const }), agent("5")]
  assert.equal(historyCut(messages, { askedAt: "1", at: "5" }), 2)
})

test("with neither found, the whole page is history", () => {
  assert.equal(historyCut([user("1"), agent("2")], { askedAt: "9", at: "9" }), 2)
  assert.equal(historyCut([user("1")], undefined), 1)
})
