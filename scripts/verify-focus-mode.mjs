#!/usr/bin/env node
// Drive FOCUS MODE — the page showing one project, its default view (web lib/pageView.ts) — on a real,
// seeded, multi-project stack, and check what it promised:
//   · the launcher's `/?project=<slug>` (and an older launcher's `?focus=<slug>`) shows that project alone:
//     its list, its cards, and a prompt box that dispatches into it with no picker;
//   · the view lives in the ADDRESS, per tab: two tabs on two projects stay there across reloads, a bare
//     `/` opens the tab's own view, a fresh tab the project last focused, a fresh browser All projects;
//   · the READY header's switcher changes the view by navigating, and Back undoes it; All projects is the
//     unified page, with the prompt box's picker carried over to the project just left;
//   · a thread drawer closes back to the tab's view, not to a guess;
//   · a retired `/project/<slug>` lands focused on it; an unknown `?project=` says so;
//   · the list names its loud bands, and opens Snoozed, Done and External one at a time;
//   · a rail square focuses its project;
//   · at a phone's width nothing overflows sideways, in either view.
//
// Usage:
//   nub scripts/adhoc-stack.mjs --port=47711 --project=/tmp/x/acme-api --also-project=/tmp/x/marketing-site \
//     --also-project=/tmp/x/billing-worker --also-project=/tmp/x/docs-portal > /tmp/stack.log 2>&1   # background
//   nub scripts/seed-all-queues.mjs --stack=/tmp/stack.log && nub scripts/seed-focus-mode.mjs --stack=/tmp/stack.log
//   nub scripts/verify-focus-mode.mjs --stack=/tmp/stack.log [--shots=/abs/dir] [--only=<words in a step name>]
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import puppeteer from "puppeteer"
import { createRpcClient } from "./lib/rpc-client.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => { const s = a.slice(2); const i = s.indexOf("="); return i < 0 ? [s, true] : [s.slice(0, i), s.slice(i + 1)] }),
)
if (!flags.stack) {
  console.error("usage: nub scripts/verify-focus-mode.mjs --stack=/abs/stack.log [--shots=/abs/dir]")
  process.exit(1)
}
const line = readFileSync(flags.stack, "utf8").split("\n").find((l) => l.startsWith("{\"url\""))
if (!line) throw new Error(`no stack json line in ${flags.stack}`)
const stack = JSON.parse(line)
const origin = new URL(stack.url).origin
const projects = [stack.launcher, ...stack.tenants].map((p) => ({ id: p.id, slug: p.slug }))
const bySlug = Object.fromEntries(projects.map((p) => [p.slug, p]))
const shots = flags.shots ?? join(process.cwd(), ".adhoc-shots")
mkdirSync(shots, { recursive: true })
const [A, B] = [bySlug["acme-api"] ?? projects[0], bySlug["marketing-site"] ?? projects[1]]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`)
}
let failures = 0
let current
async function step(name, run) {
  if (typeof flags.only === "string" && !name.includes(flags.only)) return
  try {
    await run()
  } catch (error) {
    const shot = join(shots, `focus-mode-fail-${++failures}.png`)
    const where = await current?.evaluate(() => location.pathname + location.search).catch(() => "?")
    await current?.screenshot({ path: shot }).catch(() => {})
    check(name, false, `${error instanceof Error ? error.message : String(error)} (at ${where}; ${shot})`)
  }
}

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--force-color-profile=srgb"] })
const errors = []
const boardReads = []
async function open(context, url, { width = 1440, height = 1000 } = {}) {
  const page = await context.newPage()
  current = page
  await page.setViewport({ width, height, deviceScaleFactor: 2 })
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }])
  page.on("pageerror", (error) => errors.push(`pageerror: ${error}`))
  page.on("console", (message) => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(`console: ${message.text()}`) })
  // A disposable stack runs no supervisor, so its control endpoint 404s on every page, and a project with no
  // icon answers its rail square's request with a 404 (the square falls back to its monogram); nothing else may.
  page.on("response", (response) => { if (response.status() >= 400 && !/\/_frizz\/control\/status$|\/_frizz\/project-icon\?/.test(response.url())) errors.push(`${response.status()} ${response.url()}`) })
  page.on("request", (request) => { const path = new URL(request.url()).pathname; if (path.endsWith("/rpc/board")) boardReads.push(path) })
  if (url) await page.goto(url, { waitUntil: "networkidle2" })
  return page
}
const address = (page) => page.evaluate(() => location.pathname + location.search)
const waitAddress = (page, want, ms = 10_000) =>
  page.waitForFunction((want) => location.pathname + location.search === want, { timeout: ms }, want).catch(async () => { throw new Error(`the address never became ${want}; it is ${await address(page)}`) })
const listed = (page) => page.$$eval("[data-xq-rail-project]", (groups) => groups.map((g) => g.getAttribute("data-xq-rail-project")))
const cardProjects = (page) => page.$$eval("[data-xq-card]", (cards) => [...new Set(cards.map((c) => c.getAttribute("data-xq-card")?.split("/")[0]))])
const switcherSays = (page) => page.$eval("[data-xq-switcher-label]", (el) => el.textContent?.trim() ?? "").catch(() => "")
// The view has painted: the switcher names it and the list holds exactly its projects.
const showing = async (page, project) => {
  await page.waitForFunction((name) => document.querySelector("[data-xq-switcher-label]")?.textContent?.trim() === name, { timeout: 10_000 }, project ? project.slug : "All projects")
  await page.waitForSelector("[data-xq-rail-project]")
  await sleep(500)
}
// Click only once the target is inside the viewport, unoccluded and holding still for two frames (a Radix
// menu mounts its items before positioning them; a drawer slides in).
const clickSettled = async (page, selector, { text } = {}) => {
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
  ).catch(async () => { throw new Error(`${selector}${text ? ` "${text}"` : ""} never settled on screen; at ${await address(page)}`) })
  await handle.asElement().click()
}
const choose = async (page, value) => {
  await clickSettled(page, "[data-xq-switcher]")
  await clickSettled(page, `[role="menuitem"][data-value="${value}"]`)
}

try {
  // ── the launcher's address ─────────────────────────────────────────────────────────────────────────
  const main = await browser.createBrowserContext()
  let page = await open(main, `${origin}/?project=${A.slug}`)
  await step("the launcher's /?project=<slug> shows that project alone", async () => {
    await showing(page, A)
    check("…the address keeps naming it", (await address(page)) === `/?project=${A.slug}`, await address(page))
    const groups = await listed(page)
    check("…the list is that project alone", groups.length === 1 && groups[0] === A.id, groups.join(", "))
    const cards = await cardProjects(page)
    check("…the queue is its cards alone", cards.length === 1 && cards[0] === A.id, cards.join(", "))
    check("…the prompt box has no project picker", (await page.$("[data-xq-project-picker]")) === null)
    check("…and no card wears a project chip", (await page.$("[data-xq-card] [data-xq-chip]")) === null)
    check("…and the list has no Add-a-project row", !(await page.$$eval("[data-xq-rail] button", (bs) => bs.some((b) => b.textContent?.trim() === "Add a project"))))
    await page.screenshot({ path: join(shots, "focus-mode-launch.png") })
  })
  await step("the page project is the focused one, so a new thread starts there", async () => {
    // The page project is whichever project the page's own client reads its board from — by slug; the
    // list reads other projects' boards by id (lib/projectBoards.ts).
    const boards = boardReads.filter((p) => !/\/_frizz\/[0-9a-f]{8}-/.test(p))
    check("the page is bound to the focused project", boards.at(-1) === `/_frizz/${A.slug}/rpc/board`, boards.join(", "))
  })

  // ── the list's bands ───────────────────────────────────────────────────────────────────────────────
  await step("the list names its loud bands, only where they have rows", async () => {
    const bands = await page.$$eval(`[data-xq-rail-project="${A.id}"] > [data-xq-band-label]`, (els) => els.map((el) => el.getAttribute("data-xq-band-label")))
    check("the focused project's bands are named in order", bands.join() === ["pinned", "ready", "working"].filter((b) => bands.includes(b)).join() && bands.includes("ready"), bands.join(", "))
    const empty = await page.$$eval(`[data-xq-rail-project] > [data-xq-band-label]`, (labels) => labels.filter((label) => !label.nextElementSibling?.matches("[data-xq-thread-row]")).map((l) => l.getAttribute("data-xq-band-label")))
    check("…and no name stands over an empty band", empty.length === 0, empty.join(", "))
  })
  await step("Snoozed, Done and External open one at a time, collapsed to start", async () => {
    const group = `[data-xq-rail-project="${A.id}"]`
    const opened = () => page.$$eval(`${group} [data-xq-drill-band]`, (els) => els.map((el) => el.getAttribute("data-xq-drill-band")))
    check("every quiet band starts collapsed", (await opened()).length === 0, (await opened()).join(", "))
    const toggles = await page.$$eval(`${group} [data-xq-quiet-footer] [data-xq-quiet-count]`, (els) => els.map((el) => el.getAttribute("data-xq-quiet-count")))
    if (!toggles.includes("done") || !toggles.includes("snoozed")) throw new Error(`the seed needs Snoozed and Done here; counts: ${toggles.join(", ")}`)
    await clickSettled(page, `${group} [data-xq-quiet-count="done"]`)
    await page.waitForSelector(`${group} [data-xq-drill-band="done"] [data-sidebar-item]`, { timeout: 8000 })
    check("Done opens alone", (await opened()).join() === "done", (await opened()).join(", "))
    await clickSettled(page, `${group} [data-xq-quiet-count="snoozed"]`)
    await page.waitForSelector(`${group} [data-xq-drill-band="snoozed"] [data-sidebar-item]`, { timeout: 8000 })
    check("Snoozed opens beside it, above it in the rail's order", (await opened()).join() === "snoozed,done", (await opened()).join(", "))
    const named = await page.$$eval(`${group} [data-xq-drill-band] > [data-xq-band-label]`, (els) => els.map((el) => el.getAttribute("data-xq-band-label")))
    check("…each open band is named", named.join() === "snoozed,done", named.join(", "))
    await page.screenshot({ path: join(shots, "focus-mode-quiet-open.png") })
    await clickSettled(page, `${group} [data-xq-drill-band="done"] > [data-xq-band-label]`)
    await sleep(300)
    check("a band's name closes it, and only it", (await opened()).join() === "snoozed", (await opened()).join(", "))
    await clickSettled(page, `${group} [data-xq-quiet-count="snoozed"]`)
    await sleep(300)
    check("its count closes it too", (await opened()).length === 0, (await opened()).join(", "))
  })

  // ── the cord strings the names ─────────────────────────────────────────────────────────────────────
  await step("the project's cord runs unbroken through its band names", async () => {
    // ThreadConnector's own rule (readRail): the square, each band name and each row are strung while they
    // TOUCH and each holds an icon. A name that broke the run, or held no glyph, would cut the cord there.
    const run = await page.$eval(`[data-xq-rail-project="${A.id}"]`, (group) => {
      const links = [...group.querySelectorAll(":scope > [data-xq-project-row], :scope > [data-xq-band-label], :scope > [data-xq-thread-row]")]
      let bottom = NaN
      let strung = 0
      for (const el of links) {
        const r = el.getBoundingClientRect()
        if (!el.querySelector("[data-xq-indicator]") || (strung > 0 && Math.abs(r.top - bottom) > 1)) break
        bottom = r.bottom
        strung++
      }
      return { strung, links: links.length, names: group.querySelectorAll(":scope > [data-xq-band-label]").length }
    })
    check("the cord strings the square, every band name and every row", run.names > 0 && run.strung === run.links, `${run.strung} of ${run.links} strung, ${run.names} names`)
    // And the connector drew it: its strands reach from the square to the last row.
    const span = await page.evaluate((id) => {
      const d = document.querySelector("[data-thread-cords] path")?.getAttribute("d") ?? ""
      const ys = [...d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => Number(m[2]))
      const group = document.querySelector(`[data-xq-rail-project="${id}"]`)
      const icons = [...group.querySelectorAll(":scope > * [data-xq-indicator]")].filter((slot) => !slot.closest("[data-xq-drill]")).map((slot) => slot.getBoundingClientRect())
      return { top: Math.min(...ys), bottom: Math.max(...ys), first: icons[0].top + icons[0].height / 2, last: icons.at(-1).top + icons.at(-1).height / 2 }
    }, A.id)
    check("…and the connector draws it from the square to the last row", Math.abs(span.top - span.first) < 2 && Math.abs(span.bottom - span.last) < 2, JSON.stringify(span))
  })

  // ── drawers go home to the tab's view ──────────────────────────────────────────────────────────────
  await step("a thread drawer closes back to the focused view", async () => {
    const row = `[data-xq-rail-project="${A.id}"] > [data-xq-band-label="working"] ~ [data-sidebar-item] button`
    if (!(await page.$(row))) throw new Error("no Working row to open (reseed, or respin the seeded workers)")
    await clickSettled(page, row)
    await page.waitForFunction(() => /^\/all\/[^/]+\/thread\/[^/]+$/.test(location.pathname), { timeout: 8000 })
    await page.waitForSelector("[data-drawer-layer]", { timeout: 8000 })
    check("a Working row opens its drawer on the page", true, await address(page))
    // At once, not once it has settled: a focused project's row opens its drawer STORE-first, and a close
    // that landed before the route had committed the drawer's address was re-opened by that address
    // (lib/router.ts `stale`) — 6 of 6 tries stuck on a loaded machine before the fix. Escape leaves a
    // focused composer first and closes the drawer on a later press, so three, 150ms apart.
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Escape")
      await sleep(150)
    }
    await waitAddress(page, `/?project=${A.slug}`)
    check("closing it comes back to /?project=<slug>", true)
    await sleep(3000)
    const reopened = await page.evaluate(() => ({ drawer: Boolean(document.querySelector("[data-drawer-layer]")), at: location.pathname + location.search }))
    check("…and it stays closed, though Escape came before the route had caught up", !reopened.drawer && reopened.at === `/?project=${A.slug}`, reopened.at)
  })

  // ── the switcher ───────────────────────────────────────────────────────────────────────────────────
  await step("the switcher focuses another project, and Back returns", async () => {
    await choose(page, B.slug)
    await waitAddress(page, `/?project=${B.slug}`)
    await showing(page, B)
    const groups = await listed(page)
    check("the switcher focuses the page on the project chosen", groups.length === 1 && groups[0] === B.id, groups.join(", "))
    const cards = await cardProjects(page)
    check("…with its cards alone", cards.every((c) => c === B.id), cards.join(", "))
    await page.goBack()
    await waitAddress(page, `/?project=${A.slug}`)
    await showing(page, A)
    check("Back returns to the project before", (await listed(page)).join() === A.id)
  })
  await step("All projects is the unified page, its picker carried over from the project left", async () => {
    await choose(page, "all-projects")
    await waitAddress(page, "/?all")
    await showing(page, null)
    const groups = await listed(page)
    check("All projects lists every project", projects.every((p) => groups.includes(p.id)), `${groups.length} groups for ${projects.length} projects`)
    const cards = await cardProjects(page)
    check("…and every project's cards", cards.length > 1, `${cards.length} projects' cards`)
    const picked = await page.$eval("[data-xq-picker-name]", (el) => el.textContent?.trim()).catch(() => null)
    check("…with the prompt box's picker, aimed where the operator just was", picked === A.slug, `picker "${picked}"`)
    check("…and each card wears its project's chip", (await page.$("[data-xq-card] [data-xq-chip]")) !== null)
    await page.screenshot({ path: join(shots, "focus-mode-all.png") })
  })
  await step("a card's chip focuses the page on its project", async () => {
    const chip = await page.$eval(`[data-xq-card] [data-xq-chip="${B.id}"]`, (el) => el.getAttribute("data-xq-chip")).catch(() => null)
    if (!chip) throw new Error(`no ${B.slug} card with a chip`)
    await clickSettled(page, `[data-xq-card] button[data-xq-chip="${B.id}"]`)
    await waitAddress(page, `/?project=${B.slug}`)
    await showing(page, B)
    check("a card's chip focuses the page on its project", (await listed(page)).join() === B.id)
  })
  await step("a project row's ⋯ menu offers every project back, and focus", async () => {
    await page.hover(`[data-xq-project-row="${B.id}"]`)
    await clickSettled(page, `[data-xq-project-row="${B.id}"] button[aria-label^="More actions for"]`)
    await clickSettled(page, '[role="menuitem"]', { text: "Show all projects" })
    await waitAddress(page, "/?all")
    await showing(page, null)
    await page.hover(`[data-xq-project-row="${A.id}"]`)
    await clickSettled(page, `[data-xq-project-row="${A.id}"] button[aria-label^="More actions for"]`)
    await clickSettled(page, '[role="menuitem"]', { text: "Focus on this project" })
    await waitAddress(page, `/?project=${A.slug}`)
    await showing(page, A)
    check("the ⋯ menu moves between All projects and one", true)
  })

  // ── per tab, across reloads ────────────────────────────────────────────────────────────────────────
  await step("two tabs on two projects stay there across reloads, and a bare / keeps the tab's own", async () => {
    const first = page
    const second = await open(main, `${origin}/?project=${B.slug}`)
    await showing(second, B)
    await first.bringToFront()
    await first.reload({ waitUntil: "networkidle2" })
    await showing(first, A)
    await second.reload({ waitUntil: "networkidle2" })
    await showing(second, B)
    check("each tab keeps its project across a reload", (await address(first)) === `/?project=${A.slug}` && (await address(second)) === `/?project=${B.slug}`, `${await address(first)} | ${await address(second)}`)
    // The second tab focused B last, so B is this browser's last-focused project — and yet the first tab's
    // bare `/` is still its own.
    await first.goto(`${origin}/`, { waitUntil: "networkidle2" })
    await waitAddress(first, `/?project=${A.slug}`)
    await showing(first, A)
    check("a bare / in a tab opens that tab's own view", true)
    await second.goto(`${origin}/`, { waitUntil: "networkidle2" })
    await waitAddress(second, `/?project=${B.slug}`)
    check("…in the other tab too", true)
    await second.close()
    current = first
  })
  await step("a fresh tab opens the project last focused; a fresh browser, All projects", async () => {
    // The last focus in this browser was the second tab's bare `/` → B.
    const fresh = await open(main, `${origin}/`)
    await waitAddress(fresh, `/?project=${B.slug}`)
    check("a fresh tab at / opens the project last focused in this browser", true)
    await fresh.close()
    const empty = await browser.createBrowserContext()
    const blank = await open(empty, `${origin}/`)
    await waitAddress(blank, "/?all")
    await showing(blank, null)
    check("a browser that never focused a project opens All projects", true)
    await empty.close()
    current = page
  })
  await step("an older launcher's ?focus=<slug> focuses that project", async () => {
    await page.goto(`${origin}/?focus=${B.slug}`, { waitUntil: "networkidle2" })
    await waitAddress(page, `/?project=${B.slug}`)
    await showing(page, B)
    check("?focus= reads as ?project=, and the address is rewritten", true)
  })
  await step("a retired /project/<slug> lands focused on it", async () => {
    await page.goto(`${origin}/project/${A.slug}`, { waitUntil: "networkidle2" })
    await waitAddress(page, `/?project=${A.slug}`)
    await showing(page, A)
    check("/project/<slug> lands on /?project=<slug>", true)
  })
  await step("an unknown ?project= says so and shows something real", async () => {
    await page.goto(`${origin}/?project=no-such-project`, { waitUntil: "networkidle2" })
    const toast = await page.waitForFunction(() => [...document.querySelectorAll("[data-sonner-toast], [role='status'], [data-toast]")].map((t) => t.textContent).find((t) => t?.includes("No project named no-such-project")) ?? null, { timeout: 6000 }).then(() => true, () => false)
    const now = await address(page)
    check("an unknown ?project= is reported and replaced", toast && now !== "/?project=no-such-project", now)
  })

  // ── the rail ───────────────────────────────────────────────────────────────────────────────────────
  await step("a rail square focuses the page on its project", async () => {
    const api = createRpcClient(`${origin}/`)
    const settings = await api.query("settingsGet")
    await api.mutate("settingsSet", { ...settings, projectRail: true })
    try {
      await page.goto(`${origin}/?project=${A.slug}`, { waitUntil: "networkidle2" })
      await page.waitForSelector('nav[aria-label="Projects"] a[aria-current="page"]', { timeout: 10_000 })
      const pill = await page.$eval('nav[aria-label="Projects"] a[aria-current="page"]', (a) => a.getAttribute("href"))
      check("the focused project's square wears the pill", pill === `/?project=${A.slug}`, pill)
      await page.bringToFront()
      const square = `nav[aria-label="Projects"] a[href="/?project=${B.slug}"]`
      await page.waitForSelector(square, { visible: true })
      await sleep(400)
      await page.click(square)
      await waitAddress(page, `/?project=${B.slug}`)
      await showing(page, B)
      check("a square focuses the page on its project", (await listed(page)).join() === B.id)
      await page.screenshot({ path: join(shots, "focus-mode-rail.png") })
    } finally {
      await api.mutate("settingsSet", { ...settings, projectRail: false })
    }
  })

  // ── a phone's width ────────────────────────────────────────────────────────────────────────────────
  for (const [view, url] of [["focused", `/?project=${A.slug}`], ["All projects", "/?all"]]) {
    await step(`at 420px nothing overflows sideways (${view})`, async () => {
      await page.setViewport({ width: 420, height: 900, deviceScaleFactor: 2 })
      await page.goto(`${origin}${url}`, { waitUntil: "networkidle2" })
      await page.waitForSelector("[data-xq-rail-project]")
      await sleep(800)
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      check(`at 420px nothing overflows sideways (${view})`, overflow <= 0, `${overflow}px`)
      await page.screenshot({ path: join(shots, `focus-mode-narrow-${view === "focused" ? "focus" : "all"}.png`), fullPage: true })
    })
  }

  check("no page errors", errors.length === 0, errors.slice(0, 4).join(" | "))
} finally {
  await browser.close()
}
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
