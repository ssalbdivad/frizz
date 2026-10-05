import assert from "node:assert/strict"
import test from "node:test"
import {
  checkSchedule,
  compileSchedule,
  describeSchedule,
  formatOccurrence,
  occurrencesAfter,
  occurrencesBetween,
  parseScheduleRule,
  wallToInstant,
  type CompiledSchedule,
  type ScheduleSpec,
} from "./schedule-rule.ts"

const NY = "America/New_York"

function compiled(rrule: string, dtstart = "2026-10-05T09:00", tz = NY): CompiledSchedule {
  const c = compileSchedule({ rrule, dtstart, tz })
  if (!c.ok) throw new Error(c.error)
  return c.value
}

/** Occurrences rendered as local wall strings in the schedule's zone, for readable assertions. */
function next(rrule: string, opts: { dtstart?: string; tz?: string; after?: string; n?: number } = {}): string[] {
  const tz = opts.tz ?? NY
  const c = compiled(rrule, opts.dtstart, tz)
  const after = opts.after ? Date.parse(opts.after) : c.dtstartMs - 1
  return occurrencesAfter(c, after, opts.n ?? 4).map((ms) => local(ms, tz))
}

function local(ms: number, tz: string): string {
  const parts = new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms))
  return parts.replace(" ", "T")
}

test("weekly on a named day takes the hour and minute it is given", () => {
  // 2026-10-05 is a Monday.
  assert.deepEqual(next("FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0", { dtstart: "2026-10-05T14:57" }), [
    "2026-10-12T09:00", // DTSTART's own Monday is at 09:00, before the 14:57 start, so it is not a run
    "2026-10-19T09:00",
    "2026-10-26T09:00",
    "2026-11-02T09:00",
  ])
})

test("a rule that names no day or time takes them from the start", () => {
  assert.deepEqual(next("FREQ=WEEKLY", { dtstart: "2026-10-07T16:30" }), ["2026-10-07T16:30", "2026-10-14T16:30", "2026-10-21T16:30", "2026-10-28T16:30"])
  assert.deepEqual(next("FREQ=MONTHLY", { dtstart: "2026-10-15T08:00" }), ["2026-10-15T08:00", "2026-11-15T08:00", "2026-12-15T08:00", "2027-01-15T08:00"])
  assert.deepEqual(next("FREQ=YEARLY", { dtstart: "2026-10-15T08:00", n: 2 }), ["2026-10-15T08:00", "2027-10-15T08:00"])
})

test("every weekday", () => {
  assert.deepEqual(next("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0", { dtstart: "2026-10-08T12:00", n: 5 }), [
    "2026-10-09T09:00",
    "2026-10-12T09:00",
    "2026-10-13T09:00",
    "2026-10-14T09:00",
    "2026-10-15T09:00",
  ])
})

test("every other Friday is anchored on the start's week", () => {
  assert.deepEqual(next("FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;BYHOUR=16;BYMINUTE=0", { dtstart: "2026-10-05T10:00" }), [
    "2026-10-09T16:00",
    "2026-10-23T16:00",
    "2026-11-06T16:00",
    "2026-11-20T16:00",
  ])
  // Jumping ahead to a later `after` lands on the same grid, not on a grid re-anchored at `after`.
  assert.deepEqual(next("FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;BYHOUR=16;BYMINUTE=0", { dtstart: "2026-10-05T10:00", after: "2027-03-01T00:00:00Z", n: 2 }), [
    "2027-03-12T16:00",
    "2027-03-26T16:00",
  ])
})

test("every 3 days counts from the start", () => {
  assert.deepEqual(next("FREQ=DAILY;INTERVAL=3", { dtstart: "2026-10-05T07:15" }), ["2026-10-05T07:15", "2026-10-08T07:15", "2026-10-11T07:15", "2026-10-14T07:15"])
  assert.deepEqual(next("FREQ=DAILY;INTERVAL=3", { dtstart: "2026-10-05T07:15", after: "2026-12-31T15:00:00Z", n: 2 }), ["2027-01-03T07:15", "2027-01-06T07:15"])
})

