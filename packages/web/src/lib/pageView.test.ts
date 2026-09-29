import assert from "node:assert/strict"
import { test } from "node:test"
import { ALL_PROJECTS, projectViewHref, resolveView, retiredProjectHref, sameView, viewHref, viewInSearch, viewSearch } from "./pageView.ts"

const card = (id: string, slug: string, stale = false) => ({ id, slug, stale })
const cards = [card("a", "acme"), card("b", "billing"), card("g", "gone", true)]

test("the address names a view: ?project=<slug>, ?all, or — from an older launcher — ?focus=<slug>", () => {
  assert.deepEqual(viewInSearch("?project=acme"), { kind: "project", slug: "acme" })
  assert.deepEqual(viewInSearch("?all"), ALL_PROJECTS)
  assert.deepEqual(viewInSearch("?focus=acme"), { kind: "project", slug: "acme" }, "a pre-2026-09-29 launcher's landing URL")
  assert.deepEqual(viewInSearch("?project=a%20b"), { kind: "project", slug: "a b" })
  assert.equal(viewInSearch(""), undefined)
  assert.equal(viewInSearch("?add=/tmp/x"), undefined, "a launcher's other queries name no view")
  assert.equal(viewInSearch("?project="), undefined)
})

test("a view round-trips through its own query", () => {
  for (const view of [ALL_PROJECTS, { kind: "project", slug: "acme" } as const, { kind: "project", slug: "a b/c" } as const]) {
    assert.ok(sameView(viewInSearch(viewSearch(view)), view), JSON.stringify(view))
  }
  assert.equal(viewHref(ALL_PROJECTS), "/?all")
  assert.equal(projectViewHref("acme"), "/?project=acme")
})

test("a bare / opens this tab's view, else the last project focused, else All projects", () => {
  assert.deepEqual(resolveView(cards, undefined, { kind: "project", slug: "billing" }, "a").view, { kind: "project", slug: "billing" }, "the tab's own wins over the browser's")
  assert.deepEqual(resolveView(cards, undefined, ALL_PROJECTS, "a").view, ALL_PROJECTS, "a tab showing All projects keeps showing it")
  assert.deepEqual(resolveView(cards, undefined, null, "a").view, { kind: "project", slug: "acme" }, "a fresh tab: the last project focused, by id")
  assert.deepEqual(resolveView(cards, undefined, null, null).view, ALL_PROJECTS, "nothing ever focused: All projects")
  assert.deepEqual(resolveView(cards, undefined, null, "g").view, ALL_PROJECTS, "the last focused project's directory is gone")
  assert.deepEqual(resolveView(cards, undefined, { kind: "project", slug: "renamed-away" }, "b").view, { kind: "project", slug: "billing" }, "a remembered slug that no longer resolves falls through")
})

test("a view the address names wins, and a slug nobody has is reported rather than swallowed", () => {
  assert.deepEqual(resolveView(cards, { kind: "project", slug: "acme" }, { kind: "project", slug: "billing" }, "b"), { view: { kind: "project", slug: "acme" } })
  assert.deepEqual(resolveView(cards, ALL_PROJECTS, { kind: "project", slug: "billing" }, "b"), { view: ALL_PROJECTS })
  assert.deepEqual(resolveView(cards, { kind: "project", slug: "gone" }, null, null).view, { kind: "project", slug: "gone" }, "asked for by name, a project whose directory is gone is still shown")
  assert.deepEqual(resolveView(cards, { kind: "project", slug: "typo" }, null, "a"), { view: { kind: "project", slug: "acme" }, unknown: "typo" })
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
