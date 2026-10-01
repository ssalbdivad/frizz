import assert from "node:assert/strict"
import test from "node:test"
import { subAgentFold } from "./subAgentFold.ts"

const child = (label: string, over: { state?: string; depth?: number; workflow?: boolean } = {}) => ({
  label,
  state: over.state ?? "running",
  depth: over.depth,
  workflow: over.workflow,
})

test("the fold counts every row it opens to, at every depth", () => {
  assert.equal(subAgentFold([child("fix:r1")]).label, "1 sub-agent")
  assert.equal(subAgentFold([child("fix:r1"), child("fix:r2"), child("review")]).label, "3 sub-agents")
  assert.equal(subAgentFold([child("slow-flow", { workflow: true })]).label, "1 sub-agent")
  assert.equal(
    subAgentFold([child("flow", { workflow: true }), child("a", { depth: 2 }), child("b", { depth: 2 }), child("c", { depth: 3 })]).label,
    "4 sub-agents",
    "a workflow's agents and their own children are counted, not hidden inside it",
  )
})

test("the fold spins while anything under it runs, at any depth", () => {
  assert.equal(subAgentFold([child("a", { state: "stale" }), child("b", { state: "running" })]).state, "running")
  // A rested direct child is listed only because work under it still runs (tailer anchorRoots).
  assert.equal(subAgentFold([child("a", { state: "rested" }), child("a1", { depth: 2, state: "running" })]).state, "running")
  assert.equal(subAgentFold([child("a", { state: "stale" }), child("b", { state: "stale" })]).state, "stale")
})

test("the fold's tooltip names the direct children it hides, by the handles their rows show", () => {
  assert.equal(subAgentFold([child("fix:r1"), child("fix:r2"), child("nested", { depth: 2 })]).names, "fix-r1, fix-r2")
  // A sentence has no handle, so it is named as written — the same fallback its own row takes.
  assert.equal(subAgentFold([child("Cache keys"), child("Verify goal caps on a real stack")]).names, "cache-keys, Verify goal caps on a real stack")
})

test("descendants with no direct child listed still count as themselves", () => {
  assert.equal(subAgentFold([child("orphan-a", { depth: 2 }), child("orphan-b", { depth: 2 })]).label, "2 sub-agents")
})
