import assert from "node:assert/strict"
import test from "node:test"
import { fenceRestatesRegistered, fenceStandsFor, markerIdsIn, questionStacks, registeredStandingAt } from "./questionShadow.ts"
import { type MessageSegment, splitQuestionBlocks } from "./questionBlocks.ts"

// The pair from the 2026-08-28 report, verbatim: the registration (a plain string — the `ask` schema
// carries no markdown) and the fence the worker wrote sixteen seconds later, with `code`, a link and a
// trailing parenthetical the registration does not have.
const REGISTERED = {
  spec: {
    question: "Cut 4.5.0 now? The memoizer opt-in PR #6482 is still open, and the published announcement documents its API (z.config({ memoizer: z.memoizer() })) in the Zod Mini tab.",
    kind: "question" as const,
    options: [{ label: "Merge #6482, then cut 4.5.0", recommended: true }, { label: "Cut 4.5.0 without #6482" }, { label: "Hold the release" }],
  },
}
const FENCE = [
  "Cut 4.5.0 now? The memoizer opt-in PR [#6482](https://github.com/colinhacks/zod/pull/6482) is still open, and the published announcement documents its API (`z.config({ memoizer: z.memoizer() })`) in the Zod Mini tab. (also on the board as a card)",
  "",
  "- A. Merge #6482 first, then bump to 4.5.0 and push — the release includes the memoizer API the post documents (recommended)",
  "- B. Cut 4.5.0 without #6482 — the Zod Mini memoizer tab gets stripped from the announcement first; the API ships in a later 4.5.x",
  "- C. Hold the release — nothing is bumped until further instruction",
].join("\n")

test("the re-fenced release question restates its registration despite the markup and the trailing aside", () => {
  assert.equal(fenceRestatesRegistered(FENCE, [REGISTERED]), true)
})

test("the same question asked with different context around it still folds — the `?` head is the question", () => {
  const reworded = "Before anything is pushed: Cut 4.5.0 now? #6482 is still open.\n\n- A. Yes\n- B. No"
  assert.equal(fenceRestatesRegistered(reworded, [REGISTERED]), true)
})

test("a fence that only asks the registered question's opening is a prefix of it, and folds", () => {
  assert.equal(fenceRestatesRegistered("Cut 4.5.0 now? The memoizer opt-in PR #6482 is still open\n\n- A. Yes\n- B. No", [REGISTERED]), true)
})

test("a different question at the same rest is NOT folded — the fold never hides an unseen question", () => {
  const other = "Which npm dist-tag should 4.5.0 publish under?\n\n- A. `latest` (recommended)\n- B. `next`"
  assert.equal(fenceRestatesRegistered(other, [REGISTERED]), false)
})

test("nothing folds against no registration, and a head too short to mean anything never matches", () => {
  assert.equal(fenceRestatesRegistered(FENCE, []), false)
  const short = { spec: { question: "Proceed?", kind: "question" as const } }
  assert.equal(fenceRestatesRegistered("Proceed?\n\n- A. Yes\n- B. No", [short]), false)
})

// The transcript shape of the report: a fence, two watcher wakes (user turns frizz wrote), the
// registration, then the final message with the fence again. Frizz's own wake does not end an exchange
// (lib/questionAnchor, 2026-09-28), so the registration belongs to the whole stretch after the human's
// task — the first fence included, which therefore folds too: one question, one card, at the bottom.
const at = (min: number) => new Date(Date.UTC(2026, 7, 28, 17, min)).toISOString()
const MESSAGES = [
  { role: "user", at: at(0) },
  { role: "assistant", at: at(5) }, // the first fence
  { role: "user", at: at(6), wake: true }, // the PR watcher's wake
  { role: "assistant", at: at(9) }, // tool calls
  { role: "assistant", at: at(11) }, // the final message, fence restated
]
const QUESTION = { ...REGISTERED, id: "qst_6b9bdbe563fa", askedAt: at(10) }

test("registeredStandingAt maps every worker message of the question's exchange, through frizz's wake", () => {
  const map = registeredStandingAt(MESSAGES, [QUESTION])
  assert.deepEqual([...map.keys()].sort(), [1, 3, 4])
  assert.deepEqual(map.get(4), [QUESTION])
  assert.equal(map.get(2), undefined, "a wake carries no fence of the worker's")
})

test("a HUMAN turn still closes the exchange: a fence above it is one rest up and does not fold", () => {
  const typed = MESSAGES.map((m, i) => (i === 2 ? { role: "user", at: at(6) } : m))
  assert.deepEqual([...registeredStandingAt(typed, [QUESTION]).keys()].sort(), [3, 4])
})

