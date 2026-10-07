import { statSync } from "node:fs"
import { join } from "node:path"

// Two questions half the server asks of a path someone typed or a transcript named, answered once. Each
// was copied into the module that first needed it — `isDirectory` four times (home-workspace.ts,
// path-complete.ts, router.ts, thread-cwd.ts), `expandHome` twice (edited-files.ts, path-complete.ts) —
// until 2026-10-06.

/** Whether `path` is a directory now. Anything that cannot be stat'ed — missing, unreadable — is not. */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * `~` and `~/…` resolved against `home`; any other path as it was. `~` is what a person (or a worker's
 * `cd ~/…`) types, and no filesystem call understands it: `path.resolve` takes a leading tilde for an
 * ordinary segment, so `cd ~/.cache/nub/worktrees/x && cat > a.rs` once resolved to
 * `<project>/~/.cache/…` and passed edited-files.ts's containment check as an in-project file. `~user`
 * is left alone.
 */
export function expandHome(path: string, home: string): string {
  if (path === "~") return home
  return path.startsWith("~/") ? join(home, path.slice(2)) : path
}
