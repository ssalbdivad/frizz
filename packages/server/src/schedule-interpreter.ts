import {
  SCHEDULE_NOT_FOUND_COPY,
  SCHEDULE_PRESENCE_COPY,
  SCHEDULE_SPACING_COPY,
  cutPhrase,
  isValidTimeZone,
  localWallString,
  locatePhrase,
  scheduleEcho,
  zonedWall,
  type InterpretScheduleResult,
} from "@frizz/shared"
import type { ClaudeOneShot } from "./backend/claude-oneshot.ts"
import type { ThreadScheduleRow } from "./schedule-store.ts"
import { cleanThreadName, threadNameProblem } from "./thread-names.ts"

// THE SCHEDULE INTERPRETER (plans/scheduled-threads.md §3): ONE short model call that decides whether what
// the human typed into the prompt box asks for its task to REPEAT on a schedule, and if it does, finds the
// schedule in it. The model INTERPRETS; Frizz COMPUTES — it returns an RRULE and a local start, and
// everything the human then sees (the echo, the next runs) is built from that rule by schedule-rule.ts, so
// a mistranslated "9am" shows before it ever runs.
//
// It reads ORDINARY prompts. There is no schedule button and no mode (maintainer 2026-10-06): the box asks
// whenever a prompt holds one of the trigger words (@frizz/shared schedule-trigger.ts), and most such
// prompts are not schedules — "fix the bug from this morning", "why did the nightly build fail?",
// "summarize every PR merged this week". So the first thing the prompt teaches is INTENT: only a request
// that the task itself recur on the clock or calendar is a schedule. A time in the past, a deadline, a set
// the task covers once, software the task builds that runs on a schedule, a single later time, a repeat
// tied to an event, and quoted words are all `no_schedule`. "Change when" (`existing`) is the exception:
// there the whole text is a WHEN by construction.
//
// It does NOT rewrite the prompt. It names the exact phrase it read as the schedule, and the saved prompt
// is the typed text with that phrase cut out, otherwise verbatim: Frizz prompts are often long and careful,
// and a model "distilling" one paraphrases, drops constraints or truncates (critique-ux §4).
//
// The SYSTEM PROMPT IS STATIC; the clock and the zone ride in the user message. That is what lets the
// completer keep a CLI started ahead of the next read (claude-oneshot.ts `spare`, whose options — the
// system prompt among them — are fixed when it starts), and lets a model that caches the prefix reuse it.
//
// Through the same one-shot completer the thread namer uses (backend/claude-oneshot.ts): a throwaway SDK
// session with no tools, no settings, no MCP servers and one turn.
//
// THE MODEL, measured by scripts/schedule-extract-eval.ts (see its header for how to re-run it):
// MODEL_CHOICE_PLACEHOLDER

export const SCHEDULE_INTERPRETER_MODEL = "sonnet"

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

/** "Monday, October 5, 2026, 2:32pm" in `tz`. */
function spokenNow(nowMs: number, tz: string): string {
  const w = zonedWall(nowMs, tz)
  const day = Math.floor(Date.UTC(w.y, w.mo - 1, w.d) / 86_400_000)
  const weekday = WEEKDAYS[(((day + 3) % 7) + 7) % 7]! // 1970-01-01 was a Thursday (index 3)
  const h12 = w.h % 12 === 0 ? 12 : w.h % 12
  return `${weekday}, ${MONTHS[w.mo - 1]} ${w.d}, ${w.y}, ${h12}:${String(w.mi).padStart(2, "0")}${w.h < 12 ? "am" : "pm"}`
}

/** The line that tells the model when and where it is reading — the only part of a read that changes with
 *  the clock, so it opens the user message rather than the system prompt. */
export function interpreterClock(nowMs: number, tz: string): string {
  return `Now: ${spokenNow(nowMs, tz)} (${localWallString(nowMs, tz)}) in the ${tz} time zone. Every date and time you write is local wall-clock time in that zone.`
}

