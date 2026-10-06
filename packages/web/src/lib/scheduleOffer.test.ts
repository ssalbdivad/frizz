// plans/schedule-live-reading.md §15.1 `scheduleOffer.test.ts`: the prompt box's publish policy, driven with the
// REAL grammar at the spec's clock and a simulated one for the timers — boundary, the 250ms rest, the 800ms
// close edge, the reading held mid-word, the 400ms hold, IME — and dismissal per edge: it sticks through a
// refinement and a day change, re-arms on an edge with no gate word, clears with the draft, and the glyph
// overrides it. Plus I-3 at the source: this file imports no setter of the mode.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { readSchedulePhrase, scheduleEdgeGates, type PhraseReading } from "@frizz/shared"
import {
  CLOSE_IDLE_MS,
  HOLD_MS,
  REST_MS,
  carry,
  classifyEdit,
  initialOfferState,
  publish,
  rearmDismissed,
  shownUnder,
  visibleOffer,
  type Dismissed,
  type OfferEvent,
  type OfferState,
  type Published,
} from "./scheduleOffer.ts"
import { DraftStore, draftKey } from "./drafts.ts"
import { clearDispatchDraft, readScheduleDraftState, writeScheduleDraftState } from "./scheduleDraftState.ts"
import { draftAfter } from "./scheduleIntent.ts"

const NY = "America/New_York"
// Mon Oct 5 2026, 2:32pm in New York — the spec's clock.
const NOW = Date.parse("2026-10-05T14:32:00-04:00")

/** A box: the policy's state, a clock, the timers firing in deadline order — the hook without React. */
class Box {
  state: OfferState
  t = NOW
  mode: boolean
  dismissed: Dismissed = {}
  /** Every publish step, for counting what the screen showed. */
  log: { prose: string; shown: string; ev: OfferEvent["kind"] }[] = []
  constructor(text = "", mode = false) {
    this.mode = mode
    this.state = initialOfferState(text, mode)
  }
  read = (text: string) => (): Published => ({ prose: text, read: text, at: this.t, reading: readSchedulePhrase(text, { nowMs: NOW, tz: NY, scope: this.mode ? "anywhere" : "edges" }) })
  private apply(prose: string, ev: OfferEvent) {
    this.state = publish(this.state, prose, this.read(prose), ev, { mode: this.mode, dismissed: this.dismissed })
    this.log.push({ prose, shown: this.shownLine(), ev: ev.kind })
  }
  /** The text becomes `next` by one edit. */
  edit(next: string, opts: { inputType?: string; caret?: number; composing?: boolean } = {}) {
    const caret = opts.caret ?? next.length
    if (opts.composing) this.apply(next, { kind: "composing", at: this.t })
    else this.apply(next, { kind: "edit", edit: classifyEdit(this.state.prose, next, caret, opts.inputType), caret, at: this.t })
  }
  /** Type `text` at the end, one key every `every` ms (timers fire in between, as they would). */
  type(text: string, every = 80) {
    for (const ch of text) {
      this.advance(every)
      this.edit(this.state.prose + ch)
    }
  }
  backspace(n = 1, every = 80) {
    for (let i = 0; i < n; i++) {
      this.advance(every)
      this.edit(this.state.prose.slice(0, -1), { inputType: "deleteContentBackward" })
    }
  }
  /** Let `ms` pass, firing every timer that falls due, in order. */
  advance(ms: number) {
    const end = this.t + ms
    for (;;) {
      const due = (Object.entries(this.state.wait) as ["rest" | "idle" | "hold", number][]).filter(([, at]) => at <= end).sort((a, b) => a[1] - b[1])[0]
      if (!due) break
      this.t = due[1]
      this.apply(this.state.prose, { kind: due[0], at: this.t })
    }
    this.t = end
  }
  blur() {
    this.apply(this.state.prose, { kind: "blur", at: this.t })
  }
  get shown(): PhraseReading | undefined {
    return this.state.shown?.reading
  }
  /** What the screen shows, as one line: kind, edge, the marked words, the rule and what is dim. */
  shownLine(): string {
    const s = this.state.shown
    if (!s) return "dark"
    const r = s.reading
    if (r.kind === "exact") return `exact ${r.edge} «${s.prose.slice(r.span.start, r.span.end)}» ${r.rrule}${r.assumed.map((a) => ` ~${a.part}`).join("")}`
    if (r.kind === "cue") return `cue ${r.edge} «${s.prose.slice(r.span.start, r.span.end)}» unread «${s.prose.slice(r.unread.start, r.unread.end)}»`
    if (r.kind === "ambiguous") return `ambiguous ${r.edge} ${r.word}`
    return r.kind
  }
}

