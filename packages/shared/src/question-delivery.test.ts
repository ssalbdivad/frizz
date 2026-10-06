// THE TWO TEXTS FRIZZ ADDS NOW THAT ANSWERS ARRIVE A QUESTION AT A TIME (2026-09-29): the answers fold,
// which puts several answer deliveries back into the ONE shape the chat reads as the human's own turn,
// and the open-questions note, which a typed message carries to a worker that still has questions open.
// Both ride the human's own words, so each is pinned against the reader that must not see frizz in them.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  ANSWER_CONTINUATION_INDENT,
  DEFAULTED_ANSWER_NOTE,
  DEFAULTED_FALLBACK_NOTE,
  QUESTION_DEFAULT_AFTER_MS,
  QUESTION_DEFAULT_ENGAGED_GRACE_MS,
  questionDefaultAtMs,
  recommendedDefaultAnswer,
  BURIED_ANSWERS_HEADER,
  humanGapNote,
  mergeAnswerMessages,
  openQuestionsNote,
  questionAnswerMessage,
  questionsCancelledWakeMessage,
  stripFollowUpRiders,
  stripOpenQuestionsNote,
  wakeTimeHeader,
} from "./index.ts"

const stamped = (message: string) => `${message}\n\n${wakeTimeHeader(Date.parse("2026-09-29T15:00:00.000Z"))}`

test("answer deliveries fold into ONE header with every row renumbered, and a typed numbered list cannot forge a row", () => {
  const first = stamped(questionAnswerMessage([{ questionId: "q1", question: "Which store?", chosen: ["SQLite"], text: "Do these:\n1. run x\n2. run y" }]))
  const second = stamped(questionAnswerMessage(
    [{ questionId: "q2", question: "Publish?", chosen: ["Yes"], followUps: [{ questionId: "q2", question: "Which tag?", chosen: ["next"] }] }],
    [{ question: "Rename it?" }],
  ))
  const merged = mergeAnswerMessages([first, second])!
  assert.equal(merged, [
    BURIED_ANSWERS_HEADER,
    "1. “Which store?” → SQLite — Do these:",
    `${ANSWER_CONTINUATION_INDENT}1. run x`,
    `${ANSWER_CONTINUATION_INDENT}2. run y`,
    "2. “Publish?” → Yes",
    "3. ⤷ “Which tag?” → next",
    "4. “Rename it?” → (dismissed — decide it yourself; do not re-ask)",
  ].join("\n"))
  assert.doesNotMatch(merged, /⏱/, "the parts' clocks come off; the caller stamps one")
  // The negative control for the fold itself: a cancellation is frizz's own voice and never merges into
  // the human's answers.
  assert.equal(mergeAnswerMessages([first, stamped(questionsCancelledWakeMessage(2))]), undefined)
})

test("the open-questions note names each question by text and id, and comes back off the human's bubble", () => {
  assert.equal(openQuestionsNote([]), undefined, "nothing open, nothing said")
  const note = openQuestionsNote([
    { id: "qst_aaaaaaaaaaaa", question: "Should the settings store use\nSQLite or a JSON file?" },
    { id: "qst_bbbbbbbbbbbb", question: "x".repeat(140) },
  ])!
  assert.doesNotMatch(note, /\n/, "one line, so the stripper can anchor on it")
  assert.match(note, /^❓ Frizz: 2 questions you registered are now set aside by this message: “Should the settings store use SQLite or a JSON file\?” \(qst_aaaaaaaaaaaa\), “x{99}…” \(qst_bbbbbbbbbbbb\)\./)
  assert.match(note, /frizz WITHDRAWS every one still set aside when you next come to rest\. `keep` one only if it is directly relevant/)
  assert.match(openQuestionsNote([{ id: "qst_1", question: "Merge it?" }])!, /^❓ Frizz: 1 question you registered is now set aside by this message: “Merge it\?” \(qst_1\)\./)

  // ROUND TRIP, as the router appends it — after the gap note, so "the message above" stays the human's.
  const gap = humanGapNote(Date.parse("2026-09-29T15:00:00.000Z"), "2026-09-29T11:00:00.000Z")!
  assert.equal(stripOpenQuestionsNote(`should we use this thread or the other one?\n\n${note}`), "should we use this thread or the other one?")
  assert.equal(stripFollowUpRiders(`one\n\ntwo\n\n${gap}\n\n${note}`), "one\n\ntwo")
  // AND NOTHING ELSE: prose quoting the note keeps it.
  const quoting = `why does "${note}" show up here?`
  assert.equal(stripOpenQuestionsNote(quoting), quoting)
  assert.equal(stripOpenQuestionsNote("ship it"), "ship it")
  // A transcript written under the 2026-09-29 wording keeps coming back off the bubble too.
  const older = "❓ Frizz: 1 question you registered is still open: “Merge it?” (qst_1). If the message above made any of them moot, `unask` exactly those and say so; leave the rest open — they are still the human's to answer, and still your sign-off."
  assert.equal(stripOpenQuestionsNote(`ship it\n\n${older}`), "ship it")
  // …and the 2026-09-30 one, when a set-aside card stayed answerable indefinitely.
  const sept30 = "❓ Frizz: 1 question you registered is now set aside by this message: “Merge it?” (qst_1). Their cards stay answerable where they were asked, but no longer hold this thread. If the message above did not move past one, `keep` it — reworded with `question` if the direction changed — and it rides to the bottom of your next handoff; otherwise leave it."
  assert.equal(stripOpenQuestionsNote(`ship it\n\n${sept30}`), "ship it")
})

