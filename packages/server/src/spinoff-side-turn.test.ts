import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { humanGapNote, spinoffRequestMessage, type ServerEvent, type TranscriptMessage } from "@frizz/shared"
import {
  claudeSideTurnSteps,
  hiddenSideTurnRest,
  normalizedSideTurnSteps,
  sideTurnHides,
  sideTurnRequestId,
  spawnStarted,
  stepSideTurn,
  type SideTurn,
  type SideTurnState,
  type SideTurnStep,
} from "./spinoff-side-turn.ts"
import { applyEvent, createTailer, newTailState, type SessionTelemetry } from "./tailer.ts"
import { registeredDoneFence } from "./board.ts"
import { createStorage, type SessionRow, type Storage } from "./storage.ts"
import { Bus } from "./bus.ts"
import type { Project } from "./project.ts"
import type { NormalizedEvent } from "./backend/types.ts"
import { decodeTailState, encodeTailState } from "./tail-cache.ts"
import { createTranscriptFold, parseCodexTranscript, parseTranscript } from "./transcript.ts"
import { resolveFrizzMcp } from "./dispatch.ts"
import { projectAcpTranscript } from "./backend/acp-transcript.ts"

// THE SPINOFF SIDE TURN (spinoff-side-turn.ts): a spinoff request that finds the worker at rest, answered
// with exactly one spawn_thread and nothing after it, is kept out of the thread — the chat drops the
// worker's side of it and the tailer presents the rest the request found. These pin the definition once,
// then each reader of it: the tailer's view and its rest effects, the tail cache, and the chat's Claude
// and Codex projections.

// ---- Claude records ------------------------------------------------------------------------------------

const ts = (n: number) => `2026-09-30T10:00:${String(n).padStart(2, "0")}.000Z`
const SPN = "spn_0123456789abcdef"
const SPN2 = "spn_fedcba9876543210"

const human = (n: number, text: string) =>
  JSON.stringify({ type: "user", timestamp: ts(n), uuid: `u${n}`, message: { role: "user", content: text } })
const request = (n: number, id = SPN) => human(n, spinoffRequestMessage({ id, instructions: "evaluate whether the idea holds up" }))
const say = (n: number, text: string, messageId = `msg_${n}`) =>
  JSON.stringify({ type: "assistant", timestamp: ts(n), uuid: `a${n}`, message: { id: messageId, role: "assistant", stop_reason: "end_turn", content: text ? [{ type: "text", text }] : [] } })
const call = (n: number, id: string, name: string, input: unknown) =>
  JSON.stringify({ type: "assistant", timestamp: ts(n), uuid: `a${n}`, message: { id: `msg_${n}`, role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }] } })
const result = (n: number, id: string, text: string, isError = false) =>
  JSON.stringify({ type: "user", timestamp: ts(n), uuid: `r${n}`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }], ...(isError ? { is_error: true } : {}) }] } })
const spawnCall = (n: number, id = SPN) =>
  call(n, `toolu_spawn_${n}`, "mcp__frizz__spawn_thread", { prompt: "the brief", model: "opus", effort: "high", spinoff: id })
// spawn_thread's own opening sentence (cc-worker/bin/frizz-mcp.mjs) — pinned against the real server below.
const started = (n: number, spawnedAt: number) => result(n, `toolu_spawn_${spawnedAt}`, "Spawned a new frizz thread `the-child`. The human's chat already shows this spinoff.")

const HANDOFF = "Fixed the cache bug.\n\n```done\nThe cache now invalidates on write.\n```"
// A finished thread: the human's task, the worker's registered `done` call, and its handoff.
const RESTED = [
  human(1, "fix the cache bug"),
  call(2, "toolu_done", "mcp__frizz__done", { summary: "fixed" }),
  result(3, "toolu_done", "Registered."),
  say(4, HANDOFF),
]

