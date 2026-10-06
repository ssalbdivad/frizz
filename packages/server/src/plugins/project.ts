import { z } from "zod"
import { pluginProcedureName, type ThreadView } from "@frizz/shared"
import type { AnyProcedure } from "@frizz/rpc/server"
import { log as frizzLog } from "../logging.ts"
import type { Project } from "../project.ts"
import type { SessionRow, Storage } from "../storage.ts"
import type { Dispatcher } from "../dispatch.ts"
import type { HeldStartProfile } from "../held-start.ts"
import type { PluginBackendKind, PluginHooks, PluginThreadEvent, PluginThreadRow, ProjectHost } from "./api.ts"
import { isPluginRefusal, pluginRefusal } from "./guard.ts"
import type { PluginRecord, PluginRegistry } from "./loader.ts"

// ONE PROJECT'S VIEW OF THE MACHINE'S PLUGINS (plans/upstream-superset.md §7, seams 2 and 4).
//
// The registry (loader.ts) is machine-wide: one per process, loaded before any project opened. Every hook
// that acts on threads acts on ONE project's, so each tenant builds one of these in context.ts and hands
// each plugin a ProjectHost scoped to it. Every call into a plugin goes through the registry's guard: a
// throw returns the fallback named at the call site — the view base drew, base's own start for a held
// thread — and counts toward the three strikes that fail the plugin for the process.
//
// Events are OBSERVED, not instrumented, where that is the honest reading: `threadDone` fires when the board
// sees a thread become done and `rest` when it sees one come to rest, whoever caused it — the human, the
// worker's own `done`, an undo — rather than at the four router verbs that happen to mark one. A first
// sighting only primes: a server that boots onto a board of rested threads is not watching them rest.
// `threadDeleted` is the one exception, fired from deleteOwnedThread (router.ts), the single body every
// delete runs through, because a deleted row is gone before any board could see it go.

export interface ProjectPluginsDeps {
  registry: PluginRegistry
  project: Project
  storage: Storage
  dispatcher: Pick<Dispatcher, "createHeldThread">
  /** The project's one held-thread start (context.ts startHeldThread). */
  startHeld(row: SessionRow, prompt: string, profile?: HeldStartProfile): Promise<{ slug: string; sessionId: string }>
  refresh(): void
}

export interface ProjectPlugins {
  /** Every running plugin's `threadView`, in id order, over the view base drew. */
  threadView(view: ThreadView, row: SessionRow): ThreadView
  /** What the board drew this build — the source of `threadDone` and `rest`. */
  observe(threads: readonly ThreadView[]): void
  /**
   * A message for a held thread. True when its holder took it (`onSend`); false when base must start the
   * thread on it — no holder by that id, the holder failed or gone, no `onSend`, or `onSend` threw. A
   * refusal the holder raised on purpose reaches the sender instead.
   */
  send(row: SessionRow, message: string): Promise<boolean>
  threadDeleted(row: SessionRow): void
  humanAct(slug: string, act: string): void
  /** `plugin.<id>.<name>` for every running plugin's procedures, ready to mount in this project's router. */
  procedures(): Record<string, AnyProcedure>
  /** The names in `procedures()` a human performs on a thread (HUMAN_THREAD_ACTS joins them). */
  humanProcedures(): string[]
  /** Every running plugin's addition to a worker's system prompt for `kind`, joined; "" when none. */
  systemPrompt(kind: PluginBackendKind): string
  /** The project opened: each plugin's `project()` hook. */
  opened(): void
}

const backendOf = (row: SessionRow): PluginBackendKind => (row.backend === "codex" || row.backend === "acp" ? row.backend : "claude")

export function pluginThreadRow(row: SessionRow): PluginThreadRow {
  return {
    slug: row.slug,
    sessionId: row.session_id,
    heldBy: row.held_by ?? null,
    title: row.title ?? row.slug,
    archived: row.state === "archived" || row.archived === 1,
    snoozedUntil: row.snoozed_until ?? null,
    spawnedAt: row.spawned_at,
    model: row.model ?? null,
    backend: backendOf(row),
    effort: row.effort ?? null,
  }
}

const eventOf = (row: Pick<SessionRow, "slug" | "session_id" | "held_by">): PluginThreadEvent => ({
  slug: row.slug,
  sessionId: row.session_id,
  heldBy: row.held_by ?? null,
})

