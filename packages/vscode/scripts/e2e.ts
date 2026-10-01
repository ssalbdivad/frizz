// THE EXTENSION, END TO END, IN A REAL VS CODE. Downloads VS Code (stable unless FRIZZ_E2E_VSCODE names
// a version) into ~/.cache/frizz-vscode-e2e with @vscode/test-electron, runs it with the extension under
// development and e2e/suite.ts as its test runner, and drives both directions of the editor bridge.
//
//   nub packages/vscode/scripts/e2e.ts
//       FAKE mode: an in-process fake Frizz (e2e/fake-frizz.ts) the suite asserts against frame by frame.
//
//   FRIZZ_E2E_ORIGIN=http://127.0.0.1:<port> FRIZZ_E2E_PROJECT_DIR=<a registered project's folder> \
//     nub packages/vscode/scripts/e2e.ts
//       REAL mode: the same suite against a running Frizz — a disposable one (scripts/adhoc-stack.mjs),
//       since it writes a sample file into the project folder and, with FRIZZ_E2E_SET_OPENER=1, sets
//       External app to VS Code for the run. FRIZZ_E2E_DISPATCH=1 (+ FRIZZ_E2E_THREAD=<slug>) also
//       runs the steps that start or message a real agent. FRIZZ_E2E_PAGE_CLAIMS=1 leaves the
//       prompt-box insert for a real page open on that Frizz to claim, instead of taking it itself.
//
// NEVER ON THE REAL DISPLAY. On Linux the run re-executes itself under `xvfb-run -a` with DISPLAY and
// WAYLAND_DISPLAY removed — on this machine DISPLAY=:0 is the maintainer's screen through WSLg, and a
// VS Code window popping up there is the most disruptive thing a test can do. The editor gets its own
// user-data and extensions directories and every other extension disabled.

import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron"
import type { EditorProject } from "@frizz/shared/editor-protocol"
import { FakeFrizz } from "../e2e/fake-frizz.ts"

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..")

if (process.platform === "linux" && process.env.FRIZZ_E2E_UNDER_XVFB !== "1") {
  const env: NodeJS.ProcessEnv = { ...process.env, FRIZZ_E2E_UNDER_XVFB: "1" }
  delete env.DISPLAY
  delete env.WAYLAND_DISPLAY
  const child = spawnSync("xvfb-run", ["-a", "-s", "-screen 0 1600x1000x24", "nub", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit", env })
  if (child.error) {
    console.error(`xvfb-run could not start (${child.error.message}). Install it (apt install xvfb); this harness never uses the real display.`)
    process.exit(1)
  }
  process.exit(child.status ?? 1)
}
if (process.platform === "linux" && (!process.env.DISPLAY || process.env.DISPLAY === ":0" || process.env.WAYLAND_DISPLAY)) {
  console.error(`refusing to run on DISPLAY=${process.env.DISPLAY} / WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY}: that is a real screen`)
  process.exit(1)
}

const realOrigin = process.env.FRIZZ_E2E_ORIGIN
const mode = realOrigin ? "real" : "fake"
if (mode === "real" && !process.env.FRIZZ_E2E_PROJECT_DIR) {
  console.error("REAL mode needs FRIZZ_E2E_PROJECT_DIR: a folder registered as a project in that Frizz.")
  process.exit(1)
}

const build = spawnSync("nub", ["scripts/build.ts", "--e2e"], { cwd: pkg, stdio: "inherit" })
if (build.status !== 0) process.exit(build.status ?? 1)

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "frizz-vscode-e2e-")))
const workspace = mode === "real" ? realpathSync(process.env.FRIZZ_E2E_PROJECT_DIR!) : join(scratch, "workspace")
const sample = join(workspace, "src", "sample.ts")
const wroteSample = !existsSync(sample)
mkdirSync(dirname(sample), { recursive: true })
if (wroteSample) {
  writeFileSync(sample, [
    "export function sample(xs: number[]): number {",
    "  let total = 0",
    "  for (const x of xs) {",
    "    total += x",
    "  } // the loop's end, long enough for a column",
    "  return total",
    "}",
    "",
  ].join("\n"))
}

let fake: FakeFrizz | undefined
if (mode === "fake") {
  const projects: EditorProject[] = [
    { id: randomUUID(), slug: "e2e", name: "e2e", dir: workspace, ready: 0, working: 0 },
    { id: "686f6d65-0000-4000-8000-000000000000", slug: "home", name: "Home", dir: homedir(), home: true },
  ]
  fake = await new FakeFrizz(projects).listen()
}
const origin = realOrigin ?? fake!.origin

const userData = join(scratch, "user-data")
mkdirSync(join(userData, "User"), { recursive: true })
writeFileSync(join(userData, "User", "settings.json"), JSON.stringify({
  "frizz.serverUrl": origin,
  "workbench.startupEditor": "none",
  "window.restoreWindows": "none",
  "security.workspace.trust.enabled": false,
  "update.mode": "none",
  "extensions.autoUpdate": false,
  "extensions.autoCheckUpdates": false,
  "telemetry.telemetryLevel": "off",
  "git.enabled": false,
}, null, 2))

let exitCode = 1
try {
  const vscodeExecutablePath = await downloadAndUnzipVSCode({
    version: process.env.FRIZZ_E2E_VSCODE ?? "stable",
    cachePath: join(homedir(), ".cache", "frizz-vscode-e2e"),
  })
  console.log(`frizz e2e: ${mode} mode against ${origin}, VS Code ${vscodeExecutablePath}, DISPLAY=${process.env.DISPLAY ?? "(none)"}`)
  exitCode = await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: pkg,
    extensionTestsPath: join(pkg, "dist", "e2e", "suite.cjs"),
    launchArgs: [
      workspace,
      `--user-data-dir=${userData}`,
      `--extensions-dir=${join(scratch, "extensions")}`,
      "--disable-extensions",
      "--password-store=basic",
      "--disable-gpu",
      "--disable-telemetry",
    ],
    extensionTestsEnv: {
      FRIZZ_E2E_MODE: mode,
      FRIZZ_E2E_WORKSPACE: workspace,
      FRIZZ_E2E_CONTROL: fake?.origin,
      FRIZZ_E2E_DISPATCH: process.env.FRIZZ_E2E_DISPATCH,
      FRIZZ_E2E_THREAD: process.env.FRIZZ_E2E_THREAD,
      FRIZZ_E2E_SET_OPENER: process.env.FRIZZ_E2E_SET_OPENER,
      FRIZZ_E2E_PAGE_CLAIMS: process.env.FRIZZ_E2E_PAGE_CLAIMS,
    },
  })
} catch (error) {
  console.error(`frizz e2e: ${(error as Error).message}`)
} finally {
  await fake?.close()
  if (mode === "real" && wroteSample) rmSync(sample, { force: true })
  if (exitCode === 0) rmSync(scratch, { recursive: true, force: true })
  else console.error(`frizz e2e: failed; the editor's logs are kept under ${join(userData, "logs")}`)
}
process.exit(exitCode)
