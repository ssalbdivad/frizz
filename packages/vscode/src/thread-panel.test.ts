import { test } from "node:test"
import assert from "node:assert/strict"
import { restoredTarget } from "./thread-panel.ts"

test("a tab is restored from the names its relay kept, and from nothing else", () => {
  assert.deepEqual(restoredTarget({ project: "acme-api", thread: "fix-login" }), { project: "acme-api", thread: "fix-login" })
  assert.deepEqual(restoredTarget({ project: "acme-api", thread: "fix-login", extra: "<b>" }), { project: "acme-api", thread: "fix-login" }, "only the names")
  assert.equal(restoredTarget({ project: "acme-api" }), undefined, "a tab that showed no thread is not reopened")
  assert.equal(restoredTarget({ project: "../etc", thread: "x" }), undefined)
  assert.equal(restoredTarget(undefined), undefined)
  assert.equal(restoredTarget("acme-api/fix-login"), undefined)
})
