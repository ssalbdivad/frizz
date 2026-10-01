import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { worktreeAddTargets } from "../../../cc-worker/hooks/worktree.mjs"
import { regenerable, removeThreadWorktrees, worktreesAddedBy } from "./worktree-cleanup.ts"

const here = dirname(fileURLToPath(import.meta.url))
const hooks = join(here, "../../../cc-worker/hooks")

// A real repository with one commit, under a real parent folder standing in for `~`.
function repo(): { parent: string; dir: string } {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "frizz-worktree-")))
  const dir = join(parent, "yes")
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" })
  execFileSync("git", ["init", "-q", "-b", "main", dir])
  git("config", "user.email", "t@t")
  git("config", "user.name", "t")
  writeFileSync(join(dir, "a.txt"), "a\n")
  git("add", ".")
  git("commit", "-qm", "init")
  return { parent, dir }
}

function bashHook(command: string, cwd: string, args: string[] = [], env: Record<string, string> = {}): Record<string, any> {
  const result = spawnSync(process.execPath, [join(hooks, "bash-background.mjs"), ...args], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd, tool_input: { command } }),
    encoding: "utf8",
    env: { ...process.env, FRIZZ_THREAD: "thread-under-test", FRIZZ_WORKTREE_DIR: "", ...env },
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout || "{}").hookSpecificOutput ?? {}
}

test("worktreeAddTargets reads the path through cd, -C, options and quoting", () => {
  assert.deepEqual(worktreeAddTargets("git worktree add ../yes-perf -b perf"), [{ path: "../yes-perf" }])
  assert.deepEqual(worktreeAddTargets("git worktree add -b perf .frizz/worktrees/perf main"), [{ path: ".frizz/worktrees/perf" }])
  assert.deepEqual(worktreeAddTargets("cd /r && git -C sub worktree add --detach 'my tree'"), [{ path: "my tree", base: "/r/sub" }])
  assert.deepEqual(worktreeAddTargets("git -c core.x=1 worktree add -B b --reason why /abs/t"), [{ path: "/abs/t" }])
  assert.deepEqual(worktreeAddTargets("git worktree list; echo worktree add x"), [])
  assert.deepEqual(worktreeAddTargets("git worktree remove x"), [])
})

test("the Bash hook denies a worktree beside the checkout and names the folder it belongs in", () => {
  const { parent, dir } = repo()
  const denied = bashHook("git worktree add ../yes-perf -b perf", dir)
  assert.equal(denied.permissionDecision, "deny")
  assert.ok(denied.permissionDecisionReason.includes(join(dir, ".frizz/worktrees/yes-perf")), denied.permissionDecisionReason)
  // Same verdict when the target is spelled absolutely, or reached with cd from elsewhere.
  assert.equal(bashHook(`git -C ${dir} worktree add ${join(parent, "yes-perf")}`, parent).permissionDecision, "deny")
  // From INSIDE an existing worktree, the folder is still the main checkout's.
  execFileSync("git", ["-C", dir, "worktree", "add", "-q", join(dir, ".frizz/worktrees/one"), "-b", "one"])
  const inside = join(dir, ".frizz/worktrees/one")
  assert.equal(bashHook("git worktree add ../../../../yes-two -b two", inside).permissionDecision, "deny")
  assert.deepEqual(bashHook("git worktree add ../two -b two", inside), {}, "a sibling in the folder is in the folder")
})

