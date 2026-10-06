// ---- THE SCHEDULE TRIGGER -------------------------------------------------------------------------------------
// The prompt box has no schedule button and no mode (maintainer 2026-10-06: "it should determine intent from
// the standard prompt submission … look for certain common scheduling words (every, morning etc.) and if they
// appear, run a lightweight agent to extract a schedule from the text"). This is that look: a closed list of
// words, matched whole and case-insensitively. Text without one of them never reaches the model and the box
// looks exactly as it does without schedules; text with one gets a model read that decides whether the human
// asked for the work to REPEAT (packages/server/src/schedule-interpreter.ts).
//
// It is deliberately a GATE, not a reading. A trigger costs one model call and nothing the human sees until
// the model answers that there is a schedule — so a broad list ("night" also fires on "the build broke last
// night") only spends calls, while a missing word means a schedule typed without it is dispatched as a plain
// thread. The list was checked against both directions in scripts/schedule-extract-eval.ts, which reports how
// often it fires on the maintainer's own past prompts.
//
// Not read: the runs the box already excludes and passes as `exclude` (fenced code, staged context tokens,
// @mentions, /commands), plus fenced and inline code, quoted text and a leading /command found here, so a call
// that passes nothing still skips them. Quoting is the human's escape — `"every Monday"` names the words, it
// does not ask for them. An unclosed quote or backtick is a quotation still being typed: nothing after it is
// read, so typing `"every Monday at 9am"` does not fire a read halfway and retract it when the quote closes.

/** Lowercase; each entry is matched as a whole word. Plurals are listed, not inferred. */
export const SCHEDULE_TRIGGER_WORDS = [
  "every", "each",
  "daily", "nightly", "hourly", "weekly", "biweekly", "fortnightly", "monthly", "quarterly", "yearly", "annually",
  "weekday", "weekdays", "weekend", "weekends", "weeknight", "weeknights",
  "morning", "mornings", "afternoon", "afternoons", "evening", "evenings", "night", "nights",
  "noon", "midnight",
  "monday", "mondays", "tuesday", "tuesdays", "wednesday", "wednesdays", "thursday", "thursdays",
  "friday", "fridays", "saturday", "saturdays", "sunday", "sundays",
] as const

export type ScheduleTriggerWord = (typeof SCHEDULE_TRIGGER_WORDS)[number]

/** A word: not touching another letter, digit or underscore on either side ("everything", "Mondays2" and
 *  "each_file" are not triggers; "bi-weekly" and "Monday's" are). */
const TRIGGER_SOURCE = `(?<![\\p{L}\\p{N}_])(?:${[...SCHEDULE_TRIGGER_WORDS].sort((a, b) => b.length - a.length).join("|")})(?![\\p{L}\\p{N}_])`
/** For `test`: not global, so it keeps no `lastIndex` between calls. */
const TRIGGER_ONE = new RegExp(TRIGGER_SOURCE, "iu")
/** For `matchAll` only, which iterates a clone and never moves this one's `lastIndex`. */
const TRIGGER_ALL = new RegExp(TRIGGER_SOURCE, "giu")

const FENCE = /```[\s\S]*?(?:```|$)/g
const INLINE_CODE = /`[^`\n]*`/g
/** Quote pairs: the other typographies' first, since „ … “ closes on an English opener. */
const QUOTES = [
  /„[^“”\n]*[“”]|‚[^‘’\n]*[‘’]|«[^»\n]*»|»[^«\n]*«|‹[^›\n]*›|›[^‹\n]*‹|「[^」\n]*」|『[^』\n]*』/g,
  /"[^"\n]*"/g,
  /“[^”\n]*”/g,
  // Single curly quotes. The closer is also the apostrophe ("it’s"), so a pair ends at the first one.
  // Straight single quotes are never read as quotes: they are apostrophes far more often.
  /‘[^’\n]*’/g,
]
const UNCLOSED_OPENERS = ['"', "“", "`", "„", "«", "「", "『"]
const LEADING_COMMAND = /^\s*\/[a-z][\w:.-]*/i

/** `text` with every unread character replaced by a same-length non-word mark, so offsets survive. */
function masked(text: string, exclude: readonly { readonly start: number; readonly end: number }[]): string {
  let s = text
  const mask = (start: number, end: number) => {
    const a = Math.max(0, start), b = Math.min(s.length, end)
    if (b > a) s = s.slice(0, a) + "\u0001".repeat(b - a) + s.slice(b)
  }
  for (const span of exclude) mask(span.start, span.end)
  const command = LEADING_COMMAND.exec(s)
  if (command) mask(command[0].length - command[0].trimStart().length, command[0].length)
  for (const re of [FENCE, INLINE_CODE, ...QUOTES]) s = s.replace(re, (m) => "\u0001".repeat(m.length))
  for (const open of UNCLOSED_OPENERS) {
    const at = s.indexOf(open)
    if (at >= 0) mask(at, s.length)
  }
  return s
}

/** Where each trigger word sits, in order — for a cue on the word itself while its read is in flight. */
export function scheduleTriggerSpans(
  text: string,
  exclude: readonly { readonly start: number; readonly end: number }[] = [],
): { start: number; end: number; word: ScheduleTriggerWord }[] {
  const s = masked(text, exclude)
  return [...s.matchAll(TRIGGER_ALL)].map((m) => ({ start: m.index, end: m.index + m[0].length, word: m[0].toLowerCase() as ScheduleTriggerWord }))
}

/** Whether `text` holds a schedule word outside the runs it never reads. `exclude` is the caller's own
 *  unread runs as half-open character offsets [start, end). */
export function hasScheduleTrigger(text: string, exclude: readonly { readonly start: number; readonly end: number }[] = []): boolean {
  return TRIGGER_ONE.test(masked(text, exclude))
}
