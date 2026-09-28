import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const chat = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")

// A ```question fence restating or naming a question REGISTERED at that rest or an earlier one is folded
// into the registered card (lib/questionShadow) — the 2026-08-28 "same question showing up twice in a row". The fold is a
// prop on Message, so it works only where the transcript hands it over: these pin that every transcript
// path that renders an answerable message does. (The board's queue card pinned the same wiring here until
// it was deleted with the single-project board, 2026-09-28.)

test("every answerable Message site hands the registered questions at its rest to the fold", () => {
  // Thread page: the plain path (keyed by `messageIndex`) and the virtualized path (`row.messageIndex`).
  assert.equal((chat.match(/shadowedBy=\{shadowedByMessage\.get\(messageIndex\)\}/g) ?? []).length, 1, "plain transcript path")
  assert.equal((chat.match(/shadowedBy=\{shadowedByMessage\.get\(row\.messageIndex\)\}/g) ?? []).length, 1, "virtualized transcript path")
})

test("the map is built off the same messages and questions the anchors use, on both transcript paths", () => {
  // `openQuestions` is the board's open list minus the ids already drawn settled (openQuestionsOf) — the
  // same list the placement and the anchors read on each path.
  const build = /registeredStandingAt\(messages, openQuestions\), \[messages, openQuestions\]\)/g
  assert.equal((chat.match(build) ?? []).length, 2, "one per ChatView transcript path")
})

test("a folded fence leaves no Send button behind it", () => {
  // Message's own bottom button needs a block that actually rendered.
  assert.match(chat, /else if \(showSendButton && answering && askBlocks\.length > 0\)/)
})

// ---- PER-QUESTION PLACEMENT (2026-09-11) ----

test("every Message site hands the message its placed questions, and every question stack takes its Send from questionStacks", () => {
  assert.equal((chat.match(/placed=\{placement\.placed\.get\(messageIndex\)\}/g) ?? []).length, 1, "plain transcript path")
  assert.equal((chat.match(/placed=\{placement\.placed\.get\(row\.messageIndex\)\}/g) ?? []).length, 1, "virtualized transcript path")
  // The Send rides the rest the placing marker sits in (lib/questionShadow questionStacks), so both the
  // tail mount and the anchored mount take it from the stack rather than from "anything placed anywhere".
  assert.equal((chat.match(/showSend=\{(questionGroups\.tail|row)\.showSend\}/g) ?? []).length, 2, "the thread page's tail and anchored stacks")
})

test("a placed question leaves its anchor group, and the thread page mounts ONE answering provider", () => {
  assert.match(chat, /questionStacks\(messages, openQuestions, placement\)/)
  assert.equal((chat.match(/<RegisteredAnsweringProvider thread=\{thread\}>/g) ?? []).length, 1)
})

test("a free-form fence in a post-retirement thread gets no answering controller on any site", () => {
  assert.equal((chat.match(/answering=\{fencesLive \? answeringForMessage\((m|row\.message)\) : undefined\}/g) ?? []).length, 2)
})
