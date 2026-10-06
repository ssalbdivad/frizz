// ---- SCHEDULED THREADS: THE RECURRENCE RULE --------------------------------------------------------
// A schedule's WHEN is one RFC 5545 RRULE, a local start (DTSTART as wall-clock `YYYY-MM-DDTHH:MM`, no
// zone) and an IANA zone. An AGENT writes it from the human's plain words; THIS module is the only thing
// that ever turns it into instants, so the echo the human confirms is built from the code that fires,
// never from the model's belief about what it wrote.
//
// Why RRULE and not cron: the schedules people actually say — "every other Friday", "every 3 days",
// "the first weekday of the month", "for three weeks" — need INTERVAL anchored on a start, BYSETPOS and
// COUNT/UNTIL, none of which 5-field cron has. ChatGPT Tasks, Codex automations, Devin and Google
// Calendar all landed on RRULE for the same reason, and models write it fluently.
//
// Why our own engine (zero deps) and not `rrule-temporal`: that one needs `temporal-polyfill` on every
// Node we support (~1.7 MB into the published server), and it SKIPS a local time that does not exist —
// a daily 02:30 job silently does not run on the spring-forward day. RFC 5545 (§3.3.10 by way of §3.3.5)
// reads a nonexistent local time with the offset from before the gap, i.e. it shifts FORWARD, which is
// also what cron, GitHub Actions and croner do; this engine does that. `rrule.js` is unmaintained since
// 2023 and returns zoned results as fake-UTC Dates. Differentially tested 2026-10-05 against
// rrule-temporal over 4,272 comparisons (2,136 rules, five zones): no engine date errors; every
// mismatch was the DST shift above, HOURLY stepping (below), or a reference-side bug.
//
// HOURLY steps WALL-CLOCK hours, as RFC 5545 computes recurrences in local time: `INTERVAL=3` across a
// spring-forward night reads 00:00, 03:00, 05:00 elapsed-wise, where an elapsed-time stepper says 06:00.
//
// The engine is deliberately brute force: enumerate the candidate LOCAL days of each period, filter by
// the BY* parts, apply BYSETPOS over the period, then convert each surviving wall time to an instant.
// A year of days is 366 cheap integer checks, so correctness by inspection beats a clever expander.

export type ScheduleFreq = "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY"

/** `day` is 0 = Monday … 6 = Sunday (RRULE's own order); `nth` is BYDAY's ordinal (`1MO`, `-1FR`). */
export interface ScheduleWeekday {
  day: number
  nth?: number
}

export interface ScheduleRule {
  freq: ScheduleFreq
  interval: number
  count?: number
  until?: { kind: "instant"; ms: number } | { kind: "local"; wall: Wall }
  byMonth?: number[]
  byMonthDay?: number[]
  byDay?: ScheduleWeekday[]
  byHour?: number[]
  byMinute?: number[]
  bySetPos?: number[]
  wkst: number
}

export interface ScheduleSpec {
  rrule: string
  /** Local wall-clock start, `YYYY-MM-DDTHH:MM`. Anchors INTERVAL and COUNT, and supplies the hour,
   *  minute, weekday or day-of-month a rule leaves out. */
  dtstart: string
  tz: string
}

export interface CompiledSchedule {
  rule: ScheduleRule
  dtstart: Wall
  dtstartMs: number
  tz: string
}

interface Wall {
  y: number
  mo: number
  d: number
  h: number
  mi: number
}

export type ScheduleResult<T> = { ok: true; value: T } | { ok: false; error: string }

