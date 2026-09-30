import { test } from "node:test"
import assert from "node:assert/strict"
import type { ThreadView } from "@frizz/shared"
import { foldHandle, insertMention, matchMentions, mentionCandidates, mentionQueryAt, mentionSegments, resolveMention } from "./threadMentions.ts"

function thread(over: Partial<ThreadView>): ThreadView {
  return {
    id: "t", title: "t", status: "active", mechanism: null, humanBlocked: false, ready: false, dependsOn: [], externalDeps: [],
    agents: [], errors: [], warnings: [], runtime: "turn-idle", unread: false, archived: false, hasPlan: false, subAgents: [],
    bgShells: [], watches: [], questions: [], pendingQuestion: false, kind: "session", state: "open", titleAuto: false,
    ...over,
  } as ThreadView
}

const board = [
  thread({ id: "a", title: "Shell budgets", statusLine: "Tuning the cap", lastAssistantAt: "2026-09-29T10:00:00Z" }),
  thread({ id: "b", title: "Focus mode", lastAssistantAt: "2026-09-29T12:00:00Z" }),
  thread({ id: "c", title: "Budget report", state: "archived", lastAssistantAt: "2026-09-29T13:00:00Z" }),
  thread({ id: "d", title: "A sentence far too long to be any name" }),
  thread({ id: "e", title: "External", foreign: true }),
  thread({ id: "f", title: "Spinning", titleAuto: true, spawnedAt: new Date().toISOString() }),
]

test("mentionCandidates: open threads by recency, then done ones; no self, externals, placeholders or sentences", () => {
  const all = mentionCandidates(board)
  assert.deepEqual(all.map((c) => c.handle), ["focusMode", "shellBudgets", "budgetReport"])
  assert.deepEqual(all.map((c) => c.done), [false, false, true])
  assert.equal(all[1]!.status, "Tuning the cap")
  assert.deepEqual(mentionCandidates(board, "b").map((c) => c.handle), ["shellBudgets", "budgetReport"], "the thread being written into is not offered")
})

test("mentionQueryAt: an @ at a word boundary before the caret, never an email address", () => {
  assert.deepEqual(mentionQueryAt("ask @she", 8), { start: 4, query: "she" })
  assert.deepEqual(mentionQueryAt("@", 1), { start: 0, query: "" })
  assert.deepEqual(mentionQueryAt("(@focus", 7), { start: 1, query: "focus" })
  assert.equal(mentionQueryAt("mail me@host", 12), undefined)
  assert.equal(mentionQueryAt("ask @she about", 14), undefined, "the caret has left the token")
  assert.equal(mentionQueryAt("ask @she", null), undefined)
  assert.equal(mentionQueryAt("a/@b", 4), undefined)
})

test("matchMentions: handle prefix, then a word's prefix, then substring, then letters in order", () => {
  const all = mentionCandidates(board)
  assert.deepEqual(matchMentions(all, "").map((c) => c.handle), ["focusMode", "shellBudgets", "budgetReport"])
  assert.deepEqual(matchMentions(all, "bud").map((c) => c.handle), ["budgetReport", "shellBudgets"])
  assert.deepEqual(matchMentions(all, "SHELL").map((c) => c.handle), ["shellBudgets"])
  assert.deepEqual(matchMentions(all, "fmd").map((c) => c.handle), ["focusMode"])
  assert.deepEqual(matchMentions(all, "zzz"), [])
})

test("insertMention: completes the token in place and leaves the caret after one space", () => {
  assert.deepEqual(insertMention("ask @she", 4, 8, "shellBudgets"), { prose: "ask @shellBudgets ", caret: 18 })
  // Mid-token caret: the rest of the token is replaced, and an existing space is reused.
  assert.deepEqual(insertMention("ask @shxx about", 4, 7, "shellBudgets"), { prose: "ask @shellBudgets about", caret: 18 })
})

test("resolveMention / foldHandle: case, punctuation and a plain plural fold away", () => {
  const all = mentionCandidates(board)
  assert.equal(resolveMention(all, "ShellBudget")?.slug, "a")
  assert.equal(resolveMention(all, "shell-budgets")?.slug, "a")
  assert.equal(resolveMention(all, "nothing"), undefined)
  assert.equal(foldHandle("class"), "class", "a double s is not a plural")
})

test("mentionSegments: a mention that names a thread becomes a link run; anything else stays text", () => {
  const all = mentionCandidates(board)
  const text = "ask @shellBudgets, not @nobody or me@focusMode"
  const segs = mentionSegments(text, all)
  assert.equal(segs.map((s) => s.text).join(""), text, "byte-for-byte")
  assert.deepEqual(segs.filter((s) => s.kind === "mention").map((s) => [s.text, s.kind === "mention" && s.slug]), [["@shellBudgets", "a"]])
  assert.deepEqual(mentionSegments("@focus-mode!", all).map((s) => s.kind), ["mention", "text"])
})
