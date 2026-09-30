import { closeSync, openSync, readSync, statSync } from "node:fs"
import { CLAUDE_WORKER_ENV } from "./backend/types.ts"

// ── A QUIET CHILD BLOCKED IN ONE LONG FOREGROUND CALL IS NOT A DEAD ONE ──────────────────────────────
//
// Frizz judges a tracked child's liveness by its transcript: silent past SUBAGENT_STALE_MS (15m) reads
// "stale", and a stale child is gone from `mcp__frizz__activity`, from the park check (an ```awaiting fence
// naming it is refused "NOT RUNNING (nothing by that name)") and from what keeps its parent out of the
// queue. That window was sized to Claude Code's old 10-minute ceiling on a foreground Bash call, and frizz
// lifted that ceiling to 24 hours on 2026-08-11 (backend/types.ts BASH_MAX_TIMEOUT_MS). So a child running
// `timeout 2400 nub script.mjs` in the foreground writes its tool_use, two PreToolUse hook records, and then
// NOTHING until the call returns — and read dead a quarter-hour in. Observed three times on 2026-09-29
// (session 054bee45): a93a2fe4400f31533 silent 35m and 28m inside Bash calls declaring 2500000 and 2800000
// ms, a2d303d9459d3b0fe silent 21m inside one declaring 6000000, and three agents of workflow
// wf_8a4833df-387 at once — each with its processes alive in `ps` while frizz reported it not running.
//
// The call SAID how long it may take. So when a transcript has gone quiet past the window, this reads its
// tail: if the latest model response still has a Bash call with no result, the child is live until that
// call's declared bound (its `timeout` input, or the harness default when it names none) plus a grace for
// the harness to write the result. Past that, the 15-minute rule stands exactly as before, so a child that
// truly died mid-call still goes stale — only later, and never later than the bound it declared.
//
// NOTHING HERE ENDS ANYTHING. "Stale" is what frizz BELIEVES, never an action on the child: no call is
// capped, denied or killed for running long (Colin's standing rule for shells — "no universal timeout",
// some run for days — holds for a child's calls too). What stale does is tell someone: a parent parked on
// the child is woken with what frizz saw (scheduler SOURCE 12), and the rows say it.
//
// Only a call that DECLARES a bound stretches anything. An MCP call has no ceiling at all, and a foreground
// Agent call's liveness is its own child's transcript (tailer descendantSubtrees), so neither buys a
// dead child an unbounded "running".

/** Claude Code's own default for a Bash call that names no `timeout` (frizz lowers it to 60s for its
 *  workers; a foreign session keeps this). Either sits well under SUBAGENT_STALE_MS, so it only matters
 *  as "a call with no timeout stretches nothing". */
const HARNESS_DEFAULT_BASH_MS = 120_000
/** The ceiling frizz sets on an explicit `timeout` — the harness clamps anything larger to it. */
const HARNESS_MAX_BASH_MS = Number(CLAUDE_WORKER_ENV.BASH_MAX_TIMEOUT_MS)
/** From the call's bound to its result landing: the harness kills (or backgrounds) the command, then writes
 *  the tool_result. Seconds in practice; the result's write restarts the ordinary clock. */
export const PENDING_CALL_GRACE_MS = 2 * 60_000
/** The tools whose `timeout` input is the call's bound, in milliseconds. */
const BOUNDED_TOOLS = new Set(["Bash", "PowerShell"])
/** How much of the transcript's end is read. The pending tool_use sits behind a few hook records (~4KB
 *  each); a tool_use larger than this (a huge heredoc) resolves to "no pending call", which is the old rule. */
const TAIL_BYTES = 512 * 1024

type PendingCall = { startedMs: number; boundMs: number }
const cache = new Map<string, { mtimeMs: number; size: number; calls: PendingCall[] }>()
const CACHE_MAX = 256

/**
 * The latest response's still-pending bounded calls: when each started (its record's timestamp) and the
 * bound it declared. Empty when there are none. Cached per (mtime, size): a transcript is append-only,
 * and this is only asked of one that has gone quiet, so each quiet stretch costs one tail read.
 */
