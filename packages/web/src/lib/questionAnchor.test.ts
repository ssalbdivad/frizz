import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { isHumanTurn, questionAnchorIndex, questionsByAnchor, type AnchorMessage } from "./questionAnchor.ts"

const at = (n: number) => new Date(Date.UTC(2026, 7, 27, 20, n)).toISOString()
const msg = (role: string, minute: number, kind?: string): AnchorMessage => ({ role, at: at(minute), ...(kind ? { kind } : {}) })
// The divider the server emits for every rest, off the provider's own end-of-turn signal (transcript.ts).
const rest = (minute: number): AnchorMessage => ({ role: "assistant", kind: "event", boundary: "rest", at: at(minute), text: "Agent rested" })
const answers = (minute: number): AnchorMessage => ({ role: "user", at: at(minute), wake: true, text: "Answers to earlier questions:\n1. “Merge it?” → Merge it" })

// THE ORDINARY CASE, and the one that must not move: the worker asked and rested, nothing has happened
// since, so the card is the tail exactly as it was before there was an anchor at all.
test("a question asked at the last rest anchors to the tail", () => {
  assert.equal(questionAnchorIndex([msg("user", 0), msg("assistant", 1), msg("assistant", 2), rest(2)], at(2)), 3)
  // …and with no divider at all (a runtime that emits none), still the tail.
  assert.equal(questionAnchorIndex([msg("user", 0), msg("assistant", 1), msg("assistant", 2)], at(2)), 2)
})

test("a question asked in the turn still running is the tail", () => {
  const messages = [msg("user", 0), msg("assistant", 1), rest(1), msg("user", 3), msg("assistant", 5)]
  assert.equal(questionAnchorIndex(messages, at(4)), 4)
})

// WHILE A TURN RUNS PAST THE REST, THE CARD STAYS PUT at the bottom of the handoff the human was reading
// — above their typed message, above the delivered answer, above the wake — instead of riding under the
// worker's streaming output (maintainer 2026-08-27: "The questions should show up in the chat wherever the
// session came to rest"). The caller lifts it above the divider (questionShadow aboveTrailingEvents).
test("while the next turn runs — typed, answered or woken — the card stays at the newest rest", () => {
  for (const next of [msg("user", 3), answers(3), { role: "user", at: at(3), wake: true, text: "⏰ Your watcher has expired" }]) {
    const messages = [msg("user", 0), msg("assistant", 1), msg("assistant", 2), rest(2), next, msg("assistant", 4)]
    assert.equal(questionAnchorIndex(messages, at(2)), 3, JSON.stringify(next))
  }
})

// THE 2026-09-29 CHANGE. Answers arrive one question at a time, and a typed message no longer releases
// the questions it passes — the worker decides which it made moot. So whatever is still open when the
// worker rests again is current by its own judgment, and rides to the bottom of that NEW handoff. Frozen
// at the old rest (the 2026-09-24 reading), the rest of a batch sat above the answer to its first card
// while the newest handoff showed no ask at all.
test("once the worker rests again, the card rides to the bottom of the newest handoff — whatever woke it", () => {
  for (const next of [msg("user", 3), answers(3), { role: "user", at: at(3), wake: true, text: "⏰ Your watcher has expired" }]) {
    const messages = [msg("user", 0), msg("assistant", 1), msg("assistant", 2), rest(2), next, msg("assistant", 4), rest(4)]
    assert.equal(questionAnchorIndex(messages, at(2)), 6, JSON.stringify(next))
  }
})

test("…through any number of rests", () => {
  const messages = [msg("assistant", 1), rest(1), msg("user", 2), msg("assistant", 3), rest(3), answers(4), msg("assistant", 5), rest(5), msg("user", 6)]
  assert.equal(questionAnchorIndex(messages, at(1)), 7, "mid-turn after the third rest: the third rest")
})

test("isHumanTurn: only a TYPED turn — never frizz's wake, a sub-agent's report, or the delivered answers", () => {
  assert.equal(isHumanTurn(msg("user", 1)), true)
  assert.equal(isHumanTurn(answers(1)), false, "an answer is one card of a batch, not the human moving on")
  assert.equal(isHumanTurn({ role: "user", at: at(1), wake: true, text: "⏰ Your watcher has expired" }), false)
  assert.equal(isHumanTurn({ role: "user", at: at(1), peerFrom: "frizz:high", text: "Milestone" }), false)
  assert.equal(isHumanTurn(msg("user", 1, "event")), false)
  assert.equal(isHumanTurn(msg("assistant", 1)), false)
})

