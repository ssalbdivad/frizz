// THE EXTENSION, END TO END, IN A REAL VS CODE. Downloads VS Code (stable unless FRIZZ_E2E_VSCODE names
// a version) into ~/.cache/frizz-vscode-e2e with @vscode/test-electron, runs it with the extension under
// development and e2e/suite.ts as its test runner, and drives both directions of the editor bridge.
//
//   nub packages/vscode/scripts/e2e.ts
//       FAKE mode: an in-process fake Frizz (e2e/fake-frizz.ts) the suite asserts against frame by frame.
//       FRIZZ_E2E_VSCODE=oldest runs it on the oldest VS Code the manifest's `engines.vscode` admits,
//       which is how an API newer than that floor gets caught (focusWindow, 1.128, was one).
//
//   nub packages/vscode/scripts/e2e.ts --stack
//       STACK mode: boots a disposable two-project Frizz itself (scripts/adhoc-stack.mjs: a sandbox HOME,
//       a free port, two throwaway git repos), runs REAL mode against the TENANT project — the one the
//       server did not launch from — with a headless page open on it (e2e/page-claim.ts) that must
//       receive "Add to Frizz prompt" as a chip in its new-thread box. Every file opener the server
//       could spawn is a stub on its PATH, and the run fails if one was spawned: the opens must all go
//       over the editor connection. Everything it started is torn down by exact pid, pass or fail.
//       FRIZZ_E2E_DISPATCH=1 adds `--creds` and runs the steps that start a real agent.
//
//   FRIZZ_E2E_ORIGIN=http://127.0.0.1:<port> FRIZZ_E2E_PROJECT_DIR=<a registered project's folder> \
//     nub packages/vscode/scripts/e2e.ts
//       REAL mode against a Frizz you started — a disposable one, since it writes a sample file into the
//       project folder and, with FRIZZ_E2E_SET_OPENER=1, sets External app to VS Code for the run.
//       FRIZZ_E2E_DISPATCH=1 (+ FRIZZ_E2E_THREAD=<slug>) also runs the steps that start or message a
//       real agent. FRIZZ_E2E_PAGE_CLAIMS=1 leaves the prompt-box insert for a real page open on that
//       Frizz to claim, instead of taking it itself.
//
// FRIZZ_E2E_KEEP=1 keeps the scratch folder (editor logs, the page's screenshot) even when the run passes.
//
// NEVER ON THE REAL DISPLAY. On Linux the run re-executes itself under `xvfb-run -a` with DISPLAY and
// WAYLAND_DISPLAY removed — on this machine DISPLAY=:0 is the maintainer's screen through WSLg, and a
// VS Code window popping up there is the most disruptive thing a test can do. The editor gets its own
// user-data and extensions directories and every other extension disabled; the page is headless.

import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron"
import type { EditorProject } from "@frizz/shared/editor-protocol"
import { Workbench } from "../e2e/cdp.ts"
import { FakeFrizz } from "../e2e/fake-frizz.ts"
import { watchPageClaim, type PageClaimResult } from "../e2e/page-claim.ts"

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repo = resolve(pkg, "..", "..")

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

const stackMode = process.argv.includes("--stack")
if (stackMode && process.env.FRIZZ_E2E_ORIGIN) {
  console.error("--stack boots its own Frizz; unset FRIZZ_E2E_ORIGIN.")
  process.exit(1)
}
const dispatch = process.env.FRIZZ_E2E_DISPATCH === "1"

/** `oldest` is the manifest's floor: `engines.vscode` "^1.90.0" → "1.90.0". */
function vscodeVersion(): string {
  const wanted = process.env.FRIZZ_E2E_VSCODE ?? "stable"
  if (wanted !== "oldest") return wanted
  const engines = (JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as { engines: { vscode: string } }).engines.vscode
  return engines.replace(/^[\^~>=]+/u, "")
}

const build = spawnSync("nub", ["scripts/build.ts", "--e2e"], { cwd: pkg, stdio: "inherit" })
if (build.status !== 0) process.exit(build.status ?? 1)

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "frizz-vscode-e2e-")))
const log = (line: string) => console.log(`frizz e2e: ${line}`)

// ── STACK mode: a disposable two-project Frizz, and everything it may start ───────────────────────────

interface StackInfo {
  port: number
  home: string
  tenants: { id: string; slug: string; dir: string }[]
}