test("a question the human replied past still stands at every later message of the worker's — not at the human's turn", () => {
  const replied = [...MESSAGES, { role: "user", at: at(15) }, { role: "assistant", at: at(16) }]
  const map = registeredStandingAt(replied, [QUESTION])
  assert.deepEqual([...map.keys()].sort(), [1, 3, 4, 6])
})

test("a registration whose rest is above the loaded window stands at every loaded message of the worker's", () => {
  const windowed = [{ role: "user", at: at(6) }, { role: "assistant", at: at(9) }, { role: "assistant", at: at(11) }]
  const map = registeredStandingAt(windowed, [{ ...QUESTION, askedAt: at(1) }])
  assert.deepEqual([...map.keys()].sort(), [1, 2])
})

const fenced = (body: string, info = "") => `\`\`\`question${info ? ` ${info}` : ""}\n${body}\n\`\`\``
const questionSeg = (text: string, info = "") => {
  const segs = splitQuestionBlocks(fenced(text, info)).filter((s) => s.kind === "question")
  assert.equal(segs.length, 1, "the fixture must produce exactly one question segment")
  return segs[0] as Extract<MessageSegment, { kind: "question" }>
}

test("fenceStandsFor matches by the info-string id, whatever the prose says", () => {
  const seg = questionSeg("Something else entirely?\n\n- A. Yes\n- B. No", QUESTION.id)
  assert.equal(fenceStandsFor(seg, [QUESTION]), QUESTION)
  assert.equal(fenceStandsFor(seg, [{ ...QUESTION, id: "qst_000000000000" }]), undefined, "a different id names a different row")
})

test("fenceStandsFor falls back to the prose when the worker wrote no id", () => {
  assert.equal(fenceStandsFor(questionSeg(FENCE), [QUESTION]), QUESTION)
  assert.equal(fenceStandsFor(questionSeg("Which npm dist-tag?\n\n- A. latest\n- B. next"), [QUESTION]), undefined)
})

// ---- WHERE THE CARD RENDERS: the bottom of its rest, and a marker never places it (2026-09-28) ----
//
// The report: a rebase handoff put its "move main now?" marker mid-prose, with two thousand characters
// of judgment calls and verification under the card (maintainer: "questions should always appear at the
// bottom of the thread not in the middle any explanation should occur beforehand").

const MARKER = (id: string) => `**Needs you** — the rebase is ready.\n\n${fenced("", id)}\n\n**Judgment calls:** several paragraphs the human reads before answering.`
const SECOND = { ...QUESTION, id: "qst_2222bbbb2222", askedAt: at(10) }

test("markerIdsIn reads only the EMPTY id-bearing fences, lowercased, in order", () => {
  const text = `${fenced("", "QST_AAAA")}\n\n${fenced("A real body?\n\n- A. Yes", "qst_bbbb")}\n\n${fenced("", "qst_cccc")}`
  assert.deepEqual(markerIdsIn(text), ["qst_aaaa", "qst_cccc"])
  assert.deepEqual(markerIdsIn("no fence"), [])
  assert.deepEqual(markerIdsIn(fenced(FENCE)), [], "a legacy free-form fence is not a marker")
})

test("a mid-prose marker in the asking rest moves nothing: the whole batch sits under the last message", () => {
  const messages = MESSAGES.map((m, i) => ({ ...m, text: i === 4 ? MARKER(QUESTION.id) : "prose" }))
  assert.deepEqual([...questionStacks(messages, [QUESTION, SECOND]).entries()], [[4, [QUESTION, SECOND]]])
})

test("a handoff that names none of its registrations draws them at the bottom of their rest all the same", () => {
  const messages = MESSAGES.map((m) => ({ ...m, text: "Landed it. Nothing else to say." }))
  assert.deepEqual([...questionStacks(messages, [QUESTION]).entries()], [[4, [QUESTION]]])
})

test("a card rides frizz's wake to the bottom: asked, woken, rested again", () => {
  const woken = [
    { role: "user", at: at(0), text: "Get it merge-ready." },
    { role: "assistant", at: at(10), text: "Merge-ready; needs a go-ahead." }, // asked here
    { role: "user", at: at(20), wake: true, text: "⏰ Your watcher has expired" },
    { role: "assistant", at: at(21), text: "Still merge-ready; watch re-armed." },
  ]
  assert.deepEqual([...questionStacks(woken, [QUESTION]).keys()], [3])
})

