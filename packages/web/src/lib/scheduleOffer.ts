import { useEffect, useRef, useState } from "react"
import { isScheduleOffer, readSchedulePhrase, scheduleEdgeGates, type PhraseReading, type Span } from "@frizz/shared"

// THE PROMPT BOX'S PUBLISH POLICY (plans/schedule-live-reading.md §2.4, §8). The local grammar may run on every
// keystroke — it costs a millisecond — but what it says must not reach the screen on every keystroke: read at
// `every Mon` it says nothing, at `every Monday` it says Monday at 9am, at `every Monday at` it says "a cue",
// and a ledge that followed each of those would flicker under every phrase anybody types. So the grammar's
// answer is PUBLISHED only at the moments a reading may change:
//
//   - a word ends — the character just typed is whitespace or `, ; : . ! ? )` — or a paste, a drop, an undo,
//     a redo or any other wholesale change replaced the text, or the box blurred;
//   - the typing rests (REST_MS) with the caret inside a word;
//   - a phrase at the CLOSE edge waits for the human to stop (CLOSE_IDLE_MS): every sentence being typed
//     briefly ends in whatever was just typed, so "fix the build every" is not yet an offer;
//   - while a word is half-typed, the last reading stays;
//   - a QUALIFIER STILL BEING TYPED holds the reading it qualifies (§2.4 as built): `every Monday at` is a cue
//     until the time is typed, and the offer for `every Monday` stays until it is, or the typing rests;
//   - an offer that goes away is HELD for HOLD_MS while the caret is inside or touching it (the human is
//     retyping `9am`), then folds;
//   - nothing publishes during IME composition.
//
// It is DERIVED, not an effect on the text (`Composer.tsx` explains why an effect that sets state per
// keystroke starved a burst of keystrokes into "Maximum update depth exceeded"): `publish` is a pure step from
// one state to the next, run during render when the text changes, and the hook's only effects are the timers.
//
// It never touches schedule MODE. Only an explicit act turns the mode on or off (I-3); this file reads the
// mode as an input and a test asserts it imports no setter for it.

/** A phrase at the open edge publishes after this long with the caret inside a word. */
export const REST_MS = 250
/** A phrase at the close edge publishes after this long with no input at all. */
export const CLOSE_IDLE_MS = 800
/** An offer that went away is held this long while the caret is inside or touching it. */
export const HOLD_MS = 400
/** In the mode, words the grammar declines go to the model after this long with no input (§4.2). */
export const MODEL_IDLE_MS = 700

export type ScheduleEdge = "open" | "close"
export type Dismissed = { readonly open?: true; readonly close?: true }

/** What the textarea did, as the box reports it (Composer `onInputEvent`). */
export type BoxInputEvent =
  | { type: "edit"; prose: string; caret: number; inputType?: string; composing: boolean }
  | { type: "compositionend"; prose: string; caret: number }
  | { type: "blur" }

/** How a change to the text reads to the policy. */
export type EditKind = "boundary" | "midword" | "wholesale"

export type OfferEvent =
  | { kind: "edit"; edit: EditKind; caret: number | null; at: number }
  | { kind: "composing"; at: number }
  /** REST_MS with no input. */
  | { kind: "rest"; at: number }
  /** CLOSE_IDLE_MS with no input. */
  | { kind: "idle"; at: number }
  /** HOLD_MS after a fold was held. */
  | { kind: "hold"; at: number }
  | { kind: "blur"; at: number }
  /** An explicit act read the text now — Tab, the glyph, ⌘⌥↵, Enter in the mode, the mode itself flipping
   *  (I-6). It publishes whatever the text reads, at any edge, with no wait. */
  | { kind: "force"; at: number }

/** A reading, the prose its spans index, and the prose it was READ from — the same text, unless a word has
 *  been half-typed since and the reading was carried over it. */
export interface Published {
  prose: string
  reading: PhraseReading
  at: number
  read: string
}

