// SPINOFFS: the request a parent's worker is handed, and the chat's reading of it back. One contract —
// the server formats it, the transcript projection parses it — so the two are pinned together here.
import { test } from "node:test"
import assert from "node:assert/strict"
import { DispatchInput, isInjectedNoise, SPINOFF_ID_RE, SpinoffInput, parseSpinoffChildPrompt, parseSpinoffRequest, spinoffChildPrompt, spinoffIdOfSpawnCall, spinoffRequestMessage } from "./index.ts"

const id = "spn_0123456789abcdef"

test("a spinoff request round-trips through the chat's parser, multi-line text intact", () => {
  const instructions = "fix this\nand add a test"
  const message = spinoffRequestMessage({ id, instructions })
  assert.deepEqual(parseSpinoffRequest(message), { id, instructions })
  // The transcript drops "plumbing" by prefix; the request is the human's and must survive that filter
  // (a `<frizz-…>` tag did not, and the request vanished from the parent's timeline).
  assert.equal(isInjectedNoise(message), false)
  // It tells the worker exactly which id to hand back, and what the instructions are about.
  assert.match(message, /spawn_thread` with `spinoff: "spn_0123456789abcdef"`/)
  assert.match(message, /most recent part of the conversation/)
  // A side request: the worker announces nothing and does not sign off again (the chat's card says it all).
  assert.match(message, /Do not announce the new thread/)
  // Two words, not silence: a silent rest makes Claude Code re-prompt the worker for visible output.
  assert.match(message, /end your turn right after the tool call with the two words `Spun off\.` and nothing else/)
  assert.match(message, /do not sign off again/)
  assert.doesNotMatch(message, /Say in one line/)
})

test("a mid-message envelope is just the human talking", () => {
  const message = spinoffRequestMessage({ id, instructions: "investigate perf" })
  assert.equal(parseSpinoffRequest(`look at this:\n${message}`), null)
  assert.equal(parseSpinoffRequest("fix this"), null)
})

test("a first-day request, asked of one message, still reads as a spinoff", () => {
  const legacy = [
    `<spin-off-request id="${id}">`,
    "The human selected one message in this conversation and asked for a NEW thread spun off from it.",
    "",
    "Their instructions for the new thread:",
    "<instructions>",
    "fix this",
    "</instructions>",
    "",
    "The message they selected:",
    "<selected-message>",
    "The cache keys on the raw id.",
    "</selected-message>",
    "",
    "Do this now, before anything else:",
    "</spin-off-request>",
  ].join("\n")
  assert.deepEqual(parseSpinoffRequest(legacy), { id, instructions: "fix this" })
  // The tags must agree: one envelope's open with the other's close is not a request.
  assert.equal(parseSpinoffRequest(legacy.replace("</spin-off-request>", "</spinoff-request>")), null)
})

test("the child's prompt carries the human's words verbatim and a link back, above the parent's brief", () => {
  const prompt = spinoffChildPrompt({ parentSlug: "cache-bug", parentTitle: "Cache [bug]", instructions: "fix this\nsoon", brief: "The resolver keys on…" })
  assert.equal(prompt.split("\n")[0], "A spinoff of [Cache bug](/thread/cache-bug), at the human's request. Their instructions:")
  assert.match(prompt, /\n> fix this\n> soon\n/)
  assert.ok(prompt.endsWith("The resolver keys on…"))
})

test("a parent with a handle is named by it, which the child's prose and read_thread both resolve", () => {
  const prompt = spinoffChildPrompt({ parentSlug: "cache-bug", parentTitle: "Cache bug", parentHandle: "cache-bug", instructions: "fix this", brief: "The resolver keys on…" })
  assert.equal(prompt.split("\n")[0], "A spinoff of @cache-bug, at the human's request. Their instructions:")
  assert.match(prompt, /\nThe context @cache-bug gathered for you:\n/)
})

test("the child's first prompt reads back into the human's instructions and the parent's brief", () => {
  const brief = "The resolver keys on the raw id.\n\n> a quoted line in the brief stays in the brief\n\n- src/resolver.ts"
  for (const parentHandle of ["cache-bug", undefined]) {
    const prompt = spinoffChildPrompt({ parentSlug: "cache-bug", parentTitle: "Cache bug", parentHandle, instructions: "fix this\n\nand add a test", brief })
    assert.deepEqual(parseSpinoffChildPrompt(prompt), { instructions: "fix this\n\nand add a test", brief })
    // The dispatch envelope is stripped before this runs, but trailing/leading whitespace is not a reason to miss.
    assert.deepEqual(parseSpinoffChildPrompt(`\n${prompt}\n`), { instructions: "fix this\n\nand add a test", brief })
  }
  // Anything else is just a prompt: a brief a worker wrote itself, a human quoting the header mid-message.
  assert.equal(parseSpinoffChildPrompt("Evaluate whether the feature is a good idea."), null)
  assert.equal(parseSpinoffChildPrompt("see: A spinoff of @cache-bug, at the human's request. Their instructions:\n\n> x\n\nThe context @cache-bug gathered for you:\n\ny"), null)
})

test("a spawn_thread call names the spinoff it fulfils, under any prefix and either spelling", () => {
  assert.equal(spinoffIdOfSpawnCall("mcp__frizz__spawn_thread", { prompt: "p", spinoff: ` ${id} ` }), id)
  assert.equal(spinoffIdOfSpawnCall("spawn_thread", { spinOff: id }), id)
  assert.equal(spinoffIdOfSpawnCall("frizz.spawn_thread", { spinoff: id }), id)
  assert.equal(spinoffIdOfSpawnCall("mcp__frizz__spawn_thread", { prompt: "p" }), undefined)
  assert.equal(spinoffIdOfSpawnCall("mcp__frizz__spawn_thread", { spinoff: "spn_nothex" }), undefined)
  assert.equal(spinoffIdOfSpawnCall("mcp__frizz__message_thread", { spinoff: id }), undefined)
  assert.equal(spinoffIdOfSpawnCall("mcp__frizz__spawn_thread", "not an object"), undefined)
})

test("ids and inputs are validated at the schema", () => {
  assert.ok(SPINOFF_ID_RE.test(id))
  assert.equal(DispatchInput.safeParse({ prompt: "x", spinoff: "spn_nothex" }).success, false)
  assert.equal(DispatchInput.safeParse({ prompt: "x", spinoff: id, spinoffFrom: "parent" }).success, true)
  const base = { slug: "parent", sessionId: "sid" }
  assert.equal(SpinoffInput.safeParse({ ...base, instructions: "   " }).success, false)
  assert.equal(SpinoffInput.safeParse({ ...base, instructions: "fix this" }).success, true)
  // No message is picked any more, so a client that still sends one is out of date and refused.
  assert.equal(SpinoffInput.safeParse({ ...base, instructions: "fix this", sourceId: "m1" }).success, false)
})
