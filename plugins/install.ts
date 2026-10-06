// INSTALL A FRIZZ PLUGIN from this checkout: link `plugins/<name>` into `<data>/user-plugins/<id>`, where the
// server's loader finds it at its next start (packages/server/src/plugins/loader.ts).
//
//   nub plugins/install.ts lazy                 link it (idempotent)
//   nub plugins/install.ts lazy --uninstall     remove the link; the plugin's own data is left where it is
//   nub plugins/install.ts lazy --data <dir>    another data directory (a disposable stack's)
//
// `<data>` is the machine's Frizz data root, resolved the way the server resolves it (frizz-paths.ts), so
// the same command is right on a legacy `~/.frizz` install and an XDG one. A LINK, not a copy: the plugin
// runs from this checkout, so pulling updates it at the next restart. Nothing else is touched — the
// machine config, the plugin's database (`<data>/plugin-data/<id>.db`) and every project stay as they are,
// which is also why uninstalling loses nothing: a thread the plugin held starts on its next message, and a
// reinstall picks its notes back up.
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { frizzPaths } from "../packages/server/src/frizz-paths.ts"

function fail(message: string): never {
  console.error(`✖ ${message}`)
  process.exit(1)
}

const args = process.argv.slice(2)
const name = args.find((arg) => !arg.startsWith("--") && args[args.indexOf(arg) - 1] !== "--data")
if (!name) fail("Name the plugin: nub plugins/install.ts <name> [--uninstall] [--data <dir>]")
const uninstall = args.includes("--uninstall")
const dataFlag = args.indexOf("--data")
const data = dataFlag >= 0 ? resolve(args[dataFlag + 1] ?? fail("--data needs a directory")) : frizzPaths({ home: homedir(), env: process.env }).data

const source = join(dirname(fileURLToPath(import.meta.url)), name)
let id: string
try {
  const manifest = (JSON.parse(readFileSync(join(source, "package.json"), "utf8")) as { frizzPlugin?: { id?: unknown } }).frizzPlugin
  if (typeof manifest?.id !== "string") fail(`${source}/package.json has no frizzPlugin.id`)
  id = manifest.id
} catch (error) {
  fail(`No Frizz plugin at ${source}: ${error instanceof Error ? error.message : String(error)}`)
}

const root = join(data, "user-plugins")
const target = join(root, id)
const linked = (() => {
  try {
    return lstatSync(target)
  } catch {
    return undefined
  }
})()

if (uninstall) {
  if (!linked) {
    console.log(`The ${id} plugin is not installed in ${root}.`)
  } else if (!linked.isSymbolicLink()) {
    fail(`${target} is a directory, not a link this script made; remove it yourself if you mean to.`)
  } else {
    unlinkSync(target)
    console.log(`Removed ${target}. Restart Frizz to unload it.`)
  }
  process.exit(0)
}

if (linked) {
  if (linked.isSymbolicLink() && resolve(root, readlinkSync(target)) === source) {
    console.log(`The ${id} plugin is already installed: ${target} → ${source}`)
    process.exit(0)
  }
  fail(`${target} already exists and is not a link to ${source}; move it aside first.`)
}
if (!existsSync(data)) fail(`No Frizz data directory at ${data}. Start Frizz once first, or pass --data.`)
mkdirSync(root, { recursive: true })
symlinkSync(source, target, "dir")
console.log(`Installed the ${id} plugin: ${target} → ${source}. Restart Frizz to load it.`)
