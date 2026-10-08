import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { createClaudeAgentBrokerBridge } from "./backend/claude-agent-broker-bridge.ts"
import { killBroker, liveBrokerRecords } from "./backend/claude-broker-host.ts"
import type { SessionRow } from "./storage.ts"
import {
  auditUnownedBrokersOnce,
  classifyUnownedBrokers,
  describeUnownedBroker,
  probeClaudeTranscript,
  UNOWNED_MIN_AGE_MS,
  type TranscriptReading,
} from "./unowned-brokers.ts"

const NOW = Date.parse("2026-10-08T23:10:00.000Z")
const born = (agoMs: number) => new Date(NOW - agoMs).toISOString()

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug: "what-does-this-mean-taking", session_id: "sess-live", backend: "claude", claude_runtime: "broker",
    state: "open", archived: 0, exited: 0, transcript_id: null, agent_session_id: null,
    ...over,
  } as SessionRow
}

const absent = (): TranscriptReading => ({ kind: "absent" })

function classify(daemon: { sessionId: string; ageMs?: number }, rows: SessionRow[], transcript: (id: string) => TranscriptReading = absent) {
  return classifyUnownedBrokers({
    daemons: [{ sessionId: daemon.sessionId, daemonPid: 4242, createdAt: born(daemon.ageMs ?? 17 * 60_000) }],
    rows,
    transcript,
    nowMs: NOW,
  })
}

test("a daemon an open broker row runs on is owned, and is not listed", () => {
  assert.deepEqual(classify({ sessionId: "sess-live" }, [row()]), [])
})

// The 2026-10-08 orphan: the dispatch forked the daemon, the server died before the row landed, and the
// re-sent prompt minted a new session under the same slug. Nothing names the first session at all.
test("a daemon no row names and no transcript backs is ended", () => {
  const [entry] = classify({ sessionId: "sess-orphan" }, [row()])
  assert.equal(entry.reason, "no-row")
  assert.deepEqual(entry.verdict, { end: true })
})

test("everything that might be a running turn is listed and kept", () => {
  const present = (): TranscriptReading => ({ kind: "present", mtimeMs: NOW - 60_000 })
  const cases: [string, ReturnType<typeof classify>[number]["verdict"], ReturnType<typeof classify>][] = [
    ["a row-less daemon with a transcript", { end: false, keptBecause: "has-a-transcript" }, classify({ sessionId: "s" }, [], present)],
    ["a probe that could not answer", { end: false, keptBecause: "transcript-unreadable" }, classify({ sessionId: "s" }, [], () => ({ kind: "unknown" }))],
    ["a probe that threw", { end: false, keptBecause: "transcript-unreadable" }, classify({ sessionId: "s" }, [], () => { throw new Error("EACCES") })],
    ["a daemon younger than the guard", { end: false, keptBecause: "too-young" }, classify({ sessionId: "s", ageMs: UNOWNED_MIN_AGE_MS - 1 }, [])],
    ["an archived thread's daemon", { end: false, keptBecause: "row-references-it" }, classify({ sessionId: "s" }, [row({ session_id: "s", state: "archived", archived: 1 })])],
    ["a codex row naming the session", { end: false, keptBecause: "row-references-it" }, classify({ sessionId: "s" }, [row({ session_id: "s", backend: "codex" })])],
    ["a row naming it only as its transcript", { end: false, keptBecause: "row-references-it" }, classify({ sessionId: "s" }, [row({ transcript_id: "s" })])],
  ]
  for (const [name, verdict, entries] of cases) {
    assert.equal(entries.length, 1, name)
    assert.deepEqual(entries[0].verdict, verdict, name)
  }
  assert.equal(classify({ sessionId: "s" }, [row({ session_id: "s", archived: 1 })])[0].reason, "archived")
})

test("an unreadable birth never permits an end", () => {
  const [entry] = classifyUnownedBrokers({
    daemons: [{ sessionId: "s", daemonPid: 1, createdAt: "garbage" }], rows: [], transcript: absent, nowMs: NOW,
  })
  assert.deepEqual(entry.verdict, { end: false, keptBecause: "unknown-age" })
})

test("the log line names the session, pid, age and last activity in the house duration grammar", () => {
  const [entry] = classify({ sessionId: "2d83b13e", ageMs: 17 * 60_000 }, [])
  assert.equal(
    describeUnownedBroker(entry, NOW),
    "unowned broker daemon 2d83b13e, pid 4242: no thread claims it; up 17m, last activity 17m ago; ended: it never received a prompt",
  )
})

test("the probe looks in every transcript bucket and fails closed", () => {
  const root = mkdtempSync(join(tmpdir(), "unowned-probe-"))
  try {
    assert.deepEqual(probeClaudeTranscript("s", join(root, "missing")), { kind: "absent" }, "no store at all is no transcript")
    mkdirSync(join(root, "-home-a"))
    mkdirSync(join(root, "-home-b"))
    assert.deepEqual(probeClaudeTranscript("s", root), { kind: "absent" })
    writeFileSync(join(root, "-home-b", "s.jsonl"), "") // even an EMPTY file counts: the CLI created it
    assert.equal(probeClaudeTranscript("s", root).kind, "present")
    chmodSync(join(root, "-home-a"), 0o000)
    if (process.getuid?.() !== 0) assert.deepEqual(probeClaudeTranscript("t", root), { kind: "unknown" }, "an unreadable bucket is not an absent transcript")
  } finally {
    chmodSync(join(root, "-home-a"), 0o700)
    rmSync(root, { recursive: true, force: true })
  }
})

