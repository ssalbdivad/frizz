import { cpSync, lstatSync, mkdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { frizzPaths } from "./frizz-paths.ts"

// THE STABLE WORKER PLUGIN PATH — the one thing that makes a live plugin reload useful.
//
// A worker is launched against a plugin directory and reads its HOOKS from there. The Claude Agent
// SDK can re-read that directory on demand (`query.reloadPlugins()`), but the request takes NO
// arguments: it re-reads whatever path the session started with. Frizz's paths are the problem —
// dev workers point at `~/.frizz/builds/<sha>/runtime/cc-worker` and production workers at
// `<npm package>/runtime/cc-worker`, and BOTH are immutable and version-specific. Reloading one
// re-reads the same old bytes, so the reload is a no-op and a worker can never move forward.
//
// So frizz stages each version's plugin under its own directory and publishes ONE stable path that
// points at the current one. A worker launched against the stable path can then be moved onto a newer
// plugin by repointing the link and asking it to reload — no restart, no lost context, no lost
// in-memory sub-agents. Measured: repointing this link mid-session and calling reloadPlugins() arms a
// hook the process did not start with.
//
// Staging is a COPY, deliberately, rather than a link straight into the source tree. In production the
// plugin lives inside an npx execution cache, which npm may evict while a worker is still live; a
// dangling plugin path would break every hook at once. The tree is ~300K, so the copy is cheap
// insurance. It is also what makes the stable path outlive the build that produced it.

/** `~/.frizz/plugins` — one subdirectory per staged version, siblings of `builds/`. */
export function defaultPluginStageRoot(home = homedir()): string {
  return join(frizzPaths({ home }).cache, "plugins")
}

/** `~/.frizz/current` — where the stable, repointable links live. */
export function defaultStablePluginRoot(home = homedir()): string {
  return join(frizzPaths({ home }).cache, "current")
}

export type SymlinkOutcome = "created" | "repointed" | "unchanged"

/**
 * Point `link` at `target`, idempotently.
 *
 * Four cases, each handled explicitly — the shape is lifted from t3code's `CodexHomeLayout.ensureSymlink`,
 * which solved exactly this problem for its shadow home:
 *   • nothing there            → create
 *   • a real file or directory → THROW. Silently deleting a directory someone else put here is not a
 *                                recovery, it is data loss; a stable path colliding with real content
 *                                is a bug that must surface.
 *   • a symlink pointing elsewhere → remove and recreate (the repoint case — the whole point)
 *   • already correct          → no-op
 *
 * The existing target is resolved RELATIVE TO THE LINK'S OWN DIRECTORY before comparing, so a relative
 * symlink is not mistaken for a stale one and repointed on every call.
 */
export function ensureSymlink(link: string, target: string): SymlinkOutcome {
  mkdirSync(dirname(link), { recursive: true })
  let existing: ReturnType<typeof lstatSync> | undefined
  try {
    existing = lstatSync(link)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error
  }
  if (!existing) {
    symlinkSync(target, link)
    return "created"
  }
  if (!existing.isSymbolicLink()) {
    throw new Error(`refusing to replace ${link}: it exists and is not a symlink`)
  }
  const current = readlinkSync(link)
  if ((isAbsolute(current) ? current : resolve(dirname(link), current)) === target) return "unchanged"
  // unlinkSync, never rmSync: lstat above proved this is a link, and unlink removes the LINK on every
  // Node. rmSync looks through it on Node 23.0–24.13.0 and 25.0–25.3.x (its C++ port checked the path
  // with std::filesystem::status(), which follows symlinks; nodejs/node#61040 fixed it in 24.13.1 and
  // 25.4.0; 22.x was never affected) — a link to a directory throws
  // ERR_FS_EISDIR, and a DANGLING link (its build pruned) is reported missing, swallowed by `force`, and
  // left in place, so the symlinkSync below fails EEXIST. Measured on this machine 2026-10-02: v25.2.1
  // throws, v20.20.0 / v22.18.0 / v24.14.1 remove the link.
  unlinkSync(link)
  symlinkSync(target, link)
  return "repointed"
}

/**
 * Stage `source` as the plugin for `version` and publish it at the stable path.
 *
 * Returns the STABLE path — the one every worker should be launched against. Staging is skipped when
 * that version's directory already exists, so this is cheap to call on every boot; it is the symlink
 * that carries the change, and repointing it is what a live worker's next reload will observe.
 *
 * `version` is the identity of the plugin content, not merely a release number: dev passes the build
 * digest, production the package version. Anything that changes the plugin must change this, or a
 * worker will reload and see the same bytes.
 */
export function stageStablePluginDir(opts: {
  source: string
  version: string
  name?: string
  stageRoot?: string
  stableRoot?: string
  home?: string
}): { stablePath: string; stagedPath: string; outcome: SymlinkOutcome } {
  const name = opts.name ?? "cc-worker"
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(opts.version)) {
    throw new Error(`unsafe plugin version identity: ${opts.version}`)
  }
  const home = opts.home ?? homedir()
  const stageRoot = opts.stageRoot ?? defaultPluginStageRoot(home)
  const stableRoot = opts.stableRoot ?? defaultStablePluginRoot(home)
  const stagedPath = join(stageRoot, opts.version, name)

  let staged = false
  try {
    lstatSync(stagedPath)
    staged = true
  } catch {
    // Not staged yet.
  }
  if (!staged) {
    // Stage through a temp sibling and rename, so a worker can never observe a HALF-COPIED plugin —
    // a hooks.json present before the script it names would fail every hook until the copy finished.
    const pending = join(stageRoot, `.${opts.version}.pending-${process.pid}`)
    rmSync(pending, { recursive: true, force: true })
    mkdirSync(pending, { recursive: true })
    try {
      cpSync(opts.source, join(pending, name), { recursive: true, dereference: true })
      mkdirSync(join(stageRoot, opts.version), { recursive: true })
      // RENAME, not a second copy: rename is atomic within a filesystem, so the version directory
      // either does not exist or holds the complete plugin. A copy here would reintroduce exactly the
      // half-staged window this whole dance exists to avoid — hooks.json landing before the script it
      // names, so every hook fails until the copy catches up.
      try {
        renameSync(join(pending, name), stagedPath)
      } catch (error) {
        // Losing a concurrent race is fine — the winner staged identical content under the same
        // content identity. Anything else is a real staging failure and must surface.
        const code = (error as NodeJS.ErrnoException)?.code
        if (code !== "ENOTEMPTY" && code !== "EEXIST") throw error
      }
    } finally {
      rmSync(pending, { recursive: true, force: true })
    }
  }

  const stablePath = join(stableRoot, name)
  const outcome = ensureSymlink(stablePath, realpathSync(stagedPath))
  return { stablePath, stagedPath, outcome }
}
