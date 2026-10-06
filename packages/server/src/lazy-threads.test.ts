// LAZY THREADS (plans/lazy-threads.md): a thread written down without an agent, started by its first message.
//
// The real dispatcher and the real router against real SQLite; only the broker is a recorder, because
// what these pin is what Frizz asks it to start — and that it asks at the right moment, exactly once.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import Database from "./sqlite.ts"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import { createDispatcher } from "./dispatch.ts"
import { createRouter } from "./router.ts"
import { createStorage, isHeldRow } from "./storage.ts"
import { defaultSettings } from "./settings.ts"
import { cwdSlug, type Project } from "./project.ts"
import { heldThreadView, type BoardManager } from "./board.ts"
import type { AppContext } from "./context.ts"
import type { Tailer } from "./tailer.ts"
import type { ClaudeAgentBrokerBridge } from "./backend/claude-agent-broker-bridge.ts"

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "frizz-lazy-threads-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  const project: Project = { dir, id: "lazy-threads", name: "t", label: "o/t", stateDir: dir, cwdSlug: cwdSlug(dir) }
  const snapshot: BoardSnapshot = { projectDir: dir, projectName: "t", projectLabel: "t", threads: [], errors: [], warnings: [] }
  const board: BoardManager = {
    snapshot: async () => snapshot, currentSeq: () => 0, rebuild: async () => snapshot,
    refresh: () => snapshot, start: async () => {}, stop: async () => {},
  }
  const spawned: { threadSlug: string; sessionId: string; prompt: string; model?: string }[] = []
  const followUps: string[] = []
  let gate: Promise<void> = Promise.resolve()
  const claudeBroker = {
    spawnDispatch: async (input: { threadSlug: string; sessionId: string; cwd: string; prompt: string; model?: string }) => {
      await gate
      spawned.push({ threadSlug: input.threadSlug, sessionId: input.sessionId, prompt: input.prompt, model: input.model })
      return { binding: { threadSlug: input.threadSlug, sessionId: input.sessionId, cwd: input.cwd } }
    },
    followUp: async (input: { text: string }) => void followUps.push(input.text),
    releaseSession: () => {},
  } as unknown as ClaudeAgentBrokerBridge
  const dispatcher = createDispatcher({
    project, storage, board, claudeBroker,
    getSettings: () => defaultSettings(),
    dispatchProfile: () => ({ model: "opus" }),
  })
  const tailer: Tailer = {
    get: () => undefined, foreignIds: () => [], subAgent: () => undefined,
    forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
  }
  const ctx = {
    project, storage, board, tailer, dispatcher, claudeBroker,
    getSettings: () => defaultSettings(),
  } as unknown as AppContext
  return {
    storage, dispatcher, router: createRouter(ctx), spawned, followUps,
    hold: () => { let open!: () => void; gate = new Promise((r) => { open = r }); return () => open() },
    close: () => { storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

test("writing a lazy thread down spawns nothing and leaves a row that is plainly unstarted", async () => {
  const h = harness()
  try {
    const { slug, sessionId } = await h.router.createLazyThread.handler({ input: { prompt: "Look into the flaky resume test", title: "Flaky resume" } })
    assert.deepEqual(h.spawned, [], "no agent is started for a lazy thread")
    const row = h.storage.getSession(slug)!
    assert.equal(isHeldRow(row), true)
    assert.equal(row.held_by, "lazy")
    assert.equal(row.lazy_prompt, "Look into the flaky resume test")
    assert.equal(row.session_id, sessionId)
    assert.equal(row.title, "Flaky resume")
    assert.equal(row.title_locked, 1, "a name the human typed is theirs")
    assert.equal(row.claude_runtime ?? null, null, "no runtime is recorded for a session nobody started")
    assert.equal(row.model, "opus", "the profile it will start on is the prompt box's at the time")
  } finally { h.close() }
})

test("the first message starts the agent on the SAME slug and session id, and the row stops being a lazy thread", async () => {
  const h = harness()
  try {
    const { slug, sessionId } = await h.router.createLazyThread.handler({ input: { prompt: "Fix the cache key", title: "Cache key" } })
    await h.router.followUp.handler({ input: { slug, sessionId, message: "Fix the cache key in resolver.ts" } })
    assert.equal(h.spawned.length, 1)
    assert.equal(h.spawned[0].threadSlug, slug)
    assert.equal(h.spawned[0].sessionId, sessionId)
    assert.match(h.spawned[0].prompt, /Fix the cache key in resolver\.ts/)
    assert.deepEqual(h.followUps, [], "a lazy thread's first message is a dispatch, never a resume")
    const row = h.storage.getSession(slug)!
    assert.equal(isHeldRow(row), false)
    assert.equal(row.held_by, null)
    assert.equal(row.lazy_prompt, null)
    assert.equal(row.claude_runtime, "broker")
    assert.equal(row.exited, 0)
    assert.equal(row.title, "Cache key", "the lazy thread's name carries over")
    assert.equal(row.title_locked, 1)

    // From here it is an ordinary thread: the next message is a follow-up into the running session.
    await h.router.followUp.handler({ input: { slug, sessionId, message: "and add a test" } })
    assert.equal(h.spawned.length, 1)
    assert.equal(h.followUps.length, 1)
  } finally { h.close() }
})

test("startLazyThread starts it with the edited prompt, once, and refuses a second start", async () => {
  const h = harness()
  try {
    const { slug, sessionId } = await h.router.createLazyThread.handler({ input: { prompt: "draft" } })
    const release = h.hold()
    const first = h.router.startLazyThread.handler({ input: { slug, sessionId, prompt: "the edited prompt" } })
    // A double click while the first is still spawning must not start a second agent on the same session.
    await assert.rejects(h.router.startLazyThread.handler({ input: { slug, sessionId, prompt: "again" } }), /already starting/)
    release()
    await first
    assert.equal(h.spawned.length, 1)
    assert.match(h.spawned[0].prompt, /the edited prompt/)
    await assert.rejects(h.router.startLazyThread.handler({ input: { slug, sessionId, prompt: "again" } }), /already started/)
    await assert.rejects(h.router.updateLazyPrompt.handler({ input: { slug, sessionId, prompt: "late edit" } }), /already started/)
  } finally { h.close() }
})

test("the note can be rewritten while it is unstarted", async () => {
  const h = harness()
  try {
    const { slug, sessionId } = await h.router.createLazyThread.handler({ input: { prompt: "first" } })
    await h.router.updateLazyPrompt.handler({ input: { slug, sessionId, prompt: "second" } })
    assert.equal(h.storage.getSession(slug)?.lazy_prompt, "second")
    assert.equal(h.spawned.length, 0)
  } finally { h.close() }
})

test("a failed start leaves the lazy thread exactly as it was", async () => {
  const h = harness()
  try {
    const { slug, sessionId } = await h.router.createLazyThread.handler({ input: { prompt: "keep me" } })
    ;(h.dispatcher as { dispatch: unknown }).dispatch = async () => { throw new Error("broker down") }
    await assert.rejects(h.router.startLazyThread.handler({ input: { slug, sessionId, prompt: "go" } }), /broker down/)
    assert.equal(h.storage.getSession(slug)?.lazy_prompt, "keep me")
  } finally { h.close() }
})

test("a lazy thread queues unless it is done or snoozed, and never reads as running or stalled", () => {
  const base = {
    id: "t", title: "t", status: "active", hasPlan: false, mechanism: null, humanBlocked: false, ready: false,
    dependsOn: [], externalDeps: [], agents: [], errors: [], warnings: [], runtime: "exited", sessionId: "s",
    unread: false, archived: false, subAgents: [], bgShells: [], watches: [], pendingQuestion: false, questions: [],
    needsYou: false, awaitingBackground: false, crashed: true, kind: "session",
  } as unknown as ThreadView
  const row = { lazy_prompt: "note", held_by: "lazy", spawned_at: "2026-10-01T00:00:00.000Z" } as Parameters<typeof heldThreadView>[1]
  const open = heldThreadView(base, row)
  assert.equal(open.needsYou, true)
  assert.equal(open.runtime, "turn-idle")
  assert.equal(open.crashed, false)
  assert.equal(open.lazyPrompt, "note")
  assert.equal(open.held, "lazy")
  assert.equal(heldThreadView({ ...base, archived: true }, row).needsYou, false)
  assert.equal(heldThreadView({ ...base, snoozedUntil: "2099-01-01T00:00:00.000Z" }, row).needsYou, false)
})

test("a database from the build that named the column `todo` keeps its lazy threads", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-lazy-migrate-"))
  try {
    const file = join(dir, "ui.db")
    const first = createStorage(file, "p")
    first.upsertSession({
      slug: "renew", session_id: "sid-renew", thread_name: "frizz-renew", spawned_at: "2026-10-01T00:00:00.000Z",
      last_read_at: null, unread: 0, exited: 1, archived: 0, rested_at: null, title_auto: 0, title: "renew",
      state: "open", meta: null, seen_at: null, transcript_id: null,
    })
    first.close()
    // What that build left behind: its own column, holding the prompt, and nothing in the new one.
    const raw = new Database(file)
    raw.exec("ALTER TABLE session ADD COLUMN todo TEXT")
    raw.exec("UPDATE session SET todo = 'Renew the domain', lazy_prompt = NULL")
    raw.close()
    const reopened = createStorage(file, "p")
    assert.equal(reopened.getSession("renew")?.lazy_prompt, "Renew the domain")
    assert.equal(isHeldRow(reopened.getSession("renew")), true)
    assert.equal(reopened.getSession("renew")?.held_by, "lazy")
    reopened.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
