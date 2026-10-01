import assert from "node:assert/strict"
import test from "node:test"
import { queueReading, sidebarRoute } from "./embedRoute.ts"
import { phoneSubtitle } from "./phonePage.ts"

// What VS Code's title row says over an editor's sidebar (lib/embedRoute.ts). The poster's dedupe and its
// repost after ready need embed mode, so they are tested in embedMode.test.ts.

const base = { settings: false, thread: null, other: null, scope: "acme-api", reading: "1 needs you · 4 ready" }

test("the queue is named by its scope, with its counts beside it", () => {
  assert.deepEqual(sidebarRoute(base), { view: "queue", title: "acme-api", description: "1 needs you · 4 ready" })
  assert.deepEqual(sidebarRoute({ ...base, scope: "All projects" }).title, "All projects")
  // Still loading: the name alone, never a count that is not yet true.
  assert.deepEqual(sidebarRoute({ ...base, reading: null }), { view: "queue", title: "acme-api" })
})

test("an open thread is named by its title, and Settings wins over everything", () => {
  assert.deepEqual(sidebarRoute({ ...base, thread: "Split the constants" }), { view: "thread", title: "Split the constants" })
  assert.deepEqual(sidebarRoute({ ...base, thread: "Split the constants", settings: true }), { view: "settings", title: "Settings" })
  // A file opened over the page with no thread under it.
  assert.deepEqual(sidebarRoute({ ...base, other: "README.md" }), { view: "other", title: "README.md" })
})

test("the counts read as the phone header's line, in one tone", () => {
  assert.equal(queueReading(phoneSubtitle({ asks: 1, ready: 4, working: 1 })), "1 needs you · 4 ready · 1 working")
  assert.equal(queueReading(phoneSubtitle({ asks: 2, ready: 0, working: 0 })), "2 need you")
  assert.equal(queueReading(phoneSubtitle({ asks: 0, ready: 0, working: 0 })), "Nothing needs you")
})
