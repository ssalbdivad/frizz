// What the prompt box makes of the model's answer and what each submit does with it (scheduleIntent.ts) — the
// 2026-10-06 design's D5, branch by branch, as pure steps: no trigger or a dismissed reading dispatches; a reading
// of exactly the current words creates or dispatches; no reading yet HOLDS until the answer lands, typing cancels
// the hold, a failure or a timeout stops with a line and the NEXT Enter dispatches; Undo leaves the reading
// dismissed. And the strip: nothing without a schedule word, the reading of earlier words kept while new ones are
// read (stale-while-revalidate), a "no schedule" answer taking it away.
import assert from "node:assert/strict"
import test from "node:test"
import { SCHEDULE_NOT_FOUND_COPY, SCHEDULE_PRESENCE_COPY, SCHEDULE_SPACING_COPY, type InterpretScheduleResult } from "@frizz/shared"
import {
  NO_TASK_COPY,
  SUBMIT_READY,
  classifyResult,
  dismissedPhrase,
  isDismissed,
  knownOf,
  liftsDismissal,
  nextDismissal,
  phraseSpan,
  readTextOf,
  stripLook,
  stripView,
  submitStep,
  type ScheduleKnown,
  type SubmitFacts,
  type SubmitPhase,
} from "./scheduleIntent.ts"
import type { ModelReadOk } from "./scheduleModelRead.ts"

const NY = "America/New_York"
const TEXT = "every Monday at 9am triage new issues"
const PHRASE = "every Monday at 9am"

function ok(text: string, phrase: string, extra: Partial<ModelReadOk> = {}): ModelReadOk {
  const start = text.indexOf(phrase)
  return {
    ok: true, phrase, phraseStart: start, phraseEnd: start + phrase.length,
    prompt: text.slice(start + phrase.length).trim(), whenText: phrase,
    rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0", dtstart: "2026-10-12T09:00", tz: NY,
    title: "Triage issues", preview: { describe: "every Monday at 9am", echo: "Triage issues · every Monday at 9am", nextLine: "", upcoming: [] },
    ...extra,
  }
}
const READING = ok(TEXT, PHRASE)
const SCHEDULE: ScheduleKnown = { kind: "schedule", result: READING }
const NONE: ScheduleKnown = { kind: "none" }
const PENDING: ScheduleKnown = { kind: "pending" }
const FAILED: ScheduleKnown = { kind: "failed" }

const facts = (over: Partial<SubmitFacts> = {}): SubmitFacts => ({ text: TEXT, trigger: true, known: PENDING, dismissed: undefined, ...over })

/** Run events through the machine from `phase`, collecting every run it asks for. */
function drive(phase: SubmitPhase, steps: [event: Parameters<typeof submitStep>[1], facts: SubmitFacts][]) {
  const runs: string[] = []
  for (const [event, f] of steps) {
    const next = submitStep(phase, event, f)
    phase = next.phase
    if (next.then) runs.push(next.then.run)
  }
  return { phase, runs }
}
const enter = { type: "enter" as const, now: 1_000 }
const update = { type: "update" as const }

// ---- the model's answer --------------------------------------------------------------------------------------

test("the model's answer, as the box acts on it", () => {
  assert.deepEqual(classifyResult(READING), { kind: "schedule", result: READING })
  assert.deepEqual(classifyResult({ ok: false, error: SCHEDULE_NOT_FOUND_COPY }), { kind: "none" }, "no schedule in the words: the ordinary answer")
  for (const copy of [SCHEDULE_PRESENCE_COPY, SCHEDULE_SPACING_COPY, "What should each run do? Add the task after the schedule.", "Couldn't turn that into a schedule: BYSECOND is not supported."]) {
    assert.deepEqual(classifyResult({ ok: false, error: copy }), { kind: "refused", copy }, copy)
  }
  assert.deepEqual(classifyResult({ ok: false, error: "Couldn't read that just now: overloaded" }), { kind: "failed" })
  assert.deepEqual(
    classifyResult({ ok: false, error: "Reading a schedule needs Claude, which this server has switched off." }),
    { kind: "none" },
    "an interpreter that is off: the box behaves as it does without schedules",
  )
  assert.deepEqual(classifyResult(READING, () => NO_TASK_COPY), { kind: "refused", copy: NO_TASK_COPY }, "the box's own vetting")
  assert.deepEqual(knownOf({ status: "reading" }), PENDING)
  assert.deepEqual(knownOf({ status: "none" }), PENDING)
  assert.deepEqual(knownOf({ status: "budget" }), PENDING)
  assert.deepEqual(knownOf({ status: "failed", message: "network down" }), FAILED)
})

