// A RUNNING FRIZZ KEEPS ITS DATA ROOT WHEN A STRAY `~/.frizz/registry.json` APPEARS.
//
// The incident (2026-10-02): a test harness wrote a registry into a debris `~/.frizz` on a machine whose
// install lives under the XDG data root. The live server re-resolved its roots on its next registry
// lookup, took that file for a legacy install, found none of its projects there, and every worker's
// `/_frizz/<project>/rpc/…` call answered 404. frizz-paths.ts now memoises the resolution per process;
// this drives the REAL server through the REAL route that broke.
//
//   nub scripts/verify-paths-stable.ts
//
// What it does, all under one throwaway HOME (the real ~/.frizz and XDG roots are never touched):
//   1. seeds an XDG-layout install: `<home>/.local/share/frizz/registry.json` (empty), and lets
//      adhoc-stack create its usual EMPTY `<home>/.frizz` — exactly the debris shape: a `~/.frizz` with
//      no registry beside a platform root that has one, which resolves to the platform root;
//   2. boots a real server (scripts/adhoc-stack.mjs, own port) on a throwaway git repo;
//   3. reads `/_frizz/<slug>/rpc/board` — must be 200;
//   4. drops the stray `<home>/.frizz/registry.json` the incident harness wrote;
//   5. reads the same route repeatedly for a few seconds — every answer must still be 200, and the
//      project must still be listed by `/_frizz/rpc/projectsList`;
//   6. CONTROL: a fresh process resolving the same home now picks `~/.frizz` (legacy: true), so the
//      stray file genuinely flips the rule — the server holding still is the memo, not a write that
//      missed. Run against the unmemoised frizz-paths.ts, step 5 answers 404 (see the commit message).
//
// Two more cases, added after review, each under its own throwaway HOME:
//
//   RESTART — the board the maintainer actually runs is a dev SUPERVISOR (`nub src/dev.ts`; the
//   production launcher is the same supervisor) that forks a fresh server child on every source edit,
//   crash and Update & Restart. Memoising inside one process did not survive that: the new child
//   resolved again at boot and took the stray `~/.frizz`. This boots the real `src/dev.ts`, drops the
//   stray registry, SIGKILLs the FRIZZ_DEV_CHILD process, waits for the supervisor to fork another, and
//   reads the board 10 times — all must be 200 (the supervisor now hands each child its decision,
//   frizz-paths.ts `withRootsPin`). Its control is the same run with no stray write.
//
//   READER — a long-lived process that only DISCOVERS a server (the VS Code extension host's
//   `discoverFrizz`) on a machine that has never run Frizz. Debris `~/.frizz/runtimes` appears, then the
//   first server boots and — correctly, since no platform registry exists yet — establishes its install
//   in `~/.frizz`. The reader must find that server. A reader that froze its fresh-machine answer kept
//   looking under the platform root and found nothing; readers now resolve afresh per lookup
//   (`frizzPathsNow`).
//
//   nub scripts/verify-paths-stable.ts [--case=stack|restart|reader]   (default: all three)
//
// Linux only (the restart case finds the dev child through /proc). Exit 0 when every assertion passes,
// 1 otherwise. Every server is stopped by its exact pid or process group, and every throwaway home is
// removed in `finally`.
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
let failures = 0
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/** The environment a fresh shell would give the stack: nothing of this worker's Frizz, no XDG roots. */
function cleanEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("FRIZZ_") || key.startsWith("CLAUDE") || key.startsWith("XDG_") || key === "LOCALAPPDATA") continue
    env[key] = value
  }
  env.HOME = home
  return env
}

