// plans/schedule-live-reading.md §15.1: the local schedule grammar, against its corpus
// (`schedule-phrase.corpus.ts`), at the spec's clock unless a test says otherwise.

import assert from "node:assert/strict"
import test from "node:test"
import {
  BROAD_QUALIFIERS,
  CASES,
  FIELD_CASES,
  NY,
  PROBE_CORPUS,
  PROBE_NOW,
  PROBE_OVERRIDES,
  RESIDUAL_OFFERS,
  RESIDUE_WORDS,
  ROUND2_HELD_OUT,
  ROUND2_QUALIFIERS,
  ROUND3_CORES,
  ROUND3_MAJORS,
  ROUND3_READ,
  SECOND_SENTENCES,
  SPEC_NOW,
  SPEC_TABLE,
  STRONG_QUALIFIERS,
  summarizeReading,
  TOUCH_QUALIFIERS,
} from "./schedule-phrase.corpus.ts"
import {
  cutPhrase,
  isScheduleOffer,
  locatePhrase,
  provisionalScheduleTitle,
  readingsConsistent,
  readSchedulePhrase,
  SCHEDULE_AMBIGUOUS_COPY,
  SCHEDULE_RESIDUE_FOR_TESTS,
  scheduleWindows,
  scheduleWordPrefix,
  type PhraseReading,
  type Span,
} from "./schedule-phrase.ts"
import { checkSchedule, compileSchedule, describeSchedule, describeScheduleParts, occurrencesAfter, type CompiledSchedule } from "./schedule-rule.ts"
import { scheduleEcho } from "./schedules.ts"
import { THREAD_HANDLE_MAX_CHARS, threadHandle } from "./thread-handle.ts"

type Scope = "edges" | "anywhere" | "field"
const read = (text: string, scope: Scope, nowMs = SPEC_NOW, exclude?: Span[], tz = NY): PhraseReading =>
  readSchedulePhrase(text, { nowMs, tz, scope, ...(exclude ? { exclude } : {}) })
const line = (text: string, scope: Scope, nowMs = SPEC_NOW, exclude?: Span[]) => summarizeReading(text, read(text, scope, nowMs, exclude))

function compiled(rrule: string, dtstart: string, tz = NY): CompiledSchedule {
  const c = compileSchedule({ rrule, dtstart, tz })
  if (!c.ok) throw new Error(`${rrule} @${dtstart}: ${c.error}`)
  return c.value
}
const iso = (list: number[]) => list.map((ms) => new Date(ms).toISOString())

/** Every reading in the corpus, for the properties that hold over all of them. */
function corpusReadings(): { text: string; scope: Scope; r: PhraseReading }[] {
  const out: { text: string; scope: Scope; r: PhraseReading }[] = []
  for (const c of CASES) for (const scope of ["edges", "anywhere"] as const) out.push({ text: c.text, scope, r: read(c.text, scope, SPEC_NOW, c.exclude) })
  for (const c of FIELD_CASES) out.push({ text: c.text, scope: "field", r: read(c.text, "field") })
  return out
}

// ---- the corpus, pinned ------------------------------------------------------------------------------------------

test("every pinned case reads as pinned, in the box and in the mode", () => {
  const wrong: string[] = []
  for (const c of CASES) {
    const edges = line(c.text, "edges", SPEC_NOW, c.exclude)
    const anywhere = line(c.text, "anywhere", SPEC_NOW, c.exclude)
    if (edges !== c.edges) wrong.push(`${JSON.stringify(c.text)} edges\n  want ${c.edges}\n  got  ${edges}`)
    if (anywhere !== (c.anywhere ?? c.edges)) wrong.push(`${JSON.stringify(c.text)} anywhere\n  want ${c.anywhere ?? c.edges}\n  got  ${anywhere}`)
  }
  assert.deepEqual(wrong, [])
})

test("the field reads only a whole phrase", () => {
  for (const c of FIELD_CASES) assert.equal(line(c.text, "field"), c.field, JSON.stringify(c.text))
})

test("an exact reading's phrase is its span, and a cue's span holds its core and its unread words, or the task lies between", () => {
  let far = 0
  for (const { text, r } of corpusReadings()) {
    if (r.kind === "exact" || r.kind === "cue" || r.kind === "ambiguous") {
      assert.ok(r.span.start >= 0 && r.span.end <= text.length && r.span.start < r.span.end, text)
    }
    if (r.kind === "exact" || r.kind === "cue") assert.equal(r.phrase, text.slice(r.span.start, r.span.end), text)
    if (r.kind === "cue") {
      // Unread words far from the phrase (fix round 3: "…what shipped this week") stay where they are: the span is
      // the phrase, and the words between are the task's, which a span over them would cut away.
      const inside = r.span.start <= r.unread.start && r.unread.end <= r.span.end
      const between = r.unread.start >= r.span.end ? text.slice(r.span.end, r.unread.start) : r.unread.end <= r.span.start ? text.slice(r.unread.end, r.span.start) : ""
      if (!inside) far++
      assert.ok(inside || /[\p{L}\p{N}]/u.test(between), `${text}: unread inside the span, or past the task's words`)
      assert.ok(r.unread.start < r.unread.end, `${text}: unread is not empty`)
      if (r.core) assert.ok(r.span.start <= r.core.span.start && r.core.span.end <= r.span.end, `${text}: core inside the span`)
    }
    if (r.kind === "ambiguous") assert.ok((Object.values(SCHEDULE_AMBIGUOUS_COPY) as string[]).includes(r.copy), text)
  }
  assert.ok(far > 0, "some cue reads words far from its phrase")
})

// ---- the probe corpus, graded as it was written ---------------------------------------------------------------

/** The next 12 runs agree. The engine looks ten years past a rule's start, so a yearly rule started a
 *  quarter later sees one more year: compare what both can see, which is at least ten. */
function assertSameRuns(got: CompiledSchedule, want: CompiledSchedule, label: string): void {
  const a = iso(occurrencesAfter(got, PROBE_NOW, 12))
  const b = iso(occurrencesAfter(want, PROBE_NOW, 12))
  const n = Math.min(a.length, b.length)
  assert.ok(a.length === b.length || n >= 10, `${label}: ${a.length} and ${b.length} runs`)
  assert.deepEqual(a.slice(0, n), b.slice(0, n), `next 12: ${label}`)
}

test("the probe corpus, graded at its own clock against expectations written before the grammar", () => {
  const tally = { exact: 0, model: 0, none: 0, overridden: 0 }
  for (const item of PROBE_CORPUS) {
    const anywhere = read(item.text, "anywhere", PROBE_NOW)
    const edges = read(item.text, "edges", PROBE_NOW)
    const override = PROBE_OVERRIDES[item.text]
    if (override) {
      assert.equal(summarizeReading(item.text, anywhere), override.reads, `override: ${item.text}`)
      if (override.sameRuns && typeof item.expect === "object" && anywhere.kind === "exact") {
        assertSameRuns(compiled(anywhere.rrule, anywhere.dtstart), compiled(item.expect.r, item.expect.dt ?? "2026-10-05T00:00"), item.text)
      }
      tally.overridden++
      continue
    }
    if (item.expect === "MODEL") {
      // Needs the model: never exact anywhere, and never an exact offer in the box.
      assert.ok(anywhere.kind === "cue" || anywhere.kind === "ambiguous", `${item.text}: ${summarizeReading(item.text, anywhere)}`)
      assert.ok(!(edges.kind === "exact" && isScheduleOffer(edges)), item.text)
      tally.model++
      continue
    }
    if (item.expect === "NONE") {
      // A dispatch: dark in the box, except the two known residuals, which are pinned as offers.
      assert.equal(isScheduleOffer(edges), RESIDUAL_OFFERS.includes(item.text), `${item.text}: ${summarizeReading(item.text, edges)}`)
      if (item.cat === "H") assert.equal(anywhere.kind, "event", item.text)
      tally.none++
      continue
    }
    const want = item.expect
    assert.equal(anywhere.kind, "exact", `${item.text}: ${summarizeReading(item.text, anywhere)}`)
    if (anywhere.kind !== "exact") continue
    assert.equal(anywhere.rrule, want.r, item.text)
    if (want.dt) assert.equal(anywhere.dtstart, want.dt, item.text)
    // `soft`: a defaulted time or day, which must be flagged so the box can dim it.
    const defaulted = anywhere.assumed.some((a) => a.part === "time" || a.part === "day")
    assert.equal(defaulted, !!want.soft, `${item.text}: assumed ${JSON.stringify(anywhere.assumed)}`)
    // The next 12 runs equal the expected rule's own, compiled independently from the corpus's words.
    assertSameRuns(compiled(anywhere.rrule, anywhere.dtstart), compiled(want.r, want.dt ?? "2026-10-05T00:00"), item.text)
    // In the box: a recurrence at an edge is offered; a one-off is read only in the mode.
    assert.equal(isScheduleOffer(edges), !anywhere.once, `${item.text}: ${summarizeReading(item.text, edges)}`)
    tally.exact++
  }
  assert.deepEqual(tally, { exact: 77, model: 17, none: 28, overridden: 11 })
})

// ---- the spec's §3.3 table ------------------------------------------------------------------------------------

test("§3.3: each row reads, offers and echoes as the spec's table says", () => {
  for (const row of SPEC_TABLE) {
    const r = read(row.text, row.scope)
    assert.equal(summarizeReading(row.text, r), row.reads, `row ${row.row}`)
    if (row.scope === "edges") assert.equal(isScheduleOffer(r), row.offered, `row ${row.row} offered`)
    if (row.describe) {
      assert.ok(r.kind === "exact", `row ${row.row}`)
      const echo = scheduleEcho({ title: "Run", rrule: r.rrule, dtstart: r.dtstart, tz: NY }, SPEC_NOW, NY)
      assert.ok(echo.ok, `row ${row.row}: ${!echo.ok && echo.error}`)
      assert.equal(echo.value.describe, row.describe, `row ${row.row} describe`)
      assert.ok(echo.value.nextLine.startsWith(`Next: ${row.next}`), `row ${row.row}: ${echo.value.nextLine}`)
    }
  }
  // Row 19: no accept, the copy verbatim.
  const biweekly = read("biweekly sync the roadmap doc", "edges")
  assert.ok(biweekly.kind === "ambiguous")
  assert.equal(biweekly.copy, "“Biweekly” can mean every 2 weeks or twice a week. Say which.")
  // Row 6: a dense rule echoes its runs a day, and its next line carries the time.
  const row6 = read("every 2 hours on weekdays from 9 to 5 check CI", "edges")
  assert.ok(row6.kind === "exact")
  const echo6 = scheduleEcho({ title: "Check CI", rrule: row6.rrule, dtstart: row6.dtstart, tz: NY }, SPEC_NOW)
  assert.ok(echo6.ok)
  assert.equal(echo6.value.perDay, 5)
})

// ---- what an exact reading promises ------------------------------------------------------------------------------

test("every exact reading passes the server's own check, or says it would not", () => {
  let n = 0
  for (const { text, r } of corpusReadings()) {
    const exact = r.kind === "exact" ? r : r.kind === "cue" && r.core ? { ...r.core, spacing: undefined } : undefined
    if (!exact) continue
    // Never the 9:32:17 of a rule that inherits its minute from now (rrule.js): both are always written.
    assert.match(exact.rrule, /BYMINUTE=/, text)
    if (!/FREQ=HOURLY/.test(exact.rrule)) assert.match(exact.rrule, /BYHOUR=/, text)
    assert.match(exact.dtstart, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, text)
    const checked = checkSchedule({ rrule: exact.rrule, dtstart: exact.dtstart, tz: NY }, SPEC_NOW)
    if (exact.spacing) {
      assert.equal(checked.ok, false, `${text}: spacing means the server refuses it`)
      continue
    }
    assert.ok(checked.ok, `${text}: ${!checked.ok && checked.error}`)
    // Its first run is the reading's start, and it never phrases as the raw RRULE fallback.
    assert.equal(new Date(checked.value.next[0]!).getTime(), compiled(exact.rrule, exact.dtstart).dtstartMs, `${text}: dtstart is the first run`)
    assert.ok(!describeSchedule(checked.value.compiled).startsWith("on the rule"), text)
    n++
  }
  assert.ok(n > 150, `${n} readings checked`)
})

