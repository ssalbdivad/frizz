#!/usr/bin/env node
// Escape the moment a drawer is back from /full, and check it CLOSES — and stays closed, with the address
// on the tab's view. The way back from /full opens the drawer in the page's first render, inside
// react-router's view transition, and the page's route effects (its store → URL writer, useRouteToStore)
// run only as that transition lets them: 1.0-1.3s later at a load average of ~6. An Escape in that window
// closed the drawer with no writer to record it; the route then applied the drawer's address and the board
// opened the drawer again (lib/router.ts `adopted`, `routerTransitioning`). Before the fix this failed 1 of
// 6 and then 8 of 12 round trips on the stack below at a load average of 4-6; after it, none of 41
// (2026-09-29).
//
// Each round trip: open a card's drawer from its title, ⋯ → Open fullscreen, the way back, then Escape
// three times 150ms apart as soon as the drawer is in the DOM. `--view=all` runs it on All projects
// (bare `/`) instead of the launcher's focused view; `--stay` is the control — no Escape, and the drawer
// and its address must still be there.
//
// Usage:
//   nub scripts/adhoc-stack.mjs --port=47701 --project=/tmp/x/acme-api --also-project=/tmp/x/marketing-site \
//     --also-project=/tmp/x/billing-worker --also-project=/tmp/x/docs-portal > /tmp/stack.log 2>&1   # background
//   nub scripts/seed-all-queues.mjs --stack=/tmp/stack.log
//   nub scripts/verify-full-return-escape.mjs --stack=/tmp/stack.log [--trips=8] [--view=all] [--stay]
// Exits non-zero when any round trip fails.
import { readFileSync } from "node:fs"
import puppeteer from "puppeteer"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => { const s = a.slice(2); const i = s.indexOf("="); return i < 0 ? [s, true] : [s.slice(0, i), s.slice(i + 1)] }),
)
if (!flags.stack) {
  console.error("usage: nub scripts/verify-full-return-escape.mjs --stack=/abs/stack.log [--trips=8] [--view=all] [--stay]")
  process.exit(1)
}
const stack = JSON.parse(readFileSync(flags.stack, "utf8").split("\n").find((l) => l.startsWith('{"url"')))
const origin = new URL(stack.url).origin
const trips = Number(flags.trips ?? 8)
const home = flags.view === "all" ? "/" : `/?project=${stack.launcher.slug}`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] })
let failed = 0
const errors = []
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1000 })
  page.on("pageerror", (error) => errors.push(String(error)))
  // Click only once the target is on screen and holding still for two frames (a drawer slides in, a Radix
  // menu mounts its items before positioning them).
  const clickSettled = async (selector) => {
    const handle = await page.waitForFunction((selector) => new Promise((resolve) => {
      const el = document.querySelector(selector)
      const at = el?.getBoundingClientRect()
      if (!el || !at || at.width === 0 || at.top < 0 || at.bottom > innerHeight) return resolve(null)
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const now = el.getBoundingClientRect()
        resolve(now.x === at.x && now.y === at.y ? el : null)
      }))
    }), { timeout: 15_000 }, selector).catch(() => { throw new Error(`${selector} never settled on screen`) })
    await handle.asElement().click()
  }
  const land = async () => {
    await page.goto(`${origin}${home}`, { waitUntil: "networkidle2", timeout: 90_000 })
    await page.waitForSelector("[data-xq-card] h3 a", { timeout: 30_000 })
    await sleep(1000)
  }
  await land()
  for (let trip = 1; trip <= trips; trip++) {
    let verdict
    try {
      await clickSettled("[data-xq-card] h3 a")
      await page.waitForFunction(() => /^\/all\/[^/]+\/thread\/[^/]+$/.test(location.pathname), { timeout: 8000 })
      const drawer = await page.evaluate(() => location.pathname)
      await page.waitForSelector("[data-drawer-layer] [data-thread-menu]", { timeout: 15_000 })
      await sleep(800)
      await clickSettled("[data-drawer-layer] [data-thread-menu]")
      await clickSettled('[role="menuitem"][data-value="fullscreen"]')
      await page.waitForFunction(() => location.pathname.endsWith("/full"), { timeout: 8000 })
      await page.waitForSelector("[data-standalone-return]", { timeout: 8000 })
      await sleep(1000)
      await page.click("[data-standalone-return]")
      // Off /full first — the click returns before the navigation does — then the drawer, and Escape at once.
      await page.waitForFunction(() => !location.pathname.endsWith("/full"), { timeout: 8000 })
      await page.waitForSelector("[data-drawer-layer]", { timeout: 8000 })
      if (!flags.stay) {
        for (let i = 0; i < 3; i++) {
          await page.keyboard.press("Escape")
          await sleep(150)
        }
        // The close is written once the return's transition has finished, which takes seconds under load.
        await page.waitForFunction((home) => location.pathname + location.search === home && !document.querySelector("[data-drawer-layer]"), { timeout: 15_000 }, home).catch(() => {})
      }
      // …and it has to STAY that way: the bug re-opened the drawer ~1s after it closed.
      await sleep(2500)
      const after = await page.evaluate(() => ({ drawer: Boolean(document.querySelector("[data-drawer-layer]")), at: location.pathname + location.search }))
      const ok = flags.stay ? after.drawer && after.at === drawer : !after.drawer && after.at === home
      verdict = `${ok ? "PASS" : "FAIL"}  round trip ${trip}: ${drawer} → ${after.at}${after.drawer ? " (drawer open)" : ""}`
      if (!ok) failed++
      if (after.drawer) await land()
    } catch (error) {
      failed++
      verdict = `FAIL  round trip ${trip}: ${error instanceof Error ? error.message : String(error)} (at ${await page.evaluate(() => location.pathname + location.search)})`
      await land()
    }
    console.log(verdict)
  }
} finally {
  await browser.close()
}
if (errors.length) console.log(`page errors: ${errors.slice(0, 3).join(" | ")}`)
console.log(`\n${trips - failed}/${trips} passed`)
process.exit(failed || errors.length ? 1 : 0)
