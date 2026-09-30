import type { SessionRow } from "./storage.ts"

// DELETING OLD THREADS (2026-09-30). Done threads used to be kept forever: every one stays a row, a
// tailer entry and a board thread, still answers to its `@handle`, and still holds its slug — so the
// next "Shell budgets" was dispatched as `shell-budgets-2`. Deleting one frees all of that. Three doors
// share the one delete in router.ts (`deleteOwnedThread`): the ⋯ menu's Delete on any thread, the
// Settings drawer's "Delete untouched threads now", and the automatic sweep below, which applies the
// `deleteDoneThreadsUntouchedDays` setting once at boot and hourly after.
//
// The manual and automatic doors pick threads by this ONE predicate, so the count the drawer confirms
// is the set the sweep would take.

export const DAY_MS = 86_400_000
export const RETENTION_SWEEP_INTERVAL_MS = 60 * 60_000
/** The boot pass waits a minute: a restart is busy enough without a delete in it. */
export const RETENTION_FIRST_SWEEP_MS = 60_000

/**
 * When the HUMAN last touched the thread — "last interacted with" (maintainer 2026-09-30), never the
 * agent's own activity: a thread a worker kept busy for a month is still one nobody has looked at.
 * `interacted_at` is every human verb (router.ts HUMAN_THREAD_ACTS); opening and reading stamp their own
 * columns too, which carry the history of rows older than `interacted_at`; and the dispatch itself is the
 * first touch.
 */
export function threadLastInteractedMs(row: Pick<SessionRow, "interacted_at" | "seen_at" | "last_read_at" | "spawned_at">): number {
  let latest = 0
  for (const at of [row.interacted_at, row.seen_at, row.last_read_at, row.spawned_at]) {
    const ms = at ? Date.parse(at) : NaN
    if (Number.isFinite(ms) && ms > latest) latest = ms
  }
  return latest
}

/**
 * The done threads the human has not touched for more than `days` days. Only DONE ones: a thread still
 * in the queue, working or snoozed is somebody's open work however old it is, and only the ⋯ menu
 * deletes one of those. A PINNED done thread is kept too — pinning is the human saying they want it at
 * hand.
 */
export function expiredDoneThreads(rows: readonly SessionRow[], days: number, now = Date.now()): SessionRow[] {
  if (!(days > 0)) return []
  const cutoff = now - days * DAY_MS
  return rows.filter((row) => (row.state === "archived" || row.archived === 1) && !row.pinned_at && threadLastInteractedMs(row) < cutoff)
}
