// The model reads of a schedule (scheduleModelRead.ts): one read out at a time with only the LATEST text queued
// behind it, a 10m cache keyed by the text, its zone and its local date, 40 automatic reads per draft (a submit
// still reads after that), a give-up timer, one reader per draft, and what stays on screen while the words are
// read again (stale-while-revalidate).
import assert from "node:assert/strict"
import test from "node:test"
import { SCHEDULE_NOT_FOUND_COPY, type InterpretScheduleResult } from "@frizz/shared"
import {
  MODEL_CACHE_MAX,
  MODEL_CACHE_TTL_MS,
  MODEL_READ_BUDGET,
  READ_TIMEOUT_MS,
  TYPED_HISTORY_MAX,
  cachedModelRead,
  clearModelReadCache,
  clearSharedModelReaders,
  createModelReader,
  isFailedRead,
  isModelVerdict,
  modelReadKey,
  newestAnswer,
  sharedModelReader,
  typedHistory,
  type ModelReadOk,
  type ModelReadView,
} from "./scheduleModelRead.ts"

const NY = "America/New_York"
// Mon Oct 5 2026, 2:32pm in New York.
const NOW = Date.parse("2026-10-05T14:32:00-04:00")
const NONE: InterpretScheduleResult = { ok: false, error: SCHEDULE_NOT_FOUND_COPY }

/** An interpreter the test answers by hand, recording every text it was asked to read. */
function heldInterpreter() {
  const asked: string[] = []
  const pending: { text: string; resolve: (r: InterpretScheduleResult) => void; reject: (e: Error) => void }[] = []
  const interpret = (text: string) => {
    asked.push(text)
    return new Promise<InterpretScheduleResult>((resolve, reject) => pending.push({ text, resolve, reject }))
  }
  return { interpret, asked, pending }
}

function ok(text: string, phrase: string, extra: Partial<ModelReadOk> = {}): ModelReadOk {
  const start = text.indexOf(phrase)
  return {
    ok: true, phrase, phraseStart: start, phraseEnd: start + phrase.length,
    prompt: text.slice(start + phrase.length).trim(), whenText: phrase,
    rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0", dtstart: "2026-10-12T09:00", tz: NY,
    title: "Post digest", preview: { describe: "every Monday at 9am", echo: "Post digest · every Monday at 9am", nextLine: "", upcoming: [] },
    ...extra,
  }
}

const settle = () => new Promise((r) => setImmediate(r))

/** A reader over a held interpreter, on a hand-set clock and (optionally) hand-run timers. */
function reader(opts: { budget?: number; manualTimers?: boolean } = {}) {
  clearModelReadCache()
  const held = heldInterpreter()
  let clock = NOW
  const timers: { run: () => void; ms: number; id: number }[] = []
  let ids = 0
  const r = createModelReader({
    interpret: held.interpret,
    keyOf: (text, nowMs) => modelReadKey({ tz: NY, nowMs, text }),
    now: () => clock,
    ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
    ...(opts.manualTimers ? {
      timers: {
        set: (run: () => void, ms: number) => { const id = ++ids; timers.push({ run, ms, id }); return id },
        clear: (handle: unknown) => { const at = timers.findIndex((t) => t.id === handle); if (at >= 0) timers.splice(at, 1) },
      },
    } : {}),
  })
  let notified = 0
  r.subscribe(() => { notified++ })
  return { r, held, at: (ms: number) => { clock = ms }, notified: () => notified, fireTimers: () => { for (const t of timers.splice(0)) t.run() } }
}

test("single flight: a text that changes during a read costs exactly one follow-up, for the LATEST text", async () => {
  const { r, held } = reader()
  r.request("every Monday")
  r.request("every Monday at")
  r.request("every Monday at 9am")
  assert.deepEqual(held.asked, ["every Monday"], "one request out at a time")
  assert.equal(r.view("every Monday at 9am").status, "reading", "the queued text reads as in progress")
  assert.equal(r.view("every Monday at").status, "none", "an intermediate text is never sent")
  held.pending[0]!.resolve(NONE)
  await settle()
  assert.deepEqual(held.asked, ["every Monday", "every Monday at 9am"], "exactly one follow-up")
  assert.equal(r.view("every Monday").status, "answered", "the stale answer was still cached")
  held.pending[1]!.resolve(ok("every Monday at 9am", "every Monday at 9am"))
  await settle()
  assert.equal(held.asked.length, 2)
  assert.equal(r.view("every Monday at 9am").status, "answered")
})