test("first weekday of the month uses BYSETPOS over the month", () => {
  assert.deepEqual(next("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1;BYHOUR=9;BYMINUTE=0", { dtstart: "2026-10-05T10:00" }), [
    "2026-11-02T09:00", // Nov 1 2026 is a Sunday
    "2026-12-01T09:00",
    "2027-01-01T09:00",
    "2027-02-01T09:00",
  ])
  assert.deepEqual(next("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;BYHOUR=17;BYMINUTE=0", { dtstart: "2026-10-05T10:00", n: 3 }), [
    "2026-10-30T17:00",
    "2026-11-30T17:00",
    "2026-12-31T17:00",
  ])
})

test("numbered weekdays count within the month", () => {
  assert.deepEqual(next("FREQ=MONTHLY;BYDAY=1MO;BYHOUR=10;BYMINUTE=0", { dtstart: "2026-10-05T11:00", n: 3 }), ["2026-11-02T10:00", "2026-12-07T10:00", "2027-01-04T10:00"])
  assert.deepEqual(next("FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=10;BYMINUTE=0", { dtstart: "2026-10-05T11:00", n: 3 }), ["2026-10-30T10:00", "2026-11-27T10:00", "2026-12-25T10:00"])
  // Under YEARLY with BYMONTH the ordinal is still within the month: US Thanksgiving.
  assert.deepEqual(next("FREQ=YEARLY;BYMONTH=11;BYDAY=4TH;BYHOUR=8;BYMINUTE=0", { dtstart: "2026-10-05T11:00", n: 2 }), ["2026-11-26T08:00", "2027-11-25T08:00"])
})

test("the 31st skips short months; the last day of the month does not", () => {
  assert.deepEqual(next("FREQ=MONTHLY;BYMONTHDAY=31;BYHOUR=9;BYMINUTE=0", { dtstart: "2026-10-05T10:00", n: 3 }), ["2026-10-31T09:00", "2026-12-31T09:00", "2027-01-31T09:00"])
  assert.deepEqual(next("FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=9;BYMINUTE=0", { dtstart: "2026-10-05T10:00", n: 5 }), [
    "2026-10-31T09:00",
    "2026-11-30T09:00",
    "2026-12-31T09:00",
    "2027-01-31T09:00",
    "2027-02-28T09:00",
  ])
})

test("hourly windows and several times a day", () => {
  assert.deepEqual(next("FREQ=HOURLY;INTERVAL=2;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9,11,13,15,17;BYMINUTE=0", { dtstart: "2026-10-09T09:00", n: 7 }), [
    "2026-10-09T09:00",
    "2026-10-09T11:00",
    "2026-10-09T13:00",
    "2026-10-09T15:00",
    "2026-10-09T17:00",
    "2026-10-12T09:00", // the weekend is skipped
    "2026-10-12T11:00",
  ])
  assert.deepEqual(next("FREQ=DAILY;BYHOUR=9,17;BYMINUTE=0", { dtstart: "2026-10-05T10:00", n: 3 }), ["2026-10-05T17:00", "2026-10-06T09:00", "2026-10-06T17:00"])
})

test("COUNT counts from the start, not from now", () => {
  const c = compiled("FREQ=DAILY;COUNT=3", "2026-10-05T09:00")
  assert.equal(occurrencesAfter(c, c.dtstartMs - 1, 10).length, 3)
  // After the first run, only two remain — not three more.
  assert.equal(occurrencesAfter(c, c.dtstartMs, 10).length, 2)
})

test("UNTIL is inclusive, in local or UTC form", () => {
  assert.deepEqual(next("FREQ=DAILY;UNTIL=20261007", { dtstart: "2026-10-05T09:00", n: 10 }), ["2026-10-05T09:00", "2026-10-06T09:00", "2026-10-07T09:00"])
  // 2026-10-07T13:00Z is 09:00 EDT, so the 7th is included and the 8th is not.
  assert.deepEqual(next("FREQ=DAILY;UNTIL=20261007T130000Z", { dtstart: "2026-10-05T09:00", n: 10 }), ["2026-10-05T09:00", "2026-10-06T09:00", "2026-10-07T09:00"])
})

