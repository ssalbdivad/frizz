// ---- THE LOCAL SCHEDULE GRAMMAR ---------------------------------------------------------------------------
// plans/schedule-live-reading.md §3. Reads the schedule phrase out of what a human typed — "every Monday at
// 9am triage new issues" — with no model, in a millisecond, byte-identically in the browser, in node tests
// and on the server (which re-derives a local reading before it creates anything, §10.1).
//
// It answers in kinds, and the kinds are the whole safety story:
// - `exact`: a span, an RRULE and a local start that `checkSchedule` accepts, plus which parts it ASSUMED
//   (a 9am nobody typed, the pm of "at 3", the Monday of "weekly") so the box can dim them.
// - `cue`: schedule words it will not guess at (a condition, a vague count, a zone, a value the engine or
//   the describer cannot take, a second rule, a leftover schedule word, a typo). The model reads those,
//   and only after the human asked for a schedule. A cue may carry the `core` it IS sure of.
// - `ambiguous`: a word with two common meanings ("biweekly"); the human has to say which.
// - `event` / `presence`: "every time the build fails", "while I'm working". Schedules run on the clock;
//   these get a local refusal and never reach the model (Sonnet turned the first into an hourly poll).
//
// The rule it must never break: IT NEVER EATS A PREFIX. rrule.js read "every weekday at 9am except
// holidays" as every weekday at 9am, the limit silently gone. Here any qualifier-shaped word near the
// phrase either becomes part of the span in a family read fully (bounds and starts: "for 3 weeks",
// "until Oct 30", "starting Monday") or turns the reading into a cue — pinned by a property test over
// every positive × every qualifier.
//
// Where it reads (`scope`): the prompt box outside schedule mode reads only the opening and closing
// sentence windows (240 characters each, so a 20k prompt costs what a short one does) and offers only a
// phrase at an EDGE; inside the mode it reads the first phrase anywhere; the "Change when" field and the
// server's re-derive need the WHOLE string to be the phrase. Quotes, backticks, code fences and the runs
// the caller excludes (mentions, /commands, context tokens) are never read: quoting is the human's escape.
//
// A rewrite, not a copy, of the probe sketch (live-preview-latency/grammar.ts), which read 84 of 86
// simple and mid phrasings right with none silently wrong — measured by the same hand that wrote the
// corpus, so an upper bound.

import {
  checkSchedule,
  compileSchedule,
  describeSchedule,
  localWallString,
  occurrencesAfter,
  occurrencesBetween,
  SCHEDULE_MIN_SPACING_MS,
  wallToInstant,
  zonedWall,
  type CompiledSchedule,
} from "./schedule-rule.ts"
import { THREAD_HANDLE_MAX_CHARS, threadHandle } from "./thread-handle.ts"

/** Bumped whenever a phrase could read differently. A local reading carries it to the server, which
 *  refuses a skew rather than re-reading with a different grammar (§1.3.4, §10.1).
 *  2 — fix round 1 (2026-10-06): a night's clock, an ordinal's unit, zones, the broad qualifiers, the edge
 *  guards; "every night at 2" read 2pm under 1 and 2am under 2.
 *  3 — fix round 2 (2026-10-06): the closed-class words after a phrase, a count before an adverb, a limiting
 *  adjective before a day, abbreviated calendar words, more zones, spelled and second clocks; "every hour at
 *  half past" read :00 under 2 and is a cue under 3.
 *  4 — fix round 3 (2026-10-06): the temporal residue (a word of time anywhere outside the phrase makes the
 *  reading a cue), a cue's unread words far from its phrase, the day "next Tuesday", "tonight" after midnight and
 *  "Friday at midnight" assume, spelled ordinals, quarter hours, a second clock, file names, a statement's
 *  subject, more quote pairs, linear reads; "every Monday at 9am triage new issues (PT)" read 9am New York under
 *  3 and is a zone cue under 4. */
export const SCHEDULE_GRAMMAR_VERSION = 4

export type Span = { start: number; end: number }
export type Edge = "open" | "close" | "inside" | "field"
export type Assumed =
  /** "9am": nothing typed (no `word`), or a time-of-day word read as a clock ("morning" → 9am). */
  | { part: "time"; shown: string; word?: string }
  /** "at 3" read as "3pm"; `other` is the reading it did not take, `span` the typed number. */
  | { part: "meridiem"; shown: string; other: string; span: Span }
  /** "weekly" read as Monday, "monthly" as the 1st. Fix round 3: a day the words name two ways — "next
   *  Tuesday" said early in the week, "tonight at 2" said after midnight, "Friday at midnight" — is read one way
   *  and marked: `tip` says which day it took and how to say the other, and `shift` is the other reading as
   *  every run moved by that many days (7, 1, 1), which a faithful model reading may take (§4.3). */
  | { part: "day"; shown: string; tip?: string; shift?: number }

export type CueWhy = "condition" | "event-offset" | "vague" | "zone" | "unsupported" | "compound" | "leftover" | "typo"

export type PhraseReading =
  | {
      kind: "exact"
      edge: Edge
      span: Span
      phrase: string
      rrule: string
      dtstart: string
      /** COUNT=1: a one-off run. */
      once: boolean
      assumed: Assumed[]
      /** It compiles but runs closer than 15m apart, which `checkSchedule` refuses. */
      spacing?: true
      /** A close-edge reading the edge guards turned down (§2.3): a deadline word just before it ("by
       *  every Friday"), or a sentence ABOUT a schedule ("add a GitHub Action that runs … every Monday").
       *  Never offered; the rail glyph may still hint. */
      veto?: "deadline" | "about"
    }
  | {
      kind: "cue"
      edge: Edge
      span: Span
      phrase: string
      /** The part it IS sure of. */
      core?: { span: Span; rrule: string; dtstart: string; assumed: Assumed[] }
      /** The words it will not guess at. */
      unread: Span
      why: CueWhy
    }
  | { kind: "ambiguous"; edge: Edge; span: Span; word: string; copy: string }
  | { kind: "presence"; span: Span }
  | { kind: "event"; span: Span }
  | { kind: "none" }

export interface ReadPhraseOptions {
  nowMs: number
  tz: string
  /** `edges`: the prompt box outside schedule mode — the two sentence windows, edge phrases only.
   *  `anywhere`: the prompt box in the mode — the first phrase anywhere (≤4k chars; past that, the windows).
   *  `field`: "Change when" and the server's re-derive — the WHOLE string must be the phrase. */
  scope: "edges" | "anywhere" | "field"
  /** Runs never read: the Composer's fenced code, @mentions, /commands and staged context tokens. */
  exclude?: readonly Span[]
}

export const SCHEDULE_AMBIGUOUS_COPY = {
  biweekly: "“Biweekly” can mean every 2 weeks or twice a week. Say which.",
  bimonthly: "“Bimonthly” can mean every 2 months or twice a month. Say which.",
  weeknights: "“Weeknights” can start on Sunday or Monday. Say which days, like “Monday to Thursday at 10pm”.",
  quarterly: "“Quarterly” needs a day, like “on the first weekday of every quarter”.",
} as const

/** A window's most characters; the read's cost is flat whatever the prompt's length (§2.2). */
const WINDOW_MAX = 240
/** Past this, even `anywhere` reads only the windows. */
const ANYWHERE_MAX = 4000
/** What an excluded or quoted character becomes for the matchers: not a word, not a space. */
const MASK = "\u0001"

// ---- the vocabulary -----------------------------------------------------------------------------------------

const NUM_WORDS: Record<string, number> = {
  "forty-five": 45, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, ninety: 90,
}
const NUM = `(?:\\d{1,4}|${Object.keys(NUM_WORDS).join("|")})(?![\\w-])`
const numOf = (s: string): number => (/^\d/.test(s) ? parseInt(s, 10) : NUM_WORDS[s.trim()] ?? NaN)

const WD_NAME = "(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)"
const WD_ABBR = "(?:tues|tue|weds|wed|thurs|thur|thu|mon|fri|sat|sun)"
/** A weekday, singular or plural, full or abbreviated — never a possessive ("Monday's"). An abbreviation
 *  takes its own dot ("every Wed. at 3"), which is not the sentence's (`sentenceEnd`). */
const WD = `(?:${WD_NAME}s?|${WD_ABBR}\\.?)(?![\\w'’])`
const WD_ONE = `(?:${WD_NAME}|${WD_ABBR}\\.?)(?![\\w'’])`
const WD_PLURAL = `${WD_NAME}s(?![\\w'’])`
const LIST_SEP = "(?:\\s*,\\s*(?:and\\s+|&\\s*)?|\\s+and\\s+|\\s*&\\s*|\\s*/\\s*)"
const WD_LIST = `${WD}(?:${LIST_SEP}(?:(?:every|each|on)\\s+)?${WD})*`
const WEEKDAY_CLASS = "(?:week\\s?days?|work\\s?days?|business\\s+days?|working\\s+days?)"
const WEEKEND_CLASS = "(?:weekend\\s+days?|weekends?)"
const MONTH = "(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)(?![a-z])\\.?"
const DAYN = "\\d{1,2}(?:st|nd|rd|th)?(?![\\d:])"
/** A month's day spelled out, "first" to "thirty-first" (fix round 3: "every fifteenth of the month" was refused
 *  as an event, and "on the fifteenth" read as no day at all). */
const SPELLED_ORDS = [
  "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth", "thirteenth",
  "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth", "twentieth", "twenty-first", "twenty-second",
  "twenty-third", "twenty-fourth", "twenty-fifth", "twenty-sixth", "twenty-seventh", "twenty-eighth", "twenty-ninth", "thirtieth", "thirty-first",
]
const spelled = (list: string[]) => `(?:${[...list].reverse().map((w) => w.replace("-", "[\\s-]")).join("|")})`
const SPELLED_ORD = spelled(SPELLED_ORDS)
/** A month's day as an ordinal: "15th", or spelled. "First" to "third" are as often a try's or a review's ("on
 *  the first try"), so those three are a day only where a day can stand: before a boundary, "of", "and", "at",
 *  "day", a span's "to"/"through" ("on the first", "the third of the month", "the first and fifteenth"). */
const DAY_ORD = `(?:\\d{1,2}(?:st|nd|rd|th)|(?:first|second|third)(?=\\s*(?:$|[,;:.!?)\\n—–\\u0001]|(?:of|and|at|day|to|through|thru)(?![\\w'’])|&|-))|${spelled(SPELLED_ORDS.slice(3))}(?![\\w'’-]))`
const DAY_LIST = `${DAY_ORD}(?:\\s*(?:,\\s*and|,|and|&)\\s*(?:the\\s+)?${DAY_ORD})*`
const SPELLED_ORD_RE = new RegExp(`\\d{1,2}|${SPELLED_ORD}`, "g")
/** The days a list of ordinals names: "1st and 15th", "first and fifteenth". */
function ordinalDays(list: string): number[] {
  return [...list.matchAll(SPELLED_ORD_RE)].map((x) => (/^\d/.test(x[0]) ? parseInt(x[0], 10) : SPELLED_ORDS.indexOf(x[0].replace(/\s+/, "-")) + 1))
}
const ORD = "(?:first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th)"
const ORD_LIST = `${ORD}(?:\\s*(?:,\\s*and|,|and|&)\\s*(?:the\\s+)?${ORD})*`
const OF_MONTH = "of\\s+(?:every|each|the|a)\\s+month"
const END = "(?![\\w'’])"

const ORD_VALUE: Record<string, number> = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, fifth: 5, "5th": 5, last: -1 }
const DAY_CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
const WEEKDAYS = [0, 1, 2, 3, 4]
const WEEKEND = [5, 6]

function dayIndex(token: string): number {
  return ["mo", "tu", "we", "th", "fr", "sa", "su"].indexOf(token.slice(0, 2))
}
const WD_GLOBAL = new RegExp(`\\b${WD}`, "g")
function daysIn(s: string): number[] {
  return sortedUnique([...s.matchAll(WD_GLOBAL)].map((m) => dayIndex(m[0])))
}
function monthIndex(token: string): number {
  return ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(token.slice(0, 3)) + 1
}

// Clocks. A bare number is a clock only after "at" or inside a list or a window that has one.
// "a.m." keeps its own final dot; "9am." does not take the sentence's.
const MERIDIEM = "(?:[ap]\\.m\\.?|[ap]m)(?![a-z])"
const CLOCK_STRICT = `(?:\\d{1,2}(?::\\d{2})?\\s*${MERIDIEM}|\\d{1,2}:\\d{2}(?![\\d:])|noon|midday|midnight)`
const CLOCK_BARE = "\\d{1,2}(?![\\d:%/]|[.,]\\d|\\s*(?:%|percent|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|times|x|st|nd|rd|th)(?![\\w])|[a-z])"
const CLOCK_ANY = `(?:${CLOCK_STRICT}|${CLOCK_BARE})`
const CLOCK_SEP = "\\s*(?:,\\s*and|,|and|&)\\s*(?:at\\s+)?"
const CLOCK_TAIL = "(?:\\s*o['’]clock)?(?:\\s+in\\s+the\\s+(?:morning|afternoon|evening)s?(?![\\w'’])|\\s+at\\s+night(?![\\w'’]))?"
const TOD_HOURS: Record<string, number> = { morning: 9, afternoon: 14, evening: 18, night: 21, "first thing": 9, "end of day": 17 }

// The edge gate (§2.1): recurrence words only, so a one-shot or a deadline never even lights the glyph.
// Small widenings, each recorded in the spec (§2.1 as built): "everyday" (Todoist's spelling), an ordinal two
// words from its "of" ("first business day of"), a spelled-out day range ("Monday to Friday", family A) and a
// plural time of day on a day ("Monday mornings", "weekday evenings", family B).
const GATE = new RegExp(`\\b(?:every|everyday|each|daily|nightly|hourly|weekly|bi-?weekly|fortnightly|monthly|bi-?monthly|quarterly|yearly|annually|weekdays|weeknights?|weekends|business days|workdays|(?:mon|tues|wednes|thurs|fri|satur|sun)days|mon\\s*[-–]\\s*fri|once a|twice a|\\d+ times a|on the (?:\\d{1,2}(?:st|nd|rd|th)|${SPELLED_ORD})|(?:first|last|\\d{1,2}(?:st|nd|rd|th)) \\w+(?: day)? of|(?:mon|tue|wed|thu|fri|sat|sun)\\w*\\s*(?:[-–—]|to|through|thru)\\s*(?:mon|tue|wed|thu|fri|sat|sun)\\w*|(?:(?:mon|tues|wednes|thurs|fri|satur|sun)day|weekday|weekend|workday) (?:morning|afternoon|evening|night)s)\\b`)

// ---- the qualifier, event and leftover scans ----------------------------------------------------------------