test("single flight: asking again for the text that is out sends nothing, and drops an older queued text", async () => {
  const { r, held } = reader()
  r.request("a every")
  r.request("b every")
  r.request("a every")
  held.pending[0]!.resolve(NONE)
  await settle()
  assert.deepEqual(held.asked, ["a every"], "b was moot once the human edited back to a")
  r.request("c every")
  r.request("d every")
  r.cancelQueued()
  held.pending[1]!.resolve(NONE)
  await settle()
  assert.deepEqual(held.asked, ["a every", "c every"], "the queued text was cancelled (its schedule word went)")
})

test("the cache: a hit costs no call, for 10m, then reads again; across readers on the same key", async () => {
  const { r, held, at } = reader()
  const text = "twice a week check deps"
  r.request(text)
  held.pending[0]!.resolve(ok(text, "twice a week"))
  await settle()
  // A second reader (another box, a remount) on the same key and day: no call.
  const other = createModelReader({ interpret: held.interpret, keyOf: (t, n) => modelReadKey({ tz: NY, nowMs: n, text: t }), now: () => NOW + 60_000 })
  other.request(text)
  assert.equal(other.view(text).status, "answered")
  assert.equal(held.asked.length, 1)
  at(NOW + MODEL_CACHE_TTL_MS - 1)
  r.request(text)
  assert.equal(held.asked.length, 1, "inside the TTL")
  at(NOW + MODEL_CACHE_TTL_MS + 1)
  assert.equal(r.view(text).status, "none", "past the TTL the answer is gone")
  r.request(text)
  assert.equal(held.asked.length, 2, "and it reads again")
})

test("the cache key is the text with its zone and its local date, and the context", () => {
  const key = (nowMs: number, tz = NY, context?: string) => modelReadKey({ tz, nowMs, text: "tomorrow at 8", ...(context ? { context } : {}) })
  // 11:58pm and 12:02am in New York are different days, so "tomorrow at 8" is not reused across midnight.
  const before = Date.parse("2026-10-05T23:58:00-04:00")
  const after = Date.parse("2026-10-06T00:02:00-04:00")
  assert.notEqual(key(before), key(after))
  // The same two instants are one day in UTC (03:58 and 04:02 on Oct 6).
  assert.equal(key(before, "UTC"), key(after, "UTC"))
  assert.notEqual(key(before), key(before, "UTC"), "another zone is another answer")
  assert.notEqual(key(NOW, NY, "schedule:sch_000000000001"), key(NOW), "a Change when's answers are not the box's")
})

test("the cache holds at most 50 answers, oldest first out", async () => {
  const { r, held } = reader()
  for (let i = 0; i <= MODEL_CACHE_MAX; i++) {
    r.request(`text ${i}`, { explicit: true })
    held.pending[i]!.resolve(NONE)
    await settle()
  }
  assert.equal(cachedModelRead(modelReadKey({ tz: NY, nowMs: NOW, text: "text 0" }), NOW), undefined, "the oldest went")
  assert.ok(cachedModelRead(modelReadKey({ tz: NY, nowMs: NOW, text: `text ${MODEL_CACHE_MAX}` }), NOW))
  assert.ok(cachedModelRead(modelReadKey({ tz: NY, nowMs: NOW, text: "text 1" }), NOW))
})

