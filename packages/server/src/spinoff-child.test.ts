import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { DISPATCH_TASK_BANNER_MARKER, spinoffChildPrompt } from "@frizz/shared"
import { parseTranscript, projectCodexTranscript, readLatestThreadTranscriptPage, readThreadTranscript, withSpinoffChildOrigin } from "./transcript.ts"
import { projectAcpTranscript } from "./backend/acp-transcript.ts"
import { parseClaudeLine } from "./backend/claude.ts"
import { createSpinoffEdgeRecovery } from "./spinoff-edge-recovery.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import type { Project } from "./project.ts"

// THE CHILD END OF A SPINOFF (2026-09-30): a spinoff child's opening turn is the human's instructions and
// the parent worker's brief, drawn as the thread's spinoff header — never one giant user bubble — and a
// parent's `spawn_thread` names the spinoff it fulfils, so the parent's chat can draw the spinoff card in
// its place. Plus the recovery of an edge an old MCP server never sent, and the header for the child it
// leaves behind.

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
const spawnResult = (id: string, slug: string) =>
  JSON.stringify({ type: "user", timestamp: AT, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: `Spawned a new frizz thread \`${slug}\`. It is now on the board driving independently.` }] }] } })

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

// ---- the spinoff row, for the legacy child and the recovery ------------------------------------------

function sessionRow(slug: string, over: Partial<SessionRow> = {}): SessionRow {
  return { slug, session_id: `sid-${slug}`, thread_name: `frizz-${slug}`, spawned_at: "2026-09-30T03:44:27.775Z", last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: slug, state: "open", meta: null, seen_at: null, transcript_id: null, ...over }
}

