import assert from "node:assert/strict"
import { test } from "node:test"
import { ALL_PROJECTS, projectViewHref, resolveView, retiredProjectHref, sameView, viewAt, viewHref, viewInSearch, viewSearch } from "./pageView.ts"

const cards = [{ slug: "acme" }, { slug: "billing" }, { slug: "gone" }]

test("the address names a view: ?project=<slug>, a retired ?all, or — from an older launcher — ?focus=<slug>", () => {
  assert.deepEqual(viewInSearch("?project=acme"), { kind: "project", slug: "acme" })
  assert.deepEqual(viewInSearch("?all"), ALL_PROJECTS, "All projects' address until 2026-09-30")
  assert.deepEqual(viewInSearch("?focus=acme"), { kind: "project", slug: "acme" }, "a pre-2026-09-29 launcher's landing URL")
  assert.deepEqual(viewInSearch("?project=a%20b"), { kind: "project", slug: "a b" })
  assert.equal(viewInSearch(""), undefined)
  assert.equal(viewInSearch("?add=/tmp/x"), undefined, "a launcher's other queries name no view")
  assert.equal(viewInSearch("?project="), undefined)
})

test("All projects is bare /, and a focused view round-trips through its own query", () => {
  assert.equal(viewHref(ALL_PROJECTS), "/")
  assert.deepEqual(viewAt("/", ""), ALL_PROJECTS)
  assert.deepEqual(viewAt("/", "?add=/tmp/x"), ALL_PROJECTS)
  for (const view of [{ kind: "project", slug: "acme" } as const, { kind: "project", slug: "a b/c" } as const]) {
    assert.ok(sameView(viewInSearch(viewSearch(view)), view), JSON.stringify(view))
  }
  assert.equal(projectViewHref("acme"), "/?project=acme")
})

test("a drawer with no view in its address shows its own project in a fresh tab", () => {
  assert.deepEqual(viewAt("/all/acme/thread/fix-x", ""), { kind: "project", slug: "acme" })
  assert.deepEqual(viewAt("/all/acme/thread/fix-x", "?project=billing"), { kind: "project", slug: "billing" })
})

test("a bare / is All projects, and a slug nobody has is reported rather than swallowed", () => {
  assert.deepEqual(resolveView(cards, undefined), { view: ALL_PROJECTS })
  assert.deepEqual(resolveView(cards, ALL_PROJECTS), { view: ALL_PROJECTS })
  assert.deepEqual(resolveView(cards, { kind: "project", slug: "acme" }), { view: { kind: "project", slug: "acme" } })
  assert.deepEqual(resolveView(cards, { kind: "project", slug: "typo" }), { view: ALL_PROJECTS, unknown: "typo" })
})

test("a retired /project/<slug> address lands focused on its project", () => {
  assert.equal(retiredProjectHref("/project/acme"), "/?project=acme")
  assert.equal(retiredProjectHref("/project/acme/"), "/?project=acme")
  assert.equal(retiredProjectHref("/project/acme/status/active"), "/?project=acme")
  assert.equal(retiredProjectHref("/project/acme/thread/fix-x"), "/all/acme/thread/fix-x?project=acme")
  assert.equal(retiredProjectHref("/project/acme/thread/fix-x/full"), "/all/acme/thread/fix-x/full")
  assert.equal(retiredProjectHref("/projects"), undefined)
  assert.equal(retiredProjectHref("/status/active"), undefined)
  assert.equal(retiredProjectHref("/"), undefined)
})

test("a tab on All projects stays on it across a reload with a drawer open", async () => {
  const store = new Map<string, string>()
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) }
  const saved = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage")
  Object.defineProperty(globalThis, "sessionStorage", { value: storage, configurable: true })
  try {
    const before = await import("./pageView.ts?before-reload")
    before.rememberTabView(before.ALL_PROJECTS)
    // A fresh module instance is a reload: its in-memory copy is gone, only sessionStorage survives.
    const after = await import("./pageView.ts?after-reload")
    assert.deepEqual(after.viewAt("/all/frizz/thread/x", ""), ALL_PROJECTS)
    before.rememberTabView({ kind: "project", slug: "nub" })
    const again = await import("./pageView.ts?after-second-reload")
    assert.deepEqual(again.viewAt("/all/frizz/thread/x", ""), { kind: "project", slug: "nub" })
  } finally {
    if (saved) Object.defineProperty(globalThis, "sessionStorage", saved)
    else delete (globalThis as { sessionStorage?: unknown }).sessionStorage
  }
})
