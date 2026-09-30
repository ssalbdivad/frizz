import assert from "node:assert/strict"
import test, { after, before } from "node:test"

// The composer's `@` MENTION TYPEAHEAD and the transcript's mention links, against the real <Composer>,
// ThreadRow and LinkifiedText on a stubbed board (thread-mentions-fixture.tsx). Pins the keyboard contract
// the skills menu set — ArrowDown/Enter and Tab complete, Escape dismisses without blurring — plus what
// is particular to mentions: the menu follows the CARET (a mention mid-draft), the thread being written
// into is never offered, and a sent `@handle` opens its thread.
//
// Skipped unless a Vite URL serving the fixtures is provided: start `vite` in packages/web and set
// FRIZZ_MENTIONS_E2E_URL to its origin.
const baseUrl = process.env.FRIZZ_MENTIONS_E2E_URL

const BOX = 'textarea[data-surface="chatComposer"]'
const MENU = "[data-mention-menu]"

type PuppeteerModule = typeof import("puppeteer")
type Browser = Awaited<ReturnType<PuppeteerModule["launch"]>>
type Page = Awaited<ReturnType<Browser["newPage"]>>

let browser: Browser | undefined
let page: Page | undefined
let errors: string[] = []

before(async () => {
  if (!baseUrl) return
  const { default: puppeteer } = await import("puppeteer")
  browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
  page = await browser.newPage()
  page.setDefaultTimeout(60_000)
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 })
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
})

after(async () => { await browser?.close() })

const menuRows = (): Promise<string[]> => page!.evaluate((sel) =>
  [...document.querySelectorAll(`${sel} button`)].map((row) => row.querySelector("span")!.textContent!), MENU)
const menuVisible = (): Promise<boolean> => page!.evaluate((sel) => Boolean(document.querySelector(sel)), MENU)
const boxValue = (): Promise<string> => page!.$eval(BOX, (el) => (el as HTMLTextAreaElement).value)
// Accepting restores the caret in a requestAnimationFrame; wait for it before typing on (see the skills
// typeahead test for the race this avoids).
const waitForCaretAt = (at: number): Promise<unknown> => page!.waitForFunction((sel, n) => {
  const el = document.querySelector(sel) as HTMLTextAreaElement | null
  return Boolean(el) && el!.selectionStart === n && el!.selectionEnd === n
}, {}, BOX, at)

async function open() {
  errors = []
  await page!.goto(`${baseUrl}/thread-mentions-fixture.html`, { waitUntil: "networkidle2" })
  await page!.waitForSelector(BOX)
  await page!.click(BOX)
}

test("the rail shows names as handles, and `@` offers them — open first, done last, never this thread", {
  skip: !baseUrl,
  timeout: 150_000,
}, async () => {
  await open()
  const rail = await page!.$$eval("[data-sidebar-rail] [data-xq-thread-row]", (rows) => rows.map((r) => r.textContent))
  assert.ok(rail.includes("shellBudgets") && rail.includes("arkTypePerf"), `handles in the rail: ${rail.join(", ")}`)
  await page!.type(BOX, "ask @")
  await page!.waitForSelector(MENU)
  const rows = await menuRows()
  assert.ok(!rows.includes("@focusMode"), "the thread being written into is not offered")
  assert.equal(rows.at(-1), "@billingWebhooks", "a done thread comes after every open one")
  assert.ok(!rows.some((r) => r.startsWith("@rework")), "a sentence-length title has no handle")
  await page!.type(BOX, "bud")
  assert.deepEqual(await menuRows(), ["@budgetReport", "@shellBudgets"], "a handle prefix, then a word inside one")
  assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`)
})

test("ArrowDown+Enter completes mid-draft, Tab completes, and Escape closes without blurring", {
  skip: !baseUrl,
  timeout: 150_000,
}, async () => {
  await open()
  await page!.type(BOX, "ask @bud")
  await page!.waitForSelector(MENU)
  await page!.keyboard.press("ArrowDown")
  await page!.keyboard.press("Enter")
  assert.equal(await boxValue(), "ask @shellBudgets ", "the highlighted row, inserted as text — no newline, no send")
  await waitForCaretAt("ask @shellBudgets ".length)
  assert.equal(await menuVisible(), false)

  await page!.type(BOX, "and @ark")
  await page!.waitForSelector(MENU)
  await page!.keyboard.press("Tab")
  assert.equal(await boxValue(), "ask @shellBudgets and @arkTypePerf ")
  await waitForCaretAt("ask @shellBudgets and @arkTypePerf ".length)

  await page!.type(BOX, "@b")
  await page!.waitForSelector(MENU)
  await page!.keyboard.press("Escape")
  assert.equal(await menuVisible(), false, "Escape closes the menu")
  assert.equal(await page!.evaluate((sel) => document.activeElement === document.querySelector(sel), BOX), true, "…and keeps the caret in the box")
  assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`)
})

