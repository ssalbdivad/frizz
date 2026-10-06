// WHAT EVERY KEY DOES, IN EVERY STATE OF THE PROMPT BOX'S SCHEDULE READING (plans/schedule-live-reading.md §7).
//
// This table is the single source. The Composer and PromptForm do not decide what Enter means — they ask
// `keyAction(state, key)` and execute the answer — so the safety properties are properties of one pure
// function, and `scheduleIntent.test.ts` holds them over every state × every key:
//
//   I-1  outside the mode nothing creates a schedule;
//   I-2  inside the mode nothing dispatches or saves lazily;
//   I-3  the mode turns on only through an explicit act (Tab on an offer, ⌘⌥↵, the glyph, the ledge's
//        Schedule) and off only through one (Esc, ⌘⌥↵, the glyph, Cancel) — no reading, timer or answer.
//
// The states (§5): S0 dark, S1–S3 an offer on screen (exact, cue, ambiguous), M1–M5 the mode (ready,
// reading, disagree, refused, empty) and the instant a create is in flight.

export type ScheduleUiState =
  | { name: "S0" }
  | { name: "S1" }
  | { name: "S2" }
  | { name: "S3" }
  | { name: "M1" }
  | { name: "M2" }
  | { name: "M3" }
  /** Refused or blocked. `changed`: the text changed since the answer on screen, so Enter reads it again. */
  | { name: "M4"; changed: boolean }
  | { name: "M5" }
  | { name: "creating" }

export type ScheduleStateName = ScheduleUiState["name"]

/** Every key or button that reaches the matrix. Buttons are named by the key they stand for. */
export type ScheduleKey =
  /** Enter, or a click on Send / Create schedule. */
  | "enter"
  /** ⌘/Ctrl-Enter. */
  | "mod-enter"
  /** ⌘/Ctrl-Shift-Enter, or the snail. */
  | "lazy"
  /** ⌘/Ctrl-Option-Enter, the rail glyph, or the ledge's Schedule button. */
  | "schedule"
  | "tab"
  /** Escape, or the panel's Esc Cancel. */
  | "esc"
  /** The ledge's ×. */
  | "close"

export type ScheduleAction =
  /** Start the thread now — the caller's ordinary send. */
  | "dispatch"
  /** Save it as a lazy thread — the caller's. */
  | "lazy"
  /** The key keeps its ordinary meaning (Tab moves focus). */
  | "native"
  /** Escape at rest: the box's own blur. */
  | "blur"
  /** Into the mode from an offer, reading the text again now (a cue's words then go to the model). */
  | "accept"
  /** Into the mode with no offer on screen (the glyph over dark text, or an ambiguous word): read it now. */
  | "enter-mode"
  /** Out of the mode. */
  | "leave"
  /** Out of the mode, and the edge it was read at is dismissed, in one press. */
  | "leave-dismiss"
  /** Put the offer away for this edge of this draft. */
  | "dismiss"
  /** Create what is on screen (T3: read again first; a different reading creates nothing). */
  | "create"
  /** Read the text again now — locally, then the model if it must. */
  | "read"
  /** Nothing to do yet: Create shakes. */
  | "nudge"
  /** Consumed; the panel's Esc Cancel flashes, saying how to leave. */
  | "noop-flash"
  | "noop"

export const SCHEDULE_KEYS: readonly ScheduleKey[] = ["enter", "mod-enter", "lazy", "schedule", "tab", "esc", "close"]

export const SCHEDULE_STATES: readonly ScheduleUiState[] = [
  { name: "S0" },
  { name: "S1" },
  { name: "S2" },
  { name: "S3" },
  { name: "M1" },
  { name: "M2" },
  { name: "M3" },
  { name: "M4", changed: false },
  { name: "M4", changed: true },
  { name: "M5" },
  { name: "creating" },
]

/** Whether the state is schedule mode (every M state, and a create in flight). */
export function inMode(state: ScheduleUiState): boolean {
  return state.name.startsWith("M") || state.name === "creating"
}

