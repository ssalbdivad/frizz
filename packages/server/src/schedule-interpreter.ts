import {
  SCHEDULE_NOT_FOUND_COPY,
  SCHEDULE_PRESENCE_COPY,
  SCHEDULE_SPACING_COPY,
  isValidTimeZone,
  localWallString,
  scheduleEcho,
  zonedWall,
  type InterpretScheduleResult,
} from "@frizz/shared"
import type { ClaudeOneShot } from "./backend/claude-oneshot.ts"
import type { ThreadScheduleRow } from "./schedule-store.ts"
import { cleanThreadName, threadNameProblem } from "./thread-names.ts"

// THE SCHEDULE INTERPRETER (plans/scheduled-threads.md §3): ONE short model call that reads what the human
// typed in the prompt box's schedule mode and finds the schedule in it. The model INTERPRETS; Frizz
// COMPUTES — it returns an RRULE and a local start, and everything the human then sees (the echo, the next
// runs) is built from that rule by schedule-rule.ts, so a mistranslated "9am" shows before it ever runs.
//
// It does NOT rewrite the prompt. It names the exact phrase it read as the schedule, and the saved prompt
// is the typed text with that phrase cut out, otherwise verbatim: Frizz prompts are often long and careful,
// and a model "distilling" one paraphrases, drops constraints or truncates (critique-ux §4).
//
// Through the same one-shot completer the thread namer uses (backend/claude-oneshot.ts): a throwaway SDK
// session with no tools, no settings and one turn. Sonnet rather than the namer's Haiku — the date
// arithmetic behind DTSTART and BYSETPOS is where a small model slips, and this runs once per schedule.

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

export function interpreterSystemPrompt(nowMs: number, tz: string): string {
  return `You read a person's words and find the SCHEDULE in them, for Frizz, which starts a fresh AI agent thread at each occurrence of a schedule. You never do the task itself.

Right now it is ${spokenNow(nowMs, tz)} (${localWallString(nowMs, tz)}) in the ${tz} time zone. Every date and time you write is local wall-clock time in that zone.

Answer with exactly ONE JSON object and nothing else: no prose, no code fence.

When there is a schedule:
{"phrase": string, "rrule": string, "dtstart": string, "condition": string or null, "title": string}

When there is not:
{"refuse": "presence" or "no_schedule", "detail": string}

phrase: the words that say WHEN, copied EXACTLY from the text — same characters, same case, one contiguous span. Include the words that limit or qualify the schedule ("unless it's a holiday", "for three weeks", "starting Monday"). Never include the task.

rrule: one RFC 5545 RRULE value without the "RRULE:" prefix, using ONLY these parts: FREQ (HOURLY, DAILY, WEEKLY, MONTHLY, YEARLY), INTERVAL, COUNT, UNTIL, BYMONTH, BYMONTHDAY, BYDAY, BYHOUR, BYMINUTE, BYSETPOS, WKST. Never BYSECOND, BYYEARDAY, BYWEEKNO, EXDATE or RDATE.
- ALWAYS give BYHOUR and BYMINUTE (FREQ=HOURLY: always BYMINUTE, and BYHOUR for a window of hours). When the text names no time of day, use 9am: BYHOUR=9;BYMINUTE=0.
- weekdays: BYDAY=MO,TU,WE,TH,FR. Weekends: BYDAY=SA,SU.
- the last day of the month: FREQ=MONTHLY;BYMONTHDAY=-1. Never write a BYMONTHDAY above 28 — count back from the month's end with a negative number instead.
- the first weekday of the month: FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1. The last Friday of the month: FREQ=MONTHLY;BYDAY=-1FR.
- every other Friday: FREQ=WEEKLY;INTERVAL=2;BYDAY=FR.
- every N hours within a window: FREQ=HOURLY;INTERVAL=N with BYHOUR listing exactly the hours that run — every 2 hours from 9 to 5 is BYHOUR=9,11,13,15,17.
- a limited run ("for three weeks", "until Christmas"): COUNT, or UNTIL as a date YYYYMMDD.
- runs must be at least 15 minutes apart.

dtstart: the local start, YYYY-MM-DDTHH:MM, at the rule's first time of day. Use today's date unless the text says when to start. It anchors INTERVAL, so for "every other Friday" use the coming Friday's date.

condition: anything the rule cannot express but the run itself can check when it starts, as a short clause that reads after the rule — "unless it's a US public holiday", "only when a release went out the day before", "only if there are new issues". The rule then fires on every candidate day and the run checks the condition first. null when there is none.

title: one or two words in sentence case naming the task's subject, at most 20 characters — "Triage issues", "Dep bumps", "CI check", "Standup digest". Not a sentence, not a bare verb.

Refuse with "presence" when WHEN depends on the person being at their computer, working, online or active ("while I'm working", "when I'm at my desk") — Frizz cannot tell that. Refuse with "no_schedule" when the text names no repetition and no time to run at.

Examples, as if today were Monday, October 5, 2026:
TEXT: every Monday at 9am triage new issues
{"phrase":"every Monday at 9am","rrule":"FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0","dtstart":"2026-10-05T09:00","condition":null,"title":"Triage issues"}
TEXT: Write the monthly changelog on the last day of every month at 5pm.
{"phrase":"on the last day of every month at 5pm","rrule":"FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=17;BYMINUTE=0","dtstart":"2026-10-05T17:00","condition":null,"title":"Changelog"}
TEXT: the day after each release, draft release notes from the merged PRs
{"phrase":"the day after each release","rrule":"FREQ=DAILY;BYHOUR=9;BYMINUTE=0","dtstart":"2026-10-05T09:00","condition":"only when a release was published the day before","title":"Release notes"}
TEXT: while I'm working, keep an eye on CI
{"refuse":"presence","detail":"depends on whether the person is working"}`
}

function userPrompt(text: string, existing?: Pick<ThreadScheduleRow, "when_text" | "rrule" | "dtstart" | "condition" | "title">): string {
  const body = `TEXT:\n<<<\n${text}\n>>>`
  if (!existing) return body
  return [
    `This changes WHEN an existing schedule runs. It currently runs "${existing.when_text}" — rule ${existing.rrule}, start ${existing.dtstart}, condition: ${existing.condition ? `"${existing.condition}"` : "none"}, title "${existing.title}".`,
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

/** Where `phrase` sits in `text`: exactly, else ignoring case. */
export function locatePhrase(text: string, phrase: string): { start: number; end: number } | undefined {
  const p = phrase.trim()
  if (!p) return undefined
  let at = text.indexOf(p)
  if (at < 0) at = text.toLowerCase().indexOf(p.toLowerCase())
  return at < 0 ? undefined : { start: at, end: at + p.length }
}

/** `text` with [start, end) cut out and the seam tidied — the dangling comma or dash the phrase leaves —
 *  and NOTHING else changed. */
export function cutPhrase(text: string, start: number, end: number): string {
  const before = text.slice(0, start).replace(/[\s,;:–—-]+$/u, "")
  const after = text.slice(end).replace(/^[\s,;:–—-]+/u, "")
  if (!before.trim()) return after.trim()
  if (!after.trim()) return before.trim()
  return `${before}${/^[.!?)]/.test(after) ? "" : " "}${after}`.trim()
}

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
      const system = interpreterSystemPrompt(nowMs, tz)
      let prompt = userPrompt(text, existing)
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
          prompt = `${userPrompt(text, existing)}\n\nYour previous answer was:\n${raw.trim().slice(0, 2000)}\nIt was rejected: ${problem} Answer again with one JSON object.`
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
        const saved = existing ? "" : cutPhrase(text, span.start, span.end)
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
