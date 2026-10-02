import { test } from "node:test"
import assert from "node:assert/strict"
import { clipFenceRuns, scanInputFences } from "./inputCodeFences.ts"

const shape = (text: string) =>
  scanInputFences(text)?.map((run) => [run.kind, text.slice(run.start, run.end), ...(run.kind === "code" ? [run.language] : [])])

test("prose with no fence paints nothing", () => {
  assert.equal(scanInputFences("just words"), null)
  // Three backticks on one line with a backtick after them is inline code, not a fence.
  assert.equal(scanInputFences("use ```x``` here"), null)
  assert.equal(scanInputFences("```inline``` code"), null)
})

test("a closed fence splits into prose, delimiters and a highlighted body that tile the text", () => {
  const text = "before\n```ts\nconst a = 1\n```\nafter"
  assert.deepEqual(shape(text), [
    ["prose", "before\n"],
    ["fence", "```ts\n"],
    ["code", "const a = 1\n", "typescript"],
    ["fence", "```"],
    ["prose", "\nafter"],
  ])
  assert.equal(scanInputFences(text)!.map((run) => text.slice(run.start, run.end)).join(""), text)
})

test("an unclosed fence runs to the end, the state of a block being typed", () => {
  assert.deepEqual(shape("```py\nx = 1"), [["fence", "```py\n"], ["code", "x = 1", "python"]])
  assert.deepEqual(shape("```"), [["fence", "```"]])
})

test("a fence closes only on the same character at least as long", () => {
  assert.deepEqual(shape("````\n```\n~~~\n````"), [["fence", "````\n"], ["code", "```\n~~~\n", "plaintext"], ["fence", "````"]])
})

test("an unknown language stays plaintext rather than guessed", () => {
  assert.deepEqual(shape("~~~ weird\nhi\n~~~"), [["fence", "~~~ weird\n"], ["code", "hi\n", "plaintext"], ["fence", "~~~"]])
})

test("clipFenceRuns cuts runs to a window", () => {
  const runs = scanInputFences("a\n```\nb\n```")!
  assert.deepEqual(clipFenceRuns(runs, 1, 7).map((run) => [run.kind, run.start, run.end]), [["prose", 1, 2], ["fence", 2, 6], ["code", 6, 7]])
})
