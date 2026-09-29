#!/usr/bin/env node
// Verify the snooze toast end to end in a real browser: it names WHERE the snoozed thread went, its Undo
// really un-snoozes the thread on the server and brings the card straight back, an Undo over a thread
// that was ALREADY snoozed restores the old deadline instead of waking it, and a toast that has faded
// can no longer be clicked or tabbed to.
//
// Written 2026-09-28 for the operator's "I accidentally snoozed a thread, I don't know where it went".
// Three paths, because the card comes back by three different routes:
//   • a TENANT's card in All projects — its queue arrives by the 3s poll, so the Undo must refetch rather
//     than wait for the next tick (checked after the poll has already dropped the thread);
//   • the PAGE project's card (All projects' pick, set to the launcher here) — its queue is the live
//     board, and the fade guard must lift at once;
//   • the thread DRAWER's footer — no card at all, and the thread there may already be snoozed.
//
// Usage: node scripts/verify-snooze-undo.mjs --stack=/abs/stack.log [--shots=/abs/dir]
//   against a stack booted by adhoc-stack.mjs with --also-project for marketing-site and billing-worker,
//   and seeded by scripts/seed-all-queues.mjs. It MUTATES that state (it leaves every thread awake, but
//   run it on a fresh stack). Exits non-zero when any check fails.
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import puppeteer from "puppeteer"
import { createRpcClient } from "./lib/rpc-client.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => { const s = a.slice(2); const i = s.indexOf("="); return i < 0 ? [s, true] : [s.slice(0, i), s.slice(i + 1)] }),
)
if (!flags.stack) {
  console.error("usage: node scripts/verify-snooze-undo.mjs --stack=/abs/stack.log [--shots=/abs/dir]")
  process.exit(1)
}
const line = readFileSync(flags.stack, "utf8").split("\n").find((l) => l.startsWith("{\"url\""))
if (!line) throw new Error(`no stack json line in ${flags.stack}`)
const stack = JSON.parse(line)
const origin = new URL(stack.url).origin
const ids = Object.fromEntries([[stack.launcher.slug, stack.launcher.id], ...stack.tenants.map((t) => [t.slug, t.id])])
const shots = flags.shots ?? join(process.cwd(), ".adhoc-shots")
mkdirSync(shots, { recursive: true })

