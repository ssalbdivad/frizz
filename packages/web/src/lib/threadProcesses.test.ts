import assert from "node:assert/strict"
import test from "node:test"
import type { BgShellView, ThreadTerminal } from "@frizz/shared"
import { threadProcesses } from "./threadProcesses.ts"

// ONE LIST for every process on a thread — yours and the agent's — in the order every surface draws it.

const at = (mm: string) => `2026-09-29T10:${mm}:00.000Z`
const NOW = Date.parse(at("30"))
const term = (over: Partial<ThreadTerminal>): ThreadTerminal => ({ id: "term", command: "npm run dev", cwd: "/repo", state: "running", runId: 1, startedAt: at("00"), ...over })
const shell = (over: Partial<BgShellView>): BgShellView => ({ label: "vite dev server", startedAt: at("00"), state: "running", ...over })

test("a prompt leads; the live rows of both owners interleave oldest first; your finished ones trail, newest first", () => {
  const list = threadProcesses({
    terminals: [
      term({ id: "done-old", state: "exited", exitCode: 0, startedAt: at("01"), exitedAt: at("02") }),
      term({ id: "live", startedAt: at("05") }),
      term({ id: "asking", awaitingInput: true, startedAt: at("20") }),
      term({ id: "done-new", state: "exited", exitCode: 1, startedAt: at("03"), exitedAt: at("09") }),
    ],
    bgShells: [shell({ id: "s-late", startedAt: at("10") }), shell({ id: "s-early", startedAt: at("04"), state: "stale" })],
  }, [], { now: NOW })
  assert.deepEqual(list.map((p) => [p.key, p.owner, p.state]), [
    ["t:asking", "human", "prompt"],
    ["s:s-early", "agent", "quiet"],
    ["t:live", "human", "running"],
    ["s:s-late", "agent", "running"],
    ["t:done-new", "human", "failed"],
    ["t:done-old", "human", "finished"],
  ])
})

test("a finished agent shell is not listed — it leaves the board, and its drawer resolves from the server", () => {
  // The board never sends a finished shell; only running and stale ones exist on the wire.
  const list = threadProcesses({ bgShells: [shell({ id: "a" })] }, [], { now: NOW })
  assert.deepEqual(list.map((p) => p.key), ["s:a"])
  assert.equal(list.some((p) => p.owner === "agent" && (p.state === "finished" || p.state === "failed")), false)
})

test("a Codex exec's board row and its transcript copy are ONE row, and the copy's folder fills in", () => {
  const board = shell({ id: "p1", label: "nub test --watch", command: "nub test --watch", stoppable: true, outputUnavailable: true })
  const transcript = [{ label: "Watching the tests", startedAt: at("01"), state: "running" as const, command: "nub test --watch", cwd: "/repo/.frizz/worktrees/cx" }]
  const list = threadProcesses({ bgShells: [board] }, transcript, { now: NOW })
  assert.equal(list.length, 1)
  assert.equal(list[0]!.key, "s:p1")
  assert.equal(list[0]!.cwd, "/repo/.frizz/worktrees/cx")
  assert.equal(list[0]!.outputUnavailable, true)
})

test("a sub-agent's strip lists that child's own shells and none of yours", () => {
  const list = threadProcesses(
    { terminals: [term({ id: "mine" })], bgShells: [shell({ id: "parents" })] },
    [{ label: "child's watcher", startedAt: at("01"), state: "running", launchId: "toolu_child" }],
    { now: NOW, scopedToSubAgent: true },
  )
  assert.deepEqual(list.map((p) => [p.key, p.owner]), [["s:toolu_child", "agent"]])
})

test("a row carries what its surfaces read: the checkout, the budget, the monitor flag", () => {
  const [agent, human] = threadProcesses({
    terminals: [term({ id: "t", startedAt: at("10"), checkout: { dir: "/repo/.frizz/worktrees/x", kind: "worktree" } })],
    bgShells: [shell({ id: "m", monitor: true, cwd: "/repo", budgetEndsAt: at("45") })],
  }, [], { now: NOW })
  assert.equal(agent!.monitor, true)
  assert.equal(agent!.budget?.text, "15m left")
  assert.equal(agent!.checkout, undefined, "the root carries no checkout")
  assert.deepEqual(human!.checkout, { dir: "/repo/.frizz/worktrees/x", kind: "worktree" })
})