const WEEKDAY_CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const
const FREQS: readonly ScheduleFreq[] = ["HOURLY", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"]
const UNSUPPORTED_PARTS = ["BYSECOND", "BYYEARDAY", "BYWEEKNO"]
const DAY_MS = 86_400_000

/** Occurrences closer together than this are refused: a fresh agent thread every few minutes is a
 *  runaway bill, and a same-thread heartbeat (the goal) is the tool for tight loops. */
export const SCHEDULE_MIN_SPACING_MS = 15 * 60_000
/** COUNT above this is refused — "every hour, 5000 times" is a typo or a runaway, never a plan. */
export const SCHEDULE_MAX_COUNT = 1000
/** How far ahead the engine looks for a next occurrence before calling a rule one that never fires
 *  ("February 30th"). Ten years covers a leap-day yearly rule several times over. */
const HORIZON_DAYS = 3660

// ---- parsing -----------------------------------------------------------------------------------------

export function parseScheduleRule(text: string): ScheduleResult<ScheduleRule> {
  const body = text.trim().replace(/^RRULE:/i, "")
  if (!body) return fail("The rule is empty. Write an RRULE such as FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0.")
  if (/\n/.test(body)) return fail("Give exactly one RRULE line. RDATE, EXDATE and multiple rules are not supported.")
  const seen = new Set<string>()
  const rule: Partial<ScheduleRule> & { wkst: number } = { wkst: 0, interval: 1 }
  for (const part of body.split(";").filter(Boolean)) {
    const eq = part.indexOf("=")
    if (eq < 1) return fail(`"${part}" is not a NAME=VALUE part.`)
    const name = part.slice(0, eq).trim().toUpperCase()
    const value = part.slice(eq + 1).trim().toUpperCase()
    if (seen.has(name)) return fail(`${name} appears twice.`)
    seen.add(name)
    if (UNSUPPORTED_PARTS.includes(name)) return fail(`${name} is not supported. Use BYMONTH, BYMONTHDAY, BYDAY, BYHOUR, BYMINUTE and BYSETPOS.`)
    switch (name) {
      case "FREQ": {
        if (value === "SECONDLY" || value === "MINUTELY") return fail("FREQ=HOURLY is the finest supported frequency; a scheduled thread is a fresh agent run.")
        if (!FREQS.includes(value as ScheduleFreq)) return fail(`FREQ=${value} is not a frequency.`)
        rule.freq = value as ScheduleFreq
        break
      }
      case "INTERVAL": {
        const n = intIn(value, 1, 1000)
        if (n === undefined) return fail("INTERVAL must be a whole number from 1 to 1000.")
        rule.interval = n
        break
      }
      case "COUNT": {
        const n = intIn(value, 1, SCHEDULE_MAX_COUNT)
        if (n === undefined) return fail(`COUNT must be a whole number from 1 to ${SCHEDULE_MAX_COUNT}.`)
        rule.count = n
        break
      }
      case "UNTIL": {
        const until = parseUntil(value)
        if (!until) return fail("UNTIL must look like 20261231, 20261231T170000 or 20261231T220000Z.")
        rule.until = until
        break
      }
      case "BYMONTH": {
        const list = intList(value, 1, 12)
        if (!list) return fail("BYMONTH takes months 1–12, comma-separated.")
        rule.byMonth = list
        break
      }
      case "BYMONTHDAY": {
        const list = intList(value, -31, 31)
        if (!list || list.includes(0)) return fail("BYMONTHDAY takes days 1–31 or -1–-31 (from the month's end), comma-separated.")
        rule.byMonthDay = list
        break
      }
      case "BYHOUR": {
        const list = intList(value, 0, 23)
        if (!list) return fail("BYHOUR takes hours 0–23, comma-separated.")
        rule.byHour = list
        break
      }
      case "BYMINUTE": {
        const list = intList(value, 0, 59)
        if (!list) return fail("BYMINUTE takes minutes 0–59, comma-separated.")
        rule.byMinute = list
        break
      }
      case "BYSETPOS": {
        const list = intList(value, -366, 366)
        if (!list || list.includes(0)) return fail("BYSETPOS takes positions like 1, 2 or -1, comma-separated.")
        rule.bySetPos = list
        break
      }
      case "BYDAY": {
        const days: ScheduleWeekday[] = []
        for (const raw of value.split(",")) {
          const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(raw.trim())
          if (!m) return fail(`BYDAY value "${raw}" is not a weekday like MO, 1MO or -1FR.`)
          const nth = m[1] === undefined ? undefined : parseInt(m[1], 10)
          if (nth !== undefined && (nth === 0 || Math.abs(nth) > 53)) return fail(`BYDAY ordinal in "${raw}" is out of range.`)
          days.push({ day: WEEKDAY_CODES.indexOf(m[2] as (typeof WEEKDAY_CODES)[number]), ...(nth === undefined ? {} : { nth }) })
        }
        rule.byDay = days
        break
      }
      case "WKST": {
        const i = WEEKDAY_CODES.indexOf(value as (typeof WEEKDAY_CODES)[number])
        if (i < 0) return fail("WKST must be a weekday code like MO.")
        rule.wkst = i
        break
      }
      default:
        return fail(`${name} is not a supported RRULE part.`)
    }
  }
  if (!rule.freq) return fail("The rule needs a FREQ (HOURLY, DAILY, WEEKLY, MONTHLY or YEARLY).")
  if (rule.count !== undefined && rule.until !== undefined) return fail("Use COUNT or UNTIL, not both.")
  const ordinals = rule.byDay?.some((d) => d.nth !== undefined)
  if (ordinals && rule.freq !== "MONTHLY" && rule.freq !== "YEARLY") return fail("A numbered weekday (1MO, -1FR) only works with FREQ=MONTHLY or FREQ=YEARLY.")
  if (rule.byMonthDay && rule.freq === "WEEKLY") return fail("BYMONTHDAY cannot be used with FREQ=WEEKLY.")
  return { ok: true, value: rule as ScheduleRule }
}

export function compileSchedule(spec: ScheduleSpec): ScheduleResult<CompiledSchedule> {
  if (!isValidTimeZone(spec.tz)) return fail(`"${spec.tz}" is not an IANA time zone like America/New_York.`)
  const dtstart = parseWall(spec.dtstart)
  if (!dtstart) return fail(`The start "${spec.dtstart}" must be a local time like 2026-10-12T09:00.`)
  const rule = parseScheduleRule(spec.rrule)
  if (!rule.ok) return rule
  return { ok: true, value: { rule: rule.value, dtstart, dtstartMs: wallToInstant(dtstart, spec.tz), tz: spec.tz } }
}

// ---- expansion -----------------------------------------------------------------------------------------

/** The first `limit` occurrences strictly after `afterMs`. */
export function occurrencesAfter(c: CompiledSchedule, afterMs: number, limit: number): number[] {
  const out: number[] = []
  expand(c, afterMs, (ms) => {
    out.push(ms)
    return out.length < limit
  })
  return out
}

/** Every occurrence in `(fromMs, toMs]`, capped at `cap` (the LAST `cap` of them, since a caller asking
 *  about a gap wants the most recent misses). */
export function occurrencesBetween(c: CompiledSchedule, fromMs: number, toMs: number, cap = 1000): number[] {
  const out: number[] = []
  expand(c, fromMs, (ms) => {
    if (ms > toMs) return false
    out.push(ms)
    if (out.length > cap) out.shift()
    return true
  })
  return out
}

function expand(c: CompiledSchedule, afterMs: number, emit: (ms: number) => boolean): void {
  const { rule, dtstart, tz } = c
  const startDay = dayNumber(dtstart.y, dtstart.mo, dtstart.d)
  // A COUNT rule is counted from DTSTART, so it must be walked from there; anything else may jump
  // straight to the period holding `afterMs` (rounded down onto the INTERVAL grid).
  let period = periodOf(rule, startDay, dtstart.h, rule.wkst)
  if (rule.count === undefined && afterMs > c.dtstartMs) {
    const after = zonedWall(afterMs, tz)
    const target = periodOf(rule, dayNumber(after.y, after.mo, after.d), after.h, rule.wkst)
    const steps = Math.floor(periodDistance(rule.freq, period, target) / rule.interval)
    if (steps > 0) period = advancePeriod(rule.freq, period, steps * rule.interval)
  }
  const horizonDay = Math.max(startDay, dayNumber(...wallDay(zonedWall(Math.max(afterMs, c.dtstartMs), tz)))) + HORIZON_DAYS
  let emitted = 0
  let lastMs = -Infinity
  const untilDay =
    rule.until === undefined ? Infinity
    : rule.until.kind === "local" ? dayNumber(rule.until.wall.y, rule.until.wall.mo, rule.until.wall.d)
    : Math.floor(rule.until.ms / DAY_MS) + 1
  for (;;) {
    const firstDay = periodFirstDay(rule.freq, period)
    if (firstDay > horizonDay || firstDay > untilDay) return
    // An HOURLY rule on a day its BY* parts exclude would otherwise walk all 24 hours of it, which made a
    // rarely-firing rule walk the whole ten-year horizon an hour at a time (361ms measured). Jump to the
    // first period of the next day on the INTERVAL grid instead.
    if (rule.freq === "HOURLY") {
      const [y, mo, d] = civilFromDay(firstDay)
      if (!dayMatches(rule, dtstart, y, mo, d, firstDay)) {
        const nextDayStart = (firstDay + 1) * 24
        period += Math.ceil((nextDayStart - period) / rule.interval) * rule.interval
        continue
      }
    }
    for (const wall of periodWalls(c, period)) {
      if (rule.until?.kind === "local" && compareWall(wall, rule.until.wall) > 0) return
      const ms = wallToInstant(wall, tz)
      if (ms < c.dtstartMs) continue
      if (rule.until?.kind === "instant" && ms > rule.until.ms) return
      // A spring-forward gap can shift two wall times onto one instant (02:30 → 03:30 beside a real
      // 03:30); it is one occurrence.
      if (ms <= lastMs) continue
      lastMs = ms
      emitted++
      if (ms > afterMs && !emit(ms)) return
      if (rule.count !== undefined && emitted >= rule.count) return
    }
    period = advancePeriod(rule.freq, period, rule.interval)
  }
}

// A period is an integer: a day number (DAILY), the day number of the week's first day (WEEKLY),
// year*12+month0 (MONTHLY), the year (YEARLY), or dayNumber*24+hour of LOCAL wall time (HOURLY).
function periodOf(rule: ScheduleRule, day: number, hour: number, wkst: number): number {
  switch (rule.freq) {
    case "HOURLY":
      return day * 24 + hour
    case "DAILY":
      return day
    case "WEEKLY":
      return day - ((weekdayOf(day) - wkst + 7) % 7)
    case "MONTHLY": {
      const [y, mo] = civilFromDay(day)
      return y * 12 + (mo - 1)
    }
    case "YEARLY":
      return civilFromDay(day)[0]
  }
}

function periodDistance(freq: ScheduleFreq, from: number, to: number): number {
  return freq === "WEEKLY" ? Math.floor((to - from) / 7) : to - from
}

function advancePeriod(freq: ScheduleFreq, period: number, steps: number): number {
  return freq === "WEEKLY" ? period + steps * 7 : period + steps
}

function periodFirstDay(freq: ScheduleFreq, period: number): number {
  switch (freq) {
    case "HOURLY":
      return Math.floor(period / 24)
    case "DAILY":
    case "WEEKLY":
      return period
    case "MONTHLY":
      return dayNumber(Math.floor(period / 12), (period % 12) + 1, 1)
    case "YEARLY":
      return dayNumber(period, 1, 1)
  }
}

function periodDays(freq: ScheduleFreq, period: number): number[] {
  const first = periodFirstDay(freq, period)
  let length = 1
  if (freq === "WEEKLY") length = 7
  else if (freq === "MONTHLY") length = daysInMonth(Math.floor(period / 12), (period % 12) + 1)
  else if (freq === "YEARLY") length = dayNumber(period + 1, 1, 1) - first
  return Array.from({ length }, (_, i) => first + i)
}

/** The period's occurrences as sorted local wall times, BYSETPOS applied. */
function periodWalls(c: CompiledSchedule, period: number): Wall[] {
  const { rule, dtstart } = c
  const walls: Wall[] = []
  const hours =
    rule.freq === "HOURLY"
      ? rule.byHour && !rule.byHour.includes(period % 24) ? [] : [period % 24]
      : sortedUnique(rule.byHour ?? [dtstart.h])
  const minutes = sortedUnique(rule.byMinute ?? [dtstart.mi])
  if (hours.length === 0) return walls
  for (const day of periodDays(rule.freq, period)) {
    const [y, mo, d] = civilFromDay(day)
    if (!dayMatches(rule, dtstart, y, mo, d, day)) continue
    for (const h of hours) for (const mi of minutes) walls.push({ y, mo, d, h, mi })
  }
  if (!rule.bySetPos) return walls
  const picked = new Set<number>()
  for (const pos of rule.bySetPos) {
    const i = pos > 0 ? pos - 1 : walls.length + pos
    if (i >= 0 && i < walls.length) picked.add(i)
  }
  return [...picked].sort((a, b) => a - b).map((i) => walls[i]!)
}

function dayMatches(rule: ScheduleRule, dtstart: Wall, y: number, mo: number, d: number, day: number): boolean {
  if (rule.byMonth && !rule.byMonth.includes(mo)) return false
  const monthLength = daysInMonth(y, mo)
  if (rule.byMonthDay && !rule.byMonthDay.some((md) => (md > 0 ? md === d : monthLength + md + 1 === d))) return false
  if (rule.byDay) {
    const weekday = weekdayOf(day)
    // An ordinal counts within the month under MONTHLY (or YEARLY narrowed by BYMONTH), else the year.
    const inMonth = rule.freq === "MONTHLY" || (rule.freq === "YEARLY" && rule.byMonth !== undefined)
    const index = inMonth ? d : day - dayNumber(y, 1, 1) + 1
    const length = inMonth ? monthLength : dayNumber(y + 1, 1, 1) - dayNumber(y, 1, 1)
    const ok = rule.byDay.some((spec) => {
      if (spec.day !== weekday) return false
      if (spec.nth === undefined) return true
      return spec.nth > 0 ? Math.floor((index - 1) / 7) + 1 === spec.nth : -(Math.floor((length - index) / 7) + 1) === spec.nth
    })
    if (!ok) return false
  }
  // A rule that names no day leaves it to DTSTART: its weekday (WEEKLY), its day of the month
  // (MONTHLY), or its month and day (YEARLY, unless BYMONTH named the months).
  if (!rule.byDay && !rule.byMonthDay) {
    if (rule.freq === "WEEKLY" && weekdayOf(day) !== weekdayOf(dayNumber(dtstart.y, dtstart.mo, dtstart.d))) return false
    if (rule.freq === "MONTHLY" && d !== dtstart.d) return false
    if (rule.freq === "YEARLY" && (d !== dtstart.d || (!rule.byMonth && mo !== dtstart.mo))) return false
  }
  return true
}

// ---- validation for a new or changed schedule -------------------------------------------------------

export interface ScheduleCheck {
  compiled: CompiledSchedule
  /** The next few occurrences after `nowMs`. */
  next: number[]
  /** Occurrences per day, when the rule fires more than once a day. */
  perDay?: number
}

/** Everything a schedule must pass before it is saved: it parses, it fires at least once more, and no
 *  two occurrences are closer than {@link SCHEDULE_MIN_SPACING_MS}. */
export function checkSchedule(spec: ScheduleSpec, nowMs: number, preview = 3): ScheduleResult<ScheduleCheck> {
  const compiled = compileSchedule(spec)
  if (!compiled.ok) return compiled
  const sample = occurrencesAfter(compiled.value, nowMs, 60)
  if (sample.length === 0) return fail("This rule never runs again. Check UNTIL, COUNT and the start, or impossible dates like February 30.")
  for (let i = 1; i < sample.length; i++) {
    if (sample[i]! - sample[i - 1]! < SCHEDULE_MIN_SPACING_MS) {
      return fail("Runs would be less than 15 minutes apart. Scheduled threads start a fresh agent each time; use a goal on one thread for a tighter loop.")
    }
  }
  // Runs a day, counted over the 24h from the first run. The 60-run sample is too short to count a dense
  // rule — every 15 minutes is 96 a day and read as 60 — so a saturated sample is recounted over 97 runs,
  // one more than the 15m floor allows in a day (plans/schedule-live-reading.md §3.5.1).
  let perDay = sample.filter((ms) => ms < sample[0]! + DAY_MS).length
  if (perDay === sample.length && sample.length === 60) {
    const dense = occurrencesAfter(compiled.value, nowMs, 97)
    perDay = dense.filter((ms) => ms < dense[0]! + DAY_MS).length
  }
  return {
    ok: true,
    value: { compiled: compiled.value, next: sample.slice(0, preview), ...(perDay > 1 ? { perDay } : {}) },
  }
}

// ---- describing a rule in plain words ---------------------------------------------------------------

const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
const ORDINAL_WORDS: Record<number, string> = { 1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth", [-1]: "last", [-2]: "second-to-last" }

/** One run of a rule's description, typed by what it says, so a reader can mark the parts it ASSUMED
 *  (plans/schedule-live-reading.md §3.4): the prompt box dims `9am` when nobody typed a time, `Monday`
 *  when "weekly" named no day, and only the `pm` of a `time` when "at 3" was read as the afternoon.
 *  `lead` is connective wording ("every ", " at ", ", "); the rest carry the rule. Joined, the parts are
 *  exactly {@link describeSchedule} — a test pins that for every rule in the grammar corpus. */
export interface ScheduleDescribePart {
  kind: "lead" | "days" | "interval" | "time" | "bound"
  text: string
}

type Parts = ScheduleDescribePart[]
const lead = (text: string): ScheduleDescribePart => ({ kind: "lead", text })
const daysPart = (text: string): ScheduleDescribePart => ({ kind: "days", text })
const intervalPart = (text: string): ScheduleDescribePart => ({ kind: "interval", text })
const boundPart = (text: string): ScheduleDescribePart => ({ kind: "bound", text })

/** "every Monday at 9am", "every 2 weeks on Friday at 4:30pm", "on the first weekday of every month at
 *  9am". Built from the compiled rule — never from the agent's own summary — so it says what will fire.
 *  A rule this cannot phrase falls back to its RRULE text; the next-run list is the real confirmation.
 *  `nowMs`, when given, adds the year to a one-off run that is not this year. */
export function describeSchedule(c: CompiledSchedule, nowMs?: number): string {
  return describeScheduleParts(c, nowMs).map((p) => p.text).join("")
}

/** {@link describeSchedule}, as typed parts. */
export function describeScheduleParts(c: CompiledSchedule, nowMs?: number): ScheduleDescribePart[] {
  const { rule, dtstart } = c
  const phrased = phraseParts(rule, dtstart)
  if (rule.count === 1 && phrased !== undefined) {
    const w = zonedWall(c.dtstartMs, c.tz)
    return [lead("once, "), daysPart(formatOccurrenceDate(c.dtstartMs, c.tz, nowMs)), lead(", "), timePart(formatClock(w.h, w.mi))]
  }
  const parts: Parts = phrased ?? [lead(`on the rule ${ruleText(rule)}`)]
  if (rule.count !== undefined) parts.push(lead(", "), boundPart(`${rule.count} times`))
  if (rule.until) {
    const wall = rule.until.kind === "local" ? rule.until.wall : zonedWall(rule.until.ms, c.tz)
    parts.push(lead(", "), boundPart(`until ${MONTH_NAMES[wall.mo - 1]!.slice(0, 3)} ${wall.d}, ${wall.y}`))
  }
  return parts
}

function timePart(text: string): ScheduleDescribePart {
  return { kind: "time", text }
}

function phraseParts(rule: ScheduleRule, dtstart: Wall): Parts | undefined {
  // A month FILTER over a daily or weekly rule — the model's spelling of "every Friday except in December"
  // is WEEKLY;BYMONTH=1,…,11 — is the rule without it, then which months. It echoed as `on the rule …`
  // until fix round 1 (model-raw-rrule-echo): the human was asked to confirm raw RRULE text.
  if (rule.byMonth && (rule.freq === "DAILY" || rule.freq === "WEEKLY") && !rule.byMonthDay && !rule.bySetPos) {
    const { byMonth, ...unfiltered } = rule
    const months = monthsQualifier(byMonth)
    const rest = months === undefined ? undefined : phraseParts(unfiltered, dtstart)
    return rest && months!.length ? [...rest, lead(", "), ...months!] : rest
  }
  const times = timesParts(rule, dtstart)
  if (rule.freq === "HOURLY") {
    const minute = sortedUnique(rule.byMinute ?? [dtstart.mi])
    const days = daysPhrase(rule)
    if (days === undefined) return undefined
    const on: Parts = days ? [lead(" on "), daysPart(pluralDays(rule.byDay!))] : []
    // An even step from :00 is a minute interval: BYMINUTE=0,15,30,45 is "every 15 minutes", not a list
    // of four marks past the hour (plans/schedule-live-reading.md §3.5.4).
    const step = minuteStep(minute)
    if (step !== undefined && rule.interval === 1 && !rule.byHour) return [intervalPart(`every ${step} minutes`), ...on]
    const every = rule.interval === 1 ? "every hour" : `every ${rule.interval} hours`
    const at: Parts = minute.length === 1 && minute[0] === 0 ? [] : [lead(" at "), timePart(minute.map((m) => `:${pad2(m)}`).join(", "))]
    const window: Parts = rule.byHour
      ? [lead(" from "), timePart(formatClock(Math.min(...rule.byHour), minute[0]!)), lead(" to "), timePart(formatClock(Math.max(...rule.byHour), minute[minute.length - 1]!))]
      : []
    return [intervalPart(every), ...at, ...window, ...on]
  }
  if (times === undefined) return undefined
  const at = [lead(" at "), ...times]
  if (rule.freq === "DAILY") {
    const days = daysPhrase(rule)
    if (days === undefined) return undefined
    if (rule.interval > 1) return days ? undefined : [intervalPart(`every ${rule.interval} days`), ...at]
    return [...(days ? [lead("every "), daysPart(days)] : [intervalPart("every day")]), ...at]
  }
  if (rule.freq === "WEEKLY") {
    if (rule.byMonth) return undefined
    const days = rule.byDay ? weekdayList(rule.byDay) : WEEKDAY_NAMES[weekdayOf(dayNumber(dtstart.y, dtstart.mo, dtstart.d))]!
    if (days === undefined) return undefined
    if (rule.interval === 1) return [lead("every "), daysPart(days), ...at]
    const weeks = rule.interval === 2 ? "every other week" : `every ${rule.interval} weeks`
    return [intervalPart(weeks), lead(" on "), daysPart(days), ...at]
  }
  if (rule.freq === "MONTHLY") {
    const which = monthDayPhrase(rule, dtstart)
    if (which === undefined) return undefined
    if (rule.byMonth) {
      if (rule.interval !== 1 || !isQuarterSet(rule)) return undefined
      return [lead("on "), daysPart(which), lead(" of "), intervalPart("every quarter"), ...at]
    }
    const months = rule.interval === 1 ? "every month" : rule.interval === 2 ? "every other month" : `every ${rule.interval} months`
    return [lead("on "), daysPart(which), lead(" of "), intervalPart(months), ...at]
  }
  // YEARLY
  if (rule.interval !== 1 || rule.bySetPos) return undefined
  // A calendar-quarter set (BYMONTH=1,4,7,10 or 3,6,9,12) with a day in each: an ordinal under YEARLY
  // narrowed by BYMONTH counts within the month, so it reads exactly like the MONTHLY form. BYSETPOS is
  // refused above: under YEARLY it picks positions across the whole YEAR, not one per quarter.
  if (rule.byMonth && rule.byMonth.length > 1) {
    if (!isQuarterSet(rule)) return undefined
    const which = monthDayPhrase(rule, dtstart)
    if (which === undefined || (rule.byMonthDay && rule.byMonthDay.length !== 1)) return undefined
    return [lead("on "), daysPart(which), lead(" of "), intervalPart("every quarter"), ...at]
  }
  if (rule.byDay) return undefined
  const months = (rule.byMonth ?? [dtstart.mo]).map((m) => MONTH_NAMES[m - 1]!)
  const days = rule.byMonthDay ?? [dtstart.d]
  if (months.length !== 1 || days.length !== 1 || days[0]! < 0) return undefined
  return [intervalPart("every year"), lead(" on "), daysPart(`${months[0]} ${days[0]}`), ...at]
}

/** Which months a filter keeps, in the fewest words: "except in December" (one or two left out), "from March to
 *  October" (one run, across the new year too), "in January, April and July" (three at most). Anything else
 *  would have to list months at length, and stays the raw rule. Every month is no qualifier at all. */
function monthsQualifier(byMonth: number[]): Parts | undefined {
  const set = sortedUnique(byMonth).filter((m) => m >= 1 && m <= 12)
  if (set.length === 12) return []
  if (set.length === 0) return undefined
  const name = (m: number) => MONTH_NAMES[m - 1]!
  const missing = MONTH_NAMES.map((_, i) => i + 1).filter((m) => !set.includes(m))
  if (missing.length <= 2) return [lead("except in "), daysPart(joinWords(missing.map(name)))]
  if (set.length >= 3) {
    // A run of consecutive months, possibly across December: the one month whose predecessor is missing.
    const starts = set.filter((m) => !set.includes(m === 1 ? 12 : m - 1))
    if (starts.length === 1) {
      const from = starts[0]!
      const to = ((from - 1 + set.length - 1) % 12) + 1
      return [lead("from "), daysPart(`${name(from)} to ${name(to)}`)]
    }
  }
  if (set.length <= 3) return [lead("in "), daysPart(joinWords(set.map(name)))]
  return undefined
}

/** The minute step when BYMINUTE is an even step from :00 that fills the hour (0,15,30,45 → 15). */
function minuteStep(minutes: number[]): number | undefined {
  if (minutes.length < 2 || minutes[0] !== 0) return undefined
  const step = minutes[1]!
  if (step * minutes.length !== 60) return undefined
  return minutes.every((m, i) => m === i * step) ? step : undefined
}

/** A BYMONTH set that is the calendar quarters, read from the end its day counts from: the FIRST months
 *  (1,4,7,10) with a day counted from the start, or the LAST months (3,6,9,12) with one counted from the
 *  end — "the last Friday of every quarter". Anything else names months the words would not. */
function isQuarterSet(rule: ScheduleRule): boolean {
  const months = sortedUnique(rule.byMonth ?? []).join()
  const positions = rule.bySetPos ? rule.bySetPos : [...(rule.byDay ?? []).map((d) => d.nth), ...(rule.byMonthDay ?? [])]
  if (positions.length === 0 || positions.some((p) => p === undefined)) return false
  const fromStart = positions.every((p) => p! > 0)
  const fromEnd = positions.every((p) => p! < 0)
  return (months === "1,4,7,10" && fromStart) || (months === "3,6,9,12" && fromEnd)
}

function timesParts(rule: ScheduleRule, dtstart: Wall): Parts | undefined {
  const hours = sortedUnique(rule.byHour ?? [dtstart.h])
  const minutes = sortedUnique(rule.byMinute ?? [dtstart.mi])
  if (hours.length * minutes.length > 4) return undefined
  const clocks: string[] = []
  for (const h of hours) for (const m of minutes) clocks.push(formatClock(h, m))
  const parts: Parts = []
  clocks.forEach((clock, i) => {
    if (i > 0) parts.push(lead(i === clocks.length - 1 ? " and " : ", "))
    parts.push(timePart(clock))
  })
  return parts
}

function daysPhrase(rule: ScheduleRule): string | undefined {
  if (rule.byMonth || rule.byMonthDay || rule.bySetPos) return undefined
  if (!rule.byDay) return ""
  const list = weekdayList(rule.byDay)
  return list === undefined ? undefined : list
}

function weekdayList(days: ScheduleWeekday[]): string | undefined {
  if (days.some((d) => d.nth !== undefined)) return undefined
  const set = sortedUnique(days.map((d) => d.day))
  if (set.join() === "0,1,2,3,4") return "weekday"
  if (set.join() === "5,6") return "weekend day"
  if (set.length === 7) return "day"
  return joinWords(set.map((d) => WEEKDAY_NAMES[d]!))
}

/** "weekdays", "weekends", "Mondays and Wednesdays" — for "every 2 hours … on weekdays". */
function pluralDays(days: ScheduleWeekday[]): string {
  const list = weekdayList(days)
  if (list === "weekday") return "weekdays"
  if (list === "weekend day") return "weekends"
  if (list === "day") return "every day"
  return joinWords(sortedUnique(days.map((d) => d.day)).map((d) => `${WEEKDAY_NAMES[d]}s`))
}

function monthDayPhrase(rule: ScheduleRule, dtstart: Wall): string | undefined {
  if (rule.byDay && rule.byMonthDay) return undefined
  if (rule.byDay) {
    const set = sortedUnique(rule.byDay.map((d) => d.day))
    if (rule.bySetPos) {
      if (rule.byDay.some((d) => d.nth !== undefined) || rule.bySetPos.length !== 1) return undefined
      const word = ORDINAL_WORDS[rule.bySetPos[0]!]
      const kind = set.join() === "0,1,2,3,4" ? "weekday" : set.join() === "5,6" ? "weekend day" : set.length === 1 ? WEEKDAY_NAMES[set[0]!] : undefined
      return word && kind ? `the ${word} ${kind}` : undefined
    }
    const parts = rule.byDay.map((d) => (d.nth !== undefined && ORDINAL_WORDS[d.nth] ? `the ${ORDINAL_WORDS[d.nth]} ${WEEKDAY_NAMES[d.day]}` : undefined))
    if (parts.some((p) => p === undefined)) return undefined
    return joinWords(parts as string[])
  }
  if (rule.bySetPos) return undefined
  const days = sortedUnique(rule.byMonthDay ?? [dtstart.d])
  if (days.every((d) => d > 0)) return `the ${joinWords(days.map(ordinalSuffix))}`
  if (days.length === 1 && ORDINAL_WORDS[days[0]!]) return days[0] === -1 ? "the last day" : `the ${ORDINAL_WORDS[days[0]!]} day`
  return undefined
}

function ruleText(rule: ScheduleRule): string {
  const parts = [`FREQ=${rule.freq}`]
  if (rule.interval !== 1) parts.push(`INTERVAL=${rule.interval}`)
  if (rule.byMonth) parts.push(`BYMONTH=${rule.byMonth.join(",")}`)
  if (rule.byMonthDay) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(",")}`)
  if (rule.byDay) parts.push(`BYDAY=${rule.byDay.map((d) => `${d.nth ?? ""}${WEEKDAY_CODES[d.day]}`).join(",")}`)
  if (rule.byHour) parts.push(`BYHOUR=${rule.byHour.join(",")}`)
  if (rule.byMinute) parts.push(`BYMINUTE=${rule.byMinute.join(",")}`)
  if (rule.bySetPos) parts.push(`BYSETPOS=${rule.bySetPos.join(",")}`)
  return parts.join(";")
}

/** "9am", "4:30pm", "12pm". */
export function formatClock(h: number, mi: number): string {
  const suffix = h < 12 ? "am" : "pm"
  const h12 = h % 12 === 0 ? 12 : h % 12
  return mi === 0 ? `${h12}${suffix}` : `${h12}:${pad2(mi)}${suffix}`
}

/** "Mon Oct 12, 9am" in the schedule's zone. With `nowMs`, a run in another year than now (in that zone)
 *  says its year — "Sat Jan 2, 2027, 9am" — so a yearly rule's next three runs do not read as three
 *  identical dates (plans/schedule-live-reading.md §3.5.2). */
export function formatOccurrence(ms: number, tz: string, nowMs?: number): string {
  const w = zonedWall(ms, tz)
  return `${formatOccurrenceDate(ms, tz, nowMs)}, ${formatClock(w.h, w.mi)}`
}

/** The date half of {@link formatOccurrence}: "Mon Oct 12", or "Sat Jan 2, 2027" in another year. */
function formatOccurrenceDate(ms: number, tz: string, nowMs?: number): string {
  const w = zonedWall(ms, tz)
  const weekday = WEEKDAY_NAMES[weekdayOf(dayNumber(w.y, w.mo, w.d))]!.slice(0, 3)
  const year = nowMs !== undefined && zonedWall(nowMs, tz).y !== w.y ? `, ${w.y}` : ""
  return `${weekday} ${MONTH_NAMES[w.mo - 1]!.slice(0, 3)} ${w.d}${year}`
}

// ---- local wall time ⇄ instant ------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>()
function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    })
    formatters.set(tz, f)
  }
  return f
}

const WALL_TEXT = /^(\d{1,2})\/(\d{1,2})\/(\d{4}),? (\d{1,2}):(\d{2})$/

/** The wall clock `tz` shows at `ms`, to the minute. */
export function zonedWall(ms: number, tz: string): Wall {
  const f = formatterFor(tz)
  // `format` is twice as fast as `formatToParts`, and this runs a few times per occurrence an engine
  // walk visits — the live reading walks rules on keystrokes. An engine that prints another shape
  // falls through to the parts.
  const m = WALL_TEXT.exec(f.format(new Date(ms)))
  if (m) {
    const h = parseInt(m[4]!, 10)
    return { y: parseInt(m[3]!, 10), mo: parseInt(m[1]!, 10), d: parseInt(m[2]!, 10), h: h === 24 ? 0 : h, mi: parseInt(m[5]!, 10) }
  }
  const parts = f.formatToParts(new Date(ms))
  const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10)
  const h = get("hour")
  return { y: get("year"), mo: get("month"), d: get("day"), h: h === 24 ? 0 : h, mi: get("minute") }
}

/** Offsets by zone and quarter-hour of UTC. Every offset in use since 1970 is a whole number of quarter
 *  hours and changes at a local whole or half hour, so a transition always falls ON a quarter-hour
 *  boundary and the offset is constant inside one. */
const offsetCache = new Map<string, Map<number, number>>()
const QUARTER_HOUR_MS = 900_000

function offsetAt(ms: number, tz: string): number {
  const bucket = Math.floor(ms / QUARTER_HOUR_MS)
  let zone = offsetCache.get(tz)
  const hit = ms >= 0 ? zone?.get(bucket) : undefined
  if (hit !== undefined) return hit
  const w = zonedWall(ms, tz)
  const floored = ms - (((ms % 60_000) + 60_000) % 60_000)
  const offset = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - floored
  if (ms >= 0) {
    if (!zone) offsetCache.set(tz, (zone = new Map()))
    if (zone.size >= 50_000) zone.clear()
    zone.set(bucket, offset)
  }
  return offset
}

/** The instant `tz`'s clock reads `wall`. A wall time that does not exist (the spring-forward gap) is
 *  pushed FORWARD by the gap — 02:30 becomes 03:30 — so a job still runs that day; an ambiguous one (the
 *  fall-back hour) is its FIRST instance, so it runs once. */
export function wallToInstant(wall: Wall, tz: string): number {
  const naive = Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi)
  // The two offsets in play near this wall time: the one before any transition and the one after.
  const before = offsetAt(naive - 14 * 3_600_000, tz)
  const after = offsetAt(naive + 14 * 3_600_000, tz)
  // One offset across the 28 hours around it: no transition, so the wall time exists exactly once.
  if (before === after) return naive - before
  const candidates = [...new Set([before, after])].map((off) => naive - off).sort((a, b) => a - b)
  for (const ms of candidates) {
    const got = zonedWall(ms, tz)
    if (got.y === wall.y && got.mo === wall.mo && got.d === wall.d && got.h === wall.h && got.mi === wall.mi) return ms
  }
  // In the gap: read the wall time with the offset from BEFORE the jump, which lands just past it.
  return naive - before
}

const validZones = new Map<string, boolean>()
export function isValidTimeZone(tz: string): boolean {
  if (!tz || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return false
  // Building a formatter is the slow part of compiling a rule; the live reading compiles on keystrokes.
  let ok = validZones.get(tz)
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz })
      ok = true
    } catch {
      ok = false
    }
    if (validZones.size < 256) validZones.set(tz, ok)
  }
  return ok
}

/** `YYYY-MM-DDTHH:MM` for the wall clock `tz` shows at `ms` — a schedule's default start. */
export function localWallString(ms: number, tz: string): string {
  const w = zonedWall(ms, tz)
  return `${w.y}-${pad2(w.mo)}-${pad2(w.d)}T${pad2(w.h)}:${pad2(w.mi)}`
}

// ---- small civil-date helpers ------------------------------------------------------------------------

function dayNumber(y: number, mo: number, d: number): number {
  return Math.floor(Date.UTC(y, mo - 1, d) / DAY_MS)
}

function civilFromDay(day: number): [number, number, number] {
  const date = new Date(day * DAY_MS)
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]
}

/** 0 = Monday … 6 = Sunday. Day 0 (1970-01-01) was a Thursday. */
function weekdayOf(day: number): number {
  return (((day % 7) + 7 + 3) % 7)
}

function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate()
}

function wallDay(w: Wall): [number, number, number] {
  return [w.y, w.mo, w.d]
}

function compareWall(a: Wall, b: Wall): number {
  return a.y - b.y || a.mo - b.mo || a.d - b.d || a.h - b.h || a.mi - b.mi
}

function parseWall(text: string): Wall | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::00)?$/.exec(text.trim())
  if (!m) return undefined
  const [y, mo, d, h, mi] = m.slice(1).map((s) => parseInt(s, 10)) as [number, number, number, number, number]
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || h > 23 || mi > 59) return undefined
  return { y, mo, d, h, mi }
}

function parseUntil(value: string): ScheduleRule["until"] | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value)
  if (!m) return undefined
  const y = +m[1]!, mo = +m[2]!, d = +m[3]!
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return undefined
  if (m[4] === undefined) return { kind: "local", wall: { y, mo, d, h: 23, mi: 59 } }
  const h = +m[4]!, mi = +m[5]!
  if (h > 23 || mi > 59) return undefined
  if (m[7]) return { kind: "instant", ms: Date.UTC(y, mo - 1, d, h, mi, +m[6]!) }
  return { kind: "local", wall: { y, mo, d, h, mi } }
}

function intIn(value: string, min: number, max: number): number | undefined {
  if (!/^[+-]?\d+$/.test(value)) return undefined
  const n = parseInt(value, 10)
  return n >= min && n <= max ? n : undefined
}

function intList(value: string, min: number, max: number): number[] | undefined {
  const out: number[] = []
  for (const raw of value.split(",")) {
    const n = intIn(raw.trim(), min, max)
    if (n === undefined) return undefined
    out.push(n)
  }
  return out.length ? out : undefined
}

function sortedUnique(list: number[]): number[] {
  return [...new Set(list)].sort((a, b) => a - b)
}

function joinWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ""
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`
}

function ordinalSuffix(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  return `${n}${n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th"}`
}

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error }
}
