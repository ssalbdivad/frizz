import { test } from "node:test"
import assert from "node:assert/strict"
// The PAGE's own serializer and parser, imported straight from the web package (they load under node):
// what the extension sends must be exactly what the ⌘I flow sends, and must come back as chips.
import { buildMessageWithContext, parseSentContext } from "../../web/src/lib/composerContext.ts"
import { composeMessage, QUOTE_MAX_LINES, refLabel, type FileRef } from "./message.ts"

const projectDir = "/home/me/repo"
const path = "/home/me/repo/src/a.ts"
const text = "for (const x of xs) {\n  use(x)\n}"

function selectionRef(selection: FileRef["selection"], display = "src/a.ts"): FileRef {
  return { path, display, selection }
}

test("a selection serializes byte-for-byte as the page's ⌘I flow would, and parses back into its chip", () => {
  const ref = selectionRef({ text, startLine: 12, endLine: 14 })
  const sent = composeMessage("why does this loop twice?", ref)
  assert.equal(sent, "@a.ts:12-14 why does this loop twice?\n\nSelected context:\n\n@a.ts:12-14 (src/a.ts, lines 12-14):\n> for (const x of xs) {\n>   use(x)\n> }")
  const page = buildMessageWithContext("@a.ts:12-14 why does this loop twice?", [{ id: 1, token: "@a.ts:12-14", path, text, startLine: 12, endLine: 14 }], projectDir)
  assert.equal(sent, page)
  assert.deepEqual(parseSentContext(sent), {
    body: "@a.ts:12-14 why does this loop twice?",
    items: [{ token: "@a.ts:12-14", display: "src/a.ts", startLine: 12, endLine: 14, text }],
  })
})

test("one line reads `line N`, and a file outside the project shows its absolute path", () => {
  const sent = composeMessage("rename this", selectionRef({ text: "const a = 1", startLine: 7, endLine: 7 }, "/elsewhere/b.ts"))
  assert.equal(sent, "@a.ts:7 rename this\n\nSelected context:\n\n@a.ts:7 (/elsewhere/b.ts, line 7):\n> const a = 1")
  assert.deepEqual(parseSentContext(sent)?.items, [{ token: "@a.ts:7", display: "/elsewhere/b.ts", startLine: 7, endLine: 7, text: "const a = 1" }])
})

test("Windows line endings, blank lines and trailing whitespace in a selection still parse", () => {
  const sent = composeMessage("tidy", selectionRef({ text: "a\r\n\r\nb  \r\n\r\n", startLine: 1, endLine: 4 }))
  const parsed = parseSentContext(sent)
  assert.ok(parsed, sent)
  assert.equal(parsed.items[0]?.text, "a\n\nb")
  assert.doesNotMatch(sent, /\r/)
})

test("nothing selected is a plain reference — the cursor's line from an editor, the bare file from the explorer", () => {
  assert.equal(composeMessage("what is this?", { path, display: "src/a.ts", cursorLine: 42 }), "`src/a.ts:42` what is this?")
  assert.equal(composeMessage("summarize", { path, display: "src/a.ts" }), "`src/a.ts` summarize")
  // A whitespace-only selection has nothing to quote either; it is a reference to its range.
  assert.equal(composeMessage("here", selectionRef({ text: "   \n ", startLine: 3, endLine: 4 })), "`src/a.ts:3-4` here")
  assert.equal(parseSentContext("`src/a.ts:42` what is this?"), null, "a reference is plain text, never a half-parsed chip")
})

test("a selection past the quote cap becomes a reference to its range rather than a giant prompt", () => {
  const lines = QUOTE_MAX_LINES + 1
  const big = Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n")
  assert.equal(composeMessage("explain", selectionRef({ text: big, startLine: 1, endLine: lines })), `\`src/a.ts:1-${lines}\` explain`)
  const wide = "x".repeat(33 * 1024)
  assert.equal(composeMessage("explain", selectionRef({ text: wide, startLine: 5, endLine: 5 })), "`src/a.ts:5` explain")
  // Just under both caps still quotes.
  const fits = Array.from({ length: QUOTE_MAX_LINES }, () => "y").join("\n")
  assert.ok(parseSentContext(composeMessage("explain", selectionRef({ text: fits, startLine: 1, endLine: QUOTE_MAX_LINES }))))
})

test("the parser is strict, so the round trips above are evidence (negative control)", () => {
  const sent = composeMessage("why?", selectionRef({ text, startLine: 12, endLine: 14 }))
  assert.equal(parseSentContext(sent.replace("\n\nSelected context:", "\nSelected context:")), null)
  assert.equal(parseSentContext(sent.replace("@a.ts:12-14 why?", "why?")), null, "a definition whose token is not in the prose is plain text")
})

test("the input box names the reference the way the chip will", () => {
  assert.equal(refLabel(selectionRef({ text, startLine: 12, endLine: 14 })), "a.ts:12-14")
  assert.equal(refLabel(selectionRef({ text: "x", startLine: 3, endLine: 3 })), "a.ts:3")
  assert.equal(refLabel({ path, display: "src/a.ts", cursorLine: 9 }), "a.ts:9")
  assert.equal(refLabel({ path, display: "src/a.ts" }), "a.ts")
})