test("the Bash hook allows the worktree folder, honours the setting, and stays out of non-worker sessions", () => {
  const { parent, dir } = repo()
  assert.deepEqual(bashHook("git worktree add .frizz/worktrees/perf -b perf", dir), {})
  assert.deepEqual(bashHook(`cd ${dir} && git worktree add .frizz/worktrees/perf`, parent), {})
  // A custom folder: the default location is now the wrong one.
  const custom = join(parent, "trees")
  assert.equal(bashHook("git worktree add .frizz/worktrees/perf", dir, [], { FRIZZ_WORKTREE_DIR: custom }).permissionDecision, "deny")
  assert.deepEqual(bashHook(`git worktree add ${custom}/perf`, dir, [], { FRIZZ_WORKTREE_DIR: custom }), {})
  // Codex passes the setting as argv, since its shared app-server has no per-thread env.
  assert.deepEqual(bashHook(`git worktree add ${custom}/perf`, dir, ["--frizz-thread", `--worktree-dir=${custom}`]), {})
  // Not a Frizz worker: no opinion.
  assert.deepEqual(bashHook("git worktree add ../yes-perf", dir, [], { FRIZZ_THREAD: "" }), {})
})

test("WorktreeCreate/WorktreeRemove put EnterWorktree's worktree in the folder and take it out again", () => {
  const { dir } = repo()
  const run = (args: string[], input: object) =>
    spawnSync(process.execPath, [join(hooks, "worktree.mjs"), ...args], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, FRIZZ_WORKTREE_DIR: "" } })
  const created = run(["--event=create"], { hook_event_name: "WorktreeCreate", name: "probe", cwd: dir })
  assert.equal(created.status, 0, created.stderr)
  const path = created.stdout.trim()
  assert.equal(path, join(dir, ".frizz/worktrees/probe"))
  assert.ok(existsSync(join(path, "a.txt")))
  // A resumed session re-enters it rather than failing on the existing branch.
  assert.equal(run(["--event=create"], { name: "probe", cwd: dir }).stdout.trim(), path)
  const removed = run(["--event=remove"], { hook_event_name: "WorktreeRemove", worktree_path: path })
  assert.equal(removed.status, 0, removed.stderr)
  assert.equal(existsSync(path), false)
})

test("cleanup on done removes the thread's clean worktrees and keeps dirty or foreign ones", async () => {
  const { parent, dir } = repo()
  const add = (path: string, branch: string) => execFileSync("git", ["-C", dir, "worktree", "add", "-q", path, "-b", branch])
  add(join(dir, ".frizz/worktrees/clean"), "clean")
  add(join(dir, ".frizz/worktrees/dirty"), "dirty")
  add(join(parent, "outside"), "outside")
  writeFileSync(join(dir, ".frizz/worktrees/dirty/new.txt"), "unsaved\n")
  const messages = [
    { tools: [{ name: "Bash", command: "git worktree add .frizz/worktrees/clean -b clean" }] },
    { tools: [{ name: "Bash", command: `cd ${dir} && git worktree add .frizz/worktrees/dirty -b dirty` }] },
    { tools: [{ name: "Bash", command: "git worktree add ../outside -b outside" }] },
  ] as never
  const candidates = worktreesAddedBy(messages, dir)
  assert.equal(candidates.length, 3)
  const { removed, kept } = await removeThreadWorktrees(candidates, undefined)
  assert.deepEqual(removed, [join(dir, ".frizz/worktrees/clean")])
  assert.deepEqual(kept.map((k) => k.path), [join(dir, ".frizz/worktrees/dirty")])
  assert.equal(existsSync(join(dir, ".frizz/worktrees/clean")), false)
  assert.ok(existsSync(join(dir, ".frizz/worktrees/dirty/new.txt")))
  assert.ok(existsSync(join(parent, "outside")), "a worktree outside the folder is not Frizz's to delete")
  // Its branch was merged (it never moved), so it went with it.
  const branches = execFileSync("git", ["-C", dir, "branch", "--format=%(refname:short)"], { encoding: "utf8" })
  assert.ok(!branches.split("\n").includes("clean"))
  assert.ok(branches.split("\n").includes("dirty"))
})

