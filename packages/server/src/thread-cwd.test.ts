import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import type { TranscriptMessage } from "@frizz/shared"
import { checkoutOf, newestToolWorkdir, newestTranscriptCwd, resolveThreadWorkingDir, terminalFolder } from "./thread-cwd.ts"

// WHERE A TERMINAL OPENED ON A THREAD STARTS. Real folders and real JSONL files: the reading is the
// newest `cwd` a Claude transcript records (checked against real transcripts — see thread-cwd.ts), lifted
// to the checkout it lies in.

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "frizz-cwd-")))
  const project = join(root, "repo")
  mkdirSync(join(project, ".git"), { recursive: true })
  mkdirSync(join(project, "packages", "web", "src"), { recursive: true })
  // A linked worktree: its `.git` is a FILE pointing back at the main checkout's.
  const worktree = join(project, ".frizz", "worktrees", "fix-auth")
  mkdirSync(join(worktree, "packages", "server"), { recursive: true })
  writeFileSync(join(worktree, ".git"), `gitdir: ${join(project, ".git", "worktrees", "fix-auth")}\n`)
  return { root, project, worktree, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const record = (over: Record<string, unknown>) => JSON.stringify({ type: "assistant", sessionId: "s", ...over })

test("the newest record with a cwd wins, past bookkeeping records and a sub-agent's", () => {
  const { root, project, worktree, cleanup } = fixture()
  try {
    const path = join(root, "t.jsonl")
    writeFileSync(path, [
      record({ type: "user", cwd: project }),
      record({ cwd: join(worktree, "packages", "server") }),
      // A sub-agent working elsewhere is not where the THREAD is.
      record({ cwd: "/somewhere/else", isSidechain: true }),
      // A relative reading is no reading.
      record({ cwd: "packages/web" }),
      // The trailing bookkeeping record Claude Code writes carries none.
      JSON.stringify({ type: "cost-state", total: 1 }),
      "",
    ].join("\n"))
    assert.equal(newestTranscriptCwd(path), join(worktree, "packages", "server"))
    assert.equal(newestTranscriptCwd(join(root, "missing.jsonl")), undefined)
  } finally {
    cleanup()
  }
})

test("a record straddling the reader's 64 KiB chunks, multi-byte text and all, still reads", () => {
  const { root, project, worktree, cleanup } = fixture()
  try {
    const path = join(root, "t.jsonl")
    // The newest cwd-bearing record is ~100 KiB of mostly 3-byte characters, so a chunk boundary lands
    // mid-record and very likely mid-character; a decoder fed half a character would corrupt the JSON.
    const big = record({ cwd: worktree, message: { content: "→".repeat(34_000) } })
    writeFileSync(path, [record({ cwd: project }), big, JSON.stringify({ type: "cost-state" }), ""].join("\n"))
    assert.equal(newestTranscriptCwd(path), worktree)
    // The scan is bounded: a window smaller than the record cannot see its start, and falls back to
    // nothing rather than a fragment.
    assert.equal(newestTranscriptCwd(path, 1_000), undefined)
  } finally {
    cleanup()
  }
})

test("a folder is lifted to its checkout: the worktree, or the project root — never above it", () => {
  const { root, project, worktree, cleanup } = fixture()
  try {
    assert.equal(checkoutOf(join(project, "packages", "web", "src"), project), project)
    assert.equal(checkoutOf(join(worktree, "packages", "server"), project), worktree)
    assert.equal(checkoutOf(worktree, project), worktree)
    assert.equal(checkoutOf(project, project), project)
    // A project that is itself a folder inside a larger repository stays the project.
    const outerRepo = join(root, "outer")
    const nested = join(outerRepo, "apps", "site")
    mkdirSync(join(outerRepo, ".git"), { recursive: true })
    mkdirSync(join(nested, "src"), { recursive: true })
    assert.equal(checkoutOf(join(nested, "src"), nested), nested)
    // Outside the project, the nearest checkout; no checkout at all, the folder itself.
    assert.equal(checkoutOf(join(outerRepo, "apps"), project), outerRepo)
    const loose = join(root, "loose", "dir")
    mkdirSync(loose, { recursive: true })
    assert.equal(checkoutOf(loose, project), loose)
  } finally {
    cleanup()
  }
})

test("Claude: the thread's own latest folder, lifted; a vanished or missing reading falls back to the project", () => {
  const { root, project, worktree, cleanup } = fixture()
  try {
    const path = join(root, "t.jsonl")
    writeFileSync(path, [record({ cwd: project }), record({ cwd: join(worktree, "packages", "server") }), ""].join("\n"))
    assert.deepEqual(resolveThreadWorkingDir({ projectDir: project, backend: "claude", transcriptPath: path }), { dir: worktree, source: "transcript" })

    // The agent removed its worktree since: the reading names a folder that is gone.
    writeFileSync(path, record({ cwd: join(project, ".frizz", "worktrees", "gone") }) + "\n")
    assert.deepEqual(resolveThreadWorkingDir({ projectDir: project, backend: "claude", transcriptPath: path }), { dir: project, source: "project" })
    assert.deepEqual(resolveThreadWorkingDir({ projectDir: project, backend: "claude" }), { dir: project, source: "project" })
    // An ACP agent has no reading Frizz knows how to take.
    assert.deepEqual(resolveThreadWorkingDir({ projectDir: project, backend: "acp", transcriptPath: path }), { dir: project, source: "project" })
  } finally {
    cleanup()
  }
})

test("Codex: the newest tool call's workdir, else the session's folder", () => {
  const { project, worktree, cleanup } = fixture()
  try {
    const messages = [
      { tools: [{ cwd: project }] },
      { tools: [{ cwd: "packages/server" }, { cwd: "" }] },
      { tools: [] },
    ] as unknown as TranscriptMessage[]
    // The relative workdir resolves against the session's own folder.
    assert.equal(newestToolWorkdir(messages, worktree), join(worktree, "packages", "server"))
    assert.deepEqual(
      resolveThreadWorkingDir({ projectDir: project, backend: "codex", codexMessages: () => messages, sessionCwd: worktree }),
      { dir: worktree, source: "transcript" },
    )
    // No tool call yet: where the session was started.
    assert.deepEqual(
      resolveThreadWorkingDir({ projectDir: project, backend: "codex", codexMessages: () => [], sessionCwd: worktree }),
      { dir: worktree, source: "session" },
    )
    // An unreadable rollout is no reading, not an error.
    assert.deepEqual(
      resolveThreadWorkingDir({ projectDir: project, backend: "codex", codexMessages: () => { throw new Error("EACCES") } }),
      { dir: project, source: "project" },
    )
  } finally {
    cleanup()
  }
})

test("the folder a human types is checked: ~ expands, relative and missing folders are refused", () => {
  const { project, cleanup } = fixture()
  try {
    assert.equal(terminalFolder(`  ${project}  `), project)
    assert.equal(terminalFolder("~"), homedir())
    assert.throws(() => terminalFolder("repo/packages"), /must be an absolute path: repo\/packages/)
    assert.throws(() => terminalFolder(join(project, "nope")), /No such folder/)
    // A file is not a folder.
    writeFileSync(join(project, "README.md"), "x")
    assert.throws(() => terminalFolder(join(project, "README.md")), /No such folder/)
  } finally {
    cleanup()
  }
})
