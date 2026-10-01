import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import { describeRpcError, dispatchProfile, FrizzRpc, RpcError, withRetry } from "./rpc.ts"

interface Seen {
  method?: string
  url?: string
  headers: IncomingMessage["headers"]
  body: string
}

/** A listener with the server's envelope (packages/rpc/src/server.ts) and its origin gate (app.ts). */
async function rpcServer(answer: (seen: Seen) => { status: number; body: string }) {
  const seen: Seen[] = []
  const server = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk) => (body += chunk))
    request.on("end", () => {
      const entry = { method: request.method, url: request.url, headers: request.headers, body }
      seen.push(entry)
      if (request.headers["sec-fetch-site"] !== "same-origin" && !request.headers.origin) {
        response.statusCode = 403
        response.end("Forbidden")
        return
      }
      const { status, body: out } = answer(entry)
      response.statusCode = status
      response.setHeader("content-type", "application/json")
      response.end(out)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => new Promise((r) => server.close(r)) }
}

test("queries GET ?input=, mutations POST JSON, both project-id addressed with the same-origin header", async () => {
  const server = await rpcServer((seen) => ({ status: 200, body: JSON.stringify({ result: seen.method === "GET" ? { threads: [] } : { slug: "new-thread", sessionId: "s" } }) }))
  try {
    const rpc = new FrizzRpc(server.origin)
    assert.deepEqual(await rpc.query("6f1c id/x", "board"), { threads: [] })
    assert.deepEqual(await rpc.query("p1", "threadLocate", { slug: "a b" }), { threads: [] })
    assert.deepEqual(await rpc.mutation("p1", "dispatch", { prompt: "hi", backend: "claude" }), { slug: "new-thread", sessionId: "s" })
    assert.equal(server.seen[0]?.url, "/_frizz/6f1c%20id%2Fx/rpc/board")
    assert.equal(server.seen[1]?.url, `/_frizz/p1/rpc/threadLocate?input=${encodeURIComponent(JSON.stringify({ slug: "a b" }))}`)
    assert.equal(server.seen[2]?.method, "POST")
    assert.equal(server.seen[2]?.headers["content-type"], "application/json")
    assert.deepEqual(JSON.parse(server.seen[2]?.body ?? ""), { prompt: "hi", backend: "claude" })
    assert.ok(server.seen.every((s) => s.headers["sec-fetch-site"] === "same-origin"))
  } finally {
    await server.close()
  }
})

test("a void mutation's `{result:null}` is a success, and the error envelope keeps its retryable flag", async () => {
  let reply = { status: 200, body: JSON.stringify({ result: null }) }
  const server = await rpcServer(() => reply)
  try {
    const rpc = new FrizzRpc(server.origin)
    assert.equal(await rpc.mutation("p1", "followUp", { slug: "a", sessionId: "s", message: "m" }), null)
    reply = { status: 500, body: JSON.stringify({ error: "a permission change is in flight", retryable: true }) }
    const busy = await rpc.mutation("p1", "followUp", { slug: "a", sessionId: "s", message: "m" }).catch((e: unknown) => e)
    assert.ok(busy instanceof RpcError)
    assert.deepEqual([busy.message, busy.kind, busy.retryable, busy.status], ["a permission change is in flight", "failed", true, 500])
    reply = { status: 400, body: JSON.stringify({ error: "slug: Required" }) }
    const bad = await rpc.mutation("p1", "followUp", { slug: "a", sessionId: "s", message: "m" }).catch((e: unknown) => e)
    assert.deepEqual([(bad as RpcError).kind, (bad as RpcError).retryable], ["refused", false])
    reply = { status: 404, body: "Not Found" }
    assert.equal(((await rpc.query("p1", "board").catch((e: unknown) => e)) as RpcError).message, "Not Found", "a plain-text answer is its own message")
  } finally {
    await server.close()
  }
})

test("nothing listening is `unreachable`, which reads as Frizz not running", async () => {
  const server = await rpcServer(() => ({ status: 200, body: "{}" }))
  const origin = server.origin
  await server.close()
  const error = await new FrizzRpc(origin).query("p1", "board").catch((e: unknown) => e)
  assert.ok(error instanceof RpcError)
  assert.equal(error.kind, "unreachable")
  assert.equal(describeRpcError(error), "Frizz isn't running.")
})

test("only a retryable refusal is retried, on the page's schedule, and the attempt is the same each time", async () => {
  const slept: number[] = []
  const sleep = async (ms: number) => void slept.push(ms)
  let calls = 0
  const result = await withRetry(async () => {
    calls++
    if (calls < 3) throw new RpcError("busy", "failed", true, 500)
    return "delivered"
  }, [300, 800, 1800, 3500], sleep)
  assert.equal(result, "delivered")
  assert.deepEqual(slept, [300, 800])

  // Negative control: an ambiguous failure is never resent — it may have taken effect.
  calls = 0
  await assert.rejects(withRetry(async () => { calls++; throw new RpcError("boom", "failed", false, 500) }, [1, 1], sleep), /boom/)
  assert.equal(calls, 1)

  // And the schedule ends: four retries, then the last refusal surfaces.
  calls = 0
  await assert.rejects(withRetry(async () => { calls++; throw new RpcError("still busy", "failed", true, 500) }, [1, 1, 1, 1], sleep), /still busy/)
  assert.equal(calls, 5)
})

test("a signed-out provider says where to sign in", () => {
  assert.equal(describeRpcError(new RpcError("AUTH_REQUIRED:claude", "failed", false, 500)), "Sign in to Claude in Frizz first.")
  assert.equal(describeRpcError(new RpcError("AUTH_REQUIRED:codex", "failed", false, 500)), "Sign in to Codex in Frizz first.")
  assert.equal(describeRpcError(new Error("something else")), "something else")
})

test("a new thread takes the saved backend, model and effort — filled the way the page's prompt box fills them", () => {
  assert.deepEqual(dispatchProfile({ backend: "codex", claude: { model: "opus" }, codex: { model: "gpt-5.6", effort: "xhigh" } }), { backend: "codex", model: "gpt-5.6", effort: "xhigh" })
  assert.deepEqual(dispatchProfile({ backend: "claude", claude: {}, codex: {} }), { backend: "claude", model: "opus", effort: "high" })
  assert.deepEqual(dispatchProfile({ backend: "claude", claude: { model: "sonnet", effort: "low" }, codex: {} }), { backend: "claude", model: "sonnet", effort: "low" })
  assert.deepEqual(dispatchProfile({ backend: "codex", claude: {}, codex: {} }), { backend: "codex" })
  assert.deepEqual(dispatchProfile({ backend: "acp", claude: {}, codex: {}, acp: { model: "gemini", effort: "high" } }), { backend: "acp", model: "gemini" })
  assert.deepEqual(dispatchProfile({ backend: "acp", claude: {}, codex: {} }), { backend: "acp" })
})
