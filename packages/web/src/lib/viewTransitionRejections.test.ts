import { test } from "node:test"
import assert from "node:assert/strict"
import { isAbandonedViewTransition } from "./viewTransitionRejections.ts"

test("a view transition the browser timed out or skipped is not reported", () => {
  assert.equal(isAbandonedViewTransition(new DOMException("Transition was aborted because of timeout in DOM update", "TimeoutError")), true)
  assert.equal(isAbandonedViewTransition(new DOMException("Transition was skipped", "AbortError")), true)
})

test("everything else still is", () => {
  // A duplicate view-transition-name is an authoring mistake, not the browser's call.
  assert.equal(isAbandonedViewTransition(new DOMException("Unexpected duplicate view-transition-name: thread-chat", "InvalidStateError")), false)
  assert.equal(isAbandonedViewTransition(new DOMException("The user aborted a request.", "AbortError")), false)
  assert.equal(isAbandonedViewTransition(new DOMException("signal timed out", "TimeoutError")), false)
  assert.equal(isAbandonedViewTransition(new Error("Transition was skipped")), false)
  assert.equal(isAbandonedViewTransition(undefined), false)
})
