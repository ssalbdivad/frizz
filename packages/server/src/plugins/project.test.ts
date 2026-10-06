// FRIZZ PLUGINS, ONE PROJECT — the RPC namespace, the held-thread routing, the hooks and the events, with
// a REAL plugin: a package.json manifest and a `.ts` server half in a sandbox home, loaded by the real
// loader on Node's type stripping, mounted in the real router over real SQLite and served by the real
// `mountRouter`. Only the Claude broker is a recorder, because what these pin is what Frizz asks it to
// start. The plugin reports what it saw through `globalThis.__frizzProbe` — it may import nothing from
// Frizz, so that is the one channel a test has into it.
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { Hono } from "hono"
import { mountRouter } from "@frizz/rpc/server"
import { PLUGIN_API, type BoardSnapshot, type ThreadView } from "@frizz/shared"
import { createDispatcher } from "../dispatch.ts"
import { createRouter, deleteOwnedThread } from "../router.ts"
import { createStorage } from "../storage.ts"
import { defaultSettings } from "../settings.ts"
import { cwdSlug, type Project } from "../project.ts"
import type { BoardManager } from "../board.ts"
import type { AppContext } from "../context.ts"
import type { Tailer } from "../tailer.ts"
import type { ClaudeAgentBrokerBridge } from "../backend/claude-agent-broker-bridge.ts"
import { frizzPaths } from "../frizz-paths.ts"
import { createHeldThreadStarter } from "../held-start.ts"
import { loadPlugins, userPluginsDir } from "./loader.ts"
import { createProjectPlugins } from "./project.ts"

const PROBE = `
const seen = (globalThis.__frizzProbe ??= [])
const plugin = {
  setup(host) {
    return {
      procedures: {
        note: {
          kind: "mutation", human: true,
          input: host.z.object({ slug: host.z.string(), text: host.z.string() }),
          handler: (input, project) => { seen.push(["note", input.slug, input.text, project.project.id]); return { ok: true } },
        },
        create: {
          kind: "mutation",
          input: host.z.object({ prompt: host.z.string() }),
          handler: (input, project) => project.threads.create({ prompt: input.prompt, title: "Probe note" }),
        },
        held: { kind: "query", handler: (_input, project) => project.threads.held().map((row) => row.slug) },
        boom: { kind: "query", handler: () => { throw new Error("kaboom") } },
        no: { kind: "query", handler: () => host.refuse("Not today") },
      },
      threadView(view, row) {
        if (view.id === "explodes") throw new Error("threadView broke")
        return row.heldBy === "probe" ? { ...view, needsYou: true, plugins: { ...view.plugins, probe: { marked: true } } } : view
      },
      async onSend(row, message, project) {
        seen.push(["onSend", row.slug, message])
        if (message === "throw") throw new Error("onSend broke")
        if (message === "refuse") host.refuse("Not now")
        await project.threads.start(row, "started: " + message)
      },
      on: {
        humanAct: (event) => seen.push(["humanAct", event.slug, event.act]),
        threadDeleted: (event) => seen.push(["deleted", event.slug, event.heldBy]),
        threadDone: (event) => seen.push(["done", event.slug]),
        rest: (event) => seen.push(["rest", event.slug, event.at]),
      },
      systemPrompt: (kind) => (kind === "claude" ? "The probe plugin is watching." : null),
      project: (project) => seen.push(["project", project.project.id]),
    }
  },
}
export default plugin
`

const probe = (): unknown[][] => ((globalThis as { __frizzProbe?: unknown[][] }).__frizzProbe ??= [])
const settle = () => new Promise((resolve) => setImmediate(resolve))