// THE CLEANUP NEVER DISCARDS WORK. Each case is a real repository and a real `git worktree remove`; the
// helpers below make the shapes an agent actually leaves behind.
function cleanupRepo() {
  const { parent, dir } = repo()
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim()
  writeFileSync(join(dir, ".gitignore"), ".env\nnode_modules/\ndist/\n*.tsbuildinfo\nlocal.db\n")
  git(dir, "add", ".gitignore")
  git(dir, "commit", "-qm", "ignore")
  const tree = (name: string) => join(dir, ".frizz/worktrees", name)
  const commitIn = (cwd: string, file: string) => {
    writeFileSync(join(cwd, file), `${file}\n`)
    git(cwd, "add", file)
    git(cwd, "commit", "-qm", file)
    return git(cwd, "rev-parse", "HEAD")
  }
  const refsContaining = (sha: string) => git(dir, "for-each-ref", "--contains", sha, "--format=%(refname)").split("\n").filter(Boolean)
  const branches = () => git(dir, "branch", "--format=%(refname:short)").split("\n")
  return { parent, dir, git, tree, commitIn, refsContaining, branches }
}

test("cleanup keeps a detached worktree whose commit is on no ref, and removes one whose commit is", async () => {
  const { dir, git, tree, commitIn, refsContaining } = cleanupRepo()
  git(dir, "worktree", "add", "-q", "--detach", tree("orphan"))
  const sha = commitIn(tree("orphan"), "work.txt")
  assert.deepEqual(refsContaining(sha), [], "the precondition: only the detached HEAD holds it")
  git(dir, "worktree", "add", "-q", "--detach", tree("at-main"))

  const { removed, kept } = await removeThreadWorktrees([tree("orphan"), tree("at-main")], undefined)

  assert.deepEqual(kept.map((k) => k.path), [tree("orphan")])
  assert.match(kept[0]!.reason, /detached HEAD .* is on no branch/)
  assert.equal(git(tree("orphan"), "rev-parse", "HEAD"), sha, "the commit is still checked out where the agent left it")
  assert.deepEqual(removed, [tree("at-main")], "a detached HEAD that main contains loses nothing")
  assert.equal(existsSync(tree("at-main")), false)
})

test("cleanup keeps a branch worktree with unmerged commits, and removes a merged one with its branch", async () => {
  const { dir, git, tree, commitIn, branches } = cleanupRepo()
  git(dir, "worktree", "add", "-q", tree("unmerged"), "-b", "unmerged")
  commitIn(tree("unmerged"), "wip.txt")
  // THE NEGATIVE CONTROL: commits made on a branch, then merged into main, so main holds every one.
  git(dir, "worktree", "add", "-q", tree("merged"), "-b", "merged")
  const landed = commitIn(tree("merged"), "landed.txt")
  git(dir, "merge", "-q", "--ff-only", "merged")
  assert.equal(git(dir, "rev-parse", "main"), landed)

  const { removed, kept } = await removeThreadWorktrees([tree("unmerged"), tree("merged")], undefined)

  assert.deepEqual(removed, [tree("merged")])
  assert.equal(existsSync(tree("merged")), false)
  assert.ok(!branches().includes("merged"), "the merged branch went with it")
  assert.deepEqual(kept.map((k) => k.path), [tree("unmerged")])
  assert.match(kept[0]!.reason, /only on its own branch unmerged/)
  assert.ok(existsSync(join(tree("unmerged"), "wip.txt")))
  assert.ok(branches().includes("unmerged"))
})