test("classifyEdit: a word ends at whitespace or punctuation, a paste is wholesale, anything else is mid-word", () => {
  assert.equal(classifyEdit("every Monday", "every Monday ", 13), "boundary")
  assert.equal(classifyEdit("every Monday", "every Monday,", 13), "boundary")
  assert.equal(classifyEdit("every Mon", "every Mond", 10), "midword")
  assert.equal(classifyEdit("", "e", 1), "midword")
  assert.equal(classifyEdit("every Monday at 9am", "every Monday at 9a", 18), "midword", "deleting into a word")
  assert.equal(classifyEdit("every Monday x", "every Monday ", 13), "boundary", "deleting back to a space")
  assert.equal(classifyEdit("x", "", 0), "boundary", "an emptied box")
  assert.equal(classifyEdit("", "every Monday at 9am triage", 26), "wholesale", "several characters at once")
  assert.equal(classifyEdit("every Monday", "every Tuesday", 13), "wholesale", "a replacement")
  assert.equal(classifyEdit("every Mon", "every Mond", 10, "insertFromPaste"), "wholesale")
  assert.equal(classifyEdit("every Mond", "every Mon", 9, "historyUndo"), "wholesale")
})

test("§0.1 storyboard: nothing mid-word, the offer at the space after Monday, 9am solid at the next word", () => {
  const box = new Box()
  box.type("every")
  assert.equal(box.shownLine(), "dark", "`every` alone: a gate word with no reading")
  box.type(" Mon")
  assert.equal(box.shownLine(), "dark", "`every Mon`: mid-word is never read")
  box.type("day")
  assert.equal(box.shownLine(), "dark", "`every Monday`, the caret still in the word")
  box.type(" ")
  assert.equal(box.shownLine(), "exact open «every Monday» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 ~time", "the space publishes it, 9am dim")
  box.type("at 9")
  assert.equal(box.shownLine(), "exact open «every Monday» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 ~time", "held through `at` (a qualifier being typed) and the half-typed `9`")
  box.type("am ")
  assert.equal(box.shownLine(), "exact open «every Monday at 9am» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0", "the span grows; 9am is no longer assumed")
  const before = box.state.shown
  box.type("triage new issues")
  assert.equal(box.shownLine(), "exact open «every Monday at 9am» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0", "nothing changes while the task is typed")
  assert.equal(box.state.shown?.reading.kind, before?.reading.kind)
})

test("typing stability: at most 4 published changes, none from a mid-word prefix, the last boundary shows the last reading", () => {
  for (const text of [
    "every Monday at 9am triage new issues",
    "weekdays at 8:30 summarize PRs",
    "every other Friday at 4pm write the changelog",
    "every 2 hours on weekdays from 9 to 5 check CI",
    "on the 1st and 15th review billing",
    "every Monday at 9am for the next 4 weeks, check the migration dashboards",
    "the last Friday of the month at 4pm, write the retro doc",
    "every Monday unless it's a holiday post the digest",
  ]) {
    const box = new Box()
    box.type(text)
    const changes: string[] = []
    let last = "dark"
    for (const step of box.log) {
      if (step.shown === last) continue
      // A change reaches the screen only at a publish point: never from an edit inside a word.
      const endsWord = /[\s,;:.!?)]$/.test(step.prose)
      assert.ok(step.ev !== "edit" || endsWord, `${text}: «${step.prose}» changed the screen mid-word (${step.shown})`)
      changes.push(step.shown)
      last = step.shown
    }
    assert.ok(changes.length <= 4, `${text}: ${changes.length} changes\n  ${changes.join("\n  ")}`)
    box.advance(1000)
    const final = new Box(text)
    final.edit(text, { inputType: "insertFromPaste" })
    final.state = publish(initialOfferState("", false), text, final.read(text), { kind: "edit", edit: "wholesale", caret: text.length, at: NOW }, { mode: false, dismissed: {} })
    assert.equal(box.shownLine(), final.shownLine(), `${text}: after the rest the screen shows the text's own reading`)
  }
})

