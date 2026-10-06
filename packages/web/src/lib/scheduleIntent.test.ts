// plans/schedule-live-reading.md §15.1 `scheduleIntent.test.ts`: the §7 key matrix transcribed row by row,
// and the three safety properties held over every state × every key —
//   I-1  mode off ⇒ no key creates;
//   I-2  mode on ⇒ no key dispatches or saves lazily;
//   I-3  `mode.on` changes only on the explicit acts.
// The Tab predicate's precedence (menu open, selection, IME, Shift) is pinned in composerKeyboard.test.ts.
import assert from "node:assert/strict"
import test from "node:test"
import {
  MODE_OFF_ACTIONS,
  MODE_ON_ACTIONS,
  SCHEDULE_KEYS,
  SCHEDULE_STATES,
  draftAfter,
  inMode,
  keyAction,
  sendGlyphOf,
  type ScheduleAction,
  type ScheduleDraftRecord,
  type ScheduleKey,
  type ScheduleUiState,
} from "./scheduleIntent.ts"

// The spec's table, copied by hand (not from the implementation), one row per state. Columns, in the spec's
// order: Enter/Send · ⌘↵ · ⌘⇧↵/snail · ⌘⌥↵/glyph/ledge Schedule · Tab · Esc · ledge ×. "—" (no ledge ×) is
// "noop". M4's Enter is split by whether the text changed since the answer.
const MATRIX: [string, ScheduleUiState, ScheduleAction[]][] = [
  ["S0 dark", { name: "S0" }, ["dispatch", "dispatch", "lazy", "enter-mode", "native", "blur", "noop"]],
  ["S1 offer, exact", { name: "S1" }, ["dispatch", "dispatch", "lazy", "accept", "accept", "dismiss", "dismiss"]],
  ["S2 offer, cue", { name: "S2" }, ["dispatch", "dispatch", "lazy", "accept", "accept", "dismiss", "dismiss"]],
  ["S3 offer, ambiguous", { name: "S3" }, ["dispatch", "dispatch", "lazy", "enter-mode", "native", "dismiss", "dismiss"]],
  ["M1 ready", { name: "M1" }, ["create", "create", "noop-flash", "leave", "native", "leave-dismiss", "noop"]],
  ["M2 reading", { name: "M2" }, ["nudge", "nudge", "noop-flash", "leave", "native", "leave-dismiss", "noop"]],
  ["M3 disagree", { name: "M3" }, ["nudge", "nudge", "noop-flash", "leave", "native", "leave-dismiss", "noop"]],
  ["M4 refused, text unchanged", { name: "M4", changed: false }, ["nudge", "nudge", "noop-flash", "leave", "native", "leave-dismiss", "noop"]],
  ["M4 refused, text changed", { name: "M4", changed: true }, ["read", "read", "noop-flash", "leave", "native", "leave-dismiss", "noop"]],
  ["M5 empty", { name: "M5" }, ["noop", "noop", "noop", "leave", "native", "leave", "noop"]],
  ["M creating", { name: "creating" }, ["noop", "noop", "noop", "noop", "native", "noop", "noop"]],
]
const COLUMNS: ScheduleKey[] = ["enter", "mod-enter", "lazy", "schedule", "tab", "esc", "close"]

test("§7: the key matrix, row by row", () => {
  assert.deepEqual(COLUMNS, [...SCHEDULE_KEYS], "the columns are every key the matrix knows")
  assert.equal(MATRIX.length, SCHEDULE_STATES.length, "every state has a row")
  for (const [label, state, row] of MATRIX) {
    COLUMNS.forEach((key, i) => assert.equal(keyAction(state, key), row[i], `${label} × ${key}`))
  }
})

test("⌘↵ is Enter in every state (muscle memory reaching for submit never leaks out of the mode)", () => {
  for (const state of SCHEDULE_STATES) assert.equal(keyAction(state, "mod-enter"), keyAction(state, "enter"), state.name)
})

test("I-1: outside the mode, no key creates a schedule", () => {
  for (const state of SCHEDULE_STATES.filter((s) => !inMode(s))) {
    for (const key of SCHEDULE_KEYS) assert.notEqual(keyAction(state, key), "create", `${state.name} × ${key}`)
  }
})

test("I-2: inside the mode, no key dispatches or saves lazily", () => {
  for (const state of SCHEDULE_STATES.filter(inMode)) {
    for (const key of SCHEDULE_KEYS) {
      const action = keyAction(state, key)
      assert.ok(action !== "dispatch" && action !== "lazy", `${state.name} × ${key} → ${action}`)
    }
  }
})