test("the phrase's offsets index the TRIMMED words the model read; the box maps them onto its own prose", () => {
  const prose = `\n  ${TEXT}`
  const span = phraseSpan(prose, readTextOf(prose), READING)!
  assert.equal(prose.slice(span.start, span.end), PHRASE, "a prompt that opens with a newline marks the right words")
  // A reading of EARLIER words, kept on screen while these are read, is found by its phrase for the mark.
  const later = `Please, ${TEXT} and label them`
  const moved = phraseSpan(later, readTextOf(later), READING)!
  assert.equal(later.slice(moved.start, moved.end), PHRASE)
  assert.equal(phraseSpan("triage new issues", "triage new issues", READING), undefined, "a phrase that is gone marks nothing")
})

test("a dismissal is of a phrase, and lifts once that phrase is gone", () => {
  assert.equal(isDismissed(READING, "Every  monday at 9AM"), true, "give or take case and spacing")
  assert.equal(isDismissed(READING, "every Tuesday at 9am"), false)
  const lifts = (trigger: boolean, known: ScheduleKnown) => liftsDismissal({ trigger, known, dismissed: PHRASE })
  assert.equal(lifts(true, SCHEDULE), false, "the same phrase read again: still dismissed")
  assert.equal(lifts(true, { kind: "schedule", result: ok("every Tuesday at 9am triage", "every Tuesday at 9am") }), true, "another phrase")
  assert.equal(lifts(true, NONE), true, "no schedule in the words any more")
  assert.equal(lifts(false, PENDING), true, "no schedule word left: the box emptied, or the phrase deleted")
  assert.equal(lifts(true, PENDING), false, "a read in flight lifts nothing")
  assert.equal(lifts(true, FAILED), false)
  assert.equal(lifts(true, { kind: "refused", copy: SCHEDULE_SPACING_COPY }), false)
  assert.equal(liftsDismissal({ trigger: false, known: NONE, dismissed: undefined }), false, "nothing to lift")
})

test("\"not a schedule\" said over an UPDATING strip is about the words on screen: it takes their reading's phrase when it lands (finding F)", () => {
  // The strip was showing the reading of EARLIER words ("every Monday") while "… every Monday at 9am" was read.
  // Esc dismissed "every Monday"; the current words' answer read "every Monday at 9am", a different phrase, so the
  // dismissal lifted the moment it landed and the Enter pressed after the Esc created the schedule.
  const earlier = { kind: "schedule" as const, result: ok("triage new issues every Monday", "every Monday") }
  const pending = { phrase: "every Monday", pending: true }
  // Before the current words' reading lands, it covers whatever reading is on screen…
  assert.equal(dismissedPhrase(pending, PENDING, earlier), "every Monday")
  // …and once it lands, that reading — whatever its phrase.
  assert.equal(dismissedPhrase(pending, SCHEDULE, earlier), PHRASE)
  assert.equal(isDismissed(READING, dismissedPhrase(pending, SCHEDULE, earlier)), true)
  // A held Enter landing on that answer starts the thread.
  const held = submitStep(SUBMIT_READY, enter, facts({ dismissed: dismissedPhrase(pending, PENDING, earlier) })).phase
  assert.deepEqual(submitStep(held, update, facts({ known: SCHEDULE, dismissed: dismissedPhrase(pending, SCHEDULE, earlier) })).then, { run: "dispatch" })
  // The draft then keeps the phrase it now holds for, so later edits are judged against it as usual.
  assert.deepEqual(nextDismissal({ trigger: true, known: SCHEDULE, dismissal: pending }), { adopt: PHRASE })
  assert.equal(nextDismissal({ trigger: true, known: PENDING, dismissal: pending }), "keep", "still being read")
  assert.equal(nextDismissal({ trigger: true, known: NONE, dismissal: pending }), "lift", "no schedule in the words after all")
  assert.equal(nextDismissal({ trigger: false, known: PENDING, dismissal: pending }), "lift")
  // A dismissal said over a CURRENT reading is of its phrase, as before.
  const settled = { phrase: PHRASE }
  assert.equal(dismissedPhrase(settled, SCHEDULE, undefined), PHRASE)
  assert.equal(nextDismissal({ trigger: true, known: SCHEDULE, dismissal: settled }), "keep")
  assert.equal(nextDismissal({ trigger: true, known: { kind: "schedule", result: ok("every Tuesday at 9am triage", "every Tuesday at 9am") }, dismissal: settled }), "lift")
  assert.equal(nextDismissal({ trigger: true, known: SCHEDULE, dismissal: undefined }), "keep")
  assert.equal(dismissedPhrase(undefined, SCHEDULE, earlier), undefined)
})

