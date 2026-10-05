import type Database from "./sqlite.ts"
import type { ProjectScope } from "./project-scope.ts"

// THE TWO SCHEDULED-THREADS TABLES (plans/scheduled-threads.md §7). Their CREATE statements live in
// storage.ts STORAGE_SCHEMA with every other table, so the importer, the purge and the isolation test
// cover them like the rest; the statements that read and write them live here so storage.ts does not
// grow by another few hundred lines. Every statement is prepared through the project scope, so each one
// names `@project_id` and can only ever see this project's rows.
//
// `thread_schedule` is a saved prompt plus a recurrence. `next_slug` is its ONE materialized next run —
// a lazy thread row carrying `schedule_id`, snoozed until `next_occurrence_at` (§4) — and `revision`
// is the optimistic-concurrency guard every writer bumps: the scheduler's claim and every RPC edit race
// on it, and a write that read a stale revision changes nothing.
//
// `thread_schedule_run` is the PERMANENT never-twice record (the timer lesson: an outbox row is pruned,
// a run row is not until retention). `UNIQUE(project_id, schedule_id, occurrence_at)` is what makes a
// second claim of one occurrence impossible, whoever makes it.

export type ScheduleStateValue = "proposed" | "active" | "paused" | "ended"
export type SchedulePausedReasonValue = "human" | "review" | "failures" | "stuck"
export type ScheduleRunStateValue = "starting" | "started" | "skipped" | "failed"

export interface ThreadScheduleRow {
  id: string
  title: string
  /** The human's own words for WHEN ("every Monday at 9am"), the source of truth a re-interpretation reads. */
  when_text: string
  prompt: string
  condition: string | null
  rrule: string
  dtstart: string
  tz: string
  model: string | null
  effort: string | null
  backend: string
  state: ScheduleStateValue
  paused_reason: SchedulePausedReasonValue | null
  revision: number
  next_slug: string | null
  /** Epoch ms of the occurrence the materialized next run stands for. */
  next_occurrence_at: number | null
  /** Epoch ms of the newest occurrence ever consumed — monotonic; every recompute is the first
   *  occurrence after max(now, this), so nothing fires twice even once run history is pruned. */
  last_occurrence_at: number | null
  consecutive_failures: number
  consecutive_overlaps: number
  /** `human`, or the slug of the worker thread that proposed it. */
  created_by: string
  created_at: number
  updated_at: number
}

export interface ThreadScheduleRunRow {
  id: string
  schedule_id: string
  occurrence_at: number
  started_at: number | null
  state: ScheduleRunStateValue
  reason: string | null
  /** A quiet finish's first line (the `done` tool's `quiet: true`). */
  summary: string | null
  thread_slug: string | null
  session_id: string | null
  /** The process that claimed a `starting` row — see schedules.ts SCHEDULE_PROCESS_OWNER. */
  owner: string | null
  created_at: number
}

export type NewScheduleRun = Omit<ThreadScheduleRunRow, "summary"> & { summary?: string | null }

export interface ScheduleStore {
  insertSchedule(row: ThreadScheduleRow): void
  getSchedule(id: string): ThreadScheduleRow | undefined
  listSchedules(): ThreadScheduleRow[]
  /** proposed + active + paused — what the per-project cap counts. */
  countLiveSchedules(): number
  /** Write the whole row back, guarded on `expectedRevision`; bumps `revision` and `updated_at`. False
   *  when someone else wrote it first (zero rows changed). */
  writeSchedule(row: ThreadScheduleRow, expectedRevision: number, nowMs: number): boolean
  deleteSchedule(id: string): boolean
  /** THE CLAIM: insert a `starting` run row AND bump the schedule's revision (guarded on the one read,
   *  and on the schedule still being active) in ONE transaction. False — with nothing written — when
   *  the occurrence was already claimed or the schedule moved under the caller. */
  claimScheduleRun(run: NewScheduleRun, expectedRevision: number, nowMs: number): boolean
  /** A run row that is not a claim (a skip, a manual run). False when the occurrence already has one. */
  insertScheduleRun(run: NewScheduleRun): boolean
  getScheduleRun(id: string): ThreadScheduleRunRow | undefined
  scheduleRunAt(scheduleId: string, occurrenceAt: number): ThreadScheduleRunRow | undefined
  /** Move a `starting` row to its outcome. False when it is no longer `starting`. */
  settleScheduleRun(id: string, outcome: { state: Exclude<ScheduleRunStateValue, "starting">; startedAt?: number | null; reason?: string | null; threadSlug?: string | null; sessionId?: string | null }): boolean
  /** Drop a `starting` claim outright — a human start that failed, so the occurrence can still fire. */
  dropScheduleRunClaim(id: string): boolean
  setScheduleRunSummary(id: string, summary: string): boolean
  /** Newest first. */
  listScheduleRuns(scheduleId: string, limit: number): ThreadScheduleRunRow[]
  /** Every `starting` row in the project, oldest first. */
  startingScheduleRuns(): ThreadScheduleRunRow[]
  /** The newest run row naming this thread. */
  scheduleRunForThread(slug: string): ThreadScheduleRunRow | undefined
  /** Keep the newest `keep` run rows of one schedule; returns how many went. */
  pruneScheduleRuns(scheduleId: string, keep: number): number
}