test("describeScheduleParts joins to describeSchedule for every rule in the corpus", () => {
  const seen = new Set<string>()
  for (const { r } of corpusReadings()) {
    const rule = r.kind === "exact" ? r : r.kind === "cue" ? r.core : undefined
    if (!rule || seen.has(`${rule.rrule}@${rule.dtstart}`)) continue
    seen.add(`${rule.rrule}@${rule.dtstart}`)
    const c = compiled(rule.rrule, rule.dtstart)
    assert.equal(describeScheduleParts(c, SPEC_NOW).map((p) => p.text).join(""), describeSchedule(c, SPEC_NOW), rule.rrule)
  }
  assert.ok(seen.size > 60, `${seen.size} rules`)
})

test("an assumed part names what the box dims", () => {
  const thu = read("Every Thursday at 3 prep the planning notes", "edges")
  assert.ok(thu.kind === "exact")
  assert.deepEqual(thu.assumed, [{ part: "meridiem", shown: "3pm", other: "3am", span: { start: 18, end: 19 } }])
  const morning = read("every morning summarize new Sentry errors", "edges")
  assert.ok(morning.kind === "exact")
  assert.deepEqual(morning.assumed, [{ part: "time", shown: "9am", word: "morning" }])
  const weekly = read("once a week check for outdated GitHub Actions versions", "edges")
  assert.ok(weekly.kind === "exact")
  assert.deepEqual(weekly.assumed, [{ part: "day", shown: "Monday" }, { part: "time", shown: "9am" }])
  // A window's pair settles its own guess: "9 to 5" can only be 9am to 5pm.
  const window = read("every 2 hours on weekdays from 9 to 5 check CI", "edges")
  assert.ok(window.kind === "exact")
  assert.deepEqual(window.assumed, [])
})

// ---- never eat a prefix ----------------------------------------------------------------------------------------

/** The positives every qualifier is tried against: every exact recurrence the corpus reads in the box. */
function positives(): { text: string; span: Span }[] {
  const out: { text: string; span: Span }[] = []
  for (const c of CASES) {
    if (c.exclude) continue
    const r = read(c.text, "anywhere")
    if (r.kind === "exact" && !r.spacing && isScheduleOffer(read(c.text, "edges"))) out.push({ text: c.text, span: r.span })
  }
  return out
}

function leftOutside(r: PhraseReading, q: Span): boolean {
  return r.kind === "exact" && !(r.span.start <= q.start && r.span.end >= q.end)
}

test("no silent prefix: a qualifier is in the span or the reading is not exact — appended, inserted, prepended", () => {
  const list = positives()
  assert.ok(list.length >= 90, `${list.length} positives`)
  const failures: string[] = []
  let tries = 0
  const check = (text: string, q: Span, scopes: Scope[]) => {
    for (const scope of scopes) {
      tries++
      const r = read(text, scope)
      if (leftOutside(r, q)) failures.push(`${scope}: ${JSON.stringify(text)} → ${summarizeReading(text, r)}`)
    }
  }
  for (const { text, span } of list) {
    const phrase = text.slice(span.start, span.end)
    for (const qual of [...STRONG_QUALIFIERS, ...TOUCH_QUALIFIERS]) {
      // Right after the span: "every Monday at 9am unless it's a holiday triage new issues".
      const inserted = `${text.slice(0, span.end)} ${qual}${text.slice(span.end)}`
      check(inserted, { start: span.end + 1, end: span.end + 1 + qual.length }, ["edges", "anywhere"])
      // Before the text: "unless it's a holiday, every Monday at 9am triage new issues". A weak qualifier
      // there opens the TASK when the phrase sits at the other end ("if the build is green, triage new
      // issues every Monday at 9am"), so it is tried only against a phrase that opens the text.
      if (STRONG_QUALIFIERS.includes(qual) || span.start === 0) check(`${qual}, ${text}`, { start: 0, end: qual.length }, ["edges", "anywhere"])
      // The phrase alone in the field, qualified after and before.
      check(`${phrase} ${qual}`, { start: phrase.length + 1, end: phrase.length + 1 + qual.length }, ["field", "anywhere", "edges"])
      check(`${qual} ${phrase}`, { start: 0, end: qual.length }, ["field", "anywhere"])
    }
    // At the end of the text, inside the task, only the qualifiers that change a schedule wherever they sit.
    for (const qual of STRONG_QUALIFIERS) {
      const appended = `${text.replace(/[.!]$/, "")} ${qual}`
      check(appended, { start: appended.length - qual.length, end: appended.length }, ["edges", "anywhere"])
    }
  }
  assert.deepEqual(failures, [])
  assert.ok(tries > 10_000, `${tries} readings`)
})

test("the bounds and starts it reads fully join the span; the rest become cues", () => {
  const into = (text: string, phrase: string) => {
    const r = read(text, "anywhere")
    assert.ok(r.kind === "exact", `${text}: ${summarizeReading(text, r)}`)
    assert.equal(r.phrase, phrase)
    return r
  }
  assert.match(into("every Monday at 9am for 3 weeks triage", "every Monday at 9am for 3 weeks").rrule, /COUNT=3;/)
  assert.match(into("every weekday at 9am for 2 weeks run the check", "every weekday at 9am for 2 weeks").rrule, /COUNT=10;/)
  assert.match(into("daily at 9am until Oct 30 check signups", "daily at 9am until Oct 30").rrule, /UNTIL=20261030;/)
  assert.equal(into("starting Oct 12, every weekday at 9am triage", "starting Oct 12, every weekday at 9am").dtstart, "2026-10-12T09:00")
  assert.match(into("every Monday at 9am 5 times triage", "every Monday at 9am 5 times").rrule, /COUNT=5;/)
  for (const [text, why, unread] of [
    ["every weekday at 9am except holidays triage the inbox", "condition", "except holidays"],
    ["every Monday unless it's a holiday post the digest", "condition", "unless it's a holiday"],
    ["every Monday at 9am only if CI is red, rerun it", "condition", "only if CI is red"],
    ["every monday until christmas", "leftover", "until christmas"],
    ["every Monday at 9am triage new issues and also every friday", "compound", "every friday"],
    ["every day at 9am, after each release, update the notes", "condition", "after each release"],
  ] as const) {
    const r = read(text, "anywhere")
    assert.ok(r.kind === "cue", `${text}: ${summarizeReading(text, r)}`)
    assert.equal(r.why, why, text)
    assert.equal(text.slice(r.unread.start, r.unread.end), unread, text)
  }
})

// ---- the edge rules (§2.3) -------------------------------------------------------------------------------------

test("a deadline word just before a close-edge phrase keeps it dark", () => {
  for (const word of ["until", "by", "before", "after", "since", "than", "from", "for"]) {
    for (const text of [`ship the fix ${word} Friday every week`, `ship the fix ${word} every Monday at 9am`]) {
      const r = read(text, "edges")
      assert.equal(isScheduleOffer(r), false, `${text}: ${summarizeReading(text, r)}`)
    }
  }
  // The word right before, or a deadline and its object, is a qualifier the reading cannot drop: a cue,
  // dark at the close edge. In the mode the model reads it ("by Friday every week" is Fridays to Sonnet).
  const byFriday = read("have it done by Friday every week", "anywhere")
  assert.ok(byFriday.kind === "cue" && byFriday.why === "leftover", summarizeReading("have it done by Friday every week", byFriday))
  // Where the grammar can read the idiom's words as a start, the guard still turns it down.
  const r = read("ship the fix from Friday every week", "edges")
  assert.ok(r.kind === "exact" && r.veto === "deadline", summarizeReading("ship the fix from Friday every week", r))
  // Two words away is no longer the idiom.
  assert.equal(isScheduleOffer(read("ship it for the team every Monday at 9am", "edges")), true)
})

test("a sentence about a schedule is not one, both ways (§1.3.7)", () => {
  for (const text of [
    "add a GitHub Action that runs the tests every Monday at 9am",
    "make sure the cron job fires every Monday at 9am",
    "a script I will run each morning",
    "fix the workflow so it triggers every Friday at 5pm",
    "the pipeline should be scheduled every day at 2am",
  ]) {
    const r = read(text, "edges")
    assert.ok(r.kind === "exact" && r.veto === "about", `${text}: ${summarizeReading(text, r)}`)
    assert.equal(isScheduleOffer(r), false, text)
  }
  // The sentence's first word is the imperative, never the subject.
  for (const text of ["run the e2e suite against staging nightly", "trigger the deploy every Friday at 5pm", "schedule a sync every Monday at 9am"]) {
    assert.equal(isScheduleOffer(read(text, "edges")), true, text)
  }
  // The veto is the close edge's alone: at the open edge the human is speaking the schedule.
  assert.equal(isScheduleOffer(read("every Monday at 9am, run the cron job by hand", "edges")), true)
})

test("quotes, backticks, fences, a leading /command and excluded runs are never read", () => {
  for (const text of [
    "\"every Monday at 9am\" is parsed as UTC, fix it",
    "why is “every Monday at 9am” read as UTC",
    "fix the parser for `every Monday at 9am`",
    "fix this:\n```\nevery Monday at 9am\n```",
    "\"every Monday at 9am",
    "`every Monday at 9am",
  ]) {
    for (const scope of ["edges", "anywhere", "field"] as const) assert.equal(read(text, scope).kind, "none", `${scope}: ${text}`)
  }
  const command = read("/review every Monday at 9am", "edges")
  assert.ok(command.kind === "exact" && command.edge === "open" && command.phrase === "every Monday at 9am")
  assert.equal(read("summarize @every-friday-bot", "anywhere", SPEC_NOW, [{ start: 10, end: 27 }]).kind, "none")
  assert.deepEqual(scheduleWindows("@alice every Monday at 9am", [{ start: 0, end: 6 }]), [{ start: 7, end: 26 }])
})

test("mid-text phrases stay dark in the box and are read in the mode", () => {
  for (const text of ["see the doc.\n\nevery Monday at 9am triage new issues", "list every Friday release from the changelog"]) {
    assert.equal(isScheduleOffer(read(text, "edges")), false, text)
    const r = read(text, "anywhere")
    assert.ok(r.kind === "exact" && r.edge === "inside", text)
  }
  // A phrase a statement is ABOUT (fix round 1): dark in the box, and in the mode the model reads it, with no
  // core — "every Monday, Friday is off-limits" showed why a list before "is" is not a rule to keep.
  const about = read("the job that runs every Monday at 9am is broken, fix it", "anywhere")
  assert.ok(about.kind === "cue" && about.edge === "inside" && !about.core, summarizeReading("…", about))
  assert.equal(isScheduleOffer(read("the job that runs every Monday at 9am is broken, fix it", "edges")), false)
})

test("found by the model (the agreement experiment): words that bound or move a phrase, read as such", () => {
  // Sonnet refused this as no schedule; the grammar had dropped "this week", a bound.
  const week = read("the build has been failing every day this week, find out why", "anywhere")
  assert.ok(week.kind === "cue" && week.why === "leftover")
  // Sonnet read Fridays; the grammar had dropped "by Friday" and assumed Monday.
  assert.ok(read("have it done by Friday every week", "anywhere").kind === "cue")
  // A time box, not a one-off: Sonnet found no schedule.
  assert.ok(read("stop at 5pm today", "anywhere").kind === "cue")
})