async function stackCase(): Promise<void> {
  console.log("\n## stack: one server process, stray registry mid-run")
  const home = mkdtempSync(join(tmpdir(), "frizz-paths-stable-home-"))
  const project = join(home, "proj")
  let stack: ChildProcess | undefined
  try {
    // 1. The XDG install the live server stands on, and a project to serve.
    const platformData = join(home, ".local", "share", "frizz")
    mkdirSync(platformData, { recursive: true })
    writeFileSync(join(platformData, "registry.json"), JSON.stringify({ version: 1, projects: [] }))
    mkdirSync(project, { recursive: true })
    execFileSync("git", ["init", "-q"], { cwd: project })

    // 2. A real server. adhoc-stack reads the HOME it is handed via --home and keeps it (we delete it).
    const port = await freePort()
    // HOME stays the REAL one for adhoc-stack itself: it resolves the shared runtimes cache under it and
    // only then swaps process.env.HOME to --home, before the server derives a single path.
    const env = { ...cleanEnv(home), HOME: process.env.HOME }
    stack = spawn("nub", ["scripts/adhoc-stack.mjs", `--home=${home}`, `--project=${project}`, `--port=${port}`], {
      cwd: repo,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stderr = ""
    stack.stderr!.on("data", (chunk) => { stderr += String(chunk) })
    const announced = await new Promise<{ slug: string; port: number }>((resolve, reject) => {
      let out = ""
      const timer = setTimeout(() => reject(new Error(`stack did not announce within 120s\n${stderr.slice(-2000)}`)), 120_000)
      stack!.stdout!.on("data", (chunk) => {
        out += String(chunk)
        const line = out.split("\n").find((l) => l.startsWith("{"))
        if (line) { clearTimeout(timer); resolve(JSON.parse(line)) }
      })
      // Early exit on the failure signal: a stack that died will never announce.
      stack!.once("exit", (code) => { clearTimeout(timer); reject(new Error(`stack exited ${code} before announcing\n${stderr.slice(-2000)}`)) })
    })
    const origin = `http://127.0.0.1:${announced.port}`
    const headers = { origin, "sec-fetch-site": "same-origin" }
    const board = async () => (await fetch(`${origin}/_frizz/${announced.slug}/rpc/board?input=%7B%7D`, { headers })).status
    const listed = async () => {
      const body = await (await fetch(`${origin}/_frizz/rpc/projectsList`, { headers })).json() as { result?: Array<{ slug?: string }> }
      return (body.result ?? []).some((entry) => entry.slug === announced.slug)
    }
    console.log(`stack up on ${origin}, project slug ${announced.slug}, pid ${stack.pid}`)

    // 3. Before: the project answers.
    check(await board() === 200, "before the stray write, /_frizz/<slug>/rpc/board answers 200")
    check(await listed(), "before the stray write, projectsList lists the project")
    // The server must have booted on the PLATFORM root — otherwise the stray write below would simply
    // overwrite its own registry and prove nothing about a flip.
    const booted = JSON.parse(readFileSync(join(platformData, "registry.json"), "utf8")) as { projects: Array<{ slug?: string }> }
    check(booted.projects.some((entry) => entry.slug === announced.slug), "the server registered the project under the XDG data root, not ~/.frizz")

    // 4. The incident's write: a registry inside the debris ~/.frizz, holding none of our projects.
    writeFileSync(join(home, ".frizz", "registry.json"), JSON.stringify({ version: 1, projects: [] }))

    // 5. After: every lookup for ~3s still lands on the root the server booted on.
    const statuses: number[] = []
    for (let i = 0; i < 15; i++) {
      statuses.push(await board())
      await new Promise((r) => setTimeout(r, 200))
    }
    check(statuses.every((s) => s === 200), "after the stray write, 15 reads over ~3s all answer 200", statuses.join(","))
    check(await listed(), "after the stray write, projectsList still lists the project")

    // 6. Control: a FRESH process resolving the same home now takes ~/.frizz — the write did flip the rule.
    const fresh = execFileSync("nub", ["-e", `import("${join(repo, "packages/server/src/frizz-paths.ts")}").then((m) => console.log(JSON.stringify(m.frizzPaths())))`], {
      cwd: repo,
      env: cleanEnv(home),
      encoding: "utf8",
    }).trim().split("\n").at(-1)!
    const resolved = JSON.parse(fresh) as { data: string; legacy: boolean }
    check(resolved.legacy === true && resolved.data === join(home, ".frizz"), "control: a fresh process now resolves the stray ~/.frizz", resolved.data)
  } catch (error) {
    failures++
    console.log(`FAIL harness error — ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (stack?.pid && stack.exitCode === null) {
      const exited = new Promise((r) => stack!.once("exit", r))
      stack.kill("SIGTERM")
      await Promise.race([exited, new Promise((r) => setTimeout(r, 15_000))])
      if (stack.exitCode === null && stack.signalCode === null) stack.kill("SIGKILL")
    }
    rmSync(home, { recursive: true, force: true })
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Every descendant pid of `pid`, from /proc. */
function descendants(pid: number): number[] {
  const out: number[] = []
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8")
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1])
      if (ppid === pid) out.push(Number(entry), ...descendants(Number(entry)))
    } catch {}
  }
  return out
}

/** The supervisor's current server child: the descendant whose environment carries FRIZZ_DEV_CHILD=1. */
function devChild(supervisor: number): number | undefined {
  for (const pid of descendants(supervisor)) {
    try {
      if (readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes("FRIZZ_DEV_CHILD=1")) return pid
    } catch {}
  }
  return undefined
}

/** A real `nub src/dev.ts` board under `home`, in its own process group so one signal stops all of it. */
function bootDev(home: string, project: string, port: number): { proc: ChildProcess; log: () => string } {
  const env = cleanEnv(home)
  env.FRIZZ_WAKERS_OFF = "1"
  env.FRIZZ_ORPHAN_REAPER_OFF = "1"
  // The shared runtimes cache under the REAL home, as adhoc-stack does, so no provider is downloaded.
  env.FRIZZ_RUNTIMES_DIR = join(homedir(), ".cache", "frizz", "runtimes")
  const proc = spawn("nub", [join(repo, "src/dev.ts"), "--port", String(port)], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"], detached: true })
  let log = ""
  proc.stdout!.on("data", (chunk) => { log += String(chunk) })
  proc.stderr!.on("data", (chunk) => { log += String(chunk) })
  return { proc, log: () => log }
}

async function stopGroup(proc: ChildProcess | undefined): Promise<void> {
  if (!proc?.pid) return
  try { process.kill(-proc.pid, "SIGTERM") } catch { return }
  for (let i = 0; i < 30 && proc.exitCode === null && proc.signalCode === null; i++) await sleep(500)
  try { process.kill(-proc.pid, "SIGKILL") } catch {}
}

async function status(url: string, headers: Record<string, string>): Promise<number> {
  try {
    return (await fetch(url, { headers, signal: AbortSignal.timeout(5_000) })).status
  } catch {
    return 0
  }
}

async function waitHealthy(origin: string, proc: ChildProcess, log: () => string, ms = 180_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    // Early exit on the failure signal: a supervisor that died will never answer.
    if (proc.exitCode !== null) throw new Error(`dev board exited ${proc.exitCode}\n${log().slice(-3000)}`)
    if (await status(`${origin}/health`, {}) === 200) return
    await sleep(500)
  }
  throw new Error(`dev board did not answer /health within ${ms / 1000}s\n${log().slice(-3000)}`)
}

async function restartCase(stray: boolean): Promise<void> {
  console.log(`\n## restart${stray ? "" : " (control: no stray write)"}: dev supervisor forks a fresh server child`)
  const home = mkdtempSync(join(tmpdir(), "frizz-paths-restart-home-"))
  const project = join(home, "proj")
  let board: ReturnType<typeof bootDev> | undefined
  try {
    const platformData = join(home, ".local", "share", "frizz")
    mkdirSync(platformData, { recursive: true })
    writeFileSync(join(platformData, "registry.json"), JSON.stringify({ version: 1, projects: [] }))
    mkdirSync(join(home, ".frizz"))
    mkdirSync(project)
    execFileSync("git", ["init", "-q"], { cwd: project })
    const port = await freePort()
    board = bootDev(home, project, port)
    const origin = `http://127.0.0.1:${port}`
    const headers = { origin, "sec-fetch-site": "same-origin" }
    await waitHealthy(origin, board.proc, board.log)
    const registry = JSON.parse(readFileSync(join(platformData, "registry.json"), "utf8")) as { projects: Array<{ slug?: string }> }
    const slug = registry.projects[0]?.slug
    check(Boolean(slug), "the board registered its project under the XDG data root")
    const read = () => status(`${origin}/_frizz/${slug}/rpc/board?input=%7B%7D`, headers)
    check(await read() === 200, "before: /_frizz/<slug>/rpc/board answers 200")

    if (stray) writeFileSync(join(home, ".frizz", "registry.json"), JSON.stringify({ version: 1, projects: [] }))
    const old = devChild(board.proc.pid!)
    if (!old) throw new Error("could not find the FRIZZ_DEV_CHILD process")
    process.kill(old, "SIGKILL")
    let fresh: number | undefined
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      if (board.proc.exitCode !== null) throw new Error(`supervisor exited ${board.proc.exitCode} after the child was killed`)
      fresh = devChild(board.proc.pid!)
      if (fresh && fresh !== old && await status(`${origin}/health`, {}) === 200) break
      await sleep(500)
    }
    check(Boolean(fresh && fresh !== old), "the supervisor forked a new server child", `${old} -> ${fresh}`)
    await sleep(2_000)
    const statuses: number[] = []
    for (let i = 0; i < 10; i++) {
      statuses.push(await read())
      await sleep(300)
    }
    check(statuses.every((s) => s === 200), "after the child restart, 10 board reads all answer 200", statuses.join(","))
  } finally {
    await stopGroup(board?.proc)
    rmSync(home, { recursive: true, force: true })
  }
}

async function readerCase(): Promise<void> {
  console.log("\n## reader: a discovery-only process on a fresh machine, debris, then the first server")
  const home = mkdtempSync(join(tmpdir(), "frizz-paths-reader-home-"))
  const project = join(home, "proj")
  let reader: ChildProcess | undefined
  let board: ReturnType<typeof bootDev> | undefined
  try {
    mkdirSync(project)
    execFileSync("git", ["init", "-q"], { cwd: project })
    // Stands in for the VS Code extension host: discovers every second, forever, in one process.
    const discover = join(repo, "packages/vscode/src/discovery.ts")
    const code = `const { discoverFrizz } = await import(${JSON.stringify(discover)}); for (;;) { const r = await discoverFrizz({ ports: [], timeoutMs: 800 }); console.log(JSON.stringify({ found: r.found?.origin ?? null })); await new Promise((res) => setTimeout(res, 1000)) }`
    const lines: string[] = []
    let readerErr = ""
    reader = spawn("nub", ["--input-type=module", "-e", code], { cwd: home, env: cleanEnv(home), stdio: ["ignore", "pipe", "pipe"], detached: true })
    reader.stdout!.on("data", (chunk) => { for (const line of String(chunk).split("\n")) if (line.startsWith("{")) lines.push(line) })
    reader.stderr!.on("data", (chunk) => { readerErr += String(chunk) })
    const first = Date.now() + 60_000
    while (lines.length === 0) {
      if (reader.exitCode !== null || Date.now() > first) throw new Error(`reader never reported\n${readerErr.slice(-2000)}`)
      await sleep(200)
    }
    check(JSON.parse(lines[0]!).found === null, "the reader starts on a machine with no Frizz and finds none")

    mkdirSync(join(home, ".frizz", "runtimes"), { recursive: true })
    const port = await freePort()
    board = bootDev(home, project, port)
    await waitHealthy(`http://127.0.0.1:${port}`, board.proc, board.log)
    check(existsSync(join(home, ".frizz", "registry.json")), "the first server established its install in ~/.frizz (no platform registry existed)")
    const seen = lines.length
    const deadline = Date.now() + 30_000
    while (lines.length < seen + 3 && Date.now() < deadline) await sleep(300)
    const last = JSON.parse(lines.at(-1)!) as { found: string | null }
    check(last.found === `http://127.0.0.1:${port}`, "the long-lived reader finds that server", String(last.found))
  } finally {
    await stopGroup(reader)
    await stopGroup(board?.proc)
    rmSync(home, { recursive: true, force: true })
  }
}

const only = process.argv.find((arg) => arg.startsWith("--case="))?.slice("--case=".length)
for (const [name, run] of [
  ["stack", stackCase],
  ["restart", () => restartCase(true)],
  ["restart", () => restartCase(false)],
  ["reader", readerCase],
] as const) {
  if (only && only !== name) continue
  try {
    await run()
  } catch (error) {
    failures++
    console.log(`FAIL ${name} harness error — ${error instanceof Error ? error.message : String(error)}`)
  }
}
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
