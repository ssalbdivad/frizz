import { test } from "node:test"
import assert from "node:assert/strict"
import { createClaudeOneShot, type ClaudeOneShotOptions } from "./claude-oneshot.ts"

// A stand-in for the SDK's session: yields the given messages, and makes its `return()` (the shutdown the
// real SDK waits on while the CLI exits) take as long as the test says. The real-CLI measurement of the
// same behaviour lives in the commit that introduced resolve-on-result; this pins its shape.
type Fake = {
  messages: unknown[]
  returnMs?: number
  returnThrows?: Error
  closeThrows?: Error
}
function fakeQuery(fakes: Fake[], events: string[]): NonNullable<ClaudeOneShotOptions["query"]> {
  let n = 0
  return ((_params: unknown) => {
    const index = n++
    const fake = fakes[index]!
    events.push(`spawn ${index}`)
    let i = 0
    return {
      [Symbol.asyncIterator]() { return this },
      async next() {
        if (i < fake.messages.length) return { done: false, value: fake.messages[i++] }
        return { done: true, value: undefined }
      },
      async return() {
        events.push(`return start ${index}`)
        await new Promise((r) => setTimeout(r, fake.returnMs ?? 0))
        events.push(`return done ${index}`)
        if (fake.returnThrows) throw fake.returnThrows
        return { done: true, value: undefined }
      },
      close() {
        events.push(`close ${index}`)
        if (fake.closeThrows) throw fake.closeThrows
      },
    }
  }) as unknown as NonNullable<ClaudeOneShotOptions["query"]>
}

const ok = (text: string) => [
  { type: "system", subtype: "init" },
  { type: "assistant" },
  { type: "result", subtype: "success", is_error: false, result: text },
]
const base = { cwd: "/tmp", claudeBin: "/bin/true" }

test("the answer resolves on the result message, before the session's shutdown finishes", async () => {
  const events: string[] = []
  const complete = createClaudeOneShot({ ...base, query: fakeQuery([{ messages: ok("Issue triage"), returnMs: 200 }], events) })
  const started = performance.now()
  const answer = await complete({ system: "s", prompt: "p" })
  const elapsed = performance.now() - started
  assert.equal(answer, "Issue triage")
  assert.ok(elapsed < 150, `resolved after ${elapsed.toFixed(0)}ms, i.e. it waited on the 200ms shutdown`)
  assert.ok(!events.includes("return done 0"), `the shutdown had already finished: ${events.join(", ")}`)
  // …and the shutdown still happens, return() then close(), in the background.
  await new Promise((r) => setTimeout(r, 260))
  assert.deepEqual(events, ["spawn 0", "return start 0", "return done 0", "close 0"])
})

test("a queued completion waits for the previous session's shutdown, so concurrency bounds live CLIs", async () => {
  const events: string[] = []
  const complete = createClaudeOneShot({
    ...base,
    concurrency: 1,
    query: fakeQuery([{ messages: ok("a"), returnMs: 50 }, { messages: ok("b") }], events),
  })
  const [a, b] = await Promise.all([complete({ system: "s", prompt: "1" }), complete({ system: "s", prompt: "2" })])
  assert.deepEqual([a, b], ["a", "b"])
  assert.ok(events.indexOf("spawn 1") > events.indexOf("close 0"), events.join(", "))
})

test("a shutdown failure is logged, never thrown, and never costs the answer", async () => {
  const events: string[] = []
  const logged: string[] = []
  const complete = createClaudeOneShot({
    ...base,
    log: (m) => logged.push(m),
    query: fakeQuery([{ messages: ok("x"), returnThrows: new Error("EPIPE"), closeThrows: new Error("already closed") }], events),
  })
  assert.equal(await complete({ system: "s", prompt: "p" }), "x")
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(logged.length, 2, logged.join("\n"))
  assert.match(logged[0]!, /return\(\) failed: EPIPE/)
  assert.match(logged[1]!, /close\(\) failed: already closed/)
})

test("an error result rejects, and the session is still shut down and its slot released", async () => {
  const events: string[] = []
  const complete = createClaudeOneShot({
    ...base,
    concurrency: 1,
    query: fakeQuery([
      { messages: [{ type: "result", subtype: "error_max_turns", is_error: true }] },
      { messages: [{ type: "system", subtype: "init" }] },
      { messages: ok("after") },
    ], events),
  })
  await assert.rejects(complete({ system: "s", prompt: "p" }), /Claude answered with error_max_turns \(error\)/)
  await assert.rejects(complete({ system: "s", prompt: "p" }), /ended the session without a result/)
  assert.equal(await complete({ system: "s", prompt: "p" }), "after")
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(events.filter((e) => e.startsWith("close")), ["close 0", "close 1", "close 2"])
})

test("a session that never answers is aborted at the timeout", async () => {
  let aborted = false
  const query = ((params: { options: { abortController: AbortController } }) => {
    const signal = params.options.abortController.signal
    return {
      [Symbol.asyncIterator]() { return this },
      next: () => new Promise((_, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")) })),
      async return() { return { done: true, value: undefined } },
      close() {},
    }
  }) as unknown as NonNullable<ClaudeOneShotOptions["query"]>
  const complete = createClaudeOneShot({ ...base, timeoutMs: 30, query })
  await assert.rejects(complete({ system: "s", prompt: "p" }), /did not answer within 0s/)
  assert.ok(aborted)
})
