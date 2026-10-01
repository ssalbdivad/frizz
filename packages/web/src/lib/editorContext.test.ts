import assert from "node:assert/strict"
import { test } from "node:test"
import { ADD_CONTEXT_WINDOW_MS, contextBarReading, editorAddChord, editorContext, pendingBox, requestEditorContext, setEditorContext, takePendingAdd, type ContextBox } from "./editorContext.ts"
import { contextChipLabel } from "./composerContext.ts"

const file = { path: "/work/alpha/src/lib/r2-private.ts", label: "src/lib/r2-private.ts" }

test("the bar reads the selection as the chip it will make, with its size", () => {
  const reading = contextBarReading({ ...file, selection: { startLine: 91, endLine: 116, chars: 900 } })
  assert.deepEqual(reading, { kind: "selection", name: "r2-private.ts", range: ":91-116", count: "26 lines", where: "src/lib/r2-private.ts" })
  // The name and range are the chip's label, split so the name can truncate alone.
  assert.equal(`${reading!.name}${reading!.range}`, contextChipLabel({ path: file.path, startLine: 91, endLine: 116 }))
  assert.deepEqual(contextBarReading({ ...file, selection: { startLine: 7, endLine: 7, chars: 3 } }), { kind: "selection", name: "r2-private.ts", range: ":7", count: "1 line", where: "src/lib/r2-private.ts" })
})

test("a file with nothing selected is the file alone; no editor is no reading", () => {
  assert.deepEqual(contextBarReading(file), { kind: "file", name: "r2-private.ts", range: "", where: "src/lib/r2-private.ts" })
  // A label with Windows separators still reads its basename.
  assert.equal(contextBarReading({ path: "C:\\w\\a.ts", label: "src\\a.ts" })?.name, "a.ts")
  assert.equal(contextBarReading(null), null)
})

test("the editor's add chord is spelled the way every other shortcut is, per platform", () => {
  assert.equal(editorAddChord("mac"), "⌘I")
  assert.equal(editorAddChord("other"), "Ctrl+I")
})

test("a new editor context replaces the last one whole", () => {
  setEditorContext({ type: "frizz:editor-context", active: { ...file, selection: { startLine: 1, endLine: 2, chars: 5 } }, open: [{ path: "/w/b.ts", label: "b.ts" }] })
  assert.equal(editorContext.open.length, 1)
  setEditorContext({ type: "frizz:editor-context", active: null, open: [] })
  assert.equal(editorContext.active, null)
  assert.deepEqual(editorContext.open, [])
})

// A click on a bar asks the host, and the host's answer is aimed at "front": it must land in the box
// whose bar was clicked — and only an answer that follows the click closely enough to be its answer.
test("a host's answer goes back to the box that asked, within the window only", () => {
  const box: ContextBox = { key: "followUp:/w:fix:s1", projectDir: "/w", surface: "chatComposer" }
  const at = 1_000_000
  assert.equal(pendingBox({ box, at }, at), box)
  assert.equal(pendingBox({ box, at }, at + ADD_CONTEXT_WINDOW_MS), box)
  assert.equal(pendingBox({ box, at }, at + ADD_CONTEXT_WINDOW_MS + 1), null)
  // A clock that went backwards is no evidence the answer belongs to the click.
  assert.equal(pendingBox({ box, at }, at - 1), null)
  assert.equal(pendingBox(null, at), null)
})

test("the box is claimed once: a later compose goes where its own target says", () => {
  const box: ContextBox = { key: "dispatch:/w", projectDir: "/w", surface: "newComposer" }
  assert.equal(takePendingAdd(), null)
  requestEditorContext(box, { what: "file", path: "/w/a.ts" })
  assert.equal(takePendingAdd(), box)
  assert.equal(takePendingAdd(), null)
})