/** Every side turn a Claude transcript opened, and whether it is hidden. */
function sideTurnsOf(lines: string[]): { id: string; hidden: boolean }[] {
  const st: SideTurnState = { resting: false }
  const opened: SideTurn[] = []
  for (const line of lines) {
    for (const step of claudeSideTurnSteps(JSON.parse(line))) {
      const { opened: turn } = stepSideTurn(st, step)
      if (turn) opened.push(turn)
    }
  }
  return opened.map((t) => ({ id: t.id, hidden: sideTurnHides(t) }))
}

// ---- the definition ------------------------------------------------------------------------------------

test("side turn: a request at rest answered by one successful spawn and an end is hidden", () => {
  assert.deepEqual(sideTurnsOf([...RESTED, request(10), spawnCall(11), started(12, 11), say(13, "")]), [{ id: SPN, hidden: true }])
  // A sentence after the spawn is still the side turn's own (it is hidden with it): only CALLS count as work.
  assert.deepEqual(sideTurnsOf([...RESTED, request(10), spawnCall(11), started(12, 11), say(13, "Started it.")]), [{ id: SPN, hidden: true }])
  // Reading before the spawn is the brief being gathered.
  assert.deepEqual(
    sideTurnsOf([...RESTED, request(10), call(11, "toolu_read", "Read", { file_path: "/p/a.ts" }), result(12, "toolu_read", "…"), spawnCall(13), started(14, 13), say(15, "")]),
    [{ id: SPN, hidden: true }],
  )
})

test("side turn: a spawn that failed is never hidden — by its error flag or by the absence of success", () => {
  const failed = (text: string, isError: boolean) => sideTurnsOf([...RESTED, request(10), spawnCall(11), result(12, "toolu_spawn_11", text, isError), say(13, "The spawn failed.")])
  assert.deepEqual(failed("Spawned a new frizz thread `x`.", true), [{ id: SPN, hidden: false }], "an error result, whatever it says")
  assert.deepEqual(failed("spinoff spn_0123456789abcdef was requested from another thread", false), [{ id: SPN, hidden: false }], "no success sentence")
  // …and a turn that ended without ever calling it.
  assert.deepEqual(sideTurnsOf([...RESTED, request(10), say(11, "I would rather not.")]), [{ id: SPN, hidden: false }])
})

test("side turn: work after the spawn, or a write before it, makes it a real turn", () => {
  assert.deepEqual(
    sideTurnsOf([...RESTED, request(10), spawnCall(11), started(12, 11), call(13, "toolu_ls", "Bash", { command: "ls" }), result(14, "toolu_ls", "a.ts"), say(15, "Also looked around.")]),
    [{ id: SPN, hidden: false }],
  )
  assert.deepEqual(
    sideTurnsOf([...RESTED, request(10), call(11, "toolu_edit", "Edit", { file_path: "/p/a.ts" }), result(12, "toolu_edit", "ok"), spawnCall(13), started(14, 13), say(15, "")]),
    [{ id: SPN, hidden: false }],
    "an edit made on the side would vanish from the chat with the turn",
  )
  // A second spawn_thread — even for the same request — is more than was asked.
  assert.deepEqual(sideTurnsOf([...RESTED, request(10), spawnCall(11), started(12, 11), spawnCall(13), started(14, 13), say(15, "")]), [{ id: SPN, hidden: false }])
})

test("side turn: a request that arrives MID-TURN is part of that turn, never a side turn", () => {
  const queued = JSON.stringify({ type: "attachment", timestamp: ts(12), attachment: { type: "queued_command", prompt: spinoffRequestMessage({ id: SPN, instructions: "x" }) } })
  assert.deepEqual(sideTurnsOf([human(1, "go"), call(11, "toolu_ls", "Bash", { command: "ls" }), queued, result(13, "toolu_ls", "a"), spawnCall(14), started(15, 14), say(16, "")]), [])
  // Coalesced with the human's own words: the answer to those words would be hidden with it.
  assert.deepEqual(sideTurnsOf([...RESTED, human(10, `${spinoffRequestMessage({ id: SPN, instructions: "x" })}\n\nalso, the typo`)]), [])
})

