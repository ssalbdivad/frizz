import { log as frizzLog } from "../logging.ts"

// EVERY PLUGIN HOOK RUNS INSIDE THE GUARD (plans/upstream-superset.md §7, "Isolation").
//
// A plugin is the operator's own code running in the control plane, with no sandbox: the guard is what
// keeps a bug in it from becoming a bug in Frizz. A hook that throws returns the fallback the call site
// chose — the board reading it would have drawn without the plugin, base's own start for a held thread —
// so the surface it sits on keeps working, and the throw is logged under `plugin:<id>` where an operator
// greps for it. Three throws and the plugin is FAILED for the rest of this process: every later hook
// returns its fallback without calling in, and Settings → Frizz plugins shows the reason. Three rather
// than one because a hook can trip over one malformed row and still serve every other; three rather than
// many because a hook that throws on every board build would otherwise log on every board build.
//
// What it cannot catch, and the reason `host.every` / `host.after` exist: a throw inside a timer or a
// stray promise the plugin started on its own reaches the process's `uncaughtException` handler, which
// ends the control plane (dev-child.ts). The supervisor brings it back; `FRIZZ_PLUGINS_OFF=1` keeps the
// next one plugin-free while the plugin is fixed.

export const PLUGIN_STRIKES = 3

/** What the guard needs of a plugin's record. */
export interface GuardedPlugin {
  readonly id: string
  state: "active" | "failed" | "disabled" | "incompatible"
  reason?: string
  strikes: number
}

const REFUSAL = Symbol.for("frizz.plugin.refusal")

/** An error a plugin raised ON PURPOSE (`host.refuse`): an answer for the human, never a strike. */
export function pluginRefusal(message: string): Error {
  const error = new Error(message)
  Object.defineProperty(error, REFUSAL, { value: true })
  return error
}

export function isPluginRefusal(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as Record<symbol, unknown>)[REFUSAL] === true
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface PluginGuard {
  /** Run a sync hook; a throw returns `fallback`. A failed plugin is never called. */
  run<T>(plugin: GuardedPlugin, hook: string, fn: () => T, fallback: T): T
  /** Run an async hook; a throw or rejection runs `fallback`. A failed plugin is never called. */
  runAsync<T>(plugin: GuardedPlugin, hook: string, fn: () => Promise<T>, fallback: () => T | Promise<T>): Promise<T>
  /**
   * Run a procedure: its error REACHES the caller (the human reads it), and counts as a strike unless it
   * is a refusal. A failed plugin's procedure answers with the reason instead of running.
   */
  procedure<T>(plugin: GuardedPlugin, hook: string, fn: () => T | Promise<T>): Promise<T>
  /** Record one throw against `plugin`, failing it on the third. */
  strike(plugin: GuardedPlugin, hook: string, error: unknown): void
  /** Fail `plugin` outright — setup's throw, its timeout. */
  fail(plugin: GuardedPlugin, reason: string): void
}

export function createPluginGuard(onChange: () => void = () => {}): PluginGuard {
  function fail(plugin: GuardedPlugin, reason: string): void {
    if (plugin.state === "failed") return
    plugin.state = "failed"
    plugin.reason = reason
    frizzLog.error(`plugin:${plugin.id}`, `failed: ${reason}`)
    onChange()
  }

  function strike(plugin: GuardedPlugin, hook: string, error: unknown): void {
    plugin.strikes += 1
    const detail = error instanceof Error ? error.stack ?? error.message : String(error)
    frizzLog.error(`plugin:${plugin.id}`, `${hook} threw (${plugin.strikes} of ${PLUGIN_STRIKES}): ${detail}`)
    if (plugin.strikes >= PLUGIN_STRIKES) fail(plugin, `${hook} threw ${PLUGIN_STRIKES} times; the last: ${describe(error)}`)
  }

  return {
    run(plugin, hook, fn, fallback) {
      if (plugin.state !== "active") return fallback
      try {
        return fn()
      } catch (error) {
        strike(plugin, hook, error)
        return fallback
      }
    },
    async runAsync(plugin, hook, fn, fallback) {
      if (plugin.state !== "active") return fallback()
      try {
        return await fn()
      } catch (error) {
        strike(plugin, hook, error)
        return fallback()
      }
    },
    async procedure(plugin, hook, fn) {
      if (plugin.state !== "active") throw new Error(`The ${plugin.id} plugin is not running${plugin.reason ? `: ${plugin.reason}` : ""}`)
      try {
        return await fn()
      } catch (error) {
        if (!isPluginRefusal(error)) strike(plugin, hook, error)
        throw error
      }
    },
    strike,
    fail,
  }
}
