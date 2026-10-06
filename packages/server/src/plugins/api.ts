// THE SERVER HALF'S API — what a Frizz plugin's `server.ts` is written against (plans/upstream-superset.md §7).
//
// TYPES ONLY, and that is the contract rather than a style. A plugin is loaded with `await import()` on
// Node's own type stripping, from a directory outside every server generation, so it must not import a
// single VALUE from Frizz: the server it runs in is a bundle (`dist/dev-child.js`) whose module identity
// is not the source tree's, and a plugin that reached for `zod` or a Frizz helper by path would get a
// second copy, or none. Everything it needs arrives through the `host` argument instead — zod included,
// as `host.z` — and `import type { … }` from this file is erased at load, so the path it names never has
// to resolve at runtime.
//
// A plugin's `server.ts` default-exports a `FrizzPlugin`:
//
//   import type { FrizzPlugin } from "<frizz>/packages/server/src/plugins/api.ts"
//   const plugin: FrizzPlugin = {
//     async setup(host) {
//       const db = host.db(["CREATE TABLE note (…)"])
//       return { procedures: { … }, threadView(view, row, project) { … } }
//     },
//   }
//   export default plugin
//
// Every hook runs inside `guard` (guard.ts): a throw returns the hook's fallback, is logged as
// `plugin:<id>`, and a third throw marks the plugin failed for the process. Timers a plugin sets with its
// own `setTimeout` are OUTSIDE that guard — a throw there reaches the process's uncaughtException handler
// and ends the control plane (dev-child.ts), so `host.every` / `host.after` are the documented path.
import type { z } from "zod"
import type { ThreadView } from "@frizz/shared"

export type { ThreadView }

/** The backend a dispatch starts — what `systemPrompt` is asked for. */
export type PluginBackendKind = "claude" | "codex" | "acp"

/** A plugin's SQLite file, `<data>/plugin-data/<id>.db` — the same driver the server uses (sqlite.ts). */
export interface PluginStatement<Row = Record<string, unknown>> {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number }
  get(...params: unknown[]): Row | undefined
  all(...params: unknown[]): Row[]
}
export interface PluginDatabase {
  prepare<Row = Record<string, unknown>>(sql: string): PluginStatement<Row>
  exec(sql: string): void
  /** Runs `fn` in one IMMEDIATE transaction (sqlite.ts) and returns what it returns. */
  transaction<R>(fn: () => R): R
}

/** The machine-wide half of the host: one per plugin, for the life of the process. */
export interface PluginHost {
  readonly id: string
  /** PLUGIN_API of the server the plugin is running in. */
  readonly api: number
  /** The server's own zod — so a schema a plugin builds is the one the server validates with. */
  readonly z: typeof import("zod").z
  readonly log: { info(message: string): void; warn(message: string): void; error(message: string): void }
  /**
   * Open the plugin's own database, migrating it with `migrations` in order. Each entry runs once, in a
   * transaction, and `PRAGMA user_version` records how many have run — so the list is APPEND-ONLY: add a
   * statement at the end, never edit one that shipped. Repeated calls return the same handle.
   */
  db(migrations: readonly string[]): PluginDatabase
  /** The plugin's record in the machine config (`plugin:<id>`), read through the schema it hands in. */
  readonly settings: {
    read<T>(schema: z.ZodType<T>): T | undefined
    write(value: unknown): void
  }
  /** A repeating timer whose callback runs inside the guard. Returns its cancel. */
  every(ms: number, fn: () => void | Promise<void>): () => void
  /** A one-shot timer whose callback runs inside the guard. Returns its cancel. */
  after(ms: number, fn: () => void | Promise<void>): () => void
  /**
   * Throw a refusal the human should read — "This thread has already started". It reaches the caller as
   * the RPC's error like any throw, but it is an answer rather than a fault, so it never counts toward
   * the three strikes that fail a plugin.
   */
  refuse(message: string): never
}

/**
 * A thread as a plugin sees it: the base row's identity and lifecycle, never its runtime internals. A
 * plugin keeps whatever else it needs in its own database, keyed by `slug` + `sessionId` (a slug can be
 * re-dispatched under a new session).
 */
