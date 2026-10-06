import type { PhraseReading } from "@frizz/shared"

// The Change when field's two pure rules (plans/schedule-live-reading.md §11, ScheduleDrawer.tsx `ChangeWhen`):
// WHEN a typed change may change the reading on screen, and when two readings would show the same thing.
// Kept out of the component so they are tested without a DOM.

/** A change ends a word — whitespace or punctuation just before the caret — or replaces text wholesale (a
 *  paste, a drop, undo or redo, an autocorrect): the moments a reading may change on screen (§2.4). Mid-word
 *  typing waits for the rest. Step 4's `scheduleOffer.ts` owns the prompt box's fuller policy. */
export function publishesNow(inputType: string | undefined, value: string, caret: number): boolean {
  if (inputType && WHOLESALE_INPUT.has(inputType)) return true
  return caret === 0 || /[\s,;:.!?)]$/.test(value.slice(0, caret))
}
const WHOLESALE_INPUT = new Set(["insertFromPaste", "insertFromDrop", "insertFromYank", "insertReplacementText", "insertLineBreak", "historyUndo", "historyRedo", "deleteByCut", "deleteByDrag"])

/** Two readings the screen would show identically: kind, rule and start (a cue's unread words and core too). */
export function readingKey(r: PhraseReading): string {
  switch (r.kind) {
    case "exact":
      return `exact ${r.rrule} ${r.dtstart}${r.spacing ? " spacing" : ""}`
    case "cue":
      return `cue ${r.why} ${r.unread.start}-${r.unread.end}${r.core ? ` ${r.core.rrule} ${r.core.dtstart}` : ""}`
    case "ambiguous":
      return `ambiguous ${r.word}`
    default:
      return r.kind
  }
}

/** §2.4 as built — A QUALIFIER STILL BEING TYPED HOLDS THE READING IT QUALIFIES. The grammar never eats a word
 *  it has not read, so `every Thursday at` (the time not typed yet) and `every Monday unless` are cues whose
 *  unread words run to the end of the text. When the cue's core is exactly the exact reading on screen, the
 *  human is mid-qualifier: a word boundary inside it does not change the screen, and only the rest (the
 *  typing stopping) or the qualifier finishing (`at 3pm` → exact again) does. Without it the preview
 *  flipped to "reading “at”…" and back between two words of an ordinary rule. */
export function holdsQualifier(shown: PhraseReading | undefined, words: string, next: PhraseReading): boolean {
  if (next.kind !== "cue" || !next.core || next.unread.end < words.length) return false
  return shown?.kind === "exact" && shown.rrule === next.core.rrule && shown.dtstart === next.core.dtstart
}
