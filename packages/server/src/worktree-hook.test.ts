import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { worktreeAddTargets } from "../../../cc-worker/hooks/worktree.mjs"
import { removeThreadWorktrees, worktreesAddedBy } from "./worktree-cleanup.ts"

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
