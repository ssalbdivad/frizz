import assert from "node:assert/strict"
import test from "node:test"
import type { SpinoffView, TranscriptToolCall } from "@frizz/shared"
import type { ChatMessage } from "../hooks.ts"
import { startedSpinoffsKey, withoutSpinoffCalls } from "./spinoffCalls.ts"
import { coalesceToolActivityMessages } from "./toolActivity.ts"

// The parent's `spawn_thread` call that STARTED a spinoff's thread is drawn by the spinoff card, so the chat
// drops it from the message list before anything reads it (lib/spinoffCalls.ts) — and only that call.

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
// The request the spawn above started: its edge carries the child the card links.
const STARTED = startedSpinoffsKey({ id: "parent", spinoffs: [{ id: "spn_0123456789abcdef", parentSlug: "parent", childSlug: "child", instructions: "x", createdAt: 0 }] })

test("the fulfilling call leaves both the flat list and the parts; everything else stays where it was", () => {
  const before = assistant("a", [{ text: "Checking." }, { tools: [read, spawn, ownSpawn] }])
  const [after] = withoutSpinoffCalls([before], STARTED)
  assert.deepEqual(after.tools.map((t) => t.name), ["Read", "mcp__frizz__spawn_thread"])
  assert.equal(after.tools[1].spinoff, undefined)
  assert.deepEqual(after.parts, [{ kind: "text", text: "Checking." }, { kind: "tools", tools: [{ ...read }, { ...ownSpawn }] }])
})

test("a message that was only the call becomes empty — so the coalescer drops it — and the list keeps its length and identities", () => {
  const prose = assistant("p", [{ text: "Working on the cache." }])
  const only = assistant("s", [{ tools: [spawn] }])
  const reads = assistant("r", [{ tools: [read] }])
  const out = withoutSpinoffCalls([prose, only, reads], STARTED)
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

// Review 2026-09-30: the tell is stamped from the call's INPUT before any result exists, so hiding on it
// alone hid the one line that said why a spinoff did not start.
test("a call that failed, or whose request never got a child, keeps its line — only the call the card links goes", () => {
  const refused: TranscriptToolCall = { ...spawn, status: "failed", detail: "Spinoff spn_0123456789abcdef is already being dispatched" }
  const pendingEdge = (childSlug: string | null): SpinoffView => ({ id: "spn_0123456789abcdef", parentSlug: "parent", childSlug, instructions: "x", createdAt: 0 })
  const unstarted = startedSpinoffsKey({ id: "parent", spinoffs: [pendingEdge(null)] })
  assert.equal(unstarted, "", "a request with no child is not started")

  // No child on the edge: the call — successful or not — is the only record of what happened.
  const msg = assistant("s", [{ tools: [spawn] }])
  assert.equal(withoutSpinoffCalls([msg], unstarted)[0], msg, "an edge the server never stamped hides nothing")
  assert.equal(withoutSpinoffCalls([msg], "")[0], msg, "nor does a thread with no edges at all (an old server)")

  // A child exists, but the attempt that FAILED is not the call that started it: a retry's first try.
  const retried = assistant("r", [{ tools: [refused, spawn] }])
  const [out] = withoutSpinoffCalls([retried], STARTED)
  assert.deepEqual(out.tools.map((t) => t.status), ["failed"], "the refused attempt keeps its line; the one that started the thread goes")
  const cancelled = assistant("c", [{ tools: [{ ...spawn, status: "cancelled" }] }])
  assert.equal(withoutSpinoffCalls([cancelled], STARTED)[0], cancelled)

  // A call still in flight whose edge fulfilSpinoff has already stamped is the card's too — hidden from
  // its first frame rather than flashing up and vanishing when the result lands.
  const inFlight = assistant("f", [{ tools: [{ ...spawn, status: "pending" }] }])
  assert.deepEqual(withoutSpinoffCalls([inFlight], STARTED)[0].tools, [])
})

test("only the parent's own started edges count, and the key is stable across equal board pushes", () => {
  const e = (id: string, parentSlug: string, childSlug: string | null): SpinoffView => ({ id, parentSlug, childSlug, instructions: "x", createdAt: 0 })
  // A child thread carries the edge it came from (childSlug = itself); its transcript never fulfilled it.
  assert.equal(startedSpinoffsKey({ id: "child", spinoffs: [e("spn_a", "parent", "child")] }), "")
  assert.equal(
    startedSpinoffsKey({ id: "p", spinoffs: [e("spn_b", "p", "y"), e("spn_a", "p", "x"), e("spn_c", "p", null)] }),
    startedSpinoffsKey({ id: "p", spinoffs: [e("spn_a", "p", "x"), e("spn_b", "p", "y")] }),
    "order-independent, so a re-sorted board push does not rebuild the transcript",
  )
})