test("I-3: mode.on changes only through an explicit act — Tab on an offer, the glyph/⌘⌥↵/ledge Schedule, Esc/Cancel", () => {
  const drafts: ScheduleDraftRecord[] = [
    { v: 1, on: false, dismissed: {} },
    { v: 1, on: false, dismissed: { open: true } },
    { v: 1, on: true, dismissed: {} },
    { v: 1, on: true, dismissed: { close: true } },
  ]
  for (const state of SCHEDULE_STATES) {
    for (const key of SCHEDULE_KEYS) {
      const action = keyAction(state, key)
      for (const draft of drafts.filter((d) => d.on === inMode(state) || state.name === "creating" && d.on)) {
        for (const edge of [undefined, "open", "close"] as const) {
          const after = draftAfter(action, draft, edge)
          if (after.on === draft.on) continue
          // It flipped: only an explicit act may do that, and only through the keys that ARE explicit acts.
          if (after.on) {
            assert.ok(MODE_ON_ACTIONS.has(action), `${state.name} × ${key} → ${action} turned the mode on`)
            assert.ok(key === "tab" || key === "schedule", `${state.name}: the mode turned on from ${key}`)
          } else {
            assert.ok(MODE_OFF_ACTIONS.has(action), `${state.name} × ${key} → ${action} turned the mode off`)
            assert.ok(key === "esc" || key === "schedule", `${state.name}: the mode turned off from ${key}`)
          }
        }
      }
    }
  }
  // And the converse: every on/off action really is a flip from where it is offered.
  assert.equal(draftAfter("accept", { v: 1, on: false, dismissed: {} }).on, true)
  assert.equal(draftAfter("enter-mode", { v: 1, on: false, dismissed: {} }).on, true)
  assert.equal(draftAfter("leave", { v: 1, on: true, dismissed: {} }).on, false)
  assert.equal(draftAfter("leave-dismiss", { v: 1, on: true, dismissed: {} }).on, false)
})

test("no action other than the explicit acts writes the draft's record at all", () => {
  const draft: ScheduleDraftRecord = { v: 1, on: true, dismissed: { open: true } }
  for (const action of ["dispatch", "lazy", "native", "blur", "create", "read", "nudge", "noop-flash", "noop"] as const) {
    assert.equal(draftAfter(action, draft, "close"), draft, action)
  }
})

test("§8: entering explicitly re-arms every edge; Esc in the mode leaves AND dismisses its edge in one press", () => {
  assert.deepEqual(draftAfter("enter-mode", { v: 1, on: false, dismissed: { open: true, close: true } }), { v: 1, on: true, dismissed: {} })
  assert.deepEqual(draftAfter("leave-dismiss", { v: 1, on: true, dismissed: {} }, "open"), { v: 1, on: false, dismissed: { open: true } })
  assert.deepEqual(draftAfter("leave-dismiss", { v: 1, on: true, dismissed: { close: true } }, "open"), { v: 1, on: false, dismissed: { open: true, close: true } })
  // A plain leave (the glyph, ⌘⌥↵) dismisses nothing.
  assert.deepEqual(draftAfter("leave", { v: 1, on: true, dismissed: {} }), { v: 1, on: false, dismissed: {} })
  assert.deepEqual(draftAfter("dismiss", { v: 1, on: false, dismissed: {} }, "close"), { v: 1, on: false, dismissed: { close: true } })
  // With no edge to dismiss (a mid-text reading), nothing is set.
  assert.deepEqual(draftAfter("dismiss", { v: 1, on: false, dismissed: {} }), { v: 1, on: false, dismissed: {} })
})

test("Tab accepts only on an acceptable offer (S1, S2); everywhere else it is the browser's", () => {
  for (const state of SCHEDULE_STATES) {
    const expected = state.name === "S1" || state.name === "S2" ? "accept" : "native"
    assert.equal(keyAction(state, "tab"), expected, state.name)
  }
})

test("Esc is claimed exactly where the schedule has something to undo with it", () => {
  // At rest it blurs the box (the next Esc unwinds a drawer); a create in flight swallows it.
  for (const state of SCHEDULE_STATES) {
    const action = keyAction(state, "esc")
    if (state.name === "S0") assert.equal(action, "blur")
    else if (state.name === "creating") assert.equal(action, "noop")
    else assert.ok(["dismiss", "leave", "leave-dismiss"].includes(action), `${state.name} → ${action}`)
  }
})

test("I-5: the send glyph and Enter's act never disagree — the arrow exactly where Enter dispatches", () => {
  for (const state of SCHEDULE_STATES) {
    const dispatches = keyAction(state, "enter") === "dispatch"
    assert.equal(sendGlyphOf(state), dispatches ? "send" : "schedule", state.name)
    assert.equal(keyAction(state, "mod-enter") === "dispatch", dispatches, `${state.name}: ⌘↵ agrees too`)
  }
})
