import assert from "node:assert/strict"
import test from "node:test"
import { agentTerminalEmpty } from "./TerminalSheet.tsx"

// WHAT AN AGENT TERMINAL'S DRAWER SAYS IN PLACE OF ITS LOG. Each of these was a wrong sentence once.

test("a running shell whose named log is gone says so, rather than waiting for output that cannot come", () => {
  // Verified 2026-09-29: tasks/<id>.output deleted under a running shell, the RPC said `missing`, and the
  // drawer promised "Waiting for the first output…" because it asked `running` first.
  assert.equal(agentTerminalEmpty({ state: "running", missing: true }, false, 0), "The output file is gone.")
  assert.equal(agentTerminalEmpty({ state: "done", missing: true }, false, 0), "The output file is gone.")
  // Nothing named yet (between the launch and its ack, or a Monitor that has printed nothing): waiting.
  assert.equal(agentTerminalEmpty({ state: "running" }, false, 0), "Waiting for the first output…")
  assert.equal(agentTerminalEmpty({ state: "done" }, false, 0), "No output was captured.")
})

test("output already on screen is never replaced", () => {
  assert.equal(agentTerminalEmpty({ state: "running", missing: true }, false, 120), undefined, "a vanished log keeps the lines an open pane holds")
  assert.equal(agentTerminalEmpty({ state: "running" }, true, 120), undefined)
  // Not by a later `gone` either (the retired ring moved on, a re-register hid it for a tick): that unmounted
  // the xterm with its log and put "This terminal is closed." in its place.
  assert.equal(agentTerminalEmpty({ state: "gone" }, false, 120), undefined)
})

test("a poll that keeps failing before any reply says so", () => {
  assert.equal(agentTerminalEmpty(undefined, false, 0), "Waiting for the first output…")
  assert.equal(agentTerminalEmpty(undefined, true, 0), "Could not read this terminal's output. Retrying…")
})

test("gone and Codex take their own words", () => {
  assert.equal(agentTerminalEmpty({ state: "gone" }, false, 0), "This terminal is closed.")
  assert.equal(agentTerminalEmpty({ state: "running", outputUnavailable: true }, false, 0), "Codex hands this command's output to the agent when it checks in, so Frizz can't show it here.")
})