/** A condition anywhere in the text: the run would have to check it, so the model must read it. */
const STRONG_CONDITION = /\b(?:unless|except|excluding|excepting|only\s+(?:if|when|while|whilst|whenever|on|during|after|before|until|till|once|as\s+long|so\s+long)|but\s+not|other\s+than|skip|skipping|holidays?|business\s+hours|working\s+hours|office\s+hours|work\s+hours|as\s+long\s+as|so\s+long\s+as|provided\s+that|providing|barring|on\s+condition|in\s+the\s+event|[a-z]+\s+permitting)(?![\w'’])/
/** A bound anywhere outside the span: never silently dropped. */
const BOUND_ANYWHERE = new RegExp(
  `\\bfor\\s+(?:the\\s+)?(?:next\\s+|following\\s+)?(?:${NUM}|an?|one|a\\s+few|a\\s+couple(?:\\s+of)?|several)\\s+(?:days?|weeks?|wks?|fortnights?|months?|mos?|years?|yrs?|times|runs)${END}|\\b(?:until|till|til|starting|beginning|ending)${END}|['’]til${END}` +
    // A start said as "from Nov 2" or "as of Monday": the same promise as "starting".
    `|\\b(?:from|as\\s+of|effective)\\s+(?:${MONTH}\\s*\\d|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}|\\d{1,2}/\\d{1,2}|(?:next\\s+)?${WD_ONE}|tomorrow|today|next\\s+(?:week|month))` +
    // Fix round 2: "through EOQ", "for the rest of the year", "— 2 weeks", "x14", "14 runs max", "stop after
    // Christmas" — a bound said another way. "through" is a bound only before a date ("go through the logs").
    `|\\b(?:through|thru)\\s+(?:eo[qmwy]|${MONTH}|q[1-4]|h[12]|the\\s+end|year[\\s-]?end|${WD_NAME}|next|\\d)` +
    `|\\bfor\\s+(?:the\\s+)?(?:rest|remainder|balance)\\s+of${END}` +
    `|(?<=^|\\s)[-—–]\\s*(?:${NUM}|an?)\\s+(?:days?|weeks?|wks?|fortnights?|months?)${END}` +
    `|(?<=^|[\\s(])x\\s?(?!(?:86|64|32)\\b)\\d{1,3}(?=\\s*(?:$|[.,;:!?)]|runs?\\b|times\\b|max\\b|total\\b))` +
    `|\\b(?:${NUM})\\s+runs${END}|\\b(?:${NUM})\\s+times\\s+(?:max|maximum|total|tops|in\\s+total)${END}|\\b(?:max|maximum|at\\s+most|no\\s+more\\s+than|up\\s+to)\\s+(?:${NUM})\\s+(?:runs|times)${END}` +
    `|\\b(?:stop|end|finish|pause|halt|cease)(?:s|ped|ping|ed|ing)?\\s+(?:after|on|by|once|before|following)${END}`,
)
/** Schedule words left over in the read region. */
const RESIDUAL = new RegExp(
  [
    `\\b\\d{1,2}(?::\\d{2})?\\s*${MERIDIEM}`,
    `\\b(?:at|@)\\s*\\d{1,2}(?::\\d{2})?(?=\\s*(?:$|[,.;:!?)]|o['’]clock|in\\s+the|and\\s+\\d))`,
    `\\b(?:noon|midnight|tomorrow|tonight|o['’]clock)${END}`,
    `\\bnext\\s+${WD_ONE}`,
    `\\bon\\s+the\\s+(?:half\\s+)?hour\\b`,
    `\\bon\\s+${WD}`,
  ].join("|"),
)
const HALF_HOUR = /^on\s+the\s+(?:half\s+)?hour/
const HALF_HOUR_AFTER = /^[\s,;:—–(-]*on\s+the\s+(?:half\s+)?hour(?![\w'’])/
const STRONG_EVENT = new RegExp(
  [
    "\\b(?:every\\s+time|each\\s+time|whenever|as\\s+soon\\s+as)\\b",
    "\\bany\\s?time\\s+(?=(?:a|an|the|someone|somebody|it|ci|we|you|they)\\b)",
    "\\bafter\\s+(?:each|every)\\s+(?!(?:day|week|month|hour|morning|evening|night|year|weekday|weekend)s?\\b)[a-z]+",
    "\\bon\\s+(?:each|every)\\s+(?:push|commit|merge|deploy|deployment|release|pr|pull\\s+request)s?\\b",
    "\\bwhen(?:ever)?\\s+(?:a|an|the|it|ci|tests?|builds?|deploys?|prs?|someone)\\b[^.,;!?\\n\\u0001]{0,60}?\\b(?:pass(?:es|ed)?|fail(?:s|ed)?|lands?|landed|merges?|merged|breaks?|broke|finish(?:es|ed)?|completes?|goes\\s+(?:red|green|down)|is\\s+(?:red|green|down|opened|merged)|opens?|opened|closes?|closed|crash(?:es|ed)?)\\b",
  ].join("|"),
)
const EVENT_OFFSET = /\b(?:the\s+)?(?:day|morning|evening|night|week|hour)\s+(?:after|before)\s+(?:each|every|a|an|the|any)\s+[a-z]+/
/** "each PR", "every file": a set of things, not a calendar. */
const CALENDARISH = `(?:noon|midnight|midday|lunch\\w*|dinner\\w*|breakfast\\w*|new|odd|even|alternate|alternating|wk\\w*|m|t|w|r|f|th|tu|mo|we|fr|sa|su|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:-[a-z]+)?|eleven|twelve|thirteen|fourteen|sixteen|seventeen|eighteen|nineteen|hundred|time|times|day|days|night|nights|morning|mornings|afternoon|afternoons|evening|evenings|week|weeks|weekday|weekdays|week\\s+day|weekend|weekends|weeknight|weeknights|month|months|year|years|hour|hours|minute|minutes|min|mins|hr|hrs|quarter|quarters|fortnight|other|single|business|working|work|workday|workdays|half|couple|few|several|so|now|payday|sprint|sprints|iteration|cycle|${ORD}|${SPELLED_ORD}|${WD}|${MONTH}|${NUM}|\\d)`
const EVENT_NOUN = new RegExp(`\\b(?:every|each)\\s+(?!${CALENDARISH}(?![\\w]))[a-z][a-z'’-]*`)
const PRESENCE = /\b(?:while|when(?:ever)?|as\s+long\s+as)\s+i(?:['’]m|\s+am)\b[^.,;!?\n\u0001]*/
/** A word ABOUT a schedule, earlier in the close-edge phrase's sentence (§1.3.7). */
const ABOUT = /\b(?:cron\w*|jobs?|workflows?|actions?|pipelines?|runs?|ran|running|fires?|fired|firing|triggers?|triggered|triggering|schedul\w*|recurring|periodic\w*)\b/
const DEADLINE_BEFORE = /\b(?:until|by|before|after|since|than|from|for)\s+(?:\S+\s+)?$/
const DEADLINE_OPENS = /^(?:until|till|by|before|after|since|than|from|for)\b/
/** A single "on the 15th" — the close edge's one-off date. */
const LONE_MONTH_DAY = new RegExp(`^on\\s+the\\s+(?:\\d{1,2}(?:st|nd|rd|th)|${SPELLED_ORD})$`)
/** A prohibition anywhere in the close-edge phrase's sentence. */
const NEGATION = /\b(?:don['’]?t|do\s+not|doesn['’]?t|does\s+not|never|no|not|stop|stopping|turn\s+off|disable|shouldn['’]?t|should\s+not|won['’]?t|can['’]?t|cannot|avoid|quit)\b/
/** A statement right before a close-edge phrase: a verb of being (with at most a participle), "to", ":" or
 *  "=" — the words describe a schedule, or name a setting, rather than ask for one. */
const STATEMENT_BEFORE = /(?:\b(?:is|are|was|were|be|been|being|am)|['’](?:s|re|m))\s+(?:(?:\w{2,}ed|taken|given|written|driven|chosen|frozen|broken|hidden|gotten|proven|sent|run|held|due|closed|open|out|off|away|done|set|built|shut|kept|made|paid)(?:\s+(?:up|out|off|down))?\s+)?$|\bto\s+$|[:=]\s*$/
/** After an open-edge phrase, where the imperative would be: a subject or a verb of being. "we" asks for
 *  something when a modal follows ("we should …"). */
const DECLARATIVE_AFTER = /^[\s,;:—–-]*(?:the(?!\s+(?:next|following|coming|rest|first|last)\b)|our|my|its|their|his|her|it|it['’]s|there|this(?!\s+(?:week|month|year|quarter|fall|spring|summer|winter|morning|afternoon|evening)\b)|that|these|those|is|are|was|were|isn['’]t|aren['’]t|has|have|had|keeps?|someone|somebody|nobody|everyone|everybody|people|users|customers|we(?!\s+(?:should|need|must|want|could|can|will|['’]ll|have\s+to|gotta)\b))(?![\w'’])/

// ---- what touches a phrase and changes it (fix round 1, 2026-10-06) ----------------------------------------
// An adversarial pass found the words right after a phrase read as the TASK's first words while the phrase was
// offered exact: "every weekday at 9am apart from Fridays triage new issues" ran on Fridays, "every Monday at
// 9am Berlin time" fired at 3pm Berlin, "every hour and a half" ran hourly. A task starts with a verb; the
// words below cannot start one, so right after a phrase they are part of WHEN, and the grammar does not read
// them: the reading is a cue and the model reads it in the mode.

/** A month by its abbreviation (fix round 2: "Oct 12-30", "Sep–Dec" read as the task's first words). "may" is
 *  a verb and has no abbreviation. */
const MONTH_ABBR = "(?:jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\\.?"
/** A word of the calendar: a weekday, a class of days, a month (by name or abbreviation), a quarter, the end
 *  of a quarter, month, week or year, a holiday. */
const CAL_WORD = `(?:${WD}|weekends?|week\\s?days?|workdays?|business\\s+days?|january|february|march|april|june|july|august|september|october|november|december|${MONTH_ABBR}|q[1-4]|eo[qmwy]|holidays?)(?![\\w'’])`
/** Zone abbreviations, case-insensitive. Fix round 2 added the ones its break-it pass found missing (NZT, AET,
 *  SAST, BRT, AST, WIB, IDT, …) and the POSIX names (PST8PDT). */
const ZONE_ABBR = "pt|pst|pdt|et|est|edt|ct|cst|cdt|mt|mst|mdt|utc|uct|gmt|cet|cest|bst|ist|idt|jst|kst|aest|aedt|aet|acst|acdt|awst|nzst|nzdt|nzt|wet|west|eet|eest|msk|hst|akst|akdt|sgt|hkt|pht|ict|wib|wita|sast|brt|bdt|pkt|npt|ast|adt|nst|ndt|clt|cot|gst|trt|myt|z|zulu|pst8pdt|est5edt|cst6cdt|mst7mdt"
/** Zone abbreviations that are also English words, read as zones only when typed in capitals ("9am CAT" is
 *  Central Africa, "every morning cat the error log" is a command). Matched against the ORIGINAL text. */
const ZONE_ABBR_UPPER = /^[\s,;:(\[—–-]*(?:ART|CAT|EAT|WAT|WIT|PET|GET|BOT|VET|SST)(?![\w'’/])/
/** A bare offset right after a clock, with an ASCII hyphen too ("9am -0500", "9am -05:00"). Four digits or
 *  hh:mm: "9am-5pm" is a window, not a zone. Matched before the separators the other checks skip. */
const ZONE_OFFSET_BARE = /^[\s,;:(\[]*[+−-]\s?\d{2}:?\d{2}(?!\d)/
const IANA_ZONE = "(?:africa|america|antarctica|arctic|asia|atlantic|australia|europe|indian|pacific|etc)/[a-z_+-]+(?:/[a-z_+-]+)?"
const ZONE_OFFSET = "(?:(?:utc|gmt)\\s*)?[+−]\\s*\\d{1,2}(?::?\\d{2})?(?!\\d)|(?:utc|gmt)\\s*-\\s*\\d{1,2}(?::?\\d{2})?(?!\\d)"
const ZONE_PLACE = "london|berlin|paris|madrid|lisbon|dublin|amsterdam|stockholm|zurich|munich|tokyo|seoul|beijing|shanghai|singapore|sydney|melbourne|auckland|india|japan|china|germany|france|uk|europe|nyc|ny|new\\s+york|sf|la|san\\s+francisco|los\\s+angeles|seattle|chicago|denver|toronto|vancouver|bangalore|mumbai|delhi|dubai|hong\\s+kong|pacific|eastern|central|mountain|atlantic|hawaii|alaska"
/** More cities a person names as a zone, said bare right after a clock (fix round 2: "9am Kyiv", "9am Boston").
 *  Hand-picked, not drawn from `Intl.supportedValuesOf`: a browser's and the server's ICU can differ ("Kyiv"
 *  is not in every one), and the server re-derives what the browser read. Names that are English words
 *  ("Phoenix", "Reading", "Center") are left out; "<city> time" and "in <city>" already read any word. */
const ZONE_CITY = "kyiv|kiev|lviv|warsaw|krakow|oslo|helsinki|copenhagen|vienna|prague|budapest|bucharest|athens|istanbul|moscow|rome|milan|brussels|barcelona|edinburgh|manchester|riga|tallinn|vilnius|belgrade|sofia|zagreb|reykjavik|minsk|geneva|frankfurt|hamburg|boston|austin|portland|atlanta|miami|dallas|houston|philadelphia|philly|detroit|minneapolis|nashville|pittsburgh|baltimore|raleigh|salt\\s+lake\\s+city|las\\s+vegas|san\\s+diego|san\\s+jose|sacramento|honolulu|anchorage|montreal|ottawa|calgary|edmonton|winnipeg|halifax|mexico\\s+city|bogota|lima|santiago|buenos\\s+aires|sao\\s+paulo|são\\s+paulo|caracas|kolkata|calcutta|chennai|hyderabad|pune|karachi|lahore|dhaka|kathmandu|colombo|bangkok|jakarta|manila|hanoi|saigon|ho\\s+chi\\s+minh|kuala\\s+lumpur|taipei|osaka|perth|brisbane|adelaide|wellington|tel\\s+aviv|jerusalem|riyadh|doha|abu\\s+dhabi|tehran|cairo|lagos|nairobi|johannesburg|cape\\s+town|casablanca|accra|shenzhen|guangzhou|hangzhou"
/** A zone right after a phrase: an abbreviation, an IANA name, an offset, a place, or any "<words> time". */
const ZONE_AFTER = new RegExp(`^[\\s,;:(\\[—–-]*(?:in\\s+)?(?:${IANA_ZONE}|${ZONE_OFFSET}|(?:${ZONE_ABBR})(?:\\s+time)?(?![\\w'’/])|(?:${ZONE_PLACE}|${ZONE_CITY})(?![\\w'’/])|(?:[a-z.]+\\s+){1,2}time(?![\\w'’]))`)
/** A zone anywhere: the spellings that cannot be anything else. */
const ZONE_ANYWHERE = new RegExp(`\\b(?:${IANA_ZONE})|\\b(?:utc|gmt)\\s*[+−-]\\s*\\d|\\b(?:${ZONE_PLACE}|my|local|server)\\s+time(?![\\w'’])`)
/** "every hour and a half", "every hour or so": the interval is not the one the core says. Fix round 3: the
 *  adverbs that loosen a stated run — "9am latest", "at the latest", "or later", "give or take", "± 15m",
 *  "randomly" — read as the task's first word. The first group changes the interval itself, so its cue keeps no
 *  core (a faithful "every 90 minutes" can never pass an hourly one, §4.3). */
const APPROX_AFTER = /^\s*(?:(and\s+(?:a|one)\s+(?:half|quarter)|and\s+change|plus\s+or\s+minus|plus\s+\w+)|((?:or|and)\s+so|or\s+(?:two|three|more)|-?ish|(?:at\s+the\s+)?latest|at\s+the\s+earliest|or\s+(?:later|earlier|after|before|thereabouts)|give\s+or\s+take|±|\+\/-|randomly|at\s+random))(?![\w'’])/
/** A word that cannot start an imperative, right after a phrase: an exclusion, a preposition, a negation, a
 *  count, a second frequency, a calendar word. "save" and "bar" are verbs too, so only before a day. */
const QUALIFIER_AFTER = new RegExp(
  `^[\\s,;:—–(\\[-]*(apart\\s+from|aside\\s+from|besides|save(?:\\s+for)?(?=\\s+(?:on\\s+)?(?:the\\s+)?${CAL_WORD})|bar(?:ring)?(?=\\s+(?:on\\s+)?(?:the\\s+)?${CAL_WORD})|` +
    `minus|without|w/o|excl\\.?|omitting|no|not|never|nor|in\\s+case|in|within|over|throughout|around|these|the\\s+(?:next|following|coming|rest)|this|next|` +
    `first\\s+(?:run|one|time|occurrence)s?|once|as|max(?:imum)?|at\\s+(?:most|least|max)|up\\s+to|stopping|stop(?=\\s+(?:on|at|after|by|in)\\b)|` +
    `on\\s+(?:odd|even|alternate|alternating|non-?\\w+)|every|each|x\\s?\\d+|\\d+\\s?x|${CAL_WORD})(?![\\w'’])`,
)
/** A statement or a negation right after a phrase — "every Monday, Friday is off-limits", "every Monday at
 *  9am is when the digest goes out": the words before are not a rule to run, and a list before "is" may
 *  hold the very day the human excluded, so the reading keeps no core. */
const STATEMENT_AFTER = /^[\s,;:—–-]*(is|are|isn['’]t|aren['’]t|was|were|['’]s|['’]re|off|too|also|excluded|included|frozen|blocked|closed|out|free)(?![\w'’])/
/** A clock the grammar could not parse, right after a phrase: "at 9p", "at 1430", "at 9h30", "at about 9",
 *  "9", "at ９am", "at nine". The phrase alone would read 9am, assumed, and save the clock as the task. Fix
 *  round 2: a minute (", :45"), a number past twelve ("9 thirty", "oh nine hundred"), "half" and "quarter", and
 *  a hyphen ("noon-thirty"). */
const CLOCK_WORD = "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|oh|hundred|half|quarter"
const CLOCK_AFTER = new RegExp(`^(?:-|[\\s,]*)(?:(?:at|@|around|about|approx\\.?|approximately|~|circa|roughly|by)\\s*)*(?:[\\d０-９][\\w:.０-９]*|:\\d{1,2}|(?:${CLOCK_WORD})(?![\\w'’]))`)
/** Unread words after a closed-class word that name a time of day — "to 5", "past 9", "until noon", ":30",
 *  "half", "lunch" — so the core's STATED clock is not the one the human means (§4.3). A bare count is not
 *  one ("for 2 weeks" is a bound being typed). */
const CLOCK_MENTION = new RegExp(`\\b(?:at|@|to|till|til|until|then|again|later|past|by|around|about|before|after)\\s+[\\d０-９]|${CLOCK_STRICT}|:\\d{2}|\\b(?:${CLOCK_WORD}|noon|midnight|midday|o['’]clock|lunch\\w*|standup|eod|cob|offset|delay|lag|later|earlier)(?![\\w'’])`)
/** Calendar words anywhere in the read region, outside the phrase: never eaten, never ignored. A weekday by
 *  its full name (a possessive is the task's: "prepare Monday's notes"), a class of days in the plural, a
 *  month by its full name ("may" and "march" are verbs), a quarter, a season after its preposition.
 *  Fix round 2, the abbreviations — only where nothing else can be meant, since "sat", "sun", "wed" and "Jan"
 *  are words and names: a month before a day or a span ("Oct 12-30", "(Oct–Dec)"), a weekday in a span or a
 *  list ("Mon–Fri", "Sat/Sun") or after a no or before an only/off ("not Sat", "Sat off"), the end of a
 *  quarter, month, week or year (EOQ), and a half of the year after its preposition ("in H2", "H2 only"). */
const CALENDAR_RESIDUAL = new RegExp(
  `\\b(?:${WD_NAME}s?|weekends|weekdays|workdays|business\\s+days|january|february|april|june|july|august|september|october|november|december|q[1-4]|(?:in|this|over|during|through)\\s+(?:the\\s+)?(?:summer|winter|spring|fall|autumn))(?![\\w'’])` +
    `|\\b${MONTH_ABBR}(?=\\s*(?:\\d|[-–—/]|to\\s|through\\s|thru\\s|only\\b|\\)))` +
    `|\\b${WD_ABBR}\\.?\\s*[-–—/&]\\s*${WD_ABBR}(?![\\w'’])` +
    `|\\b(?:no|not|except|excluding|skip|skipping|w/o|without|never|only)\\s+(?:on\\s+)?${WD_ABBR}(?![\\w'’])` +
    `|\\b${WD_ABBR}\\.?\\s+(?:only|off)(?![\\w'’])` +
    `|\\beo[qmwy](?![\\w'’])|(?:\\b(?:in|during|through|for|over|by)\\s+)h[12](?![\\w'’])|\\bh[12]\\s+only\\b`,
)

const TOUCH_AFTER = /^[\s,;:—–(-]*(unless|except|excluding|only(?:\s+(?:if|when|on|during|after|before))?|if|when|whenever|for|until|till|thru|through|starting|beginning|from|after|before|but(?:\s+not)?|skip|skipping|ending|between|during|while|provided|assuming|as\s+long\s+as|this\s+(?:week|month|year|quarter)|next\s+(?:week|month|year)|today|tonight|tomorrow)(?![\w'’])/
const TOUCH_BEFORE_WORD = /(?:^|[^\w'’])(until|till|by|before|after|past|since|from|for|unless|except|excluding|excl\.?|omitting|besides|minus|without|w\/o|save|bar|barring|if|when|only|stop|stopping|quit|never|not|no|nor|don['’]?t|doesn['’]?t)\s+$/
/** A deadline or anchor two words before: "have it done by Friday every week", "after standup every day" —
 *  or a first run named before its date: "nightly first run on Oct 20" (the adverb unread, the date taken). */
const TOUCH_BEFORE_PAIR = /(?:^|[^\w'’])((?:until|till|by|before|after|since|from)\s+[^\s,;:.!?\u0001]+|first\s+(?:run|one|time|occurrence)s?)\s+$/
const CLAUSE_QUALIFIER = /^[\s(\[]*(on\s+(?:odd|even|alternate|alternating|non-?\w+)|\d+\s?x|unless|except|excluding|only|if|when|whenever|until|till|for|starting|beginning|after|before|but|while|provided|assuming|apart|aside|besides|save|minus|without|w\/o|excl|omitting|bar|barring|no|not|never|nor|in|within|over|throughout|through|thru|during|around|this|these|next|the\s+(?:next|following|coming|rest)|first|once|as|max|maximum|at\s+most|up\s+to|stopping|stop|every|each|x\d|\d)(?![\w'’])/
/** A second day's own clock, so the compound's unread words are the whole second rule. */
const CONJ_CLOCK = `(?:\\s+(?:at|@)\\s*${CLOCK_ANY}|\\s+${CLOCK_STRICT})?`
// Fix round 2: "and again at 5", "then at 5", "and later at 5", "and :35" — a second clock said with a filler
// word between, or a second minute.
const CONJOINED = new RegExp(
  `^\\s*(?:,\\s*)?(?:and|&|plus|or|then)\\s+(?:(?:also|again|then|later|once\\s+more|too)\\s+)*(?:(?:every|each|on|at|in\\s+the)\\s+)?(?:(?:${WD}|(?:morning|afternoon|evening|night)s?${END}|weekends?${END}|weekdays?${END})${CONJ_CLOCK}|${CLOCK_ANY}|\\d|:\\d{1,2}|noon|midnight|tomorrow|tonight)` +
    // "every Mon at 8pm, Tue at 9pm": a second day with its own clock, joined by a comma alone.
    `|^\\s*,\\s*(?:(?:every|each|on)\\s+)?${WD}\\s+(?:at|@)\\s*(?:${CLOCK_ANY}|noon|midnight)`,
)
const OBJECT_BEFORE = /(?:^|[^\w'’])(?:the|a|an|this|that|our|my|your|their|its|his|her|skip|skipping|except|excluding|excl\.?|omitting|save|bar|barring|without|w\/o|minus|besides|not|never|during|over|through|all|both|no|most|some)\s+$/

// ---- the closed classes (fix round 2, 2026-10-06) ------------------------------------------------------------
// Round 1 answered "a word after the phrase changes WHEN" with lists of the words its break-it pass found, and
// round 2's pass found fifty more in the same classes ("so long as", "providing", "right after", "til EOY",
// "fortnightly", "NZT"). A list of members cannot close an open class; the classes these words come from ARE
// closed. A task starts with an imperative verb, and English has a fixed, short stock of prepositions,
// subordinating conjunctions and modals, none of which can open one. So right after a phrase they are WHEN or
// the task's setting, never its first word — and they split in two:
// - words that are about time or a condition whatever follows them ("after", "until", "following", "given",
//   "unless", a modal, an offset, a count): always part of WHEN, unread, and the reading is a cue;
// - words that place the task as often as they time it ("on main", "to keep CI green", "with the new client",
//   "by priority"): part of WHEN only before a word of time (`TEMPORAL_NEXT`: "on alternate weeks", "to Dec 24",
//   "by EOD", "with a 10 minute offset"), which is a far smaller and closed set than the things a task acts on.
// "post", "back", "round", "like", "save" and "bar" are verbs, "because"/"though" give reasons, and "via",
// "per", "using" are manners: none is in either. A clause BEFORE a phrase that opens with one is the same
// (`CLAUSE_WHEN`). Round 1's lists still run first and keep their words ("for", "in", "from", "as", "over" are
// always WHEN there).

/** A second frequency or a count: "fortnightly", "twice", "3x", "half-hourly", "alternate". */
const FREQ_ADV = "(?:(?:semi|bi|tri|half|twice|thrice)-?)?(?:hourly|daily|nightly|weekly|fortnightly|monthly|quarterly|yearly|annually)"
/** Always WHEN. */
const WHEN_ALWAYS =
  // prepositions and subordinators of time and condition
  "after|ahead\\s+of|amid(?:st)?|at|barring|before|besides|between|circa|considering|depending|despite|during|even|except|excepting|excluding|following|given|lest|minus|notwithstanding|once|past|pending|prior|provided|providing|since|supposing|throughout|through|thru|till|['’]?til|unless|until|upon|whether|while|whilst|within|without|w/o|whenever|when|if|" +
  // a time prefix
  "(?:post|pre|mid)-[a-z]+|" +
  // a modal — except a request ("could you …")
  "(?:can|could|would|will)(?!\\s+(?:you|u|someone|somebody|we)\\b)|should|might|must|may|shall|ought|were|had|" +
  // an offset before its anchor: "right after standup", "10 minutes before the deploy"
  "(?:right|just|shortly|immediately|directly|soon|straight|promptly|well|long|only)\\s+(?:after|before|following|prior|ahead|upon|once|when|past)|" +
  `(?:${NUM}|an?|half\\s+an?|a\\s+few|a\\s+couple(?:\\s+of)?|several)\\s+(?:minutes?|mins?|hours?|hrs?|days?|weeks?)\\s+(?:after|before|past|from|later|earlier|ahead|prior|into)|` +
  // a second frequency or a count
  `twice|thrice|(?:${NUM}|a\\s+few|several|multiple)(?:\\s+(?:or|to)\\s+(?:${NUM}))?\\s+times|once\\s+or\\s+twice|\\d+\\s?x|x\\s?\\d+|${FREQ_ADV}|bi-?weekly|bi-?monthly|alternat(?:e|ing)|every|each|other|` +
  // a participle that moves the runs, an absolute "<x> permitting", "up until"
  "offset|staggered|shifted|[a-z]+\\s+permitting|up\\s+(?:until|till|['’]?til|through|thru|to)"
/** WHEN only before a word of time. */
const WHEN_IF_TIME = "about|above|across|against|along|among(?:st)?|around|atop|behind|below|beneath|beside|beyond|by|including|inside|into|near|of|off|on|onto|outside|to|toward|towards|under|unto|with|where|wherever"
/** A word of time, after at most a determiner: a number, a clock word, a calendar word, a unit, an ordinal or a
 *  position in a period, a span's limit, an event a schedule hangs on, or a condition's object. */
const TEMPORAL_NEXT = `\\s+(?:(?:the|a|an|this|that|these|those|each|every|its|our|your|their|my|odd|even)\\s+)?(?:[\\d０-９]|(?:${CLOCK_WORD}|${CAL_WORD}|noon|midnight|midday|today|tomorrow|tonight|eod|cob|${FREQ_ADV}|odd|even|alternate|alternating|other|non-[a-z]+|first|second|third|fourth|fifth|last|next|following|previous|final|end|start|beginning|top|bottom|middle|rest|remainder|exceptions?|occasion|demand|request|call|time|times|schedule|cadence|frequency|interval|delay|offset|lag|gap|buffer|pause|break|minutes?|mins?|hours?|hrs?|days?|nights?|mornings?|afternoons?|evenings?|weeks?|weekends?|months?|quarters?|years?|fortnights?|sprints?|releases?|deploys?|deployments?|launch|standups?|lunch\\w*|christmas|xmas|thanksgiving|easter|possible|needed|necessary|applicable|appropriate|feasible|required)(?![\\w'’]))`
const WHEN_WORDS = `${WHEN_ALWAYS}|(?:${WHEN_IF_TIME})(?=${TEMPORAL_NEXT})`
const WHEN_AFTER = new RegExp(`^[\\s,;:—–(\\[-]*(${WHEN_WORDS})(?![\\w'’])`)
const CLAUSE_WHEN = new RegExp(`^[\\s(\\[]*(${WHEN_WORDS})(?![\\w'’])`)
/** A count of runs: a frequency word, never a condition. */
const COUNT_WORD = new RegExp(`^(?:twice|thrice|(?:${NUM}|a\\s+few|several|multiple)(?:\\s+(?:or|to)\\s+(?:${NUM}))?\\s+times|once\\s+or\\s+twice|\\d+\\s?x|x\\s?\\d+|${FREQ_ADV}|bi-?weekly|bi-?monthly|alternat(?:e|ing)|every|each|other)$`)
/** A second frequency anywhere, said as one — "…, fortnightly is fine", "weekly would do" — where it cannot be
 *  an adjective ("the weekly digest"): before punctuation, the end, or a verb of being or judgement. */
const FREQ_RESIDUAL = new RegExp(`\\b(?:${FREQ_ADV}|bi-?weekly|bi-?monthly)(?=\\s*(?:$|[.,;:!?)\\n—–]|(?:is|are|works?|would|should|could|instead|too|also|okay|ok|fine|rather|please|then)(?![\\w'’])))`)
/** A sequencing word right before a phrase: "and again at 5, nightly", "then every Friday". */
const SEQUENCE_BEFORE = /(?:^|[^\w'’])((?:(?:and|plus|or)\s+)?(?:again|then|later|also|once\s+more)|plus)\s+$|^\s*(and|or)\s+$/
/** An adjective that limits WHICH of the days a plural names: "alternate Thursdays", "odd Fridays", "most
 *  weekdays", "the first two Mondays". Every one of them is a superset: the core stays, the words are unread. */
const LIMIT_BEFORE = new RegExp(
  // Fix round 3: an adverb of degree before "every" ("nearly every day", "almost every weekday") is the same.
  `(?:^|[^\\w'’])((?:nearly|almost|practically|virtually|basically|mostly|usually|generally|typically|normally|roughly|just\\s+about|more\\s+or\\s+less|not\\s+quite|alternate|alternating|odd|even|most|some|certain|select(?:ed)?|specific|particular|random|occasional|several|various|few|many|(?:the\\s+)?(?:first|last|next|remaining|following|other|final)(?:\\s+(?:${NUM}|few|couple(?:\\s+of)?))?|the\\s+(?:${NUM})))\\s+$`,
)

const CONDITION_WORDS = new Set(["unless", "except", "excluding", "only", "if", "when", "whenever", "but", "skip", "skipping", "during", "while", "provided", "assuming", "apart", "aside", "besides", "save", "bar", "barring", "minus", "without", "w/o", "excl", "excl.", "omitting", "no", "not", "never", "nor", "once", "as", "in case", "don't", "dont", "don’t", "doesn't", "doesnt", "doesn’t"])
const OFFSET_WORDS = new Set(["after", "before"])

// ---- the temporal residue (fix round 3, 2026-10-06) ----------------------------------------------------------
// Each of three break-it rounds found new ways an EXACT reading was silently wrong (round 3: nine classes), and
// every round closed a LIST of words beside the phrase — and the next round found new members, because the words
// that change WHEN can sit anywhere in the text: a zone said at its end ("…triage new issues (PT)"), a bound later in the
// sentence ("…check the deploy for the next 2 hours"), a count before it ("twice every Monday"), a time of day
// the phrase did not take ("every Friday lunchtime"), a day it read past ("every month end").
//
// So an exact reading passes one more gate, over the WHOLE text it would save as the task — all of it but its
// span, and the code, quotes, mentions and commands the grammar never reads: if a word of TIME is left in it,
// the grammar cannot know its span is all of WHEN, and the reading is a cue (offered as one; in the mode, read
// by the model). Time is a CLOSED class, unlike the words that happen to sit next to a phrase: clocks and times
// of day, day and month names, the relative days, durations and counts of a unit of time, frequencies, the
// ordinals that name a day, bounds and conditions, zones. The adjacency classes above still decide the span;
// this decides whether the span is the whole schedule. A task that mentions time on its own account ("triage
// the issues from the last 24 hours") pays for it with a model read — the price chosen, measured in the spec
// (§3, as built, fix round 3).
//
// The cue keeps the exact reading as its CORE only when every word of time left can only NARROW it: a bound or
// a condition, a start, an exclusion, and the days and spans those govern ("until Oct 30", "except Fridays",
// "for the next 2 hours", "weekdays only", "next quarter"). Any other may add a run or move one ("and at 5pm",
// "today", "(PT)"), and a core would then turn the model's faithful answer into the disagree state (§4.3), so
// the cue carries none. The same test runs over the cores the earlier checks keep (round 3's "Tuesday and
// Thursday afternoons" kept the Thursday core the right answer could never pass).
//
// The scan reads the whole text, so it must cost what the windows do. One alternation of every rule took 19ms
// over 20k characters (V8 loses each rule's own fast prefix in it), the rules one by one 4.7ms; so the text is
// walked word by word and a rule is tried, anchored, only at a word that can start one of its words of time.

/** A unit a span of time or a count of runs is said in. Not seconds: nothing runs that often, and "a 200ms
 *  p99" is the task's. "A quarter of the tests" is not one. */
const T_UNIT = "(?:minutes?|mins?|hours?|hrs?|days?|nights?|weeks?|wks?|weekends?|weekdays?|weeknights?|months?|mos|years?|yrs?|fortnights?|quarters?(?!\\s+of\\b)|qtrs?|sprints?|semesters?|business\\s+days?|working\\s+days?|work\\s?days?)"
const T_QTY_WORDS = "an a one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty ninety couple few several many some half"
/** How many of a unit: a number, a number word, a vague count. */
const T_QTY = "(?:\\d+(?:\\.\\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|forty-five|fifty|sixty|ninety|a\\s+few|a\\s+couple(?:\\s+of)?|couple(?:\\s+of)?|few|several|many|some|half\\s+an?|a\\s+half|a\\s+dozen)"
const T_WD_ABBR_WORDS = "mon tue tues wed weds thu thur thurs fri sat sun"
const T_WD_ABBR = `(?:${T_WD_ABBR_WORDS.split(" ").join("|")})`
const T_MONTH_WORDS = "jan january feb february mar march apr april may jun june jul july aug august sep sept september oct october nov november dec december"
const T_MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
/** A month by a name that is nothing else ("may" and "march" are verbs, "jan" a name: those take a context). */
const T_MONTH_FREE = "(?:january|february|april|june|july|august|september|october|november|december)"
const T_ORD = `(?:\\d{1,2}(?:st|nd|rd|th)|${SPELLED_ORD}|penultimate)`
const T_ORD_WORDS = `${SPELLED_ORDS.map((w) => w.split("-")[0]).join(" ")} penultimate`
/** An ordinal that names a day on its own, at the end of a clause ("the 15th."): not "first", "second" or "third",
 *  which as often count tries and reviews ("fix the first, then the second"). */
const T_ORD_DAY = `(?:\\d{1,2}(?:st|nd|rd|th)|${spelled(SPELLED_ORDS.slice(3))})`
const WD_NAME_WORDS = DAY_NAMES.flatMap((d) => [d.toLowerCase(), `${d.toLowerCase()}s`]).join(" ")
/** A unit of the calendar an ordinal can count: "the second Friday", "the last business day", "the first week". */
const T_DAY_UNIT = `(?:day|weekday|week\\s?day|business\\s+day|work\\s?day|working\\s+day|weekend|week|${WD_NAME}|${T_WD_ABBR})s?`
const T_HOUR_WORD = "(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)"
/** After a bare hour, what makes it a clock ("at 5.", "at 5 in the morning", "at 5 every day") and not a count
 *  ("look at 5 files"). A list ("at 9 and 5") is matched before it. */
const T_CLOCK_NEXT = "(?=\\s*(?:$|[,.;:!?)\\n—–\\u0001]|o['’]clock|in\\s+the\\b|at\\s+night|sharp\\b|every\\b|each\\b|daily\\b|nightly\\b|on\\s|tomorrow|today|tonight|-?ish\\b))"
/** What "every" or a count counts when it is a frequency ("every 2 hours", "twice a week") and not a set of
 *  things ("every file"). */
const T_EVERY_NOUN = `(?:${T_UNIT}|mornings?|afternoons?|evenings?|${WD_NAME}s?|${T_WD_ABBR}\\.?|${T_MONTH_FREE}|march|may|${T_ORD})`
const FREQ_WORDS = ["hourly", "daily", "nightly", "weekly", "fortnightly", "monthly", "quarterly", "yearly", "annually"]
const T_END = "(?![\\w'’])"
/** Every city and place the zone checks know, by its first word (the trigger of the zone rule below). */
const firstWords = (alternation: string) => alternation.split("|").map((w) => w.split("\\s+")[0]!).join(" ")
const ZONE_CITY_EXTRA = "london|berlin|paris|madrid|lisbon|dublin|amsterdam|stockholm|zurich|munich|tokyo|seoul|beijing|shanghai|singapore|sydney|melbourne|auckland|new\\s+york|san\\s+francisco|los\\s+angeles|seattle|chicago|denver|toronto|vancouver|bangalore|bengaluru|mumbai|delhi|dubai|hong\\s+kong"

/** The residue's kinds. A `narrow` word only takes runs away; a governor (bound, start, except, for, window)
 *  narrows the time words it governs; every other kind may add a run or move one. */
type ResidueKind = "narrow" | "bound" | "start" | "except" | "for" | "window" | "zone" | "freq" | "period" | "duration" | "day" | "clock"

interface ResidueRule {
  kind: ResidueKind
  /** Its alternatives, each with every word one of its matches can start with ("#": a number). The walk tries an
   *  alternative only at those words; a test pins the walk to the rules matched at every position. */
  alts: [first: string, src: string][]
  /** A governor that is a word of time even with nothing to govern ("until it passes"). */
  alone?: true
}

/** The words of each kind, matched on the masked, lowercased text, in this order (the first alternative that
 *  matches at a word wins, as in one alternation of them all). */
const RESIDUE_RULES: ResidueRule[] = [
  // Conditions and bounds that only ever take runs away, and the period an event lasts ("while the freeze
  // lasts", "during the freeze").
  {
    kind: "narrow",
    alone: true,
    alts: [
      ["unless holiday holidays temporarily while whilst during throughout", `\\b(?:unless|holidays?|temporarily|while|whilst|during|throughout)${T_END}`],
      ["bank business working office work", `\\b(?:bank\\s+holidays?|(?:business|working|office|work)\\s+hours)${T_END}`],
      ["from for until", `\\b(?:from\\s+now(?:\\s+on)?|for\\s+now|for\\s+the\\s+time\\s+being|until\\s+further\\s+notice)${T_END}`],
      ["stop stops stopping stopped", "\\bstop(?:s|ping|ped)?(?=\\s*(?:$|[.!;)\\n\\u0001]|there\\b|then\\b|after\\b|once\\b|when\\b|on\\s|by\\s|before\\s|at\\s))"],
      ["only", `\\bonly\\s+(?:if|when|while|whilst|on|in|during|between|after|before|until|till|once|from|for)${T_END}`],
      ["on", `\\bon\\s+(?:(?:[a-z-]+\\s+){1,2}days|days\\s+(?:when|that|where|with))${T_END}`],
    ],
  },
  { kind: "bound", alone: true, alts: [["up until till til", `\\b(?:up\\s+)?(?:until|till|til)${T_END}`]] },
  { kind: "bound", alts: [["through thru ending stopping up no", `\\b(?:through|thru|ending|stopping|up\\s+to|no\\s+later\\s+than)${T_END}`]] },
  // A period the phrase holds in: a narrowing, never a run of its own ("next quarter", "in March", "the past 24
  // hours", "last week"). Before the governors, so "last Friday" is one word of time.
  {
    kind: "period",
    alts: [
      // A range of dates or months: "Oct 12-30", "Oct 12 – Nov 2", "Sep–Dec".
      [T_MONTH_WORDS, `\\b${T_MONTH}\\.?\\s*(?:\\d{1,2}(?:st|nd|rd|th)?\\s*[-–—]\\s*(?:${T_MONTH}\\.?\\s*)?\\d{1,2}(?:st|nd|rd|th)?|[-–—]\\s*${T_MONTH}\\.?)${T_END}`],
      // A month and a day is a date ("July 1st", below), not a period.
      ["january february april june july august september october november december", `\\b${T_MONTH_FREE}(?![\\w'’]|\\.?\\s*\\d)`],
      ["may march mar jan feb apr jun jul aug sep sept oct nov dec", `(?<=\\b(?:in|until|till|through|thru|from|since|by|before|after|during|early|late|mid|end\\s+of|start\\s+of|beginning\\s+of|all\\s+of)[\\s-]+)(?:may|march|mar|jan|feb|apr|jun|jul|aug|sept?|oct|nov|dec)\\.?(?![\\w'’]|\\s*\\d)`],
      ["this next coming following current upcoming that same", `\\b(?:this|next|coming|following|current|upcoming|that|same)\\s+(?:week|month|quarter|year|sprint|semester|fortnight|season)${T_END}`],
      ["next coming following", `\\b(?:next|coming|following)\\s+${T_QTY}\\s+${T_UNIT}${T_END}`],
      ["last past previous prior preceding", `\\b(?:last|past|previous|prior|preceding)\\s+(?:${T_QTY}\\s+)?(?:${T_UNIT}|${WD_NAME}|nights?|mornings?|evenings?|afternoons?)(?!\\s+of\\b)${T_END}`],
      ["yesterday", `\\byesterday${T_END}`],
      ["the rest remainder balance", `\\b(?:the\\s+)?(?:rest|remainder|balance)\\s+of\\s+(?:the\\s+|this\\s+)?(?:day|week|month|quarter|year|sprint)${T_END}`],
      ["q1 q2 q3 q4 fy h1 h2", `\\bq[1-4]${T_END}|\\bfy\\s?\\d{2,4}${T_END}|(?<=\\b(?:in|during|through|for|over|by)\\s+)h[12]${T_END}|\\bh[12](?=\\s+only\\b)`],
      ["summer winter spring fall autumn", `(?<=\\b(?:this|next|last|over\\s+the|during\\s+the|in\\s+the|through\\s+the|until|till|through|by|before|after|since|in)\\s+)(?:summer|winter|spring|fall|autumn)${T_END}`],
      ["#", `(?<=\\b(?:in|until|till|through|thru|by|since|from|during|before|after)\\s+)(?:19|20)\\d{2}${T_END}`],
    ],
  },
  // Days: weekdays, dates, the relative days, the ordinals that name one, holidays.
  {
    kind: "day",
    alts: [
      ["today tomorrow tmrw this that coming", `\\b(?:today|tomorrow|tmrw|this|that|coming)\\s+(?:morning|afternoon|evening|night)${T_END}`],
      ["this next coming", `\\b(?:this|next|coming)\\s+weekend${T_END}`],
      ["month week year quarter monthend weekend yearend quarterend", `\\b(?:month|week|year|quarter)[\\s-]?end${T_END}`],
      ["eow eom eoq eoy", `\\beo[wmqy]${T_END}`],
      ["end start beginning close middle", `\\b(?:end|start|beginning|close|middle)\\s+of\\s+(?:the\\s+|each\\s+|every\\s+|this\\s+|next\\s+)?(?:week|month|quarter|year|sprint)${T_END}`],
      [WD_NAME_WORDS, `\\b${WD_NAME}s?${T_END}`],
      ["today tonight tomorrow tmrw weekend weekends weekday weekdays weeknight weeknights workday workdays", `\\b(?:today|tonight|tomorrow|tmrw|weekends?|weekdays?|weeknights?|workdays?)${T_END}`],
      [`${T_ORD_WORDS} #`, `\\b${T_ORD}(?:[\\s-]+(?:to|from)[\\s-]+last)?[\\s-]+${T_DAY_UNIT}${T_END}`],
      ["last", `\\blast[\\s-]+${T_DAY_UNIT}(?=\\s+(?:of|in)\\b)`],
      [`${T_ORD_WORDS} #`, `\\b${T_ORD}(?:[\\s-]+(?:to|from)[\\s-]+|\\s+)last${T_END}`],
      ["the", `\\bthe\\s+(?:${T_ORD_DAY}(?=\\s*(?:$|[,.;:!?)\\n—–\\u0001]|&|-))|${T_ORD}(?=\\s+(?:of\\s+(?:the|every|each|this|next|a)\\s+(?:month|quarter|year)\\b|of\\s+${T_MONTH}\\b|at\\b|and\\s+(?:the\\s+)?${T_ORD}\\b|through\\b|thru\\b)))`],
      [`${T_ORD_WORDS} #`, `(?<=(?:\\band|&|,)\\s+(?:the\\s+)?)${T_ORD_DAY}(?=\\s*(?:$|[,.;:!?)\\n—–\\u0001]|of\\b|at\\b|and\\b|&))`],
      [T_MONTH_WORDS, `\\b${T_MONTH}\\.?\\s*\\d{1,2}(?:st|nd|rd|th)?(?![\\w'’%:.]|\\.\\d)`],
      ["#", `\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${T_MONTH}${T_END}|(?<=\\b(?:on|by|until|till|thru|through|from|starting|before|after|since|for|except|not)\\s+)\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?(?![\\w/])|(?<![\\w./-])\\d{1,2}/\\d{1,2}/\\d{2,4}(?![\\w/])|\\b(?:19|20)\\d{2}-\\d{2}-\\d{2}(?![\\d])`],
      [T_WD_ABBR_WORDS, `\\b${T_WD_ABBR}\\.?\\s*(?:[-–—/&]|,\\s*(?:and\\s+)?|\\s+and\\s+|\\s+or\\s+|\\s+(?:through|thru|to)\\s+)${T_WD_ABBR}${T_END}|(?<=\\b(?:every|each|on|next|this|last|until|till|through|from|by|before|after|not|no|except|excluding|skip|only)\\s+)${T_WD_ABBR}\\.?${T_END}|\\b${T_WD_ABBR}\\.?(?=\\s+(?:(?:at|@)\\s*\\d|\\d{1,2}(?::\\d{2}|\\s*[ap]\\.?m\\b)|(?:morning|afternoon|evening|night)s?\\b|only\\b|off\\b))`],
      ["christmas xmas thanksgiving easter halloween new black cyber labor memorial independence boxing good juneteenth diwali hanukkah ramadan passover", `\\b(?:christmas|xmas|thanksgiving|easter|halloween|new\\s+year['’]?s?(?:\\s+(?:day|eve))?|black\\s+friday|cyber\\s+monday|labor\\s+day|memorial\\s+day|independence\\s+day|boxing\\s+day|good\\s+friday|juneteenth|diwali|hanukkah|ramadan|passover)${T_END}`],
    ],
  },
  {
    kind: "except",
    alts: [["except excepting excluding excl but other apart aside skip skips skipping skipped not no never nor without w minus barring bar besides save omitting only", `\\b(?:except(?:ing)?(?:\\s+for)?|excluding|excl\\.|but\\s+not|other\\s+than|apart\\s+from|aside\\s+from|skip(?:s|ping|ped)?|not|no(?!\\s+earlier\\s+than\\b)|never|nor|without|w\\/o|minus|barring|bar|besides|save(?:\\s+for)?|omitting|only)${T_END}`]],
  },
  {
    kind: "start",
    alts: [
      ["starting beginning from as effective commencing no", `\\b(?:starting|beginning|from(?!\\s+time\\s+to\\s+time\\b)|as\\s+of|effective|commencing|no\\s+earlier\\s+than)${T_END}`],
      // "first run on Oct 20", "first run next week".
      ["first", `\\bfirst\\s+(?:run|one|time|occurrence)s?(?:\\s+(?:on|at|is|will\\s+be))?${T_END}`],
    ],
  },
  { kind: "for", alts: [["for", `\\bfor${T_END}`]] },
  { kind: "window", alts: [["between within", `\\b(?:between|within)${T_END}`]] },
  // Zones: the spellings that can be nothing else. An abbreviation is read in its own case (RESIDUE_CASED); an
  // offset starts at its sign ("+").
  {
    kind: "zone",
    alts: [
      ["africa america antarctica arctic asia atlantic australia europe indian pacific etc", `\\b(?:${IANA_ZONE})`],
      ["utc gmt", `\\b(?:utc|gmt)(?:\\s*[+−-]\\s*\\d{1,2}(?::?\\d{2})?)?${T_END}`],
      ["+", `(?<![\\w.:/-])[+−-]\\d{2}:\\d{2}(?![\\d:])`],
      ["time timezone timezones", `\\b(?:time\\s?zones?|timezones?)${T_END}`],
      ["my local server", `\\b(?:my|local|server)\\s+time${T_END}`],
      ["standard daylight", `\\b(?:standard|daylight)\\s+(?:savings?\\s+)?time${T_END}`],
      [`pacific eastern central mountain atlantic alaska hawaii la ny nyc sf uk us ${firstWords(ZONE_PLACE)}`, `\\b(?:pacific|eastern|central|mountain|atlantic|alaska|hawaii|la|ny|nyc|sf|uk|us|${ZONE_PLACE})\\s+time${T_END}`],
      ["time times", `\\btimes?\\s+(?:are\\s+|is\\s+|in\\s+)?(?:pacific|eastern|central|mountain|atlantic|utc|gmt|local)${T_END}`],
      [`${firstWords(ZONE_CITY)} ${firstWords(ZONE_CITY_EXTRA)}`, `\\b(?:${ZONE_CITY}|${ZONE_CITY_EXTRA})(?![\\w'’/])`],
    ],
  },
  // Frequencies and counts of runs.
  {
    kind: "freq",
    alts: [
      ["every each", `\\b(?:every|each)\\s+(?:single\\s+|other\\s+|second\\s+|third\\s+|fourth\\s+|few\\s+|couple\\s+(?:of\\s+)?|several\\s+|${T_QTY}\\s+)?${T_EVERY_NOUN}${T_END}`],
      [`once twice thrice several multiple many ${T_QTY_WORDS} #`, `\\b(?:once|twice|thrice|${T_QTY}\\s+times|\\d+\\s?x|several\\s+times|multiple\\s+times|many\\s+times)(?:\\s+(?:a|an|per|every|each|on|in\\s+the)\\s+|\\s*/\\s*|[\\s-]+)(?:${T_EVERY_NOUN}|${FREQ_WORDS.join("|")})${T_END}`],
      [`${FREQ_WORDS.join(" ")} ${["semi", "bi", "tri", "half"].flatMap((p) => FREQ_WORDS.map((f) => p + f)).join(" ")} semi bi tri half everyday`, `\\b(?:(?:semi|bi|tri|half)-?)?(?:${FREQ_WORDS.join("|")})(?![\\w'’]|-\\w)|\\beveryday${T_END}`],
      ["periodically from every now once on round around at #", `\\b(?:periodically|from\\s+time\\s+to\\s+time|every\\s+so\\s+often|now\\s+and\\s+then|once\\s+in\\s+a\\s+while|on\\s+the\\s+(?:half\\s+)?hour|(?:a)?round\\s+the\\s+clock|24\\s*/\\s*7|at\\s+random\\s+times|at\\s+a\\s+random\\s+time|on\\s+an?\\s+(?:hourly|daily|nightly|weekly|monthly|regular)\\s+basis)${T_END}`],
    ],
  },
  // Spans of time: "24 hours", "a few days", "3 more weeks", "half an hour", "a 5-minute check", "48h".
  {
    kind: "duration",
    alts: [
      // Not "0930 hrs", a clock (below).
      [`${T_QTY_WORDS} #`, `\\b(?!(?:[01]\\d|2[0-3])[0-5]\\d\\s*(?:h|hrs|hours)${T_END})${T_QTY}(?:\\s+(?:more|extra|additional|other|full|whole))?[\\s-]+${T_UNIT}${T_END}`],
      ["#", `(?<![\\w.$€£])(?!(?:2|3)d\\b|(?:[01]\\d|2[0-3])[0-5]\\d\\s*(?:h|hrs|hours)${T_END})\\d+(?:\\.\\d+)?(?:h|m|d|w|y|\\s?(?:hrs?|mins?|wks?|mo|mos|yrs?))${T_END}`],
    ],
  },
  // Clocks and times of day.
  {
    kind: "clock",
    alts: [
      ["#", `\\b\\d{1,2}(?::\\d{2})?\\s*(?:[ap]\\.m\\.?|[ap]m)(?![a-z])|(?<![\\w:./-])\\d{1,2}:\\d{2}(?![\\d:])|\\b\\d{1,2}h\\d{2}${T_END}|\\b(?:[01]\\d|2[0-3])[0-5]\\d\\s*(?:h|hrs|hours)${T_END}|(?<=(?:\\bat\\s*|@\\s*))(?:[01]\\d|2[0-3])[0-5]\\d${T_END}`],
      ["noon noonish midnight midday o overnight morning mornings afternoon afternoons evening evenings night nights lunchtime lunch daytime nighttime sunrise sunset dawn dusk daybreak nightfall eod eob cob first", `\\b(?:noon|noonish|midnight|midday|o['’]clock|overnight|mornings?|afternoons?|evenings?|nights?|lunchtime|lunch\\s+time|daytime|nighttime|night-time|sunrise|sunset|dawn|dusk|daybreak|nightfall|eod|eob|cob|first\\s+thing)${T_END}`],
      ["lunch breakfast dinner standup stand", `(?<=\\b(?:at|around|after|before|by|until|till)\\s+)(?:lunch|breakfast|dinner|standup|stand-up)${T_END}`],
      ["half quarter a ten five twenty", `\\bhalf\\s+past(?:\\s+(?:\\d{1,2}|${T_HOUR_WORD}|noon|midnight|the\\s+hour))?${T_END}|\\b(?:half|quarter|a\\s+quarter|ten|five|twenty|twenty-five)\\s+(?:past|to|till|til|after|of)\\s+(?:\\d{1,2}|${T_HOUR_WORD}|noon|midnight|the\\s+hour)${T_END}`],
      ["#", `\\b\\d{1,2}\\s+(?:past|after)\\s+(?:\\d{1,2}|${T_HOUR_WORD})${T_END}`],
      ["one two three four five six seven eight nine ten eleven twelve #", `(?<=(?:\\b(?:at|around|before|after|until|till|by|from|between)\\s+|@\\s*))(?:1[0-2]|0?[1-9]|${T_HOUR_WORD})(?:\\s*(?:,|and|or|&|-|–|to)\\s*(?:1[0-2]|0?[1-9]|${T_HOUR_WORD}))*${T_CLOCK_NEXT}`],
    ],
  },
]
/** Each word that can start a word of time, and the alternatives to try there, in rule order. */
const RESIDUE_TRIGGER = new Map<string, { re: RegExp; rule: ResidueRule }[]>()
for (const rule of RESIDUE_RULES) {
  for (const [first, src] of rule.alts) {
    const re = new RegExp(src, "y")
    for (const w of new Set(first.split(/\s+/))) {
      const at = RESIDUE_TRIGGER.get(w)
      if (at) at.push({ re, rule })
      else RESIDUE_TRIGGER.set(w, [{ re, rule }])
    }
  }
}
const RESIDUE_TRIGGER_MAX = Math.max(...[...RESIDUE_TRIGGER.keys()].map((w) => w.length))
/** The words read in their own case: a zone abbreviation in capitals ("PT", "UTC" — "pt" and "est." are
 *  English), the ones that are also common acronyms (CT, MT, BST, …) only after a clock or a zone's own words; a
 *  weekday abbreviation with its capital ("Sat", never "sat on it"); "May" and "March" not opening a sentence; a
 *  month's capitalized abbreviation. */
const RESIDUE_CASED: { kind: ResidueKind; re: RegExp; words: ReadonlySet<string>; sentenceStart?: "never" | "context" }[] = [
  {
    kind: "zone",
    re: /(?:PT|PST|PDT|ET|EST|EDT|CST|CDT|MST|MDT|UTC|UCT|GMT|CET|CEST|IST|JST|KST|AEST|AEDT|AET|ACST|ACDT|AWST|NZST|NZDT|NZT|WET|WEST|EET|EEST|MSK|HST|AKST|AKDT|SGT|HKT|PHT|WIB|WITA|SAST|BRT|PKT|NPT|ADT|NDT|CLT|TRT|MYT|PST8PDT|EST5EDT|CST6CDT|MST7MDT)(?![\w'’/])|(?<=(?:\d\s*(?:[aApP]\.?[mM]\.?)?\s*|\(\s*|\btimes?\s+(?:are\s+|in\s+)?|\bin\s+|\buse\s+))(?:BST|AST|CT|MT|ART|CAT|EAT|WAT|IDT|ICT|NST|GST|COT|BDT)(?![\w'’/])/y,
    words: new Set("PT PST PDT ET EST EDT CST CDT MST MDT UTC UCT GMT CET CEST IST JST KST AEST AEDT AET ACST ACDT AWST NZST NZDT NZT WET WEST EET EEST MSK HST AKST AKDT SGT HKT PHT WIB WITA SAST BRT PKT NPT ADT NDT CLT TRT MYT PST8PDT EST5EDT CST6CDT MST7MDT BST AST CT MT ART CAT EAT WAT IDT ICT NST GST COT BDT".split(" ")),
  },
  {
    kind: "day",
    re: /(?:Mon|Tue|Tues|Wed|Weds|Thu|Thur|Thurs|Fri|Sat|Sun|MON|TUE|TUES|WED|WEDS|THU|THUR|THURS|FRI|SAT|SUN)\b\.?/y,
    words: new Set("Mon Tue Tues Wed Weds Thu Thur Thurs Fri Sat Sun MON TUE TUES WED WEDS THU THUR THURS FRI SAT SUN".split(" ")),
    sentenceStart: "context",
  },
  { kind: "period", re: /(?:May|March|MAY|MARCH)\b/y, words: new Set(["May", "March", "MAY", "MARCH"]), sentenceStart: "never" },
  { kind: "period", re: /(?:Feb|Apr|Aug|Sep|Sept|Oct|Nov|Dec)\b\.?/y, words: new Set("Feb Apr Aug Sep Sept Oct Nov Dec".split(" ")) },
]
/** What a governor narrows. A governor reaches at most three words, in its own sentence ("until the end of the
 *  sprint", "for the next 2 hours", "no runs after 6pm"). */
const GOVERNS: Partial<Record<ResidueKind, ReadonlySet<ResidueKind>>> = {
  narrow: new Set<ResidueKind>(["period", "day", "narrow", "duration"]),
  bound: new Set<ResidueKind>(["period", "duration", "day", "clock", "narrow"]),
  except: new Set<ResidueKind>(["period", "day", "narrow", "clock"]),
  start: new Set<ResidueKind>(["period", "day", "clock"]),
  for: new Set<ResidueKind>(["period", "duration", "day"]),
  window: new Set<ResidueKind>(["period", "day", "clock", "narrow"]),
}
/** Right after a day, a period or a span, a word that makes it an exclusion or a limit: "Sundays off", "weekdays
 *  only", "this week only". Not after a clock or a frequency ("5pm only" moves the run). */
const POSTPOSED_NARROW = /^\s+(?:only|off|excluded|excepted|skipped|exempt)(?![\w'’])/
const POSTPOSED_KINDS = new Set<ResidueKind>(["day", "period", "duration"])
/** Between two words one governor reaches in a row: a list or a range ("except Mondays, Fridays and the 1st",
 *  "between 9am and 5pm"), never a clause ("not just Mondays but Fridays"). */
const CHAIN_GAP = /^[\s,]*(?:(?:and|or|nor|&|\/|-|–|—|to|through|thru|until|till|plus)\s*)?(?:(?:on|the|in|at)\s+)?$/
/** An adjective's slot: "the weekly digest", "a 30-minute call", "our morning standup", "the Monday sync" name
 *  a THING; the words after them are what is acted on, not when. At the end of the text the noun is still being
 *  typed ("post the weekly"), and the reading holds rather than flicker to a cue and back. */
const ATTRIBUTIVE_BEFORE = /(?:^|[^\w'’])(?:the|a|an|our|my|your|their|its|his|her)\s$/
const ATTRIBUTIVE_AFTER = /^(?:\s*$|\s(?!(?:and|or|at|on|in|of|to|for|from|by|with|until|till|after|before|is|are|was|were|be|then|but|every|each|only|off|sharp|ish|time|times|basis|o['’]clock|onwards?|later|earlier|ago)(?![\w'’]))[a-z][a-z-]{2,})/
/** The words that can be such an adjective: a frequency's, a time of day, a weekday, a clock, "30-minute". */
const ATTRIBUTIVE_WORD = new RegExp(`^(?:(?:(?:semi|bi|tri|half)-?)?(?:hourly|daily|nightly|weekly|fortnightly|monthly|quarterly|yearly)|morning|afternoon|evening|night|overnight|midday|lunchtime|weekend|weekday|${WD_NAME}|\\d+[\\s-]?(?:minute|min|hour|hr|day|week|month|year)|\\d{1,2}(?::\\d{2})?\\s*[ap]\\.?m\\.?)$`)

interface ResidueToken {
  start: number
  end: number
  kind: ResidueKind
  /** It can only take runs away: a narrowing word, or a time word one governs. */
  narrow: boolean
}
type RawToken = { start: number; end: number; kind: ResidueKind; alone: boolean }

/** Whether a governor at `a` reaches a word at `b`: the same sentence, at most three words between. */
function inReach(m: string, a: number, b: number): boolean {
  if (b < a || b - a > 48) return false
  const gap = m.slice(a, b)
  return !/[.;!?\n\u0001]/.test(gap) && (gap.match(/[^\s,&]+/g)?.length ?? 0) <= 3
}

/** Where a sentence starts at or before `i`: only spaces, quotes or a bullet after the last stop. */
function opensSentence(t: string, i: number): boolean {
  let j = i - 1
  while (j >= 0 && /[\s"'“‘(*•>#-]/.test(t[j]!)) j--
  return j < 0 || /[.!?:\n]/.test(t[j]!)
}

const isWordCode = (c: number) => (c >= 97 && c <= 122) || (c >= 48 && c <= 57)

/** Whether words are part of code: glued to a path, a file's extension, an identifier or a variable ("daily.yml",
 *  "src/weekly", "cron_daily", "$EOD", "@tuesday-team"). The residue skips them, and so do the older checks
 *  that look for a word of time anywhere (`judge`), or "fix daily.yml" is a second frequency. */
function gluedToCode(t: string, s: Span): boolean {
  const before = t[s.start - 1] ?? ""
  if (/[/\\._#$=]/.test(before) || (before === "@" && /[a-z]/i.test(t[s.start] ?? ""))) return true
  return /^(?:[/\\_=(\[]\w|\.[a-z][a-z0-9]{0,3}(?![\w-]))/.test(t.slice(s.end, s.end + 6))
}

/** Every word of time in the text, in order, none overlapping — but those wholly inside `span`, the phrase's
 *  own — each handed to `each`, which ends the walk by returning true. A word of time that starts inside the
 *  phrase and runs out of it ("every MONTH END", "Mon and FRI MORNINGS") is found: the walk goes on at the next
 *  word after one inside the phrase, not past its end. */
function scanResidue(p: Prep, span: Span, each: (r: RawToken) => boolean | void): void {
  const m = p.masked, t = p.text, n = m.length
  let i = 0
  while (i < n) {
    const c = m.charCodeAt(i)
    let j = i + 1
    let alts: { re: RegExp; rule: ResidueRule }[] | undefined
    let upper = false
    if (isWordCode(c)) {
      while (j < n && isWordCode(m.charCodeAt(j))) j++
      if (c <= 57) alts = RESIDUE_TRIGGER.get("#")
      else if (j - i <= RESIDUE_TRIGGER_MAX) alts = RESIDUE_TRIGGER.get(c === 102 && m.charCodeAt(i + 1) === 121 && j - i > 2 ? "fy" : m.slice(i, j))
      const C = t.charCodeAt(i)
      upper = C >= 65 && C <= 90 && j - i <= 7
    } else if ((c === 43 || c === 45 || c === 0x2212) && /\d/.test(m[i + 1] ?? "")) {
      alts = RESIDUE_TRIGGER.get("+")
    }
    let hit: RawToken | undefined
    if (alts) {
      for (const { re, rule } of alts) {
        re.lastIndex = i
        const mm = re.exec(m)
        if (mm && mm[0].length) {
          hit = { start: i, end: i + mm[0].length, kind: rule.kind, alone: !!rule.alone }
          break
        }
      }
    }
    if (!hit && upper) {
      const original = t.slice(i, j)
      for (const k of RESIDUE_CASED) {
        if (!k.words.has(original)) continue
        k.re.lastIndex = i
        const mm = k.re.exec(t)
        if (!mm) continue
        if (k.sentenceStart && opensSentence(t, i)) {
          if (k.sentenceStart === "never") continue
          // "Sat with the team", "Sun is out": any word is capitalized there. Only beside a list, a span, a
          // clock or a time of day ("Mon and Fri mornings, …") is it a day.
          const e = i + mm[0].length
          if (!/^\.?\s*(?:[-–—/&,]|and\b|or\b|through\b|thru\b|to\b|\d|at\b|@|(?:morning|afternoon|evening|night)s?\b)/i.test(t.slice(e, e + 16))) continue
        }
        hit = { start: i, end: i + mm[0].length, kind: k.kind, alone: false }
        break
      }
    }
    if (hit && !(hit.start >= span.start && hit.end <= span.end)) {
      if (each(hit)) return
      j = Math.max(j, hit.end)
    }
    i = j
  }
}

/** The words of time outside `span`, in order, each marked whether it can only narrow the reading — up to the
 *  one that settles it (fix round 3: a 20k prompt full of them cost 2.6ms more than the windows): the second
 *  word that may add or move a run, or the first that is not a clock (see `residueNarrows`). */
function temporalResidue(p: Prep, span: Span): ResidueToken[] {
  const m = p.masked, t = p.text
  // Governors narrow what they govern, through a list ("except Mondays, Fridays and holidays"); one with nothing
  // in reach and no meaning of its own is no word of time. A day or a period followed by "only" or "off" narrows
  // itself. A governor waits for the next word to know which it is.
  const out: ResidueToken[] = []
  let chain: { end: number; governs: ReadonlySet<ResidueKind>; fromGovernor: boolean } | undefined
  let pending: RawToken | undefined
  let wide = 0
  const settle = (next: RawToken | undefined) => {
    if (!pending) return
    const governs = GOVERNS[pending.kind]!
    const reaches = !!next && governs.has(next.kind) && inReach(m, pending.end, next.start)
    if (reaches || pending.alone) out.push({ start: pending.start, end: pending.end, kind: pending.kind, narrow: true })
    chain = reaches ? { end: pending.end, governs, fromGovernor: true } : undefined
    pending = undefined
  }
  scanResidue(p, span, (k) => {
    // A run the grammar never reads, and code: "daily.yml", "src/weekly", "cron_daily", "$EOD".
    if (m.slice(k.start, k.end).includes(MASK) || gluedToCode(t, k)) return
    // An adjective naming a thing: "the weekly digest", "a 30-minute call", "the morning standup".
    if (ATTRIBUTIVE_WORD.test(m.slice(k.start, k.end)) && ATTRIBUTIVE_BEFORE.test(m.slice(Math.max(0, k.start - 8), k.start)) && ATTRIBUTIVE_AFTER.test(m.slice(k.end, k.end + 24))) return
    settle(k)
    if (GOVERNS[k.kind]) {
      pending = k
      return
    }
    const governed = !!chain && chain.governs.has(k.kind) && (chain.fromGovernor ? inReach(m, chain.end, k.start) : CHAIN_GAP.test(m.slice(chain.end, k.start)))
    const narrow = governed || k.kind === "period" || (POSTPOSED_KINDS.has(k.kind) && POSTPOSED_NARROW.test(m.slice(k.end, k.end + 12)))
    out.push({ start: k.start, end: k.end, kind: k.kind, narrow })
    chain = governed ? { end: k.end, governs: chain!.governs, fromGovernor: false } : undefined
    if (!narrow && (++wide > 1 || k.kind !== "clock")) return true
  })
  settle(undefined)
  return out
}

/** The words that cross a night into the next day: over a weekly core they can move its date. */
const NIGHT_CROSSING = /^(?:overnight|midnight)$/
/** More than one clock in one word of time: "at 9 and 5", "at 9, 12", "from 9-5", "until 9 to 10". */
const CLOCK_LIST = /\b(?:and|or)\b|[,&]|\d\s*(?:[-–—]|to\b)\s*\d/

/** Whether every word of time left can only narrow `core`. One more word is no constraint on a part the core
 *  ASSUMED, since `readingsConsistent` does not compare it (§4.3): a single clock or time of day over an assumed
 *  time ("every Monday, around 2" — round 2's rule for a clock touching the phrase), unless it crosses midnight
 *  over a core with days, where it can be the next day's ("every Monday overnight"); a single weekday over an
 *  assumed day ("have it done by Friday every week"). */
function residueNarrows(p: Prep, tokens: readonly ResidueToken[], core: { rrule: string; assumed: readonly Assumed[] }): boolean {
  const wide = tokens.filter((x) => !x.narrow)
  if (wide.length === 0) return true
  if (wide.length > 1) return false
  const words = p.masked.slice(wide[0]!.start, wide[0]!.end)
  if (wide[0]!.kind === "clock" && core.assumed.some((a) => a.part === "time") && !CLOCK_LIST.test(words)) {
    const daily = /FREQ=DAILY/.test(core.rrule) && !/BYDAY/.test(core.rrule)
    return daily || !NIGHT_CROSSING.test(words)
  }
  if (wide[0]!.kind === "day" && core.assumed.some((a) => a.part === "day" && a.shift === undefined)) return new RegExp(`^${WD_NAME}s?$`).test(words)
  return false
}

/** The cue an exact reading becomes for its residue: its unread words (the first word of time, and the words it
 *  governs) and its why. */
function residueUnread(p: Prep, span: Span, tokens: readonly ResidueToken[]): { unread: Span; why: CueWhy } {
  const first = tokens[0]!
  let end = first.end
  if (GOVERNS[first.kind]) {
    for (let i = 1; i < tokens.length && tokens[i]!.narrow && !GOVERNS[tokens[i]!.kind] && inReach(p.masked, end, tokens[i]!.start); i++) end = tokens[i]!.end
  }
  let unread: Span = { start: first.start, end }
  // A word of time that runs into the phrase ("TWICE every Monday", "every month END"): its part outside it.
  if (unread.start < span.start && unread.end > span.start) unread = { start: unread.start, end: span.start }
  else if (unread.start < span.end && unread.end > span.end) unread = { start: span.end, end: unread.end }
  const trimmed = trimSpan(p, unread)
  if (trimmed.end > trimmed.start) unread = trimmed
  const why: CueWhy = first.kind === "zone" ? "zone" : first.kind === "freq" ? "compound" : first.kind === "narrow" || first.kind === "except" || first.kind === "window" ? "condition" : "leftover"
  return { unread, why }
}

/** The residue's rules and its walk, for the test that pins the walk to the rules matched at every position. */
export const SCHEDULE_RESIDUE_FOR_TESTS = {
  rules: RESIDUE_RULES.map(({ kind, alts }) => ({ kind, src: alts.map(([, src]) => src).join("|") })),
  cased: RESIDUE_CASED.map(({ kind, re, sentenceStart }) => ({ kind, src: re.source, sentenceStart })),
  masked: (text: string) => prepare(text, []).masked,
  scan: (text: string, span: Span = { start: 0, end: 0 }) => {
    const out: { start: number; end: number; kind: string }[] = []
    scanResidue(prepare(text, []), span, ({ start, end, kind }) => void out.push({ start, end, kind }))
    return out
  },
}

// ---- text preparation ----------------------------------------------------------------------------------------

interface Prep {
  text: string
  /** Lowercase, same length as `text`, with every unreadable character replaced by MASK. */
  masked: string
}

/** Lowercase without changing any index (a few characters lowercase to two code units). */
function sameLengthLower(text: string): string {
  const lower = text.toLowerCase()
  if (lower.length === text.length) return lower
  let out = ""
  for (const ch of text) {
    const l = ch.toLowerCase()
    out += l.length === ch.length ? l : ch
  }
  return out
}

const FENCE = /```[\s\S]*?(?:```|$)/g
const INLINE_CODE = /`[^`\n]*`/g
/** The quote pairs other typographies use, before the English ones (fix round 3: in „every Monday at 9am“ the
 *  German closer is an English OPENER, and the unclosed-quote rule masked from it to the end — leaving the
 *  quoted phrase as the end of the text, a close-edge offer). Low-high and single low-high quotes, guillemets
 *  either way, and the CJK corner brackets. */
const OTHER_QUOTES = /„[^“”\n]*[“”]|‚[^‘’\n]*[‘’]|«[^»\n]*»|»[^«\n]*«|‹[^›\n]*›|›[^‹\n]*‹|「[^」\n]*」|『[^』\n]*』/g
const STRAIGHT_QUOTE = /"[^"\n]*"/g
const CURLY_QUOTE = /“[^”\n]*”/g
/** Single curly quotes: ‘every Monday’. The closer is also the apostrophe ("it’s"), so a pair ends at the first. */
const SINGLE_CURLY_QUOTE = /‘[^’\n]*’/g
const LEADING_COMMAND = /^\s*\/[a-z][\w:.-]*/

function prepare(text: string, exclude: readonly Span[]): Prep {
  let s = sameLengthLower(text)
  const mask = (start: number, end: number) => {
    const a = Math.max(0, start), b = Math.min(s.length, end)
    if (b > a) s = s.slice(0, a) + MASK.repeat(b - a) + s.slice(b)
  }
  for (const span of exclude) mask(span.start, span.end)
  const command = LEADING_COMMAND.exec(s)
  if (command) mask(command[0].length - command[0].trimStart().length, command[0].length)
  for (const re of [FENCE, INLINE_CODE, OTHER_QUOTES, STRAIGHT_QUOTE, CURLY_QUOTE, SINGLE_CURLY_QUOTE]) {
    s = s.replace(re, (m) => MASK.repeat(m.length))
  }
  // An unclosed quote is a quotation still being typed: nothing after it is read.
  for (const open of ['"', "“", "`", "„", "«", "「", "『"]) {
    const at = s.indexOf(open)
    if (at >= 0) mask(at, s.length)
  }
  return { text, masked: s }
}

const isSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === " "

/** The opening and closing sentence windows (§2.2): at most two spans of at most 240 characters, never
 *  holding an excluded, quoted or fenced run. One window when the text is one short sentence. */
export function scheduleWindows(text: string, exclude: readonly Span[]): Span[] {
  return windowsOf(prepare(text, exclude).masked)
}

/** Whether each edge window holds a gate word (§2.1) — what re-arms a dismissed edge (§8): an edge whose
 *  window holds no recurrence word at a publish point has had its phrase deleted, so the human's "not a
 *  schedule" no longer has anything to apply to. The same windows and the same gate the edge read uses. */
export function scheduleEdgeGates(text: string, exclude: readonly Span[] = []): { open: boolean; close: boolean } {
  const p = prepare(text, exclude)
  const windows = windowsOf(p.masked)
  if (windows.length === 0) return { open: false, close: false }
  const open = windows[0]!, close = windows[windows.length - 1]!
  const openGate = GATE.test(p.masked.slice(open.start, open.end))
  return { open: openGate, close: close === open ? openGate : GATE.test(p.masked.slice(close.start, close.end)) }
}

/** An abbreviation whose dot is its own: a weekday's or a month's ("every Wed. at 3", "every Jan. 15"), or
 *  a qualifier's ("excl. weekends" ended the closing window at "excl.", which left "weekends" a sentence). */
const ABBR_BEFORE_DOT = /(?:^|[^a-z])(?:mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|excl|incl|approx|vs)$/

/** A sentence ends at ". ", "! ", "? " or a newline — but not at the dot of "a.m." or "p.m.", nor at an
 *  abbreviation's: "every Wed. at 3" ended its window at "Wed", so the clock never attached and the box
 *  offered Wednesday at an assumed 9am, saving ". at 3 review billing" as the task. */
function sentenceEnd(m: string, i: number): boolean {
  const c = m[i]
  if (c !== "." && c !== "!" && c !== "?") return false
  if (!(i + 1 >= m.length || isSpace(m[i + 1]))) return false
  if (c !== ".") return true
  return !/[ap]\.m$/.test(m.slice(Math.max(0, i - 3), i)) && !ABBR_BEFORE_DOT.test(m.slice(Math.max(0, i - 6), i))
}

function windowsOf(m: string): Span[] {
  const n = m.length
  let s = 0
  while (s < n && (isSpace(m[s]) || m[s] === MASK)) s++
  if (s >= n) return []
  let e = s
  const limit = Math.min(n, s + WINDOW_MAX)
  while (e < limit) {
    const c = m[e]
    if (c === MASK || c === "\n" || sentenceEnd(m, e)) break
    e++
  }
  while (e > s && isSpace(m[e - 1])) e--
  const open = { start: s, end: e }
  let ce = n
  // Trailing punctuation is not the sentence — except the dot of a final "p.m.", which is the clock's.
  while (ce > 0 && (isSpace(m[ce - 1]) || (m[ce - 1] === "." && !/[ap]\.m$/.test(m.slice(Math.max(0, ce - 4), ce - 1))) || m[ce - 1] === "!" || m[ce - 1] === ")" || m[ce - 1] === MASK)) ce--
  if (ce <= 0) return [open]
  let cs = ce
  const floor = Math.max(0, ce - WINDOW_MAX)
  while (cs > floor) {
    const c = m[cs - 1]
    if (c === MASK || c === "\n" || (sentenceEnd(m, cs - 1) && cs < n)) break
    cs--
  }
  while (cs < ce && isSpace(m[cs])) cs++
  const close = { start: cs, end: ce }
  if (close.start === open.start && close.end === open.end) return [open]
  return [open, close]
}

// ---- the parts of a phrase -----------------------------------------------------------------------------------

type Freq = "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY"
interface DaySpec {
  day: number
  nth?: number
}
interface YMD {
  y: number
  mo: number
  d: number
}
interface Clock {
  h: number
  mi: number
  /** Said as "midnight": the START of the day it names, to the engine, and its end to many (fix round 3). */
  midnight?: true
  /** "at 3" read with the work-hours rule: the hour it did not take, where the number is, and the number
   *  as typed (1–12), so a time of day found later can settle it (`settleClock`). */
  guess?: { other: number; span: Span; bare: number }
}

/** The part of a phrase that says how often. `type` sorts out what the reading will be. */
interface Core {
  start: number
  end: number
  type: "rule" | "once" | "vague" | "unsupported" | "ambiguous"
  freq?: Freq
  interval?: number
  byDay?: DaySpec[]
  byMonthDay?: number[]
  byMonth?: number[]
  bySetPos?: number
  /** HOURLY minute marks ("every 15 minutes"). */
  minutes?: number[]
  /** Runs closer than 15m. */
  spacing?: boolean
  tod?: { key: string; word: string }
  /** An adverb or bare plural: a schedule only beside a modifier or before a clause boundary. */
  gated?: boolean
  /** A gated two-meaning adverb ("biweekly"), live also where a clause starts: "biweekly sync the doc"
   *  is about a schedule, "the quarterly OKRs" is not. */
  clauseStartOk?: boolean
  /** A day the words left out, filled in and marked. */
  dayAssumed?: string
  /** A yearly rule with no date yet. */
  needsDate?: boolean
  /** "quarterly" waiting for "on the first weekday". */
  quarter?: boolean
  once?: { date: YMD; clock?: Clock; needsClock?: boolean; next?: boolean }
  word?: keyof typeof SCHEDULE_AMBIGUOUS_COPY
}

type Mod =
  | { k: "clock"; clocks: Clock[]; start: number; end: number }
  | { k: "minute"; minutes: number[]; start: number; end: number }
  | { k: "tod"; key: string; word: string; start: number; end: number }
  | { k: "window"; from: Clock; to: Clock; guessed: boolean; start: number; end: number }
  | { k: "days"; days: number[]; start: number; end: number }
  | { k: "monthDays"; days: number[]; start: number; end: number }
  | { k: "monthPos"; byDay?: DaySpec[]; bySetPos?: number; byMonthDay?: number[]; start: number; end: number }
  | { k: "date"; mo: number; d: number; start: number; end: number }
  | { k: "count"; n: number; start: number; end: number }
  | { k: "for"; n: number; unit: "day" | "week" | "month"; start: number; end: number }
  | { k: "until"; date: YMD; start: number; end: number }
  | { k: "start"; date: YMD; start: number; end: number }
  | { k: "startClock"; clock: Clock; start: number; end: number }
  | { k: "zone"; start: number; end: number }

interface Ctx {
  nowMs: number
  tz: string
  today: YMD
  oneShots: boolean
}

/** The part of the day a bare clock was said in ("every night at 2", "at 2 in the morning"). */
type DayPart = "morning" | "afternoon" | "evening" | "night"

/** The part of the day a time-of-day word names. EOD is an afternoon clock (5pm). */
function partOf(word: string | undefined): DayPart | undefined {
  if (!word) return undefined
  if (/morning|first thing/.test(word)) return "morning"
  if (/afternoon|end of day/.test(word)) return "afternoon"
  if (/evening/.test(word)) return "evening"
  if (/night/.test(word)) return "night"
  return undefined
}

/**
 * A bare 1–12 (`bare`) in a part of the day. Where the part settles it the clock is SURE: morning 1–11 is am,
 * afternoon 12–6 pm, evening 5–11 pm, night 7–11 pm, 12 midnight and 1–5 am ("every night at 2" is 2am —
 * it was read as 2pm, unmarked, because every part but the morning meant "pm"). Where the words contradict
 * themselves ("every evening at 3", "every night at 6", "every morning at 12") it keeps the reading nearer
 * the part and SAYS it is a guess, so the box dims it and offers the other. With no part: the work-hours
 * rule, 7–11 morning, 12 noon, 1–6 afternoon, always a guess.
 */
function settleClock(bare: number, mi: number, part: DayPart | undefined, span: Span): Clock {
  const am = bare % 12, pm = (bare % 12) + 12
  const sure = (h: number): Clock => ({ h, mi })
  const guess = (h: number, other: number): Clock => ({ h, mi, guess: { other, span, bare } })
  switch (part) {
    case "morning":
      return bare === 12 ? guess(0, 12) : sure(am)
    case "afternoon":
      return bare === 12 || bare <= 6 ? sure(pm) : guess(pm, am)
    case "evening":
      return bare >= 5 && bare <= 11 ? sure(pm) : bare === 12 ? guess(0, 12) : guess(pm, am)
    case "night":
      return bare >= 7 && bare <= 11 ? sure(pm) : bare === 12 ? sure(0) : bare <= 5 ? sure(am) : guess(pm, am)
    default:
      return bare === 12 ? guess(12, 0) : bare >= 7 ? guess(am, pm) : guess(pm, am)
  }
}

function parseClock(raw: string, at: number, part?: DayPart): Clock | undefined {
  const t = raw.trim()
  if (/^(?:noon|midday)$/.test(t)) return { h: 12, mi: 0 }
  if (t === "midnight") return { h: 0, mi: 0, midnight: true }
  const m = /^(\d{1,2})(?::(\d{2}))?\s*([ap]\.m\.?|[ap]m)?$/.exec(t)
  if (!m) return undefined
  const h = parseInt(m[1]!, 10)
  const mi = m[2] ? parseInt(m[2], 10) : 0
  if (mi > 59) return undefined
  if (m[3]) {
    if (h < 1 || h > 12) return undefined
    return { h: (h % 12) + (m[3][0] === "p" ? 12 : 0), mi }
  }
  if (h > 23) return undefined
  if (h === 0 || h >= 13 || /^0\d/.test(m[1]!)) return { h, mi }
  return settleClock(h, mi, part, { start: at, end: at + m[1]!.length + (m[2] ? m[2].length + 1 : 0) })
}

/** Each clock in a clock list, with its offset. */
function clocksIn(text: string, offset: number, part?: DayPart): Clock[] | undefined {
  const out: Clock[] = []
  const re = new RegExp(CLOCK_ANY, "g")
  for (const m of text.matchAll(re)) {
    const c = parseClock(m[0], offset + m.index!, part)
    if (!c) return undefined
    out.push(c)
  }
  return out.length ? out : undefined
}

// ---- date helpers ----------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000
const dayNo = (d: YMD) => Math.floor(Date.UTC(d.y, d.mo - 1, d.d) / DAY_MS)
function fromDayNo(n: number): YMD {
  const t = new Date(n * DAY_MS)
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() }
}
const weekdayOfYmd = (d: YMD) => (((dayNo(d) % 7) + 7 + 3) % 7)
const addDays = (d: YMD, n: number) => fromDayNo(dayNo(d) + n)
function addMonths(d: YMD, n: number): YMD {
  const total = d.y * 12 + (d.mo - 1) + n
  const y = Math.floor(total / 12), mo = (total % 12) + 1
  return { y, mo, d: Math.min(d.d, daysInMonth(y, mo)) }
}
const daysInMonth = (y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).getUTCDate()
const pad2 = (n: number) => String(n).padStart(2, "0")
const ymdString = (d: YMD) => `${d.y}${pad2(d.mo)}${pad2(d.d)}`
const compareYmd = (a: YMD, b: YMD) => dayNo(a) - dayNo(b)

/** The coming `day` (0 = Monday) after today; today itself only when `allowToday`. */
function comingWeekday(ctx: Ctx, day: number, allowToday: boolean): YMD {
  for (let i = allowToday ? 0 : 1; i < 8; i++) {
    const d = addDays(ctx.today, i)
    if (weekdayOfYmd(d) === day) return d
  }
  return ctx.today
}

/** Two days in one week, weeks starting on a Monday (as BYDAY and `readingsConsistent` count them). */
const sameWeek = (a: YMD, b: YMD) => Math.floor((dayNo(a) + 3) / 7) === Math.floor((dayNo(b) + 3) / 7)

/** "Next Tuesday" said on a Monday is tomorrow to some and the Tuesday after to others (fix round 3: it read as
 *  tomorrow, unmarked). The coming day is the ambiguous one when it falls in this week; past the weekend, "next
 *  Tuesday" can only be the coming one. */
const nextIsAmbiguous = (ctx: Ctx, coming: YMD) => sameWeek(coming, ctx.today)

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const SHORT_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
/** "Tue Oct 6": the date a day tip names. */
const dayWords = (d: YMD) => `${SHORT_DAYS[weekdayOfYmd(d)]} ${SHORT_MONTHS[d.mo - 1]} ${d.d}`

/** A month and day with no year: this year's, or next year's once it has passed. */
function nextDate(ctx: Ctx, mo: number, d: number, after = ctx.today): YMD | undefined {
  if (mo < 1 || mo > 12 || d < 1) return undefined
  for (const y of [after.y, after.y + 1]) {
    if (d > daysInMonth(y, mo)) continue
    const date = { y, mo, d }
    if (compareYmd(date, after) >= 0) return date
  }
  return undefined
}

/** A date as words: "Oct 30", "30 Oct", "10/30", "Friday", "next Monday", "tomorrow", "today", "next week",
 *  "next month". */
const DATE_WORDS = `(?:(?:${MONTH})\\s*${DAYN}(?:,?\\s*\\d{4})?|${DAYN}\\s+(?:of\\s+)?(?:${MONTH})(?:,?\\s*\\d{4})?|\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?(?![\\d/])|(?:next\\s+|this\\s+)?${WD_ONE}|tomorrow|today|next\\s+week|next\\s+month)`

function dateOf(raw: string, ctx: Ctx, after?: YMD): YMD | undefined {
  const t = raw.trim()
  if (t === "today") return ctx.today
  if (t === "tomorrow") return addDays(ctx.today, 1)
  if (t === "next week") return comingWeekday(ctx, 0, false)
  if (t === "next month") return { ...addMonths({ ...ctx.today, d: 1 }, 1), d: 1 }
  const wd = new RegExp(`^(?:(next|this)\\s+)?(${WD_ONE})$`).exec(t)
  if (wd) {
    const coming = comingWeekday(ctx, dayIndex(wd[2]!), wd[1] === "this")
    // A bound or a start on an ambiguous "next Tuesday" is not read (fix round 3): it stays in the words the
    // model reads, rather than end or begin a schedule on the day half the people did not mean.
    return wd[1] === "next" && nextIsAmbiguous(ctx, coming) ? undefined : coming
  }
  const md = new RegExp(`^(${MONTH})\\s*(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?$`).exec(t)
  const dm = new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH})(?:,?\\s*(\\d{4}))?$`).exec(t)
  const slash = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(t)
  let mo: number, d: number, y: number | undefined
  if (md) [mo, d, y] = [monthIndex(md[1]!), parseInt(md[2]!, 10), md[3] ? parseInt(md[3], 10) : undefined]
  else if (dm) [mo, d, y] = [monthIndex(dm[2]!), parseInt(dm[1]!, 10), dm[3] ? parseInt(dm[3], 10) : undefined]
  else if (slash) {
    // US order, unless the first number cannot be a month.
    let a = parseInt(slash[1]!, 10), b = parseInt(slash[2]!, 10)
    if (a > 12 && b <= 12) [a, b] = [b, a]
    ;[mo, d] = [a, b]
    y = slash[3] ? (slash[3].length === 2 ? 2000 + parseInt(slash[3], 10) : parseInt(slash[3], 10)) : undefined
  } else return undefined
  if (y !== undefined) return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo) ? { y, mo, d } : undefined
  return nextDate(ctx, mo, d, after ?? ctx.today)
}

// ---- modifiers -------------------------------------------------------------------------------------------------
// What can sit beside a core and belong to it: clocks, times of day, windows, days, bounds and starts.
// Each is tried at the position right after the phrase so far (forward), and the clock, time-of-day,
// bound and start ones also right before it ("at 9am every weekday", "starting Monday, every weekday").

interface ModDef {
  src: string
  back: boolean
  build: (m: RegExpExecArray, at: number, ctx: Ctx, core: Core) => Mod[] | undefined
}

const MODS: ModDef[] = [
  {
    // from 9 to 5 · between 9am and 5pm
    src: `(?:from|between)\\s+(${CLOCK_ANY})\\s*(?:to|and|until|till|through|-|–)\\s*(${CLOCK_ANY})`,
    back: false,
    build: (m, at) => {
      const fromAt = at + m[0].indexOf(m[1]!)
      const toAt = at + m[0].lastIndexOf(m[2]!)
      const a = parseClock(m[1]!, fromAt), b = parseClock(m[2]!, toAt)
      if (!a || !b) return undefined
      // The pair settles most guesses: "9 to 5" can only be 9am–5pm inside one day.
      let from = a, to = b
      if (b.guess && b.h <= a.h) to = { h: (b.h % 12) + 12, mi: b.mi, guess: b.guess }
      const flipped = { from: a.guess ? a.guess.other : a.h, to: to.guess ? (to.h >= 12 ? to.h - 12 : to.h + 12) : to.h }
      const guessed = (!!a.guess || !!to.guess) && flipped.from < flipped.to
      from = { h: a.h, mi: a.mi }
      to = { h: to.h, mi: to.mi }
      return [{ k: "window", from, to, guessed, start: at, end: at + m[0].length }]
    },
  },
  {
    // from Oct 12 until Oct 30 · from 10 May until 20 May
    src: `from\\s+(${DATE_WORDS})\\s+(?:until|till|to|through|thru)\\s+(${DATE_WORDS})${END}`,
    back: true,
    build: (m, at, ctx) => {
      const start = dateOf(m[1]!, ctx)
      const until = start && dateOf(m[2]!, ctx, start)
      if (!start || !until) return undefined
      const end = at + m[0].length
      return [{ k: "start", date: start, start: at, end }, { k: "until", date: until, start: at, end }]
    },
  },
  {
    // starting at 9pm (an hourly rule's anchor)
    src: `(?:starting|beginning)\\s+at\\s+(${CLOCK_ANY})`,
    back: false,
    build: (m, at) => {
      const c = parseClock(m[1]!, at + m[0].lastIndexOf(m[1]!))
      return c ? [{ k: "startClock", clock: c, start: at, end: at + m[0].length }] : undefined
    },
  },
  {
    // starting tomorrow · starting on Oct 12 · beginning next Monday · from aug 3
    src: `(?:starting|beginning|from|as\\s+of|effective)\\s+(?:on\\s+|from\\s+)?(${DATE_WORDS})${END}`,
    back: true,
    build: (m, at, ctx) => {
      const date = dateOf(m[1]!, ctx)
      return date ? [{ k: "start", date, start: at, end: at + m[0].length }] : undefined
    },
  },
  {
    // until Oct 30 · through 10/30 · ending Saturday
    src: `(?:(?:up\\s+)?(?:until|till|til|through|thru)|ending(?:\\s+on)?|up\\s+to)\\s+(${DATE_WORDS})${END}`,
    back: true,
    build: (m, at, ctx) => {
      const date = dateOf(m[1]!, ctx)
      return date ? [{ k: "until", date, start: at, end: at + m[0].length }] : undefined
    },
  },
  {
    // for 3 weeks · for the next 4 weeks · for a month
    src: `for\\s+(?:the\\s+)?(?:next\\s+|following\\s+)?(${NUM}|an?|one)\\s+(days?|weeks?|months?)${END}`,
    back: true,
    build: (m, at) => {
      const n = /^an?$/.test(m[1]!) ? 1 : numOf(m[1]!)
      if (!(n >= 1)) return undefined
      return [{ k: "for", n, unit: m[2]!.replace(/s$/, "") as "day" | "week" | "month", start: at, end: at + m[0].length }]
    },
  },
  {
    // for the next week · for the next month
    src: "for\\s+the\\s+(?:next|following)\\s+(day|week|month)" + END,
    back: true,
    build: (m, at) => [{ k: "for", n: 1, unit: m[1] as "day" | "week" | "month", start: at, end: at + m[0].length }],
  },
  {
    // 5 times · for 10 runs
    src: `(?:for\\s+)?(${NUM})\\s+(?:times|runs)(?!\\s+(?:a|an|per|each|every)\\b)${END}`,
    back: false,
    build: (m, at) => {
      const n = numOf(m[1]!)
      return n >= 1 ? [{ k: "count", n, start: at, end: at + m[0].length }] : undefined
    },
  },
  {
    // at 9am · at 9 and 5 · @ 17:00 · at 9 in the morning
    src: `(?:at|@)\\s*${CLOCK_ANY}(?:${CLOCK_SEP}${CLOCK_ANY})*${CLOCK_TAIL}`,
    back: true,
    build: (m, at, _ctx, core) => clockMod(m[0], at, core),
  },
  {
    // 9am · 17:00 · 9am and 5pm (no "at")
    src: `${CLOCK_STRICT}(?:${CLOCK_SEP}${CLOCK_ANY})*${CLOCK_TAIL}`,
    back: true,
    build: (m, at, _ctx, core) => clockMod(m[0], at, core),
  },
  {
    // at :15 (an hourly rule's minute)
    src: "at\\s+:(\\d{2})(?![\\d])",
    back: false,
    build: (m, at) => {
      const mi = parseInt(m[1]!, 10)
      return mi <= 59 ? [{ k: "minute", minutes: [mi], start: at, end: at + m[0].length }] : undefined
    },
  },
  {
    // first thing · first thing in the morning
    src: "first\\s+thing(?:\\s+in\\s+the\\s+morning)?" + END,
    back: true,
    build: (m, at) => [{ k: "tod", key: "first thing", word: "first thing", start: at, end: at + m[0].length }],
  },
  {
    // EOD · end of day · close of business
    src: "(?:at\\s+)?(?:the\\s+)?(?:end\\s+of\\s+(?:the\\s+)?(?:work\\s?)?day|eod|close\\s+of\\s+business|cob)" + END,
    back: true,
    build: (m, at) => [{ k: "tod", key: "end of day", word: m[0].replace(/^at\s+/, "").replace(/\b(?:eod|cob)\b/, (w) => w.toUpperCase()), start: at, end: at + m[0].length }],
  },
  {
    // in the morning · mornings · night · at night
    src: "(?:in\\s+the\\s+|at\\s+)?(morning|afternoon|evening|night)s?" + END,
    back: false,
    build: (m, at) => [{ k: "tod", key: m[1]!, word: m[1]!, start: at, end: at + m[0].length }],
  },
  {
    // on weekdays · on weekends · on Mondays and Fridays
    src: `on\\s+(?:the\\s+)?(${WEEKDAY_CLASS}|${WEEKEND_CLASS}|${WD_LIST})${END}`,
    back: false,
    build: (m, at) => {
      const w = m[1]!
      const days = new RegExp(`^${WEEKEND_CLASS}$`).test(w) ? WEEKEND : new RegExp(`^${WEEKDAY_CLASS}$`).test(w) ? WEEKDAYS : daysIn(w)
      return days.length ? [{ k: "days", days, start: at, end: at + m[0].length }] : undefined
    },
  },
  {
    // on the first Monday · on the last weekday · on the first day (for monthly and quarterly cores)
    src: `on\\s+the\\s+(${ORD})\\s+(${WD_ONE}|weekday|week\\s?day|business\\s+day|work\\s?day|working\\s+day|day)${END}`,
    back: false,
    build: (m, at) => {
      const pos = monthPosition(m[1]!, m[2]!)
      return pos ? [{ k: "monthPos", ...pos, start: at, end: at + m[0].length }] : undefined
    },
  },
  {
    // on the 1st and 15th
    src: `on\\s+the\\s+(${DAY_LIST})${END}`,
    back: false,
    build: (m, at) => {
      return [{ k: "monthDays", days: ordinalDays(m[1]!), start: at, end: at + m[0].length }]
    },
  },
  {
    // on January 2 · on Jan 2nd · on the 2nd of January
    src: `on\\s+(?:the\\s+)?(?:(${MONTH})\\s*(${DAYN})|(${DAYN})\\s+(?:of\\s+)?(${MONTH}))${END}`,
    back: false,
    build: (m, at) => {
      const mo = monthIndex((m[1] ?? m[4])!)
      const d = parseInt((m[2] ?? m[3])!, 10)
      return [{ k: "date", mo, d, start: at, end: at + m[0].length }]
    },
  },
  {
    // PT · Pacific time · UTC (only right after a clock; see `extend`)
    src: "(?:pt|pst|pdt|et|est|edt|ct|cst|cdt|mt|mst|mdt|utc|gmt|cet|cest|bst|ist|jst|aest|aedt|pacific|eastern|central|mountain)(?:\\s+time)?" + END,
    back: false,
    build: (m, at) => [{ k: "zone", start: at, end: at + m[0].length }],
  },
]

function clockMod(text: string, at: number, core: Core): Mod[] | undefined {
  const tail = /\s+in\s+the\s+(morning|afternoon|evening)s?$|\s+at\s+night$/.exec(text)
  // "at 2 at night" is the night's 2am: the tail names the part (it read as "pm" once).
  const part = tail ? ((tail[1] as DayPart | undefined) ?? "night") : partOf(core.tod?.key)
  const body = tail ? text.slice(0, tail.index) : text
  const clocks = clocksIn(body.replace(/o['’]clock/g, (s) => " ".repeat(s.length)), at, part)
  return clocks ? [{ k: "clock", clocks, start: at, end: at + text.length }] : undefined
}

const MOD_RES = MODS.map((d) => ({
  def: d,
  sticky: new RegExp(d.src, "y"),
  // Not after a sign: "-03:00, nightly" is an offset, not a clock to run at (fix round 2).
  back: d.back ? new RegExp(`(?<![\\w:@+−-])(?:${d.src})[\\s,]*$`) : undefined,
}))

// ---- cores ----------------------------------------------------------------------------------------------------

interface CoreDef {
  re: RegExp
  oneShot?: boolean
  build: (m: RegExpExecArray, ctx: Ctx) => Omit<Core, "start" | "end"> | undefined
}

function monthPosition(ord: string, unit: string): Pick<Core, "byDay" | "bySetPos" | "byMonthDay"> | undefined {
  const n = ORD_VALUE[ord]
  if (n === undefined) return undefined
  if (unit === "day") return { byMonthDay: [n] }
  if (/^(?:week\s?day|business\s+day|work\s?day|working\s+day)$/.test(unit)) return { byDay: WEEKDAYS.map((day) => ({ day })), bySetPos: n }
  return { byDay: [{ day: dayIndex(unit), nth: n }] }
}

const G = (s: string) => new RegExp(s, "g")

const CORES: CoreDef[] = [
  // Mon-Fri · every Monday through Thursday · from Monday to Friday
  {
    re: G(`\\b(?:(every|each|on)\\s+)?(?:from\\s+)?(${WD})\\s*(?:-|–|—|to|through|thru)\\s*(${WD})`),
    build: (m) => {
      const a = dayIndex(m[2]!), b = dayIndex(m[3]!)
      const days: number[] = []
      for (let i = a; ; i = (i + 1) % 7) {
        days.push(i)
        if (i === b || days.length >= 7) break
      }
      return { type: "rule", freq: "WEEKLY", byDay: days.map((day) => ({ day })), gated: !m[1] }
    },
  },
  // every other Friday · every other Monday and Thursday
  {
    re: G(`\\b(?:every|each)\\s+other\\s+(${WD_LIST})`),
    build: (m) => ({ type: "rule", freq: "WEEKLY", interval: 2, byDay: daysIn(m[1]!).map((day) => ({ day })) }),
  },
  // every 2 Fridays — which Fridays? The model reads it.
  { re: G(`\\b(?:every|each)\\s+${NUM}\\s+${WD_PLURAL}`), build: () => ({ type: "vague" }) },
  // every Monday · each Mon, Wed and Fri · on Mondays · weekly on Fridays · every Monday and every Thursday
  {
    re: G(`\\b(?:(every|each)\\s+(?:single\\s+)?|(weekly)\\s+on\\s+(?:the\\s+)?|on\\s+(?:the\\s+)?)(${WD_LIST})`),
    build: (m) => {
      const list = m[3]!
      if (!m[1] && !m[2] && !new RegExp(WD_PLURAL).test(list)) return undefined // "on Friday" is a one-off
      return { type: "rule", freq: "WEEKLY", byDay: daysIn(list).map((day) => ({ day })) }
    },
  },
  // Mondays 9am · Tuesdays at 11am · Thursdays, … — a bare plural only beside a clock or a clause edge
  {
    re: G(`\\b(${WD_PLURAL}(?:${LIST_SEP}${WD})*)`),
    build: (m) => ({ type: "rule", freq: "WEEKLY", byDay: daysIn(m[1]!).map((day) => ({ day })), gated: true }),
  },
  // Monday mornings · Friday afternoons
  {
    re: G(`\\b(${WD_ONE})\\s+(morning|afternoon|evening|night)s${END}`),
    build: (m) => ({ type: "rule", freq: "WEEKLY", byDay: [{ day: dayIndex(m[1]!) }], tod: { key: m[2]!, word: m[2]! } }),
  },
  // every weekday · on weekends · every business day · each workday
  {
    re: G(`\\b(?:every|each|on)\\s+(?:single\\s+)?(?:the\\s+)?(${WEEKDAY_CLASS}|${WEEKEND_CLASS})${END}`),
    build: (m) => ({ type: "rule", freq: "WEEKLY", byDay: (new RegExp(`^${WEEKEND_CLASS}$`).test(m[1]!) ? WEEKEND : WEEKDAYS).map((day) => ({ day })) }),
  },
  // weekdays · business days · weekends (bare plurals, gated)
  {
    re: G(`\\b(week\\s?days|work\\s?days|business\\s+days|working\\s+days|weekends|weekend\\s+days)${END}`),
    build: (m) => ({ type: "rule", freq: "WEEKLY", byDay: (/^weekend/.test(m[1]!) ? WEEKEND : WEEKDAYS).map((day) => ({ day })), gated: true }),
  },
  // weekday mornings · weekend evenings
  {
    re: G(`\\b(weekday|week\\s+day|workday|weekend)\\s+(morning|afternoon|evening|night)s${END}`),
    build: (m) => ({ type: "rule", freq: "WEEKLY", byDay: (/^weekend/.test(m[1]!) ? WEEKEND : WEEKDAYS).map((day) => ({ day })), tod: { key: m[2]!, word: m[2]! } }),
  },
  // every day · each morning · every night · daily · nightly · everyday · once a day
  {
    re: G(`\\b(?:(?:every|each)\\s+(?:single\\s+)?(day|morning|afternoon|evening|night)${END}|(everyday|daily|nightly)(?![\\w'’]|-\\w)|once\\s+(?:a|per|every)\\s+day${END})`),
    build: (m) => {
      const tod = m[1] && m[1] !== "day" ? { key: m[1], word: m[1] } : m[2] === "nightly" ? { key: "night", word: "nightly" } : undefined
      return { type: "rule", freq: "DAILY", ...(tod ? { tod } : {}), gated: !!m[2] }
    },
  },
  // every 2 hours · every 15 minutes · every 3 days · every other week · every half hour · every few hours
  {
    // Fix round 3: "every quarter hour" / "every quarter-hour" is every 15 minutes (it read as "every quarter" and
    // got the quarterly copy), and "every half-hour" takes its hyphen.
    re: G(`\\b(?:every|each)\\s+(other|second|third|fourth|half(?:\\s+an?)?|quarter(?:\\s+of\\s+an?)?|couple\\s+(?:of\\s+)?|few|several|${NUM})[\\s-]*(minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)${END}`),
    build: (m) => {
      const q = m[1]!.trim(), unit = m[2]!.replace(/s$/, "")
      if (/^(?:couple|few|several)/.test(q)) return { type: "vague" }
      if (/^half/.test(q)) return unit === "hour" ? minuteCore(30) : { type: "unsupported" }
      if (/^quarter/.test(q)) return unit === "hour" ? minuteCore(15) : { type: "unsupported" }
      const n = q === "other" || q === "second" ? 2 : q === "third" ? 3 : q === "fourth" ? 4 : numOf(q)
      if (!(n >= 1)) return undefined
      return intervalCore(n, unit)
    },
  },
  // every hour · every week · every month · every year · every fortnight · every quarter
  {
    re: G(`\\b(?:every|each)\\s+(hour|week|month|year|fortnight|quarter)${END}`),
    build: (m) => (m[1] === "fortnight" ? intervalCore(2, "week") : m[1] === "quarter" ? { type: "ambiguous", word: "quarterly", quarter: true } : intervalCore(1, m[1]!)),
  },
  // hourly · weekly · monthly · yearly · fortnightly — and the two-meaning ones
  {
    re: G("\\b(hourly|weekly|monthly|yearly|annually|fortnightly|bi-?weekly|bi-?monthly|quarterly)(?![\\w'’]|-\\w)"),
    build: (m) => {
      const w = m[1]!.replace("-", "")
      if (w === "biweekly") return { type: "ambiguous", word: "biweekly", gated: true, clauseStartOk: true }
      if (w === "bimonthly") return { type: "ambiguous", word: "bimonthly", gated: true, clauseStartOk: true }
      if (w === "quarterly") return { type: "ambiguous", word: "quarterly", quarter: true, gated: true, clauseStartOk: true }
      const core = w === "fortnightly" ? intervalCore(2, "week") : intervalCore(1, { hourly: "hour", weekly: "week", monthly: "month", yearly: "year", annually: "year" }[w]!)
      return { ...core, gated: true }
    },
  },
  // once a week · once a month · once a year · once a quarter
  {
    re: G(`\\bonce\\s+(?:a|per|every)\\s+(hour|week|month|year|fortnight|quarter)${END}`),
    build: (m) => (m[1] === "fortnight" ? intervalCore(2, "week") : m[1] === "quarter" ? { type: "ambiguous", word: "quarterly", quarter: true } : intervalCore(1, m[1]!)),
  },
  // weeknights · every weeknight
  { re: G(`\\b(?:(?:every|each|on)\\s+)?weeknights?${END}`), build: () => ({ type: "ambiguous", word: "weeknights" }) },
  // on the 1st and 15th · monthly on the 5th · every month on the 1st · on the 15th of every month
  {
    re: G(`\\b(?:(?:monthly|(?:every|each)\\s+month)\\s+)?on\\s+the\\s+(${DAY_LIST})(?:\\s+(?:day\\s+)?${OF_MONTH})?${END}`),
    build: (m) => monthDayCore(m[1]!),
  },
  // the 1st of every month · the first of the month · every 15th
  {
    re: G(`\\b(?:(?:every|each)\\s+)?the\\s+(${DAY_LIST}|first)\\s+(?:day\\s+)?${OF_MONTH}${END}|\\b(?:every|each)\\s+(${DAY_ORD})(?:\\s+(?:day\\s+)?${OF_MONTH})?${END}`),
    build: (m) => monthDayCore(m[1] === "first" ? "1st" : (m[1] ?? m[2])!),
  },
  // at the end of every month
  { re: G(`\\b(?:at\\s+)?(?:the\\s+)?end\\s+${OF_MONTH}${END}`), build: () => ({ type: "rule", freq: "MONTHLY", byMonthDay: [-1] }) },
  // the first Monday of every month · every 2nd and 4th Wednesday · last weekday of the month · first day
  // of every quarter · every last workday
  {
    re: G(`\\b(?:on\\s+)?(?:(every|each)\\s+)?(?:the\\s+)?(${ORD_LIST})\\s+(${WD_ONE}|weekday|week\\s?day|business\\s+day|work\\s?day|working\\s+day|day)(?:\\s+of\\s+(?:every|each|the|a)\\s+(month|quarter))?${END}`),
    build: (m) => {
      const ords = [...m[2]!.matchAll(new RegExp(ORD, "g"))].map((x) => ORD_VALUE[x[0]]!)
      const unit = m[3]!, scope = m[4], every = !!m[1]
      if (!scope) {
        if (!every) return undefined // "the first Monday": of which month?
        // "every 2nd Tuesday" is every other Tuesday to some and the month's 2nd to others; "every first
        // Monday" and "every last Friday" can only be the month's.
        if (ords.length === 1 && ords[0] !== 1 && ords[0] !== -1) return { type: "vague" }
      }
      const isDayClass = /^(?:week\s?day|business\s+day|work\s?day|working\s+day)$/.test(unit)
      let pos: Pick<Core, "byDay" | "bySetPos" | "byMonthDay">
      if (unit === "day") pos = { byMonthDay: ords }
      else if (isDayClass) {
        if (ords.length !== 1) return { type: "unsupported" }
        pos = { byDay: WEEKDAYS.map((day) => ({ day })), bySetPos: ords[0]! }
      } else pos = { byDay: ords.map((nth) => ({ day: dayIndex(unit), nth })) }
      if (scope === "quarter") return quarterCore(pos)
      if (pos.byMonthDay?.some((d) => d > 28)) return { type: "unsupported" }
      return { type: "rule", freq: "MONTHLY", ...pos }
    },
  },
  // every year on January 2 · annually on Mar 1 · every March 15th · on Jan 2 every year
  {
    re: G(`\\b(?:(?:(?:every|each)\\s+year|annually|yearly)\\s+on\\s+(?:the\\s+)?|(?:every|each)\\s+)(?:(${MONTH})\\s*(${DAYN})|(${DAYN})\\s+(?:of\\s+)?(${MONTH}))${END}|\\b(?:on\\s+)?(?:the\\s+)?(?:(${MONTH})\\s*(${DAYN})|(${DAYN})\\s+(?:of\\s+)?(${MONTH}))\\s+(?:every|each)\\s+year${END}`),
    build: (m) => {
      const mo = monthIndex((m[1] ?? m[4] ?? m[5] ?? m[8])!)
      const d = parseInt((m[2] ?? m[3] ?? m[6] ?? m[7])!, 10)
      return yearlyCore(mo, d)
    },
  },
  // twice a week · three times a day · a few times a month · regularly · every payday · each sprint · every
  // 2nd week (every other week to some; "every 2nd" alone read as the 2nd of the month, the week dropped) ·
  // twice daily · 3x weekly · semi-weekly · half-hourly (fix round 2: the adverb after the count read alone,
  // "check the queue twice daily" offered once a day with "twice" saved as the task's last word)
  {
    re: G(`\\b(?:twice|thrice|(?:${NUM}|a\\s+few|a\\s+couple(?:\\s+of)?|several|multiple)\\s+times|\\d+\\s?x)[\\s-]+(?:hourly|daily|nightly|weekly|fortnightly|monthly|quarterly|yearly|annually)${END}|\\b(?:semi|half|tri|twice|thrice)-?(?:hourly|daily|nightly|weekly|monthly|quarterly|yearly|annually)${END}|\\bbi-?(?:hourly|daily|nightly|yearly|annually|annual)${END}|\\b(?:every|each)\\s+(?:\\d{1,2}(?:st|nd|rd|th)|${SPELLED_ORD})\\s+(?:minute|min|hour|hr|day|night|morning|afternoon|evening|week|weekend|fortnight|month|quarter|year)s?${END}|\\b(?:twice|thrice|(?:${NUM}|a\\s+few|a\\s+couple(?:\\s+of)?|several|multiple|many)\\s+times)\\s+(?:a|an|per|each|every)\\s+(?:day|week|month|hour|year|quarter)${END}|\\b(?:regularly|periodically|every\\s+so\\s+often|from\\s+time\\s+to\\s+time|occasionally|every\\s+now\\s+and\\s+then)${END}|\\b(?:at\\s+the\\s+(?:start|beginning|end)\\s+of\\s+)?(?:every|each)\\s+(?:payday|pay\\s+day|sprint|iteration|cycle)${END}`),
    build: () => ({ type: "vague" }),
  },
  // ---- one-offs: read only in the mode and in "Change when" ----
  // tomorrow · tonight · today at 5pm · tomorrow morning · this afternoon
  {
    re: G(`\\b(?:(tomorrow|tonight|today)(?:\\s+(morning|afternoon|evening|night))?|this\\s+(morning|afternoon|evening))${END}`),
    oneShot: true,
    build: (m, ctx) => {
      const day = m[1] === "tomorrow" ? addDays(ctx.today, 1) : ctx.today
      const key = m[2] ?? m[3] ?? (m[1] === "tonight" ? "night" : undefined)
      return { type: "once", once: { date: day, needsClock: m[1] === "today" || !!m[3] }, ...(key ? { tod: { key, word: m[1] === "tonight" && !m[2] ? "tonight" : key } } : {}) }
    },
  },
  // next Monday · Friday at 3pm · on Friday at 3pm · this Friday morning
  {
    re: G(`\\b(?:(next|this|on|coming)\\s+)?(${WD_ONE})`),
    oneShot: true,
    build: (m, ctx) => {
      const next = m[1] === "next"
      return { type: "once", once: { date: comingWeekday(ctx, dayIndex(m[2]!), !next), needsClock: !next, next } }
    },
  },
  // in 2 hours · in 30 minutes · in an hour · in 3 days ("in 2 hours of debugging" is not one)
  {
    re: G(`\\bin\\s+(${NUM}|an?|half\\s+an?)\\s+(minutes?|mins?|hours?|hrs?|days?)${END}(?!\\s+of\\b)`),
    oneShot: true,
    build: (m, ctx) => {
      const n = /^half/.test(m[1]!) ? 0.5 : /^an?$/.test(m[1]!) ? 1 : numOf(m[1]!)
      if (!(n > 0)) return undefined
      const unit = m[2]!.startsWith("min") ? 60_000 : m[2]!.startsWith("h") ? 3_600_000 : DAY_MS
      const target = Math.floor((ctx.nowMs + n * unit) / 60_000) * 60_000
      const w = zonedWall(target, ctx.tz)
      // A run is stored as a local wall clock. On the night clocks fall back, "in 2 hours" can land on the
      // second 1:30, which the wall clock names as the first one — an hour early. The model reads that.
      if (wallToInstant(w, ctx.tz) !== target) return { type: "unsupported" }
      return { type: "once", once: { date: { y: w.y, mo: w.mo, d: w.d }, clock: { h: w.h, mi: w.mi } } }
    },
  },
  // on Oct 20 · Oct 20 at 3pm · on the 20th of October
  {
    re: G(`\\bon\\s+(?:(${MONTH})\\s*(${DAYN})|(?:the\\s+)?(${DAYN})\\s+(?:of\\s+)?(${MONTH}))(?:,?\\s*(\\d{4}))?${END}|\\b(${MONTH})\\s*(${DAYN})(?:,?\\s*(\\d{4}))?(?=\\s+at\\b)`),
    oneShot: true,
    build: (m, ctx) => {
      const mo = monthIndex((m[1] ?? m[4] ?? m[6])!)
      const d = parseInt((m[2] ?? m[3] ?? m[7])!, 10)
      const yRaw = m[5] ?? m[8]
      const date = yRaw ? { y: parseInt(yRaw, 10), mo, d } : nextDate(ctx, mo, d)
      if (!date || date.d > daysInMonth(date.y, date.mo)) return undefined
      return { type: "once", once: { date } }
    },
  },
]

function minuteCore(step: number): Omit<Core, "start" | "end"> {
  const minutes: number[] = []
  for (let mi = 0; mi < 60; mi += step) minutes.push(mi)
  return { type: "rule", freq: "HOURLY", minutes, ...(step < 15 ? { spacing: true } : {}) }
}

function intervalCore(n: number, unit: string): Omit<Core, "start" | "end"> {
  if (/^(?:minute|min)$/.test(unit)) {
    if (n % 60 === 0) return { type: "rule", freq: "HOURLY", interval: n / 60 }
    if (n < 15) return minuteCore(n)
    // 15, 20 and 30 fill an hour evenly; 45 and 90 are not one HOURLY rule.
    return 60 % n === 0 ? minuteCore(n) : { type: "unsupported" }
  }
  if (unit === "hour" || unit === "hr") return { type: "rule", freq: "HOURLY", interval: n }
  if (unit === "day") return { type: "rule", freq: "DAILY", interval: n }
  if (unit === "week") return { type: "rule", freq: "WEEKLY", interval: n, byDay: [{ day: 0 }], dayAssumed: "Monday" }
  if (unit === "month") return { type: "rule", freq: "MONTHLY", interval: n, byMonthDay: [1], dayAssumed: "the 1st" }
  if (unit === "year") return { type: "rule", freq: "YEARLY", interval: n, needsDate: true }
  return { type: "unsupported" }
}

function monthDayCore(list: string): Omit<Core, "start" | "end"> {
  const days = sortedUnique(ordinalDays(list))
  if (days.some((d) => d < 1 || d > 31)) return { type: "unsupported" }
  // Days 29–31 skip short months; the model writes those from the month's end instead.
  if (days.some((d) => d > 28)) return { type: "unsupported" }
  return { type: "rule", freq: "MONTHLY", byMonthDay: days }
}

function yearlyCore(mo: number, d: number): Omit<Core, "start" | "end"> {
  if (mo < 1 || d < 1 || d > daysInMonth(2027, mo)) return { type: "unsupported" } // Feb 29 included: a leap-day rule
  return { type: "rule", freq: "YEARLY", byMonth: [mo], byMonthDay: [d] }
}

/** Calendar quarters (§3.2 J). An ordinal under YEARLY narrowed by BYMONTH counts within the month, so the
 *  day forms are YEARLY;BYMONTH=…, as the model writes them. BYSETPOS under YEARLY would pick ONE position
 *  in the whole year, so "the first weekday of every quarter" is MONTHLY;BYMONTH=1,4,7,10;BYSETPOS=1. */
function quarterCore(pos: Pick<Core, "byDay" | "bySetPos" | "byMonthDay">): Omit<Core, "start" | "end"> {
  // BYSETPOS picks within the set, so its position is the only one; otherwise every ordinal counts.
  const positions = pos.bySetPos !== undefined ? [pos.bySetPos] : [...(pos.byDay ?? []).map((d) => d.nth), ...(pos.byMonthDay ?? [])]
  const fromStart = positions.every((p) => p !== undefined && p > 0)
  const fromEnd = positions.every((p) => p !== undefined && p < 0)
  if (!fromStart && !fromEnd) return { type: "unsupported" }
  if ((pos.byMonthDay?.length ?? 0) > 1) return { type: "unsupported" }
  const byMonth = fromStart ? [1, 4, 7, 10] : [3, 6, 9, 12]
  return { type: "rule", freq: pos.bySetPos !== undefined ? "MONTHLY" : "YEARLY", byMonth, ...pos }
}

// ---- finding phrases ------------------------------------------------------------------------------------------

interface Candidate {
  start: number
  end: number
  core: Core
  mods: Mod[]
  /** Gated, and the only thing that made it live is the end of the text (no mod, no punctuation). */
  endOnly: boolean
  built: Built
}

type Built =
  | { type: "exact"; rrule: string; dtstart: string; once: boolean; assumed: Assumed[]; spacing?: true }
  | { type: "cue"; why: CueWhy; unread?: Span }
  | { type: "ambiguous"; word: keyof typeof SCHEDULE_AMBIGUOUS_COPY }
  /** A rule whose words all fit, not yet checked against the engine. Only the phrase a reading is about
   *  gets checked: `checkSchedule` is most of a read's cost, and a prompt holds many candidates. */
  | { type: "pending"; check: () => Built }

/** The candidate's reading, with the engine's check run once, when it is first needed. */
function builtOf(c: Candidate): Exclude<Built, { type: "pending" }> {
  while (c.built.type === "pending") c.built = c.built.check()
  return c.built
}

/** Every phrase in `region`, extended by its modifiers, assembled, and de-overlapped: earliest first, the
 *  longest at a start. Gated cores that nothing made live are dropped. */
function findCandidates(p: Prep, region: Span, ctx: Ctx): Candidate[] {
  const m = p.masked
  const sub = m.slice(region.start, region.end)
  const raw: Candidate[] = []
  for (const def of CORES) {
    if (def.oneShot && !ctx.oneShots) continue
    def.re.lastIndex = 0
    for (let match; (match = def.re.exec(sub)); ) {
      if (match[0].length === 0) {
        def.re.lastIndex++
        continue
      }
      const built = def.build(match, ctx)
      if (!built) continue
      const core: Core = { ...built, start: region.start + match.index, end: region.start + match.index + match[0].trimEnd().length }
      const ext = extend(p, region, core, ctx)
      const assembled = assemble(core, ext.mods, ctx)
      if (!assembled) continue
      let endOnly = false
      if (core.gated && !ext.mods.some((x) => x.k !== "zone")) {
        // An adjective ("the daily build") or an object ("skip weekends"), not when anything runs.
        if (OBJECT_BEFORE.test(m.slice(Math.max(region.start, ext.start - 16), ext.start))) continue
        const after = m.slice(ext.end)
        const boundary = /^\s*(?:[,;:.!?)\n—–]|-\s)/.test(after)
        const atEnd = /^[\s.!)\u0001]*$/.test(after)
        const clauseStart = core.clauseStartOk && /(?:^|[,;:.!?(\n—–])\s*$/.test(m.slice(region.start, ext.start))
        if (!boundary && !atEnd && !clauseStart) continue
        endOnly = !boundary && !clauseStart
      }
      raw.push({ start: ext.start, end: ext.end, core, mods: ext.mods, endOnly, built: assembled })
    }
  }
  raw.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start))
  const chosen: Candidate[] = []
  for (const c of raw) if (!chosen.some((k) => c.start < k.end && c.end > k.start)) chosen.push(c)
  return chosen
}

/** Grow a core with the modifiers that touch it, forward and back, until nothing more attaches. */
function extend(p: Prep, region: Span, core: Core, ctx: Ctx): { start: number; end: number; mods: Mod[] } {
  const m = p.masked
  // Forward matches cannot run past the region: "5 p.m." at a window's trimmed end reads as "5 p.m".
  const bounded = m.slice(0, region.end)
  let start = core.start, end = core.end
  const mods: Mod[] = []
  const has = (k: Mod["k"]) => mods.some((x) => x.k === k)
  for (let rounds = 0; rounds < 12; rounds++) {
    let grew = false
    const gap = /^[ \t]*(?:,[ \t]*)?/.exec(m.slice(end, end + 8))![0].length
    const pos = end + gap
    for (const { def, sticky } of MOD_RES) {
      sticky.lastIndex = pos
      const mm = sticky.exec(bounded)
      if (!mm || mm[0].length === 0) continue
      const built = def.build(mm, pos, ctx, core)
      if (!built || built.some((x) => has(x.k))) continue
      // A zone belongs to the clock it follows ("9 PT"), not to any word that happens to spell one.
      if (built[0]!.k === "zone" && mods[mods.length - 1]?.k !== "clock") continue
      mods.push(...built)
      end = pos + mm[0].length
      grew = true
      break
    }
    if (grew) continue
    const from = Math.max(region.start, start - 100)
    const before = m.slice(from, start)
    for (const { def, back } of MOD_RES) {
      if (!back) continue
      const mm = back.exec(before)
      if (!mm || mm[0].trim().length === 0) continue
      const at = from + mm.index
      const body = mm[0].replace(/[\s,]*$/, "")
      const built = def.build(mm, at, ctx, core)
      if (!built || built.some((x) => has(x.k))) continue
      for (const x of built) {
        x.start = at
        x.end = at + body.length
      }
      mods.push(...built)
      start = at
      grew = true
      break
    }
    if (!grew) break
  }
  return { start, end, mods }
}

// ---- assembling a reading --------------------------------------------------------------------------------------

interface RuleSpec {
  freq: Freq
  interval: number
  byMonth?: number[]
  byMonthDay?: number[]
  byDay?: DaySpec[]
  bySetPos?: number
  byHour?: number[]
  byMinute: number[]
  count?: number
  forSpan?: { n: number; unit: "day" | "week" | "month" }
  until?: YMD
  start?: YMD
  /** An hourly rule's first run ("every 12 hours starting at 9pm"). */
  anchor?: Clock
  once?: { date: YMD; h: number; mi: number }
}

function assemble(core: Core, mods: Mod[], ctx: Ctx): Built | undefined {
  const mod = <K extends Mod["k"]>(k: K) => mods.find((x): x is Extract<Mod, { k: K }> => x.k === k)
  const coreSpan = { start: core.start, end: core.end }
  if (core.type === "ambiguous") {
    const pos = mod("monthPos")
    if (core.quarter && pos) return assembleRule({ ...core, ...quarterCore(pos), start: core.start, end: core.end }, mods.filter((x) => x !== pos), ctx)
    return { type: "ambiguous", word: core.word! }
  }
  if (core.type === "vague") return { type: "cue", why: "vague", unread: coreSpan }
  if (core.type === "unsupported") return { type: "cue", why: "unsupported", unread: coreSpan }
  const zone = mod("zone")
  if (zone) return { type: "cue", why: "zone", unread: { start: zone.start, end: zone.end } }
  return assembleRule(core, mods, ctx)
}

function assembleRule(core: Core, mods: Mod[], ctx: Ctx): Built | undefined {
  const mod = <K extends Mod["k"]>(k: K) => mods.find((x): x is Extract<Mod, { k: K }> => x.k === k)
  const unsupported = (span?: { start: number; end: number }): Built => ({ type: "cue", why: "unsupported", unread: span ? { start: span.start, end: span.end } : { start: core.start, end: core.end } })
  const assumed: Assumed[] = []
  const tod = core.tod ?? (mod("tod") ? { key: mod("tod")!.key, word: mod("tod")!.word } : undefined)
  if (core.tod && mod("tod")) return unsupported(mod("tod"))
  const part = partOf(tod?.key)
  const clockMod = mod("clock")
  // A clock read before its time of day was found ("every day in the evening at 6") is settled by it now.
  const settled = clockMod?.clocks.map((c) => (c.guess && part ? settleClock(c.guess.bare, c.mi, part, c.guess.span) : c))
  // A guess that lands on an hour the list STATES is the other one (fix round 2): in "at 6 and 18" the 18 says
  // which 6 was meant, and the work-hours guess (6pm) merged into it — one run a day, the 6am run gone.
  const clocks = settled?.map((c) => (c.guess && settled.some((o) => o !== c && !o.guess && o.h === c.h && o.mi === c.mi) ? { h: c.guess.other, mi: c.mi } : c))
  // Fix round 3: clocks that still land on one run ("at 7 and 7", "at 6, 12 and 6") were collapsed into it — two
  // runs said, one read. A second 7 is the evening's to some and a slip to others: the model reads it, and no
  // core is kept (the faithful reading has more runs than one).
  if (clocks && new Set(clocks.map((c) => `${c.h}:${c.mi}`)).size < clocks.length) return { type: "cue", why: "vague", unread: { start: clockMod!.start, end: clockMod!.end } }
  /** A night or an evening that runs past midnight: "at 2" on it is the NEXT calendar day's 2am. */
  const pastMidnight = (part === "night" || part === "evening") && !!clocks?.some((c) => c.h < 6)

  // One-offs.
  if (core.type === "once") {
    const o = core.once!
    if (mods.some((x) => !["clock", "tod"].includes(x.k))) return unsupported()
    // Fix round 3: "next Tuesday" said early in the week reads as the coming one, MARKED, with the other named.
    if (o.next && nextIsAmbiguous(ctx, o.date)) {
      const other = addDays(o.date, 7)
      assumed.push({ part: "day", shown: dayWords(o.date), tip: `“Next ${DAY_NAMES[weekdayOfYmd(o.date)]}” reads as ${dayWords(o.date)}. Type “${SHORT_MONTHS[other.mo - 1]} ${other.d}” if you meant the one after.`, shift: 7 })
    }
    let h: number, mi: number
    if (o.clock) {
      if (clocks || tod) return unsupported(clockMod ?? mod("tod"))
      ;({ h, mi } = o.clock)
    } else if (clocks) {
      if (clocks.length !== 1) return unsupported(clockMod)
      ;({ h, mi } = clocks[0]!)
      pushGuesses(assumed, clocks)
      // "tonight at 2" is the coming night's 2am — tomorrow's date. Said AFTER midnight (fix round 3: at 00:30 it
      // read as 25½ hours away), "tonight" is the night still going on, whose 2am is today's: that is read, and
      // marked, while it is still ahead.
      if (pastMidnight) {
        const now = zonedWall(ctx.nowMs, ctx.tz)
        if (now.h < 5 && compareYmd(o.date, ctx.today) === 0 && (h > now.h || (h === now.h && mi > now.mi))) {
          assumed.push({ part: "day", shown: dayWords(o.date), tip: `“Tonight” said after midnight reads as the night now under way: ${dayWords(o.date)}. Say “tomorrow night” for the next one.`, shift: 1 })
          return { type: "pending", check: () => finalize({ freq: "DAILY", interval: 1, byMinute: [mi], once: { date: o.date, h, mi } }, assumed, ctx, core) }
        }
        return { type: "pending", check: () => finalize({ freq: "DAILY", interval: 1, byMinute: [mi], once: { date: addDays(o.date, 1), h, mi } }, assumed, ctx, core) }
      }
    } else if (tod) {
      h = TOD_HOURS[tod.key]!
      mi = 0
      assumed.push({ part: "time", shown: formatClockShort(h, 0), word: tod.word })
    } else {
      if (o.needsClock) return undefined
      h = 9
      mi = 0
      assumed.push({ part: "time", shown: "9am" })
    }
    return { type: "pending", check: () => finalize({ freq: "DAILY", interval: 1, byMinute: [mi], once: { date: o.date, h, mi } }, assumed, ctx, core) }
  }

  const r: RuleSpec = { freq: core.freq!, interval: core.interval ?? 1, byMinute: [] }
  if (core.byMonth) r.byMonth = core.byMonth
  if (core.byMonthDay) r.byMonthDay = core.byMonthDay
  if (core.byDay) r.byDay = core.byDay
  if (core.bySetPos !== undefined) r.bySetPos = core.bySetPos
  let dayAssumed = core.dayAssumed

  // Days named after the core: "every 2 hours on weekdays", "weekly on Fridays", "monthly on the 1st".
  const days = mod("days"), monthDays = mod("monthDays"), monthPos = mod("monthPos"), date = mod("date")
  if (days) {
    if (r.freq === "HOURLY" && !r.byDay) r.byDay = days.days.map((day) => ({ day }))
    else if (r.freq === "WEEKLY" && dayAssumed) {
      r.byDay = days.days.map((day) => ({ day }))
      dayAssumed = undefined
    } else if (r.freq === "DAILY" && r.interval === 1 && !r.byDay) {
      r.freq = "WEEKLY"
      r.byDay = days.days.map((day) => ({ day }))
    } else return unsupported(days)
  }
  if (monthDays || monthPos) {
    const m = (monthDays ?? monthPos)!
    if (r.freq !== "MONTHLY" || !dayAssumed) return unsupported(m)
    delete r.byMonthDay
    if (monthDays) {
      const built = monthDayCore(monthDays.days.map((d) => `${d}th`).join(" and "))
      if (built.type !== "rule") return unsupported(monthDays)
      r.byMonthDay = built.byMonthDay
    } else {
      if (monthPos!.byMonthDay?.some((d) => d > 28)) return unsupported(monthPos)
      Object.assign(r, { ...(monthPos!.byDay ? { byDay: monthPos!.byDay } : {}), ...(monthPos!.bySetPos !== undefined ? { bySetPos: monthPos!.bySetPos } : {}), ...(monthPos!.byMonthDay ? { byMonthDay: monthPos!.byMonthDay } : {}) })
    }
    dayAssumed = undefined
  }
  if (date) {
    if (r.freq !== "YEARLY" || !core.needsDate) return unsupported(date)
    const y = yearlyCore(date.mo, date.d)
    if (y.type !== "rule") return unsupported(date)
    r.byMonth = y.byMonth
    r.byMonthDay = y.byMonthDay
  } else if (core.needsDate) return { type: "cue", why: "vague", unread: { start: core.start, end: core.end } }
  if (dayAssumed) assumed.push({ part: "day", shown: dayAssumed })

  // Times.
  const window = mod("window"), minute = mod("minute"), startClock = mod("startClock")
  if (r.freq === "HOURLY") {
    if (clockMod || tod) return unsupported(clockMod ?? mod("tod"))
    r.byMinute = core.minutes ?? (minute ? minute.minutes : [startClock ? startClock.clock.mi : 0])
    if (core.minutes && (minute || startClock || window)) return unsupported(minute ?? startClock ?? window)
    if (window) {
      if (window.from.mi !== window.to.mi || window.to.h <= window.from.h || 24 % r.interval !== 0) return unsupported(window)
      r.byHour = []
      for (let h = window.from.h; h <= window.to.h; h += r.interval) r.byHour.push(h)
      r.byMinute = [window.from.mi]
      if (window.guessed) {
        for (const c of [window.from, window.to]) assumed.push({ part: "time", shown: formatClockShort(c.h, c.mi) })
      }
    }
    if (startClock) {
      if (window) return unsupported(startClock)
      r.anchor = startClock.clock
      pushGuesses(assumed, [startClock.clock])
    }
  } else {
    if (window || minute || startClock) return unsupported(window ?? minute ?? startClock)
    // "Monday night at 2" is Tuesday at 2am to most and Monday at 2am to some: a rule that names its days
    // does not guess which. (A daily rule has no day to get wrong.)
    if (pastMidnight && r.freq !== "DAILY") return { type: "cue", why: "vague", unread: { start: clockMod!.start, end: clockMod!.end } }
    if (clocks) {
      const hours = sortedUnique(clocks.map((c) => c.h)), minutes = sortedUnique(clocks.map((c) => c.mi))
      // Two clocks must cross-multiply: 9am and 5pm is BYHOUR=9,17; 9:30am and 5pm is two rules.
      if (hours.length * minutes.length !== new Set(clocks.map((c) => `${c.h}:${c.mi}`)).size) return unsupported(clockMod)
      r.byHour = hours
      r.byMinute = minutes
      pushGuesses(assumed, clocks)
      // "every Friday at midnight" runs at the START of Friday — Thursday night — and to many it is the end of
      // Friday (fix round 3, read unmarked). The engine's reading stands, marked, and the tip says which day
      // it is and how to say the other. A daily rule has no day to get wrong.
      if (clocks.some((c) => c.midnight) && r.freq === "WEEKLY" && r.byDay?.length && !dayAssumed) {
        const one = r.byDay.length === 1 ? r.byDay[0]!.day : undefined
        const tip = one === undefined
          ? "Midnight reads as the start of each day. Name the next day if you meant the end of it."
          : `“${DAY_NAMES[one]} at midnight” reads as the start of ${DAY_NAMES[one]}. Say “${DAY_NAMES[(one + 1) % 7]} at midnight” if you meant the end of it.`
        assumed.push({ part: "day", shown: one === undefined ? "the start of each day" : `the start of ${DAY_NAMES[one]}`, tip, shift: 1 })
      }
    } else if (tod) {
      r.byHour = [TOD_HOURS[tod.key]!]
      r.byMinute = [0]
      assumed.push({ part: "time", shown: formatClockShort(TOD_HOURS[tod.key]!, 0), word: tod.word })
    } else {
      r.byHour = [9]
      r.byMinute = [0]
      assumed.push({ part: "time", shown: "9am" })
    }
  }

  // Bounds and starts.
  const count = mod("count"), forSpan = mod("for"), until = mod("until"), start = mod("start")
  if ([count, forSpan, until].filter(Boolean).length > 1) return unsupported(count ?? forSpan ?? until)
  if (count) r.count = count.n
  if (forSpan) r.forSpan = { n: forSpan.n, unit: forSpan.unit }
  if (until) r.until = until.date
  if (start) r.start = start.date
  if (core.spacing) r.byMinute = core.minutes!
  return { type: "pending", check: () => finalize(r, assumed, ctx, core) }
}

function pushGuesses(assumed: Assumed[], clocks: Clock[]): void {
  for (const c of clocks) {
    if (!c.guess) continue
    assumed.push({ part: "meridiem", shown: formatClockShort(c.h, c.mi), other: formatClockShort(c.guess.other, c.mi), span: c.guess.span })
  }
}

function formatClockShort(h: number, mi: number): string {
  const suffix = h < 12 ? "am" : "pm"
  const h12 = h % 12 === 0 ? 12 : h % 12
  return mi === 0 ? `${h12}${suffix}` : `${h12}:${pad2(mi)}${suffix}`
}

function ruleText(r: RuleSpec, opts: { interval: boolean; bounds: boolean }): string {
  const parts = [`FREQ=${r.freq}`]
  if (opts.interval && r.interval > 1) parts.push(`INTERVAL=${r.interval}`)
  if (opts.bounds && r.count !== undefined) parts.push(`COUNT=${r.count}`)
  if (opts.bounds && r.until) parts.push(`UNTIL=${ymdString(r.until)}`)
  if (r.byMonth) parts.push(`BYMONTH=${r.byMonth.join(",")}`)
  if (r.byMonthDay) parts.push(`BYMONTHDAY=${r.byMonthDay.join(",")}`)
  if (r.byDay) {
    const days = [...r.byDay].sort((a, b) => (a.nth ?? 0) - (b.nth ?? 0) || a.day - b.day)
    parts.push(`BYDAY=${days.map((d) => `${d.nth ?? ""}${DAY_CODES[d.day]}`).join(",")}`)
  }
  if (r.bySetPos !== undefined) parts.push(`BYSETPOS=${r.bySetPos}`)
  if (r.byHour) parts.push(`BYHOUR=${r.byHour.join(",")}`)
  parts.push(`BYMINUTE=${r.byMinute.join(",")}`)
  return parts.join(";")
}

type Checked = { ok: true; rrule: string; dtstart: string; once: boolean; spacing?: true; firstMs: number } | { ok: false }

/** Engine checks by rule, zone and day: the prompt box re-reads the same phrase on every keystroke of the
 *  task after it, and the walk `checkSchedule` takes is most of a read's cost. A check holds from the moment
 *  it ran until the rule's first run, the only instant at which its answer could change. */
const checkedRules = new Map<string, { from: number; until: number; out: Checked }>()

/** The rule as RRULE + a local start that is its FIRST run after now (or after its start date), checked by
 *  the same `checkSchedule` the server runs. An interval is anchored on that first run, so "every other
 *  day at 8am" said tonight starts tomorrow, and "every other Friday" on the coming Friday. */
function finalize(r: RuleSpec, assumed: Assumed[], ctx: Ctx, core: Core): Built {
  const key = `${ctx.tz}\u0000${ymdString(ctx.today)}\u0000${JSON.stringify(r)}`
  let memo = checkedRules.get(key)
  if (!memo || ctx.nowMs < memo.from || ctx.nowMs >= memo.until) {
    const out = checkRule(r, ctx)
    memo = { from: ctx.nowMs, until: out.ok ? out.firstMs : ctx.nowMs, out }
    if (checkedRules.size >= 256) checkedRules.clear()
    checkedRules.set(key, memo)
  }
  const out = memo.out
  if (!out.ok) return { type: "cue", why: "unsupported", unread: { start: core.start, end: core.end } }
  return { type: "exact", rrule: out.rrule, dtstart: out.dtstart, once: out.once, assumed, ...(out.spacing ? { spacing: true as const } : {}) }
}

function checkRule(r: RuleSpec, ctx: Ctx): Checked {
  const unsupported: Checked = { ok: false }
  const { tz, nowMs } = ctx
  if (r.once) {
    const { date, h, mi } = r.once
    const rrule = `FREQ=DAILY;COUNT=1;BYHOUR=${h};BYMINUTE=${mi}`
    const dtstart = `${date.y}-${pad2(date.mo)}-${pad2(date.d)}T${pad2(h)}:${pad2(mi)}`
    const checked = checkSchedule({ rrule, dtstart, tz }, nowMs)
    if (!checked.ok) return unsupported
    return { ok: true, rrule, dtstart, once: true, firstMs: checked.value.next[0]! }
  }
  const refDay = r.start && compareYmd(r.start, ctx.today) > 0 ? r.start : ctx.today
  const refMs = r.start && compareYmd(r.start, ctx.today) > 0 ? wallToInstant({ ...r.start, h: 0, mi: 0 }, tz) - 1 : nowMs
  const provisional = `${refDay.y}-${pad2(refDay.mo)}-${pad2(refDay.d)}T00:00`
  const baseRule = r.anchor ? `FREQ=DAILY;BYHOUR=${r.anchor.h};BYMINUTE=${r.anchor.mi}` : ruleText(r, { interval: false, bounds: false })
  const base = compileSchedule({ rrule: baseRule, dtstart: provisional, tz })
  if (!base.ok) return unsupported
  const first = occurrencesAfter(base.value, refMs, 1)[0]
  if (first === undefined) return unsupported
  const dtstart = localWallString(first, tz)
  if (r.forSpan) {
    const open = compileSchedule({ rrule: ruleText(r, { interval: true, bounds: false }), dtstart, tz })
    if (!open.ok) return unsupported
    const fw = zonedWall(first, tz)
    const firstDay = { y: fw.y, mo: fw.mo, d: fw.d }
    const endDay = r.forSpan.unit === "month" ? addMonths(firstDay, r.forSpan.n) : addDays(firstDay, r.forSpan.n * (r.forSpan.unit === "week" ? 7 : 1))
    const endMs = wallToInstant({ ...endDay, h: 0, mi: 0 }, tz)
    const n = occurrencesBetween(open.value, first - 1, endMs - 1, 5000).length
    if (n === 0) return unsupported
    if (n <= 1000) r.count = n
    else r.until = addDays(endDay, -1)
  }
  if (r.until) {
    const fw = zonedWall(first, tz)
    if (compareYmd(r.until, { y: fw.y, mo: fw.mo, d: fw.d }) < 0) return unsupported
  }
  const rrule = ruleText(r, { interval: true, bounds: true })
  const checked = checkSchedule({ rrule, dtstart, tz }, nowMs)
  if (!checked.ok) {
    const compiled = compileSchedule({ rrule, dtstart, tz })
    if (compiled.ok && tooClose(compiled.value, nowMs)) return { ok: true, rrule, dtstart, once: r.count === 1, spacing: true, firstMs: first }
    return unsupported
  }
  // A rule `describeSchedule` cannot phrase would echo as raw RRULE text: the model reads it instead.
  if (describeSchedule(checked.value.compiled).startsWith("on the rule")) return unsupported
  return { ok: true, rrule, dtstart, once: r.count === 1, firstMs: first }
}

function tooClose(c: CompiledSchedule, nowMs: number): boolean {
  const sample = occurrencesAfter(c, nowMs, 60)
  for (let i = 1; i < sample.length; i++) if (sample[i]! - sample[i - 1]! < SCHEDULE_MIN_SPACING_MS) return true
  return false
}

// ---- judging a phrase in its text -------------------------------------------------------------------------------

function makeCtx(o: ReadPhraseOptions): Ctx {
  const w = zonedWall(o.nowMs, o.tz)
  return { nowMs: o.nowMs, tz: o.tz, today: { y: w.y, mo: w.mo, d: w.d }, oneShots: o.scope !== "edges" }
}

/** Read `text` for a schedule phrase (plans/schedule-live-reading.md §3.1). */
export function readSchedulePhrase(text: string, at: ReadPhraseOptions): PhraseReading {
  const p = prepare(text, at.exclude ?? [])
  let ctx: Ctx
  try {
    ctx = makeCtx(at)
  } catch {
    return { kind: "none" }
  }
  if (at.scope === "field") return readField(p, ctx)
  if (at.scope === "anywhere") return readAnywhere(p, ctx)
  return readEdges(p, ctx)
}

function readEdges(p: Prep, ctx: Ctx): PhraseReading {
  const windows = windowsOf(p.masked)
  if (windows.length === 0) return { kind: "none" }
  const open = windows[0]!, close = windows[windows.length - 1]!
  const openGate = GATE.test(p.masked.slice(open.start, open.end))
  const closeGate = close === open ? openGate : GATE.test(p.masked.slice(close.start, close.end))
  let openCands: Candidate[] | undefined
  if (openGate) {
    openCands = findCandidates(p, open, ctx)
    const first = openCands.find((c) => atOpen(p, open, c.start))
    if (first) {
      // A phrase that is also the whole text counts as the open edge (§2.3), where the end of the text is
      // not a clause boundary for an adverb: "Daily" alone is a word being typed, not a schedule.
      if (first.endOnly) return { kind: "none" }
      if (codeAt(p, first)) return { kind: "none" }
      return openGuards(p, judge(p, ctx, first, openCands, open, "open"))
    }
    const other = edgeOther(p, open)
    if (other) return other
  }
  if (closeGate) {
    const cands = close === open && openCands ? openCands : findCandidates(p, close, ctx)
    const last = cands[cands.length - 1]
    if (last && last.end >= close.end && !(close === open && atOpen(p, open, last.start))) {
      if (codeAt(p, last)) return { kind: "none" }
      const reading = judge(p, ctx, last, cands, close, "close")
      return reading.kind === "exact" ? closeGuards(p, close, reading) : reading
    }
  }
  return { kind: "none" }
}

function atOpen(p: Prep, w: Span, start: number): boolean {
  return start >= w.start && /^[\s(\-*•>#]*$/.test(p.masked.slice(w.start, start))
}

/** At the open edge with no phrase: a presence, an event, an event offset. */
function edgeOther(p: Prep, w: Span): PhraseReading | undefined {
  const sub = p.masked.slice(w.start, w.end)
  const startsAt = (re: RegExp) => {
    const m = re.exec(sub)
    return m && atOpen(p, w, w.start + m.index) ? { start: w.start + m.index, end: w.start + m.index + m[0].trimEnd().length } : undefined
  }
  const presence = startsAt(PRESENCE)
  if (presence) return { kind: "presence", span: presence }
  const offset = startsAt(EVENT_OFFSET)
  if (offset) return cue(p, "open", offset, undefined, offset, "event-offset")
  const event = startsAt(STRONG_EVENT) ?? startsAt(EVENT_NOUN)
  if (event) return { kind: "event", span: event }
  return undefined
}

/** The close-edge guards (§2.3): a deadline word just before, or a sentence about a schedule. */
function closeGuards(p: Prep, w: Span, r: Extract<PhraseReading, { kind: "exact" }>): PhraseReading {
  const before = p.masked.slice(w.start, r.span.start)
  const phrase = p.masked.slice(r.span.start, r.span.end)
  // The idiom is the word before the phrase — or the phrase's own first word, when the grammar took
  // "from Friday" or "until Friday" in as a start or a bound: "ship the fix by Friday every week".
  if (DEADLINE_BEFORE.test(before) || DEADLINE_OPENS.test(phrase)) return { ...r, veto: "deadline" }
  // One date at the end is a deadline, not a month's day: "ship the release on the 15th" (a list, "on the
  // 1st and 15th", is a rule, family G).
  if (LONE_MONTH_DAY.test(phrase)) return { ...r, veto: "deadline" }
  // The sentence's first word is exempt: "run the e2e suite nightly" is an imperative, "a script I will
  // run each morning" is about one.
  const sentence = before.replace(/^\s*[^\s]+/, "")
  if (ABOUT.test(sentence)) return { ...r, veto: "about" }
  // A prohibition ("don't deploy on Fridays", "stop pinging me every morning") or a statement of fact ("the
  // meeting is every Monday at 9am", "I'm out Fridays", "set the interval to weekly", "the label should
  // read: every Monday") ends in a schedule's words and asks for none. Here the first word counts: it is
  // often the negation itself.
  if (NEGATION.test(before) || STATEMENT_BEFORE.test(before)) return { ...r, veto: "about" }
  return r
}

/** §2.3 at the OPEN edge (fix round 1): where the task's imperative would be, a subject or a verb of being —
 *  "Every night the backup job fails with ENOSPC, fix it", "Every Monday our CI is slow", "Weekly, we get a
 *  spike of 500s", "Every Monday at 9am is when the digest goes out". The sentence REPORTS a schedule; it
 *  does not ask for one. An exact reading keeps its veto (the glyph may still hint); a cue or an ambiguous
 *  word says nothing. */
function openGuards(p: Prep, r: PhraseReading): PhraseReading {
  if (r.kind !== "exact" && r.kind !== "cue" && r.kind !== "ambiguous") return r
  // Where the words after the phrase it is sure of begin: a cue's core, else its unread words when they
  // follow the phrase, else the end of the whole span.
  // A zone's words are WHEN ("every Monday at 9am my time"): look past them. Unread words outside the span (fix
  // round 3) are far from the phrase, and the words right after the phrase are the ones that say what it is.
  const outside = r.kind === "cue" && (r.unread.start >= r.span.end || r.unread.end <= r.span.start)
  const at = r.kind === "cue"
    ? outside ? (r.core?.span.end ?? r.span.end) : r.why === "zone" ? r.unread.end : r.core ? Math.min(r.core.span.end, r.unread.start) : r.unread.start > r.span.start ? r.unread.start : r.span.end
    : r.span.end
  if (!DECLARATIVE_AFTER.test(p.masked.slice(at)) && !statesAfter(p, at)) return r
  return r.kind === "exact" ? { ...r, veto: "about" } : { kind: "none" }
}

// Fix round 3: the phrase as the SUBJECT of a statement — "Quarterly OKRs are due", "Weeknight deploys keep
// failing", "Every night, a cron job wipes /tmp", "Every 30 minutes, pods restart", "Every morning, CI is red",
// "Each night at 2am, Postgres autovacuum locks the table", "Every Monday I get a flood of PRs". Where the
// imperative would be stands a noun phrase and its verb. A heuristic over shapes, not a parse: the misses cost
// one Esc (§2.6), and every request the history holds still reads (the gate offers none either way).
/** A subject pronoun — not a request ("I want you to", "I'd like", "I need"). */
const SUBJECT_PRONOUN = /^[\s,;:—–-]*(?:i(?!\s+(?:want|need|['’]d|would|wanna|will\s+need)\b)(?=\s+[a-z])|he|she|they|someone|somebody|nobody|everyone|everybody|something|nothing)(?![\w'’])/
/** "a cron job wipes /tmp", "a GitHub Action should post…": an article, at most three words, then a verb. */
const ARTICLE_SUBJECT = /^[\s,;:—–-]*an?\s+(?:[\w-]+\s+){0,3}?(?:(?:is|are|was|were|has|have|had|will|would|should|could|can|must|might|keeps?|gets?)(?![\w'’])|[a-z]+s\s+(?:(?:the|a|an|our|my|its|their|all|every)(?![\w'’])|\/))/
/** One word and a verb of being, a modal or a verb that reports: "CI is red", "OKRs are due", "deploys keep". */
const WORD_THEN_VERB = /^[\s,;:—–-]*(?!(?:please|kindly|also|then|just|now|you|we|and|or|so|but|i|to|go|let)\b)[\w.-]+\s+(?:is|are|was|were|isn['’]t|aren['’]t|wasn['’]t|weren['’]t|keeps?|gets?|seems?|has|have|had|will|won['’]t|would|should|shouldn['’]t|can|can['’]t|could|must|might|does|doesn['’]t|did|didn['’]t|fails?|breaks?|crashes|goes|went|times\s+out)(?![\w'’])/
/** A plural noun and a bare verb, then the end of a clause or an object: "pods restart.", "logs fill the disk". */
const PLURAL_THEN_VERB = /^[\s,;:—–-]*(?!(?:always|sometimes|perhaps|afterwards|towards|besides|nowadays|regardless|unless|thus|plus|this|his|its|is|was|has|does|yes|us|as|less|alias|bias|canvas)\b)[a-z]{2,}[^su\W]s\s+(?!(?:the|a|an|my|our|your|their|this|that|these|those|all|every|each|some|any|no|to|for|in|on|at|of|with|from|by|into|onto|over|under|and|or|but|then|first|now)\b)[a-z]+(?=\s*(?:$|[,.;:!?]|\s(?:the|a|an|my|our|your|their|its|this|that|all|every)\b|\s\/))/
/** A name (capitalized past the sentence's start), at most two words, a verb in -s and its object: "Postgres
 *  autovacuum locks the table", "GitHub sends a digest". Read on the original text. */
const NAME_THEN_VERB = /^[\s,;:—–-]*[A-Z][\w.-]*(?:\s+[a-z][\w-]*){0,2}\s+[a-z]+s\s+(?:the|a|an|my|our|your|their|its|this|that|all|every|\/)/

function statesAfter(p: Prep, at: number): boolean {
  const rest = p.masked.slice(at, at + 120)
  return SUBJECT_PRONOUN.test(rest) || ARTICLE_SUBJECT.test(rest) || WORD_THEN_VERB.test(rest) || PLURAL_THEN_VERB.test(rest) || NAME_THEN_VERB.test(p.text.slice(at, at + 120))
}

/** A phrase that is part of code, not prose: a path or an assignment ("packages/web/src/daily",
 *  "FREQ=DAILY"), an identifier ("everyDay"), or an indented line ("    schedule: every Monday at 9am"). */
function codeAt(p: Prep, c: Span): boolean {
  if (/[/=_.\\@#$:-]$/.test(p.text.slice(Math.max(0, c.start - 1), c.start)) && c.start > 0 && !isSpace(p.text[c.start - 1])) return true
  if (/[/=_(\[]/.test(p.text[c.end] ?? "") && /[\w]/.test(p.text[c.end + 1] ?? "")) return true
  // A file's name (fix round 3): "daily.yml is failing", "nightly.yml: add a step", "Mondays.md". An extension
  // is short, lowercase and glued to the word; a sentence's next word is not.
  if (/^\.[a-z][a-z0-9]{0,3}(?![\w-])/.test(p.text.slice(c.end, c.end + 6))) return true
  if (/\p{Ll}\p{Lu}/u.test(p.text.slice(c.start, c.end))) return true
  const lineStart = p.text.lastIndexOf("\n", c.start - 1) + 1
  return lineStart > 0 && /^(?: {2,}|\t)/.test(p.text.slice(lineStart, c.start))
}

function readAnywhere(p: Prep, ctx: Ctx): PhraseReading {
  const n = p.text.length
  const windows = windowsOf(p.masked)
  if (windows.length === 0) return { kind: "none" }
  const edgeOf = (c: { start: number; end: number }): Edge => {
    const open = windows[0]!, close = windows[windows.length - 1]!
    if (atOpen(p, open, c.start)) return "open"
    if (c.end >= close.end) return "close"
    return "inside"
  }
  const regions = n <= ANYWHERE_MAX ? [{ start: 0, end: n }] : windows
  for (const region of regions) {
    const cands = findCandidates(p, region, ctx)
    // Part of code is no phrase in the mode either ("daily.yml is failing": fix round 3).
    const first = cands.find((c) => !codeAt(p, c))
    if (first) return judge(p, ctx, first, cands, region, edgeOf(first))
  }
  for (const region of regions) {
    const other = regionOther(p, region, ctx, edgeOf)
    if (other) return other
  }
  return { kind: "none" }
}

function readField(p: Prep, ctx: Ctx): PhraseReading {
  const region = { start: 0, end: p.text.length }
  const cands = findCandidates(p, region, ctx)
  if (!cands.length) return regionOther(p, region, ctx, () => "field") ?? { kind: "none" }
  const c = cands[0]!
  const reading = judge(p, ctx, c, cands, region, "field")
  if (reading.kind !== "exact") return reading
  // The whole field must be the phrase: anything else is words the grammar did not read.
  const lead = /^[\s(\-*•>#]*/.exec(p.masked)![0].length
  // Walked back by hand (fix round 3): `/[\s.!)]*$/` retried its run from every position, quadratic in a
  // pasted run of spaces or dots — 1.4s for "every Monday at 9am" + 20k spaces + "x".
  let tail = p.masked.length
  while (tail > 0 && /[\s.!)]/.test(p.masked[tail - 1]!)) tail--
  if (c.start <= lead && c.end >= tail) return reading
  const unread = c.start > lead ? { start: lead, end: c.start } : { start: c.end, end: tail }
  const span = { start: c.start, end: c.end }
  return cue(p, "field", span, residueNarrows(p, temporalResidue(p, span), reading) ? reading : undefined, trimSpan(p, unread), "leftover")
}

/** Anywhere in a region with no phrase: a presence, an event offset, an event, a typo. */
function regionOther(p: Prep, region: Span, ctx: Ctx, edgeOf: (s: Span) => Edge): PhraseReading | undefined {
  const sub = p.masked.slice(region.start, region.end)
  const find = (re: RegExp) => {
    const m = re.exec(sub)
    return m ? { start: region.start + m.index, end: region.start + m.index + m[0].trimEnd().length } : undefined
  }
  const presence = find(PRESENCE)
  if (presence) return { kind: "presence", span: presence }
  const offset = find(EVENT_OFFSET)
  if (offset) return cue(p, edgeOf(offset), offset, undefined, offset, "event-offset")
  const event = find(STRONG_EVENT)
  if (event) return { kind: "event", span: event }
  const typo = typoIn(p, region, edgeOf(region) === "field")
  if (typo) return cue(p, edgeOf(typo), typo, undefined, typo, "typo")
  const noun = find(EVENT_NOUN)
  if (noun) return { kind: "event", span: noun }
  return undefined
}

/** The text-level checks on a found phrase, in order: what it is, then everything around it that could
 *  change what it means. Anything the grammar does not read turns it into a cue. */
function judge(p: Prep, ctx: Ctx, c: Candidate, cands: Candidate[], region: Span, edge: Edge): PhraseReading {
  const span = { start: c.start, end: c.end }
  const b = builtOf(c)
  if (b.type === "ambiguous") {
    const word = p.text.slice(c.core.start, c.core.end)
    return { kind: "ambiguous", edge, span, word, copy: SCHEDULE_AMBIGUOUS_COPY[b.word] }
  }
  const exact = b.type === "exact" ? b : undefined
  const m = p.masked
  const sub = m.slice(region.start, region.end)
  const outside = (s: Span) => s.end <= c.start || s.start >= c.end
  const firstOutside = (re: RegExp, text: string, offset: number): Span | undefined => {
    const g = new RegExp(re.source, "g")
    for (const mm of text.matchAll(g)) {
      const s = { start: offset + mm.index!, end: offset + mm.index! + mm[0].trimEnd().length }
      if (outside(s) && !gluedToCode(p.text, s)) return s
    }
    return undefined
  }
  // Every word of time outside the phrase (fix round 3), found once: the gate an exact reading passes last, and
  // the test every cue's core passes — a core stays only when the words left can only narrow it.
  let residue: ResidueToken[] | undefined
  const residueOf = () => (residue ??= temporalResidue(p, span))
  const asCue = (unread: Span, why: CueWhy, withCore = true) => cue(p, edge, span, withCore && exact && residueNarrows(p, residueOf(), exact) ? exact : undefined, unread, why)

  // A presence clause runs to the next punctuation, which can be into the phrase itself ("while I'm
  // working every Monday at 9am"): the clause ends where the phrase starts.
  const presenceHit = new RegExp(PRESENCE.source).exec(sub)
  if (presenceHit) {
    const start = region.start + presenceHit.index
    const end = Math.min(start + presenceHit[0].trimEnd().length, start < c.start ? c.start : Infinity)
    const span = trimSpan(p, { start, end })
    if (span.end > span.start && outside(span)) return { kind: "presence", span }
  }
  if (ctx.oneShots) {
    const typo = typoIn(p, region, edge === "field")
    if (typo) return asCue(typo, "typo")
  }
  // A phrase the grammar declined is a cue whatever surrounds it.
  if (b.type === "cue") return asCue(b.unread ?? span, b.why, false)
  // Like a condition, an event offset or an event anywhere in the text could be what the schedule hangs on
  // ("every Monday at 9am. Post the notes after each release"): the model reads it.
  const offset = firstOutside(EVENT_OFFSET, m, 0)
  if (offset) return asCue(offset, "event-offset")
  const event = firstOutside(STRONG_EVENT, m, 0)
  if (event) return asCue(event, "condition")
  const touch = touching(p, region, span)
  if (touch) {
    // Unread words that name a time of day over a core whose clock was SAID ("at 9 thirty", "at 9 and again
    // at 5", "every hour at half past"): the core would show a run the human did not ask for, and a faithful
    // model reading could never pass `readingsConsistent` against it (§4.3). An assumed time is no constraint,
    // so that core stays (fix round 2).
    const clockish = !!touch.clockish && !exact?.assumed.some((a) => a.part === "time")
    return asCue(touch.unread, touch.why, !touch.noCore && !clockish)
  }
  const condition = firstOutside(STRONG_CONDITION, m, 0)
  if (condition) return asCue(trimSpan(p, clauseOf(p, condition)), "condition")
  const zone = firstOutside(ZONE_ANYWHERE, m, 0)
  if (zone) return asCue(zone, "zone", false)
  // A second rule adds runs, so no core is shown (fix round 2, as for a conjoined one in `touching`).
  const second = cands.find((k) => k !== c && outside(k) && !codeAt(p, k))
  if (second) return asCue({ start: second.start, end: second.end }, "compound", false)
  const residual = firstOutside(RESIDUAL, sub, region.start)
  // "on the half hour" changes the core's own minute, so the core would mislead: no core for it.
  if (residual) return HALF_HOUR.test(m.slice(residual.start, residual.end)) ? asCue(residual, "unsupported", false) : asCue(residual, "leftover")
  const bound = firstOutside(BOUND_ANYWHERE, m, 0)
  if (bound) return asCue(bound, "leftover")
  const calendar = firstOutside(CALENDAR_RESIDUAL, sub, region.start)
  if (calendar) return asCue(calendar, "leftover")
  // "…, fortnightly is fine" (fix round 2): a second frequency said as one, anywhere.
  const freq = firstOutside(FREQ_RESIDUAL, m, 0)
  if (freq) return asCue(freq, "compound")
  if (!exact) return { kind: "none" }
  // THE TEMPORAL RESIDUE (fix round 3): a word of time anywhere in what would be saved as the task, and the
  // reading is not exact. Not in "Change when", where any word outside the phrase is already a cue
  // (`readField`), nor for a spacing violation, which is never offered and has its own copy.
  if (edge !== "field" && !exact.spacing) {
    const tokens = residueOf()
    if (tokens.length) {
      const { unread, why } = residueUnread(p, span, tokens)
      return cue(p, edge, span, residueNarrows(p, tokens, exact) ? exact : undefined, unread, why)
    }
  }
  return {
    kind: "exact",
    edge,
    span,
    phrase: p.text.slice(span.start, span.end),
    rrule: exact.rrule,
    dtstart: exact.dtstart,
    once: exact.once,
    assumed: exact.assumed,
    ...(exact.spacing ? { spacing: true as const } : {}),
  }
}

/** A cue over the phrase at `coreSpan`. Its span is the phrase and its unread words together when nothing but
 *  punctuation lies between them ("every Monday at 9am, until Oct 30"). Unread words FAR from the phrase — the
 *  task's own words between ("every Monday at 9am triage new issues (PT)") — stay outside the span (fix round 3):
 *  the span is what is cut from the text to leave the task, and a span grown across the task cut the whole of
 *  it, so the mode had nothing left to send the model and said there was nothing to do. */
function cue(p: Prep, edge: Edge, coreSpan: Span, core: Extract<Built, { type: "exact" }> | Extract<PhraseReading, { kind: "exact" }> | undefined, unread: Span, why: CueWhy): PhraseReading {
  const lo = Math.min(coreSpan.end, unread.end), hi = Math.max(coreSpan.start, unread.start)
  const far = hi > lo && /[\p{L}\p{N}]/u.test(p.text.slice(lo, hi))
  const span = far ? { start: coreSpan.start, end: coreSpan.end } : { start: Math.min(coreSpan.start, unread.start), end: Math.max(coreSpan.end, unread.end) }
  const coreOut = core && !core.spacing ? { core: { span: coreSpan, rrule: core.rrule, dtstart: core.dtstart, assumed: core.assumed } } : {}
  return { kind: "cue", edge, span, phrase: p.text.slice(span.start, span.end), ...coreOut, unread, why }
}

function trimSpan(p: Prep, s: Span): Span {
  let { start, end } = s
  while (start < end && (isSpace(p.text[start]) || /[,;:.!?]/.test(p.text[start]!))) start++
  while (end > start && (isSpace(p.text[end - 1]) || /[,;:.!?]/.test(p.text[end - 1]!))) end--
  return { start, end }
}

/** A condition's words: the qualifier to the next clause boundary, at most four words after the
 *  keyword(s), stopping early after a holiday or day word ("unless it's a holiday", "except Fridays"). */
function clauseOf(p: Prep, hit: Span): Span {
  const m = p.masked
  let end = hit.end
  let words = 0
  const dayish = new RegExp(`^(?:holidays?|weekends?|weekdays?|hours|${WD}|${MONTH})$`)
  if (dayish.test(m.slice(hit.start, hit.end).split(/\s+/).pop() ?? "")) return hit
  while (end < m.length && words < 4) {
    const next = /^\s+([^\s,;:.!?\n\u0001]+)/.exec(m.slice(end))
    if (!next) break
    end += next[0].length
    words++
    if (dayish.test(next[1]!.replace(/['’]s$/, ""))) break
  }
  return { start: hit.start, end }
}

/** A qualifier-shaped word right against the phrase that the phrase did not absorb (§3.1). `noCore`: the
 *  words before it may not be a rule at all ("every Monday, Friday is off-limits"), so no core is shown. */
/** A touch's unread words, and what they do to the core: `noCore` — the core is not what the words say at all
 *  (a statement, a count that ADDS runs, a second rule); `clockish` — the words name a time of day, so a core
 *  whose clock was SAID would show the wrong run (one whose clock was assumed stays: an assumed part is no
 *  constraint, §4.3). */
type Touch = { unread: Span; why: CueWhy; noCore?: true; clockish?: true }

function touching(p: Prep, region: Span, span: Span): Touch | undefined {
  const m = p.masked
  const after = m.slice(span.end, region.end)
  /** The words a match after the phrase covers, without the separators it began with. */
  const hit = (mm: RegExpExecArray, why: CueWhy, opts: { clause?: boolean; noCore?: true } = {}) => {
    // A colon before a digit is a minute's (", :45"), not a separator.
    const lead = /^(?:[\s,;—–(\[-]|:(?!\d))*/.exec(mm[0])![0].length
    const s = { start: span.end + lead, end: span.end + mm[0].length }
    return { unread: trimSpan(p, opts.clause ? clauseOf(p, s) : s), why, ...(opts.noCore ? { noCore: true as const } : {}) }
  }
  const offset = ZONE_OFFSET_BARE.exec(after)
  if (offset) {
    const lead = /^[\s,;:(\[]*/.exec(offset[0])![0].length
    return { unread: { start: span.end + lead, end: span.end + offset[0].length }, why: "zone", noCore: true }
  }
  const zone = ZONE_AFTER.exec(after) ?? ZONE_ABBR_UPPER.exec(p.text.slice(span.end, region.end))
  // A zone moves every run, so no core is shown (fix round 2): the interpreter writes the zone's 9am as this
  // box's wall clock, which no core at 9am here could ever hold (§4.3). The MOD path ("9 PT") had none already.
  if (zone) return hit(zone, "zone", { noCore: true })
  const approx = APPROX_AFTER.exec(after)
  if (approx) return approx[1] ? hit(approx, "unsupported", { noCore: true }) : hit(approx, "vague")
  const clock = CLOCK_AFTER.exec(after)
  if (clock) return { ...hit(clock, "leftover"), clockish: true }
  const statement = STATEMENT_AFTER.exec(after)
  if (statement) return hit(statement, "condition", { clause: true, noCore: true })
  const a = TOUCH_AFTER.exec(after)
  if (a) {
    const word = a[1]!.split(/\s+/)[0]!
    const start = span.end + a[0].length - a[1]!.length
    return { unread: trimSpan(p, clauseOf(p, { start, end: span.end + a[0].length })), why: whyOf(word) }
  }
  // A second rule ADDS runs: no core can be a faithful reading's superset (fix round 2 — with the core kept, the
  // model's right answer to "every Monday at 9am and Friday at 5pm" was the disagree state).
  const conj = CONJOINED.exec(after)
  if (conj) return { unread: trimSpan(p, { start: span.end, end: span.end + conj[0].length }), why: "compound", noCore: true }
  const q = QUALIFIER_AFTER.exec(after)
  if (q) return hit(q, whyOf(q[1]!.replace(/\s+/g, " ")), { clause: true })
  // "on the half hour" moves the core's own minute: unsupported, no core (it reads as the residual below when
  // it does not touch the phrase).
  const half = HALF_HOUR_AFTER.exec(after)
  if (half) return hit(half, "unsupported", { noCore: true })
  // Fix round 2: any closed-class word (a preposition, a subordinator, a modal, an offset, a second frequency
  // or a count) — see WHEN_WORDS. A count ADDS runs ("every day at 9am, twice"), so its core is not shown.
  const when = WHEN_AFTER.exec(after)
  if (when) {
    const word = when[1]!.replace(/\s+/g, " ")
    if (COUNT_WORD.test(word)) return hit(when, "vague", { noCore: true })
    const touch = hit(when, whyOf(word.split(" ")[0]!), { clause: true })
    // "at" names a time whatever follows it ("at xx:30", "at lunch", "at the half hour"), as does an offset.
    const clockish = word === "at" || word === "@" || /\s(?:after|before|past|from|later|earlier|ahead|prior|into)$/.test(word) || CLOCK_MENTION.test(m.slice(touch.unread.start, touch.unread.end))
    return clockish ? { ...touch, clockish: true } : touch
  }
  const before = m.slice(region.start, span.start)
  const w = TOUCH_BEFORE_WORD.exec(before) ?? TOUCH_BEFORE_PAIR.exec(before)
  if (w) {
    const at = region.start + w.index + w[0].trimEnd().length - w[1]!.length
    return { unread: { start: at, end: at + w[1]!.length }, why: whyOf(w[1]!.split(/\s+/)[0]!) }
  }
  // "and again at 5, nightly": a second clock said BEFORE the phrase it joins (fix round 2).
  const again = SEQUENCE_BEFORE.exec(before)
  if (again) {
    const word = (again[1] ?? again[2])!
    const at = region.start + again.index + again[0].trimEnd().length - word.length
    return { unread: { start: at, end: at + word.length }, why: "compound", noCore: true }
  }
  // "alternate Thursdays", "the first two Mondays" (fix round 2): which of the days, unread.
  const limit = LIMIT_BEFORE.exec(before)
  if (limit) {
    const at = region.start + limit.index + limit[0].trimEnd().length - limit[1]!.length
    return { unread: { start: at, end: at + limit[1]!.length }, why: "vague" }
  }
  // A clause that OPENS with a qualifier and runs into the phrase with no comma: "if the build is green
  // every Monday at 9am". A qualifier inside the task ("check if the build is green every Monday at
  // 9am") is the task's own, and stays out of this.
  const open = Math.max(...[",", ";", ":", ".", "!", "?", "\n", "—", "–", "(", MASK].map((ch) => before.lastIndexOf(ch)))
  const lead = before.slice(open + 1)
  const opener = CLAUSE_QUALIFIER.exec(lead) ?? CLAUSE_WHEN.exec(lead)
  if (opener && lead.trim().length > opener[0].trim().length) {
    const at = region.start + open + 1 + opener[0].length - opener[1]!.length
    return { unread: trimSpan(p, { start: at, end: span.start }), why: whyOf(opener[1]!) }
  }
  // The clause before, when a comma joins it to the phrase: "if CI is red, every Monday at 9am …"
  if (/[,;:—–]\s*$/.test(before)) {
    const trimmed = before.replace(/[,;:—–]\s*$/, "")
    // A colon between digits is a clock's or an offset's ("-03:00, every day …"), not a clause's.
    const cut = Math.max(trimmed.lastIndexOf(","), trimmed.lastIndexOf(";"), trimmed.search(/:(?!\d)[^:]*$/), trimmed.lastIndexOf("."), trimmed.lastIndexOf("\n"), trimmed.lastIndexOf("—"), trimmed.lastIndexOf("–"))
    const clause = trimmed.slice(cut + 1)
    const q = CLAUSE_QUALIFIER.exec(clause) ?? CLAUSE_WHEN.exec(clause)
    if (q) {
      const at = region.start + cut + 1 + q[0].length - q[1]!.length
      return { unread: trimSpan(p, { start: at, end: region.start + trimmed.length }), why: whyOf(q[1]!) }
    }
    // A clause of the calendar or a zone, whatever word opens it: "Sundays off, every day at 9am …",
    // "Berlin time, every Monday at 9am …".
    const original = p.text.slice(region.start + cut + 1, region.start + trimmed.length)
    const zoneBefore = ZONE_AFTER.test(clause) || ZONE_ANYWHERE.test(clause) || ZONE_OFFSET_BARE.test(clause) || ZONE_ABBR_UPPER.test(original)
    if (zoneBefore || new RegExp(`\\b${CAL_WORD}`).test(clause)) {
      return { unread: trimSpan(p, { start: region.start + cut + 1, end: region.start + trimmed.length }), why: zoneBefore ? "zone" : "leftover", ...(zoneBefore ? { noCore: true as const } : {}) }
    }
  }
  return undefined
}

function whyOf(word: string): CueWhy {
  if (CONDITION_WORDS.has(word)) return "condition"
  if (OFFSET_WORDS.has(word)) return "event-offset"
  return "leftover"
}

// ---- typos -------------------------------------------------------------------------------------------------------

const TYPO_KEYWORDS = ["every", "daily", "weekly", "monthly", "hourly", "nightly", "weekday", "weekdays", "weekend", "weekends", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "tomorrow", "morning"]
/** Real words one edit from a keyword. */
const REAL_WORDS = new Set(["ever", "very", "eery", "even", "every", "dairy", "dally", "sundry", "sundae", "weakly", "knightly", "mourning", "mooring", "warning", "evening", "fridays", "mondays", "sundays"])

/** A completed word one edit from a schedule word ("evry", "wendesday"). The word being typed is not
 *  judged: "Frida" is half of "Friday", not a typo. */
function typoIn(p: Prep, region: Span, lastWordDone: boolean): Span | undefined {
  const sub = p.masked.slice(region.start, region.end)
  for (const m of sub.matchAll(/[a-z]+/g)) {
    const w = m[0]
    const end = region.start + m.index! + w.length
    if (end >= p.text.length && !lastWordDone) continue
    if (w.length < 4 || REAL_WORDS.has(w) || TYPO_KEYWORDS.includes(w) || TYPO_KEYWORDS.includes(w.replace(/s$/, ""))) continue
    if (TYPO_KEYWORDS.some((k) => oneEdit(k, w))) return { start: end - w.length, end }
  }
  return undefined
}

/** Exactly one insertion, deletion, substitution or swap of two neighbours apart (Damerau, in one pass). */
function oneEdit(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  if (a.length === b.length) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true // substitution
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2) // swap
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1)
}

// ---- a word still being typed (fix round 3) ---------------------------------------------------------------------

/** The schedule words a prefix can grow into. A plural or an "-ly" reads as its stem does ("Monday"/"Mondays",
 *  "month"/"monthly"), so only a completion that reads DIFFERENTLY counts. */
const SCHEDULE_WORDS = [
  ...DAY_NAMES.map((d) => d.toLowerCase()),
  "weekday", "weekend", "weeknight", "workday", "month", "fortnight", "quarter", "morning", "afternoon", "evening", "midnight", "midday",
  "january", "february", "march", "april", "june", "july", "august", "september", "october", "november", "december",
]
/** The abbreviations the grammar reads as the word itself: finishing "Thurs" as "Thursday" changes nothing. */
const SCHEDULE_ABBREVIATIONS: Readonly<Record<string, readonly string[]>> = {
  monday: ["mon"], tuesday: ["tue", "tues"], wednesday: ["wed", "weds"], thursday: ["thu", "thur", "thurs"], friday: ["fri"], saturday: ["sat"], sunday: ["sun"],
  january: ["jan"], february: ["feb"], march: ["mar"], april: ["apr"], june: ["jun"], july: ["jul"], august: ["aug"], september: ["sep", "sept"], october: ["oct"], november: ["nov"], december: ["dec"],
}
/** Whether the word the caret is in is a strict prefix of a schedule word that reads differently from what
 *  the prefix reads (fix round 3: a 400ms pause inside "every mon|th" published Monday, then the month; inside
 *  "every week|day", a Monday then the weekdays). The box holds its reading at a REST while this is true; the
 *  idle (the typing has stopped) still publishes. Not an abbreviation of the word it would finish as ("every
 *  Tuesday and Thurs|day" reads Thursday either way, so the rest shows it), nor a plural or an adverb of a word
 *  ("Monday|s", "month|ly"). */
export function scheduleWordPrefix(word: string): boolean {
  const w = word.toLowerCase()
  if (!/^[a-z]{2,}$/.test(w)) return false
  return SCHEDULE_WORDS.some((s) => s.length > w.length && s.startsWith(w) && !/^(?:s|ly)$/.test(s.slice(w.length)) && !SCHEDULE_ABBREVIATIONS[s]?.includes(w))
}

// ---- what the prompt box offers ---------------------------------------------------------------------------------

/** Whether a prompt-box reading (scope `edges`) is OFFERED — the underline and the ledge — rather than
 *  dark (§2.3–2.5): an exact recurrence at an edge the guards let through, or a cue or an ambiguous word
 *  at the open edge. One-offs and spacing violations are never offered. */
export function isScheduleOffer(r: PhraseReading): boolean {
  if (r.kind === "exact") return (r.edge === "open" || r.edge === "close") && !r.once && !r.spacing && !r.veto
  if (r.kind === "cue" || r.kind === "ambiguous") return r.edge === "open"
  return false
}

// ---- helpers the browser and the server share ------------------------------------------------------------------

/** Where `phrase` sits in `text`: exactly, else ignoring case; with `near`, the occurrence closest to it
 *  (a model reading relocated after the task around it was edited, §4.2). */
export function locatePhrase(text: string, phrase: string, near?: number): Span | undefined {
  const p = phrase.trim()
  if (!p) return undefined
  const all = (hay: string, needle: string) => {
    const out: number[] = []
    for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) out.push(i)
    return out
  }
  let hits = all(text, p)
  if (!hits.length) hits = all(sameLengthLower(text), sameLengthLower(p))
  if (!hits.length) return undefined
  const at = near === undefined ? hits[0]! : hits.reduce((best, h) => (Math.abs(h - near) < Math.abs(best - near) ? h : best))
  return { start: at, end: at + p.length }
}

/** `text` with `span` cut out and the seam tidied — the dangling comma or dash the phrase leaves — and
 *  NOTHING else changed. The browser's "Each run:" and the server's saved prompt are both this. */
export function cutPhrase(text: string, span: Span): string {
  const before = text.slice(0, span.start).replace(/[\s,;:–—-]+$/u, "")
  const after = text.slice(span.end).replace(/^[\s,;:–—-]+/u, "")
  // A phrase that opened the text took its sentence with it: the stop that ended it ("Every day at 9am. Post
  // the digest.") has nothing left to end, so it goes too.
  if (!before.trim()) return after.replace(/^[.!?]+(?=\s|$)/u, "").trim()
  if (!after.trim()) return before.trim()
  return `${before}${/^[.!?)]/.test(after) ? "" : " "}${after}`.trim()
}

const TITLE_DROP = new Set(["please", "pls", "kindly", "the", "a", "an", "this", "that", "these", "those", "our", "my", "your", "its", "their", "all", "any", "some"])
const TITLE_TAIL_STOP = new Set(["it", "them", "this", "that", "these", "those", "up", "out", "in", "on", "at", "for", "to", "of", "the", "a", "an", "all", "now", "please", "again", "too", "there", "here", "me", "us", "with", "from", "by", "and", "or", "if", "is", "are"])

/** A schedule's title before the namer has run (§10.2): the verb and head noun of the cut prompt's first
 *  clause — "triage new issues" → "Triage issues" — in sentence case, within a thread name's two words
 *  and twenty-character handle. */
export function provisionalScheduleTitle(prompt: string): string {
  const fallback = "Scheduled run"
  const line = prompt.trim().split("\n")[0] ?? ""
  const clause = line.split(/[,;:—–]|\.(?=\s|$)|\s+-\s+|\s+(?:and|&)\s+/i)[0] ?? ""
  const words = clause.split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")).filter(Boolean)
  while (words.length && TITLE_DROP.has(words[0]!.toLowerCase())) words.shift()
  if (!words.length) return fallback
  let lastAt = words.length - 1
  while (lastAt > 0 && TITLE_TAIL_STOP.has(words[lastAt]!.toLowerCase())) lastAt--
  const first = words[0]!
  const head = first[0]!.toUpperCase() + first.slice(1)
  const fits = (name: string) => name.split(/\s+/).length <= 2 && (threadHandle(name)?.length ?? Infinity) <= THREAD_HANDLE_MAX_CHARS
  if (lastAt > 0) {
    let tail = words[lastAt]!
    // Typed in Title Case ("Triage New Issues")? Sentence case wins; an acronym or a brand keeps its caps.
    const titleCased = words.slice(1).every((w) => /^\p{Lu}\p{Ll}+$/u.test(w))
    if (titleCased && /^\p{Lu}\p{Ll}+$/u.test(tail)) tail = tail.toLowerCase()
    const two = `${head} ${tail}`
    if (fits(two)) return two
  }
  return fits(head) ? head : fallback
}

/** Whether a model's reading is a faithful reading of a local core (§4.3): its phrase CONTAINS the core's
 *  (it may grow, never shrink or move), and each of its next 12 runs is a run of the core. A condition,
 *  COUNT or UNTIL can only remove runs, so a faithful reading always passes. A part the core ASSUMED is
 *  not a constraint: an assumed time compares dates only, an assumed meridiem compares the clock on 12
 *  hours, and an assumed day compares the time of day only. */
export function readingsConsistent(
  core: { rrule: string; dtstart: string; tz: string; assumed: readonly Assumed[]; span?: Span },
  model: { rrule: string; dtstart: string; tz: string; span?: Span },
  nowMs: number,
): boolean {
  if (core.span && model.span && (model.span.start > core.span.start || model.span.end < core.span.end)) return false
  const c = compileSchedule(core)
  const md = compileSchedule(model)
  if (!c.ok || !md.ok) return false
  const theirs = occurrencesAfter(md.value, nowMs, 12)
  if (theirs.length === 0) return false
  // Through the whole day of their last run: an assumed time compares days, so our run on that day may
  // fall after theirs.
  const ours = occurrencesBetween(c.value, nowMs, theirs[theirs.length - 1]! + DAY_MS + 60_000, 20_000)
  const tz = core.tz
  const timeAssumed = core.assumed.some((a) => a.part === "time")
  const meridiemAssumed = core.assumed.some((a) => a.part === "meridiem")
  // A day with no word for it ("every week" → Monday). A day the words name two ways carries the other as a
  // `shift` instead (fix round 3), and is compared run for run below.
  const dayAssumed = core.assumed.some((a) => a.part === "day" && a.shift === undefined)
  const shifts = [0, ...core.assumed.flatMap((a) => (a.part === "day" && a.shift !== undefined ? [a.shift] : []))]
  const clockOf = (ms: number) => {
    const w = zonedWall(ms, tz)
    return `${meridiemAssumed ? w.h % 12 : w.h}:${w.mi}`
  }
  if (dayAssumed) {
    // "every week" / "every month" assumed the day (and maybe the time), but not HOW OFTEN: one run in each
    // period the core runs in. It returned true outright when the time was assumed too, so an hourly answer
    // over "every week" passed (fix round 1). Each of their runs falls in its own week (or month), the
    // periods a multiple of the core's interval apart — a condition skips periods, it never adds a run to
    // one — and at a clock the core runs at, unless that was assumed as well.
    const freq = /FREQ=(\w+)/.exec(core.rrule)?.[1]
    const interval = Number(/INTERVAL=(\d+)/.exec(core.rrule)?.[1] ?? 1)
    const periodOf = (ms: number): number => {
      const w = zonedWall(ms, tz)
      if (freq === "MONTHLY") return w.y * 12 + (w.mo - 1)
      // Weeks counted from a Monday, the week's first day here as in the core's BYDAY.
      const day = Math.floor(Date.UTC(w.y, w.mo - 1, w.d) / DAY_MS)
      return Math.floor((day + 3) / 7)
    }
    if (freq !== "WEEKLY" && freq !== "MONTHLY") return false
    const periods = theirs.map(periodOf)
    for (let i = 1; i < periods.length; i++) {
      const gap = periods[i]! - periods[i - 1]!
      if (gap <= 0 || gap % interval !== 0) return false
    }
    if (timeAssumed) return true
    const clocks = new Set(ours.map(clockOf))
    return theirs.every((ms) => clocks.has(clockOf(ms)))
  }
  // Each of their runs is one of ours, counted: an assumed time compares dates (one run on each of the
  // core's days — "every Monday" is not "hourly on Mondays"), an assumed meridiem the clock on 12 hours. Where
  // the core read one of two days, their runs may all be the other one's: ours, each moved by the shift.
  const key = (ms: number, shift: number) => {
    const w = zonedWall(ms, tz)
    const d = shift ? fromDayNo(dayNo({ y: w.y, mo: w.mo, d: w.d }) - shift) : w
    const date = `${d.y}-${d.mo}-${d.d}`
    return timeAssumed ? date : `${date} ${clockOf(ms)}`
  }
  return shifts.some((shift) => {
    const allowed = new Map<string, number>()
    for (const ms of ours) allowed.set(key(ms, 0), (allowed.get(key(ms, 0)) ?? 0) + 1)
    for (const ms of theirs) {
      const k = key(ms, shift)
      const left = allowed.get(k) ?? 0
      if (left <= 0) return false
      allowed.set(k, left - 1)
    }
    return true
  })
}

function sortedUnique(list: number[]): number[] {
  return [...new Set(list)].sort((a, b) => a - b)
}