test("a fence that RESTATES the question in prose folds but never moves it — only an id names a row", () => {
  const later = [...MESSAGES, { role: "user", at: at(15) }, { role: "assistant", at: at(16), text: `Prose.\n\n${fenced(FENCE)}` }]
    .map((m) => ("text" in m ? m : { ...m, text: "prose" }))
  assert.deepEqual([...questionStacks(later, [QUESTION]).keys()], [4])
})

test("a marker one rest ABOVE the registration never moves it", () => {
  const typed = MESSAGES.map((m, i) => ({ ...(i === 2 ? { role: "user", at: at(6) } : m), text: i === 1 ? MARKER(QUESTION.id) : "prose" }))
  assert.deepEqual([...questionStacks(typed, [QUESTION]).keys()], [4])
})

// A worker dispatched before 2026-09-28 was taught to bring an open question forward by writing its
// marker into a newer handoff, after the human replied past it. That still carries the card — to the
// BOTTOM of the marker's rest, never into the marker's slot.
test("a legacy marker in a LATER rest carries the question to the bottom of that rest, not its own message", () => {
  const later = [
    ...MESSAGES.map((m) => ({ ...m, text: "prose" })),
    { role: "user", at: at(15), text: "Unrelated follow-up." },
    { role: "assistant", at: at(16), text: MARKER(QUESTION.id) }, // 6 — the marker
    { role: "assistant", at: at(17), text: "More of the same handoff." }, // 7 — still that rest
    { role: "assistant", at: at(17), text: "Agent rested", kind: "event" }, // 8 — its closing divider
  ]
  assert.deepEqual([...questionStacks(later, [QUESTION]).keys()], [8], "at the tail the divider draws nothing, and the tail index is the interactions row")
  const answered = [...later, { role: "user", at: at(30), text: "Answers to earlier questions:\n1. …", wake: true }, { role: "assistant", at: at(31), text: "On it." }]
  assert.deepEqual([...questionStacks(answered, [QUESTION]).keys()], [7], "the next human turn ends the marker's rest, and the card sits above its divider")
})

test("a registration whose rest is above the loaded window is carried by a marker inside the window", () => {
  const windowed = [{ role: "user", at: at(15), text: "Well done" }, { role: "assistant", at: at(16), text: MARKER(QUESTION.id) }]
  assert.deepEqual([...questionStacks(windowed, [{ ...QUESTION, askedAt: at(10) }]).keys()], [1])
})

test("a marker in a HUMAN turn moves nothing", () => {
  const replied = [
    ...MESSAGES.map((m) => ({ ...m, text: "prose" })),
    { role: "user", at: at(15), text: MARKER(QUESTION.id) },
    { role: "assistant", at: at(16), text: "prose" },
  ]
  assert.deepEqual([...questionStacks(replied, [QUESTION]).keys()], [4])
})

// ---- THE OLDER REST (2026-09-24) ----
// The worker asked, the human replied past the question without answering, and the worker worked on and
// rested again with the question still open. The card stays at the bottom of the handoff that asked it —
// the later rest is about something else — unless that later handoff names it again.

const STALE = [
  { role: "user", at: at(0), text: "Do the thing." },
  { role: "assistant", at: at(5), text: MARKER(QUESTION.id) }, // the asking rest, marker written
  { role: "user", at: at(20), text: "Here's my answer to the OTHER question." },
  { role: "assistant", at: at(25), text: "Done. The first question is still open." },
]

test("a question the human replied past stays at the bottom of the rest that asked it", () => {
  assert.deepEqual([...questionStacks(STALE, [QUESTION]).keys()], [1])
})

test("…ABOVE that rest's closing divider, which draws once the human has spoken after it", () => {
  const divided = [STALE[0], STALE[1], { role: "assistant", at: at(5), text: "Agent rested", kind: "event" }, STALE[2], STALE[3]]
  assert.deepEqual([...questionStacks(divided, [QUESTION]).keys()], [1])
})

test("a marker the worker re-wrote into the NEW handoff carries the card to the bottom of it", () => {
  const rewritten = STALE.map((m, i) => (i === 3 ? { ...m, text: MARKER(QUESTION.id) } : m))
  assert.deepEqual([...questionStacks(rewritten, [QUESTION]).keys()], [3])
})

test("no open questions produces no stacks", () => {
  assert.equal(questionStacks(STALE, []).size, 0)
})
