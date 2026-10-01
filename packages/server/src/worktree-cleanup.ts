import { execFile } from "node:child_process"
import { existsSync, readdirSync, realpathSync } from "node:fs"
import path from "node:path"
import { promisify } from "node:util"
import type { TranscriptMessage } from "@frizz/shared"
import { isInside, mainCheckoutOf, worktreeAddTargets, worktreeRootFor } from "../../../cc-worker/hooks/worktree.mjs"

// WHEN A THREAD IS MARKED DONE, ITS WORKTREES GO WITH IT (the `removeWorktreesOnDone` setting, on by
// default). A worktree is scratch space for one effort; left behind, every finished thread was one more
// sibling checkout nobody would ever open again (maintainer 2026-09-30: "frizz should clean up its own
// work trees by default once the thread is done").
//
// WHICH ones: the `git worktree add` targets in the thread's own Bash calls — read with the same parser
// the PreToolUse guard uses (cc-worker/hooks/worktree.mjs), so what the guard allowed is what is found —
// plus the worktree the agent is standing in, which covers EnterWorktree. Only paths inside the worktree
// folder: a worktree made before the guard existed, somewhere else, is not Frizz's to delete.
//
// WHAT IS GUARANTEED. A removed worktree's tracked work is all on some ref outside it, it had no
// modified or untracked files, and the only ignored files it took with it lay in dependency or build
// folders (check 3 — a hand edit inside node_modules or dist is the one thing that can still go). Before a
// worktree goes, each of these must hold, and the first that fails KEEPS it, with the reason in `kept`:
//
//   1. NO OTHER LIVE THREAD IS WORKING IN IT. A thread that is not done and whose working folder (the
//      caller's `inUse`, read the way the terminal reads it — thread-cwd.ts) is the worktree or inside it
//      would have its folder vanish under it. The router passes this project's threads only; a thread of
//      another project working in this one's worktree is not seen. The case that found it: a spinoff child forks its parent's
//      conversation and keeps working in the parent's worktree after the parent is marked done.
//   2. ITS HEAD COMMIT IS ON A REF OUTSIDE IT. `git for-each-ref --contains HEAD`, not counting the
//      worktree's own branch. A DETACHED worktree's commits are on no branch, so `git worktree remove`
//      leaves them dangling (reproduced: `worktree add --detach`, commit, remove → no ref contains it,
//      gone at the next gc). Its own branch does not count either: `git branch -d` would refuse to
//      delete an unmerged branch, so the commits would survive, but the work would be left as a branch
//      nobody is told about with its folder gone — an unfinished effort stays where it was made.
//   3. EVERY IGNORED FILE IN IT IS REGENERABLE. `git worktree remove` without --force refuses modified
//      and untracked files but deletes IGNORED ones silently, and an agent's `.env`, a local database or
//      a hand-made fixture is ignored precisely because it is not in git. The rule (`regenerable`):
//      an ignored entry may go only when it is, or lies under, a dependency or build folder named in
//      REGENERABLE_DIRS (`node_modules`, `dist`, `build`, caches…), or is a file named in
//      REGENERABLE_FILES (`*.tsbuildinfo`, `.DS_Store`, `*.pyc`), or is a `.frizz/` folder holding only
//      Frizz's own `.id` / `.gitignore` markers. Everything else keeps the worktree — a NAME list rather
//      than a size or age heuristic, because what makes a file safe to delete is that a command rebuilds
//      it, and the name is the only evidence of that git gives us. A build output this list does not
//      know keeps its worktree; that is the cheap direction to be wrong in.
//   4. GIT AGREES IT IS CLEAN. `git worktree remove` WITHOUT --force still refuses modified or untracked
//      files, and a locked worktree.
//
// Then its branch goes with `git branch -d`, which refuses an unmerged branch on its own. A check that
// cannot run (git errors, an unreadable HEAD) keeps the worktree: an unanswered question is not a yes.

const exec = promisify(execFile)

type ToolLike = { name: string; command?: string; cwd?: string }
type MessageLike = Pick<TranscriptMessage, "tools">

/** The absolute paths a thread's Bash calls asked `git worktree add` to create. */
export function worktreesAddedBy(messages: readonly MessageLike[], workDir: string): string[] {
  const out = new Set<string>()
  for (const message of messages) {
    for (const tool of (message.tools ?? []) as ToolLike[]) {
      if (tool.name.toLowerCase() !== "bash" || !tool.command) continue
      for (const target of worktreeAddTargets(tool.command)) {
        const cwd = tool.cwd ?? workDir
        out.add(path.resolve(target.base === undefined ? cwd : path.resolve(cwd, target.base), target.path))
      }
    }
  }
  return [...out]
}

export type WorktreeCleanup = { removed: string[]; kept: { path: string; reason: string }[] }

/** A not-done thread's working folder, for check 1. */
export type FolderInUse = { dir: string; by: string }

