import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { composeFrizzMd, FrizzMdLanding, type FrizzMdAnswers } from "@frizz/shared"
import { createStorage } from "./storage.ts"
import { createFrizzMd, defaultBranch, frizzMdStatus, skipFrizzMd } from "./frizz-md.ts"
import { frizzConfigBlock } from "./dispatch.ts"

function tempDir(prefix: string): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

function gitRepo(branch: string): { dir: string; done: () => void } {
  const repo = tempDir("frizz-md-repo-")
  execFileSync("git", ["init", "-q", "-b", branch], { cwd: repo.dir })
  return repo
}

const answers: FrizzMdAnswers = { landing: "main", autonomy: "decide", notes: "Run `pnpm test` before every commit." }

test("a fresh project asks: no FRIZZ.md, not skipped, and the checked-out branch named", () => {
  const repo = gitRepo("trunk")
  const storage = createStorage(join(repo.dir, "ui.db"), "p")
  try {
    assert.deepEqual(frizzMdStatus(repo.dir, storage), { exists: false, skipped: false, defaultBranch: "trunk" })
  } finally {
    storage.close()
    repo.done()
  }
})

test("the remote's default branch wins over the checked-out one, and a folder outside git falls back to main", () => {
  const repo = gitRepo("feature")
  const plain = tempDir("frizz-md-plain-")
  try {
    execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop"], { cwd: repo.dir })
    assert.equal(defaultBranch(repo.dir), "develop")
    assert.equal(defaultBranch(plain.dir), "main")
  } finally {
    repo.done()
    plain.done()
  }
})

test("saving writes the composed FRIZZ.md, and the next worker's system prompt carries it", () => {
  const repo = gitRepo("main")
  const storage = createStorage(join(repo.dir, "ui.db"), "p")
  try {
    const { path } = createFrizzMd(repo.dir, answers)
    assert.equal(path, join(repo.dir, "FRIZZ.md"))
    const written = readFileSync(path, "utf8")
    assert.equal(written, composeFrizzMd(answers, "main"))
    assert.match(written, /No other coding-agent session reads it/)
    assert.match(written, /Commit finished work directly to the local `main` branch/)
    assert.match(written, /## Project notes\n\nRun `pnpm test` before every commit\./)
    // The seam that makes the questionnaire matter: dispatch reads this file into the worker prompt.
    assert.ok(frizzConfigBlock(repo.dir).includes(written.trim()))
    assert.equal(frizzMdStatus(repo.dir, storage).exists, true)
  } finally {
    storage.close()
    repo.done()
  }
})

test("saving never replaces a FRIZZ.md somebody else wrote", () => {
  const repo = gitRepo("main")
  try {
    writeFileSync(join(repo.dir, "FRIZZ.md"), "# Ours\n")
    assert.throws(() => createFrizzMd(repo.dir, answers), /already has a FRIZZ.md/)
    assert.equal(readFileSync(join(repo.dir, "FRIZZ.md"), "utf8"), "# Ours\n")
  } finally {
    repo.done()
  }
})

test("a skip is remembered for its own project only", () => {
  const a = gitRepo("main")
  const b = gitRepo("main")
  const storageA = createStorage(join(a.dir, "ui.db"), "a")
  const storageB = createStorage(join(b.dir, "ui.db"), "b")
  try {
    skipFrizzMd(storageA)
    assert.equal(frizzMdStatus(a.dir, storageA).skipped, true)
    assert.equal(frizzMdStatus(b.dir, storageB).skipped, false)
  } finally {
    storageA.close()
    storageB.close()
    a.done()
    b.done()
  }
})

test("every landing choice names the project's branch, and blank notes add no section", () => {
  for (const landing of FrizzMdLanding.options) {
    const text = composeFrizzMd({ landing, autonomy: "balanced", notes: "  \n " }, "trunk")
    assert.match(text, /`trunk`/, landing)
    assert.doesNotMatch(text, /Project notes/, landing)
  }
})
