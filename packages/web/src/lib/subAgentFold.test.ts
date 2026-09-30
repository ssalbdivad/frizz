import assert from "node:assert/strict"
import test from "node:test"
import { subAgentFold } from "./subAgentFold.ts"

const child = (label: string, over: { state?: string; depth?: number; workflow?: boolean; startedAt?: string } = {}) => ({
  label,
  state: over.state ?? "running",
  depth: over.depth,
  workflow: over.workflow,
  startedAt: over.startedAt,
})

test("the fold counts direct children, naming sub-agents and workflows apart", () => {
  assert.equal(subAgentFold([child("fix:r1")]).label, "1 sub-agent")
  assert.equal(subAgentFold([child("fix:r1"), child("fix:r2"), child("review")]).label, "3 sub-agents")
  assert.equal(subAgentFold([child("slow-flow", { workflow: true })]).label, "1 workflow")
  assert.equal(
    subAgentFold([child("a"), child("b"), child("flow", { workflow: true }), child("flow-agent", { depth: 2 })]).label,
    "2 sub-agents, 1 workflow",
    "a workflow's own agent is inside the workflow already counted",
  )
})

test("the fold spins while anything under it runs, at any depth", () => {
  assert.equal(subAgentFold([child("a", { state: "stale" }), child("b", { state: "running" })]).state, "running")
  // A rested direct child is listed only because work under it still runs (tailer anchorRoots).
  assert.equal(subAgentFold([child("a", { state: "rested" }), child("a1", { depth: 2, state: "running" })]).state, "running")
  assert.equal(subAgentFold([child("a", { state: "stale" }), child("b", { state: "stale" })]).state, "stale")
})

test("the fold's age is the batch's: its earliest direct dispatch", () => {
  const fold = subAgentFold([
    child("late", { startedAt: "2026-09-29T12:10:00.000Z" }),
    child("early", { startedAt: "2026-09-29T12:01:00.000Z" }),
    child("nested", { depth: 2, startedAt: "2026-09-29T11:00:00.000Z" }),
    child("unknown"),
  ])
  assert.equal(fold.startedAt, "2026-09-29T12:01:00.000Z")
  assert.equal(fold.names, "late, early, unknown", "the tooltip names what the fold hides, direct children only")
})

test("descendants with no direct child listed still count as themselves", () => {
  assert.equal(subAgentFold([child("orphan-a", { depth: 2 }), child("orphan-b", { depth: 2 })]).label, "2 sub-agents")
})
