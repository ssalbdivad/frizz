// plans/schedule-live-reading.md §10.1: the server re-derives a local reading from its PHRASE ALONE. The browser
// reads the whole prompt ("every Monday at 9am triage new issues", scope `edges` or `anywhere`) or the whole
// Change when field (scope `field`), and sends only `whenText` = the phrase, the rrule and the dtstart; the
// server reads `whenText` again under `field`, where the whole string must be the phrase, and writes nothing
// unless the rule reads back identically (packages/server/src/schedules.ts `rederiveLocalReading`).
//
// That is only safe if no window, edge, chip or neighbouring word ever changes what a phrase reads as — the
// spec's claim "the grammar consumes exactly its span". If it did not hold, a correct reading the human
// accepted would be refused as `schedule-reading-moved` on every Enter. This file pins the claim over every
// exact reading the corpus produces, at both corpus clocks and in both 2026 DST weeks.

import assert from "node:assert/strict"
import test from "node:test"
import { CASES, FIELD_CASES, NY, PROBE_CORPUS, PROBE_NOW, SPEC_NOW } from "./schedule-phrase.corpus.ts"
import { isScheduleOffer, readSchedulePhrase, type Span } from "./schedule-phrase.ts"
import { SCHEDULE_GRAMMAR_STALE, SCHEDULE_READING_MOVED, scheduleRefusalOf } from "./schedules.ts"

const CLOCKS = [
  SPEC_NOW,
  PROBE_NOW,
  Date.parse("2026-03-07T23:30:00-05:00"), // the night before spring-forward
  Date.parse("2026-10-31T23:30:00-04:00"), // the night before fall-back
  Date.parse("2026-12-31T22:00:00-05:00"), // a year boundary
]

function rereadsFromPhrase(text: string, scope: "edges" | "anywhere" | "field", nowMs: number, exclude?: Span[]): { checked: boolean; problem?: string } {
  const r = readSchedulePhrase(text, { nowMs, tz: NY, scope, ...(exclude ? { exclude } : {}) })
  if (r.kind !== "exact") return { checked: false }
  // The prompt box sends only what it OFFERS (or what the mode reads); a vetoed close edge never leaves it.
  if (scope === "edges" && !isScheduleOffer(r)) return { checked: false }
  const again = readSchedulePhrase(r.phrase.trim(), { nowMs, tz: NY, scope: "field" })
  if (again.kind === "exact" && again.rrule === r.rrule && again.dtstart === r.dtstart) return { checked: true }
  const got = again.kind === "exact" ? `${again.rrule} @${again.dtstart}` : again.kind
  return { checked: true, problem: `${scope} ${JSON.stringify(text)} → «${r.phrase}» ${r.rrule} @${r.dtstart}; alone it reads ${got}` }
}

test("every exact reading the box can send re-derives from its phrase alone, at every clock", () => {
  const problems: string[] = []
  let checked = 0
  const texts = [...CASES.map((c) => ({ text: c.text, exclude: c.exclude })), ...PROBE_CORPUS.map((p) => ({ text: p.text, exclude: undefined }))]
  for (const nowMs of CLOCKS) {
    for (const { text, exclude } of texts) {
      for (const scope of ["edges", "anywhere"] as const) {
        const out = rereadsFromPhrase(text, scope, nowMs, exclude)
        if (out.checked) checked++
        if (out.problem) problems.push(out.problem)
      }
    }
  }
  assert.deepEqual(problems, [])
  // A floor, so a corpus or grammar change that silently stops producing exact readings fails here rather
  // than passing over nothing. Measured 2026-10-05: 2,553 readings over the five clocks.
  assert.ok(checked > 2000, `only ${checked} readings were checked`)
})

test("a Change when field's reading re-derives from the words it sends", () => {
  for (const nowMs of CLOCKS) {
    for (const { text } of FIELD_CASES) {
      const out = rereadsFromPhrase(text, "field", nowMs)
      assert.equal(out.problem, undefined, out.problem)
    }
  }
})

test("the negative control: a phrase cut short of its span does not re-derive", () => {
  // If the re-read ignored what it was given, every check above would pass vacuously.
  const r = readSchedulePhrase("every Monday at 9am for 3 weeks triage", { nowMs: SPEC_NOW, tz: NY, scope: "edges" })
  assert.equal(r.kind, "exact")
  if (r.kind !== "exact") return
  const short = readSchedulePhrase("every Monday at 9am", { nowMs: SPEC_NOW, tz: NY, scope: "field" })
  assert.equal(short.kind, "exact")
  assert.notEqual(short.kind === "exact" && short.rrule, r.rrule, "COUNT=3 is part of the span, so the cut phrase reads another rule")
})

test("scheduleRefusalOf reads the code off a thrown error, and nothing else", () => {
  assert.equal(scheduleRefusalOf(new Error(`${SCHEDULE_READING_MOVED}: "every day at 2:40pm" reads as …`)), SCHEDULE_READING_MOVED)
  assert.equal(scheduleRefusalOf(new Error(`${SCHEDULE_GRAMMAR_STALE}: this page reads …`)), SCHEDULE_GRAMMAR_STALE)
  assert.equal(scheduleRefusalOf(SCHEDULE_GRAMMAR_STALE), SCHEDULE_GRAMMAR_STALE)
  assert.equal(scheduleRefusalOf(new Error("Runs would be less than 15 minutes apart.")), undefined)
  assert.equal(scheduleRefusalOf(new Error(`Could not save: ${SCHEDULE_READING_MOVED}`)), undefined, "only as the first word")
  assert.equal(scheduleRefusalOf(new Error(`${SCHEDULE_READING_MOVED}-ish`)), undefined)
  assert.equal(scheduleRefusalOf(undefined), undefined)
})