export interface OfferState {
  /** The prose this state describes. */
  prose: string
  /** Whether it was read in the mode (`anywhere`) or out of it (`edges`). */
  mode: boolean
  /** What the screen shows: an offer outside the mode (null = dark), the reading of the text in it. */
  shown: Published | null
  /** The reading at the last publish point, whatever it was — what the glyph's hint and the dismissal's
   *  re-arm read. */
  last: Published | null
  caret: number | null
  /** The timers this state wants, as absolute deadlines (ms). A timer that fires is removed; the rest keep
   *  counting from the input that armed them. */
  wait: { rest?: number; idle?: number; hold?: number }
  /** Bumped on every step, so a timer belongs to exactly one state. */
  seq: number
}

export interface PublishOptions {
  mode: boolean
  dismissed: Dismissed
}

// ---- classifying an edit ------------------------------------------------------------------------------------

const BOUNDARY = /[\s,;:.!?)]/
/** Input types that replace text wholesale: each is a publish point whatever the caret touches. */
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
  return caret <= 0 || BOUNDARY.test(after[caret - 1] ?? "") ? "boundary" : "midword"
}

// ---- carrying a shown reading across an edit ---------------------------------------------------------------

function mapSpan(span: Span, d: { at: number; removed: number; inserted: number }, length: number): Span | undefined {
  const delta = d.inserted - d.removed
  const editEnd = d.at + d.removed
  let { start, end } = span
  // Wholly before the span — or an insertion right at its start, which leaves its words where they were.
  if (editEnd <= start && (d.at < start || d.removed === 0)) {
    start += delta
    end += delta
  } else if (d.at >= end) {
    // after the span (typing on past its end included): untouched
  } else {
    // inside it: the span grows or shrinks with the edit
    end = Math.max(start, end + delta)
  }
  if (start < 0 || end > length || end <= start) return undefined
  return { start, end }
}

/** The same reading, its spans moved to where its words are in `prose` — what the screen keeps showing while
 *  a word is half-typed. Undefined when its words are gone. */
export function carry(shown: Published | null, prose: string): Published | null {
  if (!shown) return null
  if (shown.prose === prose) return shown
  const d = diff(shown.prose, prose)
  const m = (s: Span) => mapSpan(s, d, prose.length)
  const r = shown.reading
  let reading: PhraseReading | undefined
  switch (r.kind) {
    case "exact": {
      const span = m(r.span)
      reading = span ? { ...r, span, phrase: prose.slice(span.start, span.end) } : undefined
      break
    }
    case "cue": {
      const span = m(r.span)
      const unread = m(r.unread)
      const core = r.core ? m(r.core.span) : undefined
      reading = span && unread && (!r.core || core)
        ? { ...r, span, unread, phrase: prose.slice(span.start, span.end), ...(r.core && core ? { core: { ...r.core, span: core } } : {}) }
        : undefined
      break
    }
    case "ambiguous":
    case "presence":
    case "event": {
      const span = m(r.span)
      reading = span ? { ...r, span } : undefined
      break
    }
    case "none":
      reading = r
  }
  return reading ? { prose, reading, at: shown.at, read: shown.read } : null
}

// ---- the policy --------------------------------------------------------------------------------------------

/** The two readings would draw the same ledge (kind, rule, start, a cue's unread words and core). */
export function sameReading(a: PhraseReading, b: PhraseReading): boolean {
  return readingKey(a) === readingKey(b)
}

function readingKey(r: PhraseReading): string {
  switch (r.kind) {
    case "exact":
      return `exact ${r.edge} ${r.span.start} ${r.rrule} ${r.dtstart}${r.spacing ? " spacing" : ""}`
    case "cue":
      return `cue ${r.edge} ${r.why} ${r.span.start} ${r.unread.start}-${r.unread.end}${r.core ? ` ${r.core.rrule} ${r.core.dtstart}` : ""}`
    case "ambiguous":
      return `ambiguous ${r.edge} ${r.word}`
    case "none":
      return "none"
    default:
      return `${r.kind} ${r.span.start}`
  }
}

