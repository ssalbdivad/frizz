// Drive THREAD DELETION in a real headless browser against an adhoc stack seeded by
// seed-old-threads.ts: the ⋯ menu's Delete on an open thread with its drawer open, then Settings'
// "Delete untouched threads now" at 30d (must take shell-budgets only), with the board read back over RPC
// after each step. Screenshots land in --out.
// Usage: nub scripts/verify-thread-delete.ts --port=NNNN --slug=<project slug> --out=/abs/dir
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import puppeteer, { type Page } from "puppeteer"
import { MOUSE_POINTER_ARG } from "./lib/mouse-pointer.mjs"
import { createRpcClient } from "./lib/rpc-client.mjs"

const flags = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("="))) as Record<string, string>
const { port, slug, out } = flags
mkdirSync(out, { recursive: true })
const origin = `http://127.0.0.1:${port}`
const api = createRpcClient(`${origin}/`)
const slugs = async () => ((await api.query("board")) as { threads: { id: string; kind: string }[] }).threads.filter((t) => t.kind === "session").map((t) => t.id).sort()
const errors: string[] = []
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function clickText(page: Page, selector: string, text: string) {
  const handle = await page.waitForFunction(
    (sel, txt) => [...document.querySelectorAll<HTMLElement>(sel)].find((el) => el.textContent?.trim().startsWith(txt)) ?? null,
    { timeout: 10_000 }, selector, text,
  )
  await (handle as unknown as { click(): Promise<void> }).click()
}

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--force-color-profile=srgb", MOUSE_POINTER_ARG] })
try {
  const page = await browser.newPage()
  page.on("pageerror", (e) => errors.push(String(e)))
  page.on("response", (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`) })
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 })
  console.log("before:", await slugs())

  // 1. ⋯ → Delete thread… on the OPEN thread, from its drawer.
  await page.goto(`${origin}/all/${slug}/thread/perf-bench`, { waitUntil: "networkidle2" })
  await wait(2500)
  // The queue card carries a ⋯ too, under the drawer; the drawer's is the last one in the DOM.
  await page.waitForSelector(`[data-thread-menu="perf-bench"]`, { timeout: 10_000 })
  const menus = await page.$$(`[data-thread-menu="perf-bench"]`)
  await menus[menus.length - 1]!.click()
  await wait(400)
  await page.screenshot({ path: join(out, "menu.png") })
  await clickText(page, "[role=menuitem]", "Delete thread")
  await wait(500)
  await page.screenshot({ path: join(out, "confirm-one.png") })
  await clickText(page, "[role=dialog] button", "Delete thread")
  await wait(2000)
  await page.screenshot({ path: join(out, "after-one.png") })
  console.log("after ⋯ delete:", await slugs(), "url:", page.url())

  // 2. Settings → Delete untouched threads now, 30d (the default).
  await page.goto(`${origin}/`, { waitUntil: "networkidle2" })
  await wait(2000)
  await page.keyboard.press("Escape")
  const opened = await page.evaluate(() => {
    const button = document.querySelector<HTMLElement>("[aria-label=Settings]")
    button?.click()
    return Boolean(button)
  })
  if (!opened) throw new Error("no Settings button")
  await wait(1200)
  await page.evaluate(() => document.querySelector("[aria-label='Delete done threads automatically']")?.scrollIntoView({ block: "center" }))
  await wait(300)
  await page.screenshot({ path: join(out, "settings.png") })
  await clickText(page, "button", "Delete…")
  await wait(1200)
  await page.screenshot({ path: join(out, "confirm-bulk.png") })
  const title = await page.evaluate(() => document.querySelector("[role=dialog] h2")?.textContent)
  console.log("bulk dialog title:", title)
  await clickText(page, "[role=dialog] footer button", "Delete")
  await wait(2000)
  console.log("after bulk 30d:", await slugs())
  console.log("page errors:", errors.length ? errors : "none")
} finally {
  await browser.close()
}
