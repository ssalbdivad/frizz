import { test } from "node:test"
import assert from "node:assert/strict"
import { DISPATCH_TASK_BANNER_MARKER, spinoffChildPrompt } from "@frizz/shared"
import { parseTranscript, projectCodexTranscript } from "./transcript.ts"
import { projectAcpTranscript } from "./backend/acp-transcript.ts"

// THE CHILD END OF A SPINOFF (2026-09-30): a spinoff child's opening turn is the human's instructions and
// the parent worker's brief, drawn as the thread's spinoff header — never one giant user bubble — and a
// parent's `spawn_thread` names the spinoff it fulfils, so the parent's chat can draw the spinoff card in
// its place.

const INSTRUCTIONS = "Evaluate whether the sub-agent addresses feature is worth keeping"
const BRIEF = "Context: addresses landed in c47844bd.\n\nRead packages/shared/src/thread-handle.ts first."
const HANDLE_PROMPT = spinoffChildPrompt({ parentSlug: "live-sub-agents", parentTitle: "Live sub-agents", parentHandle: "liveSubAgents", instructions: INSTRUCTIONS, brief: BRIEF })
const LINK_PROMPT = spinoffChildPrompt({ parentSlug: "live-sub-agents", parentTitle: "Live sub-agents", instructions: INSTRUCTIONS, brief: BRIEF })
const envelope = (task: string) => `Your scratchpad is \`.frizz/threads/sid/scratch.md\` — …${DISPATCH_TASK_BANNER_MARKER}${task}`
const ORIGIN = { instructions: INSTRUCTIONS, brief: BRIEF }
const AT = "2026-09-30T03:44:00.000Z"

const userRecord = (content: string, ts = AT) => JSON.stringify({ type: "user", timestamp: ts, message: { role: "user", content } })
const enqueueRecord = (content: string) => JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: AT, content })
const assistantText = (text: string, id = "m1") => JSON.stringify({ type: "assistant", timestamp: AT, message: { id, role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] } })
const spawnCall = (id: string, input: Record<string, unknown>, name = "mcp__frizz__spawn_thread") =>
  JSON.stringify({ type: "assistant", timestamp: AT, message: { id: `m-${id}`, role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }] } })

test("a spinoff child's opening turn projects into its origin under both parent spellings and every Claude record shape", () => {
  for (const prompt of [HANDLE_PROMPT, LINK_PROMPT]) {
    // The spawned-CLI runtime writes a plain user record, the broker a queue-operation enqueue.
    for (const record of [userRecord(envelope(prompt)), enqueueRecord(envelope(prompt))]) {
      const [first] = parseTranscript(record)
      assert.deepEqual(first.spinoffOrigin, ORIGIN)
      assert.equal(first.displayText, INSTRUCTIONS, "the request every reader quotes is what the human asked")
      assert.equal(first.text, envelope(prompt), "the stored text is never narrowed")
    }
  }
})

test("only the OPENING turn is a spinoff origin, and an ordinary opening turn is untouched", () => {
  const msgs = parseTranscript([userRecord(envelope("Fix the flaky resolver test")), assistantText("ok"), userRecord(HANDLE_PROMPT, "2026-09-30T03:45:00.000Z")].join("\n"))
  const users = msgs.filter((m) => m.role === "user")
  assert.equal(users[0].displayText, "Fix the flaky resolver test")
  assert.equal(users[0].spinoffOrigin, undefined)
  assert.equal(users[1].spinoffOrigin, undefined, "a human who pastes the framing later is just talking")
})

test("a spawn_thread call carries the spinoff it fulfils, under either spelling; any other call carries none", () => {
  const msgs = parseTranscript([
    userRecord(envelope("go")),
    spawnCall("toolu_1", { prompt: "brief", model: "opus", effort: "high", spinoff: "spn_989f6d00ec353453" }),
    spawnCall("toolu_2", { prompt: "brief", model: "opus", effort: "high", spinOff: "spn_00000000000000aa" }),
    spawnCall("toolu_3", { prompt: "plain", model: "opus", effort: "high" }),
    spawnCall("toolu_4", { command: "echo spn_989f6d00ec353453", spinoff: "spn_989f6d00ec353453" }, "Bash"),
  ].join("\n"))
  const calls = msgs.flatMap((m) => m.tools)
  assert.deepEqual(calls.map((c) => c.spinoff), ["spn_989f6d00ec353453", "spn_00000000000000aa", undefined, undefined])
})

test("Codex: the opening turn projects its origin and an MCP spawn_thread call carries its spinoff", () => {
  const line = (payload: Record<string, unknown>, type = "event_msg") => JSON.stringify({ timestamp: AT, type, payload })
  const msgs = projectCodexTranscript([
    line({ type: "user_message", message: envelope(HANDLE_PROMPT) }),
    line({ type: "function_call", call_id: "call_1", name: "mcp__frizz__spawn_thread", arguments: JSON.stringify({ prompt: "brief", model: "gpt-5.6-sol", effort: "high", spinoff: "spn_0123456789abcdef" }) }, "response_item"),
    line({ type: "function_call", call_id: "call_2", name: "mcp__frizz__spawn_thread", arguments: JSON.stringify({ prompt: "plain", model: "gpt-5.6-sol", effort: "high" }) }, "response_item"),
  ].join("\n"))
  const first = msgs.find((m) => m.role === "user")!
  assert.deepEqual(first.spinoffOrigin, ORIGIN)
  assert.equal(first.displayText, INSTRUCTIONS)
  assert.deepEqual(msgs.flatMap((m) => m.tools).map((c) => c.spinoff), ["spn_0123456789abcdef", undefined])
})

test("ACP: the opening turn projects its origin, a later one does not, and spawn_thread carries its spinoff under the agent's own title", () => {
  const records = [
    { kind: "user-message", at: AT, text: HANDLE_PROMPT, synthetic: false },
    { kind: "turn-start", at: AT },
    // opencode titles an MCP tool `<server>_<tool>`; its input may only arrive on the completing update.
    { kind: "tool-call", at: AT, id: "c1", name: "frizz_spawn_thread", input: { prompt: "b", model: "m", effort: "high", spinoff: "spn_0123456789abcdef" } },
    { kind: "tool-call", at: AT, id: "c2", name: "frizz_spawn_thread", input: {} },
    { kind: "tool-result", at: AT, id: "c2", text: "Spawned a new frizz thread `x`.", acp: { input: { prompt: "b", spinoff: "spn_00000000000000aa" } } },
    { kind: "turn-end", at: AT, finalText: "", successful: true },
    { kind: "user-message", at: AT, text: HANDLE_PROMPT, synthetic: false },
  ]
  const msgs = projectAcpTranscript(records.map((r) => JSON.stringify(r)).join("\n"))
  const users = msgs.filter((m) => m.role === "user")
  assert.deepEqual(users[0].spinoffOrigin, ORIGIN)
  assert.equal(users[0].displayText, INSTRUCTIONS)
  assert.equal(users[1].spinoffOrigin, undefined)
  assert.deepEqual(msgs.flatMap((m) => m.tools).map((c) => c.spinoff), ["spn_0123456789abcdef", "spn_00000000000000aa"])
})
