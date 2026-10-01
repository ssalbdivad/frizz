// CI-runnable protocol test for the Claude session broker + its client, driven by the FAKE claude CLI
// (no real claude, no network — fast and deterministic). Proves the broker↔client typed socket
// protocol, the permission round-trip over the socket, and — the reason the broker exists —
// reconnect with a PENDING permission re-delivered to a fresh client.
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID, createHash } from "node:crypto"
import { test } from "node:test"
import assert from "node:assert/strict"
import { runClaudeBroker } from "./claude-agent-broker.ts"
import { frizzIpcPath } from "./ipc-path.ts"
import { connectClaudeBroker, type ClaudeBrokerClient } from "./claude-broker-client.ts"
import { CLAUDE_INPUT_DROP_DIAGNOSTIC_PREFIX, type ClaudeDiagnostic, type ClaudePermissionRequest, type ClaudeQueryEvent } from "./claude-agent-sdk-protocol.ts"

const fakeCli = fileURLToPath(new URL("./claude-agent-sdk.fixtures/fake-claude-cli.mjs", import.meta.url))

// Short endpoint name (macOS unix sockets cap at ~104 bytes); frizzIpcPath spells it as a unix socket
// on POSIX and a named pipe on Windows, which has no filesystem sockets at all — binding one there
// fails `listen EACCES` and every test below then times out waiting for a broker that never listened.
function shortSocket(): string {
  return frizzIpcPath(`cbt-${createHash("sha256").update(randomUUID()).digest("hex").slice(0, 16)}`)
}

interface Captured { events: ClaudeQueryEvent[]; perms: { requestId: string; request: ClaudePermissionRequest }[]; hellos: string[]; diagnostics: ClaudeDiagnostic[] }
function clientWith(socketPath: string): { client: ClaudeBrokerClient; cap: Captured; waitPerm: (ms?: number) => Promise<{ requestId: string; request: ClaudePermissionRequest }>; waitEvent: (pred: (e: ClaudeQueryEvent) => boolean, ms?: number) => Promise<ClaudeQueryEvent> } {
  const cap: Captured = { events: [], perms: [], hellos: [], diagnostics: [] }
  const permWaiters: ((v: any) => void)[] = []
  const eventWaiters: { pred: (e: ClaudeQueryEvent) => boolean; resolve: (e: ClaudeQueryEvent) => void }[] = []
  const client = connectClaudeBroker(socketPath, {
    onHello: (sid) => cap.hellos.push(sid),
    onEvent: (e) => { cap.events.push(e); for (let i = eventWaiters.length - 1; i >= 0; i--) if (eventWaiters[i].pred(e)) { eventWaiters[i].resolve(e); eventWaiters.splice(i, 1) } },
    onPermissionRequest: (requestId, request) => { const p = { requestId, request }; cap.perms.push(p); const w = permWaiters.shift(); if (w) w(p) },
    onDiagnostic: (diagnostic) => cap.diagnostics.push(diagnostic),
  })
  return {
    client, cap,
    waitPerm: (ms = 5_000) => new Promise((res, rej) => { const p = cap.perms[0]; if (p) return res(p); const t = setTimeout(() => rej(new Error("waitPerm timeout")), ms); permWaiters.push((v) => { clearTimeout(t); res(v) }) }),
    waitEvent: (pred, ms = 5_000) => new Promise((res, rej) => { const e = cap.events.find(pred); if (e) return res(e); const t = setTimeout(() => rej(new Error("waitEvent timeout")), ms); eventWaiters.push({ pred, resolve: (e) => { clearTimeout(t); res(e) } }) }),
  }
}

function startBroker(scenario: string, extra: Partial<Parameters<typeof runClaudeBroker>[0]> = {}): { socketPath: string; close: () => Promise<void>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "cbroker-"))
  const exe = join(dir, `fake-claude--${scenario}.mjs`)
  copyFileSync(fakeCli, exe); chmodSync(exe, 0o700)
  const socketPath = shortSocket()
  const broker = runClaudeBroker({ socketPath, cwd: dir, sessionId: randomUUID(), executablePath: exe, permissionMode: "default", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }, ...extra })
  return { socketPath, close: async () => { await broker.close(); rmSync(dir, { recursive: true, force: true }) }, dir }
}

