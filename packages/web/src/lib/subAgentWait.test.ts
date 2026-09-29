import assert from "node:assert/strict"
import test from "node:test"
import type { ThreadView } from "@frizz/shared"
import { showsSubAgentWait, subAgentWait, subAgentWaitHeading } from "./subAgentWait.ts"

const running = (id: string, over: Partial<ThreadView["subAgents"][number]> = {}) => ({ id, label: id, startedAt: "2026-09-29T10:00:00.000Z", state: "running" as const, ...over })
const back = (id: string) => ({ id, label: id, status: "completed" as const, finishedAt: "2026-09-29T10:03:00.000Z" })
const queued = (over: Partial<ThreadView> = {}) => ({
  kind: "session" as const, foreign: false, runtime: "turn-idle" as const, pendingQuestion: false, questions: [],
  lastFence: { kind: "awaiting" as const, body: "Waiting on the audits.", hints: [] },
  subAgents: [running("b"), running("c")], returnedSubAgents: [back("a")], ...over,
})

test("the heading counts the batch in place of a bare 'Awaiting'", () => {
  assert.equal(subAgentWaitHeading(subAgentWait(queued())!), "1 of 3 sub-agents returned")
  assert.equal(subAgentWaitHeading(subAgentWait(queued({ returnedSubAgents: [back("a"), back("b")], subAgents: [running("c")] }))!), "2 of 3 sub-agents returned")
  assert.equal(subAgentWaitHeading(subAgentWait(queued({ returnedSubAgents: undefined }))!), "Waiting on 2 sub-agents")
  assert.equal(subAgentWaitHeading(subAgentWait(queued({ returnedSubAgents: undefined, subAgents: [running("c")] }))!), "Waiting on 1 sub-agent")
  // A descendant is not a sibling in the batch: it neither counts nor opens the wait.
  assert.equal(subAgentWait(queued({ subAgents: [running("c"), running("g", { depth: 2 })] }))!.total, 2)
  assert.equal(subAgentWait(queued({ subAgents: [running("g", { depth: 2 })] })), undefined)
})

test("the card states the wait only at rest, with a child running, and nothing that outranks it", () => {
  assert.equal(showsSubAgentWait(queued()), true)
  // Negative controls, one reason each.
  assert.equal(showsSubAgentWait(queued({ subAgents: [running("b", { state: "stale" })] })), false, "nothing running")
  assert.equal(showsSubAgentWait(queued({ runtime: "running" })), false, "mid-turn")
  assert.equal(showsSubAgentWait(queued({ lastFence: { kind: "done", body: "", hints: [] } })), false, "a done handoff")
  assert.equal(showsSubAgentWait(queued({ pendingQuestion: true })), false, "a question")
  assert.equal(showsSubAgentWait(queued({ foreign: true })), false, "another tool's session")
})
