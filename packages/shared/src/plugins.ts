import { z } from "zod"

// FRIZZ PLUGINS — the contract both sides of the wire share (plans/upstream-superset.md §7).
//
// A plugin is a directory under `<data>/user-plugins/<id>/` whose `package.json` carries a `frizzPlugin`
// manifest. It is the operator's own code, loaded machine-wide and never from a project checkout, for the
// features that will not make the product (lazy threads is the first). "Plugin" in this module means a
// FRIZZ plugin; Claude Code plugins (the cc-worker directory, "Reload plugins") are a different thing,
// and user-visible copy says "Frizz plugins" to keep them apart.
//
// Only the version and the shapes that cross the wire live here. The API a plugin's server half is
// written against is `packages/server/src/plugins/api.ts`, and its web half's is
// `packages/web/src/plugins/api.ts` — both type-only, because a plugin imports nothing from Frizz at
// runtime: every value reaches it through the `host` argument.

/**
 * The plugin API this Frizz implements. A plugin names the version it was written against in its
 * manifest (`frizzPlugin.api`), and a mismatch disables THAT plugin with a reason — a server generation
 * never refuses to boot over a plugin. Additive host changes do not bump it; a change that would break a
 * plugin written against the previous shape does.
 */
export const PLUGIN_API = 1 as const
export type PluginApiVersion = typeof PLUGIN_API

/**
 * A plugin id. It is spliced into an RPC name (`plugin.<id>.<name>`), a URL segment
 * (`/_frizz/plugins/<id>/…`), a SQLite filename (`<data>/plugin-data/<id>.db`), a machine-config key
 * (`plugin:<id>`) and `session.held_by`, so it is held to the one shape every one of those accepts.
 */
export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/
export const PluginId = z.string().regex(PLUGIN_ID_PATTERN, "a plugin id is lowercase letters, digits and dashes, starting with a letter")

/**
 * Holders base keeps for itself. A plugin may not take one of these ids: `held_by` names the holder of an
 * unstarted thread, and a plugin called `schedules` would be handed a schedule's next run.
 */
export const BASE_HOLDERS = ["schedules"] as const

/** The `frizzPlugin` field of a plugin's package.json. Read without running any of the plugin's code. */
export const FrizzPluginManifest = z.object({
  id: PluginId,
  api: z.number().int(),
  // Each a path relative to the plugin's directory: the server half (`.ts`, loaded on Node's own type
  // stripping), the web half (served through `module.stripTypeScriptTypes`), and a Claude Code plugin
  // directory appended to every Claude worker's SDK `plugins`.
  server: z.string().min(1).optional(),
  web: z.string().min(1).optional(),
  claude: z.string().min(1).optional(),
})
export type FrizzPluginManifest = z.infer<typeof FrizzPluginManifest>

/**
 * Where a plugin stands in THIS process.
 *   active       — loaded and serving.
 *   failed       — it threw: at import, in setup, past the 5s setup bound, or three times in its hooks.
 *   disabled     — named in `plugins.disabled` in the machine config.
 *   incompatible — written against another plugin API, or needs a Node this one is not.
 */
export const PluginState = z.enum(["active", "failed", "disabled", "incompatible"])
export type PluginState = z.infer<typeof PluginState>

export const PluginProcedureSummary = z.object({
  name: z.string(),
  kind: z.enum(["query", "mutation"]),
  // Joins the human-act set: calling it stamps the thread's `interacted_at` like any human verb.
  human: z.boolean(),
})
export type PluginProcedureSummary = z.infer<typeof PluginProcedureSummary>

/** One plugin as Settings → Frizz plugins lists it, and as the page's loader finds its web half. */
export const PluginSummary = z.object({
  id: z.string(),
  dir: z.string(),
  version: z.string().optional(),
  description: z.string().optional(),
  state: PluginState,
  reason: z.string().optional(),
  procedures: z.array(PluginProcedureSummary),
  // MCP tools it adds to every worker (`<id>_<tool>`, auto-approved). None until the MCP proxy seam lands.
  mcpTools: z.array(z.string()),
  // Claude Code plugin directories it appends to every Claude worker's SDK `plugins`.
  claudeDirs: z.array(z.string()),
  // The web half's URL, content-hashed so a changed file is a new URL and an unchanged one caches.
  web: z.object({ url: z.string() }).optional(),
  // It keeps a settings record (`plugin:<id>` in the machine config), validated by its own schema.
  settings: z.boolean(),
})
export type PluginSummary = z.infer<typeof PluginSummary>

export const PluginsReport = z.object({
  api: z.number(),
  // FRIZZ_PLUGINS_OFF=1: safe mode, nothing was loaded.
  off: z.boolean(),
  // The directory plugins are read from, so the list can say where to put one.
  root: z.string(),
  plugins: z.array(PluginSummary),
})
export type PluginsReport = z.infer<typeof PluginsReport>

export const PluginSettingsInput = z.object({ id: PluginId }).strict()
export type PluginSettingsInput = z.infer<typeof PluginSettingsInput>
export const SetPluginSettingsInput = z.object({ id: PluginId, value: z.unknown() }).strict()
export type SetPluginSettingsInput = z.infer<typeof SetPluginSettingsInput>

/** The RPC name a plugin procedure is mounted under, inside each project's router. */
export function pluginProcedureName(id: string, name: string): string {
  return `plugin.${id}.${name}`
}
