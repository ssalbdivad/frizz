// FRIZZ PLUGINS — the loader, the guard, a plugin's database and its served web half, against real files
// in a sandbox home: real package.json manifests, real `.ts` server halves imported on Node's own type
// stripping, the real machine config. What these pin is that a plugin can never refuse a boot — every way
// one goes wrong leaves THAT plugin failed or incompatible with a reason, and the others load.
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { PLUGIN_API } from "@frizz/shared"
import { frizzPaths } from "../frizz-paths.ts"
import { writeMachineConfig } from "../machine-config.ts"
import { loadPlugins, userPluginsDir, type PluginRegistry } from "./loader.ts"
import { createPluginGuard, pluginRefusal, PLUGIN_STRIKES, type GuardedPlugin } from "./guard.ts"
import { openPluginDatabase } from "./db.ts"
import { readPluginWebAsset } from "./web-assets.ts"

interface Sandbox {
  home: string
  root: string
  data: string
  plugin(id: string, files: Record<string, string>, manifest?: Record<string, unknown> | null): string
  close(): void
}

function sandbox(): Sandbox {
  const home = mkdtempSync(join(tmpdir(), "frizz-plugins-"))
  const data = frizzPaths({ home, env: {} }).data
  const root = userPluginsDir(data)
  mkdirSync(root, { recursive: true })
  return {
    home,
    root,
    data,
    plugin(id, files, manifest = { id, api: PLUGIN_API, server: "./server.ts" }) {
      const dir = join(root, id)
      mkdirSync(dir, { recursive: true })
      const pkg: Record<string, unknown> = { name: `frizz-plugin-${id}`, version: "0.1.0", type: "module" }
      if (manifest !== null) pkg.frizzPlugin = manifest
      writeFileSync(join(dir, "package.json"), JSON.stringify(pkg))
      for (const [name, body] of Object.entries(files)) {
        mkdirSync(join(dir, name, ".."), { recursive: true })
        writeFileSync(join(dir, name), body)
      }
      return dir
    },
    close: () => rmSync(home, { recursive: true, force: true }),
  }
}

const SERVER_OK = `
const plugin = {
  setup(host) {
    return {
      procedures: {
        ping: { kind: "query", handler: () => "pong" },
        poke: { kind: "mutation", human: true, input: host.z.object({ slug: host.z.string() }), handler: (input) => input.slug },
      },
    }
  },
}
export default plugin
`

async function load(s: Sandbox, extra: Partial<Parameters<typeof loadPlugins>[0]> = {}): Promise<PluginRegistry> {
  return loadPlugins({ home: s.home, env: {}, ...extra })
}

test("a plugin in user-plugins loads: its server half is imported, setup() runs, and the report names what it adds", async () => {
  const s = sandbox()
  try {
    s.plugin("hello", { "server.ts": `import type { FrizzPlugin } from "nowhere"\n${SERVER_OK}` })
    const registry = await load(s)
    const hello = registry.get("hello")!
    assert.equal(hello.state, "active", hello.reason)
    const report = registry.report()
    assert.equal(report.api, PLUGIN_API)
    assert.equal(report.off, false)
    assert.equal(report.root, s.root)
    assert.deepEqual(report.plugins[0]!.procedures, [
      { name: "ping", kind: "query", human: false },
      { name: "poke", kind: "mutation", human: true },
    ])
    assert.deepEqual(report.plugins[0]!.mcpTools, [])
    assert.equal(report.plugins[0]!.version, "0.1.0")
    registry.close()
  } finally { s.close() }
})

