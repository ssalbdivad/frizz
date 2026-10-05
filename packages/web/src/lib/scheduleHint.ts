// THE PROMPT BOX'S SCHEDULE HINT (plans/scheduled-threads.md §3): when what the human is typing STARTS
// with a recurrence phrase — "every Monday at 9am …", "weekdays at 8 …", "on Fridays …" — the box's
// schedule button lights, and its tooltip offers the chord. That is all it does. Enter still dispatches,
// and nothing is ever converted on its own: "every time the build fails, fix it" is a dispatch, and so is
// any text this reads wrong. A miss costs a button that stays dark; a false light costs a glance.
//
// So it is deliberately a SHAPE test on the opening words, not an interpreter: the server's interpreter
// (`interpretSchedule`) is the one reader of when, and it runs only when the human asks it to.

const WEEKDAY = "(?:mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun)(?:day)?|(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)"
// What can follow "every"/"each" and still be a calendar, not a set of things ("every file", "each PR").
const UNIT = "minute|min|hour|hr|day|night|morning|afternoon|evening|weekday|weeknight|weekend|business day|workday|working day|week|fortnight|month|quarter|year"
const ORDINAL = "other|second|third|fourth|first|last|\\d+(?:st|nd|rd|th)?|two|three|four|five|six|ten|fifteen|twenty|thirty"

const OPENERS: readonly RegExp[] = [
  // every Monday · each morning · every 2 hours · every other Friday · every first weekday of the month
  new RegExp(`^(?:every|each)\\s+(?:(?:${ORDINAL})\\s+)?(?:${UNIT}|${WEEKDAY})s?\\b`, "i"),
  // daily … · weekdays … · weeknights … — the adverb on its own, not "daily-driver" or "weekly's"
  /^(?:daily|nightly|hourly|weekly|biweekly|fortnightly|monthly|quarterly|yearly|annually|weekdays|weeknights|weekends)(?![\w'’-])/i,
  // on Mondays · on weekdays · on the first of the month
  new RegExp(`^on\\s+(?:(?:${WEEKDAY})s|weekdays|weeknights|weekends|the\\s+(?:${ORDINAL}|\\d{1,2})\\b)`, "i"),
  // Mondays at 9 · Fridays, …
  new RegExp(`^(?:${WEEKDAY})s\\b`, "i"),
  // tomorrow at 8 · tonight at 11 · tomorrow morning
  /^(?:tomorrow|tonight|today)\s+(?:at|morning|afternoon|evening|night)\b/i,
  // twice a day · once a week · three times a week
  /^(?:once|twice|three\s+times|\d+\s+times)\s+(?:a|an|per|every|each)\s+(?:day|week|month|hour|year)\b/i,
  // at 9am every day · at 17:30 on weekdays
  /^at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*(?:every|each|daily|on|weekdays)\b/i,
]

/** Whether the typed text OPENS with a recurrence phrase — the cue that lights the schedule button. */
export function startsWithRecurrence(text: string): boolean {
  const head = text.trimStart().slice(0, 120)
  if (!head) return false
  return OPENERS.some((re) => re.test(head))
}