export function interpreterSystemPrompt(): string {
  return `You read a prompt someone typed into Frizz, which starts AI agent threads, and decide whether it asks for its task to RUN ON A REPEATING SCHEDULE. Almost every prompt is a task to start now. A schedule is a prompt asking for its task to be done again and again at times on the clock or calendar — "every Monday at 9am triage new issues" — and Frizz then starts a fresh thread with the task at each of those times. You never do the task.

Answer with exactly ONE JSON object and nothing else: no prose, no code fence.

A schedule:
{"phrase": string, "rrule": string, "dtstart": string, "condition": string or null, "title": string}

Not a schedule:
{"refuse": "no_schedule" or "presence", "detail": string}

DECIDE FIRST. Words of time never make a schedule by themselves; only a request that the task itself recur does. Answer no_schedule when the time words:
- describe the past, a deadline, or a thing: "the deploy broke last night", "Monday's release", "have it ready by Friday", "the daily digest email is broken"
- pick out what the task covers, once: "every file in src", "each failing test", "the PRs merged this week"
- describe software the task builds, changes or asks about, even when that software runs on a schedule: "add a workflow that runs nightly", "move the backup job to Sundays", "why does the cron fire hourly?"
- name one later time and no repetition: "Friday at 3pm deploy the release"
- tie the repeat to an event instead of the clock: "every time CI fails, fix it", "after each deploy, run the smoke tests"
- sit inside quotes or code.
Answer "presence" when WHEN depends on the person being at their computer, working or online ("while I'm working", "when I'm at my desk"): Frizz cannot tell that.

When it IS a schedule:

phrase: the words that say WHEN, copied EXACTLY from the text — same characters, same case, one contiguous span, wherever it sits (start, middle or end). Include the words that limit or qualify the schedule ("unless it's a holiday", "for three weeks", "starting Monday"). Never include the task.

rrule: one RFC 5545 RRULE value without the "RRULE:" prefix, using ONLY these parts: FREQ (HOURLY, DAILY, WEEKLY, MONTHLY, YEARLY), INTERVAL, COUNT, UNTIL, BYMONTH, BYMONTHDAY, BYDAY, BYHOUR, BYMINUTE, BYSETPOS, WKST. Never BYSECOND, BYYEARDAY, BYWEEKNO, EXDATE or RDATE.
- ALWAYS give BYHOUR and BYMINUTE (FREQ=HOURLY: always BYMINUTE, and BYHOUR for a window of hours).
- times the text does not give: no time of day is 9am; morning 9am; afternoon 2pm; evening 6pm; night, nightly and tonight 9pm; end of day 5pm. A bare hour with no am or pm: 7 to 11 is am and 12 to 6 is pm, unless a word beside it says otherwise ("at 2 at night" is 2am, "evenings at 8" is 8pm).
- days the text does not give: weekly is Monday; monthly is the 1st; hourly is on the hour.
- weekdays and business days: BYDAY=MO,TU,WE,TH,FR. Weekends: BYDAY=SA,SU.
- the last day of the month: FREQ=MONTHLY;BYMONTHDAY=-1. Never write a BYMONTHDAY above 28 — count back from the month's end with a negative number instead.
- the first weekday of the month: FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1. The last business day: the same with BYSETPOS=-1. The last Friday of the month: FREQ=MONTHLY;BYDAY=-1FR.
- quarters: FREQ=MONTHLY;INTERVAL=3 or FREQ=YEARLY;BYMONTH=1,4,7,10 (or 3,6,9,12 for a quarter's end).
- every other Friday: FREQ=WEEKLY;INTERVAL=2;BYDAY=FR.
- every N minutes: FREQ=HOURLY;BYMINUTE= the minutes that are multiples of N — every 20 minutes is BYMINUTE=0,20,40.
- every N hours within a window: FREQ=HOURLY;INTERVAL=N with BYHOUR listing exactly the hours that run — every 2 hours from 9 to 5 is BYHOUR=9,11,13,15,17.
- several times a day: BYHOUR lists them, sharing one BYMINUTE.
- a limited run ("for three weeks", "until Christmas"): COUNT, or UNTIL as a date YYYYMMDD.
- runs must be at least 15 minutes apart.

dtstart: the FIRST run, as local YYYY-MM-DDTHH:MM — the earliest time the rule fires after now, or after the start the text names. It anchors INTERVAL: "every other Friday" starts on the coming Friday, "every 3 days at 9am" at the next 9am, "every 4 hours" at the next whole hour. A time named in another zone ("9am Pacific") is converted into this zone.

condition: anything the rule cannot express but the run itself can check when it starts, as a short clause that reads after the rule — "unless it's a US public holiday", "only when a release went out the day before", "only if there are new issues". The rule then fires on every candidate day and the run checks the condition first. null when there is none.

title: one or two words in sentence case naming the task's subject, at most 20 characters — "Triage issues", "Dep bumps", "CI check", "Standup digest". Not a sentence, not a bare verb.

Examples, as if it were Monday, October 5, 2026, 2:32pm:
TEXT: every Wednesday at 11am review the stale PRs
{"phrase":"every Wednesday at 11am","rrule":"FREQ=WEEKLY;BYDAY=WE;BYHOUR=11;BYMINUTE=0","dtstart":"2026-10-07T11:00","condition":null,"title":"Stale PRs"}
TEXT: Write the monthly changelog on the last day of every month at 5pm.
{"phrase":"on the last day of every month at 5pm","rrule":"FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=17;BYMINUTE=0","dtstart":"2026-10-31T17:00","condition":null,"title":"Changelog"}
TEXT: Redeploy staging from main every weekday at 10am, unless it's a US holiday
{"phrase":"every weekday at 10am, unless it's a US holiday","rrule":"FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=10;BYMINUTE=0","dtstart":"2026-10-06T10:00","condition":"unless it's a US public holiday","title":"Staging deploy"}
TEXT: fix the flaky checkout test that failed this morning
{"refuse":"no_schedule","detail":"a past time; nothing repeats"}
TEXT: add a workflow that runs the linter every night
{"refuse":"no_schedule","detail":"builds something scheduled, once"}
TEXT: while I'm working, keep an eye on CI
{"refuse":"presence","detail":"depends on whether the person is working"}`
}