/** The §7 matrix, row by row. */
export function keyAction(state: ScheduleUiState, key: ScheduleKey): ScheduleAction {
  switch (state.name) {
    case "S0":
      return ({ enter: "dispatch", "mod-enter": "dispatch", lazy: "lazy", schedule: "enter-mode", tab: "native", esc: "blur", close: "noop" } as const)[key]
    case "S1":
    case "S2":
      return ({ enter: "dispatch", "mod-enter": "dispatch", lazy: "lazy", schedule: "accept", tab: "accept", esc: "dismiss", close: "dismiss" } as const)[key]
    case "S3":
      // Nothing to accept: an ambiguous word has no reading. The glyph still enters the mode, which shows
      // the word's copy; Tab moves focus.
      return ({ enter: "dispatch", "mod-enter": "dispatch", lazy: "lazy", schedule: "enter-mode", tab: "native", esc: "dismiss", close: "dismiss" } as const)[key]
    case "M1":
      return ({ enter: "create", "mod-enter": "create", lazy: "noop-flash", schedule: "leave", tab: "native", esc: "leave-dismiss", close: "noop" } as const)[key]
    case "M2":
    case "M3":
      return ({ enter: "nudge", "mod-enter": "nudge", lazy: "noop-flash", schedule: "leave", tab: "native", esc: "leave-dismiss", close: "noop" } as const)[key]
    case "M4": {
      const enter = state.changed ? "read" : "nudge"
      return ({ enter, "mod-enter": enter, lazy: "noop-flash", schedule: "leave", tab: "native", esc: "leave-dismiss", close: "noop" } as const)[key]
    }
    case "M5":
      return ({ enter: "noop", "mod-enter": "noop", lazy: "noop", schedule: "leave", tab: "native", esc: "leave", close: "noop" } as const)[key]
    case "creating":
      return ({ enter: "noop", "mod-enter": "noop", lazy: "noop", schedule: "noop", tab: "native", esc: "noop", close: "noop" } as const)[key]
  }
}

/** I-5: the send button wears what Enter does — the repeat glyph wherever Enter creates (or would, once the
 *  reading is ready) and never dispatches, the arrow wherever Enter starts the thread. */
export function sendGlyphOf(state: ScheduleUiState): "send" | "schedule" {
  return inMode(state) ? "schedule" : "send"
}

/** The actions that turn the mode on, and those that turn it off (I-3). Nothing else writes `mode.on`
 *  except a successful create and a draft clear, which clear the whole draft. */
export const MODE_ON_ACTIONS: ReadonlySet<ScheduleAction> = new Set(["accept", "enter-mode"])
export const MODE_OFF_ACTIONS: ReadonlySet<ScheduleAction> = new Set(["leave", "leave-dismiss"])

/** The mode's record in the draft (lib/scheduleDraftState.ts `ScheduleDraftState`). */
export type ScheduleDraftRecord = { v: 1; on: boolean; dismissed: { open?: true; close?: true } }

/**
 * What an action does to the draft's mode record — the ONLY writes the keys make to it. Entering the mode
 * explicitly re-arms every edge (§8); leaving with Esc dismisses the edge it was read at; a dismissal sets its
 * edge. Every other action leaves the record exactly as it was, which is I-3 stated as data:
 * `scheduleIntent.test.ts` holds `draftAfter(keyAction(s, k), d).on !== d.on` only for an explicit act.
 */
export function draftAfter(action: ScheduleAction, prev: ScheduleDraftRecord, edge?: "open" | "close"): ScheduleDraftRecord {
  switch (action) {
    case "accept":
    case "enter-mode":
      return { v: 1, on: true, dismissed: {} }
    case "leave":
      return { ...prev, on: false }
    case "leave-dismiss":
      return { ...prev, on: false, dismissed: edge ? { ...prev.dismissed, [edge]: true } : prev.dismissed }
    case "dismiss":
      return edge ? { ...prev, dismissed: { ...prev.dismissed, [edge]: true } } : prev
    default:
      return prev
  }
}