test("a plugin that cannot run is reported with its reason, and never stops the others loading", async () => {
  const s = sandbox()
  try {
    s.plugin("good", { "server.ts": SERVER_OK })
    s.plugin("nopkg", {}, null)
    mkdirSync(join(s.root, "bare"))
    s.plugin("badmanifest", {}, { id: "badmanifest", api: "one" })
    s.plugin("elsewhere", { "server.ts": SERVER_OK }, { id: "other-name", api: PLUGIN_API, server: "./server.ts" })
    s.plugin("schedules", { "server.ts": SERVER_OK })
    s.plugin("future", { "server.ts": SERVER_OK }, { id: "future", api: PLUGIN_API + 1, server: "./server.ts" })
    s.plugin("missing", {}, { id: "missing", api: PLUGIN_API, server: "./server.ts" })
    s.plugin("escape", {}, { id: "escape", api: PLUGIN_API, server: "../good/server.ts" })
    s.plugin("syntax", { "server.ts": "export default {{{" })
    s.plugin("noexport", { "server.ts": "export const x = 1" })
    s.plugin("throws", { "server.ts": "export default { setup() { throw new Error('no config') } }" })
    s.plugin("rejects", { "server.ts": "export default { async setup() { throw new Error('async no') } }" })
    s.plugin("badproc", { "server.ts": "export default { setup() { return { procedures: { 'a.b': { kind: 'query', handler() {} } } } } }" })
    const registry = await load(s)
    const state = (id: string) => [registry.get(id)?.state, registry.get(id)?.reason]
    assert.equal(registry.get("good")?.state, "active")
    assert.deepEqual(state("nopkg"), ["failed", "Its package.json has no frizzPlugin manifest"])
    assert.deepEqual(state("bare"), ["failed", "No readable package.json"])
    assert.match(String(state("badmanifest")[1]), /manifest is invalid: api:/)
    assert.match(String(state("elsewhere")[1]), /names it "other-name", but it sits in user-plugins\/elsewhere/)
    assert.match(String(state("schedules")[1]), /Frizz keeps for itself/)
    assert.deepEqual(state("future"), ["incompatible", `Written for plugin API ${PLUGIN_API + 1}; this Frizz runs API ${PLUGIN_API}`])
    assert.match(String(state("missing")[1]), /server file \.\/server\.ts does not exist/)
    assert.match(String(state("escape")[1]), /leaves the plugin's directory/)
    assert.match(String(state("syntax")[1]), /^Could not load server\.ts:/)
    assert.match(String(state("noexport")[1]), /no default export with a setup\(\)/)
    assert.deepEqual(state("throws"), ["failed", "setup() threw: no config"])
    assert.deepEqual(state("rejects"), ["failed", "setup() threw: async no"])
    assert.match(String(state("badproc")[1]), /procedure "a\.b" is not a plain name/)
    // A failed plugin contributes nothing: no procedures, no web half.
    assert.deepEqual(registry.report().plugins.find((p) => p.id === "throws")?.procedures, [])
    registry.close()
  } finally { s.close() }
})

test("setup() is bounded at the timeout: one that never settles fails the plugin and boot goes on", async () => {
  const s = sandbox()
  try {
    s.plugin("slow", { "server.ts": "export default { setup() { return new Promise(() => {}) } }" })
    s.plugin("good", { "server.ts": SERVER_OK })
    const started = Date.now()
    const registry = await load(s, { setupTimeoutMs: 150 })
    assert.ok(Date.now() - started < 2_000, "the bound, not the plugin, decides how long boot waits")
    assert.equal(registry.get("slow")?.state, "failed")
    assert.equal(registry.get("slow")?.reason, "setup() took longer than 150ms")
    assert.equal(registry.get("good")?.state, "active")
    registry.close()
  } finally { s.close() }
})

test("safe mode reads nothing; plugins.disabled turns one off where it stands", async () => {
  const s = sandbox()
  try {
    // Importing this would write a marker; safe mode must not even import it.
    const marker = join(s.home, "imported")
    s.plugin("loud", { "server.ts": `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "x"); export default { setup() {} }` })
    s.plugin("quiet", { "server.ts": SERVER_OK })
    const off = await load(s, { env: { FRIZZ_PLUGINS_OFF: "1" } })
    assert.equal(off.off, true)
    assert.deepEqual(off.records(), [])
    assert.deepEqual(off.report().plugins, [])
    assert.equal(existsSync(marker), false)

    writeMachineConfig(s.home, "plugins", { disabled: ["loud"] })
    const registry = await load(s)
    assert.equal(registry.get("loud")?.state, "disabled")
    assert.equal(registry.get("quiet")?.state, "active")
    assert.equal(existsSync(marker), false, "a disabled plugin is never imported")
    registry.close()
  } finally { s.close() }
})

test("a .ts server half on a Node without type stripping says which Node it needs, and boot goes on", async () => {
  const s = sandbox()
  try {
    s.plugin("typed", { "server.ts": SERVER_OK })
    s.plugin("plain", { "server.js": SERVER_OK }, { id: "plain", api: PLUGIN_API, server: "./server.js" })
    const registry = await load(s, { typeStripping: false })
    assert.equal(registry.get("typed")?.state, "incompatible")
    assert.match(String(registry.get("typed")?.reason), /^Needs Node 22\.18 or newer/)
    assert.equal(registry.get("plain")?.state, "active", "a .js server half needs no stripping")
    registry.close()
  } finally { s.close() }
})

test("the guard: a throw returns the fallback, the third fails the plugin, and a failed plugin is never called again", async () => {
  const guard = createPluginGuard()
  const plugin: GuardedPlugin = { id: "flaky", state: "active", strikes: 0 }
  let calls = 0
  const boom = () => { calls++; throw new Error("bad row") }
  for (let i = 1; i < PLUGIN_STRIKES; i++) {
    assert.equal(guard.run(plugin, "threadView", boom, "fallback"), "fallback")
    assert.equal(plugin.state, "active", `strike ${i} of ${PLUGIN_STRIKES} keeps it running`)
  }
  assert.equal(await guard.runAsync(plugin, "onSend", async () => boom(), () => "async fallback"), "async fallback")
  assert.equal(plugin.state, "failed")
  assert.equal(plugin.reason, `onSend threw ${PLUGIN_STRIKES} times; the last: bad row`)
  assert.equal(guard.run(plugin, "threadView", boom, "fallback"), "fallback")
  assert.equal(calls, PLUGIN_STRIKES, "a failed plugin's hooks are not called")
  await assert.rejects(guard.procedure(plugin, "procedure ping", () => "pong"), /The flaky plugin is not running: onSend threw/)
})

test("a procedure's error reaches the caller; a refusal is an answer and never a strike", async () => {
  const guard = createPluginGuard()
  const plugin: GuardedPlugin = { id: "notes", state: "active", strikes: 0 }
  for (let i = 0; i < PLUGIN_STRIKES + 2; i++) {
    await assert.rejects(guard.procedure(plugin, "procedure start", () => { throw pluginRefusal("This thread has already started") }), /already started/)
  }
  assert.equal(plugin.strikes, 0)
  assert.equal(plugin.state, "active")
  await assert.rejects(guard.procedure(plugin, "procedure start", () => { throw new Error("oops") }), /oops/)
  assert.equal(plugin.strikes, 1)
})

test("host timers run inside the guard: a throwing callback is a strike, never an uncaught exception", async () => {
  const s = sandbox()
  try {
    s.plugin("ticker", {
      "server.ts": `export default { setup(host) { host.after(1, () => { throw new Error("tick") }); host.after(2, () => { throw new Error("tock") }) } }`,
    })
    const registry = await load(s)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(registry.get("ticker")?.strikes, 2)
    assert.equal(registry.get("ticker")?.state, "active")
    registry.close()
  } finally { s.close() }
})

test("a plugin's database migrates by user_version: each step once, the list append-only", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-plugin-db-"))
  try {
    const file = join(dir, "plugin-data", "notes.db")
    const first = openPluginDatabase(file, ["CREATE TABLE note (slug TEXT PRIMARY KEY, body TEXT)"])
    first.db.prepare("INSERT INTO note VALUES (?, ?)").run("a", "kept")
    first.close()
    // A later version appends a step; the first does not run again (it would fail: the table exists).
    const second = openPluginDatabase(file, ["CREATE TABLE note (slug TEXT PRIMARY KEY, body TEXT)", "ALTER TABLE note ADD COLUMN at TEXT"])
    assert.deepEqual(second.db.prepare("SELECT slug, body, at FROM note").all(), [{ slug: "a", body: "kept", at: null }])
    assert.deepEqual(second.db.prepare("PRAGMA user_version").get(), { user_version: 2 })
    second.close()
    // A step that throws leaves the file at the last good one, to retry on the next open.
    assert.throws(() => openPluginDatabase(file, ["x", "y", "NOT SQL"]), /syntax error/)
    const third = openPluginDatabase(file, ["x", "y"])
    assert.deepEqual(third.db.prepare("PRAGMA user_version").get(), { user_version: 2 })
    third.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("the web half is served stripped of its types, and nothing outside the plugin's directory is served", () => {
  const s = sandbox()
  try {
    const dir = s.plugin("webby", {
      "web.ts": "import type { X } from './x.ts'\nexport function activate(host: { h: unknown }): void {}\n",
      "notes.md": "# not a script",
    }, { id: "webby", api: PLUGIN_API, web: "./web.ts" })
    writeFileSync(join(s.root, "secret.ts"), "export const secret = 1")
    symlinkSync(join(s.root, "secret.ts"), join(dir, "link.ts"))
    const served = readPluginWebAsset(dir, "web.ts")
    assert.equal(served.status, 200)
    assert.ok(served.status === 200 && !served.body.includes("import type") && !served.body.includes(": {") && served.body.includes("export function activate(host"))
    assert.equal(readPluginWebAsset(dir, "../secret.ts").status, 400)
    assert.equal(readPluginWebAsset(dir, "%2e%2e/secret.ts").status, 400)
    assert.equal(readPluginWebAsset(dir, "link.ts").status, 404, "a link out of the directory is refused")
    assert.equal(readPluginWebAsset(dir, "notes.md").status, 404, "only scripts")
    assert.equal(readPluginWebAsset(dir, "absent.ts").status, 404)
  } finally { s.close() }
})

test("the report hands the page a content-hashed URL for a running plugin's web half", async () => {
  const s = sandbox()
  try {
    s.plugin("webby", { "web.ts": "export function activate() {}\n" }, { id: "webby", api: PLUGIN_API, web: "./web.ts" })
    const registry = await load(s)
    const url = registry.report().plugins[0]!.web?.url
    assert.match(String(url), /^\/_frizz\/plugins\/webby\/web\.ts\?v=[0-9a-f]{12}$/)
    assert.equal(registry.webAsset("webby", "web.ts").status, 200)
    assert.equal(registry.webAsset("nobody", "web.ts").status, 404)
    registry.close()
  } finally { s.close() }
})
