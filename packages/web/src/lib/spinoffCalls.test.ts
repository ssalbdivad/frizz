import assert from "node:assert/strict"
import test from "node:test"
import type { TranscriptToolCall } from "@frizz/shared"
import type { ChatMessage } from "../hooks.ts"
import { withoutSpinoffCalls } from "./spinoffCalls.ts"
import { coalesceToolActivityMessages } from "./toolActivity.ts"

// The parent's `spawn_thread` call that fulfilled a spinoff is drawn by the spinoff card, so the chat
// drops it from the message list before anything reads it (lib/spinoffCalls.ts).

// A message off the wire carries each call TWICE, as separate objects: once flat, once inside `parts`.
function assistant(sourceId: string, parts: ({ text: string } | { tools: TranscriptToolCall[] })[]): ChatMessage {
  const copy = (tools: TranscriptToolCall[]) => tools.map((tool) => ({ ...tool }))
  return {
    sourceId,
    role: "assistant",
    text: parts.map((p) => ("text" in p ? p.text : "")).join(""),
    tools: parts.flatMap((p) => ("tools" in p ? copy(p.tools) : [])),
    parts: parts.map((p) => ("text" in p ? { kind: "text" as const, text: p.text } : { kind: "tools" as const, tools: copy(p.tools) })),
  }
}

const spawn: TranscriptToolCall = { name: "mcp__frizz__spawn_thread", status: "completed", spinoff: "spn_0123456789abcdef" }
const read: TranscriptToolCall = { name: "Read", detail: "src/a.ts", status: "completed" }
// A spawn_thread the worker made of its OWN accord fulfils no request and keeps its line.
const ownSpawn: TranscriptToolCall = { name: "mcp__frizz__spawn_thread", status: "completed" }

test("the fulfilling call leaves both the flat list and the parts; everything else stays where it was", () => {
  const before = assistant("a", [{ text: "Checking." }, { tools: [read, spawn, ownSpawn] }])
  const [after] = withoutSpinoffCalls([before])
  assert.deepEqual(after.tools.map((t) => t.name), ["Read", "mcp__frizz__spawn_thread"])
  assert.equal(after.tools[1].spinoff, undefined)
  assert.deepEqual(after.parts, [{ kind: "text", text: "Checking." }, { kind: "tools", tools: [{ ...read }, { ...ownSpawn }] }])
})

test("a message that was only the call becomes empty — so the coalescer drops it — and the list keeps its length and identities", () => {
  const prose = assistant("p", [{ text: "Working on the cache." }])
  const only = assistant("s", [{ tools: [spawn] }])
  const reads = assistant("r", [{ tools: [read] }])
  const out = withoutSpinoffCalls([prose, only, reads])
  assert.equal(out.length, 3, "indices into the list (paired answers, the fence cut) still line up")
  assert.equal(out[0], prose, "an untouched message is the same object")
  assert.equal(out[2], reads)
  assert.deepEqual(out[1].tools, [])
  assert.deepEqual(out[1].parts, [])
  // No `Ran 1 tool call` for the spawn: the empty message is transparent, and the run of reads after it
  // is not split by it either.
  const entries = coalesceToolActivityMessages(out)
  assert.deepEqual(entries.map((e) => e.message.sourceId), ["p", "r"])
})
