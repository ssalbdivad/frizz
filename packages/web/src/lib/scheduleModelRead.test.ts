// plans/schedule-live-reading.md §15.1 `scheduleModelRead.test.ts`: single flight, the cache's TTL and its
// local-date key, the budget of 12, and a model reading carried through a task-only edit but dropped by an
// edit that touches its phrase.
import assert from "node:assert/strict"
import test from "node:test"
import { InterpretScheduleInput, SCHEDULE_NOT_FOUND_COPY, cutPhrase, locatePhrase, type InterpretScheduleResult } from "@frizz/shared"
import {
  MODEL_CACHE_MAX,
  MODEL_CACHE_TTL_MS,
  MODEL_READ_BUDGET,
  MODEL_UNREACHABLE_COPY,
  cachedModelRead,
  clearModelReadCache,
  clearSharedModelReaders,
  createModelReader,
  isModelVerdict,
  modelReadKey,
  modelRefusalCopy,
  relocateModelReading,
  sharedModelReader,
  type ModelReadOk,
} from "./scheduleModelRead.ts"

const NY = "America/New_York"
// Mon Oct 5 2026, 2:32pm in New York — the spec's clock.
const NOW = Date.parse("2026-10-05T14:32:00-04:00")

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

function reader(opts: { now?: () => number; budget?: number } = {}) {
  clearModelReadCache()
  const held = heldInterpreter()
  let clock = NOW
  const now = opts.now ?? (() => clock)
  const r = createModelReader({
    interpret: held.interpret,
    keyOf: (text, nowMs) => modelReadKey({ tz: NY, nowMs, text }),
    now,
    ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
  })
  let notified = 0
  r.subscribe(() => { notified++ })
  return { r, held, at: (ms: number) => { clock = ms }, notified: () => notified }
}

test("single flight: a text that changes during a read costs exactly one follow-up, for the latest text", async () => {
  const { r, held } = reader()
  r.request("every Monday unless")
  r.request("every Monday unless it's")
  r.request("every Monday unless it's a holiday")
  assert.deepEqual(held.asked, ["every Monday unless"], "one request out at a time")
  assert.equal(r.view("every Monday unless it's a holiday").status, "reading", "the queued text reads as in progress")
  assert.equal(r.view("every Monday unless it's").status, "none", "an intermediate text is never sent")
  held.pending[0]!.resolve({ ok: false, error: SCHEDULE_NOT_FOUND_COPY })
  await settle()
  assert.deepEqual(held.asked, ["every Monday unless", "every Monday unless it's a holiday"], "exactly one follow-up")
  // The stale answer was still cached.
  assert.equal(r.view("every Monday unless").status, "answered")
  const text = "every Monday unless it's a holiday"
  held.pending[1]!.resolve(ok(text, text))
  await settle()
  assert.equal(held.asked.length, 2)
  const v = r.view(text)
  assert.equal(v.status, "answered")
  assert.deepEqual(r.lastAnswer()?.text, text)
})