async function harness() {
  probe().length = 0
  const home = mkdtempSync(join(tmpdir(), "frizz-plugin-project-"))
  const pluginDir = join(userPluginsDir(frizzPaths({ home, env: {} }).data), "probe")
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(pluginDir, "package.json"), JSON.stringify({ name: "probe", type: "module", frizzPlugin: { id: "probe", api: PLUGIN_API, server: "./server.ts" } }))
  writeFileSync(join(pluginDir, "server.ts"), PROBE)
  const registry = await loadPlugins({ home, env: {} })
  assert.equal(registry.get("probe")?.state, "active", registry.get("probe")?.reason)

  const dir = mkdtempSync(join(tmpdir(), "frizz-plugin-project-repo-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  const project: Project = { dir, id: "plugin-project", name: "t", label: "o/t", stateDir: dir, cwdSlug: cwdSlug(dir) }
  const snapshot: BoardSnapshot = { projectDir: dir, projectName: "t", projectLabel: "t", threads: [], errors: [], warnings: [] }
  const board: BoardManager = {
    snapshot: async () => snapshot, currentSeq: () => 0, rebuild: async () => snapshot,
    refresh: () => snapshot, start: async () => {}, stop: async () => {},
  }
  const spawned: { threadSlug: string; sessionId: string; prompt: string; appendSystemPrompt?: string }[] = []
  const claudeBroker = {
    spawnDispatch: async (input: { threadSlug: string; sessionId: string; cwd: string; prompt: string; appendSystemPrompt?: string }) => {
      spawned.push({ threadSlug: input.threadSlug, sessionId: input.sessionId, prompt: input.prompt, appendSystemPrompt: input.appendSystemPrompt })
      return { binding: { threadSlug: input.threadSlug, sessionId: input.sessionId, cwd: input.cwd } }
    },
    followUp: async () => {},
    releaseSession: () => {},
  } as unknown as ClaudeAgentBrokerBridge
  // Late-bound exactly as context.ts binds it: the plugins need the dispatcher, and it reads them per dispatch.
  let plugins: ReturnType<typeof createProjectPlugins> | undefined
  const dispatcher = createDispatcher({
    project, storage, board, claudeBroker,
    getSettings: () => defaultSettings(),
    dispatchProfile: () => ({ model: "opus" }),
    pluginSystemPrompt: (kind) => plugins?.systemPrompt(kind) ?? "",
  })
  const starter = createHeldThreadStarter({ dispatcher, board })
  plugins = createProjectPlugins({
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
  const router = createRouter(ctx)
  const app = new Hono()
  mountRouter(app, "/_frizz/rpc", router as never)
  const call = async (name: string, input?: unknown, method: "GET" | "POST" = "POST") => {
    const response = method === "POST"
      ? await app.request(`/_frizz/rpc/${name}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(input ?? null) })
      : await app.request(`/_frizz/rpc/${name}${input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`}`)
    return { status: response.status, body: (await response.json()) as { result?: unknown; error?: string } }
  }
  return {
    registry, storage, router, plugins, ctx, spawned, call,
    close: () => {
      registry.close()
      storage.close()
      rmSync(dir, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    },
  }
}

test("a plugin's procedures answer at /_frizz/rpc/plugin.<id>.<name>, validated by its own schema, listed in __procedures", async () => {
  const h = await harness()
  try {
    const listed = (await h.call("__procedures", undefined, "GET")).body as Record<string, string>
    assert.equal(listed["plugin.probe.note"], "mutation")
    assert.equal(listed["plugin.probe.held"], "query")

    const ok = await h.call("plugin.probe.note", { slug: "nowhere", text: "hi" })
    assert.equal(ok.status, 200)
    assert.deepEqual(ok.body.result, { ok: true })
    assert.deepEqual(probe().find((entry) => entry[0] === "note"), ["note", "nowhere", "hi", "plugin-project"], "handed the project's host")

    const invalid = await h.call("plugin.probe.note", { slug: "nowhere" })
    assert.equal(invalid.status, 400, "the plugin's schema refuses what it does not accept")

    const refused = await h.call("plugin.probe.no", undefined, "GET")
    assert.equal(refused.status, 500)
    assert.equal(refused.body.error, "Not today")
    assert.equal(h.registry.get("probe")!.strikes, 0, "a refusal is an answer, not a fault")

    for (let i = 0; i < 3; i++) assert.equal((await h.call("plugin.probe.boom", undefined, "GET")).body.error, "kaboom")
    assert.equal(h.registry.get("probe")!.state, "failed", "three throws fail the plugin")
    const after = await h.call("plugin.probe.held", undefined, "GET")
    assert.match(after.body.error ?? "", /The probe plugin is not running: procedure boom threw 3 times/)
  } finally { h.close() }
})

test("a human verb a plugin marks `human` stamps interacted_at and is a humanAct, like base's own", async () => {
  const h = await harness()
  try {
    const { slug } = (await h.call("plugin.probe.create", { prompt: "Remember the cache key" })).body.result as { slug: string }
    assert.equal(h.storage.getSession(slug)!.interacted_at ?? null, null)
    await h.call("plugin.probe.note", { slug, text: "edited" })
    assert.ok(h.storage.getSession(slug)!.interacted_at, "stamped")
    await h.router.renameThread.handler({ input: { slug, title: "Renamed" } } as never).catch(() => {})
    await settle()
    const acts = probe().filter((entry) => entry[0] === "humanAct")
    assert.deepEqual(acts[0], ["humanAct", slug, "plugin.probe.note"])
    assert.ok(acts.some((entry) => entry[2] === "renameThread"), "base's human verbs reach plugins too")
  } finally { h.close() }
})

test("a thread a plugin writes down is held by it, spawns nothing, and its first message goes to the plugin's onSend", async () => {
  const h = await harness()
  try {
    const { slug, sessionId } = (await h.call("plugin.probe.create", { prompt: "Look into the flaky test" })).body.result as { slug: string; sessionId: string }
    const row = h.storage.getSession(slug)!
    assert.equal(row.held_by, "probe")
    assert.equal(row.lazy_prompt, "Look into the flaky test", "the downgrade shadow: an older server reads it as unstarted")
    assert.equal(h.spawned.length, 0)
    assert.deepEqual((await h.call("plugin.probe.held", undefined, "GET")).body.result, [slug])

    await h.router.followUp.handler({ input: { slug, sessionId, message: "go" } } as never)
    assert.deepEqual(probe().find((entry) => entry[0] === "onSend"), ["onSend", slug, "go"])
    assert.equal(h.spawned.length, 1)
    assert.match(h.spawned[0]!.prompt, /started: go/, "the plugin chose what it started with")
    assert.equal(h.spawned[0]!.sessionId, sessionId, "on the row's own session")
    assert.equal(h.storage.getSession(slug)!.held_by, null)
  } finally { h.close() }
})

test("when the holder's onSend throws, base starts the thread on the message; a refusal reaches the sender", async () => {
  const h = await harness()
  try {
    const a = (await h.call("plugin.probe.create", { prompt: "one" })).body.result as { slug: string; sessionId: string }
    await h.router.followUp.handler({ input: { slug: a.slug, sessionId: a.sessionId, message: "throw" } } as never)
    assert.equal(h.spawned.length, 1)
    assert.match(h.spawned[0]!.prompt, /throw/)
    assert.equal(h.registry.get("probe")!.strikes, 1)

    const b = (await h.call("plugin.probe.create", { prompt: "two" })).body.result as { slug: string; sessionId: string }
    await assert.rejects(h.router.followUp.handler({ input: { slug: b.slug, sessionId: b.sessionId, message: "refuse" } } as never), /Not now/)
    assert.equal(h.spawned.length, 1, "refused: nothing started")
    assert.equal(h.storage.getSession(b.slug)!.held_by, "probe")
    assert.equal(h.registry.get("probe")!.strikes, 1, "and no strike")
  } finally { h.close() }
})

test("a held thread whose holder is gone or failed starts on its next message, so none is stranded", async () => {
  const h = await harness()
  try {
    const orphan = (await h.call("plugin.probe.create", { prompt: "orphan" })).body.result as { slug: string; sessionId: string }
    // The plugin that wrote it was uninstalled: the row names a holder nobody loaded.
    h.storage.upsertSession({ ...h.storage.getSession(orphan.slug)!, held_by: "uninstalled" })
    await h.router.followUp.handler({ input: { slug: orphan.slug, sessionId: orphan.sessionId, message: "carry on" } } as never)
    assert.equal(h.spawned.length, 1)
    assert.match(h.spawned[0]!.prompt, /carry on/)
    assert.equal(h.storage.getSession(orphan.slug)!.held_by, null)

    const held = (await h.call("plugin.probe.create", { prompt: "held" })).body.result as { slug: string; sessionId: string }
    h.registry.guard.fail(h.registry.get("probe")!, "broken on purpose")
    await h.router.followUp.handler({ input: { slug: held.slug, sessionId: held.sessionId, message: "still works" } } as never)
    assert.equal(h.spawned.length, 2)
    assert.match(h.spawned[1]!.prompt, /still works/)
    assert.equal(probe().filter((entry) => entry[0] === "onSend").length, 0, "a failed plugin is never called")
  } finally { h.close() }
})

test("threadView runs over every thread, writes view.plugins[id], and a throw draws base's view", async () => {
  const h = await harness()
  try {
    const { slug } = (await h.call("plugin.probe.create", { prompt: "note" })).body.result as { slug: string }
    const row = h.storage.getSession(slug)!
    const base = { id: slug, needsYou: false } as unknown as ThreadView
    const drawn = h.plugins.threadView(base, row)
    assert.equal(drawn.needsYou, true)
    assert.deepEqual(drawn.plugins, { probe: { marked: true } })
    const exploding = { id: "explodes", needsYou: false } as unknown as ThreadView
    assert.equal(h.plugins.threadView(exploding, row), exploding)
    assert.equal(h.registry.get("probe")!.strikes, 1)
  } finally { h.close() }
})

test("threadDone and rest are read off what the board drew; a first sighting only primes", async () => {
  const h = await harness()
  try {
    const view = (patch: Partial<ThreadView>) => ({ id: "t", kind: "session", sessionId: "s1", archived: false, runtime: "running", ...patch }) as ThreadView
    h.plugins.observe([view({ runtime: "turn-idle", lastAssistantAt: "2026-10-06T10:00:00.000Z" })])
    await settle()
    assert.deepEqual(probe().filter((entry) => entry[0] === "rest" || entry[0] === "done"), [], "booting onto a rested thread is not watching it rest")
    h.plugins.observe([view({ runtime: "running" })])
    h.plugins.observe([view({ runtime: "turn-idle", lastAssistantAt: "2026-10-06T10:05:00.000Z" })])
    h.plugins.observe([view({ runtime: "turn-idle", lastAssistantAt: "2026-10-06T10:05:00.000Z" })])
    h.plugins.observe([view({ runtime: "turn-idle", lastAssistantAt: "2026-10-06T10:05:00.000Z", archived: true })])
    await settle()
    assert.deepEqual(probe().filter((entry) => entry[0] === "rest" || entry[0] === "done"), [
      ["rest", "t", "2026-10-06T10:05:00.000Z"],
      ["done", "t"],
    ])
  } finally { h.close() }
})

test("deleting a thread tells the plugins; systemPrompt and project() reach every running plugin", async () => {
  const h = await harness()
  try {
    const { slug } = (await h.call("plugin.probe.create", { prompt: "to delete" })).body.result as { slug: string }
    assert.equal(await deleteOwnedThread(h.ctx, slug), true)
    await settle()
    assert.deepEqual(probe().find((entry) => entry[0] === "deleted"), ["deleted", slug, "probe"])
    assert.equal(h.plugins.systemPrompt("claude"), "The probe plugin is watching.")
    assert.equal(h.plugins.systemPrompt("codex"), "")
    h.plugins.opened()
    assert.deepEqual(probe().find((entry) => entry[0] === "project"), ["project", "plugin-project"])
  } finally { h.close() }
})

test("a plugin's systemPrompt reaches the worker's system prompt, after Frizz's own, and leaves the user prompt alone", async () => {
  const h = await harness()
  try {
    await h.ctx.dispatcher.dispatch({ prompt: "Fix the flaky test" })
    const system = h.spawned[0]!.appendSystemPrompt ?? ""
    assert.ok(system.endsWith("The probe plugin is watching."), "appended last")
    assert.ok(system.length > "The probe plugin is watching.".length, "after the worker contract, not instead of it")
    assert.doesNotMatch(h.spawned[0]!.prompt, /probe plugin/)
    h.registry.guard.fail(h.registry.get("probe")!, "off")
    await h.ctx.dispatcher.dispatch({ prompt: "Another" })
    assert.doesNotMatch(h.spawned[1]!.appendSystemPrompt ?? "", /probe plugin/, "a failed plugin adds nothing")
  } finally { h.close() }
})
