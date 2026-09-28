import assert from "node:assert/strict"
import { test } from "node:test"
import { defaultCrossProjectFocus, nextPick } from "./crossProject.ts"

const card = (id: string, lastOpenedAt: string, stale = false) => ({ id, slug: `${id}-slug`, stale, lastOpenedAt })

test("/ focuses the project this browser was last focused on", () => {
  const cards = [card("a", "2026-09-24T10:00:00Z"), card("b", "2026-09-20T10:00:00Z")]
  assert.equal(defaultCrossProjectFocus(cards, "b"), "b-slug")
})

test("without a usable memory, / focuses the most recently opened project", () => {
  const cards = [card("a", "2026-09-20T10:00:00Z"), card("b", "2026-09-24T10:00:00Z"), card("c", "2026-09-22T10:00:00Z")]
  assert.equal(defaultCrossProjectFocus(cards, null), "b-slug")
  // A remembered project that has since been removed is not a reason to land nowhere.
  assert.equal(defaultCrossProjectFocus(cards, "gone"), "b-slug")
})

test("a project whose directory is gone is never the focus", () => {
  const cards = [card("a", "2026-09-24T10:00:00Z", true), card("b", "2026-09-20T10:00:00Z")]
  assert.equal(defaultCrossProjectFocus(cards, "a"), "b-slug", "remembered but stale")
  assert.equal(defaultCrossProjectFocus(cards, null), "b-slug", "most recent but stale")
  assert.equal(defaultCrossProjectFocus([card("a", "2026-09-24T10:00:00Z", true)], null), undefined)
  assert.equal(defaultCrossProjectFocus([], null), undefined)
})

test("a project this server has not opened is not landed on while an open one exists", () => {
  const cards = [card("a", "2026-09-24T10:00:00Z"), card("b", "2026-09-20T10:00:00Z")]
  assert.equal(defaultCrossProjectFocus(cards, "a", new Set(["b"])), "b-slug", "remembered but not open")
  assert.equal(defaultCrossProjectFocus(cards, null, new Set(["b"])), "b-slug", "most recent but not open")
  // Nothing open yet (a boot still opening them): land as if the list were unknown.
  assert.equal(defaultCrossProjectFocus(cards, "b", new Set()), "b-slug")
  assert.equal(defaultCrossProjectFocus(cards, null, new Set()), "a-slug")
})

// The Home workspace is on every machine and was never "opened" in a terminal. Falling back to it would
// mean an empty machine never shows the welcome page that adds its first project.
test("the Home workspace is focused only when chosen", () => {
  const home = { id: "home-id", slug: "home", stale: false, lastOpenedAt: "1970-01-01T00:00:00.000Z", home: true as const }
  assert.equal(defaultCrossProjectFocus([home], null), undefined, "an empty machine still welcomes")
  assert.equal(defaultCrossProjectFocus([home], "home-id"), "home", "chosen, it is the focus")
  // Even one opened more recently than every project — the timestamp is not what excludes it.
  const recent = { ...home, lastOpenedAt: "2026-09-28T10:00:00Z" }
  assert.equal(defaultCrossProjectFocus([card("a", "2026-09-20T10:00:00Z"), recent], null), "a-slug")
  assert.equal(defaultCrossProjectFocus([card("a", "2026-09-20T10:00:00Z"), recent], "home-id", new Set(["home-id"])), "home")
})

const project = (slug: string, open = true, stale = false) => ({ slug, open, stale })

test("⇧Tab moves the box to the next project in the picker's order, wrapping at the end", () => {
  const projects = [project("a"), project("b"), project("c")]
  assert.equal(nextPick(projects, "a")?.slug, "b")
  assert.equal(nextPick(projects, "c")?.slug, "a")
  // A focus the list does not hold yet (a project registered a moment ago) steps onto the first.
  assert.equal(nextPick(projects, "gone")?.slug, "a")
  assert.equal(nextPick(projects, undefined)?.slug, "a")
})

test("⇧Tab passes over a project that cannot take the draft it carries", () => {
  const projects = [project("a"), project("b", false), project("c", true, true), project("d")]
  assert.equal(nextPick(projects, "a")?.slug, "d", "not open, then a directory that is gone")
  assert.equal(nextPick(projects, "d")?.slug, "a")
  // A focus that is not open itself (chosen from the menu) still steps on to one that is.
  assert.equal(nextPick(projects, "b")?.slug, "d")
})

test("with nowhere else to go, ⇧Tab is left to the browser", () => {
  assert.equal(nextPick([project("a")], "a"), undefined)
  assert.equal(nextPick([project("a"), project("b", false)], "a"), undefined)
  assert.equal(nextPick([], undefined), undefined)
})
