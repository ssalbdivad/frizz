import { closeSync, openSync, readSync, statSync } from "node:fs"
import { spinoffIdOfSpawnCall } from "@frizz/shared"
import type { NormalizedEvent } from "./backend/types.ts"
import type { Storage, ThreadSpinoffRow } from "./storage.ts"

// RECOVERING A SPINOFF EDGE THE DISPATCH NEVER SAW (2026-09-30).
//
// A spinoff's edge — `thread_spinoff.child_slug` — is written IN BAND: the parent's worker calls
// `spawn_thread` with the request's id, its MCP server forwards it as `spinoff`, and the router's
// fulfilSpinoff stamps the child it dispatches. That needs the worker's MCP server to know the argument,
// and a worker's MCP server lives as long as its session. The maintainer's first real spinoff
// (`spn_989f6d00ec353453`) landed on a parent whose server predated the argument: the model passed
// `spinoff`, the server dropped it without a word (it reads only the keys it knows), the router did a
// plain dispatch, and the row stayed pending — so neither thread drew its spinoff UI, and the request
// sat on the parent as one its worker had ignored.
//
// The dispatch cannot recover it in band: an old MCP server sends no caller identity at all, and
// guessing "the one pending spinoff in the project" would capture a human's own new-thread dispatch.
// The PARENT'S TRANSCRIPT can: it records the `spawn_thread` call carrying the request's id and, in its
// result, the slug of the thread that call started ("Spawned a new frizz thread `<slug>`", the only
// wording the tool has had since spinoffs exist). So this reads the transcripts of threads that have a
// pending spinoff and stamps the edge from that evidence.
//
// WHY HERE, NOT IN THE TAILER'S FOLD. The fold is the thread's rest/turn state, and a spinoff edge is a
// row in another table; the tail cache also restores a primed fold WITHOUT re-reading its lines, so a
// fold hook would never see the historical row this exists to repair. This keeps its own byte cursor per
// parent instead: the first visit reads the parent's whole transcript (the repair of a row left by an
// earlier server), every later one reads only what was appended, and a parent with no pending spinoff
// is never read at all — which is every parent, almost always, since an in-band fulfilment stamps its
// row before the call's result is even written.
//
// What it will stamp, and nothing else: a PENDING row (a stamped one is never overwritten —
// completeSpinoff is guarded on `child_slug IS NULL`), from the transcript of the row's OWN parent, by a
// call naming that row's id, onto a thread that exists, is not the parent, is no other spinoff's child,
// and was spawned after the request was made.

/** The one result wording `spawn_thread` has had since spinoffs exist (cc-worker/bin/frizz-mcp.mjs). */
export const SPAWN_THREAD_RESULT_RE = /Spawned a new frizz thread `([a-z0-9][a-z0-9-]*)`/

// A line can only matter if it names a spinoff id (the call) or is a spawn result. Checked on the raw
// bytes, so the overwhelming majority of a transcript is never decoded or parsed.
const CALL_NEEDLE = Buffer.from("spn_")
const RESULT_NEEDLE = Buffer.from("Spawned a new frizz thread")

// Read at most this much of one parent per sweep. A cold first visit of a large transcript then spans a
// few sweeps rather than one long block of the event loop; the boot sweep re-arms itself until done.
const DEFAULT_BUDGET_BYTES = 32 * 1024 * 1024
const WINDOW_BYTES = 4 * 1024 * 1024

export interface SpinoffEdgeRecoveryDeps {
  storage: Pick<Storage, "pendingSpinoffs" | "completeSpinoff" | "getSession" | "spinoffOfChild">
  /** A thread's transcript file and the line parser of the backend that wrote it; undefined when it has none. */
  transcriptOf(slug: string): { path: string; parseLine: (line: string) => NormalizedEvent[] } | undefined
  /** Called once per stamped edge (the board refresh). */
  onRepaired?: (row: ThreadSpinoffRow, childSlug: string) => void
  now?: () => number
  budgetBytes?: number
}

export interface SpinoffEdgeRecovery {
  /** Read the transcripts of threads with a pending spinoff and stamp any edge they prove. `advanced`
   *  names the threads whose transcript just grew; a parent not among them is read only if it was never
   *  read, or its last read stopped short. Returns true while some parent still has unread bytes. */
  sweep(advanced?: readonly string[]): boolean
}

interface Cursor {
  path: string
  offset: number
  carry: Buffer
  /** Read to the end of the file at the last visit. */
  caughtUp: boolean
  /** A `spawn_thread` call naming a spinoff, awaiting its result: tool call id → spinoff id. */
  calls: Map<string, string>
}

