import assert from "node:assert/strict"
import test from "node:test"
import { closeFilePanel, openFilePanel, pushFileReader, resetProjectState, store } from "./store.ts"
import { SHEET_CLOSE_MS } from "./lib/sheet.ts"

test("split readers stack visits and only remove the closing instance", () => {
  const previous = globalThis.window
  const timers: { fn: () => void; delay: number }[] = []
  globalThis.window = {
    setTimeout: (fn: () => void, delay: number) => { timers.push({ fn, delay }); return timers.length },
    matchMedia: () => ({ matches: false }),
  } as unknown as Window & typeof globalThis
  try {
    store.splitFileViewer = true
    store.filePanels = []
    pushFileReader("/a.md")
    pushFileReader("/b.md")
    pushFileReader("/a.md")
    assert.deepEqual(store.filePanels.map((p) => p.path), ["/a.md", "/b.md", "/a.md"])
    const ids = store.filePanels.map((p) => p.id)
    assert.equal(new Set(ids).size, 3, "revisiting a path creates an independent reader")
    closeFilePanel()
    closeFilePanel()
    assert.equal(timers.length, 1, "repeated Escape during exit cannot pop the reader below")
    assert.equal(timers[0].delay, SHEET_CLOSE_MS)
    assert.equal(store.filePanels[2].closing, true)
    openFilePanel("/code.ts")
    timers.shift()!.fn()
    assert.deepEqual(store.filePanels.map((p) => p.path), ["/a.md", "/b.md", "/code.ts"])
    assert.deepEqual(store.filePanels.slice(0, 2).map((p) => p.id), ids.slice(0, 2))
    closeFilePanel()
    resetProjectState()
    openFilePanel("/new-project.md")
    timers.shift()!.fn()
    assert.deepEqual(store.filePanels.map((p) => p.path), ["/new-project.md"], "stale exit cannot remove a new project's reader")
  } finally {
    store.filePanels = []
    store.splitFileViewer = false
    globalThis.window = previous
  }
})

test("the queue still opens a file in the drawer stack", () => {
  store.splitFileViewer = false
  store.drawers = []
  try {
    pushFileReader("/queue.md")
    assert.equal(store.drawers.at(-1)?.kind, "file")
    assert.equal(store.filePanels.length, 0)
  } finally {
    store.drawers = []
  }
})