test("a periodic pass logs a daemon once per verdict and forgets the ones that are gone", () => {
  const lines: string[] = []
  let ageMs = 74_000 // the real orphan's age when the next boot looked at it
  let daemons = [{ sessionId: "sess-orphan", daemonPid: 7, createdAt: "" }]
  const deps = {
    liveDaemons: () => daemons.map((d) => ({ ...d, createdAt: born(ageMs) })),
    rows: () => [row()],
    transcript: absent,
    end: () => { daemons = []; return true },
    log: (m: string) => lines.push(m),
    now: () => NOW,
  }
  const listed = new Map<string, string>()
  auditUnownedBrokersOnce(deps, listed)
  auditUnownedBrokersOnce(deps, listed)
  assert.equal(lines.length, 1, "the boot lists it once, and the next pass does not repeat it")
  assert.match(lines[0], /kept: too-young/)
  ageMs = UNOWNED_MIN_AGE_MS + 1
  auditUnownedBrokersOnce(deps, listed)
  assert.equal(lines.length, 2)
  assert.match(lines[1], /ended: it never received a prompt/)
  auditUnownedBrokersOnce(deps, listed)
  assert.equal(lines.length, 2, "an ended daemon is not listed again")
  assert.equal(listed.size, 0)
})

test("an end that fails is reported as kept, and enumeration failures end nothing", () => {
  const lines: string[] = []
  const [entry] = auditUnownedBrokersOnce({
    liveDaemons: () => [{ sessionId: "s", daemonPid: 7, createdAt: born(UNOWNED_MIN_AGE_MS + 1) }],
    rows: () => [], transcript: absent, end: () => false, log: (m) => lines.push(m), now: () => NOW,
  })
  assert.deepEqual(entry.verdict, { end: false, keptBecause: "end-failed" })
  let ended = 0
  for (const broken of [{ liveDaemons: () => { throw new Error("readdir") } }, { rows: () => { throw new Error("db locked") } }]) {
    assert.deepEqual(auditUnownedBrokersOnce({
      liveDaemons: () => [{ sessionId: "s", daemonPid: 7, createdAt: born(UNOWNED_MIN_AGE_MS + 1) }],
      rows: () => [], transcript: absent, end: () => { ended++; return true }, log: () => {}, now: () => NOW,
      ...broken,
    }), [])
  }
  assert.equal(ended, 0)
})

// ---- against REAL daemons -------------------------------------------------------------------------
//
// The gap lives between processes: a detached daemon outlives the server that forked it, and the next
// server has to decide about it from the record directory alone. So this forks real daemons (on the fake
// claude CLI), drops the bridge the way a dying server does, and runs the pass a booting server runs.

const fakeCli = fileURLToPath(new URL("./backend/claude-agent-sdk.fixtures/fake-claude-cli.mjs", import.meta.url))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

test("a booting server ends a real row-less, transcript-less daemon and keeps the rest", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "unowned-real-"))
  const exe = join(dir, "fake-claude--basic.mjs")
  copyFileSync(fakeCli, exe); chmodSync(exe, 0o700)
  const store = join(dir, "projects")
  mkdirSync(join(store, "-bucket"), { recursive: true })
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }
  const [orphan, conversed, owned] = [randomUUID(), randomUUID(), randomUUID()]
  const first = createClaudeAgentBrokerBridge({ stateDir: dir, executablePath: exe, env })
  try {
    for (const sessionId of [orphan, conversed, owned]) {
      await first.spawnDispatch({ threadSlug: `t-${sessionId.slice(0, 4)}`, sessionId, cwd: dir, prompt: "go", permissionMode: "default" })
    }
    first.close() // the server dies; the detached daemons do not
    await sleep(300)
    const pids = new Map(liveBrokerRecords(dir).map((r) => [r.sessionId, r.daemonPid]))
    assert.equal(pids.size, 3, "all three daemons outlived the server")
    writeFileSync(join(store, "-bucket", `${conversed}.jsonl`), "{}\n") // this one held a conversation

    const lines: string[] = []
    const entries = auditUnownedBrokersOnce({
      liveDaemons: () => liveBrokerRecords(dir),
      rows: () => [row({ slug: "owned", session_id: owned })],
      transcript: (id) => probeClaudeTranscript(id, store),
      end: (id) => killBroker(dir, id, "unowned-never-prompted"),
      log: (m) => lines.push(m),
      minAgeMs: 0,
    })
    assert.deepEqual(entries.map((e) => [e.sessionId, e.verdict.end]).sort(), [[conversed, false], [orphan, true]].sort())
    assert.equal(lines.length, 2, "both unowned daemons are listed; the owned one is not")
    const deadline = Date.now() + 10_000
    while (alive(pids.get(orphan)!) && Date.now() < deadline) await sleep(50)
    assert.equal(alive(pids.get(orphan)!), false, "the never-prompted daemon was ended")
    assert.equal(alive(pids.get(conversed)!), true, "CONTROL: the daemon with a transcript is untouched")
    assert.equal(alive(pids.get(owned)!), true, "CONTROL: the owned daemon is untouched")
  } finally {
    first.close()
    for (const r of liveBrokerRecords(dir)) { try { process.kill(r.daemonPid, "SIGKILL") } catch {} }
    await sleep(200)
    rmSync(dir, { recursive: true, force: true })
  }
})
