import type { SessionRow } from "./storage.ts"

// DELETING OLD THREADS (2026-09-30). Done threads used to be kept forever: every one stays a row, a
// tailer entry and a board thread, still answers to its `@handle`, and still holds its slug — so the
// next "Shell budgets" was dispatched as `shell-budgets-2`. Deleting one frees all of that. Three doors
// share the one delete in router.ts (`deleteOwnedThread`): the ⋯ menu's Delete on any thread, the
// Settings drawer's "delete done threads older than", and the automatic sweep below, which applies the
// `deleteDoneThreadsAfterDays` setting once at boot and hourly after.
//
// The manual and automatic doors pick threads by this ONE predicate, so the count the drawer confirms
// is the set the sweep would take.

export const DAY_MS = 86_400_000
export const RETENTION_SWEEP_INTERVAL_MS = 60 * 60_000
/** The boot pass waits a minute: a restart is busy enough without a delete in it. */
export const RETENTION_FIRST_SWEEP_MS = 60_000

/** When the thread last did anything the row records: its last rest, else its dispatch. */
export function threadLastActiveMs(row: Pick<SessionRow, "rested_at" | "spawned_at">): number {
  const at = Date.parse(row.rested_at ?? row.spawned_at)
  return Number.isFinite(at) ? at : 0
}

/**
 * The done threads idle for more than `days` days. Only DONE ones: a thread still in the queue, working
 * or snoozed is somebody's open work however old it is, and only the ⋯ menu deletes one of those. A
 * PINNED done thread is kept too — pinning is the human saying they want it at hand.
 */
export function expiredDoneThreads(rows: readonly SessionRow[], days: number, now = Date.now()): SessionRow[] {
  if (!(days > 0)) return []
  const cutoff = now - days * DAY_MS
  return rows.filter((row) => (row.state === "archived" || row.archived === 1) && !row.pinned_at && threadLastActiveMs(row) < cutoff)
}