test("punctuation after a rest is not a turn: the thread is still at rest, and the card is the tail", () => {
  const messages = [msg("assistant", 1), rest(1), msg("user", 2, "event"), msg("user", 2, "reasoning")]
  assert.equal(questionAnchorIndex(messages, at(1)), 3)
})

test("a rest older than the loaded window goes above everything, never back to the tail", () => {
  // -1 rather than the tail: at the bottom the card would be lying about being the current ask, which is
  // the whole defect. At the top it is merely as high as this window can put it. (A window holding a rest
  // after the ask needs none of this: the card is at that rest.)
  const messages = [msg("user", 5), msg("assistant", 6)]
  assert.equal(questionAnchorIndex(messages, at(1)), -1)
  assert.equal(questionAnchorIndex([msg("user", 5), msg("assistant", 6), rest(6)], at(1)), 2)
})

test("an unreadable instant degrades to the tail rather than to the top", () => {
  const messages = [msg("user", 0), msg("assistant", 1)]
  assert.equal(questionAnchorIndex(messages, "not a date"), 1)
  assert.equal(questionAnchorIndex([], at(1)), -1)
})

test("an undated rest cannot anchor anything", () => {
  const messages: AnchorMessage[] = [{ role: "assistant", at: at(1) }, { role: "assistant", kind: "event", boundary: "rest" }, { role: "user", at: at(3) }]
  assert.equal(questionAnchorIndex(messages, at(1)), 2)
})

// Every open question shares the newest rest, so questions from one call AND from several asks still open
// render as one stack at the bottom of the newest handoff.
test("questions from one call, and from earlier rests, group together at the newest rest", () => {
  const messages = [msg("assistant", 1), rest(1), msg("user", 2), msg("assistant", 3), rest(3), msg("user", 4)]
  const grouped = questionsByAnchor(messages, [
    { id: "a", askedAt: at(1) },
    { id: "b", askedAt: at(1) },
    { id: "c", askedAt: at(3) },
  ])
  assert.deepEqual([...grouped.entries()].map(([k, qs]) => [k, qs.map((q) => q.id)]), [[4, ["a", "b", "c"]]])
})

// THE ONE THING THE PURE FUNCTION CANNOT PIN: that the thread page splits the stack this way. The
// in-flight ANSWER belongs to the TAIL wherever the questions sit — it is the human's newest turn, and
// the delivered copy of it lands at the tail a second later — so a mount placed at an older rest must
// not draw it. Two drawing it would render the answer twice, in two places, seconds apart. (The board's
// queue card was read here too until it was deleted with the single-project board, 2026-09-28.)
//
// The prop is OPT-IN (`inFlight`, the rows the transcript is not already drawing — see
// unrenderedAnswers) rather than the opt-out `showInFlight` it was until 2026-09-01, so an anchored
// mount draws nothing by simply not passing it, and this reads the same guarantee off the new spelling.
test("a mount placed at an older rest never draws the in-flight answer", () => {
  for (const file of ["ChatView.tsx"]) {
    const source = readFileSync(new URL(`../components/${file}`, import.meta.url), "utf8")
    const mounts = [...source.matchAll(/<RegisteredQuestionStack[^>]*>/g)].map((m) => m[0])
    const tail = mounts.filter((m) => /questions=\{[^}]*[Tt]ail(\.questions)?\}/.test(m))
    // An ANCHORED mount is one handed a group that is not the tail. The eager fallback passes no
    // `questions` at all — it only renders with an empty transcript, where every rest IS the tail.
    const anchored = mounts.filter((m) => /questions=\{/.test(m) && !/[Tt]ail(\.questions)?\}/.test(m))
    assert.equal(tail.length, 1, `${file}: exactly one tail mount`)
    assert.ok(anchored.length >= 1, `${file}: at least one anchored mount`)
    assert.match(tail[0], /inFlight=\{/, `${file}: the tail mount draws the in-flight answer`)
    for (const m of anchored) assert.ok(!/inFlight=\{/.test(m), `${file}: an anchored mount must not`)
    // …and the mount with no `questions` at all (the empty-transcript fallback) is a tail too.
    for (const m of mounts.filter((x) => !/questions=\{/.test(x))) {
      assert.match(m, /inFlight=\{/, `${file}: the fallback mount is a tail mount`)
    }
  }
})

// No questions ⇒ no groups; the tail entry must not be minted for an empty set.
test("no open questions produces no groups", () => {
  const messages = [msg("user", 0), msg("assistant", 1)]
  assert.equal(questionsByAnchor(messages, []).size, 0)
})