test("cleanup keeps a worktree holding a hand-made ignored file, and removes one holding only build output", async () => {
  const { dir, git, tree } = cleanupRepo()
  git(dir, "worktree", "add", "-q", tree("secrets"), "-b", "secrets")
  writeFileSync(join(tree("secrets"), ".env"), "TOKEN=abc\n")
  git(dir, "worktree", "add", "-q", tree("db"), "-b", "db")
  writeFileSync(join(tree("db"), "local.db"), "rows\n")
  // Everything here is rebuilt by an install or a build, and `.frizz/` holds only what Frizz itself
  // writes into any folder it resolves as a project.
  git(dir, "worktree", "add", "-q", tree("built"), "-b", "built")
  for (const sub of ["node_modules/pkg", "dist", "packages/web/node_modules/x", ".frizz"]) mkdirSync(join(tree("built"), sub), { recursive: true })
  writeFileSync(join(tree("built"), "node_modules/pkg/index.js"), "x\n")
  writeFileSync(join(tree("built"), "packages/web/node_modules/x/.env"), "inside a dependency\n")
  writeFileSync(join(tree("built"), "dist/out.js"), "x\n")
  writeFileSync(join(tree("built"), "tsconfig.tsbuildinfo"), "{}\n")
  writeFileSync(join(tree("built"), ".frizz/.id"), "id\n")
  writeFileSync(join(tree("built"), ".frizz/.gitignore"), "*\n")
  // A `.frizz/` holding anything else (a worker's notes) is not Frizz's markers, so it is kept.
  git(dir, "worktree", "add", "-q", tree("notes"), "-b", "notes")
  mkdirSync(join(tree("notes"), ".frizz/threads/x"), { recursive: true })
  writeFileSync(join(tree("notes"), ".frizz/.gitignore"), "*\n")
  writeFileSync(join(tree("notes"), ".frizz/threads/x/notes.md"), "findings\n")

  const { removed, kept } = await removeThreadWorktrees([tree("secrets"), tree("db"), tree("built"), tree("notes")], undefined)

  assert.deepEqual(removed, [tree("built")], JSON.stringify(kept))
  assert.equal(existsSync(tree("built")), false)
  assert.deepEqual(kept.map((k) => k.path), [tree("secrets"), tree("db"), tree("notes")])
  assert.match(kept[0]!.reason, /ignored files git cannot restore: \.env/)
  assert.match(kept[1]!.reason, /local\.db/)
  assert.match(kept[2]!.reason, /\.frizz\//)
  assert.equal(readFileSync(join(tree("secrets"), ".env"), "utf8"), "TOKEN=abc\n")
  assert.ok(existsSync(join(tree("notes"), ".frizz/threads/x/notes.md")))
})

test("cleanup keeps a worktree another live thread is working in", async () => {
  const { dir, git, tree } = cleanupRepo()
  git(dir, "worktree", "add", "-q", tree("shared"), "-b", "shared")
  mkdirSync(join(tree("shared"), "packages/web"), { recursive: true })
  git(dir, "worktree", "add", "-q", tree("alone"), "-b", "alone")
  let asked = 0
  const inUse = () => {
    asked++
    // A spinoff child standing in a subfolder of its parent's worktree, and a thread at the project root.
    return [{ dir: join(tree("shared"), "packages/web"), by: "child-thread" }, { dir, by: "root-thread" }]
  }

  const { removed, kept } = await removeThreadWorktrees([tree("shared"), tree("alone")], undefined, inUse)

  assert.deepEqual(kept, [{ path: tree("shared"), reason: `thread child-thread is still working in it (${join(tree("shared"), "packages/web")})` }])
  assert.ok(existsSync(tree("shared")))
  assert.deepEqual(removed, [tree("alone")], "a thread at the project root is not inside the worktree")
  assert.equal(asked, 1, "the live threads' folders are read once per cleanup")
  // The worktree itself, exactly, counts as inside it.
  const exact = await removeThreadWorktrees([tree("shared")], undefined, () => [{ dir: tree("shared"), by: "t" }])
  assert.equal(exact.kept.length, 1)
})

test("regenerable: dependency and build output only", () => {
  const wt = "/nonexistent"
  for (const entry of ["node_modules/", "packages/a/node_modules/", "dist/", "web-dist/", "a/.turbo/", "tsconfig.tsbuildinfo", "x/.DS_Store", ".frizz/.id", "a/.frizz/.gitignore", "dist/sub/.env", "__pycache__/", "m.pyc"])
    assert.equal(regenerable(entry, wt), true, entry)
  for (const entry of [".env", "config/.env.local", "local.db", "secrets/", "notes.md", "runtime/", ".frizz/", ".frizz/threads/", "app.log", ".id"])
    assert.equal(regenerable(entry, wt), false, entry)
})