function userPrompt(text: string, clock: string, existing?: Pick<ThreadScheduleRow, "when_text" | "rrule" | "dtstart" | "condition" | "title">): string {
  const body = `${clock}\n\nTEXT:\n<<<\n${text}\n>>>`
  if (!existing) return body
  return [
    `This changes WHEN an existing schedule runs, so the TEXT is a schedule: answer no_schedule only if it names no time and no repetition. It currently runs "${existing.when_text}" — rule ${existing.rrule}, start ${existing.dtstart}, condition: ${existing.condition ? `"${existing.condition}"` : "none"}, title "${existing.title}".`,
    "The whole TEXT is the new when-phrase: return it as `phrase`. Keep the condition unless the new words change or drop it, and keep the title.",
    body,
  ].join("\n\n")
}

/** The first JSON object in a model's answer. */
function parseAnswer(raw: string): Record<string, unknown> | undefined {
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start < 0 || end <= start) return undefined
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

// `locatePhrase` and `cutPhrase` live in @frizz/shared since the live reading: the browser cuts the prompt it
// shows as "Each run:" with the same function the server saves it with.

export interface ScheduleInterpreter {
  /** `tz` is the zone the rule is read in; `viewerTz` the zone the human reads the preview in (the
   *  browser's), so a "Change when" on a schedule kept in another zone previews with the same
   *  "<City> time" suffix the saved echo will carry. Defaults to `tz`. */
  interpret(input: { text: string; tz: string; existing?: ThreadScheduleRow; viewerTz?: string }): Promise<InterpretScheduleResult>
}

