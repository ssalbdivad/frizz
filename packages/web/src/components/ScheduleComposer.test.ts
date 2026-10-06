// The prompt box's schedule panel, its pure half (plans/schedule-live-reading.md §4.3, §5, §9): what the panel
// shows for a text in the mode (`modeViewOf`), the state the keys read (`uiStateOf`), when the model may be
// asked (`needsModel`, I-8), and what Enter does with the text as it reads NOW (`t3`, I-6/I-7). The model is a
// fake reader answering by hand; the grammar is the real one at the spec's clock. The rendered pixels are
// checked in a real browser, not here.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { readSchedulePhrase, type InterpretScheduleResult } from "@frizz/shared"
import { modeViewOf, needsModel, phoneCopy, t3, uiStateOf, type ModeView } from "./ScheduleComposer.tsx"
import { keyAction } from "../lib/scheduleIntent.ts"
import { MODEL_BUDGET_COPY, MODEL_UNREACHABLE_COPY, type ModelReadOk, type ModelReadView } from "../lib/scheduleModelRead.ts"
import type { Published } from "../lib/scheduleOffer.ts"

const NY = "America/New_York"
const NOW = Date.parse("2026-10-05T14:32:00-04:00")
const promptOf = (cut: string) => cut.trim()

function published(text: string, at = NOW, read = text): Published {
  return { prose: text, read, at, reading: readSchedulePhrase(read === text ? text : read, { nowMs: at, tz: NY, scope: "anywhere" }) }
}

function answer(text: string, phrase: string, extra: Partial<ModelReadOk> = {}): ModelReadOk {
  const start = text.indexOf(phrase)
  return {
    ok: true, phrase, phraseStart: start, phraseEnd: start + phrase.length, prompt: "", whenText: phrase,
    rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0", dtstart: "2026-10-12T09:00", tz: NY,
    title: "Post digest",
    preview: { describe: "every Monday at 9am", echo: "Post digest · every Monday at 9am", nextLine: "", upcoming: [] },
    ...extra,
  }
}

/** A reader that knows the answers given, by text, and the last one that landed. */
function reader(answers: Record<string, InterpretScheduleResult | "reading" | "failed">, last?: { text: string; result: InterpretScheduleResult }) {
  return {
    view: (text: string): ModelReadView => {
      const a = answers[text]
      if (a === undefined) return { status: "none" }
      if (a === "reading") return { status: "reading" }
      if (a === "failed") return { status: "failed", message: "boom" }
      return { status: "answered", result: a }
    },
    lastAnswer: () => last,
  }
}

function view(text: string, opts: { answers?: Parameters<typeof reader>[0]; last?: Parameters<typeof reader>[1]; shown?: Published | null; stale?: { prose: string; why: "grammar" | "clock" }; hadModel?: boolean } = {}): ModeView {
  return modeViewOf({
    prose: text,
    shown: opts.shown === undefined ? published(text) : opts.shown,
    reader: reader(opts.answers ?? {}, opts.last),
    tz: NY,
    nowMs: NOW,
    promptOf,
    stale: opts.stale ?? null,
    near: undefined,
    hadModel: opts.hadModel ?? false,
  })
}

test("M1: an exact local reading is ready at once, with a provisional title and the cut prompt", () => {
  const v = view("every Monday at 9am triage new issues")
  assert.equal(v.kind, "local")
  if (v.kind !== "local") return
  assert.equal(v.prompt, "triage new issues")
  assert.equal(v.title, "Triage issues")
  assert.equal(v.reading.rrule, "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0")
  assert.deepEqual(uiStateOf(true, false, null, v), { name: "M1" })
})

