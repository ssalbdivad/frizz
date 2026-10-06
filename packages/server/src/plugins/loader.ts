import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { z } from "zod"
import {
  BASE_HOLDERS,
  FrizzPluginManifest,
  PLUGIN_API,
  type PluginsReport,
  type PluginSummary,
} from "@frizz/shared"
import { frizzPaths } from "../frizz-paths.ts"
import { readMachineConfig, writeMachineConfig } from "../machine-config.ts"
import { log as frizzLog } from "../logging.ts"
import type { FrizzPlugin, PluginDatabase, PluginHooks, PluginHost } from "./api.ts"
import { createPluginGuard, pluginRefusal, type GuardedPlugin, type PluginGuard } from "./guard.ts"
import { openPluginDatabase, pluginDataDir } from "./db.ts"
import { contentVersion, readPluginWebAsset, type WebAssetResult } from "./web-assets.ts"

// THE PLUGIN LOADER (plans/upstream-superset.md §7): what is a plugin on this machine, and is it running.
//
// WHERE. `<data>/user-plugins/<id>/` — machine-wide, never a project checkout: a repository someone
// cloned must not be able to run code in the control plane by carrying a directory. And not
// `<data>/plugins`, which is already taken: on a legacy install `<cache>` IS `<data>` (`~/.frizz`), and
// `<cache>/plugins` is the cc-worker plugin's stage root (stable-plugin-path.ts).
//
// WHAT. A directory whose package.json carries a `frizzPlugin` manifest `{id, api, server, web, claude}`.
// It is enabled by being there. `plugins.disabled` in the machine config turns one off without moving it,
// and `FRIZZ_PLUGINS_OFF=1` is safe mode: nothing under the directory is even read.
//
// HOW. The manifest is read without running anything. The server half is `await import()`ed on Node's
// own type stripping (22.18+; on 22.13–22.17 a `.ts` server half reports "needs Node 22.18 or newer"
// and boot goes on), then its `setup(host)` runs, bounded at 5s. Every way this can go wrong — a missing
// file, a bad manifest, another plugin API, a throw at import or in setup, the timeout — leaves that ONE
// plugin `failed` or `incompatible` with a reason Settings → Frizz plugins shows, and boot continues. A
// plugin can never refuse a boot.

export const PLUGINS_OFF_ENV = "FRIZZ_PLUGINS_OFF"
export const PLUGIN_SETUP_TIMEOUT_MS = 5_000
/** The machine-config record: `{ "disabled": ["lazy"] }` turns a plugin off where it stands. */
export const PLUGINS_CONFIG_KEY = "plugins"
const PluginsConfig = z.object({ disabled: z.array(z.string()).default([]) }).passthrough()
const PROCEDURE_NAME = /^[a-zA-Z][a-zA-Z0-9]{0,63}$/

export function userPluginsDir(data: string): string {
  return join(data, "user-plugins")
}

export interface PluginRecord extends GuardedPlugin {
  readonly id: string
  /** The plugin's directory, symlinks resolved — the boundary nothing it serves may leave. */
  readonly dir: string
  version?: string
  description?: string
  /** What setup() returned; empty until it has, and for every plugin that is not active. */
  hooks: PluginHooks
  server?: string
  web?: string
  claude?: string
}

export interface PluginRegistry {
  /** Safe mode: FRIZZ_PLUGINS_OFF=1. Nothing was read. */
  readonly off: boolean
  /** `<data>/user-plugins`. */
  readonly root: string
  readonly guard: PluginGuard
  records(): readonly PluginRecord[]
  /** The plugins running now. A plugin that fails later drops out of this on its own. */
  active(): readonly PluginRecord[]
  get(id: string): PluginRecord | undefined
  /** Settings → Frizz plugins, and the page's loader. */
  report(): PluginsReport
  /** Claude Code plugin directories of every running plugin, for the SDK's `plugins`. */
  claudeDirs(): string[]
  /** `/_frizz/plugins/<id>/<path>`. */
  webAsset(id: string, relPath: string): WebAssetResult
  /** The plugin's settings record through its own schema, or its defaults. Undefined: it keeps none. */
  readSettings(id: string): unknown
  /** Validated by the plugin's schema; a value that fails it is refused with zod's reading. */
  writeSettings(id: string, value: unknown): void
  /** Stop the timers plugins set through the host and close their databases. */
  close(): void
}