test("side turn: anything else reaching the worker before the turn ends makes it the worker's turn", () => {
  // The runtime appends a message queued behind the spawn to the spawn's own result record.
  const resultWithMessage = JSON.stringify({ type: "user", timestamp: ts(12), message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "toolu_spawn_11", content: [{ type: "text", text: "Spawned a new frizz thread `c`." }] },
    { type: "text", text: "and fix the typo while you are there" },
  ] } })
  assert.deepEqual(sideTurnsOf([...RESTED, request(10), spawnCall(11), resultWithMessage, say(13, "Fixed the typo.")]), [{ id: SPN, hidden: false }])
  // A Stop hook sending the worker on after it rested: it speaks again with no prompt.
  assert.deepEqual(sideTurnsOf([...RESTED, request(10), spawnCall(11), started(12, 11), say(13, ""), say(14, "One more thing.", "msg_other")]), [{ id: SPN, hidden: false }])
  // …while a second record of the SAME message that ended the turn is still that rest.
  assert.deepEqual(sideTurnsOf([...RESTED, request(10), spawnCall(11), started(12, 11), say(13, "", "msg_end"), say(13, "Done.", "msg_end")]), [{ id: SPN, hidden: true }])
})

test("side turn: two requests in a row at rest are two side turns", () => {
  assert.deepEqual(
    sideTurnsOf([...RESTED, request(10), spawnCall(11), started(12, 11), say(13, ""), request(20, SPN2), spawnCall(21, SPN2), started(22, 21), say(23, "")]),
    [{ id: SPN, hidden: true }, { id: SPN2, hidden: true }],
  )
  // A spawn naming the OTHER request fulfils nothing here.
  assert.deepEqual(sideTurnsOf([...RESTED, request(10), spawnCall(11, SPN2), started(12, 11), say(13, "")]), [{ id: SPN, hidden: false }])
})

test("side turn: a request that reached the worker with a pre-2026-09-30 build's riders still reads as one", () => {
  const withGap = `${spinoffRequestMessage({ id: SPN, instructions: "x" })}\n\n${humanGapNote(Date.parse(ts(50)) + 3 * 3_600_000, ts(4))}`
  assert.equal(sideTurnRequestId(withGap), SPN)
  assert.equal(sideTurnRequestId(`see ${spinoffRequestMessage({ id: SPN, instructions: "x" })}`), undefined, "only a message that IS the request")
})

// Codex writes its bracket before the words (task_started, then user_message); ACP the other way round.
const cx = {
  start: (): NormalizedEvent => ({ kind: "turn-start", at: ts(10) }),
  user: (text: string, at = 10): NormalizedEvent => ({ kind: "user-message", at: ts(at), text, synthetic: false }),
  spawn: (id = SPN): NormalizedEvent => ({ kind: "tool-call", at: ts(11), id: "call_spawn", name: "mcp__frizz__spawn_thread", input: { prompt: "b", model: "gpt-5", effort: "high", spinoff: id } }),
  started: (): NormalizedEvent => ({ kind: "tool-result", at: ts(12), id: "call_spawn", text: "Spawned a new frizz thread `c`." }),
  end: (over: Partial<Extract<NormalizedEvent, { kind: "turn-end" }>> = { successful: true }): NormalizedEvent => ({ kind: "turn-end", at: ts(13), ...over }),
}
function normalizedSideTurns(events: NormalizedEvent[]): { id: string; hidden: boolean }[] {
  const st: SideTurnState = { resting: false }
  const opened: SideTurn[] = []
  for (const ev of events) for (const step of normalizedSideTurnSteps(ev)) {
    const { opened: turn } = stepSideTurn(st, step as SideTurnStep)
    if (turn) opened.push(turn)
  }
  return opened.map((t) => ({ id: t.id, hidden: sideTurnHides(t) }))
}
const cxRested: NormalizedEvent[] = [
  { kind: "turn-start", at: ts(1) }, { kind: "user-message", at: ts(1), text: "go", synthetic: false },
  { kind: "assistant-text", at: ts(2), text: "Done.", final: true }, { kind: "turn-end", at: ts(3), finalText: "Done.", successful: true },
]
const REQ = spinoffRequestMessage({ id: SPN, instructions: "x" })

