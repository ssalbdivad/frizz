import { test } from "node:test"
import assert from "node:assert/strict"
import { readingLine } from "./readingLine.ts"

const VH = 900

test("far from the bottom the line sits a third of the way down", () => {
  assert.equal(readingLine(VH, 0, 5000), 300)
  assert.equal(readingLine(VH, 5000 - VH - 600, 5000), 300)
})

test("scrolled to the bottom the line reaches the bottom edge, so the last card is read", () => {
  assert.equal(readingLine(VH, 5000 - VH, 5000), VH)
  // Overscroll (rubber-banding) never pushes it past.
  assert.equal(readingLine(VH, 5000 - VH + 40, 5000), VH)
})

test("the line slides over the last two-thirds of a viewport of scroll", () => {
  assert.equal(readingLine(VH, 5000 - VH - 300, 5000), 600)
})

test("a page that does not scroll keeps the line a third of the way down", () => {
  assert.equal(readingLine(VH, 0, VH), 300)
  assert.equal(readingLine(VH, 0, 400), 300)
})

test("a page with little scroll slides over what it has", () => {
  // 100px of scroll: halfway down is halfway along the slide.
  assert.equal(readingLine(VH, 50, VH + 100), 600)
  assert.equal(readingLine(VH, 100, VH + 100), VH)
})