/** An offer the box may show outside the mode: one `isScheduleOffer` lets through, at an edge the human has
 *  not dismissed (§8). */
export function visibleOffer(r: PhraseReading, dismissed: Dismissed): r is Extract<PhraseReading, { kind: "exact" | "cue" | "ambiguous" }> {
  if (!isScheduleOffer(r)) return false
  const edge = (r as { edge: string }).edge
  return !(edge === "open" ? dismissed.open : edge === "close" ? dismissed.close : false)
}

/** What the box shows, under the dismissals as they are NOW. A dismissal is not a publish point: it changes no
 *  text, so the policy's state still holds the offer it showed — and only a later publish point (the 800ms
 *  idle, a keystroke, a blur) would have taken it down. Esc and × looked like they worked only while that idle
 *  was still armed (inside 800ms of the last key); a human who paused, read the ledge and then tapped × saw
 *  nothing happen (found on the phone, where the tap row is read before it is answered, 2026-10-06). So the
 *  shown offer is filtered here, at render, by the same predicate the policy publishes with. In the mode the
 *  panel shows whatever the text reads, dismissed or not. */
export function shownUnder(shown: Published | null, mode: boolean, dismissed: Dismissed): Published | null {
  if (!shown || mode) return shown
  return visibleOffer(shown.reading, dismissed) ? shown : null
}

/** §2.4 as built: a QUALIFIER STILL BEING TYPED holds the reading it qualifies. The grammar never eats a word
 *  it has not read, so `every Monday at` and `every Monday unless` are cues whose unread words run to the end
 *  of the text; when the cue's core is exactly the reading on screen, a word boundary inside the qualifier
 *  does not change the screen — only the rest (the typing stopping) or the qualifier finishing does. */
export function holdsQualifier(shown: PhraseReading | undefined, prose: string, next: PhraseReading): boolean {
  if (next.kind !== "cue" || !next.core || next.unread.end < prose.trimEnd().length) return false
  return shown?.kind === "exact" && shown.rrule === next.core.rrule && shown.dtstart === next.core.dtstart && shown.span.start === next.core.span.start
}

function spanOf(r: PhraseReading): Span | undefined {
  return r.kind === "none" ? undefined : r.span
}

function touches(caret: number | null, span: Span | undefined): boolean {
  return caret !== null && span !== undefined && caret >= span.start && caret <= span.end
}

/** The state before anything was read: nothing shown, nothing armed. */
export function initialOfferState(prose: string, mode: boolean): OfferState {
  return { prose, mode, shown: null, last: null, caret: null, wait: {}, seq: 0 }
}

/**
 * One step of the policy: the state after `ev`, given the text as it is now (`prose`) and a way to read it.
 * `read` is called only at a publish point, so a keystroke inside a word costs no grammar at all.
 */