test("side turn: Codex and ACP read it the same way, whichever order the bracket and the words arrive in", () => {
  assert.deepEqual(normalizedSideTurns([...cxRested, cx.start(), cx.user(REQ), cx.spawn(), cx.started(), cx.end()]), [{ id: SPN, hidden: true }], "Codex")
  assert.deepEqual(normalizedSideTurns([...cxRested, cx.user(REQ), cx.start(), cx.spawn(), cx.started(), cx.end()]), [{ id: SPN, hidden: true }], "ACP")
  // A turn the human STOPPED (no answer, no word of success) did not do what it was asked.
  assert.deepEqual(normalizedSideTurns([...cxRested, cx.start(), cx.user(REQ), cx.spawn(), cx.started(), cx.end({})]), [{ id: SPN, hidden: false }])
  // …but Codex's `turn_aborted` repeated after a successful `task_complete` is the same rest.
  assert.deepEqual(normalizedSideTurns([...cxRested, cx.start(), cx.user(REQ), cx.spawn(), cx.started(), cx.end(), cx.end({})]), [{ id: SPN, hidden: true }])
  // A child's report that lands inside the side turn may be answered there.
  assert.deepEqual(
    normalizedSideTurns([...cxRested, cx.start(), cx.user(REQ), { kind: "agent-report", at: ts(11), text: "child done" } as NormalizedEvent, cx.spawn(), cx.started(), cx.end()]),
    [{ id: SPN, hidden: false }],
  )
  // Mid-turn on Codex: the request is steered into a turn already running.
  assert.deepEqual(normalizedSideTurns([cx.start(), cx.user("go", 1), cx.user(REQ), cx.spawn(), cx.started(), cx.end()]), [])
})

// The success sentence is read out of the REAL spawn_thread's result, over its real stdio transport,
// against a real HTTP server standing in for Frizz's dispatch — so a rewording of that sentence fails
// here instead of silently turning every side turn back into a visible one.
test("side turn: spawnStarted reads the real spawn_thread result, success and refusal alike", async () => {
  let refuse = false
  const http = createServer((req, res) => {
    req.resume()
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(refuse ? { error: `spinoff ${SPN} was requested from another thread` } : { result: { slug: "the-child" } }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-side-turn-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port: (http.address() as { port: number }).port }))
  const descriptor = resolveFrizzMcp("/unused")
  assert.ok(descriptor)
  const child = spawn(process.execPath, [descriptor.scriptPath], {
    stdio: ["pipe", "pipe", "inherit"],
    cwd: mkdtempSync(join(tmpdir(), "frizz-side-turn-cwd-")),
    env: { ...process.env, FRIZZ_STATE_DIR: stateDir, FRIZZ_THREAD_SLUG: "the-parent" },
  })
  const waiting = new Map<number, (msg: { result: { isError?: boolean; content: { text: string }[] } }) => void>()
  let buf = ""
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    buf += chunk
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      const msg = JSON.parse(line)
      waiting.get(msg.id)?.(msg)
    }
  })
  const rpc = (id: number, method: string, params: unknown) => {
    const reply = new Promise<{ result: { isError?: boolean; content: { text: string }[] } }>((resolve) => waiting.set(id, resolve))
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
    return reply
  }
  const spawnThread = (id: number) => rpc(id, "tools/call", { name: "spawn_thread", arguments: { prompt: "the brief", model: "opus", effort: "high", spinoff: SPN } })
  try {
    await rpc(1, "initialize", {})
    const ok = (await spawnThread(2)).result
    assert.equal(spawnStarted(ok.content[0]!.text, ok.isError === true), true, ok.content[0]!.text)
    refuse = true
    const refused = (await spawnThread(3)).result
    assert.equal(refused.isError, true)
    assert.equal(spawnStarted(refused.content[0]!.text, refused.isError === true), false)
    // Codex and ACP carry no error flag: the text alone must still say no.
    assert.equal(spawnStarted(refused.content[0]!.text), false)
  } finally {
    child.kill()
    http.close()
  }
})