test("the two known residual offers are still offers", () => {
  for (const text of RESIDUAL_OFFERS) assert.equal(isScheduleOffer(read(text, "edges")), true, text)
})

test("a close-edge cue, an ambiguous word or a presence at the close edge is dark", () => {
  for (const text of ["finish the report before every Monday at 9am", "post the digest every Monday unless it's a holiday", "sync the roadmap doc biweekly", "check CI while I'm working"]) {
    assert.equal(isScheduleOffer(read(text, "edges")), false, `${text}: ${line(text, "edges")}`)
  }
})

// ---- typing (§2.4) -------------------------------------------------------------------------------------------

// `lib/scheduleOffer.ts` (Step 4) owns the real publish policy; until it lands, this is its boundary rule
// alone: a reading reaches the screen only where the character just typed is a boundary, and a close-edge
// offer only once the typing stops (CLOSE_IDLE_MS — here, the end of the text). Because the publisher never
// looks inside a word, "nothing published from a mid-word prefix" holds by construction; what the grammar
// adds is the mid-word assertion below — a half-typed word is never read as a typo.
//
// One rule more than §2.4 states, recorded there as built: a qualifier still being typed holds the reading
// it qualifies. "every Monday at 9am for" is a cue (the grammar never eats a word it has not read), but
// while its unread words run to the end of the text and its core is the offer on screen, the human is
// mid-qualifier — "for 3 weeks" is coming — so the offer stays until the qualifier is finished or the
// typing stops. Without it, every bound typed after a clock flips the ledge to a cue and back (6 changes
// for "every weekday at 9am for 2 weeks starting Oct 12"; 152 of 156 positives within 4 either way).
const BOUNDARY = /[\s,;:.!?)]/

/** What the offer IS: an exact reading's span and rule, or a cue's reason and core. A cue's unread words
 *  growing as they are typed ("every 2nd Tuesday", "… of", "… of the") are one reading being finished. */
function offerKey(text: string, r: PhraseReading): string {
  if (r.kind === "cue") return `cue ${r.edge} ${r.why} ${r.core ? `${r.core.rrule} @${r.core.dtstart}` : r.unread.start}`
  return summarizeReading(text, r)
}

function typeOut(text: string): { published: (string | undefined)[]; changes: number; last: string | undefined } {
  let current: string | undefined
  let shown: PhraseReading | undefined
  let changes = 0
  const published: (string | undefined)[] = []
  for (let i = 1; i <= text.length; i++) {
    const done = i === text.length
    if (!done && !BOUNDARY.test(text[i - 1]!)) continue
    const prefix = text.slice(0, i)
    const r = read(prefix, "edges")
    const midQualifier =
      !done && r.kind === "cue" && !!r.core && r.unread.end >= prefix.trimEnd().length && shown?.kind === "exact" && shown.rrule === r.core.rrule && shown.dtstart === r.core.dtstart
    if (midQualifier) continue
    const offered = isScheduleOffer(r) && (r.kind !== "exact" || r.edge === "open" || done)
    const next = offered ? offerKey(prefix, r) : undefined
    if (next !== current) {
      changes++
      current = next
      shown = offered ? r : undefined
      published.push(next)
    }
  }
  return { published, changes, last: current }
}

test("typing: a positive settles in at most four published changes, ending on its final reading", () => {
  let worst = 0
  for (const { text } of positives()) {
    const { changes, last } = typeOut(text)
    worst = Math.max(worst, changes)
    assert.ok(changes <= 4, `${text}: ${changes} changes`)
    assert.equal(last, offerKey(text, read(text, "edges")), text)
  }
  assert.ok(worst >= 1)
})

test("typing: a dispatch never offers at any word boundary", () => {
  const negatives = [
    ...PROBE_CORPUS.filter((i) => i.expect === "NONE").map((i) => i.text),
    ...CASES.filter((c) => ["hint", "prior-art", "timebox", "escape"].includes(c.source) && !isScheduleOffer(read(c.text, "edges"))).map((c) => c.text),
  ].filter((t) => !RESIDUAL_OFFERS.includes(t))
  assert.ok(negatives.length > 40)
  for (const text of negatives) assert.deepEqual(typeOut(text).published, [], text)
})

test("typing: a half-typed word is never a typo", () => {
  for (const { text } of positives()) {
    for (let i = 1; i < text.length; i++) {
      if (BOUNDARY.test(text[i]!) || BOUNDARY.test(text[i - 1]!)) continue
      const r = read(text.slice(0, i), "anywhere")
      assert.ok(!(r.kind === "cue" && r.why === "typo" && r.unread.end === i), `${JSON.stringify(text.slice(0, i))}`)
    }
  }
  const done = read("evry monday at 9 triage issues", "anywhere")
  assert.ok(done.kind === "cue" && done.why === "typo")
})

// ---- daylight saving (2026: Mar 8 and Nov 1 in New York) ---------------------------------------------------------

test("DST: a daily clock keeps its wall time across both changes", () => {
  const spring = read("every day at 9am check CI", "edges", Date.parse("2026-03-06T12:00:00-05:00"))
  assert.ok(spring.kind === "exact")
  assert.equal(spring.dtstart, "2026-03-07T09:00")
  assert.deepEqual(iso(occurrencesAfter(compiled(spring.rrule, spring.dtstart), Date.parse("2026-03-06T12:00:00-05:00"), 3)), [
    "2026-03-07T14:00:00.000Z",
    "2026-03-08T13:00:00.000Z",
    "2026-03-09T13:00:00.000Z",
  ])
  const fall = read("every day at 9am for 3 days check CI", "edges", Date.parse("2026-10-31T12:00:00-04:00"))
  assert.ok(fall.kind === "exact")
  assert.equal(fall.rrule, "FREQ=DAILY;COUNT=3;BYHOUR=9;BYMINUTE=0")
  assert.deepEqual(iso(occurrencesAfter(compiled(fall.rrule, fall.dtstart), Date.parse("2026-10-31T12:00:00-04:00"), 5)), [
    "2026-11-01T14:00:00.000Z",
    "2026-11-02T14:00:00.000Z",
    "2026-11-03T14:00:00.000Z",
  ])
})

test("DST: a run in the spring gap moves past it; one in the repeated hour runs once", () => {
  const now = Date.parse("2026-03-01T12:00:00-05:00")
  const gap = read("every Sunday at 2:30am rotate the logs", "edges", now)
  assert.ok(gap.kind === "exact")
  // The first run is Mar 8, whose 2:30 does not exist: it runs at 3:30, and the start says so.
  assert.equal(gap.dtstart, "2026-03-08T03:30")
  assert.deepEqual(iso(occurrencesAfter(compiled(gap.rrule, gap.dtstart), now, 2)), ["2026-03-08T07:30:00.000Z", "2026-03-15T06:30:00.000Z"])
  const repeated = read("every day at 1:30am rotate the logs", "edges", Date.parse("2026-10-31T12:00:00-04:00"))
  assert.ok(repeated.kind === "exact")
  assert.deepEqual(iso(occurrencesAfter(compiled(repeated.rrule, repeated.dtstart), Date.parse("2026-10-31T12:00:00-04:00"), 2)), ["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"])
})

test("DST: a bound counts runs, not hours, across the change", () => {
  const r = read("every weekday at 9am for 1 week run the check", "edges", Date.parse("2026-03-06T12:00:00-05:00"))
  assert.ok(r.kind === "exact")
  assert.equal(r.rrule, "FREQ=WEEKLY;COUNT=5;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0")
  assert.equal(r.dtstart, "2026-03-09T09:00")
})

test("DST: 'in 2 hours' is two real hours, and refuses the repeated hour it cannot name", () => {
  const spring = read("in 2 hours check the canary", "anywhere", Date.parse("2026-03-08T01:30:00-05:00"))
  assert.ok(spring.kind === "exact")
  assert.equal(spring.dtstart, "2026-03-08T04:30")
  assert.deepEqual(iso(occurrencesAfter(compiled(spring.rrule, spring.dtstart), Date.parse("2026-03-08T01:30:00-05:00"), 1)), ["2026-03-08T08:30:00.000Z"])
  // 00:30 EDT + 2h is the SECOND 1:30 (EST). A wall clock names the first, an hour early: the model reads it.
  const fall = read("in 2 hours check the canary", "anywhere", Date.parse("2026-11-01T00:30:00-04:00"))
  assert.ok(fall.kind === "cue" && fall.why === "unsupported", summarizeReading("in 2 hours check the canary", fall))
})

// ---- performance -------------------------------------------------------------------------------------------------

function medianMs(fn: () => void, runs = 21): number {
  const times: number[] = []
  for (let i = 0; i < runs; i++) {
    const t = performance.now()
    fn()
    times.push(performance.now() - t)
  }
  return times.sort((a, b) => a - b)[runs >> 1]!
}

test("performance: 20k characters in the box under 3ms, 4k in the mode under 10ms", () => {
  const filler =
    "The daily build broke again because every file in src imports the weekly helper, and on Mondays at 9am the cron job that runs every hour fires twice; check whether each PR touched it. "
  const fill = (head: string, size: number) => {
    let s = head
    while (s.length < size) s += filler
    return s.slice(0, size)
  }
  const big = fill("every Monday at 9am triage new issues. ", 20_000)
  const mid = fill("every weekday at 9am except holidays, summarize what changed. ", 4_000)
  // The first read of a phrase walks the engine (`checkSchedule`); keystrokes after it re-read the same
  // phrase. The cold read is bounded loosely, so a regression to a walk per candidate (500ms at 4k) fails.
  const coldBig = medianMs(() => read(big, "edges", SPEC_NOW + 1), 1)
  const coldMid = medianMs(() => read(mid, "anywhere", SPEC_NOW + 1), 1)
  assert.ok(coldBig < 50 && coldMid < 50, `cold: ${coldBig.toFixed(2)}ms, ${coldMid.toFixed(2)}ms`)
  const edges = medianMs(() => read(big, "edges"))
  const anywhere = medianMs(() => read(mid, "anywhere"))
  assert.ok(edges < 3, `20k edges: ${edges.toFixed(2)}ms`)
  assert.ok(anywhere < 10, `4k anywhere: ${anywhere.toFixed(2)}ms`)
})

test("performance: every read is linear — 20k characters of each pathological shape under 10ms, in every scope", () => {
  // Round 3 (F20) found three reads quadratic in a run of one character: the field's trailing-run regex (1.4s for
  // "every Monday at 9am" + 20k spaces + "x"), a conjoined rule's `\s*,?\s*` (836ms) and a zone offset's
  // `\s*` after the leading run (306ms). Measured after the fix, warm medians: at most 5.7ms here; 80k
  // characters cost about 3x what 20k do.
  const N = 20_000
  const phrase = "every Monday at 9am"
  const shapes: [string, string][] = [
    ["spaces, then a phrase", " ".repeat(N) + phrase],
    ["a phrase, spaces, a word", phrase + " ".repeat(N) + "x"],
    ["a phrase, tabs, a word", phrase + "\t".repeat(N) + "x"],
    ["a phrase, dots, a word", phrase + ".".repeat(N) + "x"],
    ["a phrase, parens, a word", phrase + ")".repeat(N) + "x"],
    ["a phrase, commas, a word", phrase + ", ".repeat(N / 2) + "x"],
    ["newlines, then a phrase", "\n".repeat(N) + phrase],
    ["bullets, then a phrase", "- ".repeat(N / 2) + phrase],
    ["open parens, then a phrase", "(".repeat(N) + phrase],
    ["words, then a phrase", "word ".repeat(N / 5) + phrase],
    ["a phrase, then words", `${phrase} ${"word ".repeat(N / 5)}`],
    ["a phrase, then bare numbers", `${phrase} ${"9 ".repeat(N / 2)}`],
    ["dots", ".".repeat(N)],
    ["parens", ")".repeat(N)],
    ["newlines", "\n".repeat(N)],
    ["digits", "1".repeat(N)],
    ["colons", ":".repeat(N)],
    ["a word, spaces, a gate word", `a${" ".repeat(N)}every`],
  ]
  const slow: string[] = []
  for (const [label, text] of shapes) {
    for (const scope of ["edges", "anywhere", "field"] as const) {
      read(text, scope)
      const ms = medianMs(() => read(text, scope), 5)
      if (ms >= 10) slow.push(`${label}, ${scope}: ${ms.toFixed(1)}ms`)
    }
  }
  assert.deepEqual(slow, [])
})

