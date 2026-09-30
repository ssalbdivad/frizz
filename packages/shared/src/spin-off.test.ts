// SPIN-OFFS: the request a parent's worker is handed, and the chat's reading of it back. One contract —
// the server formats it, the transcript projection parses it — so the two are pinned together here.
import { test } from "node:test"
import assert from "node:assert/strict"
import { DispatchInput, SPIN_OFF_ID_RE, SpinOffInput, parseSpinOffRequest, spinOffChildPrompt, spinOffRequestMessage } from "./index.ts"

const id = "spn_0123456789abcdef"

test("a spin-off request round-trips through the chat's parser, multi-line text intact", () => {
  const instructions = "fix this\nand add a test"
  const excerpt = "The cache keys on the raw id.\n\n```ts\nconst k = id\n```"
  const message = spinOffRequestMessage({ id, instructions, excerpt })
  assert.deepEqual(parseSpinOffRequest(message), { id, instructions, excerpt })
  // It tells the worker exactly which id to hand back.
  assert.match(message, /spawn_thread` with `spinoff: "spn_0123456789abcdef"`/)
})

test("an empty excerpt reads back empty, and a mid-message envelope is just the human talking", () => {
  const message = spinOffRequestMessage({ id, instructions: "investigate perf", excerpt: "  " })
  assert.deepEqual(parseSpinOffRequest(message), { id, instructions: "investigate perf", excerpt: "" })
  assert.equal(parseSpinOffRequest(`look at this:\n${message}`), null)
  assert.equal(parseSpinOffRequest("fix this"), null)
})

test("the child's prompt carries the human's words verbatim and a link back, above the parent's brief", () => {
  const prompt = spinOffChildPrompt({ parentSlug: "cache-bug", parentTitle: "Cache [bug]", instructions: "fix this\nsoon", brief: "The resolver keys on…" })
  assert.equal(prompt.split("\n")[0], "Spun off from [Cache bug](/thread/cache-bug) at the human's request. Their instructions:")
  assert.match(prompt, /\n> fix this\n> soon\n/)
  assert.ok(prompt.endsWith("The resolver keys on…"))
})

test("ids and inputs are validated at the schema", () => {
  assert.ok(SPIN_OFF_ID_RE.test(id))
  assert.equal(DispatchInput.safeParse({ prompt: "x", spinOff: "spn_nothex" }).success, false)
  assert.equal(DispatchInput.safeParse({ prompt: "x", spinOff: id, spinOffFrom: "parent" }).success, true)
  const base = { slug: "parent", sessionId: "sid", sourceId: "m1", excerpt: "text" }
  assert.equal(SpinOffInput.safeParse({ ...base, instructions: "   " }).success, false)
  assert.equal(SpinOffInput.safeParse({ ...base, instructions: "fix this" }).success, true)
})
