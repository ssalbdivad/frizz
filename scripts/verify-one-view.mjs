#!/usr/bin/env node
// Drive ALL PROJECTS — the one page's every-project view, `/?all` (web lib/pageView.ts) — on a real,
// seeded, multi-project stack, and check what the one page promised the maintainer. It was the page's
// only view, at `/`, from 2026-09-28 until focus mode (2026-09-29) made one project the default, which
// scripts/verify-focus-mode.mjs drives; this drives the view that shows them all:
//   · no `/project/<slug>` page exists: every such address lands on the one page, and nothing on the page
//     links to one;
//   · the READY header's switcher leaves All projects for one project and comes back, by address, and a
//     project row's ⋯ menu focuses on its project too;
//   · a project's other bands (Snoozed, Done, External) open in place under its row, each by its own
//     count and one at a time, and a row there opens its thread's drawer on the page;
//   · /full is a card's ⤢ (addressed with the card's own project) and an option of the drawer's menu,
//     never a door on a list row; `f` in a drawer takes
//     it, and leaving /full comes back to the drawer;
//   · a `/login` typed into a card's reply box opens sign-in instead of reaching the worker;
//   · at a phone's width nothing overflows sideways.
//
// Usage:
//   nub scripts/adhoc-stack.mjs --port=47631 --project=/tmp/x/acme-api --also-project=/tmp/x/marketing-site \
//     --also-project=/tmp/x/billing-worker --also-project=/tmp/x/docs-portal > /tmp/stack.log 2>&1   # background
//   nub scripts/seed-all-queues.mjs --stack=/tmp/stack.log   # and optionally seed-focus-mode.mjs (last run had both)
//   nub scripts/verify-one-view.mjs --stack=/tmp/stack.log [--shots=/abs/dir] [--only=<words in a step name>]
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
  // `--only=<words>` runs just the steps whose name carries them — the rest of a 4-minute pass is not
  // needed to re-run one check.
  if (typeof flags.only === "string" && !name.includes(flags.only)) return
  try {
    await run()
  } catch (error) {
    // What the page looked like when the step gave up — the only way to tell a real regression from a
    // selector that stopped matching.
    const shot = join(shots, `one-view-fail-${++failures}.png`)
    const where = await page?.evaluate(() => location.pathname + location.search).catch(() => "?")
    await page?.screenshot({ path: shot }).catch(() => {})
    check(name, false, `${error instanceof Error ? error.message : String(error)} (at ${where}; ${shot})`)
    // And the page's last few address changes, which say whether a click went nowhere or went and came back.
    console.log(addresses.slice(-6).map((entry) => `      ${entry}`).join("\n"))
  }
}
let page
const addresses = []

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--force-color-profile=srgb"] })
try {
  page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 })
  // Generous, because this machine is shared: at a load average of 30+ a cold page load alone has taken
  // 20s, and every wait below is for a condition, so a slow pass costs time and never a verdict.
  page.setDefaultNavigationTimeout(90_000)
  page.setDefaultTimeout(30_000)
  const errors = []
  page.on("console", (message) => { if (message.text().startsWith("[address]")) addresses.push(message.text().slice(10)) })
  await page.evaluateOnNewDocument(() => {
    const t0 = performance.now()
    const log = (how) => console.log(`[address] ${Math.round(performance.now() - t0)}ms ${how} ${location.pathname}${location.search}`)
    for (const method of ["pushState", "replaceState"]) {
      const original = history[method].bind(history)
      history[method] = (...args) => { const result = original(...args); log(method); return result }
    }
    addEventListener("popstate", () => log("popstate"))
    // A click, and whether the page handled it — a handled click that moved nothing is a different bug from a lost one.
    addEventListener("click", (event) => log(`click ${event.target instanceof Element ? (event.target.closest("a[href]")?.getAttribute("href") ?? event.target.tagName) : "?"} handled=${event.defaultPrevented} from`))
  })
  page.on("pageerror", (error) => errors.push(`pageerror: ${error}`))
  page.on("console", (message) => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(`console: ${message.text()}`) })
  // A disposable stack runs no supervisor, so its control endpoint 404s on every page, and a project with
  // no icon answers its rail square's request with a 404 (the square falls back to its monogram); nothing
  // else may.
  page.on("response", (response) => { if (response.status() >= 400 && !/\/_frizz\/control\/status$|\/_frizz\/project-icon\?/.test(response.url())) errors.push(`${response.status()} ${response.url()}`) })
  const posts = []
  page.on("request", (request) => { if (request.method() === "POST" && request.url().includes("/rpc/")) posts.push(new URL(request.url()).pathname) })

  const path = () => page.evaluate(() => location.pathname)
  const search = () => page.evaluate(() => location.search)
  // Every visit names its view: a bare `/` opens this tab's own, which is whatever the step before left.
  const ALL = `${origin}/?all`
  const waitPath = (predicate, what, ms = 10_000, ...args) => page.waitForFunction(predicate, { timeout: ms }, ...args).catch(async () => { throw new Error(`timed out waiting for ${what}; at ${await path()}`) })
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
  // And only once nothing sits OVER it: the lanes' sticky headers float above a card scrolled under them,
  // and a click there lands on the header. An occluded target is scrolled to the middle of the window
  // and asked again.
  const clickSettled = async (selector, { text } = {}) => {
    const handle = await page.waitForFunction(
      (selector, text) => new Promise((resolve) => {
        const el = [...document.querySelectorAll(selector)].find((candidate) => text === undefined || candidate.textContent?.trim() === text)
        const at = el?.getBoundingClientRect()
        if (!el || !at || at.width === 0) return resolve(null)
        const hit = document.elementFromPoint(at.x + at.width / 2, at.y + at.height / 2)
        if (at.top < 0 || at.bottom > innerHeight || at.left < 0 || at.right > innerWidth || !hit || !(el === hit || el.contains(hit))) {
          el.scrollIntoView({ block: "center", inline: "nearest" })
          return resolve(null)
        }
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

  // ── no project page ──────────────────────────────────────────────────────────────────────────────
  // A retired project address lands on the page focused on its project (a thread's, on that thread's
  // drawer); any other retired address on the page in this tab's view.
  const [first, second] = [projects[0].slug, projects[1].slug]
  for (const [address, lands] of [
    [`/project/${first}`, (slug) => location.pathname === "/" && new URLSearchParams(location.search).get("project") === slug, first],
    // A thread the project does not have: its drawer address, which hands a missing thread to the /full
    // page's own recovery (store.ts resolveRoutedThread) — so either is the landing.
    [`/project/${second}/thread/whatever`, (slug) => location.pathname.startsWith(`/all/${slug}/thread/whatever`), second],
    ["/status/active", () => location.pathname === "/"],
    ["/projects", () => location.pathname === "/"],
  ]) {
    await step(`${address} lands on the page`, async () => {
      await page.goto(`${origin}${address}`, { waitUntil: "networkidle2" })
      await waitPath(lands, "the page", 10_000, address.startsWith("/project/") ? address.split("/")[2] : undefined)
      check(`${address} lands on the page`, true, `${await path()}${await search()}`)
    })
  }
  await page.goto(ALL, { waitUntil: "networkidle2" })
  await page.waitForSelector("[data-xq-card]")
  await sleep(1200)
  await page.screenshot({ path: join(shots, "one-view-home.png") })
  await step("nothing on the page links to a project view", async () => {
    const links = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href")).filter((h) => /^\/project(\/|$)/.test(h ?? "")))
    check("nothing on the page links to a project view", links.length === 0, links.slice(0, 3).join(", "))
  })
  // A card's ⤢ is its door to /full again (1e36e154, 2026-09-29: Colin's card had one), addressed with
  // the CARD's project, never the page's; a row in the list has none.
  await step("a card's fullscreen door names the card's own project, and no list row carries one", async () => {
    const slugOf = Object.fromEntries(projects.map((p) => [p.id, p.slug]))
    const doors = await page.$$eval("[data-xq-card] [data-command='fullscreen']", (els) => els.map((el) => ({ key: el.closest("[data-xq-card]").getAttribute("data-xq-card"), href: el.getAttribute("href") })))
    const wrong = doors.filter(({ key, href }) => { const [id, slug] = key.split("/"); return href !== `/all/${slugOf[id]}/thread/${slug}/full` })
    const rowDoors = await page.$$eval("[data-sidebar-item] a[href$='/full']", (els) => els.length)
    check("a card's fullscreen door names the card's own project, and no list row carries one", doors.length > 0 && wrong.length === 0 && rowDoors === 0, `${doors.length} card doors, ${wrong.length} mis-addressed${wrong[0] ? ` (${wrong[0].key} → ${wrong[0].href})` : ""}, ${rowDoors} on rows`)
  })
  // Every project the stack opened has a row — and so does the Home workspace, which every server lists
  // and the stack's own line does not name.
  const everyProject = await page.$$eval("[data-xq-project-row]", (rows) => rows.map((r) => r.getAttribute("data-xq-project-row")))
  check("the list shows every project", projects.every((p) => everyProject.includes(p.id)), `${everyProject.length} rows for ${projects.length} projects`)

  // ── leaving All projects for one project, and back ─────────────────────────────────────────────────
  const shown = await cardProjects()
  const target = projects.find((p) => shown.includes(p.id)) ?? projects[0]
  const listed = () => page.$$eval("[data-xq-project-row]", (rows) => rows.map((r) => r.getAttribute("data-xq-project-row")))
  const focusedOn = (slug) => waitPath((slug) => location.pathname === "/" && new URLSearchParams(location.search).get("project") === slug, `/?project=${slug}`, 10_000, slug)
  // The page follows its address as a transition, which on a loaded machine lands seconds after the
  // address does: wait for the cards to say it, rather than for a fixed time.
  const cardsFrom = (ids) => page.waitForFunction((ids) => {
    const got = new Set([...document.querySelectorAll("[data-xq-card]")].map((c) => c.getAttribute("data-xq-card")?.split("/")[0]))
    return got.size === ids.length && ids.every((id) => got.has(id))
  }, { timeout: 30_000 }, ids).catch(() => {})
  await step("the READY header's switcher focuses the page on one project, and brings All projects back", async () => {
    const reads = await page.$eval("[data-status-row] [data-xq-switcher]", (b) => `${b.getAttribute("data-xq-switcher")} ${b.querySelector("[data-xq-switcher-label]")?.textContent?.trim()}`)
    check("in All projects, the switcher reads All projects", reads === "all All projects", reads)
    await page.click("[data-status-row] [data-xq-switcher]")
    await clickSettled(`[role="menuitem"][data-value="${target.slug}"]`)
    await focusedOn(target.slug)
    await cardsFrom([target.id])
    const only = await cardProjects()
    check("…focused, only that project's cards remain", only.length === 1 && only[0] === target.id, only.join(", "))
    const rows = await listed()
    check("…and the list shows only that project", rows.length === 1 && rows[0] === target.id, rows.join(", "))
    await page.screenshot({ path: join(shots, "one-view-focused.png") })
    await page.click("[data-status-row] [data-xq-switcher]")
    await clickSettled('[role="menuitem"][data-value="all-projects"]')
    await waitPath(() => location.search === "?all", "/?all")
    await cardsFrom(shown)
    const back = await cardProjects()
    check("the switcher's All projects shows every project again", back.length === shown.length && (await listed()).length === everyProject.length, `${back.length} projects' cards`)
  })
  await step("a project row's ⋯ menu focuses the page on it", async () => {
    const other = projects.find((p) => p.id !== target.id && shown.includes(p.id)) ?? target
    const row = `[data-xq-project-row="${other.id}"]`
    await page.hover(row)
    await page.click(`${row} button[aria-label^="More actions for"]`)
    await clickSettled('[role="menuitem"]', { text: "Focus on this project" })
    await focusedOn(other.slug)
    await cardsFrom([other.id])
    const only = await cardProjects()
    check("the ⋯ menu's Focus on this project leaves only that project's cards", only.length === 1 && only[0] === other.id, only.join(", "))
    await page.goto(ALL, { waitUntil: "networkidle2" })
    await page.waitForSelector("[data-xq-card]")
    await sleep(400)
  })

  // ── a project's row folds it; its counts open the rest ─────────────────────────────────────────────
  const rowsOf = (id) => page.$$eval(`[data-xq-rail-project="${id}"] [data-sidebar-item]`, (rows) => rows.length)
  await step("a project's row folds away everything under it, and only in the list", async () => {
    const busy = await page.$$eval("[data-xq-rail-project]", (groups) => groups.find((g) => g.querySelector("[data-sidebar-item]"))?.getAttribute("data-xq-rail-project"))
    if (!busy) throw new Error("no project lists any rows to fold")
    const before = await rowsOf(busy)
    const cards = await page.$$eval("[data-xq-card]", (c) => c.length)
    // Its quiet counts stay on its row whether it is folded or not — opening the rest never moves them.
    const counts = async (scope) => page.$eval(`[data-xq-rail-project="${busy}"]`, (g, scope) => [...g.querySelectorAll(`${scope} [data-xq-quiet-count]:not([data-xq-quiet-count="working"])`)].map((c) => c.textContent).join(" "), scope)
    const countsBefore = await counts("[data-xq-project-row]")
    const badge = async () => page.$eval(`[data-xq-project-row="${busy}"]`, (row) => {
      const bare = row.cloneNode(true)
      bare.querySelector("[data-xq-quiet-toggles]")?.remove()
      return bare.textContent
    })
    const badgeBefore = await badge()
    // Its Working rows (a pinned row is neither Ready nor Working).
    const workingBefore = await page.$$eval(`[data-xq-rail-project="${busy}"] > [data-xq-band="working"]`, (rows) => rows.length)
    await clickSettled(`[data-xq-project-row="${busy}"] [data-xq-project-fold]`)
    await sleep(300)
    const after = await rowsOf(busy)
    check("folding a project hides all its rows", before > 0 && after === 0, `${before} → ${after}`)
    check("…its row still carries its Ready count", (await badge()) === badgeBefore, badgeBefore)
    const workingAfter = await page.$eval(`[data-xq-project-row="${busy}"]`, (row) => Number(row.querySelector('[data-xq-quiet-count="working"]')?.textContent ?? 0))
    check("…and counts the Working rows it folded away", workingAfter === workingBefore, `${workingAfter} of ${workingBefore}`)
    check("…and its quiet counts stay on its row", (await counts("[data-xq-project-row]")) === countsBefore, countsBefore || "(none)")
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
  await step("a project's counts open its quiet bands in place, one at a time, and a Done row opens its drawer on the page", async () => {
    const withDone = await page.$$eval("[data-xq-project-row]", (rows) => rows.find((r) => r.closest("[data-xq-rail-project]").querySelector('[data-xq-quiet-count="done"]'))?.getAttribute("data-xq-project-row"))
    if (!withDone) throw new Error("no project has a Done count to open")
    const count = (band) => `[data-xq-rail-project="${withDone}"] [data-xq-quiet-count="${band}"]`
    const bandsOpen = () => page.$$eval(`[data-xq-drill="${withDone}"] [data-xq-drill-band]`, (bands) => bands.map((b) => b.getAttribute("data-xq-drill-band")).join(" "))
    const loud = await rowsOf(withDone)
    await clickSettled(count("done"))
    await page.waitForSelector(`[data-xq-drill="${withDone}"] [data-xq-drill-band="done"] [data-sidebar-item]`, { timeout: 8000 })
    check("the Done count lists a project's Done band under it, and only that band", (await bandsOpen()) === "done", await bandsOpen())
    const inFlight = await page.$$eval(`[data-xq-rail-project="${withDone}"] [data-sidebar-item]`, (rows) => rows.filter((r) => !r.closest("[data-xq-drill]")).length)
    check("…below its rows in flight, which stay", inFlight === loud, `${inFlight} of ${loud}`)
    check("…and the address stays on All projects", (await path()) === "/" && (await search()) === "?all", `${await path()}${await search()}`)
    // A second band opens beside it, and its own name puts only it away.
    if (await page.$(count("snoozed"))) {
      await clickSettled(count("snoozed"))
      await page.waitForSelector(`[data-xq-drill="${withDone}"] [data-xq-drill-band="snoozed"]`, { timeout: 8000 })
      check("…the Snoozed count opens Snoozed beside it", (await bandsOpen()) === "snoozed done", await bandsOpen())
      await clickSettled(`[data-xq-drill="${withDone}"] [data-xq-drill-band="snoozed"] [data-xq-band-label]`)
      await sleep(300)
      check("…and Snoozed's name closes Snoozed alone", (await bandsOpen()) === "done", await bandsOpen())
    }
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
    await page.waitForSelector("[data-drawer-layer]")
    check("a Done row opens its thread's drawer on the page", true, await path())
    await escapeAll()
    await waitPath(() => location.pathname === "/", "the page again")
    check("…which closes back to All projects", (await search()) === "?all", await search())
    await clickSettled(count("done"))
    await sleep(300)
    check("the Done count puts its band away again", (await page.$(`[data-xq-drill="${withDone}"]`)) === null && (await rowsOf(withDone)) === loud)
  })

  // ── /full is the drawer's option ─────────────────────────────────────────────────────────────────
  await step("the drawer's menu is the way to /full, and leaving it comes back to the drawer", async () => {
    const card = await page.$eval("[data-xq-card]", (c) => c.getAttribute("data-xq-card"))
    const [cardProject, cardSlug] = card.split("/")
    await clickSettled(`[data-xq-card="${card}"] h3 a`)
    await waitPath(() => /^\/all\/[^/]+\/thread\/[^/]+$/.test(location.pathname), "a drawer address")
    await page.waitForSelector("[data-drawer-layer] [data-thread-menu]", { timeout: 15000 })
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
    // Each door waits out the one before it. A door taken while the last morph still runs skips it, and
    // the way back names the drawer `thread-chat` for 600ms (store.ts primeFullscreenReturn), so `f` inside
    // that window collides with the forward door's own name and the browser aborts the transition. The
    // navigation lands either way; the page errors say "Transition was skipped" and "duplicate
    // view-transition-name". Waiting 600ms here, exactly the name's lifetime, raised both on a loaded
    // machine — on the build before focus mode as well (2 of 4 runs each, load 30+, 2026-09-29).
    await page.waitForSelector("[data-standalone-return]", { timeout: 8000 })
    await sleep(1500)
    await page.click("[data-standalone-return]")
    await waitPath(() => !location.pathname.endsWith("/full"), "leaving /full")
    check("leaving /full comes back to the drawer", (await path()) === drawer, await path())
    await page.waitForSelector("[data-drawer-layer]", { timeout: 8000 })
    await sleep(1500)
    // `f` on the drawer being read takes the same way.
    await page.keyboard.press("f")
    await waitPath(() => location.pathname.endsWith("/full"), "/full by the f key")
    check("`f` on a drawer goes to /full", true)
    await page.goto(ALL, { waitUntil: "networkidle2" })
    await page.waitForSelector("[data-xq-card]")
  })

  // ── a click while the page is still leaving a drawer ─────────────────────────────────────────────
  // react-router renders a location change as a transition, so for a while after a drawer closes the page
  // on screen is still the drawer's page, and clickable. A card of the drawer's own project clicked in that
  // window once opened store-first on that stale page, and the rebind back to the pick swept the drawer
  // away: the click did nothing (caught here at 1.8s under load, 2026-09-28). The CPU is throttled 4x
  // across the close so the window is wide on any machine rather than only on a loaded one.
  await step("a card clicked while the page is still leaving a drawer opens its thread", async () => {
    await page.goto(ALL, { waitUntil: "networkidle2" })
    await page.waitForSelector("[data-xq-card]")
    await sleep(800)
    // A project with a card and a Done thread, and the page's own project set to ANOTHER one (the prompt
    // box's pick, which All projects binds the page to): the Done row then opens that project's drawer
    // address-first (a Ready row would only bring its card into view), and the card is clicked on the way
    // out.
    const target = await page.evaluate(() => {
      for (const title of document.querySelectorAll("[data-xq-card] h3 a")) {
        const href = title.getAttribute("href")
        const [, , , , thread] = href.split("/")
        if (thread.startsWith("term-")) continue
        const id = title.closest("[data-xq-card]").getAttribute("data-xq-card").split("/")[0]
        if (document.querySelector(`[data-xq-rail-project="${id}"] [data-xq-quiet-count="done"]`)) return { card: href, id }
      }
      return null
    })
    if (!target) throw new Error("no project has both a card and a Done thread")
    const elsewhere = projects.find((p) => p.id !== target.id)
    await page.evaluate((id) => localStorage.setItem("frizz.crossProjectFocus", id), elsewhere.id)
    await page.reload({ waitUntil: "networkidle2" })
    await page.waitForSelector(`[data-xq-card] h3 a[href="${target.card}"]`)
    await sleep(800)
    const counts = `[data-xq-rail-project="${target.id}"] [data-xq-quiet-count="done"]`
    await clickSettled(counts)
    const doneRow = `[data-xq-drill="${target.id}"] [data-xq-drill-band="done"] [data-sidebar-item] button`
    await page.waitForSelector(doneRow, { timeout: 8000 })
    await page.$eval(`[data-xq-card] h3 a[href="${target.card}"]`, (a) => a.scrollIntoView({ block: "center" }))
    await sleep(600)
    await clickSettled(doneRow)
    await waitPath(() => /^\/all\/[^/]+\/thread\/[^/]+$/.test(location.pathname), "the Done row's drawer")
    await page.waitForSelector("[data-drawer-layer] [data-thread-menu]", { timeout: 15000 })
    await sleep(800)
    const second = target.card
    const cdp = await page.createCDPSession()
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 })
    try {
      await page.keyboard.press("Escape")
      // The moment the address says `/` and the card can be hit — not a frame later, which is the point.
      const at = await page.waitForFunction((href) => {
        if (location.pathname !== "/") return null
        const title = document.querySelector(`[data-xq-card] h3 a[href="${href}"]`)
        const box = title?.getBoundingClientRect()
        if (!box || box.width === 0 || box.top < 0 || box.bottom > innerHeight) return null
        const x = box.x + Math.min(box.width / 2, 40)
        const y = box.y + box.height / 2
        const hit = document.elementFromPoint(x, y)
        return hit && title.contains(hit) ? { x, y } : null
      }, { timeout: 30_000, polling: 16 }, second).then((handle) => handle.jsonValue())
      await page.mouse.click(at.x, at.y)
    } finally {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 })
    }
    await waitPath((href) => location.pathname === href, `the second card's drawer (${second})`, 20_000, second)
    await page.waitForSelector("[data-drawer-layer] [data-thread-menu]", { timeout: 15000 })
    check("a card clicked while the page is still leaving a drawer opens its thread", true, second)
    await escapeAll()
    await waitPath(() => location.pathname === "/", "the page again")
    await clickSettled(counts)
  })

  // ── a reply moves its row to Working at once ─────────────────────────────────────────────────────
  // The seeded workers are stand-ins that cannot take a message, so the follow-up is answered here, 1.5s
  // late, as a loaded server would: the row must not wait for it (lib/steering.ts markSteeredIn).
  await step("a reply sent from a card moves its row to Working before the server answers", async () => {
    await page.goto(ALL, { waitUntil: "networkidle2" })
    await page.waitForSelector('[data-xq-card] [data-surface="queueComposer"]')
    await sleep(800)
    const card = await page.$$eval('[data-xq-card]', (cards) => cards.map((c) => c.getAttribute("data-xq-card")).find((key) => !key.split("/")[1].startsWith("term-") && document.querySelector(`[data-xq-card="${key}"] [data-surface="queueComposer"]`)))
    if (!card) throw new Error("no session card with a reply box")
    const [projectId, slug] = card.split("/")
    const row = `[data-xq-rail-project="${projectId}"] [data-sidebar-item="${slug}"]`
    const carded = () => page.$$eval(`[data-xq-rail-project="${projectId}"] [data-sidebar-item][data-xq-rail-row]`, (rows) => rows.length)
    const before = await carded()
    check("…the row starts out Ready", (await page.$eval(row, (r) => r.hasAttribute("data-xq-rail-row"))) === true)
    await page.setRequestInterception(true)
    const held = (request) => {
      if (request.isInterceptResolutionHandled()) return
      if (request.method() === "POST" && request.url().endsWith("/rpc/followUp")) {
        setTimeout(() => request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ result: null }) }).catch(() => {}), 1500)
      } else request.continue().catch(() => {})
    }
    page.on("request", held)
    try {
      await clickSettled(`[data-xq-card="${card}"] [data-surface="queueComposer"]`)
      await page.keyboard.type("Looks right, carry on")
      const sent = Date.now()
      await page.keyboard.press("Enter")
      await page.waitForFunction((row) => document.querySelector(`${row} [data-rail-glyph="working"]`) !== null, { timeout: 1000, polling: 16 }, row)
      const took = Date.now() - sent
      check("the row wears Working before the server has answered", took < 1500, `${took}ms`)
      check("…it has left Ready, and the project's Ready rows are one fewer", (await page.$eval(row, (r) => !r.hasAttribute("data-xq-rail-row"))) && (await carded()) === before - 1, `${await carded()} of ${before}`)
      await page.screenshot({ path: join(shots, "one-view-steered-row.png") })
      await sleep(1800)
    } finally {
      page.off("request", held)
      await page.setRequestInterception(false)
    }
  })

  // ── /login is an account action, not a message ───────────────────────────────────────────────────
  await step("/login typed into a card opens sign-in and sends nothing", async () => {
    await page.goto(ALL, { waitUntil: "networkidle2" })
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
    await page.goto(ALL, { waitUntil: "networkidle2" })
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
