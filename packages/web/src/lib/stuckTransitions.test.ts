import assert from "node:assert/strict"
import test from "node:test"
import { sweepTransitions, type TransitionLike } from "./stuckTransitions.ts"

// lib/stuckTransitions.ts: a CSS transition the browser never started is finished, a sweep after it was first seen pending.

function transition(state: Partial<TransitionLike> = {}): TransitionLike & { finished: number } {
  return {
    pending: true,
    playState: "running",
    finished: 0,
    ...state,
    finish() {
      this.finished++
      this.pending = false
      this.playState = "finished"
    },
  }
}

test("a transition seen pending on two sweeps is finished; one seen once is only remembered", () => {
  const stuck = transition()
  const first = sweepTransitions([stuck], new Set())
  assert.equal(stuck.finished, 0, "a transition just created starts on the next frame: not touched yet")
  assert.ok(first.has(stuck))
  const second = sweepTransitions([stuck], first)
  assert.equal(stuck.finished, 1, "still pending a sweep later: the browser lost it")
  assert.equal(second.size, 0)
})

test("a transition that started between sweeps is left to run", () => {
  const sliding = transition()
  const first = sweepTransitions([sliding], new Set())
  sliding.pending = false
  sweepTransitions([sliding], first)
  assert.equal(sliding.finished, 0)
})

test("a new transition on the same element is judged on its own, not by the one it replaced", () => {
  const replaced = transition()
  const first = sweepTransitions([replaced], new Set())
  const fresh = transition()
  sweepTransitions([fresh], first)
  assert.equal(fresh.finished, 0, "first seen now")
})

test("paused, finished and idle transitions are never touched", () => {
  const paused = transition({ playState: "paused" })
  const idle = transition({ playState: "idle" })
  const first = sweepTransitions([paused, idle], new Set([paused, idle]))
  assert.equal(paused.finished + idle.finished, 0)
  assert.equal(first.size, 0)
})
