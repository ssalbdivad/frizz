// THE WEB HALF'S API — what a Frizz plugin's `web.ts` is written against (plans/upstream-superset.md §7).
//
// TYPES ONLY, for the same reason as the server half's (packages/server/src/plugins/api.ts): the page
// `import()`s the plugin's own file, types stripped by the server (plugins/web-assets.ts), from outside
// the immutable `web-dist` its bundle lives in — so the plugin can import nothing from the page. React,
// `h`, the RPC caller, board hooks and the small UI kit all arrive through `activate(host)`: one React on
// the page, no import map, and nothing compiled into `web-dist`. There is no JSX either (stripping only
// erases), so a web half writes `h(Component, props, …children)`.
//
//   import type { WebPluginHost, WebPluginActivation } from "<frizz>/packages/web/src/plugins/api.ts"
//   export function activate(host: WebPluginHost): WebPluginActivation {
//     return { slots: { "queue.head": () => host.h("div", null, "hello") } }
//   }
//
// Each slot renders inside a per-plugin error boundary, and `activate` itself is caught: a web half that
// throws loses its own slots and is listed as failed in Settings → Frizz plugins; the page carries on.
import type * as React from "react"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"

export type { BoardSnapshot, ThreadView }

/** Call one of THIS plugin's procedures (`plugin.<id>.<name>`) on a project. */
export type PluginCall = (name: string, input?: unknown) => Promise<unknown>

export interface WebPluginHost {
  readonly id: string
  /** PLUGIN_API of the page's server. */
  readonly api: number
  readonly React: typeof React
  readonly h: typeof React.createElement
  /** This plugin's procedures on the PAGE's project. Slot props carry a `call` scoped to their thread's. */
  readonly call: PluginCall
  /** The page project's board, live. A hook: call it from a slot component's body. */
  useBoard(): BoardSnapshot | null
  toast(message: string, options?: { link?: { label: string; slug: string; project?: string } }): void
}

export interface SettingsSectionSlotProps {
  /** The plugin's settings record, as its schema reads it (or its defaults). */
  settings: unknown
  /** Writes the record; the server validates it with the plugin's schema and rejects what fails it. */
  save(value: unknown): Promise<void>
}

export interface WebPluginSlots {
  /** Above the queue's cards. */
  "queue.head"?: React.ComponentType
  /** Under the plugin's entry in Settings → Frizz plugins. */
  "settings.section"?: React.ComponentType<SettingsSectionSlotProps>
}

export interface WebPluginActivation {
  slots?: WebPluginSlots
}

export type ActivateWebPlugin = (host: WebPluginHost) => WebPluginActivation | void
