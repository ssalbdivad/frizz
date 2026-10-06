// LAZY THREADS — the `lazy` Frizz plugin (plugins/lazy/server.ts): a thread written down without an agent,
// started by its first message. Until 2026-10-06 this file was lazy-threads.test.ts and drove base's own
// createLazyThread / updateLazyPrompt / startLazyThread; every case it pinned is pinned here against the
// plugin that now carries them, plus what moving them out added: the note in the plugin's database, the
// import of a legacy note, and a thread that outlives its plugin.
//
// The REAL plugin from this checkout, linked into a sandbox data directory exactly as plugins/install.ts
// links it, loaded by the real loader on Node's type stripping, mounted in the real router over real
// SQLite and called over the real `mountRouter`. Only the broker is a recorder, because what these pin is
// what Frizz asks it to start — and that it asks at the right moment, exactly once.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Hono } from "hono"
import { mountRouter } from "@frizz/rpc/server"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import Database from "../sqlite.ts"
import { createDispatcher } from "../dispatch.ts"
import { createRouter, deleteOwnedThread } from "../router.ts"
import { createStorage, isHeldRow, type Storage } from "../storage.ts"
import { defaultSettings } from "../settings.ts"
import { cwdSlug, type Project } from "../project.ts"
import { heldThreadView, type BoardManager } from "../board.ts"
import type { AppContext } from "../context.ts"
import type { Tailer } from "../tailer.ts"
import type { ClaudeAgentBrokerBridge } from "../backend/claude-agent-broker-bridge.ts"
import { frizzPaths } from "../frizz-paths.ts"
import { createHeldThreadStarter } from "../held-start.ts"
import { emptyPluginRegistry, loadPlugins, userPluginsDir, type PluginRegistry } from "./loader.ts"
import { createProjectPlugins } from "./project.ts"

const LAZY_SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../plugins/lazy")

const BASE_VIEW = {
  id: "t", title: "t", status: "active", hasPlan: false, mechanism: null, humanBlocked: false, ready: false,
  dependsOn: [], externalDeps: [], agents: [], errors: [], warnings: [], runtime: "exited", sessionId: "s",
  unread: false, archived: false, subAgents: [], bgShells: [], watches: [], pendingQuestion: false, questions: [],
  needsYou: false, awaitingBackground: false, crashed: true, kind: "session",
} as unknown as ThreadView

/** A sandbox home whose data directory has the lazy plugin linked in, as plugins/install.ts links it. */
function sandboxHome(): { home: string; data: string } {
  const home = mkdtempSync(join(tmpdir(), "frizz-lazy-plugin-"))
  const data = frizzPaths({ home, env: {} }).data
  mkdirSync(userPluginsDir(data), { recursive: true })
  symlinkSync(LAZY_SOURCE, join(userPluginsDir(data), "lazy"), "dir")
  return { home, data }
}