// ---- the tailer ----------------------------------------------------------------------------------------

interface Harness { storage: Storage; bus: Bus; events: ServerEvent[]; logDir: string; clock: { ms: number } }

function harness(): Harness {
  const logDir = join(mkdtempSync(join(tmpdir(), "frizz-side-turn-")), "-a-project")
  mkdirSync(logDir, { recursive: true })
  const storage = createStorage(join(logDir, "ui.db"), "p")
  const bus = new Bus()
  const events: ServerEvent[] = []
  bus.subscribe((e) => events.push(e))
  return { storage, bus, events, logDir, clock: { ms: Date.parse(ts(5)) } }
}

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug: "t", session_id: "sid", thread_name: "frizz-t", spawned_at: ts(0), last_read_at: null, unread: 0, exited: 0, archived: 0,
    rested_at: null, title_auto: 0, title: null, state: null, meta: null, seen_at: null, transcript_id: null, ...over,
  }
}

function tailerOf(h: Harness, over: Partial<Parameters<typeof createTailer>[0]> = {}) {
  return createTailer({
    project: { cwdSlug: "x" } as Project,
    storage: h.storage,
    bus: h.bus,
    onChange: () => {},
    now: () => h.clock.ms,
    paneDead: () => false,
    sessionLogDir: h.logDir,
    tailCache: null,
    ...over,
  })
}

const write = (h: Harness, lines: string[]) => writeFileSync(join(h.logDir, "sid.jsonl"), lines.map((l) => l + "\n").join(""))
const append = (h: Harness, lines: string[]) => appendFileSync(join(h.logDir, "sid.jsonl"), lines.map((l) => l + "\n").join(""))
const REST_FIELDS = ["lastFence", "lastAssistant", "lastAssistantAt", "lastAssistantAllDone", "pendingQuestion", "lastUserAt", "lastHumanAt", "lastToolCallAt", "lastUserText"] as const
const restOf = (tele: SessionTelemetry | undefined) => Object.fromEntries(REST_FIELDS.map((k) => [k, tele?.[k]]))
// The done the worker registered with its `mcp__frizz__done` call, as the board reads it.
const DONE = { body: "The cache now invalidates on write.", doneAt: Date.parse(ts(3)) }

