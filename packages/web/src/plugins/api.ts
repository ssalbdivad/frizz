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
import type { BoardSnapshot, DispatchInput, ThreadView } from "@frizz/shared"

export type { BoardSnapshot, ThreadView }

/** Call one of THIS plugin's procedures (`plugin.<id>.<name>`) on a project. */
export type PluginCall = (name: string, input?: unknown) => Promise<unknown>

/** The prompt box base draws for a thread with no agent yet (HeldThreadBox.tsx), handed to plugins. */
export interface HeldThreadBoxProps {
  thread: ThreadView
  surface: "queueComposer" | "chatComposer"
  className?: string
  id?: string
  /** The box's text: what sending it starts the thread with. A change from elsewhere replaces it unless typed over. */
  note: string
  /** Saves the text as it is typed (debounced). Omitted: the box keeps its text to itself. */
  save?: (text: string) => Promise<unknown>
  /** Starts the thread with the box's text. A throw is shown as a toast and leaves the box as it was. */
  start: (text: string) => Promise<unknown>
  placeholder?: string
  /** The hint under the box. */
  footer?: string
}

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
  /** Base's own components, so a plugin's box is base's box rather than a copy that drifts. */
  readonly ui: {
    HeldThreadBox: React.ComponentType<HeldThreadBoxProps>
  }
}

/** A draft in the new-thread box, as `newThread.submitAlt` receives it. */
export interface NewThreadDraft {
  /** The prompt as a dispatch would send it, chips included and the editor's context block not. */
  prompt: string
  /** The prompt box's profile pick: what the thread starts on, unless changed then. */
  model?: string
  backend?: "claude" | "codex" | "acp"
  effort?: NonNullable<DispatchInput["effort"]>
}

/**
 * The new-thread box's ALTERNATE SUBMIT: a glyph beside Send, and ⌘/Ctrl-Shift-Enter. Base clears the box as
 * a dispatch does, puts the words back if `submit` throws, and toasts the result with a link to the thread.
 */
export interface SubmitAltSlot {
  /** The button's accessible name, in sentence case. */
  label: string
  /** Its tooltip; base appends the chord. */
  title: string
  Icon: React.ComponentType<{ size: number; strokeWidth: number }>
  /** The toast after it lands. */
  done: string
  submit(draft: NewThreadDraft): Promise<{ slug: string }>
}

export interface ThreadComposerSlotProps {
  thread: ThreadView
  surface: "queueComposer" | "chatComposer"
  className?: string
  id?: string
  /** This plugin's procedures on the THREAD's project (a card on All projects may be another project's). */
  call: PluginCall
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
  /** The new-thread box's alternate submit. The first plugin, in id order, to offer one gets the glyph and chord. */
  "newThread.submitAlt"?: SubmitAltSlot
  /** The prompt box of a thread THIS plugin holds unstarted (`thread.held === id`); base's box when absent. */
  "thread.composer"?: React.ComponentType<ThreadComposerSlotProps>
}

export interface WebPluginActivation {
  slots?: WebPluginSlots
}

export type ActivateWebPlugin = (host: WebPluginHost) => WebPluginActivation | void
