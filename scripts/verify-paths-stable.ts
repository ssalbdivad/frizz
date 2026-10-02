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
// Exit 0 when every assertion passes, 1 otherwise. The server is stopped by its exact pid and the
// throwaway home removed in `finally`.
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
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
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