test("tailer: a clean side turn leaves the thread's rest exactly as the request found it", () => {
  const h = harness()
  h.storage.upsertSession(row({ last_read_at: ts(5) })) // the human read the handoff
  write(h, RESTED)
  let turnDone = 0
  let activity = 0
  const t = tailerOf(h, { onTurnDone: () => void turnDone++, onTurnActivity: () => void activity++ })
  t.tick() // prime at rest
  const before = t.get("t")
  assert.equal(before?.turn, "idle")
  assert.ok(before?.lastFence, "precondition: the handoff carries a done fence")
  assert.ok(registeredDoneFence(DONE, before?.lastUserAt, before?.lastToolCallAt), "precondition: the registered done stands")
  const restedAt = h.storage.getSession("t")?.rested_at
  assert.equal(restedAt, ts(4))

  // The request arrives and the worker gathers its brief…
  append(h, [request(10), call(11, "toolu_read", "Read", { file_path: "/p/a.ts" })])
  h.clock.ms = Date.parse(ts(11)) + 500
  t.tick()
  assert.equal(t.get("t")?.turn, "in-flight", "while it runs, the thread IS running")
  assert.equal(activity, 0, "…but a side turn gathering its brief starts no working status")

  // …spawns, and ends.
  append(h, [result(12, "toolu_read", "…"), spawnCall(13), started(14, 13), say(15, "")])
  h.clock.ms = Date.parse(ts(15)) + 500
  t.tick()
  const after = t.get("t")
  assert.equal(after?.turn, "idle")
  assert.deepEqual(restOf(after), restOf(before), "fence, preview, rest time and every human/tool clock are the ones it rested on")
  assert.ok(registeredDoneFence(DONE, after?.lastUserAt, after?.lastToolCallAt), "the registered done still stands")
  // Negative control: the raw clocks the side turn moved WOULD have spent it.
  assert.equal(registeredDoneFence(DONE, ts(10), ts(13)), undefined)
  const stored = h.storage.getSession("t")
  assert.equal(stored?.rested_at, restedAt, "rested_at did not move")
  assert.equal(stored?.unread, 0, "nothing new to read")
  assert.equal(h.events.filter((e) => e.type === "notify").length, 0, "no turn-done notify")
  assert.equal(turnDone, 0, "and no turn-done hook (sign-off nudge, status writers)")

  // The human's next word proceeds as if the side turn had never happened: a prose answer keeps the
  // registered done standing, exactly as it would have without the spinoff.
  append(h, [human(20, "why that way?")])
  h.clock.ms = Date.parse(ts(20)) + 500
  t.tick()
  append(h, [say(21, "Because writes are rare.")])
  h.clock.ms = Date.parse(ts(21)) + 500
  t.tick()
  const next = t.get("t")
  assert.equal(next?.lastAssistantAt, ts(21))
  assert.ok(registeredDoneFence(DONE, next?.lastUserAt, next?.lastToolCallAt), "the side turn's spawn did not spend it later either")
  assert.equal(h.storage.getSession("t")?.rested_at, ts(21), "and a real turn rests as always")
  assert.equal(turnDone, 1)
})

test("tailer: an unclean side turn is an ordinary turn — its rest, its badge, its notify", () => {
  const h = harness()
  h.storage.upsertSession(row({ last_read_at: ts(5) }))
  write(h, RESTED)
  let turnDone = 0
  const t = tailerOf(h, { onTurnDone: () => void turnDone++ })
  t.tick()
  append(h, [request(10), spawnCall(11), started(12, 11), call(13, "toolu_ls", "Bash", { command: "ls" })])
  h.clock.ms = Date.parse(ts(13)) + 500
  t.tick()
  append(h, [result(14, "toolu_ls", "a.ts"), say(15, "Started it, and noticed a.ts is stale.")])
  h.clock.ms = Date.parse(ts(15)) + 500
  t.tick()
  const after = t.get("t")
  assert.equal(after?.lastAssistantAt, ts(15))
  assert.equal(after?.lastAssistant, "Started it, and noticed a.ts is stale.")
  assert.equal(after?.lastFence, undefined, "the worker's new words are the thread's news")
  assert.equal(registeredDoneFence(DONE, after?.lastUserAt, after?.lastToolCallAt), undefined, "and the work spent the done")
  assert.equal(h.storage.getSession("t")?.rested_at, ts(15))
  assert.equal(h.storage.getSession("t")?.unread, 1)
  assert.equal(h.events.filter((e) => e.type === "notify").length, 1)
  assert.equal(turnDone, 1)
})

test("tailer: a restart after a clean side turn primes the rest it put back, and re-priming is idempotent", () => {
  const h = harness()
  h.storage.upsertSession(row())
  h.storage.setRestedAt("t", ts(4)) // stamped live, before the bounce
  write(h, [...RESTED, request(10), spawnCall(11), started(12, 11), say(13, "")])
  for (const _boot of [1, 2]) {
    const t = tailerOf(h)
    t.tick()
    assert.equal(t.get("t")?.lastAssistantAt, ts(4))
    // The prime stamps forward only, so a side turn's end (ts 13) WOULD have landed here.
    assert.equal(h.storage.getSession("t")?.rested_at, ts(4))
  }
})