// THE DEFAULT (2026-10-05): one deadline reading, shared by the scheduler that acts on it and the board
// that counts down to it.
test("questionDefaultAtMs: starts at the later of ask, keep and rest; engagement extends it; the x and a working thread clear it", () => {
  const q = { asked_at: 1_000, kept_at: null, engaged_at: null, default_off: 0 }
  assert.equal(questionDefaultAtMs(q, undefined), undefined, "no countdown while the thread works")
  assert.equal(questionDefaultAtMs(q, 5_000), 5_000 + QUESTION_DEFAULT_AFTER_MS)
  assert.equal(questionDefaultAtMs({ ...q, kept_at: 9_000 }, 5_000), 9_000 + QUESTION_DEFAULT_AFTER_MS)
  const late = 5_000 + QUESTION_DEFAULT_AFTER_MS - 1
  assert.equal(questionDefaultAtMs({ ...q, engaged_at: late }, 5_000), late + QUESTION_DEFAULT_ENGAGED_GRACE_MS)
  assert.equal(questionDefaultAtMs({ ...q, engaged_at: 2_000 }, 5_000), 5_000 + QUESTION_DEFAULT_AFTER_MS, "an early touch never shortens it")
  assert.equal(questionDefaultAtMs({ ...q, default_off: 1 }, 5_000), undefined)
})

test("recommendedDefaultAnswer: takes the single recommendation, its follow-ups' too, and nothing on danger, multi or free text", () => {
  const spec = { question: "Q", kind: "question" as const, options: [{ label: "A" }, { label: "B", recommended: true, followUps: [
    { question: "F1", kind: "question" as const, options: [{ label: "x", recommended: true }] },
    { question: "F2", kind: "question" as const },
  ] }] }
  assert.deepEqual(recommendedDefaultAnswer("qst_1", spec), {
    questionId: "qst_1", question: "Q", chosen: ["B"], text: DEFAULTED_ANSWER_NOTE,
    followUps: [{ questionId: "qst_1", question: "F1", chosen: ["x"] }, { questionId: "qst_1", question: "F2", chosen: [] }],
  })
  assert.equal(recommendedDefaultAnswer("q", { ...spec, danger: true }), undefined)
  assert.equal(recommendedDefaultAnswer("q", { ...spec, kind: "multi" }), undefined)
  assert.equal(recommendedDefaultAnswer("q", { question: "Q", kind: "question" }), undefined)
  assert.equal(recommendedDefaultAnswer("q", { question: "Q", kind: "question", options: [{ label: "A" }] }), undefined)
})

test("recommendedDefaultAnswer: never takes an external option — falls back to the first local one, or waits", () => {
  const spec = { question: "File the repro upstream?", kind: "question" as const, options: [
    { label: "File it", recommended: true, external: true },
    { label: "Post a comment instead", external: true },
    { label: "Keep it in the handoff" },
    { label: "Drop it" },
  ] }
  assert.deepEqual(recommendedDefaultAnswer("q", spec), {
    questionId: "q", question: spec.question, chosen: ["Keep it in the handoff"], text: DEFAULTED_FALLBACK_NOTE,
  })
  const allExternal = { ...spec, options: spec.options.slice(0, 2) }
  assert.equal(recommendedDefaultAnswer("q", allExternal), undefined, "nothing local to take: it waits for the human")
  // A follow-up under the taken option follows the same rule, and goes out blank when all of it is external.
  const nested = { question: "Q", kind: "question" as const, options: [{ label: "A", recommended: true, followUps: [
    { question: "F1", kind: "question" as const, options: [{ label: "push", recommended: true, external: true }, { label: "local" }] },
    { question: "F2", kind: "question" as const, options: [{ label: "publish", recommended: true, external: true }] },
  ] }] }
  assert.deepEqual(recommendedDefaultAnswer("q", nested)?.followUps, [
    { questionId: "q", question: "F1", chosen: ["local"] },
    { questionId: "q", question: "F2", chosen: [] },
  ])
})
