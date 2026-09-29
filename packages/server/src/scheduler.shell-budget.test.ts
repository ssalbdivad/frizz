import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage, type SessionRow, type Storage } from "./storage.ts"
import { createScheduler } from "./scheduler.ts"
import type { BgShellView, SessionTelemetry, Tailer, TurnState } from "./tailer.ts"
import {
  declaredShellBudgetMs,
  liveShellBudget,
  SHELL_BUDGET_DEFAULT_MS,
  SHELL_BUDGET_GRACE_MS,
  SHELL_BUDGET_MAX_MS,
  SHELL_BUDGET_MIN_MS,
  shellLaunchBudgetMs,
  shellStopNotice,
  type ShellStopReason,
} from "./shell-budget.ts"

// THE BACKGROUND-SHELL RUNTIME BUDGET (shell-budget.ts, scheduler SOURCE 13).
//
// Maintainer 2026-09-29: "background shells running for 16 hours makes no sense". What must hold:
//  · the budget a launch carries — its Bash `timeout`, clamped, else 1h;
//  · ONE warning per deadline, however many passes and however many restarts see it overrun;
//  · the kill GRACE after that warning, through the injected stop (the operator's × in production);
//  · an extension moving the deadline defers both, and supersedes a warning still in the outbox;
//  · a shell frizz cannot stop is warned and never killed — and told so.

const HOUR = 60 * 60_000
const START = Date.parse("2026-09-29T09:00:00.000Z")

test("a launch's budget: its `timeout`, clamped to [1m, 24h]; none (or garbage) is the 1h default", () => {
  assert.equal(declaredShellBudgetMs(undefined), undefined)
  assert.equal(declaredShellBudgetMs("7200000"), undefined, "a string is not a declared budget")
  assert.equal(declaredShellBudgetMs(0), undefined)
  assert.equal(declaredShellBudgetMs(-5), undefined)
  assert.equal(declaredShellBudgetMs(2 * HOUR), 2 * HOUR)
  assert.equal(declaredShellBudgetMs(48 * HOUR), SHELL_BUDGET_MAX_MS, "clamped to a day")
  assert.equal(declaredShellBudgetMs(5_000), SHELL_BUDGET_MIN_MS, "a budget of seconds is a mis-sized timeout, floored")
  assert.equal(shellLaunchBudgetMs(undefined), SHELL_BUDGET_DEFAULT_MS)
  assert.equal(SHELL_BUDGET_DEFAULT_MS, HOUR)
  assert.equal(shellLaunchBudgetMs(3 * HOUR), 3 * HOUR)
})

test("the kill notice says WHY: the operator's words stay put, a budget stop names the budget", () => {
  assert.match(shellStopNotice("Watching CI"), /^\[frizz\] The operator stopped your background command "Watching CI" from the Frizz dashboard/)
  const budget = shellStopNotice("npx vite", { kind: "budget", ranMs: HOUR + 10 * 60_000, budgetMs: HOUR })
  assert.match(budget, /^\[frizz\] Frizz stopped your background command "npx vite" after 1h 10m: it ran past its 1h budget/)
  assert.match(budget, /mcp__frizz__extend_shell/)
  assert.match(budget, /do not wait on it/)
})

// ---- the scheduler pass ----

function row(slug: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug, session_id: `sid-${slug}`, thread_name: `frizz-${slug}`, spawned_at: "2026-09-29T08:00:00.000Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: slug,
    state: "open", meta: null, seen_at: null, transcript_id: null, ...over,
  } as SessionRow
}

function shell(over: Partial<BgShellView> = {}): BgShellView {
  return { label: "npx vite --port 5231", startedAt: new Date(START).toISOString(), state: "running", id: "toolu_sh", taskId: "bvite1", stoppable: true, budgetMs: HOUR, ...over }
}

function tele(shells: BgShellView[], turn: TurnState = "idle"): SessionTelemetry {
  return { turn, permPrompt: false, subAgents: [], bgShells: shells, pendingQuestion: false }
}