// ---- helpers ------------------------------------------------------------------------------------------------------

test("provisionalScheduleTitle: verb and head noun, sentence case, within a thread name", () => {
  for (const [prompt, title] of [
    ["triage new issues", "Triage issues"],
    ["summarize overnight Sentry errors", "Summarize errors"],
    ["post the digest", "Post digest"],
    ["please check CI", "Check CI"],
    ["Triage New Issues", "Triage issues"],
    ["rebase the long-lived feature branch", "Rebase branch"],
    ["review open dependabot PRs, then merge the green ones", "Review PRs"],
    ["deploy", "Deploy"],
    ["update the roadmap doc from Linear", "Update Linear"],
    ["clean it up", "Clean"],
    ["", "Scheduled run"],
    ["   ", "Scheduled run"],
    ["the", "Scheduled run"],
    ["reconcile internationalization-translations", "Reconcile"],
    ["supercalifragilisticexpialidocious things", "Scheduled run"],
  ] as const) {
    const got = provisionalScheduleTitle(prompt)
    assert.equal(got, title, prompt)
    assert.ok(got.split(/\s+/).length <= 2, got)
    assert.ok((threadHandle(got)?.length ?? 0) <= THREAD_HANDLE_MAX_CHARS, got)
  }
  // Every cut prompt in the corpus titles within the limits.
  for (const c of CASES) {
    const r = read(c.text, "edges")
    if (r.kind !== "exact") continue
    const title = provisionalScheduleTitle(cutPhrase(c.text, r.span))
    assert.ok(title.split(/\s+/).length <= 2 && (threadHandle(title)?.length ?? 0) <= THREAD_HANDLE_MAX_CHARS, `${c.text} → ${title}`)
    assert.ok(/^\p{Lu}/u.test(title), title)
  }
})

