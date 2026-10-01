import assert from "node:assert/strict"
import { test } from "node:test"
import { formatFileReference, goToArgument, splitFilePosition } from "./file-position.ts"

test("splitFilePosition reads the editor/compiler suffix", () => {
  assert.deepEqual(splitFilePosition("/repo/a.ts:12"), { path: "/repo/a.ts", position: { line: 12 } })
  assert.deepEqual(splitFilePosition("/repo/a.ts:12:3"), { path: "/repo/a.ts", position: { line: 12, column: 3 } })
  assert.deepEqual(splitFilePosition("src/a.ts:12-20"), { path: "src/a.ts", position: { line: 12, endLine: 20 } })
  assert.deepEqual(splitFilePosition("a.ts:12:3-20"), { path: "a.ts", position: { line: 12, column: 3, endLine: 20 } })
})

test("splitFilePosition reads the GitHub fragment", () => {
  assert.deepEqual(splitFilePosition("/repo/a.ts#L12"), { path: "/repo/a.ts", position: { line: 12 } })
  assert.deepEqual(splitFilePosition("/repo/a.ts#L12C4"), { path: "/repo/a.ts", position: { line: 12, column: 4 } })
  assert.deepEqual(splitFilePosition("/repo/a.ts#L12-L20"), { path: "/repo/a.ts", position: { line: 12, endLine: 20 } })
  assert.deepEqual(splitFilePosition("/repo/a.ts#L12-20"), { path: "/repo/a.ts", position: { line: 12, endLine: 20 } })
})

test("splitFilePosition leaves paths without a position alone", () => {
  assert.deepEqual(splitFilePosition("/repo/a.ts"), { path: "/repo/a.ts" })
  assert.deepEqual(splitFilePosition("C:\\repo\\a.ts"), { path: "C:\\repo\\a.ts" })
  assert.deepEqual(splitFilePosition("C:\\repo\\a.ts:7"), { path: "C:\\repo\\a.ts", position: { line: 7 } })
  assert.deepEqual(splitFilePosition("/repo/AGENTS.md#setup"), { path: "/repo/AGENTS.md#setup" })
  assert.deepEqual(splitFilePosition("/repo/a.ts:"), { path: "/repo/a.ts:" })
  assert.deepEqual(splitFilePosition("a.ts:x"), { path: "a.ts:x" })
})

test("splitFilePosition refuses a line 0 and drops an inverted range", () => {
  assert.deepEqual(splitFilePosition("/repo/a.ts:0"), { path: "/repo/a.ts:0" })
  assert.deepEqual(splitFilePosition("/repo/a.ts:20-12"), { path: "/repo/a.ts", position: { line: 20 } })
  assert.deepEqual(splitFilePosition("/repo/a.ts:5:0"), { path: "/repo/a.ts", position: { line: 5 } })
})

test("a bare suffix is not a path with a position", () => {
  assert.deepEqual(splitFilePosition(":12"), { path: ":12" })
  assert.deepEqual(splitFilePosition("#L12"), { path: "#L12" })
})

test("goToArgument and formatFileReference spell the position back", () => {
  assert.equal(goToArgument("/repo/a.ts"), "/repo/a.ts")
  assert.equal(goToArgument("/repo/a.ts", { line: 12 }), "/repo/a.ts:12")
  assert.equal(goToArgument("/repo/a.ts", { line: 12, column: 3, endLine: 20 }), "/repo/a.ts:12:3")
  assert.equal(formatFileReference("src/a.ts", { line: 12 }), "src/a.ts:12")
  assert.equal(formatFileReference("src/a.ts", { line: 12, endLine: 20 }), "src/a.ts:12-20")
  assert.equal(formatFileReference("src/a.ts", { line: 12, endLine: 12 }), "src/a.ts:12")
})
