#!/usr/bin/env node
// Drive the ONE page — Everything, with no project view (2026-09-28) — on a real, seeded, multi-project
// stack, and check what the retirement promised the maintainer:
//   · no `/project/<slug>` address exists: every one lands on `/`, and nothing on the page links to one;
//   · the queue filter scopes the RIGHT column only — from the READY header's pill, from a project row's
//     ⋯ menu, and back out through the pill's ✕ — while the list keeps every project and marks the
//     filtered one;
//   · a project's other bands (Snoozed, Done, External) open in place under its row, and a row there
//     opens its thread's drawer on the page;
//   · /full is an option of the drawer's own menu, not a door on cards and rows; `f` in a drawer takes
//     it, and leaving /full comes back to the drawer;
//   · a `/login` typed into a card's reply box opens sign-in instead of reaching the worker;
//   · at a phone's width nothing overflows sideways.
//
// Usage:
//   nub scripts/adhoc-stack.mjs --port=47631 --project=/tmp/x/acme-api --also-project=/tmp/x/marketing-site \
//     --also-project=/tmp/x/billing-worker --also-project=/tmp/x/docs-portal > /tmp/stack.log 2>&1   # background
//   nub scripts/seed-all-queues.mjs --stack=/tmp/stack.log
//   nub scripts/verify-one-view.mjs --stack=/tmp/stack.log [--shots=/abs/dir]
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import puppeteer from "puppeteer"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => { const s = a.slice(2); const i = s.indexOf("="); return i < 0 ? [s, true] : [s.slice(0, i), s.slice(i + 1)] }),
)
if (!flags.stack) {
  console.error("usage: nub scripts/verify-one-view.mjs --stack=/abs/stack.log [--shots=/abs/dir]")
  process.exit(1)
}
const line = readFileSync(flags.stack, "utf8").split("\n").find((l) => l.startsWith("{\"url\""))
if (!line) throw new Error(`no stack json line in ${flags.stack}`)
const stack = JSON.parse(line)
const origin = new URL(stack.url).origin
const projects = [stack.launcher, ...stack.tenants].map((p) => ({ id: p.id, slug: p.slug }))
const shots = flags.shots ?? join(process.cwd(), ".adhoc-shots")
mkdirSync(shots, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`)
}
let failures = 0
async function step(name, run) {
  try {
    await run()
  } catch (error) {
    // What the page looked like when the step gave up — the only way to tell a real regression from a
    // selector that stopped matching.
    const shot = join(shots, `one-view-fail-${++failures}.png`)
    const where = await page?.evaluate(() => location.pathname).catch(() => "?")
    await page?.screenshot({ path: shot }).catch(() => {})
    check(name, false, `${error instanceof Error ? error.message : String(error)} (at ${where}; ${shot})`)
  }
}
let page

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--force-color-profile=srgb"] })
try {
  page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 })
  const errors = []
  page.on("pageerror", (error) => errors.push(`pageerror: ${error}`))
  page.on("console", (message) => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(`console: ${message.text()}`) })
  // A disposable stack runs no supervisor, so its control endpoint 404s on every page; nothing else may.
  page.on("response", (response) => { if (response.status() >= 400 && !response.url().endsWith("/_frizz/control/status")) errors.push(`${response.status()} ${response.url()}`) })
  const posts = []
  page.on("request", (request) => { if (request.method() === "POST" && request.url().includes("/rpc/")) posts.push(new URL(request.url()).pathname) })

  const path = () => page.evaluate(() => location.pathname)
  const waitPath = (predicate, what, ms = 10_000) => page.waitForFunction(predicate, { timeout: ms }).catch(async () => { throw new Error(`timed out waiting for ${what}; at ${await path()}`) })
  const cardProjects = () => page.$$eval("[data-xq-card]", (cards) => [...new Set(cards.map((c) => c.getAttribute("data-xq-card")?.split("/")[0]))])
  const escapeAll = async () => {
    for (let i = 0; i < 4 && (await page.$("[data-drawer-layer]")); i++) {
      await page.keyboard.press("Escape")
      await sleep(450)
    }
  }
  // Click only once the target is where the eye would find it: inside the viewport and holding still for
  // two frames. A Radix menu mounts its items BEFORE it has positioned them (off-screen, until measured),
  // and a drawer slides in over ~300ms, so a click issued the moment the node exists lands nowhere — which
  // puppeteer reports as "Node is either not clickable or not an Element".
  const clickSettled = async (selector, { text } = {}) => {
    const handle = await page.waitForFunction(
      (selector, text) => new Promise((resolve) => {
        const el = [...document.querySelectorAll(selector)].find((candidate) => text === undefined || candidate.textContent?.trim() === text)
        const at = el?.getBoundingClientRect()
        if (!el || !at || at.width === 0 || at.top < 0 || at.bottom > innerHeight || at.left < 0 || at.right > innerWidth) return resolve(null)
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const now = el.getBoundingClientRect()
          resolve(now.x === at.x && now.y === at.y ? el : null)
        }))
      }),
      { timeout: 8000 },
      selector,
      text,
    ).catch(async () => { throw new Error(`${selector}${text ? ` "${text}"` : ""} never settled on screen; at ${await path()}`) })
    await handle.asElement().click()
  }

  // ── no project view ──────────────────────────────────────────────────────────────────────────────
  for (const address of [`/project/${projects[0].slug}`, `/project/${projects[1].slug}/thread/whatever`, "/status/active", "/projects"]) {
    await step(`${address} lands on /`, async () => {
      await page.goto(`${origin}${address}`, { waitUntil: "networkidle2" })
      await waitPath(() => location.pathname === "/", "the page at /")
      check(`${address} lands on /`, true)
    })
  }
  await page.goto(`${origin}/`, { waitUntil: "networkidle2" })
  await page.waitForSelector("[data-xq-card]")
  await sleep(1200)
  await page.screenshot({ path: join(shots, "one-view-home.png") })
  await step("nothing on the page links to a project view", async () => {
    const links = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href")).filter((h) => /^\/project(\/|$)/.test(h ?? "")))
    check("nothing on the page links to a project view", links.length === 0, links.slice(0, 3).join(", "))
  })
  await step("no card or row carries a fullscreen door", async () => {
    const doors = await page.$$eval("[data-xq-card] [data-command='fullscreen'], [data-xq-card] a[href$='/full'], [data-sidebar-item] a[href$='/full']", (els) => els.length)
    check("no card or row carries a fullscreen door", doors === 0, `${doors} found`)
  })
  const everyProject = await page.$$eval("[data-xq-project-row]", (rows) => rows.map((r) => r.getAttribute("data-xq-project-row")))
  check("the list shows every project", everyProject.length === projects.length, `${everyProject.length} of ${projects.length}`)

  // ── the filter scopes the right column only ──────────────────────────────────────────────────────
  const shown = await cardProjects()
  const target = projects.find((p) => shown.includes(p.id)) ?? projects[0]
  await step("the READY header's pill filters the queue to one project", async () => {
    check("unfiltered, the pill reads All projects", (await page.$eval("[data-inbox-header] [data-xq-view-filter]", (b) => b.textContent?.trim())) === "All projects")
    await page.click("[data-inbox-header] [data-xq-view-filter]")
    await clickSettled(`[role="menuitem"][data-value="${target.slug}"]`)
    await page.waitForSelector("[data-xq-view-filter-pill]", { timeout: 5000 })
    await sleep(500)
    const only = await cardProjects()
    check("…only that project's cards remain", only.length === 1 && only[0] === target.id, only.join(", "))
    const rows = await page.$$eval("[data-xq-project-row]", (r) => r.length)
    check("…the list still shows every project", rows === projects.length, `${rows} rows`)
    const marked = await page.$$eval("[data-xq-project-filtered]", (els) => els.map((el) => el.closest("[data-xq-project-row]")?.getAttribute("data-xq-project-row")))
    check("…and marks the filtered one", marked.length === 1 && marked[0] === target.id, marked.join(", "))
    check("…and the address stays /", (await path()) === "/")
    await page.screenshot({ path: join(shots, "one-view-filtered.png") })
    await page.click("[data-xq-view-filter-clear]")
    await sleep(500)
    const back = await cardProjects()
    check("the pill's ✕ shows every project again", back.length === shown.length, `${back.length} projects' cards`)
  })
  await step("a project row's ⋯ menu filters the queue too", async () => {
    const other = projects.find((p) => p.id !== target.id && shown.includes(p.id)) ?? target
    const row = `[data-xq-project-row="${other.id}"]`
    await page.hover(row)
    await page.click(`${row} button[aria-label^="More actions for"]`)
    await clickSettled('[role="menuitem"]', { text: "Filter the queue to this project" })
    await sleep(600)
    const only = await cardProjects()
    check("the ⋯ menu's filter leaves only that project's cards", only.length === 1 && only[0] === other.id, only.join(", "))
    await page.click("[data-xq-view-filter-clear]")
    await sleep(400)
  })
  await step("the filter survives a reload of the tab", async () => {
    await page.click("[data-inbox-header] [data-xq-view-filter]")
    await clickSettled(`[role="menuitem"][data-value="${target.slug}"]`)
    await page.waitForSelector("[data-xq-view-filter-pill]")
    await page.reload({ waitUntil: "networkidle2" })
    await page.waitForSelector("[data-xq-view-filter-pill]", { timeout: 10_000 })
    const only = await cardProjects()
    check("the filter survives a reload of the tab", only.length === 1 && only[0] === target.id, only.join(", "))
    await page.click("[data-xq-view-filter-clear]")
    await sleep(400)
  })

  // ── a project's row folds it; its counts open the rest ─────────────────────────────────────────────
  const rowsOf = (id) => page.$$eval(`[data-xq-rail-project="${id}"] [data-sidebar-item]`, (rows) => rows.length)
  await step("a project's row folds away everything under it, and only in the list", async () => {
    const busy = await page.$$eval("[data-xq-rail-project]", (groups) => groups.find((g) => g.querySelector("[data-sidebar-item]"))?.getAttribute("data-xq-rail-project"))
    if (!busy) throw new Error("no project lists any rows to fold")
    const before = await rowsOf(busy)
    const cards = await page.$$eval("[data-xq-card]", (c) => c.length)
    const badge = async () => page.$eval(`[data-xq-project-row="${busy}"]`, (row) => row.textContent)
    const badgeBefore = await badge()
    await clickSettled(`[data-xq-project-row="${busy}"] [data-xq-project-fold]`)
    await sleep(300)
    const after = await rowsOf(busy)
    check("folding a project hides all its rows", before > 0 && after === 0, `${before} → ${after}`)
    check("…its row still carries its counts", (await badge()) === badgeBefore)
    check("…and the queue on the right is untouched", (await page.$$eval("[data-xq-card]", (c) => c.length)) === cards)
    await page.screenshot({ path: join(shots, "one-view-folded.png") })
    await page.reload({ waitUntil: "networkidle2" })
    await page.waitForSelector(`[data-xq-project-row="${busy}"]`)
    await sleep(600)
    check("the fold survives a reload", (await rowsOf(busy)) === 0)
    await clickSettled(`[data-xq-project-row="${busy}"] [data-xq-project-fold]`)
    await sleep(300)
    check("a second click brings every row back", (await rowsOf(busy)) === before, `${await rowsOf(busy)} of ${before}`)
  })
  await step("a project's counts open its quiet bands in place, and a Done row opens its drawer on the page", async () => {
    const withDone = await page.$$eval("[data-xq-project-row]", (rows) => rows.find((r) => r.querySelector('[data-xq-quiet-count="done"]'))?.getAttribute("data-xq-project-row"))
    if (!withDone) throw new Error("no project has a Done count to open")
    const counts = `[data-xq-project-row="${withDone}"] [data-xq-quiet-toggle]`
    const loud = await rowsOf(withDone)
    await clickSettled(counts)
    await page.waitForSelector(`[data-xq-drill="${withDone}"] [data-xq-drill-band="done"] [data-sidebar-item]`, { timeout: 8000 })
    check("the counts list a project's Done band under it", true)
    const inFlight = await page.$$eval(`[data-xq-rail-project="${withDone}"] [data-sidebar-item]`, (rows) => rows.filter((r) => !r.closest("[data-xq-drill]")).length)
    check("…below its rows in flight, which stay", inFlight === loud, `${inFlight} of ${loud}`)
    check("…and the address stays /", (await path()) === "/")
    await page.screenshot({ path: join(shots, "one-view-drill.png") })
    // The fold folds the rest too, and brings it back as it was.
    await clickSettled(`[data-xq-project-row="${withDone}"] [data-xq-project-fold]`)
    await sleep(300)
    check("folding the project folds its opened bands too", (await page.$(`[data-xq-drill="${withDone}"]`)) === null && (await rowsOf(withDone)) === 0)
    await clickSettled(`[data-xq-project-row="${withDone}"] [data-xq-project-fold]`)
    await page.waitForSelector(`[data-xq-drill="${withDone}"] [data-xq-drill-band="done"] [data-sidebar-item]`, { timeout: 8000 })
    check("…and unfolding it brings them back", true)
    await clickSettled(`[data-xq-drill="${withDone}"] [data-xq-drill-band="done"] [data-sidebar-item] button`)
    await waitPath(() => /^\/all\/[^/]+\/thread\/[^/]+$/.test(location.pathname), "a drawer address")
    await page.waitForSelector("[data-drawer-layer]", { timeout: 8000 })
    check("a Done row opens its thread's drawer on the page", true, await path())
    await escapeAll()
    await waitPath(() => location.pathname === "/", "the page again")
    await clickSettled(counts)
    await sleep(300)
    check("the counts put the bands away again", (await page.$(`[data-xq-drill="${withDone}"]`)) === null && (await rowsOf(withDone)) === loud)
  })

  // ── /full is the drawer's option ─────────────────────────────────────────────────────────────────
  await step("the drawer's menu is the way to /full, and leaving it comes back to the drawer", async () => {
    const card = await page.$eval("[data-xq-card]", (c) => c.getAttribute("data-xq-card"))
    const [cardProject, cardSlug] = card.split("/")
    await page.click("[data-xq-card] h3 a")
    await waitPath(() => /^\/all\/[^/]+\/thread\/[^/]+$/.test(location.pathname), "a drawer address")
    await page.waitForSelector("[data-drawer-layer] [data-thread-menu]", { timeout: 8000 })
    const drawer = await path()
    // The card steps aside for the drawer; the thread's row in the list stays, so the reader keeps their place.
    await sleep(400)
    const kept = await page.$(`[data-xq-rail-project="${cardProject}"] [data-sidebar-item="${cardSlug}"]`)
    check("the opened thread keeps its row in the list", kept !== null, card)
    await page.screenshot({ path: join(shots, "one-view-drawer.png") })
    await clickSettled("[data-drawer-layer] [data-thread-menu]")
    await clickSettled('[role="menuitem"][data-value="fullscreen"]')
    await waitPath(() => location.pathname.endsWith("/full"), "the /full page")
    check("the drawer's ⋯ → Open fullscreen goes to /full", (await path()) === `${drawer}/full`, await path())
    await page.waitForSelector("[data-standalone-return]", { timeout: 8000 })
    await sleep(600)
    await page.click("[data-standalone-return]")
    await waitPath(() => !location.pathname.endsWith("/full"), "leaving /full")
    check("leaving /full comes back to the drawer", (await path()) === drawer, await path())
    await page.waitForSelector("[data-drawer-layer]", { timeout: 8000 })
    await sleep(600)
    // `f` on the drawer being read takes the same way.
    await page.keyboard.press("f")
    await waitPath(() => location.pathname.endsWith("/full"), "/full by the f key")
    check("`f` on a drawer goes to /full", true)
    await page.goto(`${origin}/`, { waitUntil: "networkidle2" })
    await page.waitForSelector("[data-xq-card]")
  })

  // ── /login is an account action, not a message ───────────────────────────────────────────────────
  await step("/login typed into a card opens sign-in and sends nothing", async () => {
    await page.goto(`${origin}/`, { waitUntil: "networkidle2" })
    await clickSettled('[data-xq-card] [data-surface="queueComposer"]')
    await page.keyboard.type("/login")
    const before = posts.length
    await page.keyboard.press("Enter")
    await page.waitForSelector('[role="dialog"]', { timeout: 5000 })
    await sleep(500)
    const sent = posts.slice(before).filter((p) => p.endsWith("/rpc/followUp"))
    check("/login typed into a card opens sign-in and sends nothing", sent.length === 0, sent.join(", "))
    await page.keyboard.press("Escape")
    await sleep(300)
  })

  // ── a phone's width ──────────────────────────────────────────────────────────────────────────────
  await step("at 420px nothing overflows sideways", async () => {
    await page.setViewport({ width: 420, height: 900, deviceScaleFactor: 2 })
    await page.goto(`${origin}/`, { waitUntil: "networkidle2" })
    await page.waitForSelector("[data-xq-card]")
    await sleep(800)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    check("at 420px nothing overflows sideways", overflow <= 0, `${overflow}px`)
    await page.screenshot({ path: join(shots, "one-view-narrow.png") })
  })

  check("no page errors", errors.length === 0, errors.slice(0, 4).join(" | "))
} finally {
  await browser.close()
}
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
