import { test } from "node:test"
import assert from "node:assert/strict"
import { parseScheduledRunPrompt, scheduledRunHeader, scheduledRunPrompt } from "@frizz/shared"
import { proposedByLine, scheduledRunFacts, scheduleNextLabel } from "./schedules.ts"

const NOW = Date.parse("2026-10-05T12:00:00Z")
const next = (at: string) => ({ slug: "triage-issues", sessionId: "s", at, occurrenceAt: at, moved: false })

test("the row's column counts down to the next run in the house grammar", () => {
  assert.equal(scheduleNextLabel({ state: "active", nextRun: next("2026-10-05T15:00:00Z") }, NOW), "in 3h")
  assert.equal(scheduleNextLabel({ state: "active", nextRun: next("2026-10-07T12:00:00Z") }, NOW), "in 2d")
  assert.equal(scheduleNextLabel({ state: "active", nextRun: next("2026-10-05T12:40:00Z") }, NOW), "in 40m")
  // Due and not started yet (a post-boot grace, the start cap): it is about to run, never "in 0s".
  assert.equal(scheduleNextLabel({ state: "active", nextRun: next("2026-10-05T11:59:00Z") }, NOW), "now")
})

test("a schedule that will not run on its own says why instead", () => {
  assert.equal(scheduleNextLabel({ state: "proposed", nextRun: undefined }, NOW), "Proposed")
  assert.equal(scheduleNextLabel({ state: "paused", nextRun: undefined }, NOW), "Paused")
  assert.equal(scheduleNextLabel({ state: "ended", nextRun: undefined }, NOW), "Ended")
  assert.equal(scheduleNextLabel({ state: "active", nextRun: undefined }, NOW), "Ended")
})

test("only a worker's proposal names its proposer", () => {
  assert.equal(proposedByLine("triage-bot"), "Proposed by @triage-bot")
  assert.equal(proposedByLine("human"), null)
})

test("a run's opening header names its schedule back, and anything else names none", () => {
  const header = scheduledRunHeader({
    scheduleId: "sch_0123456789ab",
    title: "Triage issues",
    describe: "every Monday at 9am",
    condition: "skip US public holidays",
    occurrenceAt: Date.parse("2026-10-12T13:00:00Z"),
    tz: "America/New_York",
    previous: { slug: "triage-issues", at: Date.parse("2026-10-05T13:00:00Z") },
  })
  const run = parseScheduledRunPrompt(scheduledRunPrompt(header, "triage new issues"))
  assert.ok(run)
  assert.equal(run.prompt, "triage new issues")
  assert.deepEqual(scheduledRunFacts(run.header), { title: "Triage issues", describe: "every Monday at 9am" })
  assert.equal(scheduledRunFacts("triage new issues"), undefined)
})