export function pendingBoundedCalls(path: string): readonly PendingCall[] {
  let st: { mtimeMs: number; size: number }
  try {
    st = statSync(path)
  } catch {
    return []
  }
  const hit = cache.get(path)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.calls
  const calls = pendingCallsOf(readTail(path, st.size))
  cache.delete(path)
  cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, calls })
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return calls
}

/**
 * Has this transcript been quiet long enough to call its writer stale? `lastWriteMs` is the caller's own
 * reading of its mtime (the tailer's is injectable, so tests run on their own clock). Silence and a call's
 * elapsed time are both AWAKE time (awake-clock.ts): a suspended host is not a silent agent, and the
 * harness's own timeout timer did not run through the suspension either. The tail is read only once the
 * ordinary window has passed, so the common case costs nothing beyond the stat already made.
 */
export function transcriptQuietPast(
  path: string,
  lastWriteMs: number,
  nowMs: number,
  staleMs: number,
  awakeBetween: (fromMs: number, toMs: number) => number = (from, to) => to - from,
): boolean {
  if (awakeBetween(lastWriteMs, nowMs) <= staleMs) return false
  return pendingBoundedCalls(path).every((call) => awakeBetween(call.startedMs, nowMs) > call.boundMs + PENDING_CALL_GRACE_MS)
}

function readTail(path: string, size: number): string {
  const start = Math.max(0, size - TAIL_BYTES)
  const buf = Buffer.alloc(size - start)
  let fd: number | undefined
  try {
    fd = openSync(path, "r")
    const n = readSync(fd, buf, 0, buf.length, start)
    const text = buf.subarray(0, n).toString("utf8")
    // A window that starts mid-line drops the partial first line.
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text
  } catch {
    return ""
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

type Block = { type?: unknown; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown }
type Rec = { type?: unknown; timestamp?: unknown; message?: { id?: unknown; content?: unknown } }

// Walks back from the end. The LATEST model response is every assistant record sharing the newest one's
// message id (Claude Code writes one record per content block); its tool calls are pending until a user
// record carrying their tool_result appears after them. Hook attachments, system and progress records
// in between are skipped. A user prompt, or an older response, ends the walk: a call from an earlier turn
// left unanswered (a crash, an interrupt) must not stretch anything now.
export function pendingCallsOf(tail: string): PendingCall[] {
  const lines = tail.split("\n")
  const answered = new Set<string>()
  let responseId: unknown
  let seenResponse = false
  const calls: PendingCall[] = []
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue
    let rec: Rec
    try {
      rec = JSON.parse(line) as Rec
    } catch {
      continue
    }
    if (!rec || typeof rec !== "object") continue
    const content = rec.message?.content
    if (rec.type === "user") {
      const blocks = Array.isArray(content) ? (content as Block[]) : []
      const results = blocks.filter((b) => b && b.type === "tool_result" && typeof b.tool_use_id === "string")
      // A prompt (not a tool result) ends it: nothing before a prompt is still being run.
      if (results.length === 0) break
      if (seenResponse) break // a result BEFORE the response answers an older one
      for (const r of results) answered.add(r.tool_use_id as string)
      continue
    }
    if (rec.type !== "assistant") continue
    const id = rec.message?.id
    if (seenResponse && (id === undefined || id !== responseId)) break
    seenResponse = true
    responseId = id
    if (!Array.isArray(content)) continue
    const started = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN
    if (!Number.isFinite(started)) continue
    for (const b of content as Block[]) {
      if (!b || b.type !== "tool_use" || typeof b.id !== "string" || answered.has(b.id)) continue
      if (typeof b.name !== "string" || !BOUNDED_TOOLS.has(b.name)) continue
      const input = (b.input && typeof b.input === "object" ? b.input : {}) as { timeout?: unknown; run_in_background?: unknown }
      // A background launch answers at once; it is its shell, not this call, that runs on.
      if (input.run_in_background === true) continue
      const declared = typeof input.timeout === "number" && Number.isFinite(input.timeout) && input.timeout > 0 ? input.timeout : HARNESS_DEFAULT_BASH_MS
      calls.push({ startedMs: started, boundMs: Math.min(declared, HARNESS_MAX_BASH_MS) })
    }
  }
  return calls
}