test("negatives never offer at any prefix", () => {
  for (const text of [
    "every time the build fails, fix it",
    "fix the daily digest email",
    "tomorrow at 8 run the migration",
    "go until 10am tomorrow",
    "add a GitHub Action that runs the tests every Monday at 9am",
    "each PR needs a changelog entry",
  ]) {
    const box = new Box()
    box.type(text)
    box.advance(2000)
    for (const step of box.log) assert.equal(step.shown, "dark", `${text}: «${step.prose}» showed ${step.shown}`)
  }
})

test("REST_MS: an open-edge phrase with the caret inside a word publishes after the rest, not before", () => {
  const box = new Box()
  box.type("every Monday")
  assert.equal(box.shownLine(), "dark")
  box.advance(REST_MS - 10)
  assert.equal(box.shownLine(), "dark", "not yet")
  box.advance(20)
  assert.match(box.shownLine(), /^exact open «every Monday»/, "the rest publishes it")
})

test("CLOSE_IDLE_MS: a close-edge phrase waits for the human to stop, even after a boundary", () => {
  const box = new Box()
  box.type("triage new issues every Monday at 9am")
  box.advance(REST_MS + 50)
  assert.equal(box.shownLine(), "dark", "the rest is not enough at the close edge")
  box.type(" ")
  box.advance(700)
  assert.equal(box.shownLine(), "dark", "no ledge at 700ms")
  box.advance(120)
  assert.equal(box.shownLine(), "exact close «every Monday at 9am» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0", "a ledge at 800ms")
  // Typing on: the phrase no longer ends the text, and the offer goes at the next word.
  box.type("and label the dupes ")
  assert.equal(box.shownLine(), "dark")
})

test("a close-edge refinement keeps the old offer until the idle shows the new one — no flicker to dark", () => {
  const box = new Box()
  box.type("triage new issues every Monday at 9am")
  box.advance(CLOSE_IDLE_MS + 10)
  assert.match(box.shownLine(), /BYHOUR=9;/)
  box.backspace(3)
  box.type("10am")
  assert.match(box.shownLine(), /BYHOUR=9;/, "the old reading stays while 10am is typed")
  box.advance(CLOSE_IDLE_MS + 10)
  assert.match(box.shownLine(), /^exact close «every Monday at 10am» .*BYHOUR=10;/)
})

test("mid-word the last reading stays, carried over the edit", () => {
  const box = new Box()
  box.type("every Monday at 9am triage ")
  box.backspace(1)
  box.type("d")
  assert.equal(box.shownLine(), "exact open «every Monday at 9am» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0")
  // An edit BEFORE the phrase moves its span with it.
  const s = box.state.shown!
  const moved = carry(s, `> ${s.prose}`)
  assert.equal(moved && moved.reading.kind === "exact" ? moved.prose.slice(moved.reading.span.start, moved.reading.span.end) : "", "every Monday at 9am")
  assert.equal(moved?.read, s.read, "a carried reading remembers the text it was read from")
  // Words that are gone carry nothing.
  assert.equal(carry(s, ""), null)
})

