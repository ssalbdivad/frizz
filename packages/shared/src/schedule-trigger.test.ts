import assert from "node:assert/strict"
import test from "node:test"
import { SCHEDULE_TRIGGER_WORDS, hasScheduleTrigger, scheduleTriggerSpans } from "./schedule-trigger.ts"

test("every listed word fires, in any case, alone and inside a sentence", () => {
  for (const word of SCHEDULE_TRIGGER_WORDS) {
    assert.equal(hasScheduleTrigger(word), true, word)
    assert.equal(hasScheduleTrigger(word.toUpperCase()), true, word.toUpperCase())
    assert.equal(hasScheduleTrigger(`triage issues ${word[0]!.toUpperCase()}${word.slice(1)}, please`), true, word)
  }
})

test("the list is the decided one: lowercase, no duplicates, the weekday names with their plurals", () => {
  assert.equal(new Set(SCHEDULE_TRIGGER_WORDS).size, SCHEDULE_TRIGGER_WORDS.length)
  for (const word of SCHEDULE_TRIGGER_WORDS) assert.equal(word, word.toLowerCase())
  for (const day of ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]) {
    assert.ok((SCHEDULE_TRIGGER_WORDS as readonly string[]).includes(day), day)
    assert.ok((SCHEDULE_TRIGGER_WORDS as readonly string[]).includes(`${day}s`), `${day}s`)
  }
})

test("whole words only: a trigger inside a longer word does not fire", () => {
  for (const text of ["fix everything", "tell everyone", "everyday carry", "teach the parser", "midnights-ish? no: midnightly", "knightly order", "weeklyish", "Mondayitis", "each_file", "nightlybuild"]) {
    assert.equal(hasScheduleTrigger(text), false, text)
  }
})

test("punctuation, hyphens and apostrophes end a word", () => {
  for (const text of ["bi-weekly sync", "Monday's deploy", "(nightly)", "at noon.", "every\nMonday", "—weekends—", "évening? no, evening!"]) {
    assert.equal(hasScheduleTrigger(text), true, text)
  }
})

test("the runs the caller excludes are not read", () => {
  const text = "ping @every-monday about /daily please"
  // The box passes mentions and commands as exclude runs.
  const mention = { start: text.indexOf("@"), end: text.indexOf("@") + "@every-monday".length }
  const command = { start: text.indexOf("/"), end: text.indexOf("/") + "/daily".length }
  assert.equal(hasScheduleTrigger(text), true)
  assert.equal(hasScheduleTrigger(text, [mention, command]), false)
  assert.equal(hasScheduleTrigger(text, [mention]), true)
  // A word half inside an excluded run is unread.
  assert.equal(hasScheduleTrigger("every day", [{ start: 2, end: 3 }]), false)
})

test("code, quotes and a leading command are never read, whatever the caller passes", () => {
  for (const text of [
    "rename `everyMonday` to `every_monday` — wait, `every monday`",
    "```\ncron: every monday\n```\nfix the parser",
    "fix the \"nightly\" label",
    "fix the “weekly” label",
    "fix the ‘daily’ label",
    "fix the „Montag“ und «weekly» labels",
    "/daily run it",
  ]) {
    assert.equal(hasScheduleTrigger(text), false, text)
  }
  // The same words outside the quote fire.
  assert.equal(hasScheduleTrigger("fix the \"nightly\" label every Monday"), true)
})

test("an unclosed quote or backtick is a quotation still being typed: nothing after it is read", () => {
  assert.equal(hasScheduleTrigger("call it \"every Monday"), false)
  assert.equal(hasScheduleTrigger("call it `every"), false)
  // Text before it still is.
  assert.equal(hasScheduleTrigger("every Monday call it \"x"), true)
  // An apostrophe is not a quote.
  assert.equal(hasScheduleTrigger("it's due every Friday"), true)
})

test("spans name each trigger word where it sits, lowercased", () => {
  const text = "Every Monday at 9am and Friday evenings, triage `daily` issues"
  const spans = scheduleTriggerSpans(text)
  assert.deepEqual(spans.map((s) => s.word), ["every", "monday", "friday", "evenings"])
  for (const s of spans) assert.equal(text.slice(s.start, s.end).toLowerCase(), s.word)
})

test("the plural is matched whole, never as its singular plus a letter", () => {
  const [span] = scheduleTriggerSpans("on Mondays")
  assert.deepEqual(span, { start: 3, end: 10, word: "mondays" })
})

test("text with no trigger, and empty text, do not fire", () => {
  for (const text of ["", "   ", "fix the flaky login test", "at 9am tomorrow triage new issues", "in 2 hours remind me"]) {
    assert.equal(hasScheduleTrigger(text), false, text)
  }
})

test("a count per unit of time and a range of abbreviated weekdays fire with no listed word", () => {
  // The benchmark's misses before the phrases existed.
  for (const text of [
    "once a week check that the backups restored",
    "Mon-Fri at 8am post the standup reminder",
    "twice a day, at 10 and 4, check the queue",
    "3 times a month audit the billing exports",
    "2x per week rotate the staging keys",
    "once an hour poll the status page",
    "Mon–Thu at 7:30 summarize overnight alerts",
    "tue thru sat at noon check the canary",
    "Mon. - Fri. 9am triage",
  ]) {
    assert.equal(hasScheduleTrigger(text), true, text)
  }
  const [span] = scheduleTriggerSpans("deploy once a week")
  assert.deepEqual(span, { start: 7, end: 18, word: "once a week" })
  // Not a count per unit, not a range, or not whole.
  for (const text of ["do it once and for all", "a week ago it broke", "use the 2x build", "the monitor-fridge sensor", "monday-ish"]) {
    assert.equal(hasScheduleTrigger(text), text === "monday-ish", text)
  }
  // Quoted, it is named rather than asked for.
  assert.equal(hasScheduleTrigger('the docs say "once a week"'), false)
})

test("repeated calls do not leak regex state", () => {
  for (let i = 0; i < 5; i++) assert.equal(hasScheduleTrigger("every Monday"), true)
  for (let i = 0; i < 5; i++) assert.equal(hasScheduleTrigger("nothing here"), false)
})
