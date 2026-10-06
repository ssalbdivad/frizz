import { createHash } from "node:crypto"
import { readFileSync, realpathSync, statSync } from "node:fs"
import * as nodeModule from "node:module"
import { extname, isAbsolute, relative, resolve } from "node:path"

// THE WEB HALF, SERVED WITH NO BUILD STEP (plans/upstream-superset.md §7, "Loading").
//
// The page's bundle (`web-dist`) is part of an IMMUTABLE server generation (plans/stable-server-
// publishing.md): it is built once, published, and retained unchanged so a detached worker can keep using
// its files. A plugin cannot be compiled into it — a plugin is the operator's, installed after the
// generation was built and surviving every update — and a build step per plugin would need a bundler on
// every machine. So the server hands the page the plugin's own `.ts` with its types stripped by
// `module.stripTypeScriptTypes` (Node 22.13+, no dependency), and the page `import()`s it. Type
// stripping only ERASES — no JSX, no enums, no rewriting of imports — which is why a web half writes
// `h(…)` and imports nothing but its own sibling files: React, the RPC client and the UI kit arrive
// through `activate(host)`, so there is one React on the page and no import map to keep in step.
//
// Only files INSIDE the plugin's directory are served (after resolving symlinks, so a link out of it is
// refused), and only scripts. The route sits under `/_frizz/`, so it is behind the same loopback/origin
// gate (app.ts) and remote sign-in as every other route.

// `stripTypeScriptTypes` warns that it is experimental the first time it runs, on the releases that still
// call it that. The launcher paints a compact readout on the terminal the server shares, so the notice
// would land in the middle of it — and it describes nothing the operator chose or can act on. Same narrow
// filter as sqlite-quiet.ts: only this one notice, every other warning untouched.
const emitWarning = process.emitWarning.bind(process)
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const type = typeof rest[0] === "string" ? rest[0] : undefined
  const name = typeof warning === "string" ? type : warning?.name
  const text = typeof warning === "string" ? warning : warning?.message ?? ""
  if (name === "ExperimentalWarning" && text.includes("stripTypeScriptTypes")) return
  return (emitWarning as (...args: unknown[]) => void)(warning, ...rest)
}) as typeof process.emitWarning

const SCRIPT_EXTENSIONS = new Set([".ts", ".js", ".mjs"])

type StripTypes = (source: string, options?: { mode?: "strip" | "transform" }) => string

function stripper(): StripTypes | undefined {
  return (nodeModule as unknown as { stripTypeScriptTypes?: StripTypes }).stripTypeScriptTypes
}

/** Whether this Node can serve a `.ts` web half at all. */
export function canStripTypes(): boolean {
  return typeof stripper() === "function"
}

/** A short content hash: the `?v=` that makes a changed entry a new URL. */
export function contentVersion(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 12)
}

export type WebAssetResult =
  | { status: 200; body: string; etag: string }
  | { status: 400 | 404 | 500; message: string }

/**
 * Read `relPath` out of a plugin's directory, as JavaScript. `dir` is the plugin's directory as the
 * registry resolved it (its real path).
 */
export function readPluginWebAsset(dir: string, relPath: string): WebAssetResult {
  let decoded: string
  try {
    decoded = decodeURIComponent(relPath)
  } catch {
    return { status: 400, message: "bad path" }
  }
  if (!decoded || decoded.includes("\0") || isAbsolute(decoded) || decoded.split(/[\\/]/).includes("..")) {
    return { status: 400, message: "bad path" }
  }
  const extension = extname(decoded)
  if (!SCRIPT_EXTENSIONS.has(extension)) return { status: 404, message: "not a script" }
  let file: string
  try {
    file = realpathSync(resolve(dir, decoded))
    if (!statSync(file).isFile()) return { status: 404, message: "not found" }
  } catch {
    return { status: 404, message: "not found" }
  }
  const inside = relative(dir, file)
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) return { status: 404, message: "not found" }
  const source = readFileSync(file, "utf8")
  const etag = `"${createHash("sha256").update(source).digest("hex").slice(0, 16)}"`
  if (extension !== ".ts") return { status: 200, body: source, etag }
  const strip = stripper()
  if (!strip) return { status: 500, message: "This Node cannot strip TypeScript; Frizz plugins need Node 22.18 or newer" }
  try {
    return { status: 200, body: strip(source), etag }
  } catch (error) {
    // A syntax error, or syntax stripping cannot erase (an enum, a parameter property): say where.
    return { status: 500, message: `Could not strip ${decoded}: ${error instanceof Error ? error.message : String(error)}` }
  }
}
