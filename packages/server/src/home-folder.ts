import { realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, isAbsolute, join, resolve } from "node:path"
import { findByPath } from "./project-registry.ts"

// THE HOME FOLDER SETTING, AS A PATH — where the Home workspace's agents run (home-workspace.ts).
//
// Kept apart from home-workspace.ts for one reason: settings.ts validates the value on save, and
// home-workspace.ts reads it through settings.ts, so one module holding both would import itself.

/**
 * The folder a stored Home folder value names. Unset or blank is the operator's home folder; `~` and
 * `~/…` are what a person types, and a bare relative path is taken from home rather than from
 * whatever directory the server happened to start in, which the operator never sees.
 */
export function expandHomeFolder(value: string | undefined, home = homedir()): string {
  const typed = value?.trim()
  if (!typed || typed === "~") return home
  if (typed.startsWith("~/") || typed.startsWith("~\\")) return join(home, typed.slice(2))
  return isAbsolute(typed) ? resolve(typed) : resolve(home, typed)
}

/** Resolved through every symlink when it exists, so it compares equal to the registry's paths. */
export function canonicalFolder(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * Why `value` cannot be the Home folder, or undefined when it can.
 *
 * A REGISTERED PROJECT'S OWN FOLDER IS REFUSED. Claude Code shards its transcripts by the directory a
 * session runs in, so Home's workers and that project's would land in one bucket — and each board's
 * external-session scan would then list the other's threads as terminals the operator started. A
 * folder INSIDE a project is a different bucket, and fine.
 */
export function homeFolderProblem(value: string | undefined, home = homedir()): string | undefined {
  const folder = expandHomeFolder(value, home)
  let isDirectory: boolean
  try {
    isDirectory = statSync(folder).isDirectory()
  } catch {
    return `No folder at ${folder}`
  }
  if (!isDirectory) return `That is a file, not a folder: ${folder}`
  const project = findByPath(canonicalFolder(folder), home)
  if (project) return `${folder} is the project ${project.name ?? basename(project.path)}. Choose a folder that is not a project.`
  return undefined
}