test("readingsConsistent: a model reading may grow the core, never shrink or move it", () => {
  const core = read("every Monday unless it's a holiday post the digest", "edges")
  assert.ok(core.kind === "cue" && core.core)
  const base = { rrule: core.core.rrule, dtstart: core.core.dtstart, tz: NY, assumed: core.core.assumed, span: core.core.span }
  // The model's reading of the whole phrase: the same Mondays, with its condition. Grows: ok.
  assert.equal(readingsConsistent(base, { rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0", dtstart: "2026-10-12T09:00", tz: NY, span: core.span }, SPEC_NOW), true)
  // A shorter span than the core: shrinks.
  assert.equal(readingsConsistent(base, { rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0", dtstart: "2026-10-12T09:00", tz: NY, span: { start: 0, end: 5 } }, SPEC_NOW), false)
  // A different day: moved.
  assert.equal(readingsConsistent(base, { rrule: "FREQ=WEEKLY;BYDAY=TU;BYHOUR=9;BYMINUTE=0", dtstart: "2026-10-13T09:00", tz: NY }, SPEC_NOW), false)
  // The core ASSUMED 9am: the model's 10am on the same Mondays is not a contradiction.
  assert.equal(readingsConsistent(base, { rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=10;BYMINUTE=0", dtstart: "2026-10-12T10:00", tz: NY }, SPEC_NOW), true)
  // A typed 9am is a constraint.
  const typed = read("every Monday at 9am unless it's a holiday post the digest", "edges")
  assert.ok(typed.kind === "cue" && typed.core)
  const typedBase = { rrule: typed.core.rrule, dtstart: typed.core.dtstart, tz: NY, assumed: typed.core.assumed }
  assert.equal(readingsConsistent(typedBase, { rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=10;BYMINUTE=0", dtstart: "2026-10-12T10:00", tz: NY }, SPEC_NOW), false)
  // A condition, COUNT or UNTIL only removes runs: still consistent.
  assert.equal(readingsConsistent(typedBase, { rrule: "FREQ=WEEKLY;COUNT=3;BYDAY=MO;BYHOUR=9;BYMINUTE=0", dtstart: "2026-10-12T09:00", tz: NY }, SPEC_NOW), true)
  assert.equal(readingsConsistent(typedBase, { rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;BYHOUR=9;BYMINUTE=0", dtstart: "2026-10-12T09:00", tz: NY }, SPEC_NOW), true)
  // An assumed meridiem compares the clock on 12 hours: "at 3" read as 3pm, the model's 3am agrees.
  const three = read("every Thursday at 3 unless it's a holiday prep the notes", "edges")
  assert.ok(three.kind === "cue" && three.core)
  const threeBase = { rrule: three.core.rrule, dtstart: three.core.dtstart, tz: NY, assumed: three.core.assumed }
  assert.equal(readingsConsistent(threeBase, { rrule: "FREQ=WEEKLY;BYDAY=TH;BYHOUR=3;BYMINUTE=0", dtstart: "2026-10-08T03:00", tz: NY }, SPEC_NOW), true)
  assert.equal(readingsConsistent(threeBase, { rrule: "FREQ=WEEKLY;BYDAY=TH;BYHOUR=4;BYMINUTE=0", dtstart: "2026-10-08T04:00", tz: NY }, SPEC_NOW), false)
  // A rule that does not compile is never consistent.
  assert.equal(readingsConsistent(typedBase, { rrule: "FREQ=SECONDLY", dtstart: "2026-10-12T09:00", tz: NY }, SPEC_NOW), false)
})

test("cutPhrase takes the phrase and its seam, and changes nothing else", () => {
  const cut = (text: string, phrase: string) => cutPhrase(text, locatePhrase(text, phrase)!)
  assert.equal(cut("every Monday at 9am triage new issues", "every Monday at 9am"), "triage new issues")
  assert.equal(cut("triage new issues every Monday at 9am", "every Monday at 9am"), "triage new issues")
  assert.equal(cut("Every Friday at 4pm, write a summary of what shipped this week.", "Every Friday at 4pm"), "write a summary of what shipped this week.")
  assert.equal(cut("Mondays 9am: update the roadmap doc", "Mondays 9am"), "update the roadmap doc")
  assert.equal(cut("Check for new CVEs every morning at 8.", "every morning at 8"), "Check for new CVEs.")
  assert.equal(cut("triage — every Monday at 9am — the inbox", "every Monday at 9am"), "triage the inbox")
  assert.equal(cut("Ping me every morning at 9am. Keep it short", "every morning at 9am"), "Ping me. Keep it short")
  assert.equal(cut("every Monday at 9am", "every Monday at 9am"), "")
  // A phrase that was its own opening sentence leaves no stray full stop behind it.
  assert.equal(cut("Every Monday at 9am. Post the digest.", "Every Monday at 9am"), "Post the digest.")
  assert.equal(cut("Every Monday at 9am... post the digest", "Every Monday at 9am"), "post the digest")
  assert.equal(cut("every Monday at 9am .gitignore audit", "every Monday at 9am"), ".gitignore audit")
  // Its own whitespace and case are kept: only the seam is tidied.
  assert.equal(cut("every Monday at 9am  Triage   NEW issues", "every Monday at 9am"), "Triage   NEW issues")
})

test("locatePhrase finds the occurrence nearest the old one, exactly or ignoring case", () => {
  const text = "every day at 9am check CI, and note every day at 9am in the log"
  assert.deepEqual(locatePhrase(text, "every day at 9am"), { start: 0, end: 16 })
  assert.deepEqual(locatePhrase(text, "every day at 9am", 40), { start: 36, end: 52 })
  assert.deepEqual(locatePhrase("Every Day At 9am check CI", "every day at 9am"), { start: 0, end: 16 })
  assert.deepEqual(locatePhrase("check CI  every day at 9am ", " every day at 9am "), { start: 10, end: 26 })
  assert.equal(locatePhrase("check CI", "every day"), undefined)
  assert.equal(locatePhrase("check CI", "   "), undefined)
})

test("isScheduleOffer: recurrences at an edge; cues and ambiguous words at the open edge only", () => {
  const offer = (text: string) => isScheduleOffer(read(text, "edges"))
  assert.equal(offer("every Monday at 9am triage"), true)
  assert.equal(offer("triage every Monday at 9am"), true)
  assert.equal(offer("twice a week check deps"), true)
  assert.equal(offer("check deps twice a week"), false)
  assert.equal(offer("quarterly, review access"), true)
  assert.equal(offer("every 5 minutes check the deploy"), false)
  assert.equal(isScheduleOffer(read("tomorrow at 8 run the migration", "anywhere")), false)
  assert.equal(isScheduleOffer({ kind: "none" }), false)
})

test("scheduleWindows: the opening and closing sentences, 240 characters at most", () => {
  const text = `every Monday at 9am triage. ${"x ".repeat(300)}. post it every Friday at 5pm.`
  const windows = scheduleWindows(text, [])
  assert.equal(windows.length, 2)
  assert.deepEqual(windows[0], { start: 0, end: 26 })
  assert.equal(text.slice(windows[1]!.start, windows[1]!.end), "post it every Friday at 5pm")
  const long = `${"word ".repeat(100)}every Monday at 9am`
  for (const w of scheduleWindows(long, [])) assert.ok(w.end - w.start <= 240)
  assert.deepEqual(scheduleWindows("   ", []), [])
  assert.deepEqual(scheduleWindows("one sentence", []), [{ start: 0, end: 12 }])
})

// ---- the break-it battery (fix round 1, 2026-10-06) --------------------------------------------------------------
// An adversarial pass over the grammar (/tmp/live-grammar-break-1, nub scripts over the real readSchedulePhrase)
// found readings that were EXACT and wrong — the one failure the grammar exists to rule out — and offers on
// text that is not a request for a schedule. Each finding is pinned here as the property it broke, in both
// scopes the prompt box reads with.

const BOTH: Scope[] = ["edges", "anywhere"]
const hourOf = (r: PhraseReading) => (r.kind === "exact" ? /BYHOUR=([\d,]+)/.exec(r.rrule)?.[1] : undefined)

test("break: a clock said at night is not read in the afternoon, and never silently", () => {
  for (const tod of ["every night", "nightly", "each night", "every evening", "every day", "every weekday"]) {
    for (const clock of ["at 1", "at 2", "at 3", "at 4", "at 5", "at 12", "at 12:30", "at 1:30", "at 2 at night"]) {
      const text = `${tod} ${clock} back up the db`
      for (const scope of BOTH) {
        const r = read(text, scope)
        if (r.kind !== "exact") continue
        const night = /night|evening/.test(text)
        const hours = hourOf(r)!.split(",").map(Number)
        const guessed = r.assumed.some((a) => a.part === "meridiem")
        // A night or an evening is never read as the afternoon (noon to 5pm) unless the guess is SAID. "every
        // evening at 5" is 5pm: an evening can start there; a night's 5 is 5am.
        if (night) assert.ok(guessed || hours.every((h) => h < 12 || h >= 17), `${scope}: ${text} → ${summarizeReading(text, r)}`)
      }
    }
  }
  const at = (text: string, scope: Scope = "edges") => {
    const r = read(text, scope)
    assert.ok(r.kind === "exact", `${text}: ${summarizeReading(text, r)}`)
    return r
  }
  assert.match(at("every night at 2 back up the db").rrule, /;BYHOUR=2;BYMINUTE=0$/)
  assert.match(at("nightly at 1 back up the db").rrule, /;BYHOUR=1;BYMINUTE=0$/)
  assert.match(at("every night at 12 back up the db").rrule, /;BYHOUR=0;BYMINUTE=0$/)
  assert.match(at("every night at 12:30 back up the db").rrule, /;BYHOUR=0;BYMINUTE=30$/)
  assert.match(at("every night at 10 and 2 back up").rrule, /;BYHOUR=2,22;BYMINUTE=0$/)
  assert.match(at("every day at 2 at night back up the db").rrule, /;BYHOUR=2;BYMINUTE=0$/)
  assert.match(at("back up the db every night at 2").rrule, /;BYHOUR=2;BYMINUTE=0$/)
  assert.match(at("every night at 11 back up the db").rrule, /;BYHOUR=23;BYMINUTE=0$/)
  assert.match(at("every evening at 6 summarize the day").rrule, /;BYHOUR=18;BYMINUTE=0$/)
  assert.match(at("every morning at 8 check CI").rrule, /;BYHOUR=8;BYMINUTE=0$/)
  // A night that runs past midnight belongs to the NEXT day: Monday night at 2 is Tuesday at 2am to most and
  // Monday at 2am to some. The grammar does not guess which.
  for (const text of ["Monday nights at 2 back up the db", "every Friday night at 1 deploy", "every Sunday evening at 12 rotate the logs"]) {
    for (const scope of BOTH) assert.notEqual(read(text, scope).kind, "exact", `${scope}: ${text}`)
  }
  // "tonight at 2" is the coming night's 2am, tomorrow's date.
  const tonight = at("tonight at 2 back up the db", "anywhere")
  assert.equal(tonight.dtstart, "2026-10-06T02:00")
})

test("break: an ordinal before a unit is not a day of the month", () => {
  for (const text of ["every 2nd week review billing", "every 2nd hour check CI", "every 2nd year renew the certs", "every 2nd weekend clean up", "every 3rd month review billing"]) {
    for (const scope of BOTH) {
      const r = read(text, scope)
      assert.ok(!(r.kind === "exact" && /BYMONTHDAY/.test(r.rrule)), `${scope}: ${text} → ${summarizeReading(text, r)}`)
      assert.notEqual(r.kind, "exact", `${scope}: ${text} → ${summarizeReading(text, r)}`)
    }
  }
})

test("break: 'and a half' and 'or so' are part of the interval, never the task", () => {
  for (const text of ["every hour and a half check CI", "every day and a half check CI", "every week and a half check CI", "every hour and a quarter check CI", "every hour or so check CI"]) {
    for (const scope of BOTH) {
      const r = read(text, scope)
      assert.equal(r.kind, "cue", `${scope}: ${text} → ${summarizeReading(text, r)}`)
    }
  }
})

test("break: a named zone is a cue, wherever it is spelled", () => {
  for (const zone of ["Berlin time", "London time", "in London", "(London)", "Tokyo time", "Paris time", "Sydney time", "India time", "SF time", "Europe/Berlin", "America/Los_Angeles", "+0200", "Z", "(UTC)", "UTC+2", "my time"]) {
    const text = `every Monday at 9am ${zone} triage new issues`
    for (const scope of BOTH) {
      const r = read(text, scope)
      assert.ok(r.kind === "cue" && r.why === "zone", `${scope}: ${text} → ${summarizeReading(text, r)}`)
    }
  }
  // At the end of the task too, where it is not touching the phrase.
  for (const text of ["every Monday at 9am triage new issues, Europe/Berlin", "every Monday at 9am triage new issues (Berlin time)"]) {
    for (const scope of BOTH) assert.notEqual(read(text, scope).kind, "exact", `${scope}: ${text}`)
  }
})

test("break: no silent prefix for the qualifiers the property test did not list", () => {
  const phrases = ["every day at 9am", "every Monday at 9am", "every weekday at 9am", "every 2 hours", "nightly", "every morning"]
  const task = "triage new issues"
  const failures: string[] = []
  for (const ph of phrases) {
    for (const q of BROAD_QUALIFIERS) {
      const variants = [`${ph} ${q} ${task}`, `${ph}, ${q}, ${task}`, `${task} ${ph} ${q}`, `${q}, ${ph} ${task}`, `${task}, ${ph}, ${q}`]
      for (const text of variants) {
        const at = text.indexOf(q)
        for (const scope of BOTH) {
          const r = read(text, scope)
          if (leftOutside(r, { start: at, end: at + q.length })) failures.push(`${scope}: ${JSON.stringify(text)} → ${summarizeReading(text, r)}`)
        }
      }
      // The phrase alone in the field, qualified after.
      const field = `${ph} ${q}`
      const r = read(field, "field")
      if (leftOutside(r, { start: ph.length + 1, end: field.length })) failures.push(`field: ${JSON.stringify(field)} → ${summarizeReading(field, r)}`)
    }
  }
  // And right after every positive the box offers.
  for (const { text, span } of positives()) {
    for (const q of BROAD_QUALIFIERS) {
      const inserted = `${text.slice(0, span.end)} ${q}${text.slice(span.end)}`
      for (const scope of BOTH) {
        const r = read(inserted, scope)
        if (leftOutside(r, { start: span.end + 1, end: span.end + 1 + q.length })) failures.push(`${scope}: ${JSON.stringify(inserted)} → ${summarizeReading(inserted, r)}`)
      }
    }
  }
  assert.deepEqual(failures.slice(0, 40), [], `${failures.length} silent prefixes`)
})

test("break: a day the human excluded never joins the list", () => {
  for (const [text, scopes] of [
    ["every Monday, Friday is off-limits, triage new issues", BOTH],
    ["on Mondays, Fridays are frozen, triage new issues", BOTH],
    ["never on Fridays, every Monday at 9am triage new issues", ["anywhere"]],
    ["not on Fridays, every Monday at 9am triage new issues", ["anywhere"]],
    ["every Monday at 9am, Wednesdays too", BOTH],
    ["every Monday at 9am, not Fridays, triage new issues", BOTH],
  ] as const) {
    for (const scope of scopes) {
      const r = read(text, scope)
      assert.ok(!(r.kind === "exact" && /FR|WE/.test(r.rrule)), `${scope}: ${text} → ${summarizeReading(text, r)}`)
      assert.notEqual(r.kind, "exact", `${scope}: ${text} → ${summarizeReading(text, r)}`)
    }
  }
})

test("break: a clock the grammar cannot parse is never replaced by an assumed 9am", () => {
  for (const text of [
    "every Monday at 9p triage new issues",
    "every day at 1430 check the queue",
    "every weekday at 0900 triage",
    "every Monday at 9h30 triage",
    "every Monday at 14h triage",
    "every Monday at about 9 triage",
    "every Monday 9 triage",
    "every Monday at ９am triage",
    "every Monday at nine triage",
  ]) {
    for (const scope of BOTH) {
      const r = read(text, scope)
      assert.notEqual(r.kind, "exact", `${scope}: ${text} → ${summarizeReading(text, r)}`)
    }
  }
})

test("break: a weekday or month abbreviation's dot does not end the sentence", () => {
  for (const [text, rrule] of [
    ["every Wed. at 3 review billing", "FREQ=WEEKLY;BYDAY=WE;BYHOUR=15;BYMINUTE=0"],
    ["every Thurs. at 3pm review billing", "FREQ=WEEKLY;BYDAY=TH;BYHOUR=15;BYMINUTE=0"],
    ["every Mon. at 4:30pm triage new issues", "FREQ=WEEKLY;BYDAY=MO;BYHOUR=16;BYMINUTE=30"],
    ["every Sat. at 10am clean up branches", "FREQ=WEEKLY;BYDAY=SA;BYHOUR=10;BYMINUTE=0"],
    ["every Fri. 5pm write the changelog", "FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0"],
    ["every Tues. and Thurs. at 4pm triage", "FREQ=WEEKLY;BYDAY=TU,TH;BYHOUR=16;BYMINUTE=0"],
    ["every Jan. 15 at 9am renew the certs", "FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=15;BYHOUR=9;BYMINUTE=0"],
  ] as const) {
    for (const scope of BOTH) {
      const r = read(text, scope)
      assert.ok(r.kind === "exact" && r.rrule === rrule, `${scope}: ${text} → ${summarizeReading(text, r)}`)
      assert.equal(isScheduleOffer(read(text, "edges")), true, text)
    }
  }
  const wed = read("every Wed. at 3 review billing", "edges")
  assert.ok(wed.kind === "exact")
  assert.equal(cutPhrase("every Wed. at 3 review billing", wed.span), "review billing", "the saved prompt keeps no stray dot")
})

test("break: a clock schedule is not an event", () => {
  for (const text of [
    "every midnight rotate the logs",
    "every noon post the lunch menu",
    "every M/W/F at 9am triage",
    "every Tu/Th at 3 sync",
    "every twenty-four hours check CI",
    "every sixty minutes check CI",
    "every wkday at 9 triage",
    "every odd week on Monday triage",
    "every New Year's Day at 9am renew certs",
    "every lunchtime check the queue",
  ]) {
    assert.notEqual(read(text, "anywhere").kind, "event", text)
  }
  // Still events: a set of things, not a calendar.
  for (const text of ["each PR needs a changelog entry", "every file in src needs a header", "every time the build fails, fix it"]) {
    assert.equal(read(text, "anywhere").kind, "event", text)
  }
})

test("break: a recurrence that opens a bug report or an explanation is not offered", () => {
  for (const text of [
    "Every night the backup job fails with ENOSPC, fix it",
    "Every day at 3am the cron job OOMs — find out why",
    "Every hour the memory climbs by 100MB, find the leak",
    "Every Monday our CI is slow because of cache eviction, look into it",
    "Every 15 minutes the health check flaps, find out why",
    "Weekly, we get a spike of 500s on the billing endpoint; look at the logs",
    "Every Monday at 9am is when the digest goes out, add that to the docs",
  ]) {
    assert.equal(isScheduleOffer(read(text, "edges")), false, `${text}: ${line(text, "edges")}`)
  }
  // An imperative after the phrase is still a request.
  for (const text of ["every Monday at 9am triage new issues", "Every weekday at 9, post a standup summary", "every night clean up stale branches"]) {
    assert.equal(isScheduleOffer(read(text, "edges")), true, text)
  }
})

test("break: a negation or a statement at the close edge is not a schedule to create", () => {
  for (const text of [
    "don't deploy on Fridays",
    "never merge on Fridays",
    "no deploys on Fridays",
    "we don't release on weekends",
    "stop pinging me every morning",
    "don't email me daily",
    "turn off the digest that goes out every Monday",
    "the bot should not post every Monday at 9am",
    "Never: every Monday at 9am",
    "the digest email is sent every Monday at 9am",
    "the meeting is every Monday at 9am",
    "I'm out Fridays",
    "she's off Mondays",
    "the office is closed on weekends",
    "set the dependabot interval to weekly",
  ]) {
    assert.equal(isScheduleOffer(read(text, "edges")), false, `${text}: ${line(text, "edges")}`)
  }
  for (const text of ["triage new issues every Monday at 9am", "run the e2e suite against staging nightly", "check that the build is green every morning"]) {
    assert.equal(isScheduleOffer(read(text, "edges")), true, text)
  }
})

test("break: code, paths and identifiers are not prose", () => {
  for (const text of [
    "see packages/web/src/daily",
    "set FREQ=DAILY",
    "set interval=weekly",
    "the env var REPORT_WEEKLY should be daily",
    "rename variable everyday to everyDay",
    "fix this config\n    schedule: every Monday at 9am",
    "the label should read: every Monday at 9am",
  ]) {
    assert.equal(isScheduleOffer(read(text, "edges")), false, `${text}: ${line(text, "edges")}`)
  }
})

test("break: a single 'on the Nth' at the close edge is a date, not a monthly rule", () => {
  for (const text of ["ship the release on the 15th", "merge the release branch on the 1st", "post the changelog on the 15th"]) {
    assert.equal(isScheduleOffer(read(text, "edges")), false, `${text}: ${line(text, "edges")}`)
  }
  assert.equal(isScheduleOffer(read("review billing on the 1st and 15th", "edges")), true)
  assert.equal(isScheduleOffer(read("on the 15th review billing", "edges")), true)
})

test("break: readingsConsistent holds an assumed day and time to the core's frequency", () => {
  const week = read("every week unless it's a holiday post the digest", "edges")
  assert.ok(week.kind === "cue" && week.core, summarizeReading("every week unless it's a holiday post the digest", week))
  const base = { rrule: week.core.rrule, dtstart: week.core.dtstart, tz: NY, assumed: week.core.assumed }
  // "every week" says once a week: an hourly, a daily or a twice-weekly reading is not it.
  for (const rrule of ["FREQ=HOURLY;BYMINUTE=0", "FREQ=DAILY;BYHOUR=9;BYMINUTE=0", "FREQ=WEEKLY;BYDAY=MO,TH;BYHOUR=9;BYMINUTE=0"]) {
    assert.equal(readingsConsistent(base, { rrule, dtstart: "2026-10-06T09:00", tz: NY }, SPEC_NOW), false, rrule)
  }
  // Any one day of the week at any time is: the day and the time were assumed.
  assert.equal(readingsConsistent(base, { rrule: "FREQ=WEEKLY;BYDAY=TU;BYHOUR=15;BYMINUTE=0", dtstart: "2026-10-06T15:00", tz: NY }, SPEC_NOW), true)
  assert.equal(readingsConsistent(base, { rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0", dtstart: "2026-10-12T09:00", tz: NY }, SPEC_NOW), true)
  // Every other week only removes runs.
  assert.equal(readingsConsistent(base, { rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=WE;BYHOUR=9;BYMINUTE=0", dtstart: "2026-10-07T09:00", tz: NY }, SPEC_NOW), true)
  // An assumed time alone still means one run on each of the core's days.
  const monday = read("every Monday unless it's a holiday post the digest", "edges")
  assert.ok(monday.kind === "cue" && monday.core)
  const mondayBase = { rrule: monday.core.rrule, dtstart: monday.core.dtstart, tz: NY, assumed: monday.core.assumed }
  assert.equal(readingsConsistent(mondayBase, { rrule: "FREQ=HOURLY;BYDAY=MO;BYMINUTE=0", dtstart: "2026-10-12T00:00", tz: NY }, SPEC_NOW), false)
  // A monthly core with an assumed day: one run a month.
  const month = read("every month unless it's a holiday post the digest", "edges")
  assert.ok(month.kind === "cue" && month.core)
  const monthBase = { rrule: month.core.rrule, dtstart: month.core.dtstart, tz: NY, assumed: month.core.assumed }
  assert.equal(readingsConsistent(monthBase, { rrule: "FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=9;BYMINUTE=0", dtstart: "2026-10-15T09:00", tz: NY }, SPEC_NOW), true)
  assert.equal(readingsConsistent(monthBase, { rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0", dtstart: "2026-10-12T09:00", tz: NY }, SPEC_NOW), false)
})

// ---- the break-it battery, round 2 (fix round 2, 2026-10-06) ------------------------------------------------------
// A second adversarial pass (/tmp/live-grammar-break-2) found exact readings that were still silently wrong, each
// a NEW member of a class round 1 had closed with a list. Each finding is pinned here as the class it broke, in
// both scopes the box reads with; a cue at the open edge is still offered, so the cost of being wrong this way
// is one model read after Tab, never a run at the wrong time.

/** Not exact in either scope: the reading is a cue (or dark), never one the box could create as it stands. */
function neverExact(texts: readonly string[], scopes: readonly Scope[] = BOTH): string[] {
  const out: string[] = []
  for (const text of texts) for (const scope of scopes) {
    const r = read(text, scope)
    if (r.kind === "exact") out.push(`${scope}: ${JSON.stringify(text)} → ${summarizeReading(text, r)}`)
  }
  return out
}
/** A cue's core is shown in the ledge and checked against the model's answer (§4.3): one that the unread words
 *  ADD runs to, or move the clock of, would show the wrong next run and turn a faithful answer into the disagree
 *  state (Create disabled). Such a cue carries no core. */
function coreless(texts: readonly string[]): string[] {
  const out: string[] = []
  for (const text of texts) for (const scope of BOTH) {
    const r = read(text, scope)
    if (r.kind === "cue" && r.core) out.push(`${scope}: ${JSON.stringify(text)} → ${summarizeReading(text, r)}`)
  }
  return out
}

test("break 2: an hourly rule's minute it cannot place is never :00, and a second minute is a compound", () => {
  const texts = [
    "every hour at half past check CI",
    "every hour at the half hour check CI",
    "every hour at quarter past check CI",
    "every hour at quarter to check CI",
    "every hour at xx:30 check CI",
    "every hour at HH:30 check CI",
    "hourly at :05 and :35 check CI",
    "every hour at :15 and :45 check CI",
    "every hour at :15, :45 check CI",
    "every hour at :00 and :30 check CI",
    "every 30 minutes offset by 10 check CI",
  ]
  assert.deepEqual(neverExact(texts), [])
  // The core would echo `every hour · next 3pm` and refuse the model's :30: no core.
  assert.deepEqual(coreless(texts.filter((t) => !/offset/.test(t))), [])
  // A minute it CAN place still reads.
  const ok = read("every hour at :30 check CI", "edges")
  assert.ok(ok.kind === "exact" && ok.rrule === "FREQ=HOURLY;BYMINUTE=30", summarizeReading("every hour at :30 check CI", ok))
})

test("break 2: a count or a fraction glued to an adverb is not one run per period", () => {
  const close = [
    "check the queue twice daily",
    "check the queue two times daily",
    "check the queue 3x daily",
    "post the digest twice weekly",
    "post the digest twice monthly",
    "post the digest three times weekly",
    "post the digest 3 times weekly",
    "back up the db 4x nightly",
    "check CI twice hourly",
  ]
  const mode = ["twice daily, check the queue", "post the digest semi-weekly", "post the digest twice-monthly", "check CI half-hourly", "check CI bi-hourly", "post the digest every week, twice"]
  assert.deepEqual(neverExact([...close, ...mode]), [])
  for (const text of close) assert.equal(isScheduleOffer(read(text, "edges")), false, `${text}: ${line(text, "edges")}`)
  // Like "twice a day": a vague cue, which the model reads after Tab.
  for (const text of ["twice daily, check the queue", "twice weekly sync the roadmap"]) {
    const r = read(text, "edges")
    assert.ok(r.kind === "cue" && r.why === "vague" && isScheduleOffer(r), `${text}: ${summarizeReading(text, r)}`)
  }
})

test("break 2: an adjective that limits which days is not every one of them", () => {
  const close = [
    "sync with design on alternate Thursdays",
    "sync with design on alternating Thursdays",
    "deploy on odd Fridays",
    "deploy on even Fridays",
    "run the full suite on odd weekdays",
    "rotate the on-call on alternate Mondays at 10am",
    "check CI on most weekdays at 9am",
    "check CI on some Mondays at 9am",
    "check CI on certain weekdays at 9am",
    "check CI on select Fridays at 4pm",
    "check CI on the first two Mondays at 9am",
    "check CI on the remaining Fridays at 4pm",
  ]
  assert.deepEqual(neverExact([...close, "alternate Mondays at 9am check CI", "most weekdays at 9am check CI"]), [])
  for (const text of close) assert.equal(isScheduleOffer(read(text, "edges")), false, `${text}: ${line(text, "edges")}`)
})

test("break 2: an abbreviated month, weekday or span is a calendar word, wherever it sits", () => {
  assert.deepEqual(
    neverExact([
      "every weekday at 9am Oct 12-30 triage new issues",
      "every weekday at 9am Oct 12 to Oct 30 triage new issues",
      "every Monday at 9am Sep–Dec triage new issues",
      "every Monday at 9am Nov-Jan triage new issues",
      "every day at 9am Dec 1-24 post the advent puzzle",
      "every day at 9am to Dec 24 post the advent puzzle",
      "every day at 9am triage new issues (Mon–Fri only)",
      "every day at 9am triage new issues, Mon-Fri only",
      "every day at 9am triage new issues, no Sat/Sun",
      "every day at 9am triage new issues — Sat/Sun off",
      "every day at 9am triage new issues; not Sat",
      "every day at 9am triage new issues (Oct–Dec)",
      "every day at 9am triage new issues, H2 only",
      "every day at 9am triage new issues through EOQ",
      "every day at 9am triage new issues til EOQ",
      "every day at 9am triage new issues — 2 weeks",
      "every day at 9am triage new issues for 2 wks",
      "every day at 9am triage new issues for a fortnight",
      "every day at 9am triage new issues x14",
      "every day at 9am triage new issues, 14 runs max",
    ]),
    [],
  )
  // The words that only LOOK like it stay the task's.
  for (const text of ["every Monday at 9am build for x86", "every Monday at 9am ask Jan for the report", "every morning check what we sat on", "every Monday at 9am review the H1 copy"]) {
    assert.equal(read(text, "edges").kind, "exact", `${text}: ${line(text, "edges")}`)
  }
})

test("break 2: no silent prefix for the round-2 qualifiers, by class — five placements, both scopes, the field", () => {
  const phrases = ["every day at 9am", "every Monday at 9am", "every weekday at 9am", "every 2 hours", "nightly", "every morning"]
  const task = "triage new issues"
  const failures: string[] = []
  for (const [cls, qs] of [...Object.entries(ROUND2_QUALIFIERS), ...Object.entries(ROUND2_HELD_OUT).map(([c, q]) => [`held-out ${c}`, q] as const)]) {
    for (const ph of phrases) {
      for (const q of qs) {
        for (const text of [`${ph} ${q} ${task}`, `${ph}, ${q}, ${task}`, `${task} ${ph} ${q}`, `${q}, ${ph} ${task}`, `${task}, ${ph}, ${q}`]) {
          const at = text.indexOf(q)
          for (const scope of BOTH) {
            const r = read(text, scope)
            if (leftOutside(r, { start: at, end: at + q.length })) failures.push(`${cls} ${scope}: ${JSON.stringify(text)} → ${summarizeReading(text, r)}`)
          }
        }
        const field = `${ph} ${q}`
        const r = read(field, "field")
        if (leftOutside(r, { start: ph.length + 1, end: field.length })) failures.push(`${cls} field: ${JSON.stringify(field)} → ${summarizeReading(field, r)}`)
      }
    }
  }
  for (const text of SECOND_SENTENCES) for (const scope of BOTH) {
    const r = read(text, scope)
    if (r.kind === "exact") failures.push(`second sentence ${scope}: ${JSON.stringify(text)} → ${summarizeReading(text, r)}`)
  }
  assert.deepEqual(failures.slice(0, 40), [], `${failures.length} silent prefixes`)
})

test("break 2: a zone said after the clock is a zone cue, whatever its spelling", () => {
  const zones = [
    "NZT", "AET", "SAST", "BRT", "ART", "WIB", "AST", "NST", "PHT", "ICT", "EAT", "WAT", "CAT", "IDT", "PST8PDT",
    "Kyiv", "Warsaw", "Oslo", "Helsinki", "Austin", "Boston", "Portland", "-0500",
  ]
  const failures: string[] = []
  for (const zone of zones) {
    for (const [text, scopes] of [
      [`every Monday at 9am ${zone} triage new issues`, BOTH],
      [`triage new issues every Monday at 9am ${zone}`, ["anywhere"]],
    ] as const) {
      for (const scope of scopes) {
        const r = read(text, scope)
        if (!(r.kind === "cue" && r.why === "zone")) failures.push(`${scope}: ${JSON.stringify(text)} → ${summarizeReading(text, r)}`)
      }
    }
  }
  assert.deepEqual(failures, [])
  // No core: the interpreter writes "9am NZT" as this box's wall clock (Sunday 4pm here), which a Monday-9am
  // core could never hold, so a faithful answer would be the disagree state (§4.3).
  const nzt = read("every Monday at 9am NZT triage new issues", "anywhere")
  assert.ok(nzt.kind === "cue" && !nzt.core, summarizeReading("every Monday at 9am NZT triage new issues", nzt))
  assert.equal(readingsConsistent({ rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0", dtstart: "2026-10-12T09:00", tz: NY, assumed: [] }, { rrule: "FREQ=WEEKLY;BYDAY=SU;BYHOUR=16;BYMINUTE=0", dtstart: "2026-10-11T16:00", tz: NY }, SPEC_NOW), false, "why: the core would refuse the right answer")
  for (const text of ["every Monday at 9am Berlin time triage new issues", "every Monday at 9am -0500 triage new issues", "Berlin time, every Monday at 9am triage new issues"]) {
    const r = read(text, "anywhere")
    assert.ok(r.kind === "cue" && r.why === "zone" && !r.core, `${text}: ${summarizeReading(text, r)}`)
  }
  // A lowercase word that only spells an abbreviation is the task's verb.
  for (const text of ["every morning cat the error log and summarize it", "every Monday at 9am eat the backlog"]) {
    assert.equal(read(text, "edges").kind, "exact", `${text}: ${line(text, "edges")}`)
  }
})

test("break 2: a spelled clock or a second clock is never dropped, and a guess never swallows a stated hour", () => {
  const texts = [
    "every weekday at quarter to 5 write the summary",
    "every day at half past nine check the queue",
    "every weekday at quarter past 9 triage new issues",
    "every day at oh nine hundred check",
    "every day at 9 thirty check the queue",
    "every day at noon-thirty post lunch",
    "every weekday at 9 to 5 monitor the queue",
    "every weekday at 9 and again at 5 check",
    "every Monday at 9am then at 5 triage",
    "every Monday at 9am and later at 5 triage",
    "every day at lunch post the menu",
    "every Monday at standup, read out the open incidents",
  ]
  assert.deepEqual(neverExact(texts), [])
  // A second clock or a moved minute over a STATED clock: the core would show one run a day at the wrong time.
  assert.deepEqual(coreless(["every day at 9 thirty check the queue", "every weekday at 9 to 5 monitor the queue", "every weekday at 9 and again at 5 check", "every Monday at 9am then at 5 triage", "every Monday at 9am and later at 5 triage"]), [])
  // "6 and 18": the 18 says which 6 the human meant — both runs, read.
  for (const scope of BOTH) {
    const r = read("every day at 6 and 18 check", scope)
    assert.ok(r.kind !== "exact" || /;BYHOUR=6,18;/.test(r.rrule), `${scope}: ${summarizeReading("every day at 6 and 18 check", r)}`)
  }
})

// ---- the break-it battery, round 3 (fix round 3, 2026-10-06) ------------------------------------------------------
// A third pass (journal wf_d162d55f-7fd) found nine classes of exact-and-wrong, most of them a word of time AWAY
// from the phrase — a zone at the end, a bound later in the sentence, a count before it — which no list of the
// words beside a phrase could reach. Round 3 adds the temporal residue (`schedule-phrase.ts`): an exact reading
// is a cue while a word of time is left in the text it would save as the task. These pin the classes, the core
// rule, what is exempt, and the round's minor findings. The grammar was written first and these after; each
// fails against the v3 grammar (git show 5447496d:packages/shared/src/schedule-phrase.ts) except where a comment
// says it pins what v3 already did.

test("break 3: no round-3 major reads exact in either scope, but the two the spelled ordinals now read right", () => {
  const wrong: string[] = []
  let reads = 0
  for (const [cls, texts] of Object.entries(ROUND3_MAJORS)) {
    for (const text of texts) {
      for (const scope of BOTH) {
        reads++
        const r = read(text, scope)
        if (r.kind === "exact" && ROUND3_READ[text] !== r.rrule) wrong.push(`${cls} ${scope}: ${JSON.stringify(text)} → ${summarizeReading(text, r)}`)
      }
    }
  }
  assert.equal(reads, 124)
  assert.deepEqual(wrong, [])
  for (const [text, rrule] of Object.entries(ROUND3_READ)) {
    for (const scope of BOTH) {
      const r = read(text, scope)
      assert.ok(r.kind === "exact" && r.rrule === rrule, `${scope}: ${summarizeReading(text, r)}`)
    }
  }
})

test("break 3: a cue's core never refuses the faithful reading of the days it left out (§4.3)", () => {
  for (const { text, rrule, dtstart } of ROUND3_CORES) {
    for (const scope of BOTH) {
      const r = read(text, scope)
      assert.ok(r.kind !== "exact" || r.rrule === rrule, `${scope}: ${text} → ${summarizeReading(text, r)}`)
      if (r.kind === "cue" && r.core) assert.ok(readingsConsistent({ ...r.core, tz: NY }, { rrule, dtstart, tz: NY, span: r.span }, SPEC_NOW), `${scope}: ${text} → ${summarizeReading(text, r)}`)
    }
  }
})

test("break 3: a word of time outside the phrase makes it a cue, with its core only when that word can only narrow it", () => {
  for (const [text, want] of [
    // A bound, a period, a condition, an exclusion: the faithful reading is some of the core's runs.
    ["every Monday at 9am triage new issues for the next two sprints", "cue open leftover «for the next two sprints» core FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00"],
    ["every day at 9am check the canary this week only", "cue open leftover «this week» core FREQ=DAILY;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00"],
    ["every Monday at 9am triage new issues next quarter", "cue open leftover «next quarter» core FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00"],
    ["every Monday at 9am triage new issues while the freeze lasts", "cue open condition «while» core FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00"],
    // One time of day over a time the core assumed, one weekday over a day it assumed: §4.3 does not compare
    // an assumed part, so the core cannot contradict the model's answer.
    ["every morning summarize overnight Sentry errors", "cue open leftover «overnight» core FREQ=DAILY;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00"],
    ["every day check the queue around 2", "cue open leftover «2» core FREQ=DAILY;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00"],
    // May add a run or move one: no core.
    ["every Monday at 9am triage new issues (PT)", "cue open zone «PT»"],
    ["every hour check the canary today", "cue open leftover «today»"],
    ["every Monday at 9am check the canary, and recheck that evening", "cue open leftover «that evening»"],
    ["every day at 9am check the queue; rerun it at 5pm", "cue open leftover «5pm»"],
    // "Overnight" crosses into the next day, so over a core with days it can move one.
    ["every Monday morning summarize overnight Sentry errors", "cue open leftover «overnight»"],
  ] as const) {
    for (const scope of BOTH) assert.equal(line(text, scope), want, `${scope}: ${text}`)
  }
  // The same test holds over a core an older check keeps (v3 already read this one so): a weekday over the
  // day "every week" assumed.
  assert.equal(line("every week write the report, due Friday", "edges"), "cue open leftover «Friday» core FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00")
})

test("break 3: unread words far from the phrase stay where they are, and the cut keeps the task", () => {
  for (const [text, phrase, unread, cut] of [
    ["every Monday at 9am triage new issues for the next two sprints", "every Monday at 9am", "for the next two sprints", "triage new issues for the next two sprints"],
    ["every Monday at 9am triage new issues (PT)", "every Monday at 9am", "PT", "triage new issues (PT)"],
    ["Use UTC for this one: check the queue every Monday at 9am", "every Monday at 9am", "UTC", "Use UTC for this one: check the queue"],
  ] as const) {
    for (const scope of BOTH) {
      const r = read(text, scope)
      assert.ok(r.kind === "cue", `${scope}: ${summarizeReading(text, r)}`)
      assert.equal(text.slice(r.span.start, r.span.end), phrase, `${scope}: ${text}`)
      assert.equal(text.slice(r.unread.start, r.unread.end), unread, `${scope}: ${text}`)
      assert.equal(cutPhrase(text, r.span), cut, `${scope}: ${text}`)
    }
  }
  // Touching the phrase, the unread words join its span, as they always did.
  const near = read("check the queue twice every Monday", "edges")
  assert.ok(near.kind === "cue")
  assert.equal("check the queue twice every Monday".slice(near.span.start, near.span.end), "twice every Monday")
})

test("break 3: a word of time that names a thing, is someone's, or is code is the task's, and the reading stays exact", () => {
  // Each read exact under v3 as well; these pin what the residue must NOT take.
  for (const text of [
    "every Monday at 9am post the weekly digest",
    "every Friday at 4pm book a 30-minute retro",
    "every morning check the nightly build",
    "every morning summarize the overnight Sentry errors",
    "Every weekday at 9, post a standup summary of yesterday's merged PRs in #eng",
    "every day at 9am summarize the PRs from the weekend's on-call",
    "every Monday at 9am update docs/weekly-report.md",
    "every day at 9am run cron_daily",
    "every day at 9am bump $EOD_TIMEOUT",
    "every day at 9am set REPORT_DAILY=true",
    "every Monday at 9am post “weekly wins” to Slack",
    "every Monday at 9am triage issues labeled `today`",
  ]) {
    for (const scope of BOTH) assert.equal(read(text, scope).kind, "exact", `${scope}: ${line(text, scope)}`)
  }
  // A file's name is code for the older checks too: v3 read "fix daily.yml" as a second frequency.
  for (const text of ["every day at 9am fix daily.yml", "every Monday at 9am rotate logs/weekly"]) {
    for (const scope of BOTH) assert.equal(read(text, scope).kind, "exact", `${scope}: ${line(text, scope)}`)
  }
  // At the end of the text the noun is still being typed: no flicker to a cue and back.
  assert.equal(read("every Monday at 9am check the overnight", "edges").kind, "exact")
})

test("break 3: the residue's word walk finds exactly what its rules find, tried at every word", () => {
  const { rules, scan, masked } = SCHEDULE_RESIDUE_FOR_TESTS
  const all = rules.map((r) => ({ kind: r.kind, re: new RegExp(r.src, "y") }))
  // Every rule, in order, at every word start: what the walk would find if it tried them all.
  const reference = (text: string) => {
    const m = masked(text)
    const out: { start: number; end: number; kind: string }[] = []
    for (let i = 0; i < m.length; ) {
      let hit: { start: number; end: number; kind: string } | undefined
      if (i === 0 || !/[a-z0-9]/.test(m[i - 1]!)) {
        for (const { kind, re } of all) {
          re.lastIndex = i
          const mm = re.exec(m)
          if (mm && mm[0].length) {
            hit = { start: i, end: i + mm[0].length, kind }
            break
          }
        }
      }
      if (hit) out.push(hit)
      i = hit ? hit.end : i + 1
    }
    return out
  }
  const texts = new Set<string>()
  for (const c of [...CASES, ...PROBE_CORPUS, ...FIELD_CASES]) texts.add(c.text)
  for (const t of Object.values(ROUND3_MAJORS).flat()) texts.add(t)
  for (const q of [...Object.values(ROUND2_QUALIFIERS).flat(), ...Object.values(ROUND2_HELD_OUT).flat(), ...STRONG_QUALIFIERS, ...TOUCH_QUALIFIERS, ...BROAD_QUALIFIERS]) texts.add(`every Monday at 9am triage new issues ${q}`)
  let tokens = 0
  for (const [kind, words] of Object.entries(RESIDUE_WORDS)) {
    for (const w of words) {
      const text = `check the queue ${w} and report`
      texts.add(text)
      // Each is read as its own kind (the rules' order decides: "no earlier than" is a start, not an exclusion).
      assert.equal(scan(text)[0]?.kind, kind, `${kind}: ${JSON.stringify(w)} → ${JSON.stringify(scan(text))}`)
    }
  }
  // Lowercase, so the walk's capitalized words (a zone in capitals, "Sat", "May") never run: they have no
  // rule to compare with.
  for (const text of texts) {
    const lower = text.toLowerCase()
    const got = scan(lower)
    tokens += got.length
    assert.deepEqual(got, reference(lower), JSON.stringify(lower))
  }
  assert.ok(texts.size > 700 && tokens > 1400, `${texts.size} texts, ${tokens} words of time`)
})

test("break 3: a second clock that repeats one is a cue, never one run (F6)", () => {
  for (const text of ["every day at 7 and 7 check the queue", "every day at 9 and 9 check the queue", "every day at 6, 12 and 6 check the queue", "every day at 9am and 9am check the queue"]) {
    for (const scope of BOTH) {
      const r = read(text, scope)
      assert.ok(r.kind === "cue" && r.why === "vague" && !r.core, `${scope}: ${summarizeReading(text, r)}`)
    }
  }
  // A said meridiem settles the other: two runs, read (as v3 did).
  assert.equal(line("every day at 9 and 9pm check the queue", "edges"), "exact open «every day at 9 and 9pm» FREQ=DAILY;BYHOUR=9,21;BYMINUTE=0 @2026-10-05T21:00 meridiem:9am/9pm")
})

test("break 3: a spelled ordinal is a day of the month or a cue, never an event (F9)", () => {
  for (const [text, want] of [
    ["every fifteenth of the month, reconcile billing", "exact open «every fifteenth of the month» FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=9;BYMINUTE=0 @2026-10-15T09:00 time:9am"],
    ["every twentieth, reconcile billing", "exact open «every twentieth» FREQ=MONTHLY;BYMONTHDAY=20;BYHOUR=9;BYMINUTE=0 @2026-10-20T09:00 time:9am"],
    ["on the twenty-first of each month review billing", "exact open «on the twenty-first of each month» FREQ=MONTHLY;BYMONTHDAY=21;BYHOUR=9;BYMINUTE=0 @2026-10-21T09:00 time:9am"],
    ["every tenth day, rotate the keys", "cue open vague «every tenth day»"],
  ] as const) {
    for (const scope of BOTH) assert.equal(line(text, scope), want, `${scope}: ${text}`)
  }
})

test("break 3: a day the words name two ways is assumed, dimmed, and says which it took (F10, F11, F12)", () => {
  const dayOf = (r: PhraseReading) => (r.kind === "exact" ? r.assumed.find((a) => a.part === "day") : undefined)
  // "Next Tuesday" said on a Monday: tomorrow, or the Tuesday after.
  const next = read("next Tuesday at 10am run the migration", "anywhere")
  assert.equal(summarizeReading("next Tuesday at 10am run the migration", next), "exact open «next Tuesday at 10am» FREQ=DAILY;COUNT=1;BYHOUR=10;BYMINUTE=0 @2026-10-06T10:00 day:Tue Oct 6")
  assert.deepEqual(dayOf(next), { part: "day", shown: "Tue Oct 6", tip: "“Next Tuesday” reads as Tue Oct 6. Type “Oct 13” if you meant the one after.", shift: 7 })
  // "Next Monday" said on a Monday can only be the one a week out.
  assert.equal(dayOf(read("next Monday at 10am run the migration", "anywhere")), undefined)
  // As a bound or a start it is left unread: a cue, never one run tomorrow.
  for (const text of ["every day until next Tuesday check the canary", "every day starting next Tuesday check the canary"]) {
    for (const scope of BOTH) assert.equal(read(text, scope).kind, "cue", `${scope}: ${line(text, scope)}`)
  }
  // "Tonight" said after midnight is the night under way, not the next one 25 hours out.
  const late = Date.parse("2026-10-06T00:30:00-04:00")
  const tonight = read("tonight at 2 run the migration", "anywhere", late)
  assert.equal(summarizeReading("tonight at 2 run the migration", tonight), "exact open «tonight at 2» FREQ=DAILY;COUNT=1;BYHOUR=2;BYMINUTE=0 @2026-10-06T02:00 day:Tue Oct 6")
  assert.deepEqual(dayOf(tonight), { part: "day", shown: "Tue Oct 6", tip: "“Tonight” said after midnight reads as the night now under way: Tue Oct 6. Say “tomorrow night” for the next one.", shift: 1 })
  // "Friday at midnight": the start of Friday, said so; "every day at midnight" names no day to doubt.
  const midnight = read("every Friday at midnight, rotate the logs", "edges")
  assert.equal(summarizeReading("every Friday at midnight, rotate the logs", midnight), "exact open «every Friday at midnight» FREQ=WEEKLY;BYDAY=FR;BYHOUR=0;BYMINUTE=0 @2026-10-09T00:00 day:the start of Friday")
  assert.deepEqual(dayOf(midnight), { part: "day", shown: "the start of Friday", tip: "“Friday at midnight” reads as the start of Friday. Say “Saturday at midnight” if you meant the end of it.", shift: 1 })
  assert.equal(dayOf(read("every weekday at midnight rotate the logs", "edges"))?.shown, "the start of each day")
  assert.equal(dayOf(read("every day at midnight rotate the logs", "edges")), undefined)
  // The model may take the other reading, and it agrees: the day moved by the shift, never by another.
  assert.ok(midnight.kind === "exact" && tonight.kind === "exact" && next.kind === "exact")
  const as = (r: Extract<PhraseReading, { kind: "exact" }>) => ({ rrule: r.rrule, dtstart: r.dtstart, tz: NY, assumed: r.assumed })
  assert.equal(readingsConsistent(as(midnight), { rrule: "FREQ=WEEKLY;BYDAY=SA;BYHOUR=0;BYMINUTE=0", dtstart: "2026-10-10T00:00", tz: NY }, SPEC_NOW), true)
  assert.equal(readingsConsistent(as(midnight), { rrule: "FREQ=WEEKLY;BYDAY=SU;BYHOUR=0;BYMINUTE=0", dtstart: "2026-10-11T00:00", tz: NY }, SPEC_NOW), false)
  assert.equal(readingsConsistent(as(next), { rrule: "FREQ=DAILY;COUNT=1;BYHOUR=10;BYMINUTE=0", dtstart: "2026-10-13T10:00", tz: NY }, SPEC_NOW), true)
  assert.equal(readingsConsistent(as(next), { rrule: "FREQ=DAILY;COUNT=1;BYHOUR=10;BYMINUTE=0", dtstart: "2026-10-07T10:00", tz: NY }, SPEC_NOW), false)
  assert.equal(readingsConsistent(as(tonight), { rrule: "FREQ=DAILY;COUNT=1;BYHOUR=2;BYMINUTE=0", dtstart: "2026-10-07T02:00", tz: NY }, late), true)
})

test("break 3: a file's name, a statement about a schedule, or a quote in another typography is not offered (F14, F15, F17)", () => {
  for (const text of ["daily.yml is failing, fix it", "nightly.yml: add a step for lint", "weekly.json has a bug in the parser", "hourly.sh exits 1 on the new runner", "Mondays.md needs a new section"]) {
    assert.equal(isScheduleOffer(read(text, "edges")), false, `${text}: ${line(text, "edges")}`)
    assert.equal(read(text, "anywhere").kind, "none", text)
  }
  // The phrase as the subject of what follows: an adjective, a bug report.
  for (const text of [
    "Quarterly OKRs are due, draft ours",
    "Biweekly sprints are too short — propose 3-week ones",
    "Weeknight deploys keep failing, find out why",
    "Every night, a cron job wipes /tmp. Find out which one.",
    "Every 30 minutes, pods restart. Find out why.",
    "Every morning, CI is red. Figure out why.",
    "Each night at 2am, Postgres autovacuum locks the table — find a fix",
    "Every Monday I get a flood of dependabot PRs; write a script to auto-merge them",
    "Every Monday at 9am UTC, a GitHub Action should post the release notes. Write that workflow.",
  ]) {
    assert.equal(isScheduleOffer(read(text, "edges")), false, `${text}: ${line(text, "edges")}`)
  }
  for (const text of [
    "„every Monday at 9am“ is the default cron string, document it",
    "«every Monday at 9am» is the default, document it",
    "»every Monday at 9am« is the default, document it",
    "‚every Monday at 9am‘ is the default, document it",
    "「every Monday at 9am」 is the default, document it",
    "‘every Monday at 9am’ is the default, document it",
  ]) {
    for (const scope of BOTH) assert.equal(read(text, scope).kind, "none", `${scope}: ${line(text, scope)}`)
  }
  // An imperative after the phrase is still a request, and a sentence's period is no file extension.
  for (const text of ["every Monday at 9am triage new issues", "Every night, clean up stale branches", "every day at 9am. check the queue"]) {
    assert.equal(isScheduleOffer(read(text, "edges")), true, text)
  }
})

test("break 3: every quarter hour is every 15 minutes, not the quarterly copy (F18)", () => {
  for (const text of ["every quarter hour check the deploy", "every quarter-hour check the deploy", "every quarter of an hour check the deploy"]) {
    const r = read(text, "edges")
    assert.ok(r.kind === "exact" && r.rrule === "FREQ=HOURLY;BYMINUTE=0,15,30,45", `${text}: ${summarizeReading(text, r)}`)
    const echo = scheduleEcho({ title: "Check", rrule: r.rrule, dtstart: r.dtstart, tz: NY }, SPEC_NOW, NY)
    assert.ok(echo.ok)
    assert.equal(echo.value.describe, "every 15 minutes")
  }
  // A quarter of the year is still the ambiguous kind.
  assert.equal(read("every quarter review the access list", "edges").kind, "ambiguous")
})

test("scheduleWordPrefix: a word still being typed into a schedule word that reads otherwise (F19)", () => {
  // "mon" is Monday's abbreviation but "month"'s prefix; "week" is a word and "weekday"'s prefix.
  for (const w of ["mon", "Mon", "week", "Wedn", "satu", "thursd", "even", "after", "mid", "morn", "ju", "fort", "septem"]) assert.equal(scheduleWordPrefix(w), true, w)
  // An abbreviation of the only word it can finish as, a whole word, a plural or an adverb of one, a word that
  // is no prefix, and a single letter.
  for (const w of ["wed", "tue", "tues", "thurs", "sat", "jul", "mar", "sept", "month", "monday", "Mondays", "weekday", "day", "days", "every", "night", "triage", "m", "july", "may", "quarter", "weekly"]) {
    assert.equal(scheduleWordPrefix(w), false, w)
  }
})
