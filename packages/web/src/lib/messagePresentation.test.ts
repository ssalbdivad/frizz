import { test } from "node:test"
import assert from "node:assert/strict"
import { lastAskIndex, messagePresentationText } from "./messagePresentation.ts"

test("messagePresentationText prefers a validated display projection without changing full text", () => {
  const message = { text: "compact\n\n<!-- boundary -->\n\nlarge machine tail", displayText: "compact" }
  assert.equal(messagePresentationText(message), "compact")
  assert.match(message.text, /large machine tail/)
})

test("messagePresentationText leaves ordinary messages and HTML comments untouched", () => {
  const text = "Example:\n<!-- an ordinary comment -->\nstill visible"
  assert.equal(messagePresentationText({ text }), text)
})

test("lastAskIndex pins the human's latest landed turn, never a queued one or an inter-agent message", () => {
  const ask = { role: "user" as const }
  const reply = { role: "assistant" as const }
  const report = { role: "user" as const, peerFrom: "bun_project_survey" }
  const instruction = { role: "user" as const, agentInstruction: true as const }
  const queued = { role: "user" as const, queued: true }

  assert.equal(lastAskIndex([ask, reply]), 0)
  // An orchestrator's children report continuously; each is a `user` row the human never wrote, and
  // letting one win would re-pin the current-ask band to "Sub-agent «…» reported" on every report.
  assert.equal(lastAskIndex([ask, reply, report, report]), 0)
  assert.equal(lastAskIndex([ask, reply, instruction]), 0)
  // A queued follow-up pins to the bottom until it lands, so it is not the ask either.
  assert.equal(lastAskIndex([ask, report, queued]), 0)
  // A genuine later human turn does take the pin back.
  assert.equal(lastAskIndex([ask, report, { role: "user" as const }]), 2)
  assert.equal(lastAskIndex([reply, report]), -1)
  assert.equal(lastAskIndex([]), -1)
})
