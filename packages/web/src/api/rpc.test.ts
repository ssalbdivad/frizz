import { test } from "node:test"
import assert from "node:assert/strict"
import { assertMutationAllowedDuringControlPlaneTransition, CONTROL_PLANE_RESTARTING_MESSAGE, isKeptDeliveryError, isRetryableRpcError, parseRpcResponse } from "./rpc.ts"
import { store } from "../store.ts"

test("RPC response: a stale server's plain-text missing route asks for a server restart", async () => {
  await assert.rejects(
    parseRpcResponse(new Response("404 Not Found", { status: 404 }), "setThreadPermission"),
    /Frizz server restart required/,
  )
})

test("RPC transition guard holds writes locally while preserving query access", () => {
  const previous = store.controlPlaneState
  try {
    store.controlPlaneState = "restarting"
    assert.throws(
      () => assertMutationAllowedDuringControlPlaneTransition("mutation"),
      new RegExp(CONTROL_PLANE_RESTARTING_MESSAGE),
    )
    assert.doesNotThrow(() => assertMutationAllowedDuringControlPlaneTransition("query"))
  } finally {
    store.controlPlaneState = previous
  }
})

test("RPC response: valid server errors and successful envelopes keep their normal semantics", async () => {
  await assert.rejects(
    parseRpcResponse(new Response(JSON.stringify({ error: "specific failure" }), { status: 500 }), "x"),
    /specific failure/,
  )
  assert.deepEqual(
    await parseRpcResponse(new Response(JSON.stringify({ result: { effect: "next-resume" } }), { status: 200 }), "x"),
    { effect: "next-resume" },
  )
})

// `kept`: the server holds a failed follow-up as a failed bubble (server/src/router.ts
// keepFailedFollowUp). It rides beside `retryable`, and neither implies the other.
test("a kept follow-up failure is readable on the thrown error", async () => {
  const kept = await parseRpcResponse(new Response(JSON.stringify({ error: "cold resume failed", kept: true }), { status: 500 }), "followUp").then(() => null, (e: unknown) => e)
  assert.equal(isKeptDeliveryError(kept), true)
  assert.equal(isRetryableRpcError(kept), false)
  assert.equal((kept as Error).message, "cold resume failed")
  const plain = await parseRpcResponse(new Response(JSON.stringify({ error: "stale tab" }), { status: 500 }), "followUp").then(() => null, (e: unknown) => e)
  assert.equal(isKeptDeliveryError(plain), false)
})
