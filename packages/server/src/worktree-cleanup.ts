import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
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
// SAFE BY CONSTRUCTION: `git worktree remove` WITHOUT --force refuses a tree with modified or untracked
// files, and `git branch -d` refuses an unmerged branch. So the only thing this can delete is a clean
// checkout whose commits are reachable elsewhere — nothing that is not already recoverable from git.

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

export async function removeThreadWorktrees(
  candidates: readonly string[],
  setting: string | undefined,
): Promise<WorktreeCleanup> {
  const result: WorktreeCleanup = { removed: [], kept: [] }
  for (const dir of new Set(candidates)) {
    if (!existsSync(dir)) continue
    const main = mainCheckoutOf(dir)
    if (!main || path.resolve(main) === path.resolve(dir)) continue
    if (!isInside(worktreeRootFor(setting, main), dir)) continue
    let branch = ""
    try {
      branch = (await exec("git", ["-C", dir, "symbolic-ref", "--short", "HEAD"])).stdout.trim()
    } catch {}
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
