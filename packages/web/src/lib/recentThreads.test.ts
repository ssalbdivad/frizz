import { test } from "node:test"
import assert from "node:assert/strict"
import { RECENT_MS, recentOf, resetRecentThreads, touchThread } from "./recentThreads.ts"

test("recentOf keeps threads touched within the window, most recent first", () => {
  resetRecentThreads()
  touchThread("p:a", 1_000)
  touchThread("p:b", 2_000)
  touchThread("p:old", 0)
  const now = RECENT_MS + 500
  assert.deepEqual(recentOf(["p:a", "p:old", "p:c", "p:b"], (k) => k, now), ["p:b", "p:a"])
})
