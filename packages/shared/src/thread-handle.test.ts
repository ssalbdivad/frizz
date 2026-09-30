import assert from "node:assert/strict"
import test from "node:test"
import { threadHandle, threadMentions } from "./thread-handle.ts"

test("a name shows as the camelCase handle it is addressed by", () => {
  assert.equal(threadHandle("Shell budgets"), "shellBudgets")
  assert.equal(threadHandle("Focus mode"), "focusMode")
  assert.equal(threadHandle("Mentions"), "mentions")
  // Proper nouns keep their casing behind the capital; a leading acronym lowercases whole.
  assert.equal(threadHandle("ArkType perf"), "arkTypePerf")
  assert.equal(threadHandle("API keys"), "apiKeys")
  assert.equal(threadHandle("Codex MCP"), "codexMCP")
  // Punctuation and diacritics fold away; an existing handle is its own handle.
  assert.equal(threadHandle("Zod 4.5"), "zod45")
  assert.equal(threadHandle("Café menu"), "cafeMenu")
  assert.equal(threadHandle("shellBudgets"), "shellBudgets")
})

test("a session title of up to five words gets a handle; a sentence does not", () => {
  assert.equal(threadHandle("Test fixture secret word"), "testFixtureSecretWord")
  assert.equal(threadHandle("Zon4.5 features and z.properties documentation audit"), undefined)
  assert.equal(threadHandle("  "), undefined)
})

test("mentions are read off free text, not off email addresses", () => {
  assert.deepEqual(threadMentions("ask @shellBudgets about it, then reconcile with @focus-mode."), ["shellBudgets", "focus-mode"])
  assert.deepEqual(threadMentions("@arkTypePerf first"), ["arkTypePerf"])
  assert.deepEqual(threadMentions("mail david@pullfrog.com"), [])
})
