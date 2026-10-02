import assert from "node:assert/strict"
import { test } from "node:test"
import { ADD_CONTEXT_WINDOW_MS, barAdd, barHints, contextBarReading, editorAddChord, editorContext, outgoingMessage, outgoingMessageWith, pendingBox, requestEditorContext, setEditorContext, setHostState, setShareEditor, takePendingAdd, type ContextBox } from "./editorContext.ts"
import { contextChipLabel, parseSentContext, parseSentEditorContext, type ComposerContextItem } from "./composerContext.ts"
import { splitComposerValue } from "./imagePaths.ts"

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

test("the editor's add chord is Cursor's, spelled the way every other shortcut is, per platform", () => {
  assert.equal(editorAddChord("mac"), "⌘L")
  assert.equal(editorAddChord("other"), "Ctrl+L")
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

// ── the send ───────────────────────────────────────────────────────────────────────────────────────

const chip: ComposerContextItem = { id: 1, token: "@r2-private.ts:91-116", path: file.path, text: "const sig = sign(key, body)", startLine: 91, endLine: 116 }

test("a send carries the selection after the human's words and chips, before the attachments", () => {
  const active = { ...file, selection: { startLine: 91, endLine: 92, chars: 40, text: "const sig = sign(key, body)\nreturn sig" } }
  const sent = outgoingMessageWith("why does this throw?\n/tmp/a.png", [], "/work/alpha", active)
  const { prose, attachments } = splitComposerValue(sent)
  assert.deepEqual(attachments, [{ path: "/tmp/a.png", kind: "image" }])
  const parsed = parseSentEditorContext(prose)
  assert.equal(parsed?.body, "why does this throw?")
  assert.deepEqual(parsed?.editor, { kind: "selection", display: "src/lib/r2-private.ts", startLine: 91, endLine: 92, text: "const sig = sign(key, body)\nreturn sig" })
  // No editor in front: the chips' message, exactly.
  assert.equal(outgoingMessageWith("plain words", [], "/work/alpha", null), "plain words")
})

test("a chip on the selection already says it; a chip whose token was deleted does not", () => {
  const active = { ...file, selection: { startLine: 91, endLine: 116, chars: 30, text: "const sig = sign(key, body)" } }
  const covered = outgoingMessageWith("@r2-private.ts:91-116 is this right?", [chip], "/work/alpha", active)
  assert.equal(parseSentEditorContext(covered), null, "no editor block beside the chip that carries it")
  assert.deepEqual(parseSentContext(covered)?.items.map((item) => item.token), ["@r2-private.ts:91-116"])
  // The token was backspaced out of the prose: that chip does not serialize, so the editor block goes.
  const uncovered = outgoingMessageWith("is this right?", [chip], "/work/alpha", active)
  assert.equal(parseSentEditorContext(uncovered)?.editor.kind, "selection")
  assert.equal(parseSentContext(parseSentEditorContext(uncovered)!.body), null)
})

test("with nothing selected the send names the file and the caret's line, no file content", () => {
  const sent = outgoingMessageWith("what is this file for?", [], "/work/alpha", { ...file, cursorLine: 40 })
  assert.equal(sent.endsWith("\n\nOpen in the editor: src/lib/r2-private.ts (cursor on line 40)"), true, sent)
})

test("a send to a thread in a worktree writes its paths for the worktree and says whose copy the context is", () => {
  const worktree = { dir: "/work/alpha/.frizz/worktrees/r2", kind: "worktree" }
  const active = { ...file, selection: { startLine: 91, endLine: 92, chars: 40, text: "const sig = sign(key, body)\nreturn sig" } }
  const sent = outgoingMessageWith("why does this throw?", [], "/work/alpha", active, worktree)
  assert.equal(sent.endsWith("\n\nThe context above is from the human's editor, which shows the project's main checkout (/work/alpha). You are working in your own worktree (/work/alpha/.frizz/worktrees/r2): the same relative path there is your copy, and it may differ from what they see."), true, sent)
  // The window shows the worktree itself: the path is the worktree's, and nothing needs saying.
  const own = outgoingMessageWith("why does this throw?", [], "/work/alpha", { ...active, path: "/work/alpha/.frizz/worktrees/r2/src/lib/r2-private.ts" }, worktree)
  assert.equal(parseSentEditorContext(own)?.editor.display, "src/lib/r2-private.ts")
  assert.doesNotMatch(own, /main checkout/)
  // A chip alone from the main checkout gets the sentence too; plain words get nothing.
  assert.match(outgoingMessageWith("@r2-private.ts:91-116 ok?", [chip], "/work/alpha", null, worktree), /main checkout \(\/work\/alpha\)/)
  assert.equal(outgoingMessageWith("plain words", [], "/work/alpha", null, worktree), "plain words")
  // A thread at the root: exactly as before.
  assert.equal(outgoingMessageWith("why does this throw?", [], "/work/alpha", active, undefined), outgoingMessageWith("why does this throw?", [], "/work/alpha", active))
})

test("outside an editor's sidebar nothing is attached, whatever the editor state says", () => {
  // Under plain node the page is not embedded, which is the browser tab's case: the chips alone go.
  setEditorContext({ type: "frizz:editor-context", active: { ...file, selection: { startLine: 1, endLine: 1, chars: 1, text: "x" } }, open: [] })
  assert.equal(outgoingMessage("hello", [], "/work/alpha", true), "hello")
  setEditorContext({ type: "frizz:editor-context", active: null, open: [] })
})

test("the eye shows the extension's setting: the host's word wins over what the eye assumed", () => {
  assert.equal(editorContext.share, true, "on until the host says otherwise, as the setting defaults")
  setShareEditor(false)
  assert.equal(editorContext.share, false, "shown at once")
  // The host answers with what is true: a workspace value that wins puts the eye back.
  setHostState({ type: "frizz:host-state", shareEditor: true, altK: false })
  assert.equal(editorContext.share, true)
  assert.equal(editorContext.altK, false)
  setHostState({ type: "frizz:host-state", shareEditor: true, altK: true })
})

test("the hint says what goes on its own and what the chord adds, and never teaches the step a question no longer needs", () => {
  const hints = (over: Partial<Parameters<typeof barHints>[0]>) => barHints({ sending: true, selection: false, withheld: false, chord: "Ctrl+L", ...over })
  assert.deepEqual(hints({}), ["Selections go with your message · Ctrl+L puts one at the caret", "Ctrl+L puts a selection at the caret", "Select + Ctrl+L"])
  assert.deepEqual(hints({ selection: true }), ["Goes with your message · Ctrl+L puts it at the caret", "Goes with your message"])
  assert.deepEqual(hints({ selection: true, withheld: true }), ["Lines only: the file may hold secrets", "Lines only"])
  assert.deepEqual(hints({ sending: false, selection: true }), ["Not shared · Ctrl+L still adds it", "Not shared"])
  assert.deepEqual(hints({ sending: false }), ["Not shared with Frizz", "Not shared"])
  for (const state of [{}, { selection: true }, { sending: false }]) {
    for (const hint of hints(state)) {
      assert.doesNotMatch(hint, /^Select code\b/u, "not the old 'Select code and press'")
      assert.equal(hint[0], hint[0]!.toUpperCase(), "sentence case")
    }
  }
})

test("an untitled buffer goes with the message but cannot be added as a chip", () => {
  assert.equal(barAdd({ path: "Untitled-1", label: "Untitled-1", untitled: true, selection: { startLine: 1, endLine: 2, chars: 4 } }), null)
  assert.deepEqual(barAdd({ ...file, dirty: true }), { what: "file", path: file.path })
})

test("a reply names a selection its thread was just sent, through the thread's own transcript", () => {
  const active = { ...file, selection: { startLine: 91, endLine: 92, chars: 40, text: "const sig = sign(key, body)\nreturn sig" } }
  const first = outgoingMessageWith("why?", [], "/work/alpha", active)
  const previous = { display: "src/lib/r2-private.ts", startLine: 91, endLine: 92, text: "const sig = sign(key, body)\nreturn sig" }
  const again = outgoingMessageWith("and this?", [], "/work/alpha", active, null, previous)
  assert.match(first, /> return sig$/)
  assert.equal(again, `and this?\n\n${first.slice(first.indexOf("Editor context"), first.indexOf("\n\nSelected in"))}\n\nStill selected in src/lib/r2-private.ts, lines 91-92 (quoted in an earlier message)`)
})
