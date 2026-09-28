import assert from "node:assert/strict"
import { test } from "node:test"
import { defaultCrossProjectFocus, stepPick } from "./crossProject.ts"

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

const project = (slug: string, open = true, stale = false) => ({ slug, open, stale })

test("⌥↓ / ⌥↑ step the box through the picker's order, wrapping round at either end", () => {
  const projects = [project("a"), project("b"), project("c")]
  assert.equal(stepPick(projects, "a", 1)?.slug, "b")
  assert.equal(stepPick(projects, "c", 1)?.slug, "a")
  assert.equal(stepPick(projects, "b", -1)?.slug, "a")
  assert.equal(stepPick(projects, "a", -1)?.slug, "c")
  // A focus the list does not hold yet (a project registered a moment ago) steps onto an end.
  assert.equal(stepPick(projects, "gone", 1)?.slug, "a")
  assert.equal(stepPick(projects, "gone", -1)?.slug, "c")
  assert.equal(stepPick(projects, undefined, 1)?.slug, "a")
})

test("a step passes over a project that cannot take the draft it carries", () => {
  const projects = [project("a"), project("b", false), project("c", true, true), project("d")]
  assert.equal(stepPick(projects, "a", 1)?.slug, "d", "not open, then a directory that is gone")
  assert.equal(stepPick(projects, "d", -1)?.slug, "a")
  assert.equal(stepPick(projects, "d", 1)?.slug, "a")
  // A focus that is not open itself (chosen from the menu) still steps on to one that is.
  assert.equal(stepPick(projects, "b", 1)?.slug, "d")
  assert.equal(stepPick(projects, "b", -1)?.slug, "a")
})

test("with nowhere else to go, the key is left to the browser", () => {
  assert.equal(stepPick([project("a")], "a", 1), undefined)
  assert.equal(stepPick([project("a"), project("b", false)], "a", -1), undefined)
  assert.equal(stepPick([], undefined, 1), undefined)
})
