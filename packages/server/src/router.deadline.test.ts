// THE THREAD'S TIME LIMIT AT THE RPC BOUNDARY — the real router against real SQLite (ARCHITECTURE.md § Time limits).
//
// The rule these pin is the one the plan calls irreversible-in-spirit: ONLY THE HUMAN may move or clear a
// deadline the human set. A worker reads it, sets one where there is none, and moves only its own.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BoardSnapshot, Settings } from "@frizz/shared"
import type { BoardManager } from "./board.ts"
import { createRouter } from "./router.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import type { AppContext } from "./context.ts"
import type { Project } from "./project.ts"
import type { SessionTelemetry, Tailer } from "./tailer.ts"
import { withDispatchCaller } from "./dispatch-caller.ts"
import { createWakeDeliveryStore } from "./wake-store.ts"

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "frizz-deadline-rpc-"))
  const project: Project = { dir, id: "dl", name: "test", label: "test", stateDir: dir, cwdSlug: "test" }
  const storage = createStorage(join(dir, "ui.db"), "p")
  const snapshot: BoardSnapshot = { projectDir: dir, projectName: "test", projectLabel: "test", threads: [], errors: [], warnings: [] }
  const board: BoardManager = {
    snapshot: async () => snapshot, currentSeq: () => 0, rebuild: async () => snapshot,
    refresh: () => snapshot, start: async () => {}, stop: async () => {},
  }
  const tailer: Tailer = {
    get: () => ({ subAgents: [], bgShells: [] }) as unknown as SessionTelemetry,
    foreignIds: () => [], subAgent: () => undefined,
    forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
  }
  const ctx = { project, storage, board, tailer, getSettings: () => ({ permissionMode: "auto" }) as unknown as Settings } as unknown as AppContext
  const notices = () => createWakeDeliveryStore(storage.scope).listOpen().filter((d) => d.fenceId.startsWith("deadline-notice:"))
  return { storage, notices, router: createRouter(ctx), close: () => { storage.close(); rmSync(dir, { recursive: true, force: true }) } }
}

function row(slug: string): SessionRow {
  return {
    slug, session_id: `sid-${slug}`, thread_name: `frizz-${slug}`, spawned_at: "2026-10-06T00:00:00.000Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
  }
}

const inMs = (ms: number) => new Date(Date.now() + ms).toISOString()
const asWorker = <T>(fn: () => T) => withDispatchCaller({ origin: undefined, userAgent: "node" }, fn)
const asBrowser = <T>(fn: () => T) => withDispatchCaller({ origin: "http://localhost:9393", userAgent: "Mozilla/5.0" }, fn)

test("the human sets a deadline: a new generation, set by the human, and the worker is told", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    const at = inMs(2 * 3_600_000)
    const got = await asBrowser(() => h.router.setThreadDeadline.handler({ input: { slug: "t", deadline: at } }))
    assert.equal(got.deadline?.at, new Date(at).toISOString())
    assert.equal(got.deadline?.setBy, "human")
    const stored = h.storage.getSession("t")!
    assert.equal(stored.deadline_at, new Date(at).toISOString())
    assert.equal(stored.deadline_set_by, "human")
    assert.equal(stored.deadline_stage, null)
    const notices = h.notices()
    assert.equal(notices.length, 1)
    assert.match(notices[0]!.message, /set a time limit/)
    assert.equal(notices[0]!.fenceId, `deadline-notice:set:${stored.deadline_set_at}`)
  } finally {
    h.close()
  }
})

test("a worker's transport cannot use the human's control", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    await assert.rejects(
      asWorker(() => h.router.setThreadDeadline.handler({ input: { slug: "t", deadline: inMs(3_600_000) } })),
      /mcp__frizz__deadline/,
    )
    assert.equal(h.storage.getSession("t")!.deadline_at ?? null, null)
  } finally {
    h.close()
  }
})