test("tailer: the side-turn reading survives the tail cache, mid-side-turn and from a cache that predates it", () => {
  const boot = (h: Harness, cache: boolean) => {
    const t = tailerOf(h, { now: () => Date.parse("2026-09-30T11:00:00.000Z"), paneDead: () => true, ...(cache ? { tailCache: undefined } : {}) })
    t.start()
    const tele = t.get("t")
    t.stop()
    return tele
  }
  const full = [...RESTED, request(10), spawnCall(11), started(12, 11), say(13, "")]

  // Seeded mid-side-turn, finished while the server was down.
  const h = harness()
  h.storage.upsertSession(row())
  write(h, full.slice(0, RESTED.length + 2))
  boot(h, true)
  append(h, full.slice(RESTED.length + 2))
  const warm = boot(h, true)
  assert.deepEqual(warm, boot(h, false), "a warm boot derives what a cold one does")
  assert.equal(warm?.lastAssistantAt, ts(4), "…which is the hidden side turn's rest")

  // Seeded at rest by a build with no side-turn reading at all: the state carries no `sideTurn`, and the
  // first request after the upgrade must still read as one that found the worker at rest.
  const old = harness()
  old.storage.upsertSession(row())
  write(old, RESTED)
  boot(old, true)
  const stored = old.storage.db.prepare<[], { state: string }>("SELECT state FROM tail_state").get()!
  const state = decodeTailState(stored.state)!
  assert.ok(state.sideTurn, "precondition: this build caches the reading")
  delete state.sideTurn
  old.storage.db.prepare("UPDATE tail_state SET state = ?").run(encodeTailState(state))
  append(old, full.slice(RESTED.length))
  assert.equal(boot(old, true)?.lastAssistantAt, ts(4))
})

test("tailer: a Codex side turn restores through applyEvent the same way", () => {
  const state = newTailState("t", "sid", "/p")
  const fence = "Done.\n\n```done\nShipped.\n```"
  for (const ev of [...cxRested.slice(0, 2), { kind: "assistant-text", at: ts(2), text: fence, final: true }, { kind: "turn-end", at: ts(3), finalText: fence, successful: true }] as NormalizedEvent[]) applyEvent(state, ev)
  const before = { lastFence: state.lastFence, lastAssistantAt: state.lastAssistantAt, lastUserAt: state.lastUserAt, lastUserText: state.lastUserText }
  assert.ok(before.lastFence)
  for (const ev of [cx.start(), cx.user(REQ), cx.spawn(), cx.started(), cx.end()]) applyEvent(state, ev)
  const rest = hiddenSideTurnRest(state)
  assert.ok(rest, "the side turn is hidden")
  assert.deepEqual({ lastFence: rest.lastFence, lastAssistantAt: rest.lastAssistantAt, lastUserAt: rest.lastUserAt, lastUserText: rest.lastUserText }, before)
  assert.equal(state.lastUserText, REQ, "the raw fold still knows the request was delivered")
})

// ---- the chat ------------------------------------------------------------------------------------------

const shape = (messages: TranscriptMessage[]) => messages.map((m) => m.boundary ? `—${m.boundary}` : `${m.role}${m.spinoff ? "(spinoff)" : ""}: ${m.displayText ?? m.text}${m.tools.length ? ` [${m.tools.map((c) => c.name).join(",")}]` : ""}`)

