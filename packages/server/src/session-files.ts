import { lstatSync, rmSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { frizzTempDir } from "./frizz-paths.ts"

// Per-install. The filenames are UUIDs so content cannot collide, but on Linux the first OS user to
// create this directory sets its mode and the second user's writeFileSync then fails EACCES — and
// that write (dispatch.ts) is NOT wrapped, so every dispatch for the second user throws.
export const SYSTEM_PROMPT_DIR = frizzTempDir("frizz-sysprompts")

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/

export function systemPromptPath(sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error("invalid session id")
  return join(SYSTEM_PROMPT_DIR, `${sessionId}.md`)
}

function isDirectDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

function pathAbsent(path: string): boolean {
  try {
    lstatSync(path)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
  }
}

function unlinkDirectChild(parent: string, filename: string): boolean {
  if (!isDirectDirectory(parent)) return pathAbsent(parent)
  const child = join(parent, filename)
  try {
    // unlink removes the direct child itself and never follows a child symlink. Not rmSync: on Node
    // 23.0–24.13.0 and 25.0–25.3.x it looks through a link (nodejs/node#61040) — EISDIR on a link to a
    // directory, a silent no-op on a dangling one. Parent validation above prevents a poisoned
    // directory symlink from redirecting recovery outside Frizz-owned roots.
    unlinkSync(child)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false
  }
  return pathAbsent(child)
}

export function cleanupAdoptionSessionFiles(projectDir: string, sessionId: string): boolean {
  if (!SESSION_ID_RE.test(sessionId)) return false
  const frizzDir = join(projectDir, ".frizz")
  let clean = true
  if (isDirectDirectory(frizzDir)) {
    const threads = join(frizzDir, "threads")
    // A UUID-named child belongs to exactly one dispatch. Remove the complete private scratch directory
    // directory rather than leaving an empty per-thread shell after a failed spawn/adoption.
    if (isDirectDirectory(threads)) {
      const child = join(threads, sessionId)
      try {
        rmSync(child, { recursive: true, force: true })
      } catch {
        clean = false
      }
    } else if (!pathAbsent(threads)) clean = false
  } else if (!pathAbsent(frizzDir)) clean = false
  clean = unlinkDirectChild(SYSTEM_PROMPT_DIR, `${sessionId}.md`) && clean
  return clean
}
