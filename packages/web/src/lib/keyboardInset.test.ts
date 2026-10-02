import { test } from "node:test"
import assert from "node:assert/strict"
import { keyboardInsetFrom } from "./keyboardInset.ts"

// A 390×844 phone. The bar's panel is pinned to the bottom of the layout viewport (844).
const visual = (height: number, offsetTop = 0, scale = 1) => ({ height, offsetTop, scale })

test("no keyboard: the visual viewport reaches the panel's bottom, so the bar stays put", () => {
  assert.equal(keyboardInsetFrom({ pinnedBottom: 844, visual: visual(844) }), 0)
})

test("a keyboard that shrinks only the visual viewport lifts the bar by exactly what it covers", () => {
  // Android Chrome (resizes-visual) and iOS Safari before any pan: 336px of keyboard.
  assert.equal(keyboardInsetFrom({ pinnedBottom: 844, visual: visual(508) }), 336)
})

test("an iOS pan that scrolled the visual viewport down is subtracted, not double-counted", () => {
  // iOS moved the visible band 120px down to reveal the field: the keyboard now covers 216px of it.
  assert.equal(keyboardInsetFrom({ pinnedBottom: 844, visual: visual(508, 120) }), 216)
})

test("a pinch zoom is not a keyboard", () => {
  assert.equal(keyboardInsetFrom({ pinnedBottom: 844, visual: visual(422, 0, 2) }), 0)
})

test("a toolbar-sized sliver is noise, never a keyboard; and no visual viewport means no inset", () => {
  assert.equal(keyboardInsetFrom({ pinnedBottom: 844, visual: visual(800) }), 0)
  assert.equal(keyboardInsetFrom({ pinnedBottom: 844, visual: null }), 0)
})

test("a browser that shrinks the layout itself (resizes-content) reads 0 — the panel already moved", () => {
  assert.equal(keyboardInsetFrom({ pinnedBottom: 508, visual: visual(508) }), 0)
})
