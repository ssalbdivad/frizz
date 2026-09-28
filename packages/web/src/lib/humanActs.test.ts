import { test } from "node:test"
import assert from "node:assert/strict"
import { actedOnHere, noteRpcMutation, resetHumanActs } from "./humanActs.ts"

// lib/humanActs.ts: a card that leaves the queue while on screen stays as a ghost unless the human took it
// away from this tab. These pin what counts as taking it away.

test("an act on a thread from this tab keeps its card from ghosting for half a minute", () => {
  resetHumanActs()
  noteRpcMutation("setThreadState", { slug: "fix-auth", state: "archived" }, 1_000)
  assert.equal(actedOnHere("fix-auth", 1_000), true)
  assert.equal(actedOnHere("fix-auth", 30_999), true)
  assert.equal(actedOnHere("fix-auth", 31_000), false)
  assert.equal(actedOnHere("other", 1_000), false)
})

test("reading a card, opening a link, or a lookup is not taking it away", () => {
  resetHumanActs()
  for (const name of ["markRead", "threadSeen", "openExternal", "openLocalFile", "listOwnThreadTimers", "getOwnThreadRecurringPrompt"]) {
    noteRpcMutation(name, { slug: "fix-auth" }, 1_000)
  }
  assert.equal(actedOnHere("fix-auth", 1_000), false)
})

test("a mutation that names no thread marks none", () => {
  resetHumanActs()
  noteRpcMutation("dispatch", { prompt: "go" }, 1_000)
  noteRpcMutation("settingsSet", undefined, 1_000)
  assert.equal(actedOnHere("go", 1_000), false)
})
