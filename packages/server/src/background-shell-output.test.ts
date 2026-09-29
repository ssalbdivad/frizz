import assert from "node:assert/strict"
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { backgroundShellLineCount, readBackgroundShellOutput, resetBackgroundShellLineCounts, vetHarnessOutputPath } from "./background-shell-output.ts"

test("background shell output reads a bounded, presentation-safe tail", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-shell-output-"))
  try {
    const path = join(dir, "task.output")
    writeFileSync(path, `discard-me\n12345\u001b[31mred\u001b[0m\rprogress`)
    assert.deepEqual(readBackgroundShellOutput(path, 24), {
      output: "345red\nprogress",
      truncated: true,
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("background shell output degrades safely when the task file is unavailable", () => {
  assert.deepEqual(readBackgroundShellOutput("/definitely/missing/frizz-shell-output"), { output: "", truncated: false })
})

// ── THE LIVE COUNTER on a shell row ──────────────────────────────────────────────────────────────

function withOutputFile(run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "frizz-shell-lines-"))
  resetBackgroundShellLineCounts()
  try {
    run(join(dir, "task.output"))
  } finally {
    resetBackgroundShellLineCounts()
    rmSync(dir, { recursive: true, force: true })
  }
}

test("the line counter counts what the drawer shows — terminators, a trailing partial line, and bare \\r", () => {
  withOutputFile((path) => {
    writeFileSync(path, "")
    assert.equal(backgroundShellLineCount(path), 0, "a shell that has printed nothing reads as 0, not as absent")
    writeFileSync(path, "one\n")
    resetBackgroundShellLineCounts()
    assert.equal(backgroundShellLineCount(path), 1)
    writeFileSync(path, "one\ntwo")
    resetBackgroundShellLineCounts()
    assert.equal(backgroundShellLineCount(path), 2, "output ending mid-line still shows that line")
    // readBackgroundShellOutput rewrites a bare \r to \n, so an overprinting progress bar renders as
    // several lines in the drawer — the counter beside it has to agree.
    writeFileSync(path, "10%\r20%\r30%")
    resetBackgroundShellLineCounts()
    assert.equal(backgroundShellLineCount(path), 3)
    writeFileSync(path, "a\r\nb\r\n")
    resetBackgroundShellLineCounts()
    assert.equal(backgroundShellLineCount(path), 2, "CRLF is ONE break, not two")
  })
})

test("the line counter advances incrementally as a live shell appends", () => {
  withOutputFile((path) => {
    writeFileSync(path, "first\nsecond\n")
    assert.equal(backgroundShellLineCount(path), 2)
    appendFileSync(path, "third\n")
    assert.equal(backgroundShellLineCount(path), 3, "the second call must read only the delta and still total correctly")
    assert.equal(backgroundShellLineCount(path), 3, "a poll with no new bytes re-reports the same total")
    appendFileSync(path, "partial")
    assert.equal(backgroundShellLineCount(path), 4)
    appendFileSync(path, " more\n")
    assert.equal(backgroundShellLineCount(path), 4, "finishing the partial line does not add a second one")
  })
})

// The delta boundary landing between the \r and the \n of one CRLF is the one way an incremental
// counter double-counts, and it needs two separate appends to reproduce at all.
test("the line counter does not double-count a CRLF split across two polls", () => {
  withOutputFile((path) => {
    writeFileSync(path, "alpha\r")
    assert.equal(backgroundShellLineCount(path), 1)
    appendFileSync(path, "\nbeta\r")
    assert.equal(backgroundShellLineCount(path), 2, "the \\n closing a counted \\r is not a break of its own")
    appendFileSync(path, "\ngamma")
    assert.equal(backgroundShellLineCount(path), 3)
  })
})

test("the line counter recovers when the output file is truncated or rotated under it", () => {
  withOutputFile((path) => {
    writeFileSync(path, "one\ntwo\nthree\n")
    assert.equal(backgroundShellLineCount(path), 3)
    writeFileSync(path, "fresh\n")
    assert.equal(backgroundShellLineCount(path), 1, "a shrunk file is re-counted rather than reported off the stale total")
  })
})

// The rotation a size check alone cannot see: the replacement file is LARGER than what it replaced.
test("the line counter re-counts when a LARGER file replaces the one at that path", () => {
  withOutputFile((path) => {
    writeFileSync(path, "one\ntwo\n")
    assert.equal(backgroundShellLineCount(path), 2)
    rmSync(path)
    writeFileSync(path, "a\nb\nc\nd\ne\n")
    assert.equal(backgroundShellLineCount(path), 5, "a new inode at the same path is a new file, whatever its size")
  })
})

test("the line counter reports nothing — never zero — for a file it cannot read", () => {
  assert.equal(backgroundShellLineCount("/definitely/missing/frizz-shell-output"), undefined)
})

// ── THE HARNESS-PATH GUARD ────────────────────────────────────────────────────────────────────────
// The path a shell's output is read from comes out of an ACK — text in a tool_result — and one ack shape
// is the output of a FOREGROUND command, so its path is whatever that command printed. Only the harness's
// own task-log shape may be opened.

test("vetHarnessOutputPath: only a real file shaped tasks/<taskId>.output passes", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "frizz-vet-")))
  try {
    const tasks = join(root, "claude-1000", "-proj", "sid", "tasks")
    mkdirSync(tasks, { recursive: true })
    const good = join(tasks, "b1.output")
    writeFileSync(good, "tick 1\n")
    assert.equal(vetHarnessOutputPath(good, "b1"), good)
    // No task id known yet (a Monitor's derived path, an ack that named no id): the shape alone decides.
    assert.equal(vetHarnessOutputPath(good, undefined), good)

    assert.equal(vetHarnessOutputPath("/etc/passwd", undefined), undefined, "an arbitrary file is refused")
    // A symlink in the right place is judged by what it POINTS AT.
    const secret = join(root, "id_rsa")
    writeFileSync(secret, "PRIVATE KEY")
    const link = join(tasks, "b9.output")
    symlinkSync(secret, link)
    assert.equal(vetHarnessOutputPath(link, "b9"), undefined, "a tasks/ symlink to a secret resolves to the secret and fails")
    symlinkSync("/etc/passwd", join(tasks, "b8.output"))
    assert.equal(vetHarnessOutputPath(join(tasks, "b8.output"), "b8"), undefined)
    // A directory with the right name is not a log.
    mkdirSync(join(tasks, "b2.output"))
    assert.equal(vetHarnessOutputPath(join(tasks, "b2.output"), "b2"), undefined)
    // The right shape, the wrong task: never another shell's log.
    const other = join(tasks, "b3.output")
    writeFileSync(other, "x")
    assert.equal(vetHarnessOutputPath(other, "b1"), undefined)
    // `..` resolves before the shape check: `tasks/../x.output` is not in `tasks`.
    writeFileSync(join(tasks, "..", "x.output"), "x")
    assert.equal(vetHarnessOutputPath(join(tasks, "..", "x.output"), "x"), undefined)
    // A name outside the harness's id alphabet.
    writeFileSync(join(tasks, "a b.output"), "x")
    assert.equal(vetHarnessOutputPath(join(tasks, "a b.output"), undefined), undefined)
    // Missing entirely.
    assert.equal(vetHarnessOutputPath(join(tasks, "gone.output"), "gone"), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
