// The live preview's pure half (plans/schedule-live-reading.md §3.4, §5.6, §11): which parts render dim for
// what the grammar assumed, the guessed-meridiem line, the next line it decorates, and the field's publish
// points. The rendered pixels are checked in a real browser, not here.
import assert from "node:assert/strict"
import test from "node:test"
import { compileSchedule, describeScheduleParts, readSchedulePhrase } from "@frizz/shared"
import { meridiemLine, previewSegments, schedulePreviewModel } from "./SchedulePreview.tsx"
import { holdsQualifier, publishesNow } from "../lib/scheduleWhenField.ts"

const NY = "America/New_York"
const NOW = Date.parse("2026-10-05T14:32:00-04:00")

function read(words: string) {
  const r = readSchedulePhrase(words, { nowMs: NOW, tz: NY, scope: "field" })
  assert.equal(r.kind, "exact", `${words} reads exact`)
  if (r.kind !== "exact") throw new Error("unreachable")
  return r
}

function segments(words: string) {
  const r = read(words)
  const c = compileSchedule({ rrule: r.rrule, dtstart: r.dtstart, tz: NY })
  assert.ok(c.ok)
  if (!c.ok) throw new Error("unreachable")
  return previewSegments(describeScheduleParts(c.value, NOW), r.assumed)
    .map((s) => (s.assumed ? `[${s.text}]` : s.text)).join("")
}

test("dim parts: a time nobody typed, the day of 'weekly', only the pm of 'at 3'", () => {
  assert.equal(segments("every Monday at 9am"), "every Monday at 9am", "nothing assumed, nothing dim")
  assert.equal(segments("every morning"), "every day at [9am]")
  assert.equal(segments("weekly"), "every [Monday] at [9am]")
  assert.equal(segments("every Thursday at 3"), "every Thursday at 3[pm]")
  assert.equal(segments("weekdays at 8:30"), "every weekday at 8:30[am]")
  assert.equal(segments("every Mon at 8 and 5"), "every Monday at 8[am] and 5[pm]")
  assert.equal(segments("the 1st of every month"), "on the 1st of every month at [9am]")
  // A window's pair settles its numbers: nothing is dim.
  assert.equal(segments("every 2 hours on weekdays from 9 to 5"), "every 2 hours from 9am to 5pm on weekdays")
})

test("each dim part says why and how to change it", () => {
  const r = read("every morning")
  const c = compileSchedule({ rrule: r.rrule, dtstart: r.dtstart, tz: NY })
  if (!c.ok) throw new Error("compiles")
  const dim = previewSegments(describeScheduleParts(c.value, NOW), r.assumed).find((s) => s.assumed)
  assert.equal(dim?.tip, "“Morning” reads as 9am. Add a time to change it.")
  assert.equal(meridiemLine(read("every Thursday at 3").assumed), "Read “3” as 3pm. Type “3am” if you meant morning.")
  assert.equal(meridiemLine(read("every weekday at 9").assumed), "Read “9” as 9am. Type “9pm” if you meant evening.")
  assert.equal(meridiemLine(read("every Mon at 8 and 5").assumed), "Read “8” as 8am, “5” as 5pm. Add am or pm to change one.")
  assert.equal(meridiemLine(read("every Monday at 9am").assumed), undefined)
})

test("the model: the echo's parts, its zone suffix, the condition, and the shared next line split", () => {
  const r = read("every Monday at 9am")
  const m = schedulePreviewModel({ title: "Triage issues", rrule: r.rrule, dtstart: r.dtstart, tz: NY, condition: "unless it's a holiday" }, NOW, NY)
  assert.ok(m.ok)
  if (!m.ok) return
  assert.equal(m.zone, "")
  assert.deepEqual(m.tail, ["unless it's a holiday"])
  assert.deepEqual(m.next, ["Mon Oct 12", "Mon Oct 19", "Mon Oct 26"])
  assert.equal(m.firstAt, "2026-10-12T13:00:00.000Z")
  const away = schedulePreviewModel({ title: "Triage issues", rrule: r.rrule, dtstart: r.dtstart, tz: NY }, NOW, "Europe/Berlin")
  assert.ok(away.ok && away.zone === " New York time")
  // A dense rule names its runs a day and puts times on its dates.
  const dense = read("every 15 minutes")
  const d = schedulePreviewModel({ title: "Check deploy", rrule: dense.rrule, dtstart: dense.dtstart, tz: NY }, NOW, NY)
  assert.ok(d.ok)
  if (d.ok) {
    assert.deepEqual(d.tail, ["96 runs a day"])
    assert.equal(d.next[0], "Mon Oct 5, 2:45pm")
  }
})

test("a rule checkSchedule refuses previews as its own words, with nothing to save", () => {
  const m = schedulePreviewModel({ title: "Triage", rrule: "FREQ=DAILY;UNTIL=20261001;BYHOUR=9;BYMINUTE=0", dtstart: "2026-09-01T09:00", tz: NY }, NOW, NY)
  assert.equal(m.ok, false)
  assert.match(!m.ok ? m.error : "", /never runs again/)
})

test("the field publishes at a word's end or a wholesale change, never mid-word", () => {
  assert.equal(publishesNow("insertText", "every Monday ", 13), true)
  assert.equal(publishesNow("insertText", "every Monday,", 13), true)
  assert.equal(publishesNow("insertText", "every Mon", 9), false)
  assert.equal(publishesNow("insertText", "every Monday at 9", 17), false)
  // The caret, not the end of the text, decides: typing inside a word earlier in the field is mid-word.
  assert.equal(publishesNow("insertText", "every Monday at 9am", 8), false)
  assert.equal(publishesNow("insertFromPaste", "every Monday at 9am", 19), true)
  assert.equal(publishesNow("historyUndo", "every Mon", 9), true)
  assert.equal(publishesNow("deleteContentBackward", "every Monday at 9a", 18), false)
  assert.equal(publishesNow("deleteContentBackward", "every Monday at ", 16), true)
  assert.equal(publishesNow("deleteContentBackward", "", 0), true)
})

test("a qualifier still being typed holds the reading it qualifies; a finished one or another rule does not", () => {
  const at = (words: string) => readSchedulePhrase(words, { nowMs: NOW, tz: NY, scope: "field" })
  const thursday = at("every Thursday")
  assert.equal(holdsQualifier(thursday, "every Thursday at", at("every Thursday at")), true, "the time is not typed yet")
  const monday = at("every Monday")
  assert.equal(holdsQualifier(monday, "every Monday unless", at("every Monday unless")), true)
  // The cue's core is not what is on screen: a different rule is news.
  assert.equal(holdsQualifier(monday, "every Thursday at", at("every Thursday at")), false)
  // Finished: an exact reading is never held.
  assert.equal(holdsQualifier(thursday, "every Thursday at 3pm", at("every Thursday at 3pm")), false)
  // Nothing on screen to hold.
  assert.equal(holdsQualifier(undefined, "every Thursday at", at("every Thursday at")), false)
})
