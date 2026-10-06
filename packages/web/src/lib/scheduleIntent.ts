import { SCHEDULE_NOT_FOUND_COPY, SCHEDULE_PRESENCE_COPY, SCHEDULE_SPACING_COPY, locatePhrase, type InterpretScheduleResult, type Span } from "@frizz/shared"
import { isFailedRead, type ModelReadOk, type ModelReadView } from "./scheduleModelRead.ts"

// WHAT THE PROMPT BOX MAKES OF ITS WORDS, AND WHAT ENTER DOES WITH THEM (plans/schedule-live-reading.md). There is
// one submit — Enter, the send button, the phone's send — and the model decides what it means: a prompt with a
// schedule word in it is read (lib/scheduleReadScheduler.ts), and if the model says the words ask for the work
// to REPEAT, Enter creates that schedule instead of starting the thread. Everything here is pure, so the
// decisions are tested without a DOM (scheduleIntent.test.ts) and ScheduleComposer.tsx only executes them.
//
// The rules:
//   - A reading is used at submit only for EXACTLY the text being submitted (its trimmed words), never one read
//     from an earlier text: an edit since the last read is re-read before anything is created. A reading the
//     cache holds costs nothing to re-use, so nothing relocates an old reading onto new words.
//   - Without a reading for the text, Enter HOLDS ("Checking for a schedule…") until the answer lands, then
//     acts on it. Typing during the hold cancels it.
//   - Nothing is ever dispatched silently in place of a schedule the human may have meant: a read that fails at
//     submit, or a schedule the box cannot make, stops with a line that says so, and the NEXT Enter starts it.
//   - The human can say "not a schedule" (× or Esc): the draft keeps that phrase DISMISSED, and Enter starts the
//     thread, until the model reads a different phrase out of the words.

/** What the model's answer means for the box. */
export type ScheduleAnswer =
  /** The words ask for a schedule, and this is it. */
  | { kind: "schedule"; result: ModelReadOk }
  /** They do not ask for one: Enter starts the thread. */
  | { kind: "none" }
  /** They ask for one the box cannot make — closer than 15m, at the keyboard, nothing left to run. */
  | { kind: "refused"; copy: string }
  /** The read itself failed; nothing is known. */
  | { kind: "failed" }

/** What is known about one text: an answer, or not yet. */
export type ScheduleKnown = ScheduleAnswer | { kind: "pending" }

/** What the box says when a reading leaves nothing for each run to do. */
export const NO_TASK_COPY = "Say what each run should do, like “every Monday at 9am triage new issues”."

/**
 * The model's answer, as the box acts on it. `refuse` vets a reading the box cannot show or save (a rule with no
 * words for it, nothing left to run) into a refusal with its copy.
 *
 * The interpreter's "doesn't say when it should run" is NONE, the ordinary answer for most words with a schedule
 * word in them ("fix the bug from this morning"). So is an interpreter that is switched off (FRIZZ_THREAD_NAMER=0)
 * or a refusal this box has no words for: the box then behaves as it would with no schedules at all. Only the
 * refusals of a schedule the human evidently asked for — too frequent, while at the keyboard, no task, a rule
 * that would not check — are said on screen.
 */
export function classifyResult(result: InterpretScheduleResult, refuse?: (reading: ModelReadOk) => string | undefined): ScheduleAnswer {
  if (result.ok) {
    const copy = refuse?.(result)
    return copy ? { kind: "refused", copy } : { kind: "schedule", result }
  }
  if (isFailedRead(result)) return { kind: "failed" }
  const e = result.error
  if (e === SCHEDULE_NOT_FOUND_COPY) return { kind: "none" }
  if (e === SCHEDULE_PRESENCE_COPY || e === SCHEDULE_SPACING_COPY || e.startsWith("Couldn't turn that into a schedule") || e.startsWith("What should each run do?")) {
    return { kind: "refused", copy: e }
  }
  return { kind: "none" }
}

/** What the reader knows about a text, as the box acts on it. */
export function knownOf(view: ModelReadView, refuse?: (reading: ModelReadOk) => string | undefined): ScheduleKnown {
  if (view.status === "answered") return classifyResult(view.result, refuse)
  if (view.status === "failed") return { kind: "failed" }
  return { kind: "pending" }
}

/** The words the model reads for a prose: trimmed, as the server would read them anyway. */
export const readTextOf = (prose: string): string => prose.trim()

/**
 * Where a reading's phrase sits in `prose`. A reading OF this prose (`readText` is its trimmed words) maps its
 * offsets — which index the trimmed text — by the whitespace trimmed off the front: a prompt that opens with a
 * newline drew every mark one character late until that was added back (fix round 1, X8). A reading of an
 * earlier text, still on screen while this one is read, is found by its phrase, near where it was.
 */
export function phraseSpan(prose: string, readText: string, result: ModelReadOk): Span | undefined {
  const lead = prose.length - prose.trimStart().length
  const at = { start: lead + result.phraseStart, end: lead + result.phraseEnd }
  if (readTextOf(prose) === readText && prose.slice(at.start, at.end) === result.phrase) return at
  return locatePhrase(prose, result.phrase, at.start)
}

const normal = (phrase: string) => phrase.trim().replace(/\s+/g, " ").toLowerCase()