interface Stack {
  origin: string
  tenant: { id: string; slug: string; dir: string }
  /** Every opener the server spawned; empty when every open went over the editor connection. */
  openers(): string
  teardown(): Promise<void>
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as { port: number }
  await new Promise((resolve) => server.close(resolve))
  return port
}

function gitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=frizz e2e", "-c", "user.email=e2e@frizz.invalid", ...args], { cwd: dir, stdio: "ignore" })
  git("init", "-q")
  writeFileSync(join(dir, "README.md"), `# ${dir}\n`)
  git("add", ".")
  git("commit", "-q", "-m", "init")
  return realpathSync(dir)
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

async function waitGone(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (check()) {
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return true
}

/**
 * Processes a stack left behind: anything whose environment carries its sandbox HOME (a detached
 * worker daemon inherits it) or whose command line names it. Read from /proc where there is one, and
 * from `ps` everywhere. Never ourselves, never our ancestors.
 */
function leftovers(home: string): number[] {
  const found = new Set<number>()
  const own = new Set([process.pid, process.ppid])
  if (existsSync("/proc")) {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/u.test(entry)) continue
      try {
        if (readFileSync(`/proc/${entry}/environ`, "utf8").split("\0").includes(`HOME=${home}`)) found.add(Number(entry))
      } catch {}
    }
  }
  try {
    for (const line of execFileSync("ps", ["-Ao", "pid=,args="], { encoding: "utf8" }).split("\n")) {
      const match = /^\s*(\d+)\s+(.*)$/u.exec(line)
      if (match && match[2]!.includes(home)) found.add(Number(match[1]))
    }
  } catch {}
  return [...found].filter((pid) => !own.has(pid))
}

async function bootStack(): Promise<Stack> {
  const launcher = gitRepo(join(scratch, "launcher"))
  const tenantDir = gitRepo(join(scratch, "tenant"))
  // A HOME this run owns from the first moment, so its processes can be found even if the stack dies
  // before it says where it is. `--home` keeps adhoc-stack from deleting it; the teardown does.
  const home = realpathSync(mkdtempSync(join(tmpdir(), "frizz-vscode-e2e-home-")))
  // Every opener the server could fall back to is a stub that writes down how it was called: a spawn
  // must never reach the human's real VS Code (on WSL `code` on PATH is the Windows one, under /mnt),
  // and one that happened is a failure of the run — the opens are meant to go over the editor socket.
  const stubs = join(scratch, "stub-bin")
  const opened = join(scratch, "openers.log")
  mkdirSync(stubs)
  for (const name of ["code", "code-insiders", "cursor", "windsurf", "xdg-open", "open", "wslview", "explorer.exe", "cmd.exe"]) {
    writeFileSync(join(stubs, name), `#!/bin/sh\necho "${name} $*" >> '${opened}'\n`)
    chmodSync(join(stubs, name), 0o755)
  }
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: [stubs, ...(process.env.PATH ?? "").split(delimiter).filter((dir) => dir && !dir.startsWith("/mnt/"))].join(delimiter) }
  delete env.WAYLAND_DISPLAY
  delete env.FRIZZ_E2E_UNDER_XVFB

  const port = await freePort()
  const stackLog = join(scratch, "stack.log")
  const out = openSync(stackLog, "w")
  // Its own process group (`detached`), so the teardown reaches nub's node child with one signal.
  const child: ChildProcess = spawn("nub", [
    "scripts/adhoc-stack.mjs", `--port=${port}`, `--project=${launcher}`, `--also-project=${tenantDir}`, `--home=${home}`, ...(dispatch ? ["--creds"] : []),
  ], { cwd: repo, env, stdio: ["ignore", out, out], detached: true })
  closeSync(out)
  const pid = child.pid!
  let exited = false
  child.on("exit", () => (exited = true))
  log(`stack: pid ${pid} (process group), port ${port}, HOME ${home}; its log is ${stackLog}`)

  const groupAlive = () => alive(-pid)
  const tearDown = async () => {
    try {
      process.kill(-pid, "SIGTERM")
    } catch {}
    if (!(await waitGone(groupAlive, 20_000))) {
      log(`stack: process group ${pid} ignored SIGTERM for 20s; killing it`)
      try {
        process.kill(-pid, "SIGKILL")
      } catch {}
      await waitGone(groupAlive, 5_000)
    }
    // Worker daemons are detached into groups of their own; the sandbox HOME in their environment names them.
    let strays = leftovers(home)
    for (const stray of strays) try { process.kill(stray, "SIGTERM") } catch {}
    if (strays.length && !(await waitGone(() => leftovers(home).length > 0, 10_000))) {
      for (const stray of leftovers(home)) try { process.kill(stray, "SIGKILL") } catch {}
    }
    strays = leftovers(home)
    log(strays.length ? `stack: STILL RUNNING after teardown: ${strays.join(", ")}` : `stack: torn down (pid ${pid}${exited ? " exited" : ""}; nothing left with its HOME)`)
    rmSync(home, { recursive: true, force: true })
  }
  let tearing: Promise<void> | undefined
  const teardown = () => (tearing ??= tearDown())
  // Published the moment the group exists, not when the boot returns: a Ctrl-C during the minute the
  // stack takes to come up must still reach it, and `stack` is not assigned until it is up.
  stackTeardown = teardown

  try {
    const deadline = Date.now() + 180_000
    let info: StackInfo | undefined
    while (!info) {
      const line = readFileSync(stackLog, "utf8").split("\n").find((candidate) => candidate.startsWith('{"url"'))
      if (line) info = JSON.parse(line) as StackInfo
      else if (exited) throw new Error(`the stack exited before it was up; see ${stackLog}`)
      else if (Date.now() > deadline) throw new Error(`the stack was not up within 180s; see ${stackLog}`)
      else await new Promise((resolve) => setTimeout(resolve, 250))
    }
    const tenant = info.tenants[0]
    if (!tenant) throw new Error(`the stack registered no tenant; see ${stackLog}`)
    return {
      origin: `http://127.0.0.1:${info.port}`,
      tenant,
      openers: () => (existsSync(opened) ? readFileSync(opened, "utf8").trim() : ""),
      teardown,
    }
  } catch (error) {
    await teardown()
    throw error
  }
}

