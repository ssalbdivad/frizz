import assert from "node:assert/strict"
import test from "node:test"
import { addressSegments, subAgentAddress, subAgentChain, subAgentHandle, threadHandle, threadMentions } from "./thread-handle.ts"

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

test("a sub-agent mention runs through its thread's handle, and a full stop after a mention is not part of it", () => {
  assert.deepEqual(threadMentions("ask @portTheParser.cacheKeys, then @portTheParser.wave2.implW3."), ["portTheParser.cacheKeys", "portTheParser.wave2.implW3"])
  assert.deepEqual(threadMentions("done with @shellBudgets. Next"), ["shellBudgets"])
})

test("a sub-agent is named by the thread rule and addressed under its thread", () => {
  assert.equal(subAgentHandle("Cache keys"), "cacheKeys")
  assert.equal(subAgentHandle("fix:r1"), "fixR1")
  assert.equal(subAgentHandle("Fresh-context review of the whole effort diff"), undefined, "a sentence has no handle")
  assert.deepEqual(addressSegments("@portTheParser.cacheKeys"), ["portTheParser", "cacheKeys"])
  const agents = [
    { id: "wf", label: "Wave 2" },
    { id: "w3", label: "impl:W3", parentId: "wf" },
    { id: "long", label: "Fresh-context review of the whole effort diff" },
    { id: "under-long", label: "Cache keys", parentId: "long" },
    { id: "orphan", label: "Orphan", parentId: "gone" },
  ]
  assert.deepEqual(subAgentChain(agents, "w3"), ["wave2", "implW3"])
  assert.equal(subAgentAddress("portTheParser", subAgentChain(agents, "w3")!), "portTheParser.wave2.implW3")
  assert.equal(subAgentChain(agents, "under-long"), undefined, "a parent with no handle leaves a hole")
  assert.equal(subAgentChain(agents, "orphan"), undefined, "a parent that has returned leaves a hole")
})