export function createProjectPlugins(deps: ProjectPluginsDeps): ProjectPlugins {
  const { registry, storage } = deps
  const guard = registry.guard
  const hosts = new Map<string, ProjectHost>()

  function hostFor(record: PluginRecord): ProjectHost {
    const existing = hosts.get(record.id)
    if (existing) return existing
    const id = record.id
    const host: ProjectHost = {
      project: { id: deps.project.id, name: deps.project.name, dir: deps.project.dir },
      threads: {
        get(slug) {
          const row = storage.getSession(slug)
          return row ? pluginThreadRow(row) : undefined
        },
        held: () => storage.allSessions().filter((row) => row.held_by === id).map(pluginThreadRow),
        create(input) {
          const created = deps.dispatcher.createHeldThread(input, { holder: id })
          deps.refresh()
          return created
        },
        async start(row, prompt, profile) {
          // Re-read: the plugin's copy may be stale, and only a thread it STILL holds is its to start.
          const current = storage.getSession(row.slug)
          if (!current || current.session_id !== row.sessionId) throw pluginRefusal("This thread is gone")
          if (current.held_by !== id) throw pluginRefusal("This thread has already started")
          return deps.startHeld(current, prompt, profile)
        },
        legacyNote(row) {
          const current = storage.getSession(row.slug)
          if (!current || current.session_id !== row.sessionId || current.held_by !== id) return undefined
          return current.lazy_prompt?.length ? current.lazy_prompt : undefined
        },
      },
      refresh: () => deps.refresh(),
    }
    hosts.set(id, host)
    return host
  }

  /** Running plugins that implement `pick`, in id order (the registry reads its directory sorted). */
  function withHook<K extends keyof PluginHooks>(key: K): { record: PluginRecord; hook: NonNullable<PluginHooks[K]> }[] {
    return registry.active().flatMap((record) => {
      const hook = record.hooks[key]
      return hook ? [{ record, hook: hook as NonNullable<PluginHooks[K]> }] : []
    })
  }

  function emit<E extends keyof NonNullable<PluginHooks["on"]>>(
    name: E,
    event: Parameters<NonNullable<NonNullable<PluginHooks["on"]>[E]>>[0],
  ): void {
    for (const { record, hook } of withHook("on")) {
      const handler = hook[name] as ((event: unknown, project: ProjectHost) => void) | undefined
      if (!handler) continue
      // Fire-and-forget, off the caller's stack: nothing waits on an event, and a slow handler must not
      // hold a board build or a delete.
      queueMicrotask(() => void guard.runAsync(record, `on.${name}`, async () => { await handler(event, hostFor(record)) }, () => undefined))
    }
  }

  // What the previous build drew, per thread: whether it was done, and the rest it was at (lastAssistantAt
  // while turn-idle). Keyed by slug + session id, so a slug re-dispatched under a new session starts over.
  const seen = new Map<string, { sessionId: string; archived: boolean; restAt: string | undefined }>()

  return {
    threadView(view, row) {
      let out = view
      for (const { record, hook } of withHook("threadView")) {
        const before = out
        out = guard.run(record, "threadView", () => hook(before, pluginThreadRow(row), hostFor(record)) ?? before, before)
      }
      return out
    },

    observe(threads) {
      if (registry.active().every((record) => !record.hooks.on?.threadDone && !record.hooks.on?.rest)) return
      const live = new Set<string>()
      for (const view of threads) {
        if (view.kind !== "session" || !view.sessionId) continue
        live.add(view.id)
        const restAt = view.runtime === "turn-idle" && !view.held ? view.lastAssistantAt : undefined
        const before = seen.get(view.id)
        seen.set(view.id, { sessionId: view.sessionId, archived: view.archived, restAt })
        if (!before || before.sessionId !== view.sessionId) continue
        const event = { slug: view.id, sessionId: view.sessionId, heldBy: view.held ?? null }
        if (view.archived && !before.archived) emit("threadDone", event)
        if (restAt && restAt !== before.restAt) emit("rest", { ...event, at: restAt })
      }
      for (const slug of seen.keys()) if (!live.has(slug)) seen.delete(slug)
    },

    async send(row, message) {
      const holder = row.held_by ? registry.get(row.held_by) : undefined
      const onSend = holder?.state === "active" ? holder.hooks.onSend : undefined
      if (!holder || !onSend) return false
      let refused: unknown
      const taken = await guard.runAsync(holder, "onSend", async () => {
        try {
          await onSend(pluginThreadRow(row), message, hostFor(holder))
          return true
        } catch (error) {
          if (!isPluginRefusal(error)) throw error
          refused = error
          return true
        }
      }, () => {
        frizzLog.warn(`plugin:${holder.id}`, `onSend failed for ${row.slug}; starting it on the message`)
        return false
      })
      if (refused) throw refused
      return taken
    },

    threadDeleted(row) {
      emit("threadDeleted", eventOf(row))
    },

    humanAct(slug, act) {
      if (withHook("on").every(({ hook }) => !hook.humanAct)) return
      const row = storage.getSession(slug)
      if (row) emit("humanAct", { ...eventOf(row), act })
    },

    procedures() {
      const out: Record<string, AnyProcedure> = {}
      for (const record of registry.active()) {
        for (const [name, proc] of Object.entries(record.hooks.procedures ?? {})) {
          const hook = `procedure ${name}`
          const handler = ({ input }: { input?: unknown }) => guard.procedure(record, hook, () => proc.handler(input, hostFor(record)))
          // The schema is the plugin's own (built with host.z, the server's zod), so mountRouter validates
          // with it like any procedure's; a plugin that declares none takes anything JSON.
          const input = proc.input ?? z.unknown()
          out[pluginProcedureName(record.id, name)] = proc.kind === "query"
            ? { _tag: "query", input, output: z.unknown(), handler: handler as never }
            : { _tag: "mutation", input, handler: handler as never }
        }
      }
      return out
    },

    humanProcedures() {
      return registry.active().flatMap((record) =>
        Object.entries(record.hooks.procedures ?? {}).flatMap(([name, proc]) => (proc.human ? [pluginProcedureName(record.id, name)] : [])),
      )
    },

    systemPrompt(kind) {
      const parts: string[] = []
      for (const { record, hook } of withHook("systemPrompt")) {
        const text = guard.run(record, "systemPrompt", () => hook(kind, hostFor(record)), undefined)
        if (typeof text === "string" && text.trim()) parts.push(text.trim())
      }
      return parts.join("\n\n")
    },

    opened() {
      for (const { record, hook } of withHook("project")) guard.run(record, "project", () => hook(hostFor(record)), undefined)
    },
  }
}

/** A project with no plugins — a hand-built test context, or a server whose registry is empty. */
export function noProjectPlugins(): ProjectPlugins {
  return {
    threadView: (view) => view,
    observe: () => {},
    send: async () => false,
    threadDeleted: () => {},
    humanAct: () => {},
    procedures: () => ({}),
    humanProcedures: () => [],
    systemPrompt: () => "",
    opened: () => {},
  }
}