test("chat (Claude): a clean side turn drops the worker's side of it and keeps the request", () => {
  const baseline = shape(parseTranscript([...RESTED].join("\n")))
  const clean = [...RESTED, request(10), spawnCall(11), started(12, 11), say(13, "Started it.")]
  assert.deepEqual(shape(parseTranscript(clean.join("\n"))), [...baseline, "user(spinoff): evaluate whether the idea holds up"])

  // The incremental fold lands where the one-shot parse does, split mid-side-turn.
  const fold = createTranscriptFold()
  fold.ingest(clean.slice(0, RESTED.length + 2).map((l) => l + "\n").join(""))
  assert.ok(shape(fold.messages()).some((s) => s.includes("mcp__frizz__spawn_thread")), "mid-side-turn, the worker's call shows")
  fold.ingest(clean.slice(RESTED.length + 2).map((l) => l + "\n").join(""))
  fold.finalize()
  assert.deepEqual(shape(fold.messages()), shape(parseTranscript(clean.join("\n"))))

  // Unclean: every message stays.
  const unclean = [...RESTED, request(10), spawnCall(11), started(12, 11), call(13, "toolu_ls", "Bash", { command: "ls" }), result(14, "toolu_ls", "a"), say(15, "Also looked.")]
  const shown = shape(parseTranscript(unclean.join("\n")))
  assert.ok(shown.some((s) => s.includes("mcp__frizz__spawn_thread")) && shown.includes("assistant: Also looked."), shown.join("\n"))
})

const cxLine = (n: number, type: string, payload: Record<string, unknown>) => JSON.stringify({ timestamp: ts(n), type, payload })
const cxRollout = (sideTurn: string[]) => [
  cxLine(0, "session_meta", { id: "cx", cwd: "/p" }),
  cxLine(1, "event_msg", { type: "task_started", turn_id: "t1" }),
  cxLine(1, "event_msg", { type: "user_message", message: "fix the cache bug" }),
  cxLine(2, "event_msg", { type: "agent_message", message: HANDOFF, phase: "final_answer" }),
  cxLine(3, "event_msg", { type: "task_complete", turn_id: "t1", last_agent_message: HANDOFF, error: null }),
  ...sideTurn,
].join("\n")
const cxSide = (after: string[] = []) => [
  cxLine(10, "event_msg", { type: "task_started", turn_id: "t2" }),
  cxLine(10, "event_msg", { type: "user_message", message: REQ }),
  cxLine(11, "response_item", { type: "function_call", call_id: "call_spawn", name: "mcp__frizz__spawn_thread", arguments: JSON.stringify({ prompt: "b", model: "gpt-5", effort: "high", spinoff: SPN }) }),
  cxLine(12, "response_item", { type: "function_call_output", call_id: "call_spawn", output: "Spawned a new frizz thread `c`." }),
  ...after,
  cxLine(14, "event_msg", { type: "task_complete", turn_id: "t2", last_agent_message: null, error: null }),
]

test("chat (Codex): a clean side turn drops the worker's side of it and keeps the request", () => {
  const baseline = shape(parseCodexTranscript(cxRollout([])))
  assert.deepEqual(shape(parseCodexTranscript(cxRollout(cxSide()))), [...baseline, "user(spinoff): x"])
  const unclean = shape(parseCodexTranscript(cxRollout(cxSide([
    cxLine(13, "response_item", { type: "function_call", call_id: "call_ls", name: "exec_command", arguments: JSON.stringify({ cmd: "ls" }) }),
  ]))))
  assert.ok(unclean.length > baseline.length + 1, unclean.join("\n"))
})

test("chat (ACP): the drawer drops the side turn its tailer fold hides", () => {
  const acp = (events: NormalizedEvent[]) => projectAcpTranscript(events.map((e) => JSON.stringify(e)).join("\n"))
  const baseline = shape(acp(cxRested))
  // ACP's order: the words, then the bracket.
  const side = [cx.user(REQ), cx.start(), cx.spawn(), cx.started(), { kind: "assistant-text", at: ts(13), text: "Started.", final: true } as NormalizedEvent, cx.end()]
  assert.deepEqual(shape(acp([...cxRested, ...side])), [...baseline, `user: ${REQ}`], "the request stays; the worker's side goes")
  assert.ok(shape(acp([...cxRested, ...side.slice(0, -1), cx.end({})])).some((s) => s.includes("Started.")), "a stopped one stays")
})