// ── the run ───────────────────────────────────────────────────────────────────────────────────────────

let stack: Stack | undefined
/** The stack's teardown, set as soon as it is spawned; idempotent, so the boot's own failure path and the run's may both call it. */
let stackTeardown: (() => Promise<void>) | undefined
let fake: FakeFrizz | undefined
/** A second fake on another port, which the sidebar's suite moves the window to, as a Frizz restarting elsewhere would. */
let fakeElsewhere: FakeFrizz | undefined
let exitCode = 1
let pageClaim: Promise<PageClaimResult> | undefined
const stopPage = new AbortController()
let pageBrowser: ChildProcess | undefined
let sample: string | undefined
let wroteSample = false
let tornDown = false
/** The editor's workbench over its debugging port, opened the first time the suite presses a key or reads the title row. */
let workbench: Promise<Workbench> | undefined

async function teardown(): Promise<void> {
  if (tornDown) return
  tornDown = true
  stopPage.abort()
  if (workbench) (await workbench.catch(() => undefined))?.close()
  if (pageClaim) await Promise.race([pageClaim, new Promise((resolve) => setTimeout(resolve, 15_000))])
  // The handle, not a bare pid: a browser the watcher already closed has an exit code, so its pid —
  // possibly someone else's process by now — is never signalled.
  if (pageBrowser && pageBrowser.exitCode === null && pageBrowser.signalCode === null) {
    log(`the page's browser (pid ${pageBrowser.pid}) outlived its watcher; killing it`)
    pageBrowser.kill("SIGKILL")
  }
  await fake?.close()
  await fakeElsewhere?.close()
  await stackTeardown?.()
  if (sample && wroteSample) rmSync(sample, { force: true })
}

// Interrupted (Ctrl-C, a timeout's SIGTERM): still tear down what this run started.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log(`${signal}: tearing down`)
    void teardown().finally(() => process.exit(130))
  })
}

