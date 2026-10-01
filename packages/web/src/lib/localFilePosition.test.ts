import { test } from "node:test"
import assert from "node:assert/strict"
import { localPositionAttrs, localPositionOf } from "./localFilePosition.ts"

// An element as far as these helpers read one: its attributes, by name.
function element(attrs: Record<string, string>): Element {
  return { getAttribute: (name: string) => attrs[name] ?? null } as unknown as Element
}

test("a position round-trips through the data attributes", () => {
  for (const position of [{ line: 12 }, { line: 12, column: 3 }, { line: 12, endLine: 20 }, { line: 1, column: 1, endLine: 2 }]) {
    assert.deepEqual(localPositionOf(element(localPositionAttrs(position))), position)
  }
  assert.deepEqual(localPositionAttrs(undefined), {})
  assert.equal(localPositionOf(null), undefined)
  assert.equal(localPositionOf(element({})), undefined)
})

// The attributes survive the sanitizer, so an author's raw HTML can set them: anything malformed must
// read as "no line" (or no column, no range) rather than reach the opener as NaN, 0 or an inverted range.
test("a malformed attribute is refused, not passed on", () => {
  assert.equal(localPositionOf(element({ "data-local-line": "0" })), undefined)
  assert.equal(localPositionOf(element({ "data-local-line": "-3" })), undefined)
  assert.equal(localPositionOf(element({ "data-local-line": "1e3" })), undefined)
  assert.equal(localPositionOf(element({ "data-local-line": "" })), undefined)
  assert.deepEqual(localPositionOf(element({ "data-local-line": "8", "data-local-col": "nope" })), { line: 8 })
  assert.deepEqual(localPositionOf(element({ "data-local-line": "8", "data-local-end-line": "3" })), { line: 8 })
  assert.deepEqual(localPositionOf(element({ "data-local-line": "8", "data-local-end-line": "8" })), { line: 8 })
  // An end line equal to the start is no range, so it is never written either.
  assert.deepEqual(localPositionAttrs({ line: 8, endLine: 8 }), { "data-local-line": "8" })
})
