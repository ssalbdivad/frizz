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

// ---- what every CLI starts with, and the spare ------------------------------------------------------------

type Captured = { prompt?: unknown; options: Record<string, unknown> }
function recordingQuery(answers: unknown[][], seen: Captured[], events: string[]): NonNullable<ClaudeOneShotOptions["query"]> {
  const inner = fakeQuery(answers.map((messages) => ({ messages })), events)
  return ((params: Captured) => {
    seen.push(params)
    return inner(params as never)
  }) as unknown as NonNullable<ClaudeOneShotOptions["query"]>
}

/** A stand-in for the SDK's `startup`: each call parks a "CLI" whose one `query()` answers from `answers`. */
function fakeStartup(answers: unknown[][], seen: Captured[], events: string[], fail: Set<number> = new Set()): NonNullable<ClaudeOneShotOptions["startup"]> {
  let n = 0
  return (async (params: { options: Record<string, unknown> }) => {
    const index = n++
    seen.push({ options: params.options })
    events.push(`startup ${index}`)
    if (fail.has(index)) throw new Error("spawn failed")
    return {
      query(prompt: string) {
        events.push(`warm query ${index}: ${prompt}`)
        let i = 0
        const messages = answers[index] ?? []
        return {
          [Symbol.asyncIterator]() { return this },
          async next() { return i < messages.length ? { done: false, value: messages[i++] } : { done: true, value: undefined } },
          async return() { return { done: true, value: undefined } },
          close() { events.push(`warm close ${index}`) },
        }
      },
      close() { events.push(`spare closed ${index}`) },
      async [Symbol.asyncDispose]() {},
    }
  }) as unknown as NonNullable<ClaudeOneShotOptions["startup"]>
}

test("every CLI starts with no MCP servers, no settings, no tools, no persistence and no non-essential traffic", async () => {
  // Measured on the real CLI (claude-oneshot.ts header): the non-essential traffic flag alone took the
  // interpreter's answer from 3.55s to 1.86s median; no MCP servers keeps a user-scope one from spawning.
  const seen: Captured[] = []
  const complete = createClaudeOneShot({ ...base, query: recordingQuery([ok("x")], seen, []) })
  await complete({ system: "s", prompt: "p", model: "sonnet" })
  const o = seen[0]!.options
  assert.equal(seen[0]!.prompt, "p")
  assert.equal(o.strictMcpConfig, true)
  assert.deepEqual(o.mcpServers, {})
  assert.deepEqual(o.settingSources, [])
  assert.deepEqual(o.tools, [])
  assert.equal(o.persistSession, false)
  assert.equal(o.maxTurns, 1)
  assert.equal(o.model, "sonnet")
  assert.equal(o.systemPrompt, "s")
  assert.equal((o.env as Record<string, string>).CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1")
})

test("with a spare, the next request with the same model and system prompt is written to a CLI already started", async () => {
  const events: string[] = []
  const seen: Captured[] = []
  const spareSeen: Captured[] = []
  const complete = createClaudeOneShot({
    ...base,
    concurrency: 1,
    spare: { idleMs: 60_000 },
    query: recordingQuery([ok("cold")], seen, events),
    startup: fakeStartup([ok("warm 1"), ok("warm 2")], spareSeen, events),
  })
  assert.equal(await complete({ system: "s", prompt: "1" }), "cold")
  assert.equal(await complete({ system: "s", prompt: "2" }), "warm 1")
  assert.equal(await complete({ system: "s", prompt: "3" }), "warm 2")
  assert.equal(seen.length, 1, "only the first request started a CLI of its own")
  // Each claim starts the next spare before writing its own prompt.
  assert.deepEqual(events.filter((e) => /^(spawn|startup|warm query)/.test(e)), [
    "startup 0", "spawn 0", "startup 1", "warm query 0: 2", "startup 2", "warm query 1: 3",
  ])
  // The spare starts with exactly the options a cold CLI would, prompt aside.
  const { abortController: _a, ...cold } = seen[0]!.options
  const { abortController: _b, ...warm } = spareSeen[0]!.options
  assert.deepEqual(warm, cold)
})

test("a request for another system prompt or model replaces the spare and starts cold", async () => {
  const events: string[] = []
  const seen: Captured[] = []
  const complete = createClaudeOneShot({
    ...base,
    spare: { idleMs: 60_000 },
    query: recordingQuery([ok("a"), ok("b"), ok("c")], seen, events),
    startup: fakeStartup([], [], events),
  })
  await complete({ system: "s1", prompt: "1" })
  await complete({ system: "s2", prompt: "2" })
  await complete({ system: "s2", prompt: "3", model: "opus" })
  assert.equal(seen.length, 3)
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(events.filter((e) => e.startsWith("spare closed")), ["spare closed 0", "spare closed 1"])
})

test("an unclaimed spare is closed after idleMs", async () => {
  const events: string[] = []
  const complete = createClaudeOneShot({
    ...base,
    spare: { idleMs: 40 },
    query: recordingQuery([ok("a")], [], events),
    startup: fakeStartup([], [], events),
  })
  await complete({ system: "s", prompt: "1" })
  assert.ok(!events.includes("spare closed 0"))
  await new Promise((r) => setTimeout(r, 80))
  assert.ok(events.includes("spare closed 0"), events.join(", "))
})

test("a spare that failed to start, or died while it waited, costs the request nothing: it starts cold", async () => {
  const events: string[] = []
  const seen: Captured[] = []
  const complete = createClaudeOneShot({
    ...base,
    concurrency: 1,
    spare: { idleMs: 60_000 },
    query: recordingQuery([ok("cold 1"), ok("cold 2"), ok("cold 3")], seen, events),
    // Spare 0 fails to start; spare 1 "died": its query ends without a word.
    startup: fakeStartup([[], []], [], events, new Set([0])),
  })
  assert.equal(await complete({ system: "s", prompt: "1" }), "cold 1")
  assert.equal(await complete({ system: "s", prompt: "2" }), "cold 2")
  assert.equal(await complete({ system: "s", prompt: "3" }), "cold 3")
  assert.deepEqual(events.filter((e) => /^(spawn|startup|warm query)/.test(e)), [
    "startup 0", "spawn 0", // no spare yet; spare 0 fails to start and is dropped
    "startup 1", "spawn 1", // so request 2 starts cold too
    "startup 2", "warm query 1: 3", "spawn 2", // spare 1 ends without a word: request 3 starts cold
  ])
})
