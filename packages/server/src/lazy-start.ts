import type { DispatchInput } from "@frizz/shared"
import type { BackendKind } from "./backend/types.ts"
import type { BoardManager } from "./board.ts"
import type { Dispatcher } from "./dispatch.ts"
import { isLazyRow, type SessionRow } from "./storage.ts"

// STARTING A LAZY THREAD (plans/lazy-threads.md): its first message runs `dispatch` with `opts.lazy`, on
// the row's own slug, session id and title. It lived in the router's closure until scheduled threads
// (plans/scheduled-threads.md §4), whose next run IS a lazy row the SCHEDULER starts — so it is built once
// per project in context.ts and shared by both, and the one-launch-at-a-time guard below sees every
// launch, whoever makes it. A second launch while the first is still spawning would start a second agent
// on the SAME session id; it is refused here rather than raced in the broker.

export interface LazyStartProfile {
  model?: string
  backend?: BackendKind
  effort?: DispatchInput["effort"]
}

export interface LazyThreadStarter {
  start(row: SessionRow, prompt: string, profile?: LazyStartProfile): Promise<{ slug: string; sessionId: string }>
  /** A launch of this slug is in flight. */
  isStarting(slug: string): boolean
}

export function createLazyThreadStarter(deps: { dispatcher: Pick<Dispatcher, "dispatch">; board: Pick<BoardManager, "refresh"> }): LazyThreadStarter {
  const starting = new Set<string>()
  return {
    isStarting: (slug) => starting.has(slug),
    async start(row, prompt, profile = {}) {
      if (!isLazyRow(row)) throw new Error("This thread has already started")
      if (starting.has(row.slug)) throw new Error("This thread is already starting")
      starting.add(row.slug)
      try {
        // The profile defaults to the one the lazy thread was written down with. A different backend
        // borrows nothing from it: another backend's model id, or an effort its model lacks, is wrong.
        const backend = profile.backend ?? (row.backend === "codex" || row.backend === "acp" ? row.backend : "claude")
        const sameBackend = profile.backend === undefined || profile.backend === row.backend
        const model = profile.model ?? (sameBackend ? row.model ?? undefined : undefined)
        const effort = profile.effort ?? (sameBackend && model === (row.model ?? undefined) ? (row.effort ?? undefined) as DispatchInput["effort"] : undefined)
        const started = await deps.dispatcher.dispatch({ prompt, model, effort }, { backend, lazy: row })
        deps.board.refresh()
        return started
      } finally {
        starting.delete(row.slug)
      }
    },
  }
}