test("only verdicts are cached: a failed call is kept for its text, never cached, and a submit asks again", async () => {
  const { r, held } = reader()
  const text = "every weekday at 9 PT"
  r.request(text)
  held.pending[0]!.resolve({ ok: false, error: "Couldn't read that just now: Claude did not answer within 60s" })
  await settle()
  const v = r.view(text)
  assert.ok(v.status === "answered" && isFailedRead(v.result), "the failure is what this text reads as, this session")
  assert.equal(cachedModelRead(modelReadKey({ tz: NY, nowMs: NOW, text }), NOW), undefined, "and is not cached")
  r.request(text)
  assert.equal(held.asked.length, 1, "an automatic request does not retry a failure on its own")
  r.request(text, { explicit: true })
  assert.equal(held.asked.length, 2, "a submit does")
  held.pending[1]!.reject(new Error("network down"))
  await settle()
  assert.deepEqual(r.view(text), { status: "failed", message: "network down" })
  assert.equal(isModelVerdict(NONE), true)
  assert.equal(isModelVerdict({ ok: false, error: "Reading a schedule needs Claude, which this server has switched off." }), false)
})

test("the budget: 40 automatic reads per draft, then only a submit reads; a new draft refills it", async () => {
  assert.equal(MODEL_READ_BUDGET, 40)
  const { r, held } = reader()
  for (let i = 0; i < MODEL_READ_BUDGET; i++) {
    r.request(`edit ${i}`)
    held.pending[i]!.resolve(NONE)
    await settle()
  }
  assert.equal(r.spent(), MODEL_READ_BUDGET)
  r.request("edit 40")
  assert.equal(held.asked.length, MODEL_READ_BUDGET, "the 41st automatic read is not sent")
  assert.equal(r.view("edit 40").status, "budget")
  r.request("edit 40", { explicit: true })
  assert.equal(held.asked.length, MODEL_READ_BUDGET + 1, "a submit reads past the budget")
  assert.equal(r.spent(), MODEL_READ_BUDGET, "and is not counted")
  held.pending[MODEL_READ_BUDGET]!.resolve(NONE)
  await settle()
  r.reset()
  r.request("edit 41")
  assert.equal(held.asked.length, MODEL_READ_BUDGET + 2, "an emptied box is a new draft, with a new budget")
})

test("the budget also binds a queued follow-up; a cache hit costs none of it", async () => {
  const { r, held } = reader({ budget: 1 })
  r.request("one every")
  r.request("two every")
  held.pending[0]!.resolve(NONE)
  await settle()
  assert.deepEqual(held.asked, ["one every"])
  assert.equal(r.view("two every").status, "budget")
  r.request("one every")
  assert.equal(r.view("one every").status, "answered", "a cached answer is free past the budget")
})

test("a read that hangs is given up after 15s: its text reads as failed, the queued text goes out, and a late verdict is still cached", async () => {
  const { r, held, fireTimers } = reader({ manualTimers: true })
  assert.equal(READ_TIMEOUT_MS, 15_000)
  r.request("every Monday hang")
  r.request("every Monday next")
  fireTimers()
  assert.deepEqual(r.view("every Monday hang"), { status: "failed", message: "timed out" })
  assert.deepEqual(held.asked, ["every Monday hang", "every Monday next"], "the queued text went out at once")
  held.pending[0]!.resolve(NONE)
  await settle()
  assert.equal(r.view("every Monday hang").status, "answered", "the late verdict was cached for the next ask")
})

test("one reader per draft: two boxes on one draft send one read for one text", async () => {
  clearModelReadCache()
  clearSharedModelReaders()
  const held = heldInterpreter()
  const deps = { interpret: held.interpret, keyOf: (text: string, nowMs: number) => modelReadKey({ tz: NY, nowMs, text }), now: () => NOW }
  const dialog = sharedModelReader("draft:/a", deps)
  const page = sharedModelReader("draft:/a", deps)
  assert.equal(dialog, page, "the `c` dialog and the page box under it read through one reader")
  const text = "every Monday at 9am post the digest"
  dialog.request(text, { explicit: true })
  page.request(text)
  assert.deepEqual(held.asked, [text], "the second box finds the text already out")
  held.pending[0]!.resolve(ok(text, "every Monday at 9am"))
  await settle()
  assert.equal(page.view(text).status, "answered", "and the answer lands in both")
  assert.notEqual(sharedModelReader("draft:/b", deps), dialog, "another draft has its own")
  clearSharedModelReaders()
})