export interface LoadPluginsOptions {
  /** The home whose machine config (`plugins.disabled`, `plugin:<id>`) and data root apply. */
  home: string
  env?: NodeJS.ProcessEnv
  /** Overrides `<data>` (tests). */
  data?: string
  setupTimeoutMs?: number
  /** Whether this Node strips types on import (`process.features.typescript`). Injected by tests. */
  typeStripping?: boolean
}

function nodeStripsTypes(): boolean {
  const flag = (process.features as { typescript?: unknown }).typescript
  return flag === "strip" || flag === "transform" || flag === true
}

/** A manifest path, resolved, or undefined when it would leave the plugin's directory. */
function inside(dir: string, path: string): string | undefined {
  const absolute = resolve(dir, path)
  const rel = relative(dir, absolute)
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? absolute : undefined
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function loadPlugins(options: LoadPluginsOptions): Promise<PluginRegistry> {
  const env = options.env ?? process.env
  const data = options.data ?? frizzPaths({ home: options.home, env }).data
  const root = userPluginsDir(data)
  const off = env[PLUGINS_OFF_ENV] === "1"
  const records: PluginRecord[] = []
  const guard = createPluginGuard()
  const databases = new Map<string, { db: PluginDatabase; close(): void }>()
  const timers = new Set<NodeJS.Timeout>()
  const stripsTypes = options.typeStripping ?? nodeStripsTypes()

  const registry: PluginRegistry = {
    off,
    root,
    guard,
    records: () => records,
    active: () => records.filter((record) => record.state === "active"),
    get: (id) => records.find((record) => record.id === id),
    report: () => ({ api: PLUGIN_API, off, root, plugins: records.map(summary) }),
    claudeDirs: () => records.flatMap((record) => (record.state === "active" && record.claude ? [record.claude] : [])),
    webAsset(id, relPath) {
      const record = records.find((candidate) => candidate.id === id)
      if (!record || record.state !== "active") return { status: 404, message: "no such plugin running" }
      return readPluginWebAsset(record.dir, relPath)
    },
    readSettings(id) {
      const declared = records.find((record) => record.id === id)?.hooks.settings
      if (!declared) return undefined
      return readMachineConfig(options.home, `plugin:${id}`, declared.schema) ?? declared.defaults
    },
    writeSettings(id, value) {
      const declared = records.find((record) => record.id === id)?.hooks.settings
      if (!declared) throw new Error(`The ${id} plugin keeps no settings`)
      const parsed = declared.schema.safeParse(value)
      if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => issue.message).join("; "))
      writeMachineConfig(options.home, `plugin:${id}`, parsed.data)
    },
    close() {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      for (const { close } of databases.values()) {
        try { close() } catch { /* already closed */ }
      }
      databases.clear()
    },
  }

  function summary(record: PluginRecord): PluginSummary {
    const active = record.state === "active"
    let web: PluginSummary["web"]
    if (active && record.web) {
      try {
        web = { url: `/_frizz/plugins/${record.id}/${relative(record.dir, record.web).split("\\").join("/")}?v=${contentVersion(record.web)}` }
      } catch {
        web = undefined
      }
    }
    return {
      id: record.id,
      dir: record.dir,
      ...(record.version ? { version: record.version } : {}),
      ...(record.description ? { description: record.description } : {}),
      state: record.state,
      ...(record.reason ? { reason: record.reason } : {}),
      procedures: Object.entries(record.hooks.procedures ?? {}).map(([name, proc]) => ({ name, kind: proc.kind, human: proc.human === true })),
      mcpTools: [],
      claudeDirs: record.claude ? [record.claude] : [],
      ...(web ? { web } : {}),
      settings: record.hooks.settings !== undefined,
    }
  }

  if (off) {
    frizzLog.info("plugins", `${PLUGINS_OFF_ENV}=1: Frizz plugins are off for this run`)
    return registry
  }

  let entries: string[]
  try {
    entries = readdirSync(root).filter((name) => !name.startsWith(".")).sort()
  } catch {
    return registry // no directory, no plugins
  }
  const disabled = new Set(readMachineConfig(options.home, PLUGINS_CONFIG_KEY, PluginsConfig)?.disabled ?? [])
  for (const name of entries) {
    const record = readRecord(name)
    if (record) records.push(record)
  }

  function readRecord(name: string): PluginRecord | undefined {
    let dir: string
    try {
      dir = realpathSync(join(root, name))
      if (!statSync(dir).isDirectory()) return undefined
    } catch {
      // A link to nothing: say so, since the operator put it there to be a plugin.
      return { id: name, dir: join(root, name), state: "failed", reason: "Its directory is a broken link", strikes: 0, hooks: {} }
    }
    const failed = (reason: string): PluginRecord => ({ id: name, dir, state: "failed", reason, strikes: 0, hooks: {} })
    let pkg: { version?: unknown; description?: unknown; frizzPlugin?: unknown }
    try {
      pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as typeof pkg
    } catch {
      return failed("No readable package.json")
    }
    if (pkg.frizzPlugin === undefined) return failed("Its package.json has no frizzPlugin manifest")
    const parsed = FrizzPluginManifest.safeParse(pkg.frizzPlugin)
    if (!parsed.success) {
      return failed(`Its frizzPlugin manifest is invalid: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`).join("; ")}`)
    }
    const manifest = parsed.data
    if (manifest.id !== name) return failed(`Its manifest names it "${manifest.id}", but it sits in user-plugins/${name}`)
    if ((BASE_HOLDERS as readonly string[]).includes(manifest.id)) return failed(`"${manifest.id}" is a name Frizz keeps for itself`)
    const record: PluginRecord = {
      id: manifest.id,
      dir,
      ...(typeof pkg.version === "string" ? { version: pkg.version } : {}),
      ...(typeof pkg.description === "string" ? { description: pkg.description } : {}),
      state: "active",
      strikes: 0,
      hooks: {},
    }
    for (const key of ["server", "web", "claude"] as const) {
      const path = manifest[key]
      if (path === undefined) continue
      const resolved = inside(dir, path)
      if (!resolved) return { ...record, state: "failed", reason: `Its ${key} path ${path} leaves the plugin's directory` }
      try {
        const stat = statSync(resolved)
        if (key === "claude" ? !stat.isDirectory() : !stat.isFile()) throw new Error("wrong kind")
      } catch {
        return { ...record, state: "failed", reason: `Its ${key} ${key === "claude" ? "directory" : "file"} ${path} does not exist` }
      }
      record[key] = resolved
    }
    if (disabled.has(record.id)) return { ...record, state: "disabled", reason: "Turned off in the machine config (plugins.disabled)" }
    // The one version check: written against another API, it cannot be trusted with this host.
    if (manifest.api !== PLUGIN_API) {
      return { ...record, state: "incompatible", reason: `Written for plugin API ${manifest.api}; this Frizz runs API ${PLUGIN_API}` }
    }
    if (record.server?.endsWith(".ts") && !stripsTypes) {
      return { ...record, state: "incompatible", reason: `Needs Node 22.18 or newer to load a .ts server half (this is ${process.version})` }
    }
    return record
  }

  function hostFor(record: PluginRecord): PluginHost {
    const scope = `plugin:${record.id}`
    const timer = (ms: number, fn: () => void | Promise<void>, repeat: boolean): (() => void) => {
      const tick = () => void guard.runAsync(record, repeat ? "every" : "after", async () => { await fn() }, () => undefined)
      const handle = repeat ? setInterval(tick, ms) : setTimeout(() => { timers.delete(handle); tick() }, ms)
      handle.unref?.()
      timers.add(handle)
      return () => {
        clearTimeout(handle)
        timers.delete(handle)
      }
    }
    return {
      id: record.id,
      api: PLUGIN_API,
      z,
      log: {
        info: (message) => frizzLog.info(scope, message),
        warn: (message) => frizzLog.warn(scope, message),
        error: (message) => frizzLog.error(scope, message),
      },
      db(migrations) {
        const open = databases.get(record.id)
        if (open) return open.db
        const opened = openPluginDatabase(join(pluginDataDir(data), `${record.id}.db`), migrations)
        databases.set(record.id, opened)
        return opened.db
      },
      settings: {
        read: (schema) => readMachineConfig(options.home, `plugin:${record.id}`, schema),
        write: (value) => writeMachineConfig(options.home, `plugin:${record.id}`, value),
      },
      every: (ms, fn) => timer(ms, fn, true),
      after: (ms, fn) => timer(ms, fn, false),
      refuse(message) {
        throw pluginRefusal(message)
      },
    }
  }

  async function start(record: PluginRecord): Promise<void> {
    const server = record.server!
    let plugin: FrizzPlugin | undefined
    try {
      const module = (await import(pathToFileURL(server).href)) as { default?: FrizzPlugin }
      plugin = module.default
    } catch (error) {
      guard.fail(record, `Could not load ${relative(record.dir, server)}: ${errorText(error)}`)
      return
    }
    if (!plugin || typeof plugin.setup !== "function") {
      guard.fail(record, `${relative(record.dir, server)} has no default export with a setup()`)
      return
    }
    const timeoutMs = options.setupTimeoutMs ?? PLUGIN_SETUP_TIMEOUT_MS
    let timeout: NodeJS.Timeout | undefined
    const timedOut = Symbol("timed out")
    try {
      const hooks = await Promise.race([
        Promise.resolve().then(() => plugin.setup(hostFor(record))),
        new Promise<typeof timedOut>((done) => {
          timeout = setTimeout(() => done(timedOut), timeoutMs)
          timeout.unref?.()
        }),
      ])
      if (hooks === timedOut) {
        guard.fail(record, `setup() took longer than ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`}`)
        return
      }
      const procedures = hooks?.procedures ?? {}
      for (const [name, proc] of Object.entries(procedures)) {
        if (!PROCEDURE_NAME.test(name)) throw new Error(`procedure "${name}" is not a plain name`)
        if (proc.kind !== "query" && proc.kind !== "mutation") throw new Error(`procedure "${name}" has no kind (query or mutation)`)
        if (typeof proc.handler !== "function") throw new Error(`procedure "${name}" has no handler`)
      }
      record.hooks = hooks ?? {}
      frizzLog.info(`plugin:${record.id}`, `loaded from ${record.dir}`)
    } catch (error) {
      guard.fail(record, `setup() threw: ${errorText(error)}`)
    } finally {
      clearTimeout(timeout)
    }
  }

  // In parallel, so the 5s bound is the boot's worst case however many plugins there are.
  await Promise.all(records.filter((record) => record.state === "active" && record.server).map(start))
  for (const record of records) {
    if (record.state !== "active" && record.state !== "failed") frizzLog.warn(`plugin:${record.id}`, `${record.state}: ${record.reason}`)
  }
  return registry
}

/** A registry with nothing in it — a context built without the server (tests), or before plugins load. */
export function emptyPluginRegistry(): PluginRegistry {
  const guard = createPluginGuard()
  return {
    off: false,
    root: "",
    guard,
    records: () => [],
    active: () => [],
    get: () => undefined,
    report: () => ({ api: PLUGIN_API, off: false, root: "", plugins: [] }),
    claudeDirs: () => [],
    webAsset: () => ({ status: 404, message: "no such plugin running" }),
    readSettings: () => undefined,
    writeSettings: (id) => { throw new Error(`The ${id} plugin keeps no settings`) },
    close: () => {},
  }
}