/** Dependency and build folders: whatever is under one is rebuilt by an install or a build. */
export const REGENERABLE_DIRS: ReadonlySet<string> = new Set([
  "node_modules", "dist", "build", "out", "web-dist", "coverage",
  ".turbo", ".cache", ".vite", ".next", ".nuxt", ".svelte-kit", ".parcel-cache", ".eslintcache",
  "target", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".venv", "venv", ".gradle",
])
const REGENERABLE_FILES = [/\.tsbuildinfo$/, /^\.DS_Store$/, /\.py[co]$/]
/** What Frizz itself writes into a folder it resolves as a project (project-root.ts). */
const FRIZZ_MARKERS: ReadonlySet<string> = new Set([".id", ".gitignore"])

/** Whether an ignored entry (`git status --ignored` path, relative to the worktree; a trailing `/` is a
 *  wholly ignored folder) is safe to delete with its worktree. See check 3 above. */
export function regenerable(entry: string, worktree: string): boolean {
  const segments = entry.replace(/\/$/, "").split("/")
  if (segments.slice(0, -1).some((s) => REGENERABLE_DIRS.has(s))) return true
  const last = segments.at(-1)!
  if (entry.endsWith("/")) {
    if (REGENERABLE_DIRS.has(last)) return true
    if (last === ".frizz") {
      try {
        return readdirSync(path.join(worktree, entry)).every((name) => FRIZZ_MARKERS.has(name))
      } catch {
        return false
      }
    }
    return false
  }
  if (segments.at(-2) === ".frizz" && FRIZZ_MARKERS.has(last)) return true
  return REGENERABLE_FILES.some((re) => re.test(last))
}

function canonical(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return path.resolve(dir)
  }
}

async function git(dir: string, ...args: string[]): Promise<string> {
  return (await exec("git", ["-C", dir, ...args], { maxBuffer: 64 * 1024 * 1024 })).stdout
}

/** Why `dir` must be kept, or undefined when every check passed. */
async function reasonToKeep(dir: string, main: string, branch: string, inUse: () => readonly FolderInUse[]): Promise<string | undefined> {
  const here = canonical(dir)
  const busy = inUse().find((use) => {
    const there = canonical(use.dir)
    return there === here || isInside(here, there)
  })
  if (busy) return `thread ${busy.by} is still working in it (${busy.dir})`

  let head: string
  try {
    head = (await git(dir, "rev-parse", "--verify", "HEAD")).trim()
  } catch (error) {
    return `could not read its HEAD: ${(error as { stderr?: string }).stderr?.trim() || String(error)}`
  }
  const own = branch ? `refs/heads/${branch}` : undefined
  const containing = (await git(main, "for-each-ref", "--contains", head, "--format=%(refname)"))
    .split("\n")
    .filter((ref) => ref && ref !== own)
  if (containing.length === 0) {
    return branch
      ? `its commit ${head.slice(0, 12)} is only on its own branch ${branch}, which is not merged anywhere`
      : `its detached HEAD ${head.slice(0, 12)} is on no branch or ref; removing it would orphan the commit`
  }

  // NUL-separated so a path with a newline or quote reads verbatim. `matching`, not `traditional`: both
  // report a folder an ignore pattern names as one entry (so node_modules is one line, not thousands),
  // but `traditional` also collapses a folder that merely CONTAINS only ignored things — a `packages/`
  // whose only untracked content is `packages/web/node_modules` came back as `packages/`, hiding which
  // ignored thing was inside. `matching` lists that folder's contents instead.
  const status = await git(dir, "status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=normal")
  const handMade = status
    .split("\0")
    .filter((record) => record.startsWith("!! "))
    .map((record) => record.slice(3))
    .filter((entry) => !regenerable(entry, dir))
  if (handMade.length > 0) {
    const shown = handMade.slice(0, 5).join(", ") + (handMade.length > 5 ? `, and ${handMade.length - 5} more` : "")
    return `it holds ignored files git cannot restore: ${shown}`
  }
  return undefined
}

export async function removeThreadWorktrees(
  candidates: readonly string[],
  setting: string | undefined,
  inUse: () => readonly FolderInUse[] = () => [],
): Promise<WorktreeCleanup> {
  const result: WorktreeCleanup = { removed: [], kept: [] }
  // Read once, and only if some candidate gets that far: the caller's answer may mean reading every
  // open thread's transcript.
  let folders: readonly FolderInUse[] | undefined
  const foldersInUse = () => (folders ??= inUse())
  for (const dir of new Set(candidates)) {
    if (!existsSync(dir)) continue
    const main = mainCheckoutOf(dir)
    if (!main || path.resolve(main) === path.resolve(dir)) continue
    if (!isInside(worktreeRootFor(setting, main), dir)) continue
    let branch = ""
    try {
      branch = (await git(dir, "symbolic-ref", "--short", "HEAD")).trim()
    } catch {}
    let keep: string | undefined
    try {
      keep = await reasonToKeep(dir, main, branch, foldersInUse)
    } catch (error) {
      keep = `could not check it: ${(error as { stderr?: string }).stderr?.trim() || String(error)}`
    }
    if (keep) {
      result.kept.push({ path: dir, reason: keep })
      continue
    }
    try {
      await exec("git", ["-C", main, "worktree", "remove", dir])
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr?.trim()
      result.kept.push({ path: dir, reason: stderr || String(error) })
      continue
    }
    result.removed.push(dir)
    if (branch) await exec("git", ["-C", main, "branch", "-d", branch]).catch(() => {})
  }
  return result
}