test("HOLD_MS: an offer whose words go is held while the caret touches them, then folds; elsewhere it folds at once", () => {
  const box = new Box()
  box.type("every Monday at 9am triage new issues")
  assert.match(box.shownLine(), /^exact open/)
  // Select `Monday` and start retyping it: `every T…` reads as nothing, but the caret is inside the old span.
  box.advance(100)
  box.edit("every T at 9am triage new issues", { caret: 7 })
  assert.match(box.shownLine(), /^exact open «every T at 9am»/, "held: the caret is in the old span, which shrank with the edit")
  assert.ok(box.state.wait.hold !== undefined)
  box.advance(HOLD_MS - 20)
  assert.match(box.shownLine(), /^exact open/, "still held")
  box.advance(40)
  assert.equal(box.shownLine(), "dark", "folded after the hold")

  const far = new Box()
  far.type("every Monday at 9am triage new issues")
  far.advance(100)
  // A paste replacing everything with the caret at the end, far from the old span.
  far.edit("please look at the flaky tests in CI", { inputType: "insertFromPaste" })
  assert.equal(far.shownLine(), "dark", "folds at once")
})

test("nothing publishes during an IME composition; its commit does", () => {
  const box = new Box()
  box.type("every Monday at 9am ")
  const shown = box.shownLine()
  box.advance(80)
  box.edit("every Monday at 9am と", { composing: true })
  box.advance(80)
  box.edit("every Monday at 9am とり", { composing: true })
  assert.equal(box.shownLine(), shown, "the reading is carried, nothing re-read")
  assert.deepEqual(box.state.wait, {}, "and no timer is armed by a composition")
  box.advance(80)
  // compositionend reaches the policy as a wholesale edit.
  box.state = publish(box.state, "every Monday at 9am 取り", box.read("every Monday at 9am 取り"), { kind: "edit", edit: "wholesale", caret: 22, at: box.t }, { mode: false, dismissed: {} })
  assert.match(box.shownLine(), /^exact open «every Monday at 9am»/)
})

test("the box blurring publishes an open-edge phrase whose last word was never ended", () => {
  const box = new Box()
  box.type("every Monday")
  box.blur()
  assert.match(box.shownLine(), /^exact open «every Monday»/)
})

test("in the mode every reading shows, at any edge, at the boundary — no close-edge wait, no offer filter", () => {
  const box = new Box("", true)
  box.type("triage new issues every Monday at 9am ")
  assert.match(box.shownLine(), /^exact close «every Monday at 9am»/, "a close edge shows at the boundary in the mode")
  const mid = new Box("", true)
  mid.type("please list every Friday release from the changelog ")
  assert.match(mid.shownLine(), /^exact inside «every Friday»/, "the mode reads anywhere")
  const event = new Box("", true)
  event.type("every time the build fails, fix it ")
  assert.equal(event.state.shown?.reading.kind, "event", "an event shows too — as the panel's local refusal")
})

test("a forced read (an explicit act) shows whatever the text reads, at once, at any edge", () => {
  const box = new Box()
  box.type("triage new issues every Monday at 9am")
  assert.equal(box.shownLine(), "dark")
  const text = box.state.prose
  box.state = publish(box.state, text, box.read(text), { kind: "force", at: box.t }, { mode: false, dismissed: {} })
  assert.match(box.shownLine(), /^exact close/)
})