export function createSpinoffEdgeRecovery(deps: SpinoffEdgeRecoveryDeps): SpinoffEdgeRecovery {
  const cursors = new Map<string, Cursor>()
  const budget = deps.budgetBytes ?? DEFAULT_BUDGET_BYTES

  function stamp(row: ThreadSpinoffRow, childSlug: string): void {
    if (childSlug === row.parent_slug) return
    const child = deps.storage.getSession(childSlug)
    if (!child) return
    const spawnedAt = Date.parse(child.spawned_at)
    // A call answering this request cannot have started a thread that already existed before it.
    if (Number.isFinite(spawnedAt) && spawnedAt < row.created_at) return
    if (deps.storage.spinoffOfChild(childSlug)) return
    if (deps.storage.completeSpinoff(row.id, childSlug, Number.isFinite(spawnedAt) ? spawnedAt : (deps.now ?? Date.now)())) {
      deps.onRepaired?.(row, childSlug)
    }
  }

  function onLine(line: string, cursor: Cursor, parseLine: (line: string) => NormalizedEvent[], pending: Map<string, ThreadSpinoffRow>): void {
    for (const ev of parseLine(line)) {
      if (ev.kind === "tool-call") {
        const id = spinoffIdOfSpawnCall(ev.name, ev.input)
        if (id) cursor.calls.set(ev.id, id)
      } else if (ev.kind === "tool-result") {
        const id = cursor.calls.get(ev.id)
        if (!id) continue
        cursor.calls.delete(ev.id)
        const row = pending.get(id)
        const slug = SPAWN_THREAD_RESULT_RE.exec(ev.text)?.[1]
        if (row && slug) {
          stamp(row, slug)
          pending.delete(id)
        }
      }
    }
  }

  /** Read one parent from its cursor; true when bytes remain past this sweep's budget. */
  function scan(parent: string, pending: Map<string, ThreadSpinoffRow>): boolean {
    const source = deps.transcriptOf(parent)
    if (!source) return false
    let cursor = cursors.get(parent)
    if (!cursor || cursor.path !== source.path) {
      cursor = { path: source.path, offset: 0, carry: Buffer.alloc(0), caughtUp: false, calls: new Map() }
      cursors.set(parent, cursor)
    }
    let size: number
    try {
      size = statSync(source.path).size
    } catch {
      return false // no transcript yet
    }
    if (size < cursor.offset) {
      // Truncated or replaced: whatever was read belongs to a file that no longer exists.
      cursor.offset = 0
      cursor.carry = Buffer.alloc(0)
      cursor.calls.clear()
    }
    const stop = Math.min(size, cursor.offset + budget)
    try {
      const fd = openSync(source.path, "r")
      try {
        const buf = Buffer.allocUnsafe(Math.min(WINDOW_BYTES, Math.max(1, stop - cursor.offset)))
        while (cursor.offset < stop && pending.size > 0) {
          const read = readSync(fd, buf, 0, Math.min(buf.length, stop - cursor.offset), cursor.offset)
          if (read <= 0) break
          cursor.offset += read
          const view = cursor.carry.length ? Buffer.concat([cursor.carry, buf.subarray(0, read)]) : buf.subarray(0, read)
          let start = 0
          for (;;) {
            const nl = view.indexOf(0x0a, start)
            if (nl === -1) break
            const line = view.subarray(start, nl)
            if (line.includes(CALL_NEEDLE) || line.includes(RESULT_NEEDLE)) onLine(line.toString("utf8"), cursor, source.parseLine, pending)
            start = nl + 1
          }
          cursor.carry = start < view.length ? Buffer.from(view.subarray(start)) : Buffer.alloc(0)
        }
      } finally {
        closeSync(fd)
      }
    } catch {
      return false // a read that raced a write; the next sweep resumes from the cursor
    }
    cursor.caughtUp = cursor.offset >= size || pending.size === 0
    return !cursor.caughtUp
  }

  return {
    sweep(advanced) {
      const rows = deps.storage.pendingSpinoffs()
      const byParent = new Map<string, Map<string, ThreadSpinoffRow>>()
      for (const row of rows) {
        const bucket = byParent.get(row.parent_slug) ?? new Map<string, ThreadSpinoffRow>()
        bucket.set(row.id, row)
        byParent.set(row.parent_slug, bucket)
      }
      // A parent with nothing pending any more is never read again (until it is asked for another).
      for (const parent of cursors.keys()) if (!byParent.has(parent)) cursors.delete(parent)
      let more = false
      for (const [parent, pending] of byParent) {
        const cursor = cursors.get(parent)
        if (advanced && cursor?.caughtUp && !advanced.includes(parent)) continue
        try {
          if (scan(parent, pending)) more = true
        } catch {
          // Never let a malformed transcript break the caller's tick.
        }
      }
      return more
    },
  }
}