// ---- what stays on screen while the words are read again ----------------------------------------------------

/** A `view` over a fixed table of answers. */
const views = (answers: Record<string, InterpretScheduleResult | "reading" | "failed">) => (text: string): ModelReadView => {
  const a = answers[text]
  if (a === undefined) return { status: "none" }
  if (a === "reading") return { status: "reading" }
  if (a === "failed") return { status: "failed", message: "network down" }
  return { status: "answered", result: a }
}

test("stale-while-revalidate: the text's own answer, else the answer for the newest text typed before it", () => {
  const t1 = "every Monday at 9am triage"
  const t2 = "every Monday at 9am triage new"
  const t3 = "every Monday at 9am triage new issues"
  const s1 = ok(t1, "every Monday at 9am")
  const s2 = ok(t2, "every Monday at 9am")
  let history = typedHistory([], t1)
  history = typedHistory(history, t2)
  history = typedHistory(history, t3)
  assert.deepEqual(history, [t1, t2, t3])
  // Nothing for t3 yet: t2's answer stays on screen.
  assert.deepEqual(newestAnswer(history, t3, views({ [t1]: s1, [t2]: s2, [t3]: "reading" })), { text: t2, result: s2 })
  // t3's own answer replaces it the moment it lands.
  const s3 = ok(t3, "every Monday at 9am")
  assert.deepEqual(newestAnswer(history, t3, views({ [t1]: s1, [t2]: s2, [t3]: s3 })), { text: t3, result: s3 })
  // An answer of no schedule for t3 is an answer: it is what shows (and the strip leaves).
  assert.deepEqual(newestAnswer(history, t3, views({ [t2]: s2, [t3]: NONE })), { text: t3, result: NONE })
})

test("stale-while-revalidate goes by TYPING order: an older text's late answer never replaces a newer one's", () => {
  const t1 = "every day at 9am post"
  const t2 = "every weekday at 9am post"
  const t3 = "every weekday at 9am post the digest"
  const old = ok(t1, "every day at 9am", { rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0" })
  const newer = ok(t2, "every weekday at 9am", { rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0" })
  const history = [t1, t2, t3]
  // t1's answer landed LAST (it was queued), but t2 was typed after it: t2's reading is the one on screen.
  assert.deepEqual(newestAnswer(history, t3, views({ [t1]: old, [t2]: newer, [t3]: "reading" })), { text: t2, result: newer })
  // With no answer for t2 at all, t1's is the newest there is.
  assert.deepEqual(newestAnswer(history, t3, views({ [t1]: old, [t2]: "reading", [t3]: "reading" })), { text: t1, result: old })
})

test("stale-while-revalidate: a failed read is no answer, editing back moves a text to the newest end, and empty starts over", () => {
  const t1 = "every Monday post"
  const t2 = "every Monday post x"
  const s1 = ok(t1, "every Monday")
  const failed: InterpretScheduleResult = { ok: false, error: "Couldn't read that just now: overloaded" }
  assert.deepEqual(newestAnswer([t1, t2], t2, views({ [t1]: s1, [t2]: failed })), { text: t1, result: s1 }, "the failed read leaves the last answer up")
  assert.deepEqual(newestAnswer([t1, t2], t2, views({ [t1]: s1, [t2]: "failed" })), { text: t1, result: s1 })
  assert.deepEqual(typedHistory([t1, t2], t1), [t2, t1], "a typo fixed back: t1 is the newest again")
  assert.deepEqual(typedHistory([t1, t2], ""), [], "an emptied box remembers nothing")
  assert.equal(newestAnswer([], "", views({})), undefined)
  const long = Array.from({ length: TYPED_HISTORY_MAX + 5 }, (_, i) => `every day ${i}`)
  assert.equal(long.reduce((h: readonly string[], t) => typedHistory(h, t), []).length, TYPED_HISTORY_MAX, "bounded")
})