// The fake CLI writes one JSON record per line beside its executable; `session-title` rows are the
// `generate_session_title` control requests the broker issued.
function captureRows(dir: string): { kind: string; description?: string; persist?: boolean }[] {
  try {
    return readFileSync(join(dir, "capture.jsonl"), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
  } catch { return [] }
}
async function waitForRows(dir: string, predicate: (rows: ReturnType<typeof captureRows>) => boolean, ms = 5_000): Promise<ReturnType<typeof captureRows>> {
  const deadline = Date.now() + ms
  for (;;) {
    const rows = captureRows(dir)
    if (predicate(rows)) return rows
    if (Date.now() > deadline) return rows
    await new Promise((r) => setTimeout(r, 50))
  }
}

// The diagnostics log recorded a DROPPED input but never a RECEIVED one, and the drop line fires only
// when `handle.send` REJECTS. A send that never completes — an agent wedged before it drains stdin —
// left the file byte-identical to one where the frame never arrived at all, so the two were
// indistinguishable. That ambiguity is what stalled the 2026-07-31 investigation into a thread whose
// diagnostics held a single `started` line. Receipt is now recorded: ids and sizes ONLY, because the
// message text is the operator's content and must never be written to a diagnostics file.
test("the daemon records every input frame on receipt, without the message text", { timeout: 15_000 }, async () => {
  const sessionId = randomUUID()
  const logDir = mkdtempSync(join(tmpdir(), "cbroker-diag-"))
  const diagnosticLogPath = join(logDir, "diag.log")
  const b = startBroker("basic", { sessionId, diagnosticLogPath })
  const SECRET = "the Landlock people, and this text must never reach the diagnostics file"
  try {
    const c = clientWith(b.socketPath)
    await new Promise((r) => setTimeout(r, 300))
    const id = randomUUID()
    c.client.sendInput({ id, text: SECRET })
    await c.waitEvent((e) => e.kind === "result")

    const log = readFileSync(diagnosticLogPath, "utf8")
    const received = log.split("\n").filter(Boolean).map((l) => JSON.parse(l))
      .filter((r) => typeof r.diagnostic?.message === "string" && r.diagnostic.message.startsWith("input received:"))
    assert.equal(received.length, 1, "exactly one receipt line for one input frame")
    assert.match(received[0].diagnostic.message, new RegExp(`id=${id}\\b`), "the receipt names the input's id")
    assert.match(received[0].diagnostic.message, new RegExp(`chars=${SECRET.length}\\b`), "the receipt carries the size")
    assert.ok(!log.includes(SECRET), "the operator's prompt text is NEVER written to the diagnostics log")
    c.client.close()
  } finally {
    await b.close()
    rmSync(logDir, { recursive: true, force: true })
  }
})

// A refused input has to reach the ATTACHED CLIENT, not just the diagnostics file on disk. The `input`
// frame carries no reply by design, so this relay is the only channel by which the frizz server can
// ever learn that a message it recorded as delivered was in fact thrown away — and until 2026-08-05 the
// server's own handler discarded every diagnostic that was not a daemon crash, so the channel ran into
// a wall. Thread `are-taking-over-an-in-flight-epic` refused every input for over two hours and said
// nothing anywhere an operator would look. Both ends are pinned here: the daemon emits the shared
// prefix, and a live client receives it.
test("a refused input is relayed to the attached client, not just written to the diagnostics file", { timeout: 15_000 }, async () => {
  // `hold-inputs` never answers, so the first send's uuid stays outstanding and the second is refused
  // as a duplicate — the cheapest way to make `handle.send` reject over the real socket.
  const b = startBroker("hold-inputs")
  try {
    const c = clientWith(b.socketPath)
    await new Promise((r) => setTimeout(r, 300))
    const id = randomUUID()
    c.client.sendInput({ id, text: "the first send holds the uuid outstanding" })
    await new Promise((r) => setTimeout(r, 300))
    c.client.sendInput({ id, text: "the second send is refused" })
    const isDrop = (d: ClaudeDiagnostic): boolean => d.kind === "stderr" && d.message.startsWith(CLAUDE_INPUT_DROP_DIAGNOSTIC_PREFIX)
    for (let waited = 0; waited < 5_000 && !c.cap.diagnostics.some(isDrop); waited += 50) {
      await new Promise((r) => setTimeout(r, 50))
    }
    const drop = c.cap.diagnostics.find(isDrop)
    assert.ok(drop, "the client is told its message never reached the agent")
    assert.match(drop.kind === "stderr" ? drop.message : "", /already outstanding/, "the diagnostic names the refusal")
    c.client.close()
  } finally {
    await b.close()
  }
})

// The composer typeahead's data path, end to end over the REAL socket: client `list-skills` frame →
// daemon dispatch → handle (initialize commands ∩ init-frame skills) → `skills-result` frame → client
// promise. The fake CLI's initialize response carries "review" and "explore" AND the built-in stand-in
// "compact"; only the first two are named by its init frame's `skills`, so only those may cross back.
// Each one's SOURCE has to survive the socket too, including the undefined one — the client re-checks
// the value against the closed set, and a bug there would silently strip every label.
test("listSkills round-trips the harness's skill list over the broker socket", { timeout: 15_000 }, async () => {
  const b = startBroker("basic")
  try {
    const c = clientWith(b.socketPath)
    await c.waitEvent((e) => e.kind === "init")
    assert.deepEqual(await c.client.listSkills(), [
      { name: "review", description: "Review changes", source: "project" },
      { name: "explore", description: "Explore the repository (dynamic workflow)", source: undefined },
    ])
    c.client.close()
  } finally {
    await b.close()
  }
})

test("broker relays a typed permission request and forwards the decision", { timeout: 15_000 }, async () => {
  const b = startBroker("permission")
  try {
    const c = clientWith(b.socketPath)
    await new Promise((r) => setTimeout(r, 300))
    c.client.sendInput({ id: randomUUID(), text: "do the thing" })
    const perm = await c.waitPerm()
    assert.equal(perm.request.toolName, "Bash") // the fake CLI's permission scenario requests Bash
    assert.ok(typeof perm.requestId === "string")
    c.client.answerPermission(perm.requestId, { behavior: "allow" })
    const result = await c.waitEvent((e) => e.kind === "result")
    assert.equal(result.kind, "result")
    c.client.close()
  } finally { await b.close() }
})

test("a pending permission is re-delivered to a client that reconnects (the broker's reason to exist)", { timeout: 15_000 }, async () => {
  const b = startBroker("permission")
  try {
    const c1 = clientWith(b.socketPath)
    await new Promise((r) => setTimeout(r, 300))
    c1.client.sendInput({ id: randomUUID(), text: "do the thing" })
    const perm1 = await c1.waitPerm()
    assert.ok(perm1.requestId)
    // frizz "dies" mid-permission — drop the client WITHOUT answering.
    c1.client.close()
    await new Promise((r) => setTimeout(r, 300))
    // frizz "restarts" — a fresh client reconnects to the SAME live broker.
    const c2 = clientWith(b.socketPath)
    const helloAgain = await new Promise<boolean>((res) => { const t = setTimeout(() => res(false), 5_000); const iv = setInterval(() => { if (c2.cap.hellos.length) { clearInterval(iv); clearTimeout(t); res(true) } }, 50) })
    assert.ok(helloAgain, "reconnected client got a hello")
    const perm2 = await c2.waitPerm()
    assert.equal(perm2.requestId, perm1.requestId, "the SAME pending permission was re-delivered")
    c2.client.answerPermission(perm2.requestId, { behavior: "allow" })
    const result = await c2.waitEvent((e) => e.kind === "result")
    assert.equal(result.kind, "result", "the session continued after reconnect")
    c2.client.close()
  } finally { await b.close() }
})

// ─── The session title ────────────────────────────────────────────────────────────────────────────
// Claude Code titles a session by itself on the first user message — EXCEPT on the Agent-SDK
// transport with a SessionStart hook registered, which is exactly the broker's configuration (it
// always loads the cc-worker plugin). Bisected live against 2.1.220: a plugin carrying only a no-op
// SessionStart hook produces NO `ai-title` record, the same plugin with only PreToolUse/PostToolUse/
// PermissionRequest hooks titles normally. So the broker ASKS, and the board stops falling back to a
// truncation of the raw dispatch prompt.
test("the broker asks Claude to title the session from the first dispatch prompt", { timeout: 15_000 }, async () => {
  const b = startBroker("basic")
  try {
    const c = clientWith(b.socketPath)
    await new Promise((r) => setTimeout(r, 300))
    c.client.sendInput({ id: randomUUID(), text: "Fix the login button on mobile" })
    const rows = await waitForRows(b.dir, (r) => r.some((row) => row.kind === "session-title"))
    const titles = rows.filter((row) => row.kind === "session-title")
    assert.equal(titles.length, 1, "exactly one title request")
    assert.equal(titles[0].description, "Fix the login button on mobile", "titled from the dispatch prompt")
    assert.equal(titles[0].persist, true, "persisted — an unpersisted title never reaches the transcript frizz reads")
    c.client.close()
  } finally { await b.close() }
})

test("a follow-up never retitles the thread", { timeout: 15_000 }, async () => {
  const b = startBroker("basic")
  try {
    const c = clientWith(b.socketPath)
    await new Promise((r) => setTimeout(r, 300))
    c.client.sendInput({ id: randomUUID(), text: "first prompt" })
    await waitForRows(b.dir, (r) => r.some((row) => row.kind === "session-title"))
    c.client.sendInput({ id: randomUUID(), text: "and now something completely different" })
    await new Promise((r) => setTimeout(r, 600))
    const titles = captureRows(b.dir).filter((row) => row.kind === "session-title")
    assert.equal(titles.length, 1, "still exactly one title request")
    assert.equal(titles[0].description, "first prompt")
    c.client.close()
  } finally { await b.close() }
})

test("a resumed session keeps the title its transcript already carries", { timeout: 15_000 }, async () => {
  const b = startBroker("basic", { resume: true })
  try {
    const c = clientWith(b.socketPath)
    await new Promise((r) => setTimeout(r, 300))
    c.client.sendInput({ id: randomUUID(), text: "carry on where we left off" })
    await new Promise((r) => setTimeout(r, 600))
    assert.equal(captureRows(b.dir).filter((row) => row.kind === "session-title").length, 0, "no title request on resume")
    c.client.close()
  } finally { await b.close() }
})

test("a failed title request neither throws nor stops the turn", { timeout: 15_000 }, async () => {
  const b = startBroker("title-failure")
  try {
    const c = clientWith(b.socketPath)
    await new Promise((r) => setTimeout(r, 300))
    c.client.sendInput({ id: randomUUID(), text: "do the thing" })
    const result = await c.waitEvent((e) => e.kind === "result")
    assert.equal(result.kind, "result", "the turn completed despite the title request failing")
    // The title request is deliberately NOT awaited by the turn, so it races the result event: under
    // load the turn can complete before the fake CLI has flushed its capture row. Wait for the row
    // instead of sampling it — the assertion is that the request happened, not that it happened first.
    const rows = await waitForRows(b.dir, (r) => r.some((row) => row.kind === "session-title"))
    assert.ok(rows.some((row) => row.kind === "session-title"), "the title request was made")
    c.client.close()
  } finally { await b.close() }
})

// A second interrupt behind a first one aborts the turn that first one opened — the turn reading the
// operator's message. Live on 2026-10-01: ⌘⏎ sent a follow-up and interrupted, a second ⌘⏎ on the
// now-empty box asked to "push the queue through", and the thread rested on two
// `[Request interrupted by user]` records with no reply. The daemon drops a push when nothing was sent
// since the last interrupt, and drops ANY interrupt while one is still in flight.
test("a queue push behind an interrupt that already freed the queue interrupts nothing", { timeout: 15_000 }, async () => {
  const b = startBroker("hold-inputs")
  const interrupts = () => captureRows(b.dir).filter((r) => r.kind === "host-control" && (r as { subtype?: string }).subtype === "interrupt").length
  try {
    const c = clientWith(b.socketPath)
    await new Promise((r) => setTimeout(r, 300))
    c.client.sendInput({ id: randomUUID(), text: "first" })
    c.client.interrupt()
    await waitForRows(b.dir, () => interrupts() === 1)
    c.client.interrupt({ ifQueued: true })
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(interrupts(), 1, "the push found nothing sent since the interrupt that opened the turn, so it must not abort it")
    c.client.sendInput({ id: randomUUID(), text: "second" })
    c.client.interrupt({ ifQueued: true })
    await waitForRows(b.dir, () => interrupts() === 2)
    assert.equal(interrupts(), 2, "a push with a genuinely new message queued still preempts")
    c.client.close()
  } finally {
    await b.close()
  }
})

test("an interrupt arriving while another is still in flight is dropped", { timeout: 15_000 }, async () => {
  const b = startBroker("hanging-control")
  const interrupts = () => captureRows(b.dir).filter((r) => r.kind === "host-control" && (r as { subtype?: string }).subtype === "interrupt").length
  try {
    const c = clientWith(b.socketPath)
    await new Promise((r) => setTimeout(r, 300))
    c.client.sendInput({ id: randomUUID(), text: "first" })
    c.client.interrupt()
    await waitForRows(b.dir, () => interrupts() === 1)
    c.client.sendInput({ id: randomUUID(), text: "second" })
    c.client.interrupt()
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(interrupts(), 1, "the first interrupt never answered, so the second must not reach the CLI")
    c.client.close()
  } finally {
    await b.close()
  }
})
