import { test } from "node:test"
import assert from "node:assert/strict"
import { RECENT_MS, recentOf, resetRecentThreads, touchThread } from "./recentThreads.ts"

test("recentOf keeps threads touched within the window, most recent first", () => {
  resetRecentThreads()
  touchThread("a", 1_000)
  touchThread("b", 2_000)
  touchThread("old", 0)
  const now = RECENT_MS + 500
  assert.deepEqual(recentOf(["a", "old", "c", "b"], (k) => k, now), ["b", "a"])
})