export function publish(prev: OfferState, prose: string, read: () => Published, ev: OfferEvent, opts: PublishOptions): OfferState {
  const caret = ev.kind === "edit" ? ev.caret : prev.caret
  const base: OfferState = { ...prev, prose, mode: opts.mode, caret, seq: prev.seq + 1 }
  // A composition is the IME's: nothing publishes, nothing is armed until it commits (a `compositionend`
  // reaches here as a wholesale edit).
  if (ev.kind === "composing") return { ...base, shown: carry(prev.shown, prose), wait: {} }
  // What stays armed: an edit re-arms the idle (and the rest, inside a word) from now; a timer that fired
  // is spent; the others keep their deadlines.
  const wait: OfferState["wait"] = ev.kind === "edit"
    ? { idle: ev.at + CLOSE_IDLE_MS, ...(ev.edit === "midword" ? { rest: ev.at + REST_MS } : {}) }
    : { ...prev.wait }
  if (ev.kind === "rest") delete wait.rest
  if (ev.kind === "idle") delete wait.idle
  delete wait.hold
  // Inside a word: the last reading stays, carried to where its words are now.
  if (ev.kind === "edit" && ev.edit === "midword") return { ...base, shown: carry(prev.shown, prose), wait }

  const now = read()
  const next: OfferState = { ...base, last: now, wait }
  const qualifierHeld = ev.kind === "edit" && ev.edit === "boundary" && holdsQualifier(prev.shown?.reading, prose, now.reading)
  if (qualifierHeld) return { ...next, shown: carry(prev.shown, prose), wait: { ...wait, rest: ev.at + REST_MS } }

  // In the mode the panel shows whatever the text reads, at any edge (§4.1).
  if (opts.mode) return { ...next, shown: now }

  const r = now.reading
  if (visibleOffer(r, opts.dismissed)) {
    const waitsForIdle = r.edge === "close" && ev.kind !== "idle" && ev.kind !== "force"
    if (!waitsForIdle) return { ...next, shown: now }
    // The close edge waits for the human to stop. A close-edge offer already showing — the same one, or the
    // one being refined (`9am` → `10am` at the end) — stays until the idle publishes the new one; anything
    // else is not on screen yet.
    if (prev.shown && sameReading(prev.shown.reading, r)) return { ...next, shown: now }
    const kept = carry(prev.shown, prose)
    if (kept && kept.reading.kind !== "none" && "edge" in kept.reading && kept.reading.edge === "close") return { ...next, shown: kept }
    return fold(prev, next, prose, ev)
  }
  return fold(prev, next, prose, ev)
}

/** Nothing to offer: the shown offer folds — after HOLD_MS while the caret is inside or touching it. */
function fold(prev: OfferState, next: OfferState, prose: string, ev: OfferEvent): OfferState {
  if (!prev.shown || ev.kind === "hold" || ev.kind === "force") return { ...next, shown: null }
  const kept = carry(prev.shown, prose)
  if (kept && touches(next.caret, spanOf(kept.reading))) return { ...next, shown: kept, wait: { ...next.wait, hold: ev.at + HOLD_MS } }
  return { ...next, shown: null }
}

// ---- dismissal ----------------------------------------------------------------------------------------------

/**
 * §8: a dismissed edge RE-ARMS when it holds no gate word at a publish point — the human deleted the phrase,
 * so "not a schedule" has nothing left to apply to. Refining `9am` to `10am`, or Monday to Tuesday, keeps a
 * gate word there and stays dismissed. (Clearing the draft and entering the mode explicitly re-arm too; those
 * are the caller's writes.)
 */
export function rearmDismissed(dismissed: Dismissed, gates: { open: boolean; close: boolean }): Dismissed {
  const open = !!dismissed.open && gates.open
  const close = !!dismissed.close && gates.close
  if (open === !!dismissed.open && close === !!dismissed.close) return dismissed
  return { ...(open ? { open: true as const } : {}), ...(close ? { close: true as const } : {}) }
}

/** The edge a dismissal applies to: the offer's own, when it is at one. */
export function dismissalEdge(r: PhraseReading | undefined): ScheduleEdge | undefined {
  if (!r || r.kind === "none" || r.kind === "presence" || r.kind === "event") return undefined
  return r.edge === "open" || r.edge === "close" ? r.edge : undefined
}

// ---- the hook -----------------------------------------------------------------------------------------------

export interface ScheduleOfferInput {
  prose: string
  exclude: readonly Span[]
  /** Schedule mode: read `anywhere`, show every reading. An input, never written here (I-3). */
  mode: boolean
  dismissed: Dismissed
  tz: string
}

export interface ScheduleOffer {
  /** What the screen shows (see `OfferState.shown`). */
  shown: Published | null
  /** The reading at the last publish point. */
  last: Published | null
  /** The dismissals as they apply now: the stored ones, less any edge that re-armed. */
  dismissed: Dismissed
  /** What the textarea did (Composer `onInputEvent`). */
  onInput: (e: BoxInputEvent) => void
  /** Read the text NOW and put it on screen — an explicit act (I-6). Returns the fresh reading; pass one
   *  just taken to publish exactly it. */
  force: (fresh?: Published) => Published
  /** Read the text now in the given scope without publishing it. */
  readNow: (mode: boolean) => Published
}

