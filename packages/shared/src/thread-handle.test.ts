import assert from "node:assert/strict"
import test from "node:test"
import { addressSegments, subAgentAddress, subAgentChain, subAgentHandle, threadHandle, threadMentions } from "./thread-handle.ts"

test("a name shows as the kebab-case handle it is addressed by", () => {
  assert.equal(threadHandle("Shell budgets"), "shell-budgets")
  assert.equal(threadHandle("Focus mode"), "focus-mode")
  assert.equal(threadHandle("Mentions"), "mentions")
  // Every word lowercases whole, and a word is never split at its capitals.
  assert.equal(threadHandle("ArkType perf"), "arktype-perf")
  assert.equal(threadHandle("API keys"), "api-keys")
  assert.equal(threadHandle("Codex MCP"), "codex-mcp")
  // Punctuation separates words and diacritics fold away; an existing handle is its own handle.
  assert.equal(threadHandle("Zod 4.5"), "zod-4-5")
  assert.equal(threadHandle("Café menu"), "cafe-menu")
  assert.equal(threadHandle("shell-budgets"), "shell-budgets")
})

test("a session title of up to five words gets a handle; a sentence does not", () => {
  assert.equal(threadHandle("Test fixture secret word"), "test-fixture-secret-word")
  assert.equal(threadHandle("Zon4.5 features and z.properties documentation audit"), undefined)
  assert.equal(threadHandle("  "), undefined)
})

test("mentions are read off free text, not off email addresses", () => {
  assert.deepEqual(threadMentions("ask @shell-budgets about it, then reconcile with @focus-mode."), ["shell-budgets", "focus-mode"])
  assert.deepEqual(threadMentions("@arktype-perf first"), ["arktype-perf"])
  // A handle written before the kebab switch is still read whole.
  assert.deepEqual(threadMentions("@shellBudgets first"), ["shellBudgets"])
  assert.deepEqual(threadMentions("mail david@pullfrog.com"), [])
})

test("a dash straight after a mention is punctuation, not part of it", () => {
  assert.deepEqual(threadMentions("ask @shell-budgets- then"), ["shell-budgets"])
  assert.deepEqual(threadMentions("ask @shell-budgets -- then @focus-mode_"), ["shell-budgets", "focus-mode"])
})

test("a sub-agent mention runs through its thread's handle, and a full stop after a mention is not part of it", () => {
  assert.deepEqual(threadMentions("ask @port-the-parser.cache-keys, then @port-the-parser.wave-2.impl-w3."), ["port-the-parser.cache-keys", "port-the-parser.wave-2.impl-w3"])
  assert.deepEqual(threadMentions("done with @shell-budgets. Next"), ["shell-budgets"])
})

test("a sub-agent is named by the thread rule and addressed under its thread", () => {
  assert.equal(subAgentHandle("Cache keys"), "cache-keys")
  assert.equal(subAgentHandle("fix:r1"), "fix-r1")
  assert.equal(subAgentHandle("Fresh-context review of the whole effort diff"), undefined, "a sentence has no handle")
  assert.deepEqual(addressSegments("@port-the-parser.cache-keys"), ["port-the-parser", "cache-keys"])
  const agents = [
    { id: "wf", label: "Wave 2" },
    { id: "w3", label: "impl:W3", parentId: "wf" },
    { id: "long", label: "Fresh-context review of the whole effort diff" },
    { id: "under-long", label: "Cache keys", parentId: "long" },
    { id: "orphan", label: "Orphan", parentId: "gone" },
  ]
  assert.deepEqual(subAgentChain(agents, "w3"), ["wave-2", "impl-w3"])
  assert.equal(subAgentAddress("port-the-parser", subAgentChain(agents, "w3")!), "port-the-parser.wave-2.impl-w3")
  assert.equal(subAgentChain(agents, "under-long"), undefined, "a parent with no handle leaves a hole")
  assert.equal(subAgentChain(agents, "orphan"), undefined, "a parent that has returned leaves a hole")
})
