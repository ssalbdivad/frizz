import { test } from "node:test"
import assert from "node:assert/strict"
import {
  childDeadlineMs,
  deadlineStageAtMs,
  deadlineStageDue,
  formatDeadlineLeft,
  parseDeadlineInput,
  TIME_LIMIT_LINE,
} from "./deadline.ts"
import { stripWakeTimeHeader, wakeTimeHeader } from "./index.ts"

const M = 60_000
const H = 60 * M

test("stages fall at 50%, 80%, the final lead, and the deadline", () => {
  const set = 1_000_000
  // 2h budget: half 1h, converge 1h 36m, final at 95% = 1h 54m (earlier than five minutes before), over 2h.
  assert.equal(deadlineStageAtMs(set, set + 2 * H, "half"), set + H)
  assert.equal(deadlineStageAtMs(set, set + 2 * H, "converge"), set + 96 * M)
  assert.equal(deadlineStageAtMs(set, set + 2 * H, "final"), set + 114 * M)
  // 1h: five minutes before (55m) is earlier than 95% (57m).
  assert.equal(deadlineStageAtMs(set, set + H, "final"), set + 55 * M)
  assert.equal(deadlineStageAtMs(set, set + 2 * H, "over"), set + 2 * H)
  // 10h: 95% is earlier than five minutes before, so 95% it is.
  assert.equal(deadlineStageAtMs(set, set + 10 * H, "final"), set + 9.5 * H)
  // 4m: "5m before" would precede the budget itself, so final holds at 87.5% — after converge, never with it.
  const final4 = deadlineStageAtMs(set, set + 4 * M, "final")
  assert.equal(final4, set + 3.5 * M)
  assert.ok(final4 > deadlineStageAtMs(set, set + 4 * M, "converge"))
})

test("only the LATEST due stage is reported", () => {
  const set = 0
  const end = 4 * M
  assert.equal(deadlineStageDue(set, end, 1 * M), undefined)
  assert.equal(deadlineStageDue(set, end, 2 * M), "half")
  assert.equal(deadlineStageDue(set, end, 3.3 * M), "converge")
  assert.equal(deadlineStageDue(set, end, 3.6 * M), "final")
  assert.equal(deadlineStageDue(set, end, 5 * M), "over")
})

test("the reading: left, rounded up to the minute; over by, past it", () => {
  assert.equal(formatDeadlineLeft(42 * M, 0), "42m left")
  assert.equal(formatDeadlineLeft(59 * M + 10_000, 0), "1h left")
  assert.equal(formatDeadlineLeft(72 * M, 0), "1h 12m left")
  assert.equal(formatDeadlineLeft(40_000, 0), "40s left")
  assert.equal(formatDeadlineLeft(0, 8 * M), "over by 8m")
})

test("what the human types: durations, compounds and wall clocks", () => {
  const now = new Date(2026, 9, 6, 13, 0, 0).getTime() // 13:00 local
  const at = (raw: string) => {
    const r = parseDeadlineInput(raw, now)
    assert.ok(r.ok, `${raw}: ${!r.ok ? r.error : ""}`)
    return r.atMs
  }
  assert.equal(at("30m"), now + 30 * M)
  assert.equal(at("2h"), now + 2 * H)
  assert.equal(at("1h30m"), now + 90 * M)
  assert.equal(at("1h 30m"), now + 90 * M)
  assert.equal(at("15:30"), new Date(2026, 9, 6, 15, 30).getTime())
  // An unmarked 12-hour reading is whichever comes next — "go until 3:30" at 13:00 is 15:30.
  assert.equal(at("3:30"), new Date(2026, 9, 6, 15, 30).getTime())
  assert.equal(at("3:30am"), new Date(2026, 9, 7, 3, 30).getTime())
  assert.equal(at("3pm"), new Date(2026, 9, 6, 15, 0).getTime())
  // A time already past today is tomorrow's.
  assert.equal(at("09:00"), new Date(2026, 9, 7, 9, 0).getTime())
  // …while an unmarked "9:00" is the next of the two, tonight's.
  assert.equal(at("9:00"), new Date(2026, 9, 6, 21, 0).getTime())
  for (const bad of ["", "30", "soon", "25:00", "13pm", "30s", "8d"]) {
    assert.equal(parseDeadlineInput(bad, now).ok, false, bad)
  }
})

test("a child's share: the parent's remaining time minus a reserve, and never past it", () => {
  const now = 0
  // 2h left: reserve max(24m, 5m) = 24m → 1h 36m.
  assert.equal(childDeadlineMs({ nowMs: now, parentDeadlineMs: 2 * H }), 96 * M)
  // A declared 20m fits under that ceiling.
  assert.equal(childDeadlineMs({ nowMs: now, parentDeadlineMs: 2 * H, declaredMs: 20 * M }), 20 * M)
  // A declared 3h is clamped to it.
  assert.equal(childDeadlineMs({ nowMs: now, parentDeadlineMs: 2 * H, declaredMs: 3 * H }), 96 * M)
  // 4m left: the 5m reserve is capped at half, so the child still gets 2m.
  assert.equal(childDeadlineMs({ nowMs: now, parentDeadlineMs: 4 * M }), 2 * M)
  // No parent deadline: a declared limit alone, else none.
  assert.equal(childDeadlineMs({ nowMs: now, declaredMs: 2 * M }), 2 * M)
  assert.equal(childDeadlineMs({ nowMs: now }), undefined)
  // A parent already over still gives the child the floor.
  assert.equal(childDeadlineMs({ nowMs: now, parentDeadlineMs: -5 * M }), M)
})

test("the Time limit line is read on a line of its own, indented or not", () => {
  assert.equal(TIME_LIMIT_LINE.exec("Do the thing.\nTime limit: 20m\nThanks")?.[1], "20m")
  assert.equal(TIME_LIMIT_LINE.exec("  time limit: 1h 30m  ")?.[1], "1h 30m")
  assert.equal(TIME_LIMIT_LINE.exec("There is no time limit: relax"), null)
})

test("the wake clock carries the time left, and the display stripper still takes it off", () => {
  const now = new Date(2026, 9, 6, 13, 0).getTime()
  const left = wakeTimeHeader(now, new Date(now - 3 * M).toISOString(), now + 42 * M)
  assert.match(left, /— you last spoke 3m ago · 42m left\.$/)
  const over = wakeTimeHeader(now, null, now - 8 * M)
  assert.match(over, / · over by 8m\.$/)
  for (const clock of [left, over, wakeTimeHeader(now, null)]) {
    assert.equal(stripWakeTimeHeader(`Body text\n\n${clock}`), "Body text")
  }
})