export function useScheduleOffer(input: ScheduleOfferInput): ScheduleOffer {
  const { prose, mode } = input
  const latest = useRef(input)
  latest.current = input
  const readAt = (text: string, inMode: boolean): Published => {
    const at = Date.now()
    const { exclude, tz } = latest.current
    return { prose: text, at, read: text, reading: readSchedulePhrase(text, { nowMs: at, tz, scope: inMode ? "anywhere" : "edges", exclude }) }
  }
  const options = (): PublishOptions => {
    const cur = latest.current
    return { mode: cur.mode, dismissed: cur.dismissed }
  }
  const pendingInput = useRef<Extract<BoxInputEvent, { type: "edit" }> | null>(null)

  // A text already in the box when it mounts (a reload, a remount, the `c` dialog over a page box) is
  // published at once, as a paste would be.
  const [state, setState] = useState<OfferState>(() => {
    const first = initialOfferState(prose, mode)
    return prose ? publish(first, prose, () => readAt(prose, mode), { kind: "edit", edit: "wholesale", caret: null, at: Date.now() }, { mode, dismissed: input.dismissed }) : first
  })

  // DERIVED during render: a new text (or a mode flip) steps the policy here, with what the textarea said it
  // did — or, for a text that changed from somewhere else (another box on the draft, an Undo, a clear), as
  // a wholesale change.
  let current = state
  if (state.prose !== prose || state.mode !== mode) {
    const meta = pendingInput.current
    pendingInput.current = null
    const at = Date.now()
    const ev: OfferEvent = state.mode !== mode
      ? { kind: "force", at }
      : meta && meta.prose === prose
        ? meta.composing ? { kind: "composing", at } : { kind: "edit", edit: classifyEdit(state.prose, prose, meta.caret, meta.inputType), caret: meta.caret, at }
        : { kind: "edit", edit: "wholesale", caret: null, at }
    current = publish(state, prose, () => readAt(prose, mode), ev, { mode, dismissed: input.dismissed })
    setState(current)
  }

  // The timers — this hook's only effects.
  const { seq, wait } = current
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = []
    const fire = (kind: "rest" | "idle" | "hold") => () =>
      setState((s) => (s.seq !== seq ? s : publish(s, s.prose, () => readAt(s.prose, s.mode), { kind, at: Date.now() }, options())))
    for (const kind of ["rest", "idle", "hold"] as const) {
      const deadline = wait[kind]
      if (deadline !== undefined) timers.push(setTimeout(fire(kind), Math.max(0, deadline - Date.now())))
    }
    return () => timers.forEach(clearTimeout)
  }, [seq])

  const gates = current.last ? scheduleEdgeGates(current.last.prose, input.exclude) : { open: false, close: false }
  const dismissed = current.last ? rearmDismissed(input.dismissed, gates) : input.dismissed

  return {
    shown: shownUnder(current.shown, mode, dismissed),
    last: current.last,
    dismissed,
    onInput: (e) => {
      if (e.type === "edit") {
        pendingInput.current = e
        return
      }
      const at = Date.now()
      const ev: OfferEvent = e.type === "blur" ? { kind: "blur", at } : { kind: "edit", edit: "wholesale", caret: e.caret, at }
      setState((s) => publish(s, s.prose, () => readAt(s.prose, s.mode), ev, options()))
    },
    force: (given) => {
      const fresh = given ?? readAt(latest.current.prose, latest.current.mode)
      setState((s) => publish(s, fresh.prose, () => fresh, { kind: "force", at: fresh.at }, options()))
      return fresh
    },
    readNow: (inMode) => readAt(latest.current.prose, inMode),
  }
}