/** Whether a reading is the one the draft dismissed: the same phrase, give or take case and spacing. */
export function isDismissed(result: ModelReadOk, dismissed: string | undefined): boolean {
  return dismissed !== undefined && normal(result.phrase) === normal(dismissed)
}

/** A dismissal lifts once the model reads the words again and finds a DIFFERENT phrase, or none at all: "not a
 *  schedule" was said about those words, and they are gone. A pending or failed read lifts nothing. */
export function liftsDismissal(known: ScheduleKnown, dismissed: string | undefined): boolean {
  if (dismissed === undefined) return false
  if (known.kind === "none") return true
  return known.kind === "schedule" && !isDismissed(known.result, dismissed)
}

// ---- submit ---------------------------------------------------------------------------------------------------

export type SubmitAct =
  /** Start the thread now, exactly as the box always has. */
  | { act: "dispatch" }
  /** Create this schedule. */
  | { act: "create"; result: ModelReadOk }
  /** Nothing is known for this text yet: hold the send until the answer lands, reading it now. */
  | { act: "hold" }
  /** Nothing starts. The line on screen says why, and the next Enter starts the thread. */
  | { act: "stop"; why: "refused" | "failed" }

/**
 * What a submit does with the text, given what is known about EXACTLY that text. `at` is the Enter itself, or a
 * held Enter's answer landing. Null: still nothing known, so a hold keeps holding.
 *
 * - No schedule word, a dismissed reading, or no schedule in the words: dispatch.
 * - A schedule: create it.
 * - A refusal: at an Enter its line is already on screen, saying Enter starts it now, so it does. Landing on a held
 *   Enter it stops instead — the human pressed Enter before they could read it.
 * - A failed read: "Couldn't check for a schedule" stops the first Enter; the next one dispatches. A failure of a
 *   read made while typing is not that line: Enter holds and reads again.
 * - Nothing known yet: hold.
 */
export function submitAct(a: {
  trigger: boolean
  known: ScheduleKnown
  dismissed: string | undefined
  /** "Couldn't check for a schedule" is on screen for exactly this text. */
  failShown: boolean
  at: "enter" | "landed"
}): SubmitAct | null {
  if (!a.trigger) return { act: "dispatch" }
  const k = a.known
  switch (k.kind) {
    case "schedule":
      return isDismissed(k.result, a.dismissed) ? { act: "dispatch" } : { act: "create", result: k.result }
    case "none":
      return { act: "dispatch" }
    case "refused":
      return a.at === "enter" ? { act: "dispatch" } : { act: "stop", why: "refused" }
    case "failed":
      if (a.at === "landed") return { act: "stop", why: "failed" }
      return a.failShown ? { act: "dispatch" } : { act: "hold" }
    case "pending":
      if (a.at === "landed") return null
      return a.failShown ? { act: "dispatch" } : { act: "hold" }
  }
}

// ---- what the strip under the box shows ------------------------------------------------------------------------

export type StripView =
  | { kind: "none" }
  /** A read of this text is out and nothing is on screen: only the faint cue on the schedule words. */
  | { kind: "pending" }
  /** The schedule Enter creates: `fresh` for this very text, else the last one read while this one is read
   *  (stale-while-revalidate), from `readText`. */
  | { kind: "schedule"; result: ModelReadOk; readText: string; fresh: boolean }
  /** A schedule the box cannot make, and why. */
  | { kind: "refused"; copy: string }
  /** Undo dismissed this reading: the line that says Enter starts it now, with a way to schedule it after all. */
  | { kind: "undone" }

export type Dismissal = { phrase: string; undone: boolean }

/**
 * The strip, given what is known about the text, the read out for it, and the newest answer known before it.
 *
 * Text with no schedule word shows nothing, whatever was read before: the box looks exactly as it does without
 * schedules. A schedule read from an earlier text STAYS while this one is read and updates in place when the
 * answer lands; an answer of no schedule takes it away. A refusal is said only for the text it was given for:
 * read from an earlier text it is usually a schedule half typed ("every Monday at" has no task yet).
 */
export function stripView(a: {
  trigger: boolean
  /** The words the model reads for the text on screen (`readTextOf`). */
  text: string
  known: ScheduleKnown
  reading: boolean
  stale: { text: string; answer: ScheduleAnswer } | undefined
  dismissed: Dismissal | undefined
}): StripView {
  if (!a.trigger) return { kind: "none" }
  const d = a.dismissed
  const k = a.known
  if (k.kind === "schedule") {
    if (isDismissed(k.result, d?.phrase)) return d!.undone ? { kind: "undone" } : { kind: "none" }
    return { kind: "schedule", result: k.result, readText: a.text, fresh: true }
  }
  if (k.kind === "refused") return { kind: "refused", copy: k.copy }
  if (k.kind === "none") return { kind: "none" }
  // Pending or failed: what was read before stays, if it was a schedule.
  const s = a.stale?.answer
  if (s?.kind === "schedule") {
    if (!isDismissed(s.result, d?.phrase)) return { kind: "schedule", result: s.result, readText: a.stale!.text, fresh: false }
    if (d!.undone) return { kind: "undone" }
  } else if (d?.undone) return { kind: "undone" }
  return a.reading ? { kind: "pending" } : { kind: "none" }
}
