import * as React from "react"
import { Component, useSyncExternalStore, type ErrorInfo, type ReactElement, type ReactNode } from "react"
import { useSnapshot } from "valtio"
import { PLUGIN_API, pluginProcedureName, type BoardSnapshot, type PluginSummary } from "@frizz/shared"
import { callProcedure, rpc } from "../api/rpc.ts"
import { apiBase } from "../lib/base-path.ts"
import { showToast, store } from "../store.ts"
import type { ActivateWebPlugin, PluginCall, WebPluginHost, WebPluginSlots } from "./api.ts"

// THE PAGE'S HALF OF FRIZZ PLUGINS (plans/upstream-superset.md §7).
//
// Once per page: ask the server which plugins run and where each one's web half is (`plugins`, a
// content-hashed `/_frizz/plugins/<id>/web.ts?v=…`), `import()` each, and call its `activate(host)`.
// What it returns is a set of SLOTS — components and descriptors base renders at fixed places (the head
// of the queue, a thread's prompt box, the new-thread box's alternate submit, a Settings section). Base
// never renders a slot bare: each one sits in its own error boundary (PluginBoundary below), and
// `activate` is caught, so a web half that throws loses its own slots and is listed as failed in
// Settings → Frizz plugins while the page carries on.
//
// The registry is a module store read through useSyncExternalStore rather than valtio, because what it
// holds is components and functions — exactly what a proxy should not wrap — and it changes only when a
// plugin loads or fails.

export interface LoadedPlugin {
  id: string
  summary: PluginSummary
  slots: WebPluginSlots
}

let loaded: readonly LoadedPlugin[] = []
const webFailures = new Map<string, string>()
const listeners = new Set<() => void>()
let version = 0

function changed(): void {
  version++
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

function useRegistryVersion(): number {
  return useSyncExternalStore(subscribe, () => version)
}

/** This plugin's procedures on the API base `base()` names, read at call time. */
export function pluginCaller(summary: PluginSummary, base: () => string): PluginCall {
  return (name, input) => {
    const procedure = summary.procedures.find((candidate) => candidate.name === name)
    if (!procedure) return Promise.reject(new Error(`The ${summary.id} plugin has no ${name}`))
    return callProcedure(base(), pluginProcedureName(summary.id, name), procedure.kind, input)
  }
}

function hostFor(summary: PluginSummary): WebPluginHost {
  return {
    id: summary.id,
    api: PLUGIN_API,
    React,
    h: React.createElement,
    call: pluginCaller(summary, apiBase),
    useBoard: () => useSnapshot(store).board as BoardSnapshot | null,
    toast: (message, options) => showToast(message, options),
  }
}

/** Load every running plugin's web half. Once per page; a server with no plugins answers an empty list. */
export async function initPlugins(): Promise<void> {
  let plugins: PluginSummary[]
  try {
    plugins = (await rpc.plugins()).plugins
  } catch {
    return // a server from before plugins, or one restarting: the page simply has none
  }
  await Promise.all(plugins.filter((plugin) => plugin.state === "active" && plugin.web).map(load))
}

async function load(summary: PluginSummary): Promise<void> {
  try {
    const module = (await import(/* @vite-ignore */ summary.web!.url)) as { activate?: ActivateWebPlugin }
    if (typeof module.activate !== "function") throw new Error("its web half exports no activate()")
    const activation = module.activate(hostFor(summary)) ?? {}
    loaded = [...loaded, { id: summary.id, summary, slots: activation.slots ?? {} }].sort((a, b) => a.id.localeCompare(b.id))
  } catch (error) {
    console.error(`[frizz] the ${summary.id} plugin's web half failed to load:`, error)
    webFailures.set(summary.id, `Its web half failed to load: ${error instanceof Error ? error.message : String(error)}`)
  }
  changed()
}

/** Every loaded plugin offering `name`, in id order. */
export function usePluginSlots<K extends keyof WebPluginSlots>(name: K): { plugin: LoadedPlugin; slot: NonNullable<WebPluginSlots[K]> }[] {
  useRegistryVersion()
  return loaded.flatMap((plugin) => {
    const slot = plugin.slots[name]
    return slot ? [{ plugin, slot: slot as NonNullable<WebPluginSlots[K]> }] : []
  })
}

/** What went wrong in this page with each plugin's web half — Settings → Frizz plugins shows it. */
export function useWebPluginFailures(): ReadonlyMap<string, string> {
  useRegistryVersion()
  return webFailures
}

/**
 * One plugin's slot, fenced. A render that throws shows `fallback` (nothing, unless the site has a base
 * reading to fall back to) and is recorded against the plugin; the rest of the page never sees it.
 */
export class PluginBoundary extends Component<{ id: string; slot: string; fallback?: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[frizz] the ${this.props.id} plugin's ${this.props.slot} slot threw:`, error, info.componentStack)
    webFailures.set(this.props.id, `Its ${this.props.slot} slot threw: ${error instanceof Error ? error.message : String(error)}`)
    changed()
  }

  override render(): ReactNode {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children
  }
}

/** Every plugin's `queue.head`, in id order, each fenced. */
export function QueueHeadSlots(): ReactElement | null {
  const slots = usePluginSlots("queue.head")
  if (slots.length === 0) return null
  return (
    <>
      {slots.map(({ plugin, slot: Slot }) => (
        <PluginBoundary key={plugin.id} id={plugin.id} slot="queue.head">
          <Slot />
        </PluginBoundary>
      ))}
    </>
  )
}

/** Test seam: forget every loaded plugin. */
export function resetWebPlugins(): void {
  loaded = []
  webFailures.clear()
  changed()
}
