// Does a web edit reach an open tab in `frizz-dev --dev` — before AND after the control-plane child
// restarts? Boots a `--dev --sandbox` launcher from THIS checkout, opens the board headless, edits the
// project switcher's label, then touches a server file (which recycles the child onto a new private
// port) and edits the label again. A tab that only picks up the first edit has lost its HMR socket.
//
//   nub scripts/verify-dev-hmr.ts
//
// It edits ProjectSwitcher.tsx and a server source file in place and restores both on exit, so run it
// in a worktree, never in a checkout someone is working in.
import { spawn } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import puppeteer from "puppeteer"

const root = resolve(import.meta.dirname, "..")
const webFile = resolve(root, "packages/web/src/components/ProjectSwitcher.tsx")
const serverFile = resolve(root, "packages/server/src/qr.ts")
const webOriginal = readFileSync(webFile, "utf8")
const serverOriginal = readFileSync(serverFile, "utf8")
// The switcher button's label — on screen without opening anything.
const LABEL = ': "All projects"'
if (!webOriginal.includes(LABEL)) throw new Error(`${webFile} no longer renders ${LABEL}`)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let log = ""
const launcher = spawn("nub", ["--no-env-file", resolve(root, "src/index.ts"), "--dev", "--sandbox", "--no-app"], {
  cwd: root,
  env: { ...process.env, FRIZZ_SOURCE_COMMAND: "frizz-dev" },
  stdio: ["ignore", "pipe", "pipe"],
})
launcher.stdout!.on("data", (chunk) => { log += chunk })
launcher.stderr!.on("data", (chunk) => { log += chunk })

const browser = await puppeteer.launch({ headless: true })
const restore = () => {
  writeFileSync(webFile, webOriginal)
  writeFileSync(serverFile, serverOriginal)
}
const results: Record<string, unknown> = {}
try {
  let origin = ""
  for (let i = 0; i < 300 && !origin; i++) {
    origin = log.match(/local: (http:\/\/127\.0\.0\.1:\d+)/)?.[1] ?? ""
    await sleep(1000)
  }
  if (!origin) throw new Error(`launcher never printed its address:\n${log}`)
  const page = await browser.newPage()
  const consoleLines: string[] = []
  page.on("console", (m) => consoleLines.push(m.text()))
  await page.goto(origin, { waitUntil: "networkidle2", timeout: 120_000 })
  await page.waitForFunction(() => document.body.innerText.includes("All projects"), { timeout: 60_000 })
  // A full page load would also show the new label; this marker survives HMR and dies on a reload.
  await page.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true })

  const seen = async (marker: string, ms: number) => {
    try {
      await page.waitForFunction((m) => document.body.innerText.includes(m), { timeout: ms }, marker)
      return { updated: true, reloaded: !(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)) }
    } catch {
      return { updated: false }
    }
  }

  writeFileSync(webFile, webOriginal.replace(LABEL, ': "All projects HMR1"'))
  results.beforeRestart = await seen("All projects HMR1", 20_000)

  // Recycle the child: a server source edit, exactly what another agent's save does.
  const status = async () => (await fetch(`${origin}/_frizz/control/status`, { headers: { "sec-fetch-site": "same-origin" } }).then((r) => r.json()).catch(() => null)) as { state?: string } | null
  writeFileSync(serverFile, `${serverOriginal}\n// hmr probe ${Date.now()}\n`)
  let sawRestart = false
  for (let i = 0; i < 120; i++) {
    const s = await status()
    if (s?.state === "restarting") sawRestart = true
    if (sawRestart && s?.state === "ready") break
    await sleep(500)
  }
  results.childRestarted = sawRestart
  await sleep(3000)
  await page.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true })

  writeFileSync(webFile, webOriginal.replace(LABEL, ': "All projects HMR2"'))
  results.afterRestart = await seen("All projects HMR2", 20_000)
  results.viteConsole = consoleLines.filter((line) => line.includes("[vite]"))
} finally {
  restore()
  await browser.close()
  launcher.kill("SIGINT")
  await new Promise((r) => launcher.once("exit", r))
}
console.log(JSON.stringify(results, null, 2))