test("a sent @handle opens the thread it names; an unknown one stays text", {
  skip: !baseUrl,
  timeout: 150_000,
}, async () => {
  await open()
  const links = await page!.$$eval("[data-mention-bubble] a[data-thread-mention]", (as) => as.map((a) => [a.textContent, a.getAttribute("data-thread-mention")]))
  assert.deepEqual(links, [["@shellBudgets", "shell-budgets"], ["@focusMode", "focus-mode"]])
  await page!.click('[data-mention-bubble] a[data-thread-mention="shell-budgets"]')
  const drawers = await page!.evaluate(() => (window as unknown as { __drawers: () => string[] }).__drawers())
  assert.deepEqual(drawers, ["thread:shell-budgets"], "a plain click opens the thread's drawer")
  assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`)
})

// ── SUB-AGENTS AFTER THE DOT (maintainer 2026-09-30: "autocomplete should still work for subagents
// after .") — the fixture stubs `shell-budgets`'s subAgentDirectory.
const menuRowText = (): Promise<string[]> => page!.evaluate((sel) =>
  [...document.querySelectorAll(`${sel} button`)].map((row) => [...row.querySelectorAll("span")].map((s) => s.textContent).join(" | ")), MENU)
const directoryRequests = (): Promise<string[]> => page!.evaluate(() => [...(window as unknown as { __directoryRequests: string[] }).__directoryRequests])

test("`@thread.` offers that thread's sub-agents, live before returned, and narrows as you type", {
  skip: !baseUrl,
  timeout: 150_000,
}, async () => {
  await open()
  await page!.type(BOX, "ask @shellBudgets")
  await page!.waitForSelector(MENU)
  assert.deepEqual(await menuRows(), ["@shellBudgets"], "no dot: threads only, exactly as before")
  await page!.type(BOX, ".")
  await page!.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("aria-label") === "Sub-agents", {}, MENU)
  assert.deepEqual(await menuRows(), [
    "@shellBudgets.cacheKeys",
    "@shellBudgets.wave2",
    "@shellBudgets.wave2.implW3",
    "@shellBudgets.capAudit",
    "@shellBudgets.cacheSweep",
  ], "every addressed child, live first; the sentence-named one has no address and is not offered")
  const rows = await menuRowText()
  assert.match(rows[0]!, /^@shellBudgets\.cacheKeys \| running 1[12]m$/)
  assert.match(rows[3]!, /^@shellBudgets\.capAudit \| returned 3h ago \| done$/, "a returned child is tagged done")
  assert.match(rows[4]!, /^@shellBudgets\.cacheSweep \| failed 2d ago \| done$/)
  await page!.type(BOX, "ca")
  await page!.waitForFunction((sel) => document.querySelectorAll(`${sel} button`).length === 3, {}, MENU)
  assert.deepEqual(await menuRows(), ["@shellBudgets.cacheKeys", "@shellBudgets.capAudit", "@shellBudgets.cacheSweep"])
  await page!.type(BOX, "che")
  await page!.waitForFunction((sel) => document.querySelectorAll(`${sel} button`).length === 2, {}, MENU)
  assert.deepEqual(await directoryRequests(), ["shell-budgets"], "typing on reads the one answer the dot fetched")
  await page!.keyboard.press("Enter")
  assert.equal(await boxValue(), "ask @shellBudgets.cacheKeys ", "completes to the whole address, then one space")
  await waitForCaretAt("ask @shellBudgets.cacheKeys ".length)
  // A thread with no directory entries: the dot closes the menu rather than offering nothing.
  await page!.type(BOX, "and @arkTypePerf.")
  await page!.waitForFunction(() => (window as unknown as { __directoryRequests: string[] }).__directoryRequests.includes("arktype-perf"))
  assert.equal(await menuVisible(), false)
  assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`)
})