try {
  if (stackMode) stack = await bootStack()
  const realOrigin = stack?.origin ?? process.env.FRIZZ_E2E_ORIGIN
  const mode = realOrigin ? "real" : "fake"
  const projectDir = stack?.tenant.dir ?? process.env.FRIZZ_E2E_PROJECT_DIR
  if (mode === "real" && !projectDir) throw new Error("REAL mode needs FRIZZ_E2E_PROJECT_DIR: a folder registered as a project in that Frizz.")

  const workspace = mode === "real" ? realpathSync(projectDir!) : join(scratch, "workspace")
  sample = join(workspace, "src", "sample.ts")
  wroteSample = !existsSync(sample)
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

  if (mode === "fake") {
    const projects: EditorProject[] = [
      { id: randomUUID(), slug: "e2e", name: "e2e", dir: workspace, ready: 0, working: 0 },
      { id: "686f6d65-0000-4000-8000-000000000000", slug: "home", name: "Home", dir: homedir(), home: true },
    ]
    fake = await new FakeFrizz(projects).listen()
    fakeElsewhere = await new FakeFrizz(structuredClone(projects)).listen()
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

  const pageClaims = stack ? true : process.env.FRIZZ_E2E_PAGE_CLAIMS === "1"
  if (stack) {
    // "Add to Frizz prompt" selects the sample's lines 2-3; the page must show that chip.
    pageClaim = watchPageClaim({
      origin,
      project: stack.tenant.slug,
      token: "@sample.ts:2-3",
      shot: join(scratch, "page-claim.png"),
      timeoutMs: 600_000,
      signal: stopPage.signal,
      onBrowser: (browser) => (pageBrowser = browser),
    }).catch((error: unknown): PageClaimResult => ({ ok: false, value: "", errors: [String(error)] }))
  }

  // Keys and the title row go through the workbench's debugging port (e2e/cdp.ts): a keybinding is only
  // proved by a key, and what the title row shows only by the title row. The port is a free one on
  // loopback, and the editor it belongs to is this run's own, under Xvfb.
  const debuggingPort = await freePort()
  if (fake) {
    const connect = () => (workbench ??= Workbench.connect(debuggingPort))
    fake.workbench = {
      press: async (chord) => (await connect()).press(chord),
      evaluate: async (expression) => (await connect()).evaluate(expression),
      click: async (selector) => (await connect()).click(selector),
    }
  }

  const vscodeExecutablePath = await downloadAndUnzipVSCode({ version: vscodeVersion(), cachePath: join(homedir(), ".cache", "frizz-vscode-e2e") })
  log(`${stack ? "stack" : mode} mode against ${origin}${stack ? ` (tenant ${stack.tenant.slug})` : ""}, VS Code ${vscodeExecutablePath}, DISPLAY=${process.env.DISPLAY ?? "(none)"}`)
  const suiteCode = await runTests({
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
      `--remote-debugging-port=${debuggingPort}`,
    ],
    extensionTestsEnv: {
      FRIZZ_E2E_MODE: mode,
      FRIZZ_E2E_WORKSPACE: workspace,
      FRIZZ_E2E_CONTROL: fake?.origin,
      FRIZZ_E2E_CONTROL_ELSEWHERE: fakeElsewhere?.origin,
      FRIZZ_E2E_DISPATCH: process.env.FRIZZ_E2E_DISPATCH,
      FRIZZ_E2E_THREAD: process.env.FRIZZ_E2E_THREAD,
      FRIZZ_E2E_SET_OPENER: stack ? "1" : process.env.FRIZZ_E2E_SET_OPENER,
      FRIZZ_E2E_PAGE_CLAIMS: pageClaims ? "1" : undefined,
      FRIZZ_E2E_ONLY: process.env.FRIZZ_E2E_ONLY,
    },
  }).catch((error: unknown) => {
    log(`the suite did not run: ${(error as Error).message}`)
    return 1
  })
  exitCode = suiteCode

  if (pageClaim) {
    // The suite has sent its insert by now (or failed); the page gets a short grace to show it.
    const claimed = await Promise.race([pageClaim, new Promise<undefined>((resolve) => setTimeout(resolve, suiteCode === 0 ? 60_000 : 1_000))])
    if (!claimed) {
      stopPage.abort()
      log("the page never showed the chip")
      exitCode ||= 1
    } else if (!claimed.ok) {
      log(`the page never showed the chip (its new-thread box: ${JSON.stringify(claimed.value)})`)
      exitCode ||= 1
    } else {
      log(`the page claimed the insert: its new-thread box reads ${JSON.stringify(claimed.value)}`)
    }
  }
  if (stack) {
    const openers = stack.openers()
    if (openers) {
      log(`the server spawned a file opener instead of using the editor connection:\n${openers}`)
      exitCode ||= 1
    } else {
      log("no file opener was spawned: every open went over the editor connection")
    }
  }
} catch (error) {
  log((error as Error).message)
  exitCode ||= 1
} finally {
  await teardown()
  if (exitCode === 0 && process.env.FRIZZ_E2E_KEEP !== "1") rmSync(scratch, { recursive: true, force: true })
  else log(`${exitCode === 0 ? "passed" : "failed"}; the editor's logs${stackMode ? ", the stack's log and the page's screenshot" : ""} are kept under ${scratch}`)
}
process.exit(exitCode)
