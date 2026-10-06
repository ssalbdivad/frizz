import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import type { ClaudeOneShot, ClaudeOneShotRequest } from "./backend/claude-oneshot.ts"
import { BACKGROUND_SUMMARIES_READ_MS, createBackgroundSummaries } from "./background-summaries.ts"
import { createEffortChooser } from "./effort-chooser.ts"
import { createScheduleInterpreter, SCHEDULE_READING_OFF_COPY } from "./schedule-interpreter.ts"
import { createThreadNamer } from "./thread-names.ts"

// Background summaries (Settings, default on) is the one switch over every model call Frizz makes on
// its own. These pin the three things it has to be: read live (no restart), honoured by every caller
// through the same "no completer" fallback it always had, and the ONLY way context.ts hands a caller a
// completer — so a new model call cannot slip past it.

function harness(initial: boolean) {
  let on = initial
  let clock = 1_000_000
  const calls: ClaudeOneShotRequest[] = []
  const logs: string[] = []
  const complete: ClaudeOneShot = async (request) => {
    calls.push(request)
    return "Answer"
  }
  const summaries = createBackgroundSummaries({
    settings: () => ({ backgroundSummaries: on }),
    now: () => clock,
    log: (message) => logs.push(message),
  })
  return {
    summaries,
    complete,
    calls,
    logs,
    set: (value: boolean) => { on = value },
    // Past the memo, so the next read sees the new value.
    tick: () => { clock += BACKGROUND_SUMMARIES_READ_MS },
  }
}

test("the switch is read live: off withholds the completer, on hands it back, with no restart", () => {
  const h = harness(true)
  const model = h.summaries.model("thread name", h.complete)
  assert.equal(typeof model(), "function")
  h.set(false)
  // Inside the memo window the last reading stands — at most two seconds.
  assert.equal(typeof model(), "function")
  h.tick()
  assert.equal(model(), undefined)
  h.set(true)
  h.tick()
  assert.equal(typeof model(), "function")
})

test("an absent setting is on, an environment override can only turn a call off, and a failed read keeps the last value", () => {
  const absent = createBackgroundSummaries({ settings: () => ({}) })
  assert.equal(absent.on(), true)
  const h = harness(true)
  assert.equal(h.summaries.model("auto effort", h.complete, true)(), undefined, "FRIZZ_AUTO_EFFORT=0 wins over on")
  let throws = false
  let clock = 0
  const flaky = createBackgroundSummaries({
    settings: () => {
      if (throws) throw new Error("store unreadable")
      return { backgroundSummaries: false }
    },
    now: () => clock,
  })
  assert.equal(flaky.on(), false)
  throws = true
  clock += BACKGROUND_SUMMARIES_READ_MS
  assert.equal(flaky.on(), false, "an unreadable store is not the human turning it back on")
})

test("every caller falls back with no model call while it is off, and asks again once it is on", async () => {
  const h = harness(false)
  const namerModel = h.summaries.model("thread name", h.complete)
  const effortModel = h.summaries.model("auto effort", h.complete)
  const scheduleModel = h.summaries.model("schedule reading", h.complete)
  // Wired exactly as context.ts wires them: the completer is a getter, read at each call.
  const namer = createThreadNamer({
    storage: { allSessions: () => [], setMintedTitle: () => true },
    get complete() { return namerModel() },
  })
  const chooseEffort = createEffortChooser({ get complete() { return effortModel() } })
  const interpreter = createScheduleInterpreter({ get complete() { return scheduleModel() } })

  assert.equal(namer.available, false)
  await namer.mint("t1", "s1", "fix the login bug")
  await assert.rejects(namer.status({ conversation: "…" }))
  assert.equal(await chooseEffort({ prompt: "rename a variable", efforts: ["low", "medium", "high"], fallback: "high" }), "high")
  assert.deepEqual(await interpreter.interpret({ text: "every Monday at 9am triage issues", tz: "UTC" }), { ok: false, error: SCHEDULE_READING_OFF_COPY })
  assert.equal(h.calls.length, 0, "no model call while off")
  assert.deepEqual(h.logs, [])

  h.set(true)
  h.tick()
  assert.equal(namer.available, true)
  await chooseEffort({ prompt: "rename a variable", efforts: ["low", "medium", "high"], fallback: "high" })
  assert.equal(h.calls.length, 1, "on again, the next dispatch asks")
  assert.match(h.logs[0] ?? "", /^auto effort: asking Claude/)
})

test("context.ts hands out no completer except through the Background summaries switch", () => {
  const source = readFileSync(new URL("./context.ts", import.meta.url), "utf8")
  const made = source.match(/createClaudeOneShot\(/g)?.length ?? 0
  const gated = source.match(/summaries\.model\("[^"]+", createClaudeOneShot\(/g)?.length ?? 0
  assert.ok(made >= 4, `expected the namer, live status, effort and schedule completers, found ${made}`)
  assert.equal(gated, made, "every createClaudeOneShot in context.ts goes through summaries.model")
  // And no module is handed a completer captured once at boot.
  assert.doesNotMatch(source, /\bcomplete: (?!.*summaries)/)
})