// ---- D5: submit, branch by branch ------------------------------------------------------------------------------

test("D5: no schedule word, or the reading dismissed → dispatch exactly as today", () => {
  assert.deepEqual(drive(SUBMIT_READY, [[enter, facts({ trigger: false, known: PENDING })]]), { phase: SUBMIT_READY, runs: ["dispatch"] })
  assert.deepEqual(drive(SUBMIT_READY, [[enter, facts({ known: SCHEDULE, dismissed: PHRASE })]]), { phase: SUBMIT_READY, runs: ["dispatch"] })
})

test("D5: a reading for the current words in hand → create it if it is a schedule, else dispatch", () => {
  const created = submitStep(SUBMIT_READY, enter, facts({ known: SCHEDULE }))
  assert.deepEqual(created, { phase: SUBMIT_READY, then: { run: "create", result: READING } })
  assert.deepEqual(drive(SUBMIT_READY, [[enter, facts({ known: NONE })]]).runs, ["dispatch"])
})

test("D5: no reading for the current words yet → HOLD and read; the answer landing decides", () => {
  const held = submitStep(SUBMIT_READY, enter, facts())
  assert.deepEqual(held, { phase: { kind: "holding", text: TEXT, since: 1_000 }, then: { run: "read" } })
  // Still nothing known: keep holding, ask nothing more.
  assert.deepEqual(submitStep(held.phase, update, facts()), { phase: held.phase })
  // A schedule lands: create it.
  assert.deepEqual(submitStep(held.phase, update, facts({ known: SCHEDULE })), { phase: SUBMIT_READY, then: { run: "create", result: READING } })
  // No schedule lands: start it now.
  assert.deepEqual(submitStep(held.phase, update, facts({ known: NONE })), { phase: SUBMIT_READY, then: { run: "dispatch" } })
  // The reading lands but was dismissed meanwhile (Esc on a stale strip): start it now.
  assert.deepEqual(submitStep(held.phase, update, facts({ known: SCHEDULE, dismissed: PHRASE })).then, { run: "dispatch" })
})

test("D5: a second Enter during the hold changes nothing; Esc cancels the hold and is claimed", () => {
  const held = submitStep(SUBMIT_READY, enter, facts()).phase
  assert.deepEqual(submitStep(held, { type: "enter", now: 2_000 }, facts()), { phase: held })
  assert.deepEqual(submitStep(held, { type: "escape" }, facts()), { phase: SUBMIT_READY })
  assert.deepEqual(submitStep(SUBMIT_READY, { type: "escape" }, facts()), { phase: SUBMIT_READY }, "with nothing held, Esc is not the machine's")
})

test("D5: typing during the hold cancels it — nothing runs — and Enter again submits the new words", () => {
  const held = submitStep(SUBMIT_READY, enter, facts()).phase
  const typed = `${TEXT} and label them`
  const cancelled = submitStep(held, update, facts({ text: typed }))
  assert.deepEqual(cancelled, { phase: SUBMIT_READY }, "cancelled, with no dispatch and no create")
  // The answer for the OLD words lands after the edit: it is not the new words' answer, and nothing acts on it.
  assert.deepEqual(submitStep(cancelled.phase, update, facts({ text: typed, known: PENDING })), { phase: SUBMIT_READY })
  assert.deepEqual(submitStep(cancelled.phase, { type: "enter", now: 3_000 }, facts({ text: typed })).phase, { kind: "holding", text: typed, since: 3_000 })
})

test("D5: the read failing at submit never dispatches silently: the line, then the NEXT Enter dispatches", () => {
  const held = submitStep(SUBMIT_READY, enter, facts()).phase
  const failed = submitStep(held, update, facts({ known: FAILED }))
  assert.deepEqual(failed, { phase: { kind: "failed", text: TEXT } }, "no run: nothing starts")
  assert.deepEqual(drive(failed.phase, [[enter, facts({ known: FAILED })]]), { phase: SUBMIT_READY, runs: ["dispatch"] })
  // A read still out for those words when the line is up (Try again's, or an automatic one): Enter dispatches too.
  assert.deepEqual(drive(failed.phase, [[enter, facts({ known: PENDING })]]).runs, ["dispatch"])
})

