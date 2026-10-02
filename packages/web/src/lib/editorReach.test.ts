import assert from "node:assert/strict"
import test from "node:test"
import { droppedUris, fileQueryAt, fileReference, insertFileReference, insertReferencesAt, isVscodeDrag, problemCountsLabel } from "./editorReach.ts"

// The page's half of the sidebar's other ways in (lib/editorReach.ts): the `@` file query, what replaces
// it, the references a drop writes, and what a drag from VS Code carries.

test("a file query runs over a path's characters, and opens only where a mention could", () => {
  assert.deepEqual(fileQueryAt("see @src/web/App.t", 18), { start: 4, query: "src/web/App.t" })
  assert.deepEqual(fileQueryAt("@", 1), { start: 0, query: "" })
  assert.deepEqual(fileQueryAt("look (@a.ts", 11), { start: 6, query: "a.ts" })
  // The caret decides: past a space the query is over.
  assert.equal(fileQueryAt("@a.ts and", 9), undefined)
  // Inside a word (an email address) or right after a path's own characters, never.
  assert.equal(fileQueryAt("me@example.com", 14), undefined)
  assert.equal(fileQueryAt("x/@a", 4), undefined)
  assert.equal(fileQueryAt("@a", null), undefined)
})

test("choosing a file replaces the whole `@` token with its reference, a space after", () => {
  assert.deepEqual(insertFileReference("see @App.t please", 4, 8, "`src/App.tsx`"), { prose: "see `src/App.tsx` please", caret: 18 })
  assert.deepEqual(insertFileReference("@ap", 0, 3, "`a.ts`"), { prose: "`a.ts` ", caret: 7 })
})

test("dropped references land at the caret, spaced from the words around them", () => {
  assert.deepEqual(insertReferencesAt("look at", 7, ["`a.ts`", "`b/`"]), { prose: "look at `a.ts` `b/` ", caret: 20 })
  assert.deepEqual(insertReferencesAt("look  please", 5, ["`a.ts`"]), { prose: "look `a.ts` please", caret: 12 })
  assert.deepEqual(insertReferencesAt("", 0, ["`a.ts`"]), { prose: "`a.ts` ", caret: 7 })
})

test("a reference is project-relative under the project, absolute elsewhere, and a folder ends in its separator", () => {
  assert.equal(fileReference({ path: "/repo/src/a.ts" }, "/repo"), "`src/a.ts`")
  assert.equal(fileReference({ path: "/elsewhere/a.ts" }, "/repo"), "`/elsewhere/a.ts`")
  assert.equal(fileReference({ path: "/repo/src", folder: true }, "/repo"), "`src/`")
  assert.equal(fileReference({ path: "C:\\repo\\src", folder: true }, "C:\\repo"), "`src\\`")
})

test("a drag is VS Code's by its own types, never by a plain uri-list (a file from the desktop carries one too)", () => {
  assert.equal(isVscodeDrag(["text/plain", "ResourceURLs", "text/uri-list"]), true)
  assert.equal(isVscodeDrag(["application/vnd.code.uri-list"]), true)
  assert.equal(isVscodeDrag(["Files", "text/uri-list"]), false)
  assert.equal(isVscodeDrag([]), false)
})

test("the dropped resources are read from a uri-list or VS Code's JSON list, each once", () => {
  assert.deepEqual(
    droppedUris(["file:///r/a.ts\r\n# a comment\r\nfile:///r/b\r\n", undefined, '["file:///r/a.ts","file:///r/c.md"]']),
    ["file:///r/a.ts", "file:///r/b", "file:///r/c.md"],
  )
  assert.deepEqual(droppedUris(["[not json", ""]), [])
})

test("the problems entry names only the counts there are", () => {
  assert.equal(problemCountsLabel({ label: "a.ts", errors: 2, warnings: 1, infos: 0 }), "2 errors, 1 warning")
  assert.equal(problemCountsLabel({ label: "a.ts", errors: 0, warnings: 0, infos: 1 }), "1 info")
})
