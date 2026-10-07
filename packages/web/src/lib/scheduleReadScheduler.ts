// WHEN THE BOX ASKS THE MODEL (ARCHITECTURE.md § Scheduled threads). A prompt whose words include a schedule word
// (`hasScheduleTrigger`, packages/shared/src/schedule-trigger.ts) is read by the model as it is typed, so the
// schedule it holds is on screen before Enter. Not on every keystroke: a read takes seconds and costs quota,
// and "every Mon" is not yet anything. The box asks when a WORD COMPLETES — the character just typed is a
// space, a newline or punctuation, or the text was replaced wholesale (a paste, an undo) — or after the typing
// rests for READ_IDLE_MS, whichever comes first. The reader (lib/scheduleModelRead.ts) does the rest: one read
// out at a time with only the latest text queued behind it, the 10m cache, the per-draft budget.
//
// A change this box did not make — another box on the same draft typed it (the `c` dialog over the page box),
// an Undo put it back, a re-aim carried it in — waits for the idle: it is a keystroke in someone else's word
// as often as not, and the box that made it asks at the word's end anyway (the shared reader sends it once).

/** The typing rests this long, mid-word, before the box asks about the text as it stands. */
export const READ_IDLE_MS = 500

/** What the textarea did, as the box reports it (Composer `onInputEvent`), before its own onChange. */
export type BoxInputEvent =
  | { type: "edit"; prose: string; caret: number; inputType?: string; composing: boolean }
  | { type: "compositionend"; prose: string; caret: number }
  | { type: "blur" }

/** How a change to the text reads: it ended a word, replaced text wholesale, or happened inside a word. */
export type EditKind = "boundary" | "midword" | "wholesale"

const BOUNDARY = /[\s,;:.!?)]/
/** Input types that replace text wholesale: each completes whatever it touched. */
const WHOLESALE_INPUT = new Set([
  "insertFromPaste", "insertFromDrop", "insertFromYank", "insertReplacementText", "insertLineBreak",
  "historyUndo", "historyRedo", "deleteByCut", "deleteByDrag", "deleteWordBackward", "deleteWordForward",
  "deleteSoftLineBackward", "deleteSoftLineForward", "deleteHardLineBackward", "deleteHardLineForward",
])

/** The one change between two texts: where it starts, and what it removed and inserted. */
function diff(before: string, after: string): { at: number; removed: number; inserted: number } {
  const max = Math.min(before.length, after.length)
  let p = 0
  while (p < max && before[p] === after[p]) p++
  let s = 0
  while (s < max - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++
  return { at: p, removed: before.length - p - s, inserted: after.length - p - s }
}

/** A change that ends a word (a boundary just before the caret), replaces text wholesale (several characters
 *  at once, or an input type that is one), or happens inside a word. */
export function classifyEdit(before: string, after: string, caret: number, inputType?: string): EditKind {
  if (inputType && WHOLESALE_INPUT.has(inputType)) return "wholesale"
  const d = diff(before, after)
  if (d.inserted > 1 || d.removed > 1 || (d.inserted > 0 && d.removed > 0)) return "wholesale"
  // A colon after a digit is a clock being typed ("10:" on the way to "10:30am"), not the end of a word.
  if (after[caret - 1] === ":" && /\d/.test(after[caret - 2] ?? "")) return "midword"
  return caret <= 0 || BOUNDARY.test(after[caret - 1] ?? "") ? "boundary" : "midword"
}

/** How the box saw the text change: its own edit (classified), an IME still composing, or another box's. */
export type ChangeKind = EditKind | "composing" | "external"

export interface ReadScheduler {
  /** The text is now `text`. Asks at once at a word's end or a wholesale change, else after the idle. */
  changed(text: string, how: ChangeKind): void
  /** Stop waiting (the box unmounted). */
  dispose(): void
}

export interface ReadSchedulerDeps {
  /** Ask the model about `text` (an automatic read: budgeted, single-flight). */
  request: (text: string) => void
  /** The text no longer wants a read: drop the one queued behind the read that is out. */
  cancel: () => void
  /** Whether `text` wants a read at all — it holds a schedule word. */
  wanted: (text: string) => boolean
  idleMs?: number
  timers?: { set: (run: () => void, ms: number) => unknown; clear: (handle: unknown) => void }
}

export function createReadScheduler(deps: ReadSchedulerDeps): ReadScheduler {
  const idleMs = deps.idleMs ?? READ_IDLE_MS
  const timers = deps.timers ?? { set: (run: () => void, ms: number) => setTimeout(run, ms), clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) }
  let idle: unknown
  let armed = false
  let latest = ""
  const disarm = () => {
    if (armed) timers.clear(idle)
    armed = false
  }
  return {
    changed(text, how) {
      latest = text
      disarm()
      if (!deps.wanted(text)) {
        deps.cancel()
        return
      }
      // An IME's composition is not text yet: its commit arrives as a wholesale change.
      if (how === "composing") return
      if (how === "boundary" || how === "wholesale") {
        deps.request(text)
        return
      }
      armed = true
      idle = timers.set(() => {
        armed = false
        if (deps.wanted(latest)) deps.request(latest)
      }, idleMs)
    },
    dispose: disarm,
  }
}