test("D5: the hold timing out (15s) is a failure too: the line, then the next Enter dispatches", () => {
  const held = submitStep(SUBMIT_READY, enter, facts()).phase
  const timedOut = submitStep(held, { type: "timeout" }, facts())
  assert.deepEqual(timedOut, { phase: { kind: "failed", text: TEXT } })
  assert.deepEqual(drive(timedOut.phase, [[enter, facts()]]).runs, ["dispatch"])
  assert.deepEqual(submitStep(SUBMIT_READY, { type: "timeout" }, facts()), { phase: SUBMIT_READY }, "a stray timer does nothing")
})

test("an upload started during the hold cancels it, as typing does: nothing is sent without the file (finding C)", () => {
  // The held Enter used to act on the answer with an image still uploading, and the image was dropped — the very
  // send the Composer's \`!uploading\` gate refuses.
  const held = submitStep(SUBMIT_READY, enter, facts()).phase
  assert.deepEqual(submitStep(held, update, facts({ uploading: true })), { phase: SUBMIT_READY }, "cancelled")
  assert.deepEqual(submitStep(held, update, facts({ known: SCHEDULE, uploading: true })), { phase: SUBMIT_READY }, "and nothing created mid-upload")
  assert.deepEqual(submitStep(SUBMIT_READY, enter, facts({ known: SCHEDULE, uploading: true })), { phase: SUBMIT_READY }, "an Enter mid-upload does nothing")
  assert.deepEqual(drive(SUBMIT_READY, [[enter, facts({ known: SCHEDULE })]]).runs, ["create"], "once it lands, Enter acts")
})

test("a read that failed while TYPING is not the failure line: Enter holds and reads again", () => {
  assert.deepEqual(submitStep(SUBMIT_READY, enter, facts({ known: FAILED })).then, { run: "read" })
})

test("the failure line is about its words while nothing is known for them: an edit, or an answer, takes it away", () => {
  const failed: SubmitPhase = { kind: "failed", text: TEXT }
  assert.deepEqual(submitStep(failed, update, facts({ known: PENDING })), { phase: failed })
  assert.deepEqual(submitStep(failed, update, facts({ text: `${TEXT}!` })), { phase: SUBMIT_READY })
  assert.deepEqual(submitStep(failed, update, facts({ known: SCHEDULE })), { phase: SUBMIT_READY }, "a late answer replaces the line with the strip")
  // Try again: hold and read once more, even with the line up.
  assert.deepEqual(submitStep(failed, { type: "enter", now: 5_000, retry: true }, facts({ known: FAILED })), {
    phase: { kind: "holding", text: TEXT, since: 5_000 },
    then: { run: "read" },
  })
})

test("a refusal (too frequent, at the keyboard, no task) — at Enter its line is on screen, so it dispatches; landing on a held Enter it stops", () => {
  const refused: ScheduleKnown = { kind: "refused", copy: SCHEDULE_SPACING_COPY }
  assert.deepEqual(drive(SUBMIT_READY, [[enter, facts({ known: refused })]]).runs, ["dispatch"])
  const held = submitStep(SUBMIT_READY, enter, facts()).phase
  assert.deepEqual(submitStep(held, update, facts({ known: refused })), { phase: SUBMIT_READY }, "stopped: the human pressed Enter before they could read it")
})

test("Undo → the words come back with their reading DISMISSED: Enter starts them now; Schedule it takes that back", () => {
  // What Undo writes (ScheduleComposer `undo`): the phrase dismissed, as undone. The words' reading is cached.
  const undone = facts({ known: SCHEDULE, dismissed: PHRASE })
  assert.deepEqual(drive(SUBMIT_READY, [[enter, undone]]).runs, ["dispatch"])
  // "Schedule it" clears the dismissal: Enter creates again.
  assert.deepEqual(drive(SUBMIT_READY, [[enter, facts({ known: SCHEDULE })]]).runs, ["create"])
})

// ---- the strip -----------------------------------------------------------------------------------------------

const strip = (over: Partial<Parameters<typeof stripView>[0]> = {}) =>
  stripView({ trigger: true, text: TEXT, known: PENDING, reading: false, stale: undefined, dismissed: undefined, ...over })

test("the strip: nothing without a schedule word, whatever was read before", () => {
  assert.deepEqual(strip({ trigger: false, known: SCHEDULE }), { kind: "none" })
  assert.deepEqual(strip({ trigger: false, stale: { text: TEXT, answer: SCHEDULE } }), { kind: "none" })
})

