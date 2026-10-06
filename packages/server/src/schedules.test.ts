// SCHEDULED THREADS (plans/scheduled-threads.md): the schedule service against the REAL dispatcher, the REAL
// lazy-thread starter, the REAL router and real SQLite. Only the Claude broker is a recorder (what Frizz
// asks it to start, and when) and the clock is injected, so every case below is the scheduler pass exactly
// as production runs it, at an instant the test chooses.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { mountRouter } from "@frizz/rpc/server"
import {
  SCHEDULE_GRAMMAR_STALE,
  SCHEDULE_GRAMMAR_VERSION,
  SCHEDULE_READING_MOVED,
  parseScheduledRunPrompt,
  readSchedulePhrase,
  scheduleRefusalOf,
  type BoardSnapshot,
  type ThreadView,
} from "@frizz/shared"
import { createDispatcher } from "./dispatch.ts"
import { createRouter } from "./router.ts"
import { createStorage, isLazyRow, isScheduledLazyRow } from "./storage.ts"
import { defaultSettings } from "./settings.ts"
import { cwdSlug, type Project } from "./project.ts"
import { lazyThreadView, type BoardManager } from "./board.ts"
import type { AppContext } from "./context.ts"
import type { Tailer } from "./tailer.ts"
import type { ClaudeAgentBrokerBridge } from "./backend/claude-agent-broker-bridge.ts"
import { ProviderAuthRequiredError } from "./backend/auth-status.ts"
import { createLazyThreadStarter } from "./lazy-start.ts"
import { createScheduleService, createStartCap, rederiveLocalReading, type ScheduleServiceDeps } from "./schedules.ts"

const T = (iso: string) => Date.parse(iso)
// Monday 2026-10-05, in UTC so the arithmetic reads off the page.
const MON_8AM = T("2026-10-05T08:00:00Z")
const MON_9AM = T("2026-10-05T09:00:00Z")
const NEXT_MON_9AM = T("2026-10-12T09:00:00Z")

const WEEKLY = {
  title: "Triage issues",
  prompt: "Triage the new issues and label them.",
  whenText: "every Monday at 9am",
  rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0",
  dtstart: "2026-10-05T09:00",
  tz: "UTC",
  model: "haiku",
  effort: "low" as const,
}