test("spring forward: a time that does not exist runs at the next valid time; fall back runs once", () => {
  // 2027-03-14 02:00 EST jumps to 03:00 EDT in New York.
  assert.deepEqual(next("FREQ=DAILY;BYHOUR=2;BYMINUTE=30", { dtstart: "2027-03-12T00:00", n: 4 }), [
    "2027-03-12T02:30",
    "2027-03-13T02:30",
    "2027-03-14T03:30",
    "2027-03-15T02:30",
  ])
  // 2026-11-01 01:30 happens twice; the run is the first (EDT) one, once.
  const c = compiled("FREQ=DAILY;BYHOUR=1;BYMINUTE=30", "2026-10-31T00:00")
  const runs = occurrencesAfter(c, c.dtstartMs - 1, 3)
  assert.equal(new Date(runs[1]!).toISOString(), "2026-11-01T05:30:00.000Z")
  assert.equal(runs[2]! - runs[1]!, 25 * 3_600_000)
})

test("wall-clock conversion holds in a zone with no DST and one far from UTC", () => {
  assert.equal(new Date(wallToInstant({ y: 2026, mo: 10, d: 5, h: 9, mi: 0 }, "Asia/Kolkata")).toISOString(), "2026-10-05T03:30:00.000Z")
  assert.equal(new Date(wallToInstant({ y: 2026, mo: 10, d: 5, h: 9, mi: 0 }, "UTC")).toISOString(), "2026-10-05T09:00:00.000Z")
  assert.equal(new Date(wallToInstant({ y: 2026, mo: 4, d: 5, h: 2, mi: 30 }, "Australia/Sydney")).toISOString(), "2026-04-04T15:30:00.000Z")
})

test("occurrencesBetween keeps the most recent misses", () => {
  const c = compiled("FREQ=HOURLY", "2026-10-05T00:00", "UTC")
  const between = occurrencesBetween(c, Date.parse("2026-10-05T00:00:00Z"), Date.parse("2026-10-05T10:30:00Z"), 3)
  assert.deepEqual(between.map((ms) => new Date(ms).toISOString().slice(11, 16)), ["08:00", "09:00", "10:00"])
})

test("the parser refuses what the engine does not support, with a reason an agent can act on", () => {
  const refuse = (rule: string, pattern: RegExp) => {
    const r = parseScheduleRule(rule)
    assert.equal(r.ok, false, rule)
    if (!r.ok) assert.match(r.error, pattern, rule)
  }
  refuse("", /empty/)
  refuse("FREQ=MINUTELY", /HOURLY is the finest/)
  refuse("FREQ=DAILY;BYWEEKNO=3", /not supported/)
  refuse("FREQ=WEEKLY;BYDAY=1MO", /MONTHLY or FREQ=YEARLY/)
  refuse("FREQ=DAILY;COUNT=2;UNTIL=20270101", /not both/)
  refuse("FREQ=DAILY;BYHOUR=24", /BYHOUR/)
  refuse("BYDAY=MO", /needs a FREQ/)
  refuse("FREQ=WEEKLY;BYMONTHDAY=3", /WEEKLY/)
  assert.equal(parseScheduleRule("RRULE:freq=weekly;byday=mo").ok, true)
})

test("checkSchedule refuses runs closer than 15 minutes and rules that never fire", () => {
  const spec = (rrule: string): ScheduleSpec => ({ rrule, dtstart: "2026-10-05T09:00", tz: NY })
  const now = Date.parse("2026-10-05T15:00:00Z") // 11am in New York
  const tight = checkSchedule(spec("FREQ=HOURLY;BYMINUTE=0,10,20,30,40,50"), now)
  assert.equal(tight.ok, false)
  const never = checkSchedule(spec("FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30"), now)
  assert.equal(never.ok, false)
  const over = checkSchedule(spec("FREQ=DAILY;COUNT=1"), now) // its one run was this morning
  assert.equal(over.ok, false)
  const zone = checkSchedule({ rrule: "FREQ=DAILY", dtstart: "2026-10-05T09:00", tz: "Mars/Olympus" }, now)
  assert.equal(zone.ok, false)
  const ok = checkSchedule(spec("FREQ=HOURLY;INTERVAL=2"), now)
  assert.equal(ok.ok, true)
  if (ok.ok) {
    assert.equal(ok.value.next.length, 3)
    assert.equal(ok.value.perDay, 12)
  }
})