test("ONLY THE HUMAN moves or clears a deadline the human set; the worker may read it", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    await asBrowser(() => h.router.setThreadDeadline.handler({ input: { slug: "t", deadline: inMs(3_600_000) } }))
    const read = await h.router.ownDeadline.handler({ input: { slug: "t", action: "read" } })
    assert.equal(read.deadline?.setBy, "human")
    await assert.rejects(h.router.ownDeadline.handler({ input: { slug: "t", action: "extend", for: "2h" } }), /only the human can extend/)
    await assert.rejects(h.router.ownDeadline.handler({ input: { slug: "t", action: "clear" } }), /only the human can remove/)
    await assert.rejects(h.router.ownDeadline.handler({ input: { slug: "t", action: "set", for: "2h" } }), /only the human can move/)
    // Untouched by every refusal.
    assert.equal(h.storage.getSession("t")!.deadline_at, read.deadline?.at)
    // …and the human can.
    const moved = await asBrowser(() => h.router.setThreadDeadline.handler({ input: { slug: "t", deadline: inMs(3 * 3_600_000) } }))
    assert.ok(Date.parse(moved.deadline!.at) > Date.parse(read.deadline!.at))
    assert.match(h.notices().at(-1)!.message, /extended your deadline/)
    await asBrowser(() => h.router.setThreadDeadline.handler({ input: { slug: "t", deadline: null } }))
    assert.equal(h.storage.getSession("t")!.deadline_at, null)
    assert.match(h.notices().at(-1)!.message, /removed your time limit/)
  } finally {
    h.close()
  }
})

test("a worker sets one where there is none, then moves and clears its own", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    const set = await h.router.ownDeadline.handler({ input: { slug: "t", action: "set", for: "1h 30m" } })
    assert.equal(set.deadline?.setBy, "worker")
    const ms = Date.parse(set.deadline!.at) - Date.now()
    assert.ok(ms > 89 * 60_000 && ms <= 90 * 60_000, String(ms))
    await assert.rejects(h.router.ownDeadline.handler({ input: { slug: "t", action: "set", for: "2h" } }), /use `extend`/)
    await assert.rejects(h.router.ownDeadline.handler({ input: { slug: "t", action: "extend", for: "30m" } }), /moves a deadline later/)
    const moved = await h.router.ownDeadline.handler({ input: { slug: "t", action: "extend", for: "2h" } })
    assert.ok(Date.parse(moved.deadline!.at) > Date.parse(set.deadline!.at))
    assert.notEqual(moved.deadline!.setAt, set.deadline!.setAt, "a move is a new generation")
    const cleared = await h.router.ownDeadline.handler({ input: { slug: "t", action: "clear" } })
    assert.equal(cleared.deadline, null)
    // The worker made each change itself, so nothing is queued to tell it.
    assert.equal(h.notices().length, 0)
  } finally {
    h.close()
  }
})

test("bounds: under a minute and past a week are refused on both doors", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    await assert.rejects(asBrowser(() => h.router.setThreadDeadline.handler({ input: { slug: "t", deadline: inMs(20_000) } })), /at least 1m/)
    await assert.rejects(asBrowser(() => h.router.setThreadDeadline.handler({ input: { slug: "t", deadline: inMs(8 * 86_400_000) } })), /at most 7d/)
    await assert.rejects(h.router.ownDeadline.handler({ input: { slug: "t", action: "set", for: "30s" } }), /at least 1m/)
    await assert.rejects(h.router.ownDeadline.handler({ input: { slug: "t", action: "set", for: "15:30" } }), /not a duration/)
  } finally {
    h.close()
  }
})

test("a re-dispatch over the slug drops the old session's deadline; a resume keeps it", () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    h.storage.setDeadline("t", { deadlineAt: inMs(3_600_000), setAt: new Date().toISOString(), setBy: "human" })
    h.storage.upsertSession(h.storage.getSession("t")!)
    assert.ok(h.storage.getSession("t")!.deadline_at, "same session spread back keeps it")
    h.storage.upsertSession({ ...row("t"), session_id: "sid-fresh" })
    assert.equal(h.storage.getSession("t")!.deadline_at, null)
  } finally {
    h.close()
  }
})
