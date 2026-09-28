import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"
import { canonicalFolder, expandHomeFolder, homeFolderProblem } from "./home-folder.ts"
import { registerProject } from "./project-registry.ts"

const A = "4b1f0d2e-7c3a-4e59-9a61-0c2d8e5f7a10"

function sandbox(): string {
  // realpath'd so an expectation built from it compares equal to canonicalFolder's answer (macOS /var).
  const home = realpathSync(mkdtempSync(join(tmpdir(), "frizz-home-folder-")))
  mkdirSync(join(home, ".frizz"), { recursive: true }) // legacy collapse root, so the registry lands in the sandbox
  return home
}

test("expandHomeFolder: unset, blank and `~` are the home folder itself", () => {
  const home = "/home/x"
  for (const value of [undefined, "", "   ", "~", " ~ "]) assert.equal(expandHomeFolder(value, home), home, JSON.stringify(value))
})

test("expandHomeFolder: `~/…` is under home, an absolute path is resolved as written", () => {
  const home = "/home/x"
  assert.equal(expandHomeFolder("~/code", home), join(home, "code"))
  assert.equal(expandHomeFolder("  ~/code  ", home), join(home, "code"), "trimmed, as typed into a field")
  assert.equal(expandHomeFolder("/srv/work/../scratch", home), resolve("/srv/scratch"))
})

// The server's own cwd is whichever directory the launcher happened to start in — nothing the operator
// sees — so a bare relative value resolving against it would move Home between launches.
test("expandHomeFolder: a bare relative path is taken from home, never from the process cwd", () => {
  const home = mkdtempSync(join(tmpdir(), "frizz-home-folder-rel-"))
  try {
    assert.notEqual(process.cwd(), home)
    assert.equal(expandHomeFolder("code", home), join(home, "code"))
    assert.equal(expandHomeFolder("code/sub", home), join(home, "code", "sub"))
    assert.notEqual(expandHomeFolder("code", home), resolve("code"))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("canonicalFolder resolves symlinks, and keeps a missing path verbatim", () => {
  const home = sandbox()
  try {
    mkdirSync(join(home, "real"))
    symlinkSync(join(home, "real"), join(home, "link"))
    assert.equal(canonicalFolder(join(home, "link")), join(home, "real"))
    assert.equal(canonicalFolder(join(home, "gone")), join(home, "gone"))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("homeFolderProblem: a missing folder and a file are refused, an existing folder is fine", () => {
  const home = sandbox()
  try {
    assert.equal(homeFolderProblem("~/nope", home), `No folder at ${join(home, "nope")}`)
    writeFileSync(join(home, "notes.txt"), "x")
    assert.equal(homeFolderProblem("~/notes.txt", home), `That is a file, not a folder: ${join(home, "notes.txt")}`)
    mkdirSync(join(home, "scratch"))
    assert.equal(homeFolderProblem("~/scratch", home), undefined)
    assert.equal(homeFolderProblem(undefined, home), undefined, "unset is the home folder, which exists")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// Claude Code shards transcripts by the session's cwd, so Home running IN a project's folder would put
// both boards' workers in one bucket and each would list the other's threads as external sessions.
test("homeFolderProblem: a registered project's own folder is refused, by any spelling of it", () => {
  const home = sandbox()
  try {
    const dir = join(home, "code", "proj")
    mkdirSync(join(dir, ".frizz"), { recursive: true })
    writeFileSync(join(dir, ".frizz", ".id"), `${A}\n`)
    registerProject({ dir, id: A }, home)

    assert.match(homeFolderProblem("~/code/proj", home) ?? "", /is the project proj\. Choose a folder that is not a project\./)
    assert.match(homeFolderProblem(dir, home) ?? "", /is the project proj/)
    // A symlink to the checkout is the same bucket, so it is caught through canonicalFolder.
    symlinkSync(dir, join(home, "proj-link"))
    assert.match(homeFolderProblem("~/proj-link", home) ?? "", /is the project proj/)

    // A folder INSIDE a project is a different cwd, a different transcript bucket, and allowed.
    mkdirSync(join(dir, "sub"))
    assert.equal(homeFolderProblem("~/code/proj/sub", home), undefined)
    // …and so is the project's parent.
    assert.equal(homeFolderProblem("~/code", home), undefined)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