function harness(opts: { stoppable?: boolean; stopThrows?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "frizz-shell-budget-"))
  const dbPath = join(dir, "ui.db")
  let storage: Storage = createStorage(dbPath, "p")
  const teleMap = new Map<string, SessionTelemetry>()
  const resumes: { slug: string; message: string; deliveryId: string }[] = []
  const stops: { slug: string; id: string; reason: ShellStopReason; notify: boolean }[] = []
  const clock = { ms: START }
  const tailer: Tailer = {
    get: (slug) => teleMap.get(slug), foreignIds: () => [], subAgent: () => undefined,
    forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
  }
  const make = () => createScheduler({
    storage,
    tailer,
    resume: (slug, message, deliveryId) => void resumes.push({ slug, message, deliveryId }),
    now: () => clock.ms,
    fetchPr: async () => undefined,
    fetchGithubReview: async () => [],
    log: () => {},
    wakeQuietWindowMs: 0,
    shellControl: {
      stoppable: () => opts.stoppable !== false,
      stop: async (slug, id, reason, stopOpts) => {
        if (opts.stopThrows) throw new Error("daemon went away")
        stops.push({ slug, id, reason, notify: stopOpts.notify })
        // The real stop retires the row from tracking; so does this.
        const t = teleMap.get(slug)
        if (t) teleMap.set(slug, { ...t, bgShells: t.bgShells.filter((s) => s.id !== id) })
        return { stopped: true, note: null }
      },
    },
  })
  return {
    get storage() { return storage },
    tele: teleMap, resumes, stops, clock, make,
    /** A server restart: the same database file, a fresh connection and a fresh scheduler. */
    restart() {
      storage.close()
      storage = createStorage(dbPath, "p")
      return make()
    },
    cleanup() { storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

const warnings = (resumes: { message: string }[]) => resumes.filter((r) => /past its .* budget/.test(r.message))

test("inside its budget a shell is left alone; past it, ONE warning — across passes and a restart", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    h.storage.setBackend("t", "claude")
    h.tele.set("t", tele([shell()]))
    let s = h.make()
    h.clock.ms = START + HOUR - 60_000
    await s.tick()
    assert.equal(warnings(h.resumes).length, 0, "a minute short of the budget: nothing")

    h.clock.ms = START + HOUR + 30_000
    await s.tick()
    await s.tick()
    assert.equal(warnings(h.resumes).length, 1, "past it: exactly one warning over two passes")
    assert.equal(h.storage.getShellBudget("t", "toolu_sh")?.warned_deadline, START + HOUR, "the warning is durable on the budget row, not only in the outbox")
    const w = warnings(h.resumes)[0]!
    assert.match(w.message, /Your background shell `bvite1` \(npx vite --port 5231\) has been running 1h, past its 1h budget/)
    assert.match(w.message, /Frizz stops it in 10m unless you extend it/)
    assert.match(w.message, /mcp__frizz__extend_shell` with `shell: "bvite1"`/)
    assert.match(w.message, /TaskStop/)
    assert.match(w.message, /⏱ /, "frizz-authored, so it carries the wall clock")
    await s.stop()

    // A RESTART — the outbox row is still there, and more to the point the budget row records the
    // warning, so a fresh scheduler must not warn again for the same deadline.
    h.clock.ms += 60_000
    s = h.restart()
    await s.tick()
    assert.equal(warnings(h.resumes).length, 1, "a restart does not re-warn the same deadline")
    assert.deepEqual(h.stops, [], "and nothing is stopped inside the grace")
    await s.stop()
  } finally {
    h.cleanup()
  }
})

test("the warning goes out MID-TURN — its grace clock is already running", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    h.tele.set("t", tele([shell()], "in-flight"))
    const s = h.make()
    h.clock.ms = START + HOUR + 1_000
    await s.tick()
    assert.equal(warnings(h.resumes).length, 1, "delivered while the worker is busy")
    await s.stop()
  } finally {
    h.cleanup()
  }
})

test("unanswered, the shell is stopped GRACE after the warning — through the shared stop, with the reason", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    h.tele.set("t", tele([shell()]))
    const s = h.make()
    const warnedAt = START + HOUR + 5_000
    h.clock.ms = warnedAt
    await s.tick()
    h.clock.ms = warnedAt + SHELL_BUDGET_GRACE_MS - 1_000
    await s.tick()
    assert.equal(h.stops.length, 0, "one second short of the grace: still running")
    h.clock.ms = warnedAt + SHELL_BUDGET_GRACE_MS
    await s.tick()
    assert.equal(h.stops.length, 1)
    assert.equal(h.stops[0]!.id, "toolu_sh", "addressed by the row id the × uses")
    assert.equal(h.stops[0]!.notify, true, "the worker is told")
    assert.deepEqual(h.stops[0]!.reason, { kind: "budget", ranMs: HOUR + 5_000 + SHELL_BUDGET_GRACE_MS, budgetMs: HOUR })
    assert.notEqual(h.storage.getShellBudget("t", "toolu_sh")?.stopped_at, null, "recorded")
    await s.tick()
    assert.equal(h.stops.length, 1, "a stopped shell is not stopped twice")
    await s.stop()
  } finally {
    h.cleanup()
  }
})

test("the grace counts from the WARNING: a server down across the deadline still gives the worker its window", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    h.tele.set("t", tele([shell()]))
    const s = h.make()
    // First pass the scheduler ever runs is three hours past the deadline.
    h.clock.ms = START + 4 * HOUR
    await s.tick()
    assert.equal(warnings(h.resumes).length, 1)
    assert.match(warnings(h.resumes)[0]!.message, /has been running 4h, past its 1h budget/)
    assert.deepEqual(h.stops, [], "not killed on first sight, however late")
    h.clock.ms += SHELL_BUDGET_GRACE_MS
    await s.tick()
    assert.equal(h.stops.length, 1)
    await s.stop()
  } finally {
    h.cleanup()
  }
})

test("an extension defers the warning, supersedes one already queued, and re-arms at the new deadline", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    h.tele.set("t", tele([shell()], "in-flight"))
    // AHEAD OF TIME: extended before the first deadline, so nothing happens at it.
    h.storage.extendShellBudget({ slug: "t", shellId: "toolu_sh", startedAt: shell().startedAt, deadlineAtMs: START + 3 * HOUR, nowMs: START + 30 * 60_000 })
    const s = h.make()
    h.clock.ms = START + 2 * HOUR
    await s.tick()
    assert.equal(warnings(h.resumes).length, 0, "the extended deadline governs, not the launch budget")

    // Past the extended deadline: warned, and then extended IN THE MOMENT before the grace runs out.
    h.clock.ms = START + 3 * HOUR + 1_000
    await s.tick()
    assert.equal(warnings(h.resumes).length, 1)
    assert.match(warnings(h.resumes)[0]!.message, /past its 3h budget/, "the budget read back is the one in force")
    h.storage.extendShellBudget({ slug: "t", shellId: "toolu_sh", startedAt: shell().startedAt, deadlineAtMs: h.clock.ms + 2 * HOUR, nowMs: h.clock.ms })
    h.clock.ms += SHELL_BUDGET_GRACE_MS + 1_000
    await s.tick()
    assert.deepEqual(h.stops, [], "an extension inside the grace cancels the kill")
    assert.equal(warnings(h.resumes).length, 1)

    // …and the NEW deadline gets its own warning when it, too, runs out.
    h.clock.ms = START + 5 * HOUR + 2_000
    await s.tick()
    assert.equal(warnings(h.resumes).length, 2, "a moved deadline is warned afresh")
    await s.stop()
  } finally {
    h.cleanup()
  }
})

test("a warning still QUEUED when the worker extends is superseded, not delivered", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    h.tele.set("t", tele([shell()]))
    // A resume that throws keeps the wake in the outbox for retry.
    let fail = true
    const resumes: string[] = []
    const s = createScheduler({
      storage: h.storage,
      tailer: { get: (slug) => h.tele.get(slug), foreignIds: () => [], subAgent: () => undefined, forget: () => {}, start: () => {}, stop: () => {}, tick: () => {} },
      resume: (_slug, message) => {
        if (fail) throw new Error("socket down")
        resumes.push(message)
      },
      now: () => h.clock.ms,
      log: () => {},
      wakeQuietWindowMs: 0,
      retryBaseMs: 1,
      retryMaxMs: 1,
      deliveryLeaseMs: 1,
    })
    h.clock.ms = START + HOUR + 1_000
    await s.tick()
    assert.equal(resumes.length, 0, "the first attempt failed and is held for retry")
    h.storage.extendShellBudget({ slug: "t", shellId: "toolu_sh", startedAt: shell().startedAt, deadlineAtMs: h.clock.ms + HOUR, nowMs: h.clock.ms })
    fail = false
    h.clock.ms += 60_000
    await s.tick()
    await s.tick()
    assert.deepEqual(resumes.filter((m) => /past its/.test(m)), [], "the extension made the queued warning untrue")
    await s.stop()
  } finally {
    h.cleanup()
  }
})

test("a shell frizz cannot stop is WARNED, told frizz cannot stop it, and never killed", async () => {
  const h = harness({ stoppable: false })
  try {
    h.storage.upsertSession(row("t"))
    h.tele.set("t", tele([shell({ stoppable: undefined })]))
    const s = h.make()
    h.clock.ms = START + HOUR + 1_000
    await s.tick()
    assert.equal(warnings(h.resumes).length, 1)
    assert.match(warnings(h.resumes)[0]!.message, /Frizz cannot stop this one for you/)
    assert.doesNotMatch(warnings(h.resumes)[0]!.message, /Frizz stops it in/)
    h.clock.ms += 5 * SHELL_BUDGET_GRACE_MS
    await s.tick()
    assert.deepEqual(h.stops, [])
    await s.stop()
  } finally {
    h.cleanup()
  }
})

test("a Monitor, a stale shell, and a shell under budget are all left alone", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    h.tele.set("t", tele([
      shell({ id: "toolu_mon", taskId: "bmon", budgetMs: undefined, label: "tail -f log" }),
      shell({ id: "toolu_gone", taskId: "bgone", state: "stale" }),
      shell({ id: "toolu_long", taskId: "blong", budgetMs: 8 * HOUR }),
    ]))
    const s = h.make()
    h.clock.ms = START + 5 * HOUR
    await s.tick()
    h.clock.ms += 2 * SHELL_BUDGET_GRACE_MS
    await s.tick()
    assert.deepEqual(warnings(h.resumes), [])
    assert.deepEqual(h.stops, [])
    await s.stop()
  } finally {
    h.cleanup()
  }
})

test("an ARCHIVED thread is not woken, but its forgotten shell still ends on the same clock — silently", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t", { state: "archived", archived: 1 }))
    h.tele.set("t", tele([shell()]))
    const s = h.make()
    h.clock.ms = START + HOUR + 1_000
    await s.tick()
    assert.deepEqual(warnings(h.resumes), [], "nobody is reading an archived thread")
    h.clock.ms += SHELL_BUDGET_GRACE_MS
    await s.tick()
    assert.equal(h.stops.length, 1)
    assert.equal(h.stops[0]!.notify, false, "and no turn is spent announcing the kill")
    await s.stop()
  } finally {
    h.cleanup()
  }
})

test("a failed stop is retried, spaced — not every tick", async () => {
  const h = harness({ stopThrows: true })
  try {
    h.storage.upsertSession(row("t"))
    h.tele.set("t", tele([shell()]))
    let attempts = 0
    const s = createScheduler({
      storage: h.storage,
      tailer: { get: (slug) => h.tele.get(slug), foreignIds: () => [], subAgent: () => undefined, forget: () => {}, start: () => {}, stop: () => {}, tick: () => {} },
      resume: () => {},
      now: () => h.clock.ms,
      log: () => {},
      wakeQuietWindowMs: 0,
      shellControl: { stoppable: () => true, stop: async () => { attempts++; throw new Error("daemon went away") } },
    })
    h.clock.ms = START + HOUR + 1_000
    await s.tick()
    h.clock.ms += SHELL_BUDGET_GRACE_MS
    await s.tick()
    await s.tick()
    assert.equal(attempts, 1, "one attempt, then a pause")
    h.clock.ms += 5 * 60_000
    await s.tick()
    assert.equal(attempts, 2, "and a retry once the pause is over")
    await s.stop()
  } finally {
    h.cleanup()
  }
})

test("a budget row recorded for a DIFFERENT shell under the same id is ignored (and replaced on write)", () => {
  const h = harness()
  try {
    const older = "2026-09-28T09:00:00.000Z"
    h.storage.extendShellBudget({ slug: "t", shellId: "proc-1", startedAt: older, deadlineAtMs: START + 20 * HOUR, nowMs: START })
    h.storage.markShellBudgetWarned({ slug: "t", shellId: "proc-1", startedAt: older, deadlineMs: START + 20 * HOUR, nowMs: START })
    const live = { id: "proc-1", startedAt: new Date(START).toISOString(), budgetMs: HOUR }
    const budget = liveShellBudget(h.storage, "t", live)
    assert.equal(budget?.deadlineMs, START + HOUR, "the earlier shell's extension does not carry over")
    assert.equal(budget?.record, undefined)
    h.storage.markShellBudgetWarned({ slug: "t", shellId: "proc-1", startedAt: live.startedAt, deadlineMs: START + HOUR, nowMs: START + HOUR })
    const row = h.storage.getShellBudget("t", "proc-1")!
    assert.equal(row.started_at, live.startedAt)
    assert.equal(row.deadline_at, null, "the old shell's extension was reset, not inherited")
    assert.equal(row.warned_deadline, START + HOUR)
  } finally {
    h.cleanup()
  }
})
