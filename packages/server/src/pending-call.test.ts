// What a quiet child is still running, read off its transcript's tail. Every fixture is shaped from the
// real bytes of the three children read dead on 2026-09-29 (session 054bee45): the Bash tool_use, then
// the two PreToolUse hook attachments the harness writes before the call starts, then nothing.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PENDING_CALL_GRACE_MS, pendingBoundedCalls, pendingCallsOf, transcriptQuietPast } from "./pending-call.ts"

const T0 = "2026-09-29T23:11:46.478Z"
const STALE = 15 * 60_000

const prompt = (text: string) => ({ type: "user", timestamp: "2026-09-29T22:00:00.000Z", message: { role: "user", content: text } })
const call = (id: string, input: object, msg = "msg_1", name = "Bash", at = T0) =>
  ({ type: "assistant", timestamp: at, message: { id: msg, role: "assistant", content: [{ type: "tool_use", id, name, input }] } })
const thinking = (msg: string, at = T0) => ({ type: "assistant", timestamp: at, message: { id: msg, role: "assistant", content: [{ type: "thinking", thinking: "…" }] } })
const hook = (at = "2026-09-29T23:11:46.530Z") => ({ type: "attachment", timestamp: at, attachment: { type: "hook_success", hookName: "PreToolUse:Bash" } })
const result = (id: string, at = "2026-09-29T23:32:48.000Z") => ({ type: "user", timestamp: at, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } })
const lines = (...recs: object[]) => recs.map((r) => JSON.stringify(r)).join("\n") + "\n"

test("the observed shape: a Bash call behind its two hook records is pending, with its declared timeout", () => {
  const tail = lines(prompt("go"), thinking("msg_1"), call("toolu_A", { command: "run-aq.sh", timeout: 6_000_000 }), hook(), hook())
  assert.deepEqual(pendingCallsOf(tail), [{ startedMs: Date.parse(T0), boundMs: 6_000_000 }])
})

test("an ANSWERED call is not pending, and neither is the thinking that follows it", () => {
  const tail = lines(call("toolu_A", { command: "x", timeout: 6_000_000 }), hook(), result("toolu_A"), hook(), thinking("msg_2", "2026-09-29T23:32:50.000Z"))
  assert.deepEqual(pendingCallsOf(tail), [])
})

test("parallel calls: the one still out counts, the one that returned does not", () => {
  const tail = lines(
    call("toolu_A", { command: "fast", timeout: 1_800_000 }),
    call("toolu_B", { command: "slow", timeout: 2_400_000 }),
    hook(), hook(),
    result("toolu_A"),
  )
  assert.deepEqual(pendingCallsOf(tail), [{ startedMs: Date.parse(T0), boundMs: 2_400_000 }])
})

test("a call with no timeout gets the harness default; one past the 24h ceiling is clamped to it", () => {
  assert.deepEqual(pendingCallsOf(lines(call("toolu_A", { command: "x" }))), [{ startedMs: Date.parse(T0), boundMs: 120_000 }])
  assert.deepEqual(pendingCallsOf(lines(call("toolu_A", { command: "x", timeout: 1e12 }))), [{ startedMs: Date.parse(T0), boundMs: 24 * 60 * 60_000 }])
  assert.deepEqual(pendingCallsOf(lines(call("toolu_A", { command: "x", timeout: 3_600_000 }, "msg_1", "PowerShell"))), [{ startedMs: Date.parse(T0), boundMs: 3_600_000 }])
})

test("only a DECLARED bound stretches anything: MCP calls, Agent calls and background launches do not", () => {
  assert.deepEqual(pendingCallsOf(lines(call("toolu_A", { url: "x" }, "msg_1", "mcp__chrome-devtools__navigate_page"))), [])
  assert.deepEqual(pendingCallsOf(lines(call("toolu_A", { prompt: "x" }, "msg_1", "Agent"))), [])
  assert.deepEqual(pendingCallsOf(lines(call("toolu_A", { command: "vite", run_in_background: true, timeout: 86_400_000 }))), [])
})

test("a call left unanswered by an EARLIER response stretches nothing now", () => {
  // A crash or an interrupt can strand a tool_use; the child then carried on. Only the latest response counts.
  const tail = lines(call("toolu_OLD", { command: "x", timeout: 86_400_000 }, "msg_1"), prompt("carry on"), thinking("msg_2", "2026-09-29T23:40:00.000Z"))
  assert.deepEqual(pendingCallsOf(tail), [])
  const behindResult = lines(call("toolu_OLD", { command: "x", timeout: 86_400_000 }, "msg_1"), result("toolu_X"), call("toolu_NEW", { command: "y", timeout: 60_000 }, "msg_2"))
  assert.deepEqual(pendingCallsOf(behindResult), [{ startedMs: Date.parse(T0), boundMs: 60_000 }])
})

test("transcriptQuietPast: the 15m floor, the declared bound + grace, and awake time", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-pending-"))
  try {
    const path = join(dir, "agent-a.jsonl")
    writeFileSync(path, lines(prompt("go"), call("toolu_A", { command: "x", timeout: 40 * 60_000 }), hook(), hook()))
    const start = Date.parse(T0)
    const last = start + 52 // the hook records' write
    assert.equal(transcriptQuietPast(path, last, start + 20 * 60_000, STALE), false, "20m into a 40m call: alive")
    assert.equal(transcriptQuietPast(path, last, start + 40 * 60_000 + PENDING_CALL_GRACE_MS - 1000, STALE), false, "inside the grace")
    assert.equal(transcriptQuietPast(path, last, start + 40 * 60_000 + PENDING_CALL_GRACE_MS + 1000, STALE), true, "past bound + grace: stale")
    // 70 wall minutes, 50 of them asleep: 20 awake minutes into the call, so still alive.
    const asleep = (from: number, to: number) => Math.max(0, to - from - 50 * 60_000)
    assert.equal(transcriptQuietPast(path, last, start + 70 * 60_000, STALE, asleep), false, "host sleep is not silence")

    // The result lands: the ordinary rule is back, and the cache keyed on the file sees the append.
    appendFileSync(path, lines(result("toolu_A", "2026-09-29T23:40:00.000Z")))
    assert.deepEqual(pendingBoundedCalls(path), [])
    assert.equal(transcriptQuietPast(path, last, start + 20 * 60_000, STALE), true, "no pending call: 15m of quiet is stale")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