test("M4: every local refusal, with no model call possible (I-8)", () => {
  const cases: [string, RegExp][] = [
    ["every time the build fails, fix it", /^Schedules run on the clock/],
    ["while I'm working, keep an eye on CI", /^Frizz can't tell when you're at the keyboard/],
    ["every 5 minutes check the deploy", /^Runs can't be closer than 15m apart\.$/],
    ["biweekly sync the roadmap doc", /^“Biweekly” can mean/],
    ["twice a week", /^Say what it should do as well/],
  ]
  for (const [text, copy] of cases) {
    const v = view(text)
    assert.equal(v.kind, "copy", text)
    if (v.kind !== "copy") continue
    assert.match(v.copy, copy, text)
    assert.equal(needsModel(published(text), promptOf), false, `${text}: never the model`)
    assert.equal(uiStateOf(true, false, null, v).name, "M4", text)
  }
  // A reading with nothing left to run keeps the reading on screen, says what is missing, and Enter waits.
  const bare = view("every Monday at 9am")
  assert.equal(bare.kind, "copy")
  if (bare.kind === "copy") {
    assert.equal(bare.copy, "Say what each run should do.")
    assert.ok(bare.reading, "the reading stays on screen")
  }
  assert.equal(keyAction(uiStateOf(true, false, null, bare), "enter"), "nudge")
})

test("I-8: the model is asked only for a cue with a task, or text the grammar sees no schedule in", () => {
  assert.equal(needsModel(published("every Monday unless it's a holiday post the digest"), promptOf), true)
  assert.equal(needsModel(published("evry monday at 9 check CI"), promptOf), true, "a typo is the model's in the mode")
  assert.equal(needsModel(published("every Monday at 9am triage new issues"), promptOf), false, "exact: local wins")
  assert.equal(needsModel(published(""), promptOf), false)
  assert.equal(needsModel(published("   "), promptOf), false)
})

test("M2 → M1: a cue reads its core at once, then the model's consistent answer lands and the mark grows", () => {
  const text = "every Monday unless it's a holiday post the digest"
  const reading = view(text, { answers: { [text]: "reading" } })
  assert.equal(reading.kind, "reading")
  if (reading.kind === "reading") {
    assert.equal(reading.quoted, "unless it's a holiday")
    assert.ok(reading.core, "the part the grammar IS sure of shows while the model reads")
    assert.equal(reading.prompt, "post the digest")
  }
  assert.equal(uiStateOf(true, false, null, reading).name, "M2")
  assert.equal(keyAction(uiStateOf(true, false, null, reading), "enter"), "nudge", "Enter waits for the reading")

  const ok = answer(text, "every Monday unless it's a holiday", { condition: "unless it's a holiday" })
  const landed = view(text, { answers: { [text]: ok }, last: { text, result: ok } })
  assert.equal(landed.kind, "model")
  if (landed.kind === "model") {
    assert.equal(landed.prompt, "post the digest")
    assert.deepEqual(landed.span, { start: 0, end: 34 })
    assert.ok(landed.core && landed.core.end < landed.span.end, "the model's span grows past the core")
  }
  assert.equal(uiStateOf(true, false, null, landed).name, "M1")
})

test("I-10 / M3: a model reading that moves the core's day disagrees, and neither Enter nor the button creates", () => {
  const text = "every Monday unless it's a holiday post the digest"
  const wrong = answer(text, "every Monday unless it's a holiday", { rrule: "FREQ=WEEKLY;BYDAY=TU;BYHOUR=9;BYMINUTE=0", dtstart: "2026-10-06T09:00" })
  const v = view(text, { answers: { [text]: wrong }, last: { text, result: wrong } })
  assert.equal(v.kind, "disagree")
  if (v.kind === "disagree") {
    assert.equal(v.ours, "every Monday at 9am")
    assert.equal(v.theirs, "every Tuesday at 9am")
    assert.equal(v.corePhrase, "every Monday")
  }
  const state = uiStateOf(true, false, null, v)
  assert.equal(state.name, "M3")
  assert.equal(keyAction(state, "enter"), "nudge")
  assert.equal(keyAction(state, "mod-enter"), "nudge")
})

test("a model reading belongs to its phrase: a task-only edit keeps it, re-cut; a phrase edit says it is reading again", () => {
  const text = "every Monday unless it's a holiday post the digest"
  const ok = answer(text, "every Monday unless it's a holiday", { condition: "unless it's a holiday" })
  const edited = "every Monday unless it's a holiday post the weekly digest"
  const kept = view(edited, { last: { text, result: ok } })
  assert.equal(kept.kind, "model", "the task changed, the reading stands")
  if (kept.kind === "model") {
    assert.equal(kept.prompt, "post the weekly digest")
    assert.equal(kept.text, text, "it remembers the text the model read")
  }
  const touched = "every Monday unless it's a holiday or a weekend post the digest"
  const again = view(touched, { last: { text, result: ok }, hadModel: true })
  assert.equal(again.kind, "reading")
  if (again.kind === "reading") assert.equal(again.edited, true, "Edited. Reading it again…")
})

test("model refusals and failures: its copy verbatim; a failed call or a spent budget reads again on Enter", () => {
  const text = "check on things every so often"
  const refused = view(text, { answers: { [text]: { ok: false, error: "Couldn't find a schedule in that. Try “every weekday at 9am”." } } })
  assert.equal(refused.kind, "copy")
  if (refused.kind === "copy") assert.equal(refused.rereads, false)
  const failed = view(text, { answers: { [text]: "failed" } })
  assert.equal(failed.kind, "copy")
  if (failed.kind === "copy") {
    assert.equal(failed.copy, "Couldn't read that just now. Press Enter to try again.")
    assert.equal(failed.rereads, true)
  }
  assert.equal(keyAction(uiStateOf(true, false, null, failed), "enter"), "read")
})

test("M4 `changed`: words read before a half-typed word make Enter read again rather than nudge", () => {
  const read = "every time the build fails, fix it"
  const now = "every time the build fails, fix it now"
  const v = view(now, { shown: { prose: now, read, at: NOW, reading: readSchedulePhrase(read, { nowMs: NOW, tz: NY, scope: "anywhere" }) } })
  assert.equal(v.kind, "copy")
  assert.deepEqual(uiStateOf(true, false, null, v), { name: "M4", changed: true })
  assert.equal(keyAction(uiStateOf(true, false, null, v), "enter"), "read")
})

test("the stale-bundle copy, M5 empty, and the S states outside the mode", () => {
  const text = "every Monday at 9am triage new issues"
  const stale = view(text, { stale: { prose: text, why: "grammar" } })
  assert.equal(stale.kind, "copy")
  if (stale.kind === "copy") assert.equal(stale.copy, "Frizz has updated since this page loaded. Reload the page to create this schedule.")
  assert.equal(view("", { shown: null }).kind, "empty")
  assert.equal(uiStateOf(true, false, null, view("", { shown: null })).name, "M5")
  assert.equal(uiStateOf(true, true, null, view(text)).name, "creating", "a create in flight swallows the keys")
  const edges = (t: string) => ({ prose: t, read: t, at: NOW, reading: readSchedulePhrase(t, { nowMs: NOW, tz: NY, scope: "edges" }) })
  assert.equal(uiStateOf(false, false, edges(text), null).name, "S1")
  assert.equal(uiStateOf(false, false, edges("every Monday unless it's a holiday post the digest"), null).name, "S2")
  assert.equal(uiStateOf(false, false, edges("biweekly sync the roadmap doc"), null).name, "S3")
  assert.equal(uiStateOf(false, false, null, null).name, "S0")
})

test("T3 (I-6, I-7): Enter creates only the reading on screen; a different fresh read creates nothing and says why", () => {
  const text = "every day at 2:40pm check the beta signups"
  const at239 = Date.parse("2026-10-05T14:39:00-04:00")
  const at241 = Date.parse("2026-10-05T14:41:00-04:00")
  const onScreen = modeViewOf({ prose: text, shown: published(text, at239), reader: reader({}), tz: NY, nowMs: at239, promptOf, stale: null, near: undefined, hadModel: false })
  assert.equal(onScreen.kind, "local")
  // The same words, read at Enter a minute later: today's 2:40pm has passed, the first run moved to tomorrow.
  const later = t3({ view: onScreen, shownRead: text, fresh: published(text, at241), promptOf })
  assert.deepEqual(later, { act: "show", notice: "Updated for the current time. Press Enter to create." })
  // An edit that never published (Enter right after a half-typed word): the typed words win, nothing created.
  const typed = "every day at 2:45pm check the beta signups"
  assert.deepEqual(t3({ view: onScreen, shownRead: text, fresh: published(typed, at239), promptOf }), { act: "show", notice: "Updated to what you typed. Press Enter to create." })
  // The same reading: create it, with the prompt cut from the prose as it is.
  const same = t3({ view: onScreen, shownRead: text, fresh: published(text, at239), promptOf })
  assert.equal(same.act, "create-local")
  if (same.act === "create-local") {
    assert.equal(same.prompt, "check the beta signups")
    assert.equal(same.reading.phrase, "every day at 2:40pm")
  }
})

test("T3: a model reading is created only while it still stands over the text", () => {
  const text = "every Monday unless it's a holiday post the digest"
  const ok = answer(text, "every Monday unless it's a holiday", { condition: "unless it's a holiday" })
  const v = view(text, { answers: { [text]: ok }, last: { text, result: ok } })
  assert.equal(v.kind, "model")
  const go = t3({ view: v, shownRead: text, fresh: published(text), promptOf })
  assert.equal(go.act, "create-model")
  if (go.act === "create-model") assert.equal(go.prompt, "post the digest")
  // The phrase was edited and not yet published: read again, create nothing.
  const touched = "every Monday unless it's a holiday or a weekend post the digest"
  assert.deepEqual(t3({ view: v, shownRead: text, fresh: published(touched), promptOf }), { act: "reread" })
  // An unpublished edit that makes the text read exact locally: local wins, and it is shown first.
  assert.equal(t3({ view: v, shownRead: text, fresh: published("every Monday at 9am post the digest"), promptOf }).act, "show")
})

test("I-12: no accent before accept — the offer's marks and its ledge are drawn in fg and muted ink only", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8")
  for (const tone of ["offer", "unread", "reading"]) {
    for (const block of css.matchAll(new RegExp(`\\[data-composer-mark="${tone}"\\][^{]*\\{[^}]*\\}`, "g"))) {
      assert.doesNotMatch(block[0], /accent/, `${tone}: ${block[0]}`)
    }
  }
  // The shared base rule's custom properties are the offer's ink: fg, never the accent.
  const base = /\[data-composer-mark\] \{[^}]*\}/.exec(css)?.[0] ?? ""
  assert.match(base, /--sched-dot: color-mix\(in srgb, var\(--color-fg\)/)
  assert.doesNotMatch(base, /accent/)
  const source = readFileSync(new URL("./ScheduleComposer.tsx", import.meta.url), "utf8")
  const ledge = source.slice(source.indexOf("function LedgeLine("), source.indexOf("function EchoLine("))
  assert.ok(ledge.length > 500, "found the ledge's source")
  assert.doesNotMatch(ledge, /accent/, "the ledge never uses the accent")
})