export function createScheduleInterpreter(deps: { complete?: ClaudeOneShot; now?: () => number; model?: string }): ScheduleInterpreter {
  const now = deps.now ?? Date.now
  return {
    async interpret({ text, tz, existing, viewerTz }) {
      if (!deps.complete) return { ok: false, error: "Reading a schedule needs Claude, which this server has switched off." }
      if (!isValidTimeZone(tz)) return { ok: false, error: `"${tz}" is not a time zone Frizz knows.` }
      const nowMs = now()
      const system = interpreterSystemPrompt()
      const clock = interpreterClock(nowMs, tz)
      let prompt = userPrompt(text, clock, existing)
      let lastProblem = SCHEDULE_NOT_FOUND_COPY
      for (let attempt = 0; attempt < 2; attempt++) {
        let raw: string
        try {
          raw = await deps.complete({ system, prompt, model: deps.model ?? SCHEDULE_INTERPRETER_MODEL })
        } catch (error) {
          return { ok: false, error: `Couldn't read that just now: ${error instanceof Error ? error.message : String(error)}` }
        }
        const answer = parseAnswer(raw)
        const retry = (problem: string, human = SCHEDULE_NOT_FOUND_COPY) => {
          lastProblem = human
          prompt = `${userPrompt(text, clock, existing)}\n\nYour previous answer was:\n${raw.trim().slice(0, 2000)}\nIt was rejected: ${problem} Answer again with one JSON object.`
        }
        if (!answer) {
          retry("it was not one JSON object.")
          continue
        }
        if (answer.refuse === "presence") return { ok: false, error: SCHEDULE_PRESENCE_COPY }
        if (answer.refuse !== undefined) return { ok: false, error: SCHEDULE_NOT_FOUND_COPY }
        const rrule = typeof answer.rrule === "string" ? answer.rrule.trim().replace(/^RRULE:/i, "") : ""
        const dtstart = typeof answer.dtstart === "string" ? answer.dtstart.trim() : ""
        const phrase = typeof answer.phrase === "string" ? answer.phrase : ""
        const condition = typeof answer.condition === "string" && answer.condition.trim() ? answer.condition.trim() : undefined
        if (!rrule || !dtstart) {
          retry("it gave no rrule or no dtstart.")
          continue
        }
        const hourly = /FREQ=HOURLY/i.test(rrule)
        if (!/BYMINUTE=/i.test(rrule) || (!hourly && !/BYHOUR=/i.test(rrule))) {
          retry("the rrule must name BYHOUR and BYMINUTE (FREQ=HOURLY: at least BYMINUTE).")
          continue
        }
        // Change when: the whole text is the phrase, and nothing is cut out of a prompt.
        const span = existing ? { start: 0, end: text.length } : locatePhrase(text, phrase)
        if (!span) {
          retry(`"phrase" must be copied exactly from TEXT, and "${phrase.slice(0, 120)}" is not in it.`)
          continue
        }
        const title = existing?.title
          ?? (typeof answer.title === "string" ? cleanThreadName(answer.title) : undefined)
          ?? "Scheduled run"
        const checked = scheduleEcho({ title, rrule, dtstart, tz, condition }, nowMs, viewerTz ?? tz)
        if (!checked.ok) {
          if (/less than 15 minutes apart/i.test(checked.error)) return { ok: false, error: SCHEDULE_SPACING_COPY }
          retry(checked.error, `Couldn't turn that into a schedule: ${checked.error}`)
          continue
        }
        const { compiled: _c, ...preview } = checked.value
        const saved = existing ? "" : cutPhrase(text, span)
        if (!existing && !saved) {
          return { ok: false, error: "What should each run do? Add the task after the schedule, like “every Monday at 9am triage new issues”." }
        }
        return {
          ok: true,
          phrase: text.slice(span.start, span.end),
          phraseStart: span.start,
          phraseEnd: span.end,
          prompt: saved,
          whenText: text.slice(span.start, span.end).trim(),
          rrule,
          dtstart,
          tz,
          ...(condition ? { condition } : {}),
          title: threadNameProblem(title) ? "Scheduled run" : title,
          preview,
        }
      }
      return { ok: false, error: lastProblem }
    },
  }
}