export interface PluginThreadRow {
  slug: string
  sessionId: string
  /** The plugin holding this thread unstarted, or null once it has started (or was never held). */
  heldBy: string | null
  title: string
  archived: boolean
  snoozedUntil: string | null
  spawnedAt: string
  /** The profile the thread will start on — the prompt box's pick when it was written down. */
  model: string | null
  backend: PluginBackendKind
  effort: string | null
}

export interface PluginStartProfile {
  model?: string
  backend?: PluginBackendKind
  effort?: string
}

/** The per-project half of the host, handed to every hook that acts on one project's threads. */
export interface ProjectHost {
  readonly project: { id: string; name: string; dir: string }
  readonly threads: {
    get(slug: string): PluginThreadRow | undefined
    /** Every thread this plugin holds unstarted in this project. */
    held(): PluginThreadRow[]
    /**
     * Write down a thread HELD by this plugin: a name and a session id, no agent. It sits out of the queue
     * (base never queues a held thread — the plugin's `threadView` decides), and a message sent to it calls
     * this plugin's `onSend`. A typed `title` is the human's and is locked; otherwise one is minted from
     * `prompt`, as a dispatch would be. The profile is what it will start on.
     */
    create(input: { prompt: string; title?: string; model?: string; backend?: PluginBackendKind; effort?: string }): { slug: string; sessionId: string }
    /**
     * Start a thread this plugin holds: its agent is dispatched on the row's own slug and session id, so its
     * place, pin, links and name carry over, and it is no longer held. One start at a time per thread —
     * a second while the first is spawning is refused. The profile defaults to the row's.
     */
    start(row: PluginThreadRow, prompt: string, profile?: PluginStartProfile): Promise<{ slug: string; sessionId: string }>
    /**
     * What base's legacy column (`session.lazy_prompt`) holds for a thread this plugin holds — the note a
     * thread written down before plugins existed carried. For a one-time import; undefined when empty.
     */
    legacyNote(row: PluginThreadRow): string | undefined
  }
  /** Re-assemble this project's board (after a write `threadView` reads), so open pages redraw. */
  refresh(): void
}

export interface PluginThreadEvent {
  slug: string
  sessionId: string
  heldBy: string | null
}

/** A procedure, mounted as `plugin.<id>.<name>` in every project's router. */
export interface PluginProcedure<I = any> {
  kind: "query" | "mutation"
  input?: z.ZodType<I>
  /** A verb the HUMAN performs on a thread (`input.slug`): stamps `interacted_at` like every human act. */
  human?: boolean
  handler(input: I, project: ProjectHost): unknown
}

export interface PluginHooks {
  procedures?: Record<string, PluginProcedure>
  /** The schema of the plugin's settings record, which the page's settings section reads and writes. */
  settings?: { schema: z.ZodType; defaults: unknown }
  /** A project opened. Sync and cheap — the moment to reconcile the plugin's records with its rows. */
  project?(project: ProjectHost): void
  /**
   * Called for every thread on every board build: sync, cheap, and usually a pass-through. For a thread it
   * holds, the plugin decides what base will not — whether the thread queues (`needsYou`) — and writes
   * what its web half needs under `view.plugins[id]`.
   */
  threadView?(view: ThreadView, row: PluginThreadRow, project: ProjectHost): ThreadView
  /**
   * A message was sent to a thread this plugin holds. Without this hook (or with the plugin failed or
   * gone) base starts the thread on that message, so a held thread can never be stranded.
   */
  onSend?(row: PluginThreadRow, message: string, project: ProjectHost): Promise<void>
  /** Fire-and-forget. A throw is logged and counted; nothing waits on these. */
  on?: {
    threadDone?(event: PluginThreadEvent, project: ProjectHost): void
    threadDeleted?(event: PluginThreadEvent, project: ProjectHost): void
    humanAct?(event: PluginThreadEvent & { act: string }, project: ProjectHost): void
    rest?(event: PluginThreadEvent & { at: string }, project: ProjectHost): void
  }
  /** Text appended to the system prompt of every worker this project dispatches, per backend. */
  systemPrompt?(kind: PluginBackendKind, project: ProjectHost): string | null | undefined
}

export interface FrizzPlugin {
  /** Once per process, before any project opens. Bounded at 5s; a throw or a timeout fails the plugin. */
  setup(host: PluginHost): PluginHooks | void | Promise<PluginHooks | void>
}
