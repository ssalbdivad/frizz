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