test("single flight: asking again for the text that is out sends nothing, and drops an older queued text", async () => {
  const { r, held } = reader()
  r.request("a")
  r.request("b")
  r.request("a")
  held.pending[0]!.resolve({ ok: false, error: SCHEDULE_NOT_FOUND_COPY })
  await settle()
  assert.deepEqual(held.asked, ["a"], "b was moot once the human edited back to a")
  r.cancelQueued()
  r.request("c")
  r.request("d")
  r.cancelQueued()
  // "c" is out; "d" was queued and cancelled (the grammar reads it now): nothing follows.
  held.pending[1]!.resolve({ ok: false, error: SCHEDULE_NOT_FOUND_COPY })
  await settle()
  assert.deepEqual(held.asked, ["a", "c"])
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

test("the cache key carries the local date in the zone, and the context", () => {
  const key = (nowMs: number, tz = NY, context?: string) => modelReadKey({ tz, nowMs, text: "tomorrow at 8", ...(context ? { context } : {}) })
  // 11:58pm and 12:02am in New York are different days, so "tomorrow at 8" is not reused across midnight.
  const before = Date.parse("2026-10-05T23:58:00-04:00")
  const after = Date.parse("2026-10-06T00:02:00-04:00")
  assert.notEqual(key(before), key(after))
  // The same two instants are one day in UTC (03:58 and 04:02 on Oct 6).
  assert.equal(key(before, "UTC"), key(after, "UTC"))
  assert.notEqual(key(before), key(before, "UTC"))
  assert.notEqual(key(NOW, NY, "schedule:sch_000000000001"), key(NOW), "a Change when's answers are not the box's")
  assert.equal(key(NOW).split("\0").length, 4)
})

test("the cache holds at most 50 answers, oldest first out", async () => {
  const { r, held } = reader()
  for (let i = 0; i <= MODEL_CACHE_MAX; i++) {
    r.request(`text ${i}`, { explicit: true })
    held.pending[i]!.resolve({ ok: false, error: SCHEDULE_NOT_FOUND_COPY })
    await settle()
  }
  assert.equal(cachedModelRead(modelReadKey({ tz: NY, nowMs: NOW, text: "text 0" }), NOW), undefined, "the oldest went")
  assert.ok(cachedModelRead(modelReadKey({ tz: NY, nowMs: NOW, text: `text ${MODEL_CACHE_MAX}` }), NOW))
  assert.ok(cachedModelRead(modelReadKey({ tz: NY, nowMs: NOW, text: "text 1" }), NOW))
})

test("only verdicts are cached: a failed call is shown for its text, never cached, and Enter asks again", async () => {
  const { r, held } = reader()
  r.request("every weekday at 9 PT")
  held.pending[0]!.resolve({ ok: false, error: "Couldn't read that just now: Claude did not answer within 60s" })
  await settle()
  const v = r.view("every weekday at 9 PT")
  assert.equal(v.status, "answered")
  assert.equal(v.status === "answered" && !v.result.ok && modelRefusalCopy(v.result), MODEL_UNREACHABLE_COPY)
  r.request("every weekday at 9 PT")
  assert.equal(held.asked.length, 1, "an automatic request does not retry a failure on its own")
  r.request("every weekday at 9 PT", { explicit: true })
  assert.equal(held.asked.length, 2, "Enter does")
  held.pending[1]!.reject(new Error("network down"))
  await settle()
  assert.deepEqual(r.view("every weekday at 9 PT"), { status: "failed", message: "network down" })
  assert.equal(isModelVerdict({ ok: false, error: SCHEDULE_NOT_FOUND_COPY }), true)
  assert.equal(isModelVerdict({ ok: false, error: "Reading a schedule needs Claude, which this server has switched off." }), false)
})

test("the budget: 12 automatic reads a session, then only Enter reads; a new session refills it", async () => {
  const { r, held } = reader()
  for (let i = 0; i < MODEL_READ_BUDGET; i++) {
    r.request(`edit ${i}`)
    held.pending[i]!.resolve({ ok: false, error: SCHEDULE_NOT_FOUND_COPY })
    await settle()
  }
  assert.equal(r.spent(), MODEL_READ_BUDGET)
  r.request("edit 12")
  assert.equal(held.asked.length, MODEL_READ_BUDGET, "the 13th automatic read is not sent")
  assert.equal(r.view("edit 12").status, "budget")
  r.request("edit 12", { explicit: true })
  assert.equal(held.asked.length, MODEL_READ_BUDGET + 1, "Enter reads past the budget")
  assert.equal(r.spent(), MODEL_READ_BUDGET, "and is not counted")
  held.pending[MODEL_READ_BUDGET]!.resolve({ ok: false, error: SCHEDULE_NOT_FOUND_COPY })
  await settle()
  r.reset()
  r.request("edit 13")
  assert.equal(held.asked.length, MODEL_READ_BUDGET + 2, "a new session reads again")
})

test("the budget also binds a queued follow-up", async () => {
  const { r, held } = reader({ budget: 1 })
  r.request("one")
  r.request("two")
  held.pending[0]!.resolve({ ok: false, error: SCHEDULE_NOT_FOUND_COPY })
  await settle()
  assert.deepEqual(held.asked, ["one"])
  assert.equal(r.view("two").status, "budget")
})

test("a model reading belongs to its phrase: a task-only edit keeps it and re-cuts the prompt", () => {
  const read = "every Monday unless it's a holiday post the digest"
  const result = ok(read, "every Monday unless it's a holiday")
  // An edit further into the task: kept, and the prompt is re-cut from the prose as it is now.
  assert.deepEqual(relocateModelReading("every Monday unless it's a holiday post the weekly digest", { text: read, result }), {
    span: { start: 0, end: 34 },
    prompt: "post the weekly digest",
  })
  // Text typed BEFORE the phrase, short of the word next to it, moves it; it is found near where it was.
  const noted = "Team: every Monday unless it's a holiday post the digest"
  const moved = relocateModelReading("Weekly team: every Monday unless it's a holiday post the digest", { text: noted, result: ok(noted, "every Monday unless it's a holiday") })
  assert.deepEqual(moved?.span, { start: 13, end: 47 })
  assert.equal(moved?.prompt, "Weekly team post the digest", "cutPhrase tidies the seam the phrase leaves")
})

// Fix round 3 (relocate-blind-behind-punctuation): the neighbour check read "" across punctuation on both
// sides, so with a comma after the phrase ANY words typed after the comma passed — `, or a weekend,` extended
// the condition the model had read, no second read went out, and the created schedule fired on weekends with
// "or a weekend, post the digest" as its task. Driven on the fixture. "Touches", made exact: an edit touches
// the phrase when it changes any character of the phrase, the PUNCTUATION between the phrase and the nearest
// word on either side (whitespace aside), or that nearest WORD itself — on a side where a word stands now or
// stood when it was read. Everything past that word is the task's.
test("touching the phrase, made exact: an edit that continues its clause drops the reading, past punctuation too", () => {
  const P = "every day unless it's a holiday"
  const drops: [read: string, now: string, why: string][] = [
    [`${P}, post the digest`, `${P}, or a weekend, post the digest`, "words after a comma that continues its clause"],
    [`${P}. Post the digest.`, `${P}. Skip weekends too. Post the digest.`, "a new sentence right after it"],
    [`${P} post the digest`, `Except weekends, ${P} post the digest`, "a qualifier before it, across a comma"],
    [`${P} post the digest`, `Hey, ${P} post the digest`, "any word typed right before it: the reading cannot tell a greeting from a qualifier"],
    [`post the digest ${P}`, `post the digest ${P}, or a weekend`, "words appended after its last word, across a comma"],
    [`post the digest ${P}`, `post the digest ${P} or a weekend`, "words appended directly after its last word"],
    [`${P}, post the digest`, `${P} post the digest`, "the punctuation at its seam changed"],
    [`${P}, post the digest`, `${P}, opost the digest`, "a key typed into the word next to it (the first key of `or`)"],
  ]
  for (const [read, now, why] of drops) {
    assert.equal(relocateModelReading(now, { text: read, result: ok(read, P) }), undefined, `${why}: ${JSON.stringify(now)}`)
  }
})

test("touching the phrase, made exact: an edit to the task alone keeps the reading, re-cut", () => {
  const P = "every day unless it's a holiday"
  const keeps: [read: string, now: string, prompt: string, why: string][] = [
    [`${P}, post the digest`, `${P}, post the weekly digest`, "post the weekly digest", "a word inside the task, after the comma"],
    // (The prompt is always the shared cutPhrase's cut, byte for byte; it drops the phrase's own full stop.)
    [`${P}. Post the digest.`, `${P}. Post the digest to #eng.`, "Post the digest to #eng.", "the end of the task's sentence"],
    [`${P}, post the digest`, `${P}, post the digest. Then ping me.`, "post the digest. Then ping me.", "a sentence after the task's first word"],
    [`post the digest ${P}`, `post the weekly digest ${P}`, "post the weekly digest", "a task before it, short of the word next to it"],
    [`post the digest ${P}`, `post the digest ${P}.`, "post the digest.", "a full stop with no word after it: nothing continues the clause"],
    [`post the digest ${P}`, `post the digest ${P},`, "post the digest", "a comma with no word after it YET (the next word decides)"],
    [`${P}, post the digest`, `${P},  post the digest`, "post the digest", "whitespace at the seam is not punctuation"],
  ]
  for (const [read, now, prompt, why] of keeps) {
    const at = relocateModelReading(now, { text: read, result: ok(read, P) })
    assert.ok(at, `${why}: ${JSON.stringify(now)} keeps the reading`)
    assert.equal(now.slice(at.span.start, at.span.end), P)
    assert.equal(at.prompt, prompt, why)
  }
})

test("a model reading is dropped by an edit that touches its phrase", () => {
  const read = "every Monday unless it's a holiday post the digest"
  const result = ok(read, "every Monday unless it's a holiday")
  // Inside the phrase.
  assert.equal(relocateModelReading("every Tuesday unless it's a holiday post the digest", { text: read, result }), undefined)
  // Right after it: the phrase's characters are intact, but "or a weekend" changes what it means.
  assert.equal(relocateModelReading("every Monday unless it's a holiday or a weekend post the digest", { text: read, result }), undefined)
  // Right before it.
  assert.equal(relocateModelReading("only every Monday unless it's a holiday post the digest", { text: read, result }), undefined)
  // Glued into a word.
  assert.equal(relocateModelReading("every Monday unless it's a holidays post the digest", { text: read, result }), undefined)
  // Gone.
  assert.equal(relocateModelReading("post the digest", { text: read, result }), undefined)
})

test("with two copies of the phrase, the one near where it was is the reading's", () => {
  const read = "twice a week check deps, and say twice a week in the summary"
  const second = read.lastIndexOf("twice a week")
  const result = ok(read, "twice a week", { phraseStart: second, phraseEnd: second + 12 })
  const prose = "twice a week check the deps, and say twice a week in the summary"
  const at = relocateModelReading(prose, { text: read, result })
  assert.deepEqual(at?.span, { start: prose.lastIndexOf("twice a week"), end: prose.lastIndexOf("twice a week") + 12 })
  assert.equal(at?.prompt, "twice a week check the deps, and say in the summary")
})

test("the model's offsets index the text the box SENT, though the server reads it trimmed (fix round 1, X8)", async () => {
  // The server parses the request with InterpretScheduleInput, whose `text` is `.trim()`ed, and the
  // interpreter's offsets index THAT. A prompt that starts with a newline (Shift-Enter first) or a pasted
  // space put every model mark one character late: the panel read "Each run: y post the digest".
  const { r, held } = reader()
  const sent = "\n  every Monday unless it's a holiday post the digest"
  r.request(sent)
  const parsed = InterpretScheduleInput.parse({ text: held.asked[0] })
  const span = locatePhrase(parsed.text, "every Monday unless it's a holiday")!
  held.pending[0]!.resolve(ok(parsed.text, "every Monday unless it's a holiday", { prompt: cutPhrase(parsed.text, span) }))
  await settle()
  const v = r.view(sent)
  assert.ok(v.status === "answered" && v.result.ok)
  assert.equal(sent.slice(v.result.phraseStart, v.result.phraseEnd), "every Monday unless it's a holiday")
  const last = r.lastAnswer()!
  assert.ok(last.result.ok)
  assert.equal(sent.slice(last.result.phraseStart, last.result.phraseEnd), "every Monday unless it's a holiday")
  assert.equal(relocateModelReading(sent, { text: last.text, result: last.result })?.prompt, "post the digest")
  // A server that did NOT trim (offsets already into the sent text) is left as it is.
  const { r: r2, held: held2 } = reader()
  r2.request(sent)
  held2.pending[0]!.resolve(ok(sent, "every Monday unless it's a holiday"))
  await settle()
  const v2 = r2.view(sent)
  assert.ok(v2.status === "answered" && v2.result.ok)
  assert.equal(sent.slice(v2.result.phraseStart, v2.result.phraseEnd), "every Monday unless it's a holiday")
})

test("one reader per draft: two boxes on one draft send one read for one text (fix round 1, X2)", async () => {
  clearModelReadCache()
  clearSharedModelReaders()
  const held = heldInterpreter()
  const deps = { interpret: held.interpret, keyOf: (text: string, nowMs: number) => modelReadKey({ tz: NY, nowMs, text }), now: () => NOW }
  const dialog = sharedModelReader("draft:/a", deps)
  const page = sharedModelReader("draft:/a", deps)
  assert.equal(dialog, page, "the dialog and the page box under it read through one reader")
  const text = "every Monday unless it's a holiday post the digest"
  dialog.request(text, { explicit: true })
  page.request(text)
  assert.deepEqual(held.asked, [text], "the second box finds the text already out")
  held.pending[0]!.resolve(ok(text, "every Monday unless it's a holiday"))
  await settle()
  assert.equal(page.view(text).status, "answered", "and the answer lands in both")
  assert.notEqual(sharedModelReader("draft:/b", deps), dialog, "another draft has its own")
  clearSharedModelReaders()
})