test("§8 dismissal: per edge; sticks through a refinement and a day change; re-arms when the edge holds no gate word", () => {
  const box = new Box()
  box.type("every Monday at 9am triage new issues")
  const r = box.shown!
  assert.ok(visibleOffer(r, {}))
  assert.equal(visibleOffer(r, { open: true }), false, "dismissed at its edge")
  assert.ok(visibleOffer(r, { close: true }), "a dismissal at the OTHER edge does not reach it")

  // The human dismisses the open edge, then refines 9am → 10am and Monday → Tuesday: still dark.
  box.dismissed = { open: true }
  const prose = box.state.prose
  for (const next of [prose.replace("9am", "10am"), prose.replace("9am", "10am").replace("Monday", "Tuesday")]) {
    box.advance(100)
    box.edit(next, { inputType: "insertReplacementText" })
    box.advance(1000)
    assert.equal(box.shownLine(), "dark", next)
    const gates = scheduleEdgeGates(next)
    assert.deepEqual(rearmDismissed(box.dismissed, gates), { open: true }, `${next}: a gate word is still there, so it stays dismissed`)
  }
  // Delete the phrase: the open edge holds no gate word, and the dismissal re-arms.
  const gone = "triage new issues"
  assert.deepEqual(rearmDismissed({ open: true }, scheduleEdgeGates(gone)), {})
  // …while a close-edge dismissal, in a sentence that still holds its phrase, stays. (One sentence is both
  // windows, so it would keep both.)
  assert.deepEqual(rearmDismissed({ open: true, close: true }, scheduleEdgeGates("Triage new issues. Do it every Monday at 9am")), { close: true })
  assert.deepEqual(rearmDismissed({ open: true, close: true }, scheduleEdgeGates("triage new issues every Monday at 9am")), { open: true, close: true })
  // The same object back when nothing re-arms, so a caller can compare by identity.
  const d = { open: true as const }
  assert.equal(rearmDismissed(d, { open: true, close: false }), d)
})

test("§8 dismissal clears with the draft, and entering the mode explicitly (the glyph) overrides it", () => {
  const memory = new Map<string, string>()
  const store = new DraftStore({ getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => void memory.set(k, v) })
  const key = draftKey.dispatchSchedule("/repo")
  writeScheduleDraftState(key, { v: 1, on: false, dismissed: { open: true } }, store)
  assert.deepEqual(readScheduleDraftState(key, store).dismissed, { open: true })
  clearDispatchDraft("/repo", {}, store)
  assert.deepEqual(readScheduleDraftState(key, store).dismissed, {}, "a cleared draft re-arms every edge")
  writeScheduleDraftState(key, { v: 1, on: false, dismissed: { open: true, close: true } }, store)
  writeScheduleDraftState(key, (prev) => draftAfter("enter-mode", prev), store)
  assert.deepEqual(readScheduleDraftState(key, store), { v: 1, on: true, dismissed: {} }, "the glyph re-arms them")
})

test("I-3 at the source: the publish policy imports no setter of the mode and writes no `on`", () => {
  const source = readFileSync(new URL("./scheduleOffer.ts", import.meta.url), "utf8")
  const imports = [...source.matchAll(/^import[^\n]*$/gm)].map((m) => m[0])
  for (const line of imports) {
    assert.doesNotMatch(line, /scheduleDraftState|drafts\.ts|writeScheduleDraftState|useScheduleDraftState|setMode|draftAfter|scheduleIntent/, line)
  }
  assert.doesNotMatch(source, /\bon\s*:\s*true\b|\.on\s*=(?!=)/, "no write of the mode's `on`")
  assert.doesNotMatch(source, /draftStore|sessionStorage|localStorage/, "no store writes of any kind")
})

test("§8 a dismissal takes the offer down at once — not at the next publish point", () => {
  // A dismissal changes no text, so nothing publishes, and the policy's state still holds the offer after Esc
  // or ×. Long after the last key (every timer spent), the screen must still drop it the moment its edge is
  // dismissed. Before shownUnder it stayed up until the next keystroke or blur.
  const box = new Box()
  box.type("every Monday at 9am triage new issues")
  box.advance(5_000)
  assert.deepEqual(box.state.wait, {}, "every timer spent: no publish point is coming")
  const shown = box.state.shown
  assert.equal(shown?.reading.kind, "exact")
  assert.equal(shownUnder(shown, false, {}), shown, "undismissed: shown")
  assert.equal(shownUnder(shown, false, { open: true }), null, "its edge dismissed: gone at once")
  assert.equal(shownUnder(shown, false, { close: true }), shown, "the other edge's dismissal does not touch it")
  assert.equal(shownUnder(shown, true, { open: true }), shown, "in the mode the panel shows the reading, dismissed or not")
  assert.equal(shownUnder(null, false, {}), null)
})