test("the phone has no keys: every line that says Press Enter says what to tap there instead (fix round 1, X7)", () => {
  const source = readFileSync(new URL("./ScheduleComposer.tsx", import.meta.url), "utf8")
  // Every copy constant in this file that names a key, plus the model tier's two.
  const keyed = [...source.matchAll(/^const [A-Z_]+ = "([^"]*\b(?:Press|Enter)\b[^"]*)"/gm)].map((m) => m[1]!)
  assert.ok(keyed.length >= 2, `found the keyed copy: ${JSON.stringify(keyed)}`)
  for (const copy of [...keyed, MODEL_UNREACHABLE_COPY, MODEL_BUDGET_COPY]) {
    const phone = phoneCopy(copy)
    assert.doesNotMatch(phone, /\b(?:Press|Enter|Esc|Tab)\b/, `${copy} → ${phone}`)
    assert.match(phone, /\bTap\b/, `the phone line says what to tap: ${phone}`)
  }
  assert.equal(phoneCopy("Say what each run should do."), "Say what each run should do.", "copy with no key is the same on the phone")
})

test("the human never confirms raw RRULE text: a model reading is phrased, or refused (fix round 1, model-raw-rrule-echo)", () => {
  // Real Sonnet's answer to "every Friday except in December…": phrased now, and consistent with the core.
  const text = "every Friday except in December write the changelog"
  const dec = answer(text, "every Friday except in December", { rrule: "FREQ=WEEKLY;BYMONTH=1,2,3,4,5,6,7,8,9,10,11;BYDAY=FR;BYHOUR=9;BYMINUTE=0", dtstart: "2026-10-09T09:00", title: "Changelog" })
  const phrased = view(text, { answers: { [text]: dec }, last: { text, result: dec } })
  assert.equal(phrased.kind, "model", JSON.stringify(phrased))
  // A rule no words cover: refused with copy, never echoed as `on the rule FREQ=…`, and nothing to create.
  const odd = "write the changelog sometimes"
  const raw = answer(odd, "sometimes", { rrule: "FREQ=YEARLY;BYDAY=20MO;BYHOUR=9;BYMINUTE=0", dtstart: "2027-05-17T09:00" })
  const refused = view(odd, { answers: { [odd]: raw }, last: { text: odd, result: raw } })
  assert.equal(refused.kind, "copy", JSON.stringify(refused))
  if (refused.kind === "copy") {
    assert.doesNotMatch(refused.copy, /FREQ=|on the rule/)
    assert.equal(refused.rereads, false, "reading the same words again would give the same rule")
  }
  assert.equal(uiStateOf(true, false, null, refused).name, "M4")
  assert.notEqual(keyAction(uiStateOf(true, false, null, refused), "enter"), "create")
})

test("a clock disagreement is never the reload copy: Enter reads it again (fix round 1, rederive-refuses-same-runs-across-boundary)", () => {
  // The server refused the same words twice as moved: this page's clock and the server's read a different
  // first run. Reloading changes nothing about that; reading again once the clocks agree does.
  const text = "every 2 hours check the deploy"
  const clock = view(text, { stale: { prose: text, why: "clock" } })
  assert.equal(clock.kind, "copy")
  if (clock.kind === "copy") {
    assert.doesNotMatch(clock.copy, /Reload|updated since/i)
    assert.equal(clock.rereads, true)
  }
  assert.equal(keyAction(uiStateOf(true, false, null, clock), "enter"), "read")
  assert.doesNotMatch(phoneCopy(clock.kind === "copy" ? clock.copy : ""), /\bEnter\b/)
  // Other words are not held by it.
  assert.notEqual(view("every 3 hours check the deploy", { stale: { prose: text, why: "clock" } }).kind, "copy")
})