test("a sent @thread.child opens that sub-agent's drawer; an unknown child opens its thread", {
  skip: !baseUrl,
  timeout: 150_000,
}, async () => {
  await open()
  const links = await page!.$$eval("[data-mention-bubble-sub] a[data-thread-mention]", (as) => as.map((a) => [a.textContent, a.getAttribute("data-subagent-mention")]))
  assert.deepEqual(links, [
    ["@shellBudgets.cacheKeys", "shellBudgets.cacheKeys"],
    ["@ShellBudget.capAudit", "ShellBudget.capAudit"],
    ["@shellBudgets.nothing", "shellBudgets.nothing"],
  ], "the sentence's full stop after capAudit is not part of the link")
  // The fixture mounts no drawer stack, so each open replaces the top layer; read the top one.
  const openedBy = async (mention: string): Promise<string | undefined> => {
    // The click fetches the directory before it opens anything, so wait for the stack to move — read
    // BEFORE the click, since a cached answer can open the drawer before the next line runs.
    const before = await page!.evaluate(() => JSON.stringify((window as unknown as { __drawers: () => string[] }).__drawers()))
    await page!.click(`[data-mention-bubble-sub] a[data-subagent-mention="${mention}"]`)
    await page!.waitForFunction((was) => JSON.stringify((window as unknown as { __drawers: () => string[] }).__drawers()) !== was, {}, before)
    return page!.evaluate(() => (window as unknown as { __drawers: () => string[] }).__drawers().at(-1))
  }
  assert.equal(await openedBy("shellBudgets.cacheKeys"), "subagent:shell-budgets:toolu_keys")
  assert.equal(await openedBy("ShellBudget.capAudit"), "subagent:shell-budgets:toolu_audit", "a returned child, found by its folded address")
  assert.equal(await openedBy("shellBudgets.nothing"), "thread:shell-budgets", "no such child: its thread opens instead")
  assert.deepEqual(await directoryRequests(), ["shell-budgets"], "three clicks, one fetch")
  assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`)
})

// AGENT PROSE (maintainer 2026-09-30: agents referring to each other name "the fully qualified name so
// you can easily click to view that agent"): the real markdown pipeline, the real sanitizer, and the
// app's own delegated `/thread/` listener.
test("an agent's @thread and @thread.child in rendered markdown are links that open what they name", {
  skip: !baseUrl,
  timeout: 150_000,
}, async () => {
  await open()
  const links = await page!.$$eval("[data-agent-prose] a", (as) => as.map((a) => [a.textContent, a.getAttribute("href"), a.getAttribute("target")]))
  assert.deepEqual(links, [
    ["@shellBudgets", "/thread/shell-budgets", "_blank"],
    ["@shellBudgets.cacheKeys", "/thread/shell-budgets#shellBudgets.cacheKeys", "_blank"],
    ["@ShellBudget.capAudit", "/thread/shell-budgets#ShellBudget.capAudit", "_blank"],
    ["@shellBudgets", "https://example.com", "_blank"],
  ], "code, a package, an author's own link and an unknown thread are untouched")
  const code = await page!.$$eval("[data-agent-prose] code", (cs) => cs.map((c) => c.textContent))
  assert.deepEqual(code, ["@shellBudgets"])
  const top = () => page!.evaluate(() => (window as unknown as { __drawers: () => string[] }).__drawers().at(-1))
  const click = async (selector: string) => {
    const before = await page!.evaluate(() => JSON.stringify((window as unknown as { __drawers: () => string[] }).__drawers()))
    await page!.click(selector)
    await page!.waitForFunction((was) => JSON.stringify((window as unknown as { __drawers: () => string[] }).__drawers()) !== was, {}, before)
    return top()
  }
  assert.equal(await click('[data-agent-prose] a[href="/thread/shell-budgets#shellBudgets.cacheKeys"]'), "subagent:shell-budgets:toolu_keys")
  assert.equal(await click('[data-agent-prose] a[href="/thread/shell-budgets#ShellBudget.capAudit"]'), "subagent:shell-budgets:toolu_audit")
  assert.equal(await click('[data-agent-prose] a[href="/thread/shell-budgets"]'), "thread:shell-budgets")
  assert.equal(page!.url().endsWith("/thread-mentions-fixture.html"), true, "a plain click never navigated")
  assert.equal((await browser!.pages()).length, 2, "…nor opened a tab")
  assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`)
})