export function createScheduleStore(db: Database, scope: ProjectScope): ScheduleStore {
  const insertScheduleStmt = scope.prepare(`
    INSERT INTO thread_schedule (
      project_id, id, title, when_text, prompt, condition, rrule, dtstart, tz, model, effort, backend, state,
      paused_reason, revision, next_slug, next_occurrence_at, last_occurrence_at, consecutive_failures,
      consecutive_overlaps, created_by, created_at, updated_at
    ) VALUES (
      @project_id, @id, @title, @when_text, @prompt, @condition, @rrule, @dtstart, @tz, @model, @effort, @backend, @state,
      @paused_reason, @revision, @next_slug, @next_occurrence_at, @last_occurrence_at, @consecutive_failures,
      @consecutive_overlaps, @created_by, @created_at, @updated_at
    )
  `)
  const getScheduleStmt = scope.prepare<[string], ThreadScheduleRow>("SELECT * FROM thread_schedule WHERE project_id = @project_id AND id = ?")
  const listSchedulesStmt = scope.prepare<[], ThreadScheduleRow>("SELECT * FROM thread_schedule WHERE project_id = @project_id ORDER BY created_at, id")
  const countLiveStmt = scope.prepare<[], { n: number }>(
    "SELECT COUNT(*) AS n FROM thread_schedule WHERE project_id = @project_id AND state IN ('proposed', 'active', 'paused')",
  )
  const writeScheduleStmt = scope.prepare(`
    UPDATE thread_schedule SET
      title = @title, when_text = @when_text, prompt = @prompt, condition = @condition, rrule = @rrule,
      dtstart = @dtstart, tz = @tz, model = @model, effort = @effort, backend = @backend, state = @state,
      paused_reason = @paused_reason, next_slug = @next_slug, next_occurrence_at = @next_occurrence_at,
      last_occurrence_at = @last_occurrence_at, consecutive_failures = @consecutive_failures,
      consecutive_overlaps = @consecutive_overlaps, revision = revision + 1, updated_at = @updated_at
    WHERE project_id = @project_id AND id = @id AND revision = @expected_revision
  `)
  const deleteScheduleStmt = scope.prepare("DELETE FROM thread_schedule WHERE project_id = @project_id AND id = ?")
  const deleteRunsStmt = scope.prepare("DELETE FROM thread_schedule_run WHERE project_id = @project_id AND schedule_id = ?")
  const insertRunStmt = scope.prepare(`
    INSERT OR IGNORE INTO thread_schedule_run (
      project_id, id, schedule_id, occurrence_at, started_at, state, reason, summary, thread_slug, session_id, owner, created_at
    ) VALUES (
      @project_id, @id, @schedule_id, @occurrence_at, @started_at, @state, @reason, @summary, @thread_slug, @session_id, @owner, @created_at
    )
  `)
  // The claim's revision bump. `last_occurrence_at` moves forward only (MAX), never back.
  const claimBumpStmt = scope.prepare(`
    UPDATE thread_schedule SET revision = revision + 1, updated_at = @now,
      last_occurrence_at = MAX(COALESCE(last_occurrence_at, @occurrence_at), @occurrence_at)
    WHERE project_id = @project_id AND id = @id AND revision = @expected_revision AND state = 'active'
  `)
  const getRunStmt = scope.prepare<[string], ThreadScheduleRunRow>("SELECT * FROM thread_schedule_run WHERE project_id = @project_id AND id = ?")
  const runAtStmt = scope.prepare<[string, number], ThreadScheduleRunRow>(
    "SELECT * FROM thread_schedule_run WHERE project_id = @project_id AND schedule_id = ? AND occurrence_at = ?",
  )
  const settleRunStmt = scope.prepare(`
    UPDATE thread_schedule_run SET state = @state, started_at = @started_at, reason = @reason,
      thread_slug = COALESCE(@thread_slug, thread_slug), session_id = COALESCE(@session_id, session_id)
    WHERE project_id = @project_id AND id = @id AND state = 'starting'
  `)
  const dropClaimStmt = scope.prepare("DELETE FROM thread_schedule_run WHERE project_id = @project_id AND id = ? AND state = 'starting'")
  const setSummaryStmt = scope.prepare("UPDATE thread_schedule_run SET summary = ? WHERE project_id = @project_id AND id = ?")
  const listRunsStmt = scope.prepare<[string, number], ThreadScheduleRunRow>(
    "SELECT * FROM thread_schedule_run WHERE project_id = @project_id AND schedule_id = ? ORDER BY occurrence_at DESC, created_at DESC LIMIT ?",
  )
  const startingRunsStmt = scope.prepare<[], ThreadScheduleRunRow>(
    "SELECT * FROM thread_schedule_run WHERE project_id = @project_id AND state = 'starting' ORDER BY created_at, id",
  )
  const runForThreadStmt = scope.prepare<[string], ThreadScheduleRunRow>(
    "SELECT * FROM thread_schedule_run WHERE project_id = @project_id AND thread_slug = ? ORDER BY created_at DESC LIMIT 1",
  )
  const pruneRunsStmt = scope.prepare(`
    DELETE FROM thread_schedule_run WHERE project_id = @project_id AND schedule_id = @schedule_id AND id NOT IN (
      SELECT id FROM thread_schedule_run WHERE project_id = @project_id AND schedule_id = @schedule_id
      ORDER BY occurrence_at DESC, created_at DESC LIMIT @keep
    )
  `)

  const runParams = (run: NewScheduleRun) => ({
    id: run.id,
    schedule_id: run.schedule_id,
    occurrence_at: run.occurrence_at,
    started_at: run.started_at ?? null,
    state: run.state,
    reason: run.reason ?? null,
    summary: run.summary ?? null,
    thread_slug: run.thread_slug ?? null,
    session_id: run.session_id ?? null,
    owner: run.owner ?? null,
    created_at: run.created_at,
  })

  // One transaction: the run row and the revision bump land together or not at all. A UNIQUE conflict
  // (the occurrence already has a row) and a stale revision both roll the whole thing back.
  const claim = db.transaction((run: NewScheduleRun, expectedRevision: number, nowMs: number): boolean => {
    if (Number(insertRunStmt.run(runParams(run)).changes) === 0) return false
    const bumped = claimBumpStmt.run({ id: run.schedule_id, expected_revision: expectedRevision, now: nowMs, occurrence_at: run.occurrence_at })
    if (Number(bumped.changes) === 0) throw new StaleScheduleClaim()
    return true
  })

  const removeSchedule = db.transaction((id: string): boolean => {
    deleteRunsStmt.run(id)
    return Number(deleteScheduleStmt.run(id).changes) > 0
  })

  return {
    insertSchedule: (row) => void insertScheduleStmt.run({ ...row }),
    getSchedule: (id) => getScheduleStmt.get(id),
    listSchedules: () => listSchedulesStmt.all(),
    countLiveSchedules: () => countLiveStmt.get()?.n ?? 0,
    writeSchedule: (row, expectedRevision, nowMs) =>
      Number(writeScheduleStmt.run({ ...row, expected_revision: expectedRevision, updated_at: nowMs }).changes) > 0,
    deleteSchedule: (id) => removeSchedule(id),
    claimScheduleRun(run, expectedRevision, nowMs) {
      try {
        return claim(run, expectedRevision, nowMs)
      } catch (error) {
        if (error instanceof StaleScheduleClaim) return false
        throw error
      }
    },
    insertScheduleRun: (run) => Number(insertRunStmt.run(runParams(run)).changes) > 0,
    getScheduleRun: (id) => getRunStmt.get(id),
    scheduleRunAt: (scheduleId, occurrenceAt) => runAtStmt.get(scheduleId, occurrenceAt),
    settleScheduleRun: (id, outcome) =>
      Number(settleRunStmt.run({
        id,
        state: outcome.state,
        started_at: outcome.startedAt ?? null,
        reason: outcome.reason ?? null,
        thread_slug: outcome.threadSlug ?? null,
        session_id: outcome.sessionId ?? null,
      }).changes) > 0,
    dropScheduleRunClaim: (id) => Number(dropClaimStmt.run(id).changes) > 0,
    setScheduleRunSummary: (id, summary) => Number(setSummaryStmt.run(summary, id).changes) > 0,
    listScheduleRuns: (scheduleId, limit) => listRunsStmt.all(scheduleId, limit),
    startingScheduleRuns: () => startingRunsStmt.all(),
    scheduleRunForThread: (slug) => runForThreadStmt.get(slug),
    pruneScheduleRuns: (scheduleId, keep) => Number(pruneRunsStmt.run({ schedule_id: scheduleId, keep }).changes),
  }
}

/** Thrown inside the claim transaction to roll back a run row whose schedule moved under it. */
class StaleScheduleClaim extends Error {
  constructor() {
    super("the schedule changed since it was read")
  }
}
