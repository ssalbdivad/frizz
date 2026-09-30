#!/usr/bin/env node
// The launcher's REAL launch path, end to end, and where it lands: the page focused on the project it was
// run in (`/?project=<slug>`, focus mode's default view, 2026-09-29), for a cold start and for a second
// launch that JOINS the running server from another repository.
//
// Nothing is stood in except the browser. The source launcher (`src/index.ts`, what `frizz-dev` runs)
// selects or builds its immutable artifact, starts the server, waits for health and "opens the default
// browser" — on Linux by exec'ing `xdg-open <url>`, which a stub first on PATH records instead. That
// recorded URL is then loaded in a headless Chrome and must show that project alone: the address kept,
// the READY header's switcher naming it, the list holding it and nothing else, no prompt-box picker.
//
// Everything runs under a throwaway HOME (so it never reaches ~/.frizz or a live board) with every
// FRIZZ_* variable dropped, on its own port — asked of BOTH launches, since a launch joins only a server
// on the port it asks (src/index.ts joinCandidatePorts): without it the second launch starts a rival on
// the default port. The first cold run builds an artifact (~1-2 min); the HOME is deleted after, with
// the servers stopped through the launcher's own `--stop`.
//
// Linux only (the xdg-open seam). Usage: nub scripts/verify-launcher-landing.mjs [--port=47741] [--keep]
import { execFileSync, spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import puppeteer from "puppeteer"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => { const s = a.slice(2); const i = s.indexOf("="); return i < 0 ? [s, true] : [s.slice(0, i), s.slice(i + 1)] }),
)
if (process.platform !== "linux") throw new Error("verify-launcher-landing records the browser open through xdg-open, which is Linux's")
const source = resolve(fileURLToPath(new URL("..", import.meta.url)))
const port = Number(flags.port ?? 47741)
const root = mkdtempSync(join(tmpdir(), "frizz-launcher-landing-"))
const home = join(root, "home")
const bin = join(root, "bin")
const opened = join(root, "opened.txt")
const projects = ["launch-demo", "second-proj"]
mkdirSync(home)
mkdirSync(bin)
for (const name of projects) {
  mkdirSync(join(root, name))
  execFileSync("git", ["init", "-q"], { cwd: join(root, name) })
  execFileSync("git", ["-c", "user.email=x@y", "-c", "user.name=x", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: join(root, name) })
}
writeFileSync(join(bin, "xdg-open"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(opened)}\n`)
chmodSync(join(bin, "xdg-open"), 0o755)
// A PATH with no Windows mounts (WSL puts some with spaces in them), and the stub first.
const env = {
  HOME: home,
  PATH: [bin, ...(process.env.PATH ?? "").split(":").filter((p) => p && !p.startsWith("/mnt/"))].join(":"),
  USER: process.env.USER ?? "frizz",
  LANG: "C.UTF-8",
  TERM: "dumb",
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const openedUrls = () => (existsSync(opened) ? readFileSync(opened, "utf8").split("\n").filter(Boolean) : [])
const launch = (project, args = []) => {
  const log = join(root, `${project}.log`)
  const child = spawn("nub", [join(source, "src/index.ts"), `--port=${port}`, ...args], { cwd: join(root, project), env, stdio: ["ignore", "pipe", "pipe"] })
  let text = ""
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { text += chunk; writeFileSync(log, text) })
  return { child, log: () => text }
}
const results = []
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`) }
async function waitForOpen(count, launched, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (openedUrls().length >= count) return openedUrls()[count - 1]
    if (launched.child.exitCode !== null && openedUrls().length < count) break
    await sleep(1000)
  }
  throw new Error(`the launcher opened no browser (${openedUrls().length} opened)\n${launched.log().slice(-1500)}`)
}

const launches = []
let browser
try {
  browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] })
  const landing = async (url, slug) => {
    const page = await browser.newPage()
    const errors = []
    page.on("pageerror", (error) => errors.push(String(error)))
    try {
      await page.setViewport({ width: 1440, height: 900 })
      await page.goto(url, { waitUntil: "networkidle2", timeout: 90_000 })
      await page.waitForFunction((slug) => document.querySelector("[data-xq-switcher-label]")?.textContent?.trim() === slug, { timeout: 30_000 }, slug).catch(() => {})
      await sleep(1000)
      await page.screenshot({ path: join(root, `landing-${slug}.png`) })
      const seen = await page.evaluate(async () => {
        const cards = (await (await fetch("/_frizz/rpc/projectsList")).json()).result ?? []
        const slugOf = (id) => cards.find((c) => c.id === id)?.slug ?? id
        return {
          address: location.pathname + location.search,
          switcher: document.querySelector("[data-xq-switcher-label]")?.textContent?.trim(),
          listed: [...document.querySelectorAll("[data-xq-rail-project]")].map((g) => slugOf(g.getAttribute("data-xq-rail-project"))),
          picker: Boolean(document.querySelector("[data-xq-project-picker]")),
        }
      })
      return { ...seen, errors }
    } finally {
      await page.close()
    }
  }
  const expectFocused = (what, url, seen, slug) => {
    check(`${what} opens /?project=${slug}`, url === `http://127.0.0.1:${port}/?project=${slug}`, url)
    check(`…which lands focused on ${slug} alone`, seen.address === `/?project=${slug}` && seen.switcher === slug && seen.listed.length === 1 && seen.listed[0] === slug && !seen.picker && seen.errors.length === 0, JSON.stringify(seen))
  }

  const first = launch(projects[0])
  launches.push(first)
  const url1 = await waitForOpen(1, first, 600_000)
  expectFocused("a cold launch", url1, await landing(url1, projects[0]), projects[0])

  const second = launch(projects[1])
  launches.push(second)
  const url2 = await waitForOpen(2, second, 180_000)
  check("the second launch joins the running server", /already running on port/.test(second.log()), second.log().split("\n").find((l) => l.includes("server")) ?? "")
  expectFocused("the joining launch", url2, await landing(url2, projects[1]), projects[1])
} finally {
  await browser?.close()
  for (const project of projects) {
    try { execFileSync("nub", [join(source, "src/index.ts"), "--stop"], { cwd: join(root, project), env, stdio: "ignore", timeout: 60_000 }) } catch {}
  }
  for (const { child } of launches) if (child.exitCode === null) child.kill("SIGTERM")
  await sleep(2000)
  // Anything still running out of the sandbox HOME (the launcher's own provider probes among them).
  const table = execFileSync("ps", ["-Ao", "pid=,command="], { encoding: "utf8" })
  const left = table.split("\n").map((row) => row.trim().match(/^(\d+)\s+(.*)$/)).filter((m) => m && m[2].includes(home)).map((m) => Number(m[1]))
  for (const pid of left) { try { process.kill(pid, "SIGTERM") } catch {} }
  if (left.length) console.log(`stopped ${left.length} leftover process(es) under the sandbox HOME: ${left.join(", ")}`)
  if (!flags.keep) rmSync(root, { recursive: true, force: true })
  else console.log(`kept ${root}`)
}
const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
