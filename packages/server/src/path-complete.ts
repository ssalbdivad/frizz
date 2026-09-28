import { readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

// THE ADD-PROJECT DIALOG'S AUTOCOMPLETE — what is at the path being typed, and which folders continue it.
//
// Same reason the picker lives on the server (directory-picker.ts): a page cannot see the filesystem,
// and a project IS a path. It answers with folder NAMES only — never file contents, never files at all
// in the suggestions, since only a folder can become a project.

export type PathCompletion = {
  /** What the typed path names right now, so the dialog can say so before anyone presses Add. */
  status: "directory" | "file" | "missing" | "empty"
  /**
   * Folders continuing the LAST segment, each spelled the way the operator typed its parent (a `~`
   * stays a `~`) and ending in `/`, so accepting one leaves the cursor ready to descend.
   */
  suggestions: string[]
}

const MAX_SUGGESTIONS = 8

/** `~` is what a person types; it is not a path any filesystem call understands. */
function expandHome(typed: string, home: string): string {
  return typed === "~" || typed.startsWith("~/") ? join(home, typed.slice(1)) : typed
}

export function completePath(input: string, home = homedir()): PathCompletion {
  const typed = input.trimStart()
  if (!typed.trim()) return { status: "empty", suggestions: [] }
  const absolute = resolve(expandHome(typed.trimEnd(), home))

  let status: PathCompletion["status"] = "missing"
  try {
    status = statSync(absolute).isDirectory() ? "directory" : "file"
  } catch {}

  // A bare `~` completes as `~/`, the one prefix with no slash in it worth descending into.
  const slash = typed.lastIndexOf("/")
  if (slash === -1 && typed !== "~") return { status, suggestions: [] }
  const parentTyped = typed === "~" ? "~/" : typed.slice(0, slash + 1)
  const partial = typed === "~" ? "" : typed.slice(slash + 1)
  const parent = resolve(expandHome(parentTyped, home))

  let names: string[]
  try {
    names = readdirSync(parent, { withFileTypes: true })
      // A symlink to a folder is a folder to the person typing; resolve it rather than hide it.
      .filter((entry) => entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(join(parent, entry.name))))
      .map((entry) => entry.name)
  } catch {
    return { status, suggestions: [] }
  }
  const lower = partial.toLowerCase()
  const suggestions = names
    // Dotfolders only once a dot is typed — `~/` would otherwise open on `.cache`, `.npm`, `.cargo`.
    .filter((name) => (partial.startsWith(".") || !name.startsWith(".")) && name.toLowerCase().startsWith(lower))
    // The exact match is already typed; offering it again would read as "nothing else here".
    .filter((name) => name !== partial)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .slice(0, MAX_SUGGESTIONS)
    .map((name) => `${parentTyped}${name}/`)
  return { status, suggestions }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