test("the strip: a read out with nothing on screen is only the pending cue; a schedule reading is the strip", () => {
  assert.deepEqual(strip({ reading: true }), { kind: "pending" })
  assert.deepEqual(strip({ reading: false }), { kind: "none" }, "nothing asked yet (the idle, the budget): nothing at all")
  assert.deepEqual(strip({ known: SCHEDULE }), { kind: "schedule", result: READING, readText: TEXT, fresh: true })
  assert.deepEqual(strip({ known: NONE, reading: false }), { kind: "none" }, "\"fix the bug from this morning\": nothing")
})

test("stale-while-revalidate: the last reading STAYS while newer words are read, and an answer of none takes it away", () => {
  const earlier = "every Monday at 9am triage"
  const stale = { text: earlier, answer: { kind: "schedule" as const, result: ok(earlier, PHRASE) } }
  const kept = strip({ reading: true, stale })
  assert.equal(kept.kind, "schedule")
  assert.ok(kept.kind === "schedule" && !kept.fresh && kept.readText === earlier, "kept, marked not fresh (the updating state)")
  assert.deepEqual(strip({ known: FAILED, stale }).kind, "schedule", "a failed read leaves it up")
  assert.deepEqual(strip({ known: NONE, stale }), { kind: "none" }, "the new answer says no schedule: the strip leaves")
  assert.deepEqual(strip({ known: SCHEDULE, stale }), { kind: "schedule", result: READING, readText: TEXT, fresh: true }, "replaced in place")
  // A stale NON-schedule never shows: a refusal or a none read from earlier words is not said for these.
  assert.deepEqual(strip({ reading: true, stale: { text: earlier, answer: { kind: "refused", copy: NO_TASK_COPY } } }), { kind: "pending" })
})

test("a reading of OTHER words never looks current; ↻ only while it is current or being read again (finding B)", () => {
  const earlier = "every Monday at 9am triage"
  const kept = strip({ reading: true, stale: { text: earlier, answer: { kind: "schedule", result: ok(earlier, PHRASE) } } })
  // The words' own reading: current, and Enter creates it.
  assert.deepEqual(stripLook(strip({ known: SCHEDULE }), false), { updating: false, revalidating: false, scheduleGlyph: true })
  // An earlier reading while these words are read (or due to be): updating, shimmering, ↻ kept — no flicker per word.
  assert.deepEqual(stripLook(kept, true), { updating: true, revalidating: true, scheduleGlyph: true })
  // An earlier reading with NO read coming — the budget spent, the read failed: it was shown as current, with ↻,
  // over an Enter that holds and may well start the thread. Now it is plainly not current, and the send is plain.
  assert.deepEqual(stripLook(kept, false), { updating: true, revalidating: false, scheduleGlyph: false })
  for (const s of [strip(), strip({ reading: true }), strip({ known: { kind: "refused", copy: SCHEDULE_SPACING_COPY } })]) {
    assert.deepEqual(stripLook(s, true), { updating: false, revalidating: false, scheduleGlyph: false }, s.kind)
  }
})

test("the strip: a refusal is said for its own words; dismissed shows nothing, or the Undo line", () => {
  assert.deepEqual(strip({ known: { kind: "refused", copy: SCHEDULE_SPACING_COPY } }), { kind: "refused", copy: SCHEDULE_SPACING_COPY })
  assert.deepEqual(strip({ known: SCHEDULE, dismissed: { phrase: PHRASE, undone: false } }), { kind: "none" })
  assert.deepEqual(strip({ known: SCHEDULE, dismissed: { phrase: PHRASE, undone: true } }), { kind: "undone" })
  // Undo's words merged with a word typed since: the read for them is out, and the line stays meanwhile.
  const stale = { text: TEXT, answer: SCHEDULE as ReturnType<typeof classifyResult> }
  assert.deepEqual(strip({ text: `${TEXT} x`, reading: true, stale, dismissed: { phrase: PHRASE, undone: true } }), { kind: "undone" })
  assert.deepEqual(strip({ known: SCHEDULE, dismissed: { phrase: "every Friday", undone: false } }).kind, "schedule", "another phrase's dismissal")
})

test("a reading, a refusal and no schedule are told apart by the interpreter's own words (no other field exists)", () => {
  const results: [InterpretScheduleResult, string][] = [
    [READING, "schedule"],
    [{ ok: false, error: SCHEDULE_NOT_FOUND_COPY }, "none"],
    [{ ok: false, error: SCHEDULE_PRESENCE_COPY }, "refused"],
    [{ ok: false, error: "Couldn't read that just now: socket hang up" }, "failed"],
  ]
  for (const [result, kind] of results) assert.equal(classifyResult(result).kind, kind)
})