const clients = new Map()
const api = (project) => {
  if (!clients.has(project)) clients.set(project, createRpcClient(`${origin}/`, ids[project]))
  return clients.get(project)
}
const threadOf = async (project, slug) => (await api(project).query("board")).threads.find((t) => t.id === slug)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(what, predicate, ms = 10_000, every = 100) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await sleep(every)
  }
  throw new Error(`timed out waiting for ${what}`)
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`)
}
async function step(name, run) {
  try {
    await run()
  } catch (error) {
    check(name, false, error instanceof Error ? error.message : String(error))
  }
}

const card = (project, slug) => `[data-xq-card="${ids[project]}/${slug}"]`
// Wake phrases are the browser's locale, so the checks match the sentence's SHAPE around them.
const SNOOZED = /^Snoozed until .+$/
const under = (project) => `Under ${project} in the list`

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--force-color-profile=srgb"] })
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 })
  const errors = []
  page.on("pageerror", (error) => errors.push(`pageerror: ${error}`))
  page.on("console", (message) => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(`console: ${message.text()}`) })
  page.on("response", (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })

  // A toast is its text, an optional muted second line (`detail`), and its buttons.
  const toast = () => page.evaluate(() => {
    const el = document.querySelector("[data-toast]")
    if (!el) return null
    const own = (node) => [...node.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join("").trim()
    const lines = [...el.children].find((child) => child.tagName === "SPAN")
    const button = el.querySelector("button")
    return { text: lines ? own(lines) : own(el), detail: lines?.querySelector("span")?.textContent?.trim() ?? null, button: button?.textContent?.trim() ?? null, opacity: Number(getComputedStyle(el).opacity) }
  })
  const toastSays = (pattern) => waitFor(`a toast matching ${pattern}`, async () => { const t = await toast(); return t && pattern.test(t.text) && t.opacity > 0.5 ? t : null }, 6000, 50)
  const clickUndo = async () => {
    const undo = await page.waitForSelector("[data-toast] button", { timeout: 3000 })
    await undo.click()
  }
  // The quick snooze on a card: the first button of its footer (SnoozeButton's one-click half).
  const snoozeCard = async (scope) => {
    const button = await page.$(`${scope} footer button`)
    if (!button) throw new Error(`no snooze button in ${scope}`)
    await button.click()
  }
  const shotToast = async (name) => {
    await sleep(300) // past the 200ms rise, so the shot is the toast at rest
    // The toast is `fixed`, so its rect is the VIEWPORT's; a clip is the DOCUMENT's.
    const rect = await page.evaluate(() => { const r = document.querySelector("[data-toast]").getBoundingClientRect(); return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height } })
    const pad = 20
    const path = join(shots, name)
    await page.screenshot({ path, clip: { x: rect.x - pad, y: rect.y - pad, width: rect.width + 2 * pad, height: rect.height + 2 * pad } })
    return path
  }

  // All projects (`/?all`, lib/pageView.ts), bound to the launcher: the prompt box's pick, which the page
  // binds in that view, is set before the page loads.
  const ALL = `${origin}/?all`
  await page.goto(`${origin}/?project=acme-api`, { waitUntil: "networkidle2" })
  await page.evaluate((id) => localStorage.setItem("frizz.crossProjectFocus", id), ids["acme-api"])
  await page.goto(ALL, { waitUntil: "networkidle2" })
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark" })
  await page.waitForSelector("[data-xq-card]")
  await sleep(800)

  await step("a tenant's card: the toast names its project, and Undo brings the card back from the poll", async () => {
    const scope = card("marketing-site", "pricing-page-tiers")
    await snoozeCard(scope)
    const shown = await toastSays(SNOOZED)
    check("the snooze toast says where the thread went", shown.detail === under("marketing-site"), `"${shown.text}" / "${shown.detail}" [${shown.button}]`)
    check("the snooze toast offers Undo", shown.button === "Undo")
    console.log(`      shot: ${await shotToast("snooze-undo-toast.png")}`)
    const snoozed = await waitFor("the tenant thread to snooze", async () => { const t = await threadOf("marketing-site", "pricing-page-tiers"); return t?.snoozedUntil ? t : null })
    check("the tenant's thread is snoozed on the server", Boolean(snoozed.snoozedUntil), snoozed.snoozedUntil)
    await waitFor("the card to leave", async () => (await page.$(scope)) === null)
    // Past one full poll, so the page's copy of the queue no longer holds the thread and the card can
    // only come back through a fresh read — the path the refetch exists for.
    await sleep(3400)
    const clickedAt = Date.now()
    await clickUndo()
    await waitFor("the card to come back", async () => (await page.$(scope)) !== null, 6000, 25)
    const back = Date.now() - clickedAt
    check("Undo brings the tenant's card back without waiting out a poll", back < 1500, `${back}ms`)
    const awake = await threadOf("marketing-site", "pricing-page-tiers")
    check("Undo un-snoozes the tenant's thread on the server", !awake?.snoozedUntil, `snoozedUntil ${awake?.snoozedUntil ?? "cleared"}`)
    const after = await toastSays(/^Snooze undone$/)
    check("Undo confirms itself", after.text === "Snooze undone")
  })

  await step("the focused project's card: Undo lifts the fade guard at once", async () => {
    const scope = card("acme-api", "rate-limit-headers")
    await sleep(1800) // let the previous toast go
    await snoozeCard(scope)
    await toastSays(SNOOZED)
    await waitFor("the card to leave", async () => (await page.$(scope)) === null)
    const clickedAt = Date.now()
    await clickUndo()
    await waitFor("the card to come back", async () => (await page.$(scope)) !== null, 6000, 25)
    const back = Date.now() - clickedAt
    check("Undo brings the focused project's card back promptly", back < 1500, `${back}ms`)
    const awake = await threadOf("acme-api", "rate-limit-headers")
    check("Undo un-snoozes the focused project's thread", !awake?.snoozedUntil, `snoozedUntil ${awake?.snoozedUntil ?? "cleared"}`)
  })

  await step("the drawer: a re-snooze's Undo restores the first deadline", async () => {
    const scope = card("acme-api", "upgrade-postgres-driver")
    await sleep(1800)
    await page.click(`${scope} h3 a`)
    const footer = "[data-thread-lifecycle-footer]"
    await page.waitForSelector(`${footer} button[aria-label^="Snooze "]:not([aria-label="Snooze options"])`, { timeout: 8000 })
    await sleep(500)
    await page.click(`${footer} button[aria-label^="Snooze "]:not([aria-label="Snooze options"])`)
    const first = await toastSays(SNOOZED)
    check("the drawer's snooze toast names the drawer's project", first.detail === under("acme-api"), `"${first.text}" / "${first.detail}"`)
    const firstUntil = (await waitFor("the thread to snooze", async () => { const t = await threadOf("acme-api", "upgrade-postgres-driver"); return t?.snoozedUntil ? t : null })).snoozedUntil
    await sleep(600)
    // Re-snooze to a week from the chevron menu, then Undo: the FIRST snooze must come back, not "awake".
    await page.click(`${footer} button[aria-label="Snooze options"]`)
    await page.waitForSelector(`[role="menu"] [data-value="1w"]`, { timeout: 3000 })
    await page.click(`[role="menu"] [data-value="1w"]`)
    await waitFor("the week-long snooze", async () => { const t = await threadOf("acme-api", "upgrade-postgres-driver"); return t?.snoozedUntil && t.snoozedUntil !== firstUntil ? t : null })
    await toastSays(SNOOZED)
    await clickUndo()
    const restored = await toastSays(/^Snooze restored$/)
    const thread = await threadOf("acme-api", "upgrade-postgres-driver")
    check("Undo over an earlier snooze restores that snooze", thread?.snoozedUntil === firstUntil && restored.text === "Snooze restored", `until ${thread?.snoozedUntil} (first ${firstUntil})`)
    // The toast is outside the drawer's DOM, so every drawer read a click on it as a click OUTSIDE and
    // closed — Undo took the drawer down with the snooze.
    await sleep(400)
    check("Undo in a drawer leaves the drawer open", (await page.$(footer)) !== null)
  })

  await step("a faded toast's button takes no click and no Tab", async () => {
    // The drawer is still open, so the toast rides above its footer — the spot where an invisible Undo
    // would have caught a click. Snooze once more, let the toast fade, then probe the button's place.
    const footer = "[data-thread-lifecycle-footer]"
    await sleep(1800)
    await page.click(`${footer} button[aria-label="Wake thread now"]`)
    await toastSays(/^Snooze cleared$/)
    await sleep(1800)
    await page.click(`${footer} button[aria-label^="Snooze "]:not([aria-label="Snooze options"])`)
    await toastSays(SNOOZED)
    const probe = () => page.evaluate(() => {
      const button = document.querySelector("[data-toast] button")
      if (!button) return null
      const r = button.getBoundingClientRect()
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return { hit: hit === button || button.contains(hit), tab: button.tabIndex, onScreen: Math.max(0, Math.min(window.innerHeight, r.bottom) - Math.max(0, r.top)) }
    })
    const live = await probe()
    check("a shown toast's Undo is clickable (negative control)", live?.hit === true && live.tab === 0, JSON.stringify(live))
    await sleep(5600)
    const faded = await probe()
    check("a faded toast's Undo cannot be clicked", faded !== null && faded.hit === false, JSON.stringify(faded))
    check("a faded toast's Undo is out of the Tab order", faded?.tab === -1)
    check("the faded Undo still sits on screen above the drawer (why this mattered)", (faded?.onScreen ?? 0) > 0, `${faded?.onScreen}px on screen`)
    // Leave the thread awake.
    const thread = await threadOf("acme-api", "upgrade-postgres-driver")
    if (thread?.snoozedUntil) await api("acme-api").mutate("setThreadSnooze", { slug: "upgrade-postgres-driver", sessionId: thread.sessionId, until: null, prompt: null })
  })

  await step("with no drawer open, a faded toast's Undo is inert too", async () => {
    // Without a drawer the toast rests at the page's bottom edge, and its fade drops it 32px — which
    // left part of the button inside the viewport, where it still caught clicks.
    await page.goto(ALL, { waitUntil: "networkidle2" })
    await page.waitForSelector("[data-xq-card]")
    await sleep(800)
    const scope = card("acme-api", "fix-pagination-cursor")
    await snoozeCard(scope)
    await toastSays(SNOOZED)
    await sleep(5600)
    const faded = await page.evaluate(() => {
      const button = document.querySelector("[data-toast] button")
      if (!button) return null
      const r = button.getBoundingClientRect()
      const y = Math.min(window.innerHeight - 1, r.top + 2)
      const hit = document.elementFromPoint(r.x + r.width / 2, y)
      return { hit: hit === button || button.contains(hit), tab: button.tabIndex, onScreen: Math.max(0, Math.min(window.innerHeight, r.bottom) - Math.max(0, r.top)) }
    })
    check("a faded toast's Undo, no drawer, cannot be clicked where it still overlaps the page", faded !== null && faded.hit === false && faded.tab === -1, JSON.stringify(faded))
    const thread = await threadOf("acme-api", "fix-pagination-cursor")
    if (thread?.snoozedUntil) await api("acme-api").mutate("setThreadSnooze", { slug: "fix-pagination-cursor", sessionId: thread.sessionId, until: null, prompt: null })
  })

  // Two 404s that are answers, not faults (verify-all-queues.mjs filters the same pair): the supervisor
  // probe on a stack with no supervisor, and the icon request for a project that has no icon.
  const real = errors.filter((e) => !/\/_frizz\/control\/status|\/_frizz\/project-icon\?/.test(e))
  check("no page errors", real.length === 0, real.slice(0, 5).join(" | "))
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length > 0 ? 1 : 0)
