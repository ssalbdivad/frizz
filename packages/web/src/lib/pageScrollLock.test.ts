import assert from "node:assert/strict"
import test from "node:test"
import { clampPin, isPageScrollLocked, pageScrollY } from "./pageScrollLock.ts"

function withDom<T>(body: { style: { position?: string; top?: string } }, scrollY: number, fn: () => T): T {
  const globals = globalThis as typeof globalThis & { window?: Window; document?: Document }
  const previous = { window: globals.window, document: globals.document }
  try {
    globals.document = { body } as unknown as Document
    globals.window = { scrollY } as unknown as Window
    return fn()
  } finally {
    globals.window = previous.window
    globals.document = previous.document
  }
}

test("pageScrollY reads window.scrollY on an unlocked page", () => {
  withDom({ style: { position: "", top: "" } }, 940, () => {
    assert.equal(isPageScrollLocked(), false)
    assert.equal(pageScrollY(), 940)
  })
})

// The whole reason this module exists: App pins `body{position:fixed; top:-y}` while an overlay is
// open, and window.scrollY then reads 0 no matter how far the reader had scrolled. Measuring a queue
// card's landing off that 0 lands every scroll short by exactly y.
test("pageScrollY reads the lock's own offset while the page is pinned", () => {
  withDom({ style: { position: "fixed", top: "-1740px" } }, 0, () => {
    assert.equal(isPageScrollLocked(), true)
    assert.equal(pageScrollY(), 1740)
  })
})

// A lock applied at the very top writes `top: -0px`; -(-0) is 0, not NaN, and must not fall back.
test("pageScrollY handles a lock taken at the top of the page", () => {
  withDom({ style: { position: "fixed", top: "-0px" } }, 0, () => assert.equal(pageScrollY(), 0))
})

// A page that shrank under the pin (a long card left the queue behind a drawer) holds the pin at its end,
// as a native scroll would; one shorter than the window pins at the top.
test("clampPin holds a pin within the page", () => {
  assert.equal(clampPin(-1200, 3000, 900), -1200)
  assert.equal(clampPin(-2600, 3000, 900), -2100)
  assert.equal(clampPin(-400, 600, 900), 0)
  assert.equal(clampPin(20, 3000, 900), 0)
})
