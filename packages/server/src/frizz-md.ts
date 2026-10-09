import { execFileSync } from "node:child_process"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { composeFrizzMd, type FrizzMdAnswers, type FrizzMdStatus } from "@frizz/shared"
import type { Storage } from "./storage.ts"

// The server half of the first-run questionnaire (the questions and the text they produce are in
// shared/frizz-md.ts). Three operations: is there anything to ask, write the answers as FRIZZ.md, and
// remember that the operator skipped it.
//
// "Already has a FRIZZ.md" is read off the disk every time rather than remembered, so a file someone
// committed, deleted or wrote by hand is always the truth. Only the SKIP needs storing — it is the one
// answer that leaves nothing on disk — and it lives in this project's own settings table, so skipping in
// one project never silences the questionnaire in another.

const SKIP_SETTING = "frizzMd.onboarding.skipped.v1"

function frizzMdPath(projectDir: string): string {
  return join(projectDir, "FRIZZ.md")
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim() || null
  } catch {
    return null
  }
}

/**
 * The branch the landing rules name. The remote's default (`origin/HEAD`) is what a pull request
 * targets; without one, the checked-out branch is the best guess at the mainline; a detached HEAD or a
 * folder that is not a repository falls back to `main`.
 */
export function defaultBranch(projectDir: string): string {
  const remote = git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], projectDir)
  if (remote?.startsWith("origin/")) return remote.slice("origin/".length)
  const current = git(["symbolic-ref", "--quiet", "--short", "HEAD"], projectDir)
  return current ?? "main"
}

export function frizzMdStatus(projectDir: string, storage: Storage): FrizzMdStatus {
  return {
    exists: existsSync(frizzMdPath(projectDir)),
    skipped: storage.getSetting(SKIP_SETTING) !== undefined,
    defaultBranch: defaultBranch(projectDir),
  }
}

/**
 * Write the answers as the project's FRIZZ.md. Refuses to replace a file that is already there
 * (`wx`): the questionnaire is only shown when there is none, so one appearing in between was written by
 * someone else, and theirs wins.
 */
export function createFrizzMd(projectDir: string, answers: FrizzMdAnswers): { path: string } {
  const path = frizzMdPath(projectDir)
  try {
    writeFileSync(path, composeFrizzMd(answers, defaultBranch(projectDir)), { encoding: "utf8", flag: "wx" })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("This project already has a FRIZZ.md.")
    throw error
  }
  return { path }
}

export function skipFrizzMd(storage: Storage, now = new Date()): void {
  storage.setSetting(SKIP_SETTING, { at: now.toISOString() })
}