function storageHarness() {
  const dir = mkdtempSync(join(tmpdir(), "frizz-spinoff-child-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  return { dir, storage, done: () => { storage.close(); rmSync(dir, { recursive: true, force: true }) } }
}

// A child the recovery below stamps opened on the parent's RAW brief — no framing to read back — so its
// header comes from the spinoff row: the human's instructions from the row, the opening turn as context.
test("a spinoff child whose prompt predates the framing still opens on its spinoff header, and nothing else does", () => {
  const h = storageHarness()
  try {
    h.storage.insertSpinoff({ id: "spn_989f6d00ec353453", parentSlug: "parent", instructions: INSTRUCTIONS, createdAtMs: 1 })
    h.storage.completeSpinoff("spn_989f6d00ec353453", "child", 2)
    const legacy = parseTranscript([userRecord(envelope(BRIEF)), assistantText("On it.")].join("\n"))
    const retained = legacy[0]

    const wrapped = withSpinoffChildOrigin(legacy, h.storage, "child", false)
    assert.deepEqual(wrapped[0].spinoffOrigin, ORIGIN)
    assert.equal(wrapped[0].displayText, INSTRUCTIONS)
    assert.equal(legacy[0], retained, "the retained projection is never mutated")
    assert.equal(retained.spinoffOrigin, undefined)

    // Not a spinoff child, or not its opening turn: left exactly as it is.
    assert.equal(withSpinoffChildOrigin(legacy, h.storage, "someone-else", false), legacy)
    const window = parseTranscript([userRecord("a later human turn"), assistantText("ok")].join("\n"))
    assert.equal(withSpinoffChildOrigin(window, h.storage, "child", false), window, "a latest window may start at a later turn")
    assert.deepEqual(withSpinoffChildOrigin(window, h.storage, "child", true)[0].spinoffOrigin?.brief, "a later human turn", "…but the whole projection's first turn IS the opening one")
    // A framed child already carries its own origin, which the row never overrides.
    const framed = parseTranscript(userRecord(envelope(HANDLE_PROMPT)))
    assert.equal(withSpinoffChildOrigin(framed, h.storage, "child", false), framed)
  } finally {
    h.done()
  }
})

// Through the readers themselves, which is where every seam (the paged RPC, the push, `read_thread`, the
// handoff) gets it. These resolve the real Claude log dir, so the test writes a throwaway one and removes it.
test("the transcript readers serve a legacy spinoff child with its header", () => {
  const h = storageHarness()
  const cwdSlug = `-tmp-frizz-spinoff-child-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  const logDir = join(homedir(), ".claude", "projects", cwdSlug)
  mkdirSync(logDir, { recursive: true })
  try {
    const project = { cwdSlug } as unknown as Project
    h.storage.upsertSession(sessionRow("child"))
    h.storage.insertSpinoff({ id: "spn_989f6d00ec353453", parentSlug: "parent", instructions: INSTRUCTIONS, createdAtMs: 1 })
    h.storage.completeSpinoff("spn_989f6d00ec353453", "child", 2)
    writeFileSync(join(logDir, "sid-child.jsonl"), [userRecord(envelope(BRIEF)), assistantText("On it.")].join("\n") + "\n")
    for (const messages of [readThreadTranscript(project, h.storage, "child"), readLatestThreadTranscriptPage(project, h.storage, "child").messages]) {
      assert.deepEqual(messages[0].spinoffOrigin, ORIGIN)
      assert.equal(messages[0].displayText, INSTRUCTIONS)
    }
  } finally {
    rmSync(logDir, { recursive: true, force: true })
    h.done()
  }
})

// ---- recovering the edge an old MCP server dropped --------------------------------------------------

function recoveryHarness(budgetBytes?: number) {
  const h = storageHarness()
  const paths = new Map<string, string>()
  const repaired: string[] = []
  const transcript = (slug: string, lines: string[]) => {
    const path = join(h.dir, `${slug}.jsonl`)
    paths.set(slug, path)
    writeFileSync(path, lines.map((l) => l + "\n").join(""))
    return path
  }
  const recovery = createSpinoffEdgeRecovery({
    storage: h.storage,
    transcriptOf: (slug) => (paths.has(slug) ? { path: paths.get(slug)!, parseLine: parseClaudeLine } : undefined),
    onRepaired: (row, child) => repaired.push(`${row.id}->${child}`),
    ...(budgetBytes ? { budgetBytes } : {}),
  })
  return { ...h, transcript, recovery, repaired }
}

const REQUEST_AT = Date.parse("2026-09-30T03:44:03.977Z")

// The observed failure, in the maintainer's own ids: the parent's MCP server predated `spinoff`, so the
// dispatch took the plain path and the row stayed pending with the child on the board.
test("a pending spinoff is stamped from its parent's transcript, once, and only from that evidence", () => {
  const h = recoveryHarness()
  try {
    const child = "evaluate-whether-the-sub-agent-addresses-featur"
    for (const slug of ["live-sub-agents", child, "other-parent", "stamped-child", "other-child"]) h.storage.upsertSession(sessionRow(slug))
    h.storage.insertSpinoff({ id: "spn_989f6d00ec353453", parentSlug: "live-sub-agents", instructions: INSTRUCTIONS, createdAtMs: REQUEST_AT })
    // A row of ANOTHER parent, named by this parent's call: never stamped from the wrong transcript.
    h.storage.insertSpinoff({ id: "spn_00000000000000aa", parentSlug: "other-parent", instructions: "x", createdAtMs: REQUEST_AT })
    // A row already stamped: never overwritten.
    h.storage.insertSpinoff({ id: "spn_00000000000000bb", parentSlug: "live-sub-agents", instructions: "y", createdAtMs: REQUEST_AT })
    h.storage.completeSpinoff("spn_00000000000000bb", "stamped-child", REQUEST_AT + 1)
    h.transcript("live-sub-agents", [
      userRecord(envelope("the parent's own task")),
      spawnCall("toolu_a", { prompt: "brief", model: "opus", effort: "high", spinoff: "spn_00000000000000aa" }),
      spawnResult("toolu_a", "other-child"),
      spawnCall("toolu_b", { prompt: "brief", model: "opus", effort: "high", spinoff: "spn_00000000000000bb" }),
      spawnResult("toolu_b", "other-child"),
      spawnCall("toolu_c", { prompt: "brief", model: "opus", effort: "high", title: "Sub-agent addresses", spinoff: "spn_989f6d00ec353453" }),
      spawnResult("toolu_c", child),
    ])

    assert.equal(h.recovery.sweep(), false)
    assert.equal(h.storage.getSpinoff("spn_989f6d00ec353453")?.child_slug, child)
    assert.equal(h.storage.getSpinoff("spn_989f6d00ec353453")?.spawned_at, Date.parse("2026-09-30T03:44:27.775Z"), "stamped at the child's own spawn")
    assert.equal(h.storage.getSpinoff("spn_00000000000000aa")?.child_slug, null)
    assert.equal(h.storage.getSpinoff("spn_00000000000000bb")?.child_slug, "stamped-child")
    assert.deepEqual(h.repaired, [`spn_989f6d00ec353453->${child}`])
    h.recovery.sweep()
    assert.equal(h.repaired.length, 1)
  } finally {
    h.done()
  }
})

test("a spawn result is not an edge unless it names a real thread spawned after the request, that is no other spinoff's child", () => {
  const h = recoveryHarness()
  try {
    h.storage.upsertSession(sessionRow("parent"))
    h.storage.upsertSession(sessionRow("older", { spawned_at: "2026-09-29T00:00:00.000Z" }))
    h.storage.upsertSession(sessionRow("taken"))
    h.storage.insertSpinoff({ id: "spn_00000000000000c1", parentSlug: "parent", instructions: "a", createdAtMs: REQUEST_AT })
    h.storage.insertSpinoff({ id: "spn_00000000000000c2", parentSlug: "parent", instructions: "b", createdAtMs: REQUEST_AT })
    h.storage.insertSpinoff({ id: "spn_00000000000000c3", parentSlug: "parent", instructions: "c", createdAtMs: REQUEST_AT })
    h.storage.insertSpinoff({ id: "spn_00000000000000c4", parentSlug: "elsewhere", instructions: "d", createdAtMs: REQUEST_AT })
    h.storage.completeSpinoff("spn_00000000000000c4", "taken", REQUEST_AT + 1)
    h.transcript("parent", [
      spawnCall("t1", { prompt: "p", spinoff: "spn_00000000000000c1" }), spawnResult("t1", "no-such-thread"),
      spawnCall("t2", { prompt: "p", spinoff: "spn_00000000000000c2" }), spawnResult("t2", "older"),
      spawnCall("t3", { prompt: "p", spinoff: "spn_00000000000000c3" }), spawnResult("t3", "taken"),
    ])
    h.recovery.sweep()
    assert.deepEqual(["c1", "c2", "c3"].map((n) => h.storage.getSpinoff(`spn_00000000000000${n}`)?.child_slug), [null, null, null])
    assert.deepEqual(h.repaired, [])
  } finally {
    h.done()
  }
})

// Live: the call lands on one tick and its result on a later one; a sweep for other threads' growth does
// not re-read a parent that is caught up, and one naming the parent reads only what was appended.
test("a live parent is read incrementally as its transcript grows", () => {
  const h = recoveryHarness()
  try {
    h.storage.upsertSession(sessionRow("parent"))
    h.storage.upsertSession(sessionRow("child"))
    h.storage.insertSpinoff({ id: "spn_00000000000000d1", parentSlug: "parent", instructions: "a", createdAtMs: REQUEST_AT })
    const path = h.transcript("parent", [userRecord("the request"), spawnCall("t1", { prompt: "p", spinoff: "spn_00000000000000d1" })])
    assert.equal(h.recovery.sweep(["parent"]), false)
    appendFileSync(path, spawnResult("t1", "child") + "\n")
    h.recovery.sweep(["somebody-else"])
    assert.equal(h.storage.getSpinoff("spn_00000000000000d1")?.child_slug, null, "a caught-up parent that did not grow is not re-read")
    h.recovery.sweep(["parent"])
    assert.equal(h.storage.getSpinoff("spn_00000000000000d1")?.child_slug, "child")
  } finally {
    h.done()
  }
})

// At boot the whole history of a parent is read, in budgeted slices that the caller re-arms until done —
// the repair of a row an earlier server left pending, with no manual database edit.
test("a restarted server repairs a historical row across budgeted sweeps", () => {
  const h = recoveryHarness(4096)
  try {
    h.storage.upsertSession(sessionRow("parent"))
    h.storage.upsertSession(sessionRow("child"))
    h.storage.insertSpinoff({ id: "spn_00000000000000e1", parentSlug: "parent", instructions: "a", createdAtMs: REQUEST_AT })
    const filler = Array.from({ length: 200 }, (_, i) => assistantText(`narration ${i} `.repeat(4), `m${i}`))
    h.transcript("parent", [...filler, spawnCall("t1", { prompt: "p", spinoff: "spn_00000000000000e1" }), ...filler, spawnResult("t1", "child")])
    let sweeps = 1
    while (h.recovery.sweep()) sweeps++
    assert.ok(sweeps > 2, `the history took ${sweeps} sweeps`)
    assert.equal(h.storage.getSpinoff("spn_00000000000000e1")?.child_slug, "child")
  } finally {
    h.done()
  }
})

// ---- a forgotten child ------------------------------------------------------------------------------

// A FORGOTTEN CHILD TAKES ITS EDGE WITH IT (2026-09-30). forgetThread frees the slug, and the next thread
// slugified to it — the human re-dispatching the task by hand — used to inherit the dead child's edge:
// its opening turn was rewritten to the OLD request, with the human's own prompt folded away as context.
test("forgetting a spinoff child drops its edge, so the next thread under its slug is nobody's spinoff", () => {
  const h = recoveryHarness()
  try {
    h.storage.upsertSession(sessionRow("parent"))
    h.storage.upsertSession(sessionRow("investigate-perf"))
    h.storage.insertSpinoff({ id: "spn_00000000000000f1", parentSlug: "parent", instructions: "OLD INSTRUCTIONS", createdAtMs: REQUEST_AT })
    h.storage.completeSpinoff("spn_00000000000000f1", "investigate-perf", REQUEST_AT + 1)
    h.storage.forgetSession("investigate-perf")
    assert.equal(h.storage.spinoffOfChild("investigate-perf"), undefined)
    assert.equal(h.storage.getSpinoff("spn_00000000000000f1"), undefined, "deleted, not left pending for a re-stamp")
    assert.equal(h.storage.spinoffsBySlug().get("parent"), undefined)

    // The human dispatches the same task by hand; it slugifies to the freed slug.
    h.storage.upsertSession(sessionRow("investigate-perf", { session_id: "sid-new", spawned_at: "2026-09-30T05:00:00.000Z" }))
    const mine = parseTranscript([userRecord(envelope("My brand new unrelated request")), assistantText("ok")].join("\n"))
    assert.equal(withSpinoffChildOrigin(mine, h.storage, "investigate-perf", true), mine, "the human's own request stays theirs")

    // …and a GENUINE new spinoff under the reused slug is recovered, not refused as another spinoff's child.
    h.storage.insertSpinoff({ id: "spn_00000000000000f2", parentSlug: "parent", instructions: "new", createdAtMs: Date.parse("2026-09-30T04:59:00.000Z") })
    h.transcript("parent", [spawnCall("t1", { prompt: "p", spinoff: "spn_00000000000000f2" }), spawnResult("t1", "investigate-perf")])
    h.recovery.sweep()
    assert.equal(h.storage.getSpinoff("spn_00000000000000f2")?.child_slug, "investigate-perf")
  } finally {
    h.done()
  }
})

// …and the edge a forget left behind BEFORE that fix is swept the next time the database is opened; a
// live child's edge, and a still-pending request, are left exactly as they are.
test("opening storage drops a spinoff edge whose child was already forgotten", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-spinoff-child-"))
  try {
    const first = createStorage(join(dir, "ui.db"), "p")
    first.upsertSession(sessionRow("parent"))
    first.upsertSession(sessionRow("alive"))
    first.insertSpinoff({ id: "spn_00000000000000f3", parentSlug: "parent", instructions: "a", createdAtMs: REQUEST_AT })
    first.completeSpinoff("spn_00000000000000f3", "ghost", REQUEST_AT + 1) // a child with no row: forgotten
    first.insertSpinoff({ id: "spn_00000000000000f4", parentSlug: "parent", instructions: "b", createdAtMs: REQUEST_AT })
    first.completeSpinoff("spn_00000000000000f4", "alive", REQUEST_AT + 1)
    first.insertSpinoff({ id: "spn_00000000000000f5", parentSlug: "parent", instructions: "c", createdAtMs: REQUEST_AT })
    first.close()
    const reopened = createStorage(join(dir, "ui.db"), "p")
    try {
      assert.equal(reopened.getSpinoff("spn_00000000000000f3"), undefined)
      assert.equal(reopened.spinoffOfChild("ghost"), undefined)
      assert.equal(reopened.getSpinoff("spn_00000000000000f4")?.child_slug, "alive")
      assert.equal(reopened.getSpinoff("spn_00000000000000f5")?.child_slug, null)
    } finally {
      reopened.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- where a parent's first read starts ------------------------------------------------------------

// Every spinoff is pending from the request until its spawn, so a request made while the server runs
// used to have its parent's WHOLE history read from byte 0, 32 MB a tick. Announced as it is recorded,
// its parent is read from where the transcript stood: the proof is a decoy answer in the history, which a
// read from byte 0 would stamp first.
test("a request made while the server runs is read from where its parent's transcript stood, not from byte 0", () => {
  const h = recoveryHarness()
  try {
    for (const slug of ["parent", "decoy", "child"]) h.storage.upsertSession(sessionRow(slug))
    const id = "spn_00000000000000a1"
    const path = h.transcript("parent", [
      userRecord(envelope("the parent's own task")),
      spawnCall("t0", { prompt: "p", spinoff: id }), spawnResult("t0", "decoy"),
      ...Array.from({ length: 50 }, (_, i) => assistantText(`history ${i}`, `m${i}`)),
    ])
    h.storage.insertSpinoff({ id, parentSlug: "parent", instructions: "a", createdAtMs: REQUEST_AT })
    h.recovery.noteRequest("parent", id)
    appendFileSync(path, [userRecord("the request"), spawnCall("t1", { prompt: "p", spinoff: id }), spawnResult("t1", "child")].map((l) => l + "\n").join(""))
    h.recovery.sweep(["somebody-else"])
    assert.equal(h.storage.getSpinoff(id)?.child_slug, null, "a seeded parent is caught up until it grows")
    h.recovery.sweep(["parent"])
    assert.equal(h.storage.getSpinoff(id)?.child_slug, "child")
    assert.deepEqual(h.repaired, [`${id}->child`])
  } finally {
    h.done()
  }
})

// …but a parent with an OLDER request still pending — one an earlier server left, whose answer may be
// anywhere in the history — is still read whole, and a parent with no transcript yet is simply not seeded.
test("a new request never skips the history an older pending request on the same parent needs", () => {
  const h = recoveryHarness()
  try {
    for (const slug of ["parent", "old-child", "new-child", "fresh"]) h.storage.upsertSession(sessionRow(slug))
    const path = h.transcript("parent", [
      spawnCall("t0", { prompt: "p", spinoff: "spn_00000000000000b1" }), spawnResult("t0", "old-child"),
    ])
    h.storage.insertSpinoff({ id: "spn_00000000000000b1", parentSlug: "parent", instructions: "old", createdAtMs: REQUEST_AT })
    h.storage.insertSpinoff({ id: "spn_00000000000000b2", parentSlug: "parent", instructions: "new", createdAtMs: REQUEST_AT })
    h.recovery.noteRequest("parent", "spn_00000000000000b2")
    appendFileSync(path, [spawnCall("t1", { prompt: "p", spinoff: "spn_00000000000000b2" }), spawnResult("t1", "new-child")].map((l) => l + "\n").join(""))
    h.recovery.sweep(["parent"])
    assert.equal(h.storage.getSpinoff("spn_00000000000000b1")?.child_slug, "old-child")
    assert.equal(h.storage.getSpinoff("spn_00000000000000b2")?.child_slug, "new-child")

    h.storage.insertSpinoff({ id: "spn_00000000000000b3", parentSlug: "fresh", instructions: "x", createdAtMs: REQUEST_AT })
    h.recovery.noteRequest("fresh", "spn_00000000000000b3") // no transcript yet: nothing to seed, and no throw
    h.transcript("fresh", [spawnCall("t2", { prompt: "p", spinoff: "spn_00000000000000b3" }), spawnResult("t2", "child-of-fresh")])
    h.storage.upsertSession(sessionRow("child-of-fresh"))
    h.recovery.sweep(["fresh"])
    assert.equal(h.storage.getSpinoff("spn_00000000000000b3")?.child_slug, "child-of-fresh")
  } finally {
    h.done()
  }
})