test("describeSchedule says what will fire", () => {
  const say = (rrule: string, dtstart = "2026-10-05T09:00") => describeSchedule(compiled(rrule, dtstart))
  assert.equal(say("FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0"), "every Monday at 9am")
  assert.equal(say("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=30"), "every weekday at 9:30am")
  assert.equal(say("FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0"), "every weekday at 9am")
  assert.equal(say("FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;BYHOUR=16;BYMINUTE=0"), "every other week on Friday at 4pm")
  assert.equal(say("FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=12;BYMINUTE=0"), "every Monday and Wednesday at 12pm")
  assert.equal(say("FREQ=DAILY"), "every day at 9am")
  assert.equal(say("FREQ=DAILY;INTERVAL=3"), "every 3 days at 9am")
  assert.equal(say("FREQ=DAILY;BYHOUR=9,17;BYMINUTE=0"), "every day at 9am and 5pm")
  assert.equal(say("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1;BYHOUR=9;BYMINUTE=0"), "on the first weekday of every month at 9am")
  assert.equal(say("FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=9;BYMINUTE=0"), "on the last Friday of every month at 9am")
  assert.equal(say("FREQ=MONTHLY;BYMONTHDAY=1,15"), "on the 1st and 15th of every month at 9am")
  assert.equal(say("FREQ=MONTHLY;BYMONTHDAY=-1"), "on the last day of every month at 9am")
  assert.equal(say("FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1"), "every year on March 1 at 9am")
  assert.equal(say("FREQ=HOURLY;INTERVAL=2;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9,11,13,15,17;BYMINUTE=0"), "every 2 hours from 9am to 5pm on weekdays")
  assert.equal(say("FREQ=HOURLY;INTERVAL=3;BYDAY=MO,WE"), "every 3 hours on Mondays and Wednesdays")
  assert.equal(say("FREQ=HOURLY"), "every hour")
  assert.equal(say("FREQ=DAILY;COUNT=5"), "every day at 9am, 5 times")
  assert.equal(say("FREQ=DAILY;COUNT=1", "2026-10-06T08:00"), "once, Tue Oct 6, 8am")
  assert.equal(say("FREQ=DAILY;UNTIL=20261231"), "every day at 9am, until Dec 31, 2026")
  // Something it cannot phrase falls back to the rule itself.
  assert.match(say("FREQ=YEARLY;BYDAY=20MO"), /^on the rule FREQ=YEARLY;BYDAY=20MO/)
})

test("formatOccurrence renders in the schedule's zone", () => {
  assert.equal(formatOccurrence(Date.parse("2026-10-12T13:00:00Z"), NY), "Mon Oct 12, 9am")
  assert.equal(formatOccurrence(Date.parse("2026-10-12T13:00:00Z"), "Europe/Berlin"), "Mon Oct 12, 3pm")
})

test("DST edges outside New York: a midnight gap, and fall-back east of UTC takes the first instance", () => {
  // Santiago springs forward at 00:00 → 01:00 on 2026-09-06.
  assert.deepEqual(next("FREQ=DAILY;BYHOUR=0;BYMINUTE=30", { dtstart: "2026-09-05T00:00", tz: "America/Santiago", n: 3 }), [
    "2026-09-05T00:30",
    "2026-09-06T01:30",
    "2026-09-07T00:30",
  ])
  // Sydney falls back 03:00 → 02:00 on 2026-04-05; 02:30 happens twice and runs at the first (AEDT).
  const c = compiled("FREQ=DAILY;BYHOUR=2;BYMINUTE=30", "2026-04-04T00:00", "Australia/Sydney")
  const runs = occurrencesAfter(c, c.dtstartMs - 1, 2)
  assert.equal(new Date(runs[1]!).toISOString(), "2026-04-04T15:30:00.000Z")
})

test("a rarely-firing hourly rule stays fast", () => {
  const c = compiled("FREQ=HOURLY;INTERVAL=4;BYMONTH=2;BYMONTHDAY=29;BYHOUR=8", "2026-10-05T00:00", "UTC")
  const started = performance.now()
  const runs = occurrencesAfter(c, c.dtstartMs, 3)
  assert.ok(performance.now() - started < 50, "under 50ms")
  assert.deepEqual(runs.map((ms) => new Date(ms).toISOString().slice(0, 13)), ["2028-02-29T08", "2032-02-29T08", "2036-02-29T08"])
})
