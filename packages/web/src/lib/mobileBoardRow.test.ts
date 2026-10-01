import { test } from "node:test"
import assert from "node:assert/strict"
import type { ThreadView } from "@frizz/shared"
import { agentSuffix, handoffLine, liveAgentCount, rowSecondLine, wakeAt } from "./mobileBoardRow.ts"

const now = Date.parse("2026-09-30T12:00:00.000Z")
const ahead = (ms: number) => new Date(now + ms).toISOString()

function thread(over: Partial<ThreadView>): ThreadView {
  return { id: "t", title: "T", runtime: "turn-idle", kind: "session", subAgents: [], watches: [], questions: [], ...over } as ThreadView
}

test("a handoff's leading bold phrase is its verdict, and markdown reads as prose", () => {
  assert.deepEqual(handoffLine("**Fixed** — the arm builds on Node 24, `e41c2a0` on main"), {
    lead: "Fixed",
    text: "— the arm builds on Node 24, e41c2a0 on main",
  })
  assert.deepEqual(handoffLine("## Waiting on CI for [#966](https://github.com/x/y/pull/966)"), { text: "Waiting on CI for #966" })
  assert.deepEqual(handoffLine("- first bullet *soft* here"), { text: "first bullet soft here" })
  assert.deepEqual(handoffLine("**Done.**"), { text: "Done." })
  // The tailer collapses newlines, so the first line ends where the next block would have started.
  assert.deepEqual(handoffLine("Landed the fix. ```done - Fixed the rounding. - Added a test. ```"), { text: "Landed the fix." })
  assert.deepEqual(handoffLine("```done - The context meter now reads codex token counts. - Tests green. ```"), { text: "The context meter now reads codex token counts." })
  assert.deepEqual(handoffLine("**Fixed** — the rail holds. - ws.ts no longer clears it."), { lead: "Fixed", text: "— the rail holds." })
  assert.deepEqual(handoffLine("First line\nsecond line"), { text: "First line" })
  assert.equal(handoffLine("   "), null)
  assert.equal(handoffLine(undefined), null)
})

test("an ask's line is its question, or the count when there are several", () => {
  const one = thread({ questions: [{ id: "q1", askedAt: ahead(0), spec: { question: "SQLite or a JSON file?\n\nMore context below.", kind: "question" } }] as ThreadView["questions"] })
  assert.deepEqual(rowSecondLine(one, "needs-input", false), { text: "SQLite or a JSON file?" })
  const two = thread({ questions: [
    { id: "q1", askedAt: ahead(0), spec: { question: "A?", kind: "question" } },
    { id: "q2", askedAt: ahead(0), spec: { question: "B?", kind: "question" } },
  ] as ThreadView["questions"] })
  assert.deepEqual(rowSecondLine(two, "needs-input", false), { text: "2 questions" })
  const native = thread({ pendingAsk: { questions: [{ question: "Post it?", header: "", multiSelect: false, options: [] }] } as unknown as ThreadView["pendingAsk"] })
  assert.deepEqual(rowSecondLine(native, "needs-input", false), { text: "Post it?" })
  // No question text anywhere: the handoff says what was asked.
  assert.deepEqual(rowSecondLine(thread({ humanBlocked: true, lastAssistant: "Should I merge?" }), "needs-input", false), { text: "Should I merge?" })
})

test("a running row reads its activity, and a rested row its handoff", () => {
  const t = thread({ activity: "Running the focused tests", lastAssistant: "**Fixed** — done" })
  assert.deepEqual(rowSecondLine(t, "working", true), { text: "Running the focused tests" })
  // A session thread carries no gerund: the newest thing its agent said is the live line.
  assert.deepEqual(rowSecondLine(thread({ lastAssistant: "Measuring the payload first." }), "working", true), { text: "Measuring the payload first." })
  assert.equal(rowSecondLine(thread({}), "working", true), null)
  assert.deepEqual(rowSecondLine(t, "rest", false), { lead: "Fixed", text: "— done" })
  // Nothing written yet: the activity is better than an empty line.
  assert.deepEqual(rowSecondLine(thread({ activity: "Reading ci.yml" }), "rest", false), { text: "Reading ci.yml" })
})

test("a parked row says who parked it, and when it wakes", () => {
  const snoozed = thread({ snoozedUntil: ahead(3 * 3_600_000), lastAssistant: "whatever" })
  assert.deepEqual(rowSecondLine(snoozed, "snoozed", false, now), { text: "Snoozed by you" })
  assert.equal(wakeAt(snoozed, now), snoozed.snoozedUntil)
  const timer = thread({
    watches: [
      { id: "w1", kind: "timer", target: "tmr_1", state: "armed", createdAt: ahead(0), timer: { fireAt: ahead(6 * 3_600_000), prompt: "p" } },
      { id: "w2", kind: "timer", target: "tmr_2", state: "armed", createdAt: ahead(0), timer: { fireAt: ahead(2 * 3_600_000), prompt: "p" } },
      { id: "w3", kind: "timer", target: "tmr_3", state: "fired", createdAt: ahead(0), timer: { fireAt: ahead(3_600_000), prompt: "p" } },
    ] as ThreadView["watches"],
  })
  assert.equal(wakeAt(timer, now), ahead(2 * 3_600_000), "the earliest ARMED timer")
  assert.equal(wakeAt(thread({}), now), undefined, "no clock, no promise")
  assert.equal(wakeAt(thread({ snoozedUntil: ahead(-60_000) }), now), undefined)
})

test("the agent count counts running children only", () => {
  const t = thread({ subAgents: [
    { id: "a", label: "a", state: "running" },
    { id: "b", label: "b", state: "running", depth: 2 },
    { id: "c", label: "c", state: "rested" },
    { id: "d", label: "d", state: "stale" },
  ] as ThreadView["subAgents"] })
  assert.equal(liveAgentCount(t), 2)
  assert.equal(agentSuffix(0), "")
  assert.equal(agentSuffix(1), "1 agent")
  assert.equal(agentSuffix(3), "3 agents")
})