function harness(opts: Partial<Pick<ScheduleServiceDeps, "bootAtMs" | "postBootGraceMs" | "startCap" | "owner" | "nameFor" | "log">> & { nowMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "frizz-schedules-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  const project: Project = { dir, id: "schedules", name: "t", label: "o/t", stateDir: dir, cwdSlug: cwdSlug(dir) }
  // A board that projects every row the way the real one does for what these tests read: an editable
  // session thread, with its schedule ref (late-bound — the service is built below).
  let refOf: (row: never) => ThreadView["schedule"] = () => undefined
  const snapshot = (): BoardSnapshot => ({
    projectDir: dir, projectName: "t", projectLabel: "t", errors: [], warnings: [],
    threads: storage.allSessions().map((row) => ({
      id: row.slug, title: row.title ?? "", status: "active", kind: "session", foreign: false,
      state: row.state === "archived" ? "archived" : "open", schedule: refOf(row as never),
    }) as unknown as ThreadView),
  })
  const board: BoardManager = {
    snapshot: async () => snapshot(), currentSeq: () => 0, rebuild: async () => snapshot(),
    refresh: () => snapshot(), start: async () => {}, stop: async () => {},
  }
  const spawned: { threadSlug: string; sessionId: string; prompt: string; model?: string }[] = []
  let fail: (() => Error | undefined) | undefined
  let gate: Promise<void> = Promise.resolve()
  const claudeBroker = {
    spawnDispatch: async (input: { threadSlug: string; sessionId: string; cwd: string; prompt: string; model?: string }) => {
      await gate
      const error = fail?.()
      if (error) throw error
      spawned.push({ threadSlug: input.threadSlug, sessionId: input.sessionId, prompt: input.prompt, model: input.model })
      return { binding: { threadSlug: input.threadSlug, sessionId: input.sessionId, cwd: input.cwd } }
    },
    followUp: async () => {},
    releaseSession: () => {},
  } as unknown as ClaudeAgentBrokerBridge
  let preflight: "authed" | "signed-out" = "authed"
  const dispatcher = createDispatcher({
    project, storage, board, claudeBroker,
    getSettings: () => defaultSettings(),
    dispatchProfile: () => ({ model: "opus" }),
    preflightAuth: async () => preflight,
  })
  const starter = createLazyThreadStarter({ dispatcher, board })
  let clock = opts.nowMs ?? MON_8AM
  // The board's reading of a run, by slug — what the overlap check consults. Default: nothing known.
  const readings = new Map<string, { view?: ThreadView; vouched: boolean }>()
  const service = createScheduleService({
    project, storage, dispatcher, starter, board,
    nameHolder: (name, except) => storage.allSessions().find((r) => r.state !== "archived" && r.title === name && r.slug !== except),
    threadView: (slug) => readings.get(slug) ?? { vouched: true },
    clientZone: () => "UTC",
    now: () => clock,
    bootAtMs: opts.bootAtMs ?? 0,
    postBootGraceMs: opts.postBootGraceMs ?? 0,
    startCap: opts.startCap ?? createStartCap(2),
    ...(opts.owner ? { owner: opts.owner } : {}),
    ...(opts.nameFor ? { nameFor: opts.nameFor } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  })
  refOf = (row) => service.threadRef(row)
  const tailer: Tailer = {
    get: () => undefined, foreignIds: () => [], subAgent: () => undefined,
    forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
  }
  const ctx = {
    project, storage, board, tailer, dispatcher, claudeBroker,
    getSettings: () => defaultSettings(),
    schedules: service,
    startLazyThread: (row: never, prompt: string, profile: never) => service.startLazyRow(row, prompt, profile),
    terminalRunner: { closeThread: async () => {}, live: () => false, stopThread: async () => {} },
  } as unknown as AppContext
  return {
    storage, service, router: createRouter(ctx), spawned, readings,
    at: (ms: number) => { clock = ms },
    tick: async () => { service.evalDue(clock); await service.drain() },
    failWith: (f: (() => Error | undefined) | undefined) => { fail = f },
    signOut: () => { preflight = "signed-out" },
    hold: () => { let open!: () => void; gate = new Promise((r) => { open = r }); return () => open() },
    close: () => { storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

const running = (slug: string): ThreadView => ({ id: slug, title: "x", status: "active", runtime: "running" } as unknown as ThreadView)

test("a new schedule's next run is a lazy thread snoozed until the occurrence, parked in Snoozed even once due", async () => {
  const h = harness()
  try {
    const view = h.service.create(WEEKLY)
    assert.equal(view.state, "active")
    assert.equal(view.echo, "Triage issues · every Monday at 9am")
    assert.equal(view.nextLine, "Next: Mon Oct 5 · Mon Oct 12 · Mon Oct 19")
    assert.ok(view.nextRun, "the next run is materialized")
    assert.equal(view.nextRun!.at, new Date(MON_9AM).toISOString())
    const row = h.storage.getSession(view.nextRun!.slug)!
    assert.equal(isScheduledLazyRow(row), true)
    assert.equal(row.title, "Triage issues")
    assert.equal(row.lazy_prompt, WEEKLY.prompt)
    assert.equal(row.model, "haiku")
    assert.equal(h.spawned.length, 0, "nothing runs at create")
    // The board's projection: Snoozed with its wake time — and STILL parked after the time passes.
    const ref = h.service.threadRef(row)
    assert.deepEqual(ref, { id: view.id, title: "Triage issues", describe: "every Monday at 9am", pending: true })
    const base = { id: row.slug, title: row.title, status: "active", archived: false, schedule: ref } as unknown as ThreadView
    const projected = lazyThreadView(base, row)
    assert.equal(projected.snoozedUntil, row.snoozed_until)
    assert.equal(projected.needsYou, false, "a pending run never queues")
  } finally {
    h.close()
  }
})

test("at its time the scheduler starts the run with the header, records it, and materializes the next one", async () => {
  const h = harness()
  try {
    const view = h.service.create(WEEKLY)
    const firstSlug = view.nextRun!.slug
    h.at(MON_9AM - 1000)
    await h.tick()
    assert.equal(h.spawned.length, 0, "not before its time")
    h.at(MON_9AM + 5_000)
    await h.tick()
    assert.equal(h.spawned.length, 1)
    assert.equal(h.spawned[0]!.threadSlug, firstSlug, "it starts on the lazy row's own slug")
    assert.equal(h.spawned[0]!.model, "haiku")
    const prompt = h.spawned[0]!.prompt
    assert.match(prompt, /<scheduled-run schedule="sch_[0-9a-f]{12}">/)
    assert.match(prompt, /This run is for Mon Oct 5, 9am\./)
    assert.match(prompt, /This is the schedule's first run\./)
    assert.match(prompt, /`quiet: true`/)
    assert.ok(prompt.includes(WEEKLY.prompt), "the saved prompt follows the header")
    const started = h.storage.getSession(firstSlug)!
    assert.equal(isLazyRow(started), false)
    assert.equal(started.schedule_id, view.id, "the run keeps its schedule")
    const after = h.service.get(view.id)
    assert.equal(after.history.length, 1)
    assert.equal(after.history[0]!.state, "started")
    assert.equal(after.history[0]!.label, "@triage-issues")
    assert.equal(after.schedule.nextRun!.occurrenceAt, new Date(NEXT_MON_9AM).toISOString())
    const next = h.storage.getSession(after.schedule.nextRun!.slug)!
    assert.equal(next.title, "Triage issues 2", "a collision takes a number, never another word")
    assert.equal(isScheduledLazyRow(next), true)
    // The second run's header names the first.
    h.at(NEXT_MON_9AM + 1000)
    await h.tick()
    assert.equal(h.spawned.length, 2)
    assert.match(h.spawned[1]!.prompt, /The previous run was @triage-issues for Mon Oct 5, 9am\./)
  } finally {
    h.close()
  }
})

test("two passes over one due occurrence start exactly one run", async () => {
  const h = harness()
  try {
    h.service.create(WEEKLY)
    h.at(MON_9AM + 1000)
    const open = h.hold()
    // Two ticks while the first launch is still in flight — the second must see the claim and stand down.
    h.service.evalDue(MON_9AM + 1000)
    h.service.evalDue(MON_9AM + 2000)
    open()
    await h.service.drain()
    assert.equal(h.spawned.length, 1)
  } finally {
    h.close()
  }
})

test("a claim a dead process left behind is settled by what its thread shows", async () => {
  const h = harness()
  try {
    const a = h.service.create(WEEKLY)
    const b = h.service.create({ ...WEEKLY, title: "Dep bumps" })
    // Process A claimed both occurrences and died: one before the dispatch landed, one after.
    for (const v of [a, b]) {
      h.storage.insertScheduleRun({
        id: `run_dead_${v.id}`, schedule_id: v.id, occurrence_at: MON_9AM, started_at: null, state: "starting", reason: null,
        thread_slug: v.nextRun!.slug, session_id: v.nextRun!.sessionId, owner: "a-dead-process", created_at: MON_9AM,
      })
    }
    const row = h.storage.getSession(b.nextRun!.slug)!
    h.storage.upsertSession({ ...row, lazy_prompt: null, snoozed_until: null, exited: 0 })
    h.at(MON_9AM + 60_000)
    await h.tick()
    assert.equal(h.spawned.length, 0, "a settled claim is never retried")
    const ha = h.service.get(a.id)
    assert.equal(ha.history[0]!.state, "failed")
    assert.equal(ha.history[0]!.label, "Didn't start: Frizz stopped")
    assert.equal(ha.schedule.nextRun!.occurrenceAt, new Date(NEXT_MON_9AM).toISOString(), "the next occurrence is materialized")
    // The dead process may have handed that session id to a daemon before it died, so the next run is a
    // fresh lazy row under a fresh session id, never the same one re-snoozed.
    assert.notEqual(ha.schedule.nextRun!.sessionId, a.nextRun!.sessionId, "a fresh session id for the next run")
    assert.equal(h.storage.getSession(a.nextRun!.slug)?.session_id === a.nextRun!.sessionId, false, "the cut-off lazy row is gone")
    const hb = h.service.get(b.id)
    assert.equal(hb.history[0]!.state, "started", "its thread started, so the claim got through")
    assert.notEqual(hb.schedule.nextRun!.slug, b.nextRun!.slug)
  } finally {
    h.close()
  }
})

test("an occurrence missed past its lateness cap is skipped once, with the count, and never fires", async () => {
  // Frizz came up Thursday; the Monday run was due while it was off — 3 days late on a weekly rule.
  const h = harness({ bootAtMs: T("2026-10-08T12:00:00Z") })
  try {
    h.at(T("2026-10-04T12:00:00Z"))
    const view = h.service.create(WEEKLY)
    h.at(T("2026-10-08T12:00:10Z"))
    await h.tick()
    assert.equal(h.spawned.length, 0)
    const got = h.service.get(view.id)
    assert.equal(got.history[0]!.label, "Skipped: Frizz was off")
    assert.equal(got.schedule.nextRun!.occurrenceAt, new Date(NEXT_MON_9AM).toISOString())
  } finally {
    h.close()
  }
})

test("an occurrence missed WITHIN the cap runs once, late, and says so", async () => {
  const h = harness({ bootAtMs: T("2026-10-05T11:00:00Z") })
  try {
    h.service.create(WEEKLY)
    h.at(T("2026-10-05T11:10:00Z"))
    await h.tick()
    assert.equal(h.spawned.length, 1)
    assert.match(h.spawned[0]!.prompt, /It started 2h 10m late, because Frizz was off\./)
  } finally {
    h.close()
  }
})

test("nothing fires inside the post-boot grace", async () => {
  const h = harness({ bootAtMs: MON_9AM, postBootGraceMs: 60_000 })
  try {
    h.service.create(WEEKLY)
    h.at(MON_9AM + 30_000)
    await h.tick()
    assert.equal(h.spawned.length, 0)
    h.at(MON_9AM + 61_000)
    await h.tick()
    assert.equal(h.spawned.length, 1)
  } finally {
    h.close()
  }
})

test("a previous run still working skips the occurrence; unvouched defers; three in a row pause it", async () => {
  const h = harness()
  try {
    const view = h.service.create({ ...WEEKLY, rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0" })
    h.at(MON_9AM + 1000)
    await h.tick()
    const firstRun = h.spawned[0]!.threadSlug
    h.readings.set(firstRun, { view: running(firstRun), vouched: false })
    h.at(MON_9AM + 86_400_000 + 1000)
    await h.tick()
    assert.equal(h.service.get(view.id).history.length, 1, "an unvouched reading neither fires nor skips")
    h.readings.set(firstRun, { view: running(firstRun), vouched: true })
    for (let day = 1; day <= 3; day++) {
      h.at(MON_9AM + day * 86_400_000 + 1000)
      await h.tick()
    }
    const got = h.service.get(view.id)
    assert.equal(h.spawned.length, 1, "nothing started over the running one")
    assert.deepEqual(got.history.slice(0, 3).map((r) => r.label), Array(3).fill("Skipped: the last run was still working"))
    assert.equal(got.schedule.state, "paused")
    assert.equal(got.schedule.pausedReason, "stuck")
    assert.equal(got.schedule.attention, true)
    assert.equal(got.schedule.nextRun, undefined, "a paused schedule holds no next run")
  } finally {
    h.close()
  }
})

test("three unreviewed runs pause it, and reviewing them resumes it without catching up", async () => {
  const h = harness()
  try {
    const view = h.service.create({ ...WEEKLY, rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0" })
    for (let day = 0; day < 3; day++) {
      h.at(MON_9AM + day * 86_400_000 + 1000)
      await h.tick()
    }
    assert.equal(h.spawned.length, 3)
    h.at(MON_9AM + 3 * 86_400_000 + 1000)
    await h.tick()
    let got = h.service.get(view.id)
    assert.equal(h.spawned.length, 3, "the fourth does not start")
    assert.equal(got.schedule.state, "paused")
    assert.equal(got.schedule.pausedText, "Paused until you review 3 runs")
    assert.equal(h.service.summary()!.attention, true)
    // The human marks two done: still paused, and the line counts what is left.
    h.storage.setState(h.spawned[0]!.threadSlug, "archived")
    h.storage.setState(h.spawned[1]!.threadSlug, "archived")
    await h.tick()
    got = h.service.get(view.id)
    assert.equal(got.schedule.pausedText, "Paused until you review 1 run")
    h.storage.forgetSession(h.spawned[2]!.threadSlug) // deleted counts as reviewed
    h.at(MON_9AM + 3 * 86_400_000 + 7_200_000) // 11am — today's 9am is gone
    await h.tick()
    got = h.service.get(view.id)
    assert.equal(got.schedule.state, "active")
    assert.equal(got.schedule.nextRun!.occurrenceAt, new Date(MON_9AM + 4 * 86_400_000).toISOString(), "resume never catches up")
    assert.equal(h.spawned.length, 3)
  } finally {
    h.close()
  }
})

test("failed starts are recorded, retried never, and pause the schedule after three", async () => {
  const h = harness()
  try {
    const view = h.service.create({ ...WEEKLY, rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0" })
    const lazySlug = view.nextRun!.slug
    h.signOut()
    for (let day = 0; day < 3; day++) {
      h.at(MON_9AM + day * 86_400_000 + 1000)
      await h.tick()
      await h.tick() // a second pass the same minute must not retry it
    }
    const got = h.service.get(view.id)
    assert.equal(h.spawned.length, 0)
    assert.deepEqual(got.history.map((r) => r.label), Array(3).fill("Didn't start: Claude is signed out"))
    assert.equal(got.schedule.state, "paused")
    assert.equal(got.schedule.pausedText, "Paused: couldn't start 3 times. Sign in to Claude, then resume.")
    assert.equal(h.storage.getSession(lazySlug), undefined, "the pause removes the unstarted next run")
  } finally {
    h.close()
  }
})

test("the human's acts on the next run: done skips it, a snooze moves it, Wake now runs it", async () => {
  const h = harness()
  try {
    const view = h.service.create({ ...WEEKLY, rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0" })
    // Mark as done = skip this occurrence. The row stays in Done; a fresh one stands for tomorrow.
    h.storage.setState(view.nextRun!.slug, "archived")
    h.at(MON_9AM + 1000)
    await h.tick()
    let got = h.service.get(view.id)
    assert.equal(got.history[0]!.label, "Skipped: you marked it done")
    assert.equal(h.spawned.length, 0)
    const tomorrow = got.schedule.nextRun!
    assert.equal(tomorrow.occurrenceAt, new Date(MON_9AM + 86_400_000).toISOString())
    // Snooze it to 2pm tomorrow = move this occurrence: nothing at 9, a start at 2.
    const twoPm = new Date(MON_9AM + 86_400_000 + 5 * 3_600_000).toISOString()
    await h.router.setThreadSnooze.handler({ input: { slug: tomorrow.slug, sessionId: tomorrow.sessionId, until: twoPm } as never })
    got = h.service.get(view.id)
    assert.equal(got.schedule.nextRun!.moved, true)
    h.at(MON_9AM + 86_400_000 + 1000)
    await h.tick()
    assert.equal(h.spawned.length, 0, "not at its old time")
    h.at(Date.parse(twoPm) + 1000)
    await h.tick()
    assert.equal(h.spawned.length, 1, "at the time the human moved it to")
    assert.match(h.spawned[0]!.prompt, /This run is for Tue Oct 6, 9am\./)
    // Wake now on the following one = run it now, as the human, through the RPC (no scheduler tick).
    got = h.service.get(view.id)
    const third = got.schedule.nextRun!
    await h.router.setThreadSnooze.handler({ input: { slug: third.slug, sessionId: third.sessionId, until: null } as never })
    assert.equal(h.spawned.length, 2)
    assert.match(h.spawned[1]!.prompt, /This run is for Wed Oct 7, 9am; the human started it early\./)
    got = h.service.get(view.id)
    assert.equal(got.history[0]!.reason, "started by you")
    assert.equal(got.schedule.nextRun!.occurrenceAt, new Date(MON_9AM + 3 * 86_400_000).toISOString(), "that occurrence is spent")
  } finally {
    h.close()
  }
})

test("sending the next run early (followUp) starts it with the header; Run now on a paused schedule runs once", async () => {
  const h = harness()
  try {
    const view = h.service.create(WEEKLY)
    const next = view.nextRun!
    // The human edits this run's note, then sends it.
    await h.router.updateLazyPrompt.handler({ input: { slug: next.slug, sessionId: next.sessionId, prompt: "Only the bug reports this time." } })
    await h.router.followUp.handler({ input: { slug: next.slug, sessionId: next.sessionId, message: "Only the bug reports this time." } } as never)
    assert.equal(h.spawned.length, 1)
    assert.ok(parseScheduledRunPrompt(h.spawned[0]!.prompt.slice(h.spawned[0]!.prompt.indexOf("<scheduled-run"))))
    assert.match(h.spawned[0]!.prompt, /Only the bug reports this time\./)
    // Paused: Run now still works, consumes no occurrence, and leaves it paused.
    h.service.setState(view.id, "paused")
    const run = await h.router.runScheduleNow.handler({ input: { id: view.id } })
    assert.equal(h.spawned.length, 2)
    assert.equal(h.spawned[1]!.threadSlug, run.slug)
    const got = h.service.get(view.id)
    assert.equal(got.schedule.state, "paused")
    assert.equal(got.history.filter((r) => r.state === "started").length, 2)
  } finally {
    h.close()
  }
})

test("the machine-wide start cap holds a third start for the next tick, late but not skipped", async () => {
  const h = harness({ startCap: createStartCap(2) })
  try {
    for (const title of ["Triage issues", "Dep bumps", "CI check"]) h.service.create({ ...WEEKLY, title })
    h.at(MON_9AM + 1000)
    const open = h.hold()
    h.service.evalDue(MON_9AM + 1000)
    open()
    await h.service.drain()
    assert.equal(h.spawned.length, 2)
    await h.tick()
    assert.equal(h.spawned.length, 3)
  } finally {
    h.close()
  }
})

test("a quiet done files a scheduled run under Done with its summary; on any other thread it is refused", async () => {
  const h = harness()
  try {
    const view = h.service.create(WEEKLY)
    h.at(MON_9AM + 1000)
    await h.tick()
    const slug = h.spawned[0]!.threadSlug
    const result = await h.router.markOwnDone.handler({ input: { slug, body: "**Nothing new** — no issues since Oct 5.\n\n- checked `gh issue list`", quiet: true } })
    assert.equal(result.done, true)
    assert.equal(h.storage.getSession(slug)!.state, "archived")
    const got = h.service.get(view.id)
    assert.equal(got.history[0]!.summary, "Nothing new — no issues since Oct 5.")
    assert.equal(got.history[0]!.label, "Nothing new — no issues since Oct 5.")
    assert.equal(got.schedule.counts.unreviewed, 0)
    // An ordinary thread: the lazy one the human wrote down, started.
    const plain = await h.router.createLazyThread.handler({ input: { prompt: "plain work", title: "Plain work" } })
    await h.router.startLazyThread.handler({ input: { slug: plain.slug, sessionId: plain.sessionId, prompt: "plain work" } })
    await assert.rejects(
      h.router.markOwnDone.handler({ input: { slug: plain.slug, body: "done", quiet: true } }),
      /`quiet` is only for a scheduled run/,
    )
    assert.equal(h.storage.getSession(plain.slug)!.state, "open")
  } finally {
    h.close()
  }
})

test("a worker proposes; only the human turns it on; skip_next and move_next act on one occurrence", async () => {
  const h = harness()
  try {
    // The caller must be a registered thread.
    const caller = await h.router.createLazyThread.handler({ input: { prompt: "x", title: "Caller" } })
    const spec = { slug: caller.slug, title: "Dep bumps", prompt: "Bump the deps.", when: "first weekday of the month at 10", rrule: "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1;BYHOUR=10;BYMINUTE=0", dtstart: "2026-10-05T10:00", tz: "UTC", model: "sonnet", effort: "medium" as const }
    const dry = await h.router.ownSchedule.handler({ input: { action: "dry_run", ...spec } })
    assert.match(dry.text, /^Dry run — nothing was saved/)
    assert.match(dry.text, /Dep bumps · on the first weekday of every month at 10am/)
    assert.equal(h.storage.listSchedules().length, 0)
    const made = await h.router.ownSchedule.handler({ input: { action: "create", ...spec } })
    assert.equal(made.schedule!.state, "proposed")
    assert.equal(made.schedule!.attention, true)
    assert.equal(made.schedule!.nextRun, undefined, "a proposal materializes nothing")
    assert.match(made.text, /does NOT run until the human clicks Turn on/)
    assert.match(made.text, /Next: Mon Nov 2 · Tue Dec 1 · Fri Jan 1/)
    // It may refine its own proposal…
    const id = made.schedule!.id
    await h.router.ownSchedule.handler({ input: { action: "update", slug: caller.slug, id, prompt: "Bump the deps, then run the tests." } })
    // …but not anyone else's, and not once it is on.
    const other = await h.router.createLazyThread.handler({ input: { prompt: "y", title: "Other" } })
    await assert.rejects(h.router.ownSchedule.handler({ input: { action: "update", slug: other.slug, id, title: "Hijack" } }), /only change a schedule you proposed/)
    const on = h.service.setState(id, "active")
    assert.equal(on.state, "active")
    assert.equal(on.nextRun!.occurrenceAt, "2026-11-02T10:00:00.000Z")
    await assert.rejects(h.router.ownSchedule.handler({ input: { action: "update", slug: caller.slug, id, title: "Renamed" } }), /only change a schedule you proposed/)
    // move_next: only that occurrence moves, and never past the one after it.
    const moved = await h.router.ownSchedule.handler({ input: { action: "move_next", slug: caller.slug, id, to: "2026-11-03T10:00" } })
    assert.match(moved.text, /Moved the run for Mon Nov 2, 10am to Tue Nov 3, 10am\. The rule is unchanged\./)
    await assert.rejects(h.router.ownSchedule.handler({ input: { action: "move_next", slug: caller.slug, id, to: "2026-12-02T10:00" } }), /past the run after it/)
    const skipped = await h.router.ownSchedule.handler({ input: { action: "skip_next", slug: caller.slug, id, reason: "release freeze" } })
    assert.match(skipped.text, /Skipped the run for Mon Nov 2, 10am\. The next one is Tue Dec 1, 10am\./)
    assert.equal(h.service.get(id).history[0]!.label, "Skipped: release freeze")
    const paused = await h.router.ownSchedule.handler({ input: { action: "pause", slug: caller.slug, id } })
    assert.equal(paused.schedule!.state, "paused")
    assert.equal(paused.schedule!.attention, false, "a deliberate pause is not Frizz's to flag")
  } finally {
    h.close()
  }
})

test("validation: the cap, the title, the spacing floor", async () => {
  const h = harness()
  try {
    assert.throws(() => h.service.create({ ...WEEKLY, title: "Triage every new issue" }), /one or two short words/)
    assert.throws(() => h.service.create({ ...WEEKLY, rrule: "FREQ=HOURLY;BYMINUTE=0,5" }), /less than 15 minutes apart/)
    for (let i = 0; i < 25; i++) h.service.create({ ...WEEKLY, title: `Job ${i}` })
    assert.throws(() => h.service.create({ ...WEEKLY, title: "One more" }), /A project can hold 25 schedules/)
  } finally {
    h.close()
  }
})

test("an edit re-points the next run: a new rule re-snoozes it, a new prompt reaches an untouched note only", async () => {
  const h = harness()
  try {
    const view = h.service.create(WEEKLY)
    const slug = view.nextRun!.slug
    const edited = h.service.update({ id: view.id, rrule: "FREQ=WEEKLY;BYDAY=TU;BYHOUR=10;BYMINUTE=0", whenText: "every Tuesday at 10am", prompt: "New prompt." })
    assert.equal(edited.nextRun!.slug, slug, "the same lazy row")
    assert.equal(edited.nextRun!.at, "2026-10-06T10:00:00.000Z")
    assert.equal(h.storage.getSession(slug)!.lazy_prompt, "New prompt.")
    // The human edits this run's note; a later prompt change leaves it alone.
    await h.router.updateLazyPrompt.handler({ input: { slug, sessionId: edited.nextRun!.sessionId, prompt: "Just this once." } })
    h.service.update({ id: view.id, prompt: "Newer prompt." })
    assert.equal(h.storage.getSession(slug)!.lazy_prompt, "Just this once.")
    assert.throws(() => h.service.update({ id: view.id, revision: 0, title: "Stale" }), /changed while you were editing/)
    h.service.remove(view.id)
    assert.equal(h.storage.getSession(slug), undefined, "deleting the schedule removes its unstarted run")
    assert.equal(h.storage.listSchedules().length, 0)
  } finally {
    h.close()
  }
})

test("a failure that is not auth reads plainly, and the lazy row survives for the next occurrence", async () => {
  const h = harness()
  try {
    const view = h.service.create(WEEKLY)
    h.failWith(() => new Error("daemon exited before it became ready"))
    h.at(MON_9AM + 1000)
    await h.tick()
    const got = h.service.get(view.id)
    assert.match(got.history[0]!.label, /^Didn't start: Claude session broker could not start this thread: daemon exited/)
    assert.equal(got.schedule.nextRun!.slug, view.nextRun!.slug, "the failed run's row is reused")
    assert.equal(got.schedule.nextRun!.occurrenceAt, new Date(NEXT_MON_9AM).toISOString())
    assert.equal(got.schedule.state, "active")
  } finally {
    h.close()
  }
})

test("ProviderAuthRequiredError reads as signed out", async () => {
  const { scheduleStartFailure } = await import("./schedules.ts")
  assert.equal(scheduleStartFailure(new ProviderAuthRequiredError("codex")), "Codex is signed out")
  assert.equal(scheduleStartFailure(new Error("spawn x ENOENT")), "the project folder is missing")
})

test("after a long absence the newest occurrence still inside its own cap runs once; the older ones are skipped", async () => {
  // Daily at 9. Frizz went off on Friday after 10am and came back Monday at 9:19. Saturday's run, the one
  // materialized, is two days late; Monday's is twenty minutes late, well inside its 12h cap, and must run.
  const h = harness({ nowMs: T("2026-10-02T10:00:00Z"), bootAtMs: T("2026-10-05T09:19:00Z") })
  try {
    const view = h.service.create({ ...WEEKLY, rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0", dtstart: "2026-10-02T09:00" })
    assert.equal(view.nextRun!.occurrenceAt, "2026-10-03T09:00:00.000Z", "Saturday is the materialized run")
    h.at(T("2026-10-05T09:20:00Z"))
    await h.tick()
    assert.equal(h.spawned.length, 1, "Monday's run starts")
    assert.match(h.spawned[0]!.prompt, /This run is for Mon Oct 5, 9am\. It started 20m late, because Frizz was off\./)
    const got = h.service.get(view.id)
    assert.deepEqual(got.history.map((r) => [r.occurrenceAt, r.state]), [
      ["2026-10-05T09:00:00.000Z", "started"],
      ["2026-10-03T09:00:00.000Z", "skipped"],
    ])
    assert.equal(got.history[1]!.label, "Skipped: Frizz was off; 2 runs missed", "Saturday and Sunday")
    assert.equal(got.schedule.nextRun!.occurrenceAt, "2026-10-06T09:00:00.000Z")
    await h.tick()
    assert.equal(h.spawned.length, 1, "and nothing more")
  } finally {
    h.close()
  }
})

test("a rule edit moves the next run but keeps the note the human wrote for it", async () => {
  const h = harness()
  try {
    const view = h.service.create(WEEKLY)
    const next = view.nextRun!
    await h.router.updateLazyPrompt.handler({ input: { slug: next.slug, sessionId: next.sessionId, prompt: "Just this once: only the bug reports." } })
    const edited = h.service.update({ id: view.id, rrule: "FREQ=WEEKLY;BYDAY=TU;BYHOUR=10;BYMINUTE=0", whenText: "every Tuesday at 10am" })
    assert.equal(edited.nextRun!.slug, next.slug)
    assert.equal(edited.nextRun!.at, "2026-10-06T10:00:00.000Z")
    assert.equal(h.storage.getSession(next.slug)!.lazy_prompt, "Just this once: only the bug reports.")
    h.at(T("2026-10-06T10:00:05Z"))
    await h.tick()
    assert.equal(h.spawned.length, 1)
    assert.match(h.spawned[0]!.prompt, /Just this once: only the bug reports\.$/)
  } finally {
    h.close()
  }
})

test("Mark as done then Undo before the next pass leaves the next run at its time, not due now", async () => {
  // Archiving clears a row's snooze (storage setState), so the Undo — the mobile triage toast, or the
  // rail's uncheck — hands back the pending run with NO instant before the scheduler has reconciled the
  // skip. It must not read that as "due now": a Monday run must not fire on a Tuesday.
  const h = harness({ nowMs: T("2026-10-06T08:00:00Z") })
  try {
    const view = h.service.create(WEEKLY)
    const next = view.nextRun!
    assert.equal(next.occurrenceAt, new Date(NEXT_MON_9AM).toISOString())
    await h.router.setThreadState.handler({ input: { slug: next.slug, state: "archived" } })
    await h.router.setThreadState.handler({ input: { slug: next.slug, state: "open" } })
    h.at(T("2026-10-06T08:00:10Z"))
    await h.tick()
    assert.equal(h.spawned.length, 0, "nothing starts on Tuesday")
    const got = h.service.get(view.id)
    assert.equal(got.history.length, 0, "and nothing was skipped: the Undo took the skip back")
    assert.equal(got.schedule.nextRun!.slug, next.slug)
    assert.equal(h.storage.getSession(next.slug)!.snoozed_until, new Date(NEXT_MON_9AM).toISOString(), "parked at its time again")
    h.at(NEXT_MON_9AM + 1000)
    await h.tick()
    assert.equal(h.spawned.length, 1, "it runs at its occurrence")
  } finally {
    h.close()
  }
})

// ---- the provisional title's rename (plans/schedule-live-reading.md §10.2, §15.1 "Title compare-and-set") --

/** A namer whose answers the test releases by hand, recording what it was asked. */
function heldNamer() {
  const asked: { source: string; exceptSlug?: string }[] = []
  const answers: { resolve: (name: string) => void; reject: (error: Error) => void }[] = []
  const nameFor = (source: string, exceptSlug?: string) => {
    asked.push({ source, ...(exceptSlug !== undefined ? { exceptSlug } : {}) })
    return new Promise<string>((resolve, reject) => answers.push({ resolve, reject }))
  }
  return { nameFor, asked, answers }
}
/** Let the rename's continuation run (it is fire-and-forget off `create`). */
const settle = () => new Promise((r) => setImmediate(r))

test("titleAuto: the namer's name lands when nothing changed, and the pending run's title follows", async () => {
  const namer = heldNamer()
  const h = harness({ nameFor: namer.nameFor })
  try {
    const view = h.service.create({ ...WEEKLY, titleAuto: true })
    assert.equal(view.title, "Triage issues", "create answers with the provisional title at once")
    const slug = view.nextRun!.slug
    assert.deepEqual(namer.asked, [{ source: WEEKLY.prompt, exceptSlug: slug }], "named from the prompt, not counting its own run")
    namer.answers[0]!.resolve("Issue triage")
    await settle()
    const after = h.service.get(view.id).schedule
    assert.equal(after.title, "Issue triage")
    assert.equal(after.echo, "Issue triage · every Monday at 9am")
    assert.equal(h.storage.getSession(slug)!.title, "Issue triage", "the pending run carries the new name")
    assert.equal(after.nextRun!.slug, slug, "the same pending run, not a new one")
  } finally {
    h.close()
  }
})

test("titleAuto: a human rename before the namer answers wins", async () => {
  const namer = heldNamer()
  const h = harness({ nameFor: namer.nameFor })
  try {
    const view = h.service.create({ ...WEEKLY, titleAuto: true })
    const renamed = h.service.update({ id: view.id, revision: view.revision, title: "Inbox sweep" })
    namer.answers[0]!.resolve("Issue triage")
    await settle()
    assert.equal(h.service.get(view.id).schedule.title, "Inbox sweep")
    assert.equal(h.service.get(view.id).schedule.revision, renamed.revision, "the namer wrote nothing")
    assert.equal(h.storage.getSession(view.nextRun!.slug)!.title, "Inbox sweep", "the pending run follows the human")
  } finally {
    h.close()
  }
})

test("titleAuto: any other edit before the answer also keeps the title (compare-and-set on the revision)", async () => {
  const namer = heldNamer()
  const h = harness({ nameFor: namer.nameFor })
  try {
    const view = h.service.create({ ...WEEKLY, titleAuto: true })
    // Same title, new rule: the title compare alone would pass; the revision does not.
    h.service.update({ id: view.id, rrule: "FREQ=WEEKLY;BYDAY=TU;BYHOUR=10;BYMINUTE=0", whenText: "every Tuesday at 10am" })
    namer.answers[0]!.resolve("Issue triage")
    await settle()
    assert.equal(h.service.get(view.id).schedule.title, "Triage issues")
  } finally {
    h.close()
  }
})

test("titleAuto: a deleted schedule, a failed namer and an unusable name all leave things as they are", async () => {
  const namer = heldNamer()
  const logged: string[] = []
  const h = harness({ nameFor: namer.nameFor, log: (m) => logged.push(m) })
  try {
    const gone = h.service.create({ ...WEEKLY, titleAuto: true })
    h.service.remove(gone.id)
    namer.answers[0]!.resolve("Issue triage")
    const failed = h.service.create({ ...WEEKLY, titleAuto: true })
    namer.answers[1]!.reject(new Error("Claude did not answer within 60s"))
    const long = h.service.create({ ...WEEKLY, titleAuto: true })
    namer.answers[2]!.resolve("Triage of every new issue")
    await settle()
    assert.equal(h.storage.listSchedules().length, 2, "the deleted one stays deleted")
    assert.equal(h.service.get(failed.id).schedule.title, "Triage issues")
    assert.equal(h.service.get(long.id).schedule.title, "Triage issues")
    assert.equal(h.service.get(long.id).schedule.revision, long.revision)
    assert.ok(logged.some((m) => /naming schedule .* failed; it keeps "Triage issues": Claude did not answer/.test(m)), logged.join("\n"))
  } finally {
    h.close()
  }
})

test("titleAuto with no namer (FRIZZ_THREAD_NAMER=0) keeps the provisional title; without titleAuto the namer is never asked", async () => {
  const off = harness()
  const namer = heldNamer()
  const on = harness({ nameFor: namer.nameFor })
  try {
    const kept = off.service.create({ ...WEEKLY, titleAuto: true })
    await settle()
    assert.equal(off.service.get(kept.id).schedule.title, "Triage issues")
    assert.equal(off.service.get(kept.id).schedule.revision, kept.revision)
    on.service.create(WEEKLY)
    await settle()
    assert.equal(namer.asked.length, 0, "a human-typed title is never renamed")
  } finally {
    off.close()
    on.close()
  }
})

// ---- the server re-derives a local reading (plans/schedule-live-reading.md §10.1, §15.1 "Server") ---------
// A rule the browser read with the local grammar arrives with `source`; the server reads `whenText` again with
// the same grammar at its own clock and writes only a rule that reads back identically.

const LOCAL = { kind: "local" as const, grammar: SCHEDULE_GRAMMAR_VERSION }

test("a local reading that reads back identically is created; a model reading (no source) is gated as before", async () => {
  const h = harness()
  try {
    // At Mon 8am UTC "every Monday at 9am" first runs at 9am today: WEEKLY's own rrule and dtstart.
    const view = h.service.create({ ...WEEKLY, source: LOCAL })
    assert.equal(view.rrule, WEEKLY.rrule)
    assert.equal(view.dtstart, WEEKLY.dtstart)
    assert.ok(view.nextRun, "it is a real schedule, with its next run")
    // A model reading may carry a rule the grammar would not read from these words (a condition, a guess):
    // with no `source` nothing re-reads it.
    const model = h.service.create({ ...WEEKLY, whenText: "every Monday unless it's a holiday", condition: "unless it's a holiday" })
    assert.equal(model.condition, "unless it's a holiday")
  } finally {
    h.close()
  }
})

test("a local reading whose rule or start differs is refused as schedule-reading-moved, and nothing is written", async () => {
  const h = harness()
  try {
    const before = h.storage.allSessions().length
    const cases = [
      { ...WEEKLY, rrule: "FREQ=WEEKLY;BYDAY=TU;BYHOUR=9;BYMINUTE=0" },
      { ...WEEKLY, dtstart: "2026-10-12T09:00" },
      // Words with more in them than a phrase: the field must be the WHOLE string.
      { ...WEEKLY, whenText: "every Monday at 9am triage new issues" },
      // Words the grammar hands to the model: a cue is never a local reading.
      { ...WEEKLY, whenText: "every Monday at 9am unless it's a holiday" },
    ]
    for (const input of cases) {
      assert.throws(() => h.service.create({ ...input, source: LOCAL }), (error: Error) => {
        assert.equal(scheduleRefusalOf(error), SCHEDULE_READING_MOVED, error.message)
        return true
      })
    }
    assert.equal(h.storage.listSchedules().length, 0, "no schedule")
    assert.equal(h.storage.allSessions().length, before, "and no next run")
  } finally {
    h.close()
  }
})

test("the server's clock decides: a reading whose runs from now are the same is created at the server's start", async () => {
  // Read in the browser at 14:39 UTC: "every day at 2:40pm" first runs at 14:40 today. Saved at 14:41 the
  // same words start tomorrow — and every run from now on is the same run: created, at the server's start.
  // (Until fix round 1 this was refused, and a browser whose clock ran behind the server's read the same
  // start again, was refused a second time, and was told to reload.)
  const h = harness({ nowMs: T("2026-10-05T14:41:00Z") })
  try {
    const read = { ...WEEKLY, whenText: "every day at 2:40pm", rrule: "FREQ=DAILY;BYHOUR=14;BYMINUTE=40", dtstart: "2026-10-05T14:40" }
    const made = h.service.create({ ...read, source: LOCAL })
    assert.equal(made.dtstart, "2026-10-06T14:40", "stored as the server reads it")
    assert.equal(made.nextRun!.occurrenceAt, new Date(T("2026-10-06T14:40:00Z")).toISOString())
  } finally {
    h.close()
  }
})

test("rederiveLocalReading: a start the clocks disagree on is accepted only when every run from now agrees (fix round 1)", () => {
  const NY = "America/New_York"
  // The skew repro: the browser reads "every 15 minutes" at 14:44:40 (first run 14:45), the server
  // re-derives 30s later (first run 15:00). Same rule, same runs from the server's now.
  const at = T("2026-10-05T14:44:40-04:00")
  const read = readSchedulePhrase("every 15 minutes", { nowMs: at, tz: NY, scope: "field" })
  assert.ok(read.kind === "exact")
  assert.equal(read.dtstart, "2026-10-05T14:45")
  for (const [skew, start] of [[2_000, "2026-10-05T14:45"], [30_000, "2026-10-05T15:00"], [90_000, "2026-10-05T15:00"]] as const) {
    const dtstart = rederiveLocalReading(LOCAL, { whenText: "every 15 minutes", rrule: read.rrule, dtstart: read.dtstart, tz: NY }, at + skew)
    assert.equal(dtstart, start, `server ${skew / 1000}s ahead: created, at the server's start`)
  }
  // Read identically: the start it was sent.
  assert.equal(rederiveLocalReading(LOCAL, { whenText: "every 15 minutes", rrule: read.rrule, dtstart: read.dtstart, tz: NY }, at), "2026-10-05T14:45")
  // A once is its start: a run the human saw that the server would not make is refused, never moved.
  const once = readSchedulePhrase("today at 2:45pm", { nowMs: at, tz: NY, scope: "field" })
  assert.ok(once.kind === "exact", "today at 2:45pm reads at 14:44:40")
  assert.throws(
    () => rederiveLocalReading(LOCAL, { whenText: "today at 2:45pm", rrule: once.rrule, dtstart: once.dtstart, tz: NY }, at + 30_000),
    (error: Error) => scheduleRefusalOf(error) === SCHEDULE_READING_MOVED,
  )
  // A count is anchored at its start: moving the start moves the last run, so it is refused too.
  assert.throws(
    () => rederiveLocalReading(LOCAL, { whenText: "every 15 minutes", rrule: `${read.rrule};COUNT=4`, dtstart: read.dtstart, tz: NY }, at + 30_000),
    (error: Error) => scheduleRefusalOf(error) === SCHEDULE_READING_MOVED,
  )
  // And a start that changes which runs come (an interval anchored elsewhere) is refused.
  assert.throws(
    () => rederiveLocalReading(LOCAL, { whenText: "every 2 days at 9am", rrule: "FREQ=DAILY;INTERVAL=2;BYHOUR=9;BYMINUTE=0", dtstart: "2026-10-07T09:00", tz: NY }, at),
    (error: Error) => scheduleRefusalOf(error) === SCHEDULE_READING_MOVED,
  )
})

test("a grammar version the server does not run is refused as schedule-grammar-stale, before any re-read", async () => {
  const h = harness()
  try {
    for (const grammar of [SCHEDULE_GRAMMAR_VERSION + 1, ...(SCHEDULE_GRAMMAR_VERSION > 1 ? [SCHEDULE_GRAMMAR_VERSION - 1] : [])]) {
      // The words and the rule agree, so only the version can be what refuses it.
      assert.throws(() => h.service.create({ ...WEEKLY, source: { kind: "local", grammar } }), (error: Error) => {
        assert.equal(scheduleRefusalOf(error), SCHEDULE_GRAMMAR_STALE, error.message)
        return true
      })
    }
    assert.equal(h.storage.listSchedules().length, 0)
  } finally {
    h.close()
  }
})

test("update: a local reading is re-derived against the words that will be stored", async () => {
  const h = harness()
  try {
    const view = h.service.create(WEEKLY)
    // Change when, read locally: "every Tuesday at 10am" at Mon 8am UTC first runs Tue Oct 6 10:00.
    const tuesday = { whenText: "every Tuesday at 10am", rrule: "FREQ=WEEKLY;BYDAY=TU;BYHOUR=10;BYMINUTE=0", dtstart: "2026-10-06T10:00" }
    const moved = (patch: object) => assert.throws(
      () => h.service.update({ id: view.id, ...patch, source: LOCAL }),
      (error: Error) => scheduleRefusalOf(error) === SCHEDULE_READING_MOVED,
    )
    moved({ ...tuesday, dtstart: "2026-10-13T10:00" })
    moved({ ...tuesday, rrule: WEEKLY.rrule })
    // A rule sent without its words is held to the STORED words, which read as the old rule.
    moved({ rrule: tuesday.rrule, dtstart: tuesday.dtstart })
    assert.throws(
      () => h.service.update({ id: view.id, ...tuesday, source: { kind: "local", grammar: SCHEDULE_GRAMMAR_VERSION + 1 } }),
      (error: Error) => scheduleRefusalOf(error) === SCHEDULE_GRAMMAR_STALE,
    )
    const untouched = h.service.get(view.id).schedule
    assert.equal(untouched.rrule, WEEKLY.rrule, "every refusal wrote nothing")
    assert.equal(untouched.revision, view.revision)
    const saved = h.service.update({ id: view.id, revision: view.revision, ...tuesday, tz: "UTC", source: LOCAL })
    assert.equal(saved.rrule, tuesday.rrule)
    assert.equal(saved.whenText, "every Tuesday at 10am")
    assert.equal(saved.nextRun!.occurrenceAt, new Date(T("2026-10-06T10:00:00Z")).toISOString(), "the next run moved to the new rule")
  } finally {
    h.close()
  }
})

test("the refusal's code survives the wire: the RPC envelope's error names it for the browser", async () => {
  const h = harness()
  try {
    const app = new Hono()
    mountRouter(app, "/_frizz/rpc", h.router)
    const post = async (input: object) => {
      const response = await app.request("http://localhost/_frizz/rpc/createSchedule", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      })
      return { status: response.status, json: await response.json() as { error?: string; result?: { id: string } } }
    }
    const stale = await post({ ...WEEKLY, source: { kind: "local", grammar: SCHEDULE_GRAMMAR_VERSION + 1 } })
    assert.equal(stale.status, 500)
    assert.equal(scheduleRefusalOf(stale.json.error), SCHEDULE_GRAMMAR_STALE, stale.json.error)
    const moved = await post({ ...WEEKLY, dtstart: "2026-10-12T09:00", source: LOCAL })
    assert.equal(scheduleRefusalOf(moved.json.error), SCHEDULE_READING_MOVED, moved.json.error)
    const made = await post({ ...WEEKLY, source: LOCAL, titleAuto: true })
    assert.equal(made.status, 200)
    assert.match(made.json.result!.id, /^sch_/)
    // The schema refuses a source that is not the local grammar's.
    const odd = await post({ ...WEEKLY, source: { kind: "model", grammar: 1 } })
    assert.equal(odd.status, 400)
  } finally {
    h.close()
  }
})

test("rederiveLocalReading: an invalid zone is said plainly, not as a moved reading", () => {
  assert.throws(
    () => rederiveLocalReading(LOCAL, { whenText: "every Monday at 9am", rrule: WEEKLY.rrule, dtstart: WEEKLY.dtstart, tz: "Mars/Olympus" }, MON_8AM),
    (error: Error) => scheduleRefusalOf(error) === undefined && /not an IANA time zone/.test(error.message),
  )
  assert.doesNotThrow(() => rederiveLocalReading(undefined, { whenText: "anything", rrule: "x", dtstart: "y", tz: "Mars/Olympus" }, MON_8AM), "no source, no re-read")
})
