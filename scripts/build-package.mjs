// Build the two registry artifacts. `frizz` is the stable shell; `frizz-server` is the replaceable
// server generation it installs. Each server entry is a real file because the supervisor starts the
// child and detached daemons in separate Node processes.
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { rmSync, existsSync } from "node:fs"
import { build } from "esbuild"
import { DETACHED_DAEMON_ENTRIES, detachedDaemonOutputName } from "../packages/server/src/detached-daemons.ts"

const here = dirname(fileURLToPath(import.meta.url))
const workspace = resolve(here, "..")
const serverRelease = resolve(workspace, "packages/server-release")
const mode = process.argv[2]
if (mode !== "--shell" && mode !== "--server") throw new Error("usage: build-package.mjs --shell | --server")

const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.13",
  absWorkingDir: workspace,
  banner: {
    js: 'import { createRequire as __frizzCreateRequire } from "node:module"; const require = __frizzCreateRequire(import.meta.url);',
  },
  external: ["node-pty", "@parcel/watcher", "vite"],
  logLevel: "silent",
}

const entries = mode === "--shell"
  ? { "frizz.js": "src/production.ts" }
  : { "dev-child.js": "packages/server/src/dev-child.ts" }
if (mode === "--server") {
  for (const entry of DETACHED_DAEMON_ENTRIES) entries[detachedDaemonOutputName(entry)] = entry
}
const dist = resolve(mode === "--shell" ? workspace : serverRelease, "dist")
rmSync(dist, { recursive: true, force: true })
for (const [outName, entry] of Object.entries(entries)) {
  await build({ ...shared, entryPoints: [entry], outfile: join(dist, outName) })
}
for (const outName of Object.keys(entries)) {
  if (!existsSync(join(dist, outName))) throw new Error(`build-package: expected ${outName} was not emitted`)
}
console.log(`built ${mode === "--shell" ? "frizz shell" : "frizz-server"}: ${Object.keys(entries).join(", ")}`)