async function harness(opts: { home?: string; registry?: PluginRegistry; storageFile?: string } = {}) {
  const sandbox = opts.home ? { home: opts.home } : sandboxHome()
  const registry = opts.registry ?? await loadPlugins({ home: sandbox.home, env: {} })
  if (!opts.registry) assert.equal(registry.get("lazy")?.state, "active", registry.get("lazy")?.reason)
  const dir = mkdtempSync(join(tmpdir(), "frizz-lazy-plugin-repo-"))
  const storage: Storage = createStorage(opts.storageFile ?? join(dir, "ui.db"), "p")
  const project: Project = { dir, id: "lazy-threads", name: "t", label: "o/t", stateDir: dir, cwdSlug: cwdSlug(dir) }
  const snapshot: BoardSnapshot = { projectDir: dir, projectName: "t", projectLabel: "t", threads: [], errors: [], warnings: [] }
  const board: BoardManager = {
    snapshot: async () => snapshot, currentSeq: () => 0, rebuild: async () => snapshot,
    refresh: () => snapshot, start: async () => {}, stop: async () => {},
  }
  const spawned: { threadSlug: string; sessionId: string; prompt: string; model?: string }[] = []
  const followUps: string[] = []
  let gate: Promise<void> = Promise.resolve()
  let brokerDown = false
  const claudeBroker = {
    spawnDispatch: async (input: { threadSlug: string; sessionId: string; cwd: string; prompt: string; model?: string }) => {
      await gate
      if (brokerDown) throw new Error("broker down")
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
  const starter = createHeldThreadStarter({ dispatcher, board })
  const plugins = createProjectPlugins({
    registry, project, storage, dispatcher,
    startHeld: (row, prompt, profile) => starter.start(row, prompt, profile),
    refresh: () => {},
  })
  const tailer: Tailer = {
    get: () => undefined, foreignIds: () => [], subAgent: () => undefined,
    forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
  }
  const ctx = {
    project, storage, board, tailer, dispatcher, claudeBroker, plugins, pluginRegistry: registry,
    getSettings: () => defaultSettings(),
    startHeldThread: (row: never, prompt: string, profile: never) => starter.start(row, prompt, profile),
    terminalRunner: { forgetThread: async () => {}, closeThread: async () => {}, live: () => false, stopThread: async () => {} },
  } as unknown as AppContext
  plugins.opened()
  const router = createRouter(ctx)
  const app = new Hono()
  mountRouter(app, "/_frizz/rpc", router as never)
  /** A plugin procedure over HTTP, as the page calls it; throws the server's error text. */
  const call = async <T = unknown>(name: string, input: unknown): Promise<T> => {
    const response = await app.request(`/_frizz/rpc/plugin.lazy.${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) })
    const body = (await response.json()) as { result?: T; error?: string }
    if (response.status !== 200) throw new Error(body.error ?? `HTTP ${response.status}`)
    return body.result as T
  }
  const view = (slug: string): ThreadView => {
    const row = storage.getSession(slug)!
    return plugins.threadView(heldThreadView({ ...BASE_VIEW, id: slug, sessionId: row.session_id }, row), row)
  }
  return {
    home: sandbox.home, storage, dispatcher, router, plugins, registry, ctx, spawned, followUps, call, view,
    hold: () => { let open!: () => void; gate = new Promise((r) => { open = r }); return () => open() },
    breakBroker: () => { brokerDown = true },
    close: (keepHome = false) => {
      registry.close()
      storage.close()
      rmSync(dir, { recursive: true, force: true })
      if (!keepHome) rmSync(sandbox.home, { recursive: true, force: true })
    },
  }
}

type Created = { slug: string; sessionId: string }

test("writing a lazy thread down spawns nothing and leaves a row that is plainly unstarted", async () => {
  const h = await harness()
  try {
    const { slug, sessionId } = await h.call<Created>("create", { prompt: "Look into the flaky resume test", title: "Flaky resume" })
    assert.equal(h.spawned.length, 0, "no agent is started for a lazy thread")
    const row = h.storage.getSession(slug)!
    assert.equal(isHeldRow(row), true)
    assert.equal(row.held_by, "lazy")
    assert.equal(row.lazy_prompt, "Look into the flaky resume test", "base's copy: what an older Frizz, or no plugin, starts it on")
    assert.equal(row.session_id, sessionId)
    assert.equal(row.title, "Flaky resume")
    assert.equal(row.title_locked, 1, "a name the human typed is theirs")
    assert.equal(row.claude_runtime ?? null, null, "no runtime is recorded for a session nobody started")
    assert.equal(row.model, "opus", "the profile it will start on is the prompt box's at the time")
    assert.deepEqual(h.view(slug).plugins, { lazy: { note: "Look into the flaky resume test" } })
  } finally { h.close() }
})

test("the first message starts the agent on the SAME slug and session id, and the row stops being a lazy thread", async () => {
  const h = await harness()
  try {
    const { slug, sessionId } = await h.call<Created>("create", { prompt: "Fix the cache key", title: "Cache key" })
    await h.router.followUp.handler({ input: { slug, sessionId, message: "Fix the cache key in resolver.ts" } } as never)
    assert.equal(h.spawned.length, 1)
    assert.equal(h.spawned[0]!.threadSlug, slug)
    assert.equal(h.spawned[0]!.sessionId, sessionId)
    assert.match(h.spawned[0]!.prompt, /Fix the cache key in resolver\.ts/)
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
    await h.router.followUp.handler({ input: { slug, sessionId, message: "and add a test" } } as never)
    assert.equal(h.spawned.length, 1)
    assert.equal(h.followUps.length, 1)
  } finally { h.close() }
})

test("start starts it with the edited prompt, once, and refuses a second start — without failing the plugin", async () => {
  const h = await harness()
  try {
    const { slug, sessionId } = await h.call<Created>("create", { prompt: "draft" })
    const release = h.hold()
    const first = h.call("start", { slug, sessionId, prompt: "the edited prompt" })
    // A double click while the first is still spawning must not start a second agent on the same session.
    await assert.rejects(h.call("start", { slug, sessionId, prompt: "again" }), /already starting/)
    release()
    await first
    assert.equal(h.spawned.length, 1)
    assert.match(h.spawned[0]!.prompt, /the edited prompt/)
    await assert.rejects(h.call("start", { slug, sessionId, prompt: "again" }), /already started/)
    await assert.rejects(h.call("update", { slug, sessionId, note: "late edit" }), /already started/)
    for (let i = 0; i < 3; i++) await assert.rejects(h.call("start", { slug, sessionId, prompt: "again" }), /already started/)
    assert.equal(h.registry.get("lazy")!.state, "active", "a refusal is an answer, never a strike")
    assert.equal(h.registry.get("lazy")!.strikes, 0)
  } finally { h.close() }
})

test("the note can be rewritten while it is unstarted, and base's copy follows it", async () => {
  const h = await harness()
  try {
    const { slug, sessionId } = await h.call<Created>("create", { prompt: "first" })
    await h.call("update", { slug, sessionId, note: "second" })
    assert.deepEqual(h.view(slug).plugins, { lazy: { note: "second" } })
    assert.equal(h.storage.getSession(slug)?.lazy_prompt, "second", "so it starts on the latest words if the plugin is gone")
    assert.equal(h.spawned.length, 0)
    await assert.rejects(h.call("update", { slug, sessionId: "another-session", note: "x" }), /gone/)
  } finally { h.close() }
})

test("a failed start leaves the lazy thread exactly as it was", async () => {
  const h = await harness()
  try {
    const { slug, sessionId } = await h.call<Created>("create", { prompt: "keep me" })
    h.breakBroker()
    await assert.rejects(h.call("start", { slug, sessionId, prompt: "go" }), /broker down/)
    assert.equal(h.storage.getSession(slug)?.held_by, "lazy")
    assert.equal(h.storage.getSession(slug)?.lazy_prompt, "keep me")
    assert.deepEqual(h.view(slug).plugins, { lazy: { note: "keep me" } })
    assert.equal(h.registry.get("lazy")!.strikes, 0, "base's failure is not the plugin's")
  } finally { h.close() }
})

test("a lazy thread queues unless it is done or snoozed; base alone never queues it", async () => {
  const h = await harness()
  try {
    const { slug } = await h.call<Created>("create", { prompt: "note" })
    const row = h.storage.getSession(slug)!
    const held = heldThreadView({ ...BASE_VIEW, id: slug }, row)
    assert.equal(held.needsYou, false, "base: no agent, no queue")
    assert.equal(held.runtime, "turn-idle")
    assert.equal(held.crashed, false)
    const open = h.plugins.threadView(held, row)
    assert.equal(open.needsYou, true, "the plugin: waiting on the human, like a bare rest")
    assert.equal(open.held, "lazy")
    assert.equal(h.plugins.threadView(heldThreadView({ ...BASE_VIEW, id: slug, archived: true }, row), row).needsYou, false)
    assert.equal(h.plugins.threadView(heldThreadView({ ...BASE_VIEW, id: slug, snoozedUntil: "2099-01-01T00:00:00.000Z" }, row), row).needsYou, false)
  } finally { h.close() }
})

test("a lazy thread written down BEFORE the plugin keeps its note: the migration hands it over and the plugin imports it", async () => {
  const sandbox = sandboxHome()
  const dbDir = mkdtempSync(join(tmpdir(), "frizz-lazy-legacy-"))
  const file = join(dbDir, "ui.db")
  try {
    // What the build before the move left: a lazy row whose note is in `lazy_prompt`, and no `held_by` column.
    const old = createStorage(file, "p")
    old.upsertSession({
      slug: "renew", session_id: "sid-renew", thread_name: "frizz-renew", spawned_at: "2026-10-01T00:00:00.000Z",
      last_read_at: null, unread: 0, exited: 1, archived: 0, rested_at: null, title_auto: 0, title: "Renew",
      state: "open", meta: null, seen_at: null, transcript_id: null, lazy_prompt: "Renew the domain before the 14th",
    })
    old.close()
    const raw = new Database(file)
    raw.exec("ALTER TABLE session DROP COLUMN held_by")
    raw.close()

    const h = await harness({ home: sandbox.home, storageFile: file })
    try {
      assert.equal(h.storage.getSession("renew")?.held_by, "lazy")
      assert.deepEqual(h.view("renew").plugins, { lazy: { note: "Renew the domain before the 14th" } })
      assert.equal(h.view("renew").needsYou, true, "it is still in the queue")
      // Imported into the plugin's own database at project open: the legacy column is a copy from here on.
      const pluginDb = new Database(join(sandbox.data, "plugin-data", "lazy.db"))
      try {
        assert.deepEqual(pluginDb.prepare("SELECT slug, session_id, text FROM note").all(), [{ slug: "renew", session_id: "sid-renew", text: "Renew the domain before the 14th" }])
      } finally { pluginDb.close() }
      assert.equal(h.storage.getSession("renew")?.lazy_prompt, "Renew the domain before the 14th", "never emptied")
      await h.router.followUp.handler({ input: { slug: "renew", sessionId: "sid-renew", message: "Renew the domain before the 14th" } } as never)
      assert.equal(h.spawned.length, 1)
    } finally { h.close(true) }
  } finally {
    rmSync(dbDir, { recursive: true, force: true })
    rmSync(sandbox.home, { recursive: true, force: true })
  }
})

test("with the plugin gone, a lazy thread still starts on its next message, on what base kept", async () => {
  const sandbox = sandboxHome()
  const dbDir = mkdtempSync(join(tmpdir(), "frizz-lazy-orphan-"))
  const file = join(dbDir, "ui.db")
  try {
    // Write one down with the plugin and edit it, then reopen the same database with no plugins at all.
    const withPlugin = await harness({ home: sandbox.home, storageFile: file })
    const { slug, sessionId } = await withPlugin.call<Created>("create", { prompt: "first draft" })
    await withPlugin.call("update", { slug, sessionId, note: "the latest words" })
    withPlugin.close(true)

    const without = await harness({ home: sandbox.home, storageFile: file, registry: emptyPluginRegistry() })
    try {
      const row = without.storage.getSession(slug)!
      assert.equal(row.held_by, "lazy", "still held: nothing is rewritten when a plugin goes away")
      const drawn = without.view(slug)
      assert.equal(drawn.needsYou, false, "no holder to queue it: base's rule")
      assert.equal(drawn.heldPrompt, "the latest words", "base's box shows the latest note")
      await without.router.followUp.handler({ input: { slug, sessionId, message: "go" } } as never)
      assert.equal(without.spawned.length, 1)
      assert.match(without.spawned[0]!.prompt, /go/)
      assert.equal(without.storage.getSession(slug)!.held_by, null)
    } finally { without.close(true) }
  } finally {
    rmSync(dbDir, { recursive: true, force: true })
    rmSync(sandbox.home, { recursive: true, force: true })
  }
})

test("deleting a lazy thread drops its note", async () => {
  const h = await harness()
  try {
    const { slug } = await h.call<Created>("create", { prompt: "to delete" })
    assert.equal(await deleteOwnedThread(h.ctx, slug), true)
    await new Promise((resolve) => setImmediate(resolve))
    const pluginDb = new Database(join(frizzPaths({ home: h.home, env: {} }).data, "plugin-data", "lazy.db"))
    try {
      assert.deepEqual(pluginDb.prepare("SELECT slug FROM note").all(), [])
    } finally { pluginDb.close() }
  } finally { h.close() }
})
