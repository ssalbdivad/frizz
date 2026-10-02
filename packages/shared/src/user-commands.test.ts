import assert from "node:assert/strict"
import { test } from "node:test"
import { expandUserCommand, expandUserCommandDraft, userCommandDisplayText } from "./index.ts"

const commit = { name: "commit", body: "commit with a one-line message" }
const fix = { name: "fix", body: "Fix this: $ARGUMENTS. Then run the tests." }

test("$ARGUMENTS is replaced; without it, arguments ride on a line of their own", () => {
  assert.equal(expandUserCommand(fix, "the flaky test"), '<frizz-command name="fix" args="the flaky test">\nFix this: the flaky test. Then run the tests.\n</frizz-command>')
  assert.equal(expandUserCommand(commit, "say why"), '<frizz-command name="commit" args="say why">\ncommit with a one-line message\n\nARGUMENTS: say why\n</frizz-command>')
  assert.equal(expandUserCommand(commit, ""), '<frizz-command name="commit">\ncommit with a one-line message\n</frizz-command>')
})

test("only a draft that OPENS with a known command is expanded", () => {
  assert.ok(expandUserCommandDraft("/commit", [commit])?.includes("one-line message"))
  assert.ok(expandUserCommandDraft("  /fix the build\nand the lint", [fix])?.includes("Fix this: the build\nand the lint."))
  assert.equal(expandUserCommandDraft("please /commit", [commit]), undefined)
  assert.equal(expandUserCommandDraft("/commitx", [commit]), undefined)
  assert.equal(expandUserCommandDraft("/tmp/commit", [commit]), undefined)
})

test("a delivered command reads back as exactly what was typed, whatever its arguments hold", () => {
  for (const args of ["", "the flaky test", 'quote "this" & <that>\nsecond line']) {
    const typed = args ? `/fix ${args}` : "/fix"
    assert.equal(userCommandDisplayText(expandUserCommandDraft(typed, [fix])!), typed)
  }
  // What a send appends after the wrapper (attached context, file paths) stays visible.
  assert.equal(userCommandDisplayText(`${expandUserCommand(commit, "")}\n\n/home/x/shot.png`), "/commit\n\n/home/x/shot.png")
  assert.equal(userCommandDisplayText("an ordinary message"), undefined)
  assert.equal(userCommandDisplayText('<frizz-command name="x">\nno close'), undefined)
})
