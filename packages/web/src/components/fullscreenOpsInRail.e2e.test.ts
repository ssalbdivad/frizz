import assert from "node:assert/strict"
import test from "node:test"

// On /full the ops strip under the prompt box gives way to the rail beside the column (maintainer
// 2026-10-02: "it's already showing up in the sidebar to the right") — so the rail has to carry every row
// the strip did, and the strip has to come back the moment the window is too narrow to show the rail.
// Real server, real tailer, real broker-row thread; only the absent launcher status probe is stubbed.
// Boot scripts/adhoc-stack.mjs, then scripts/seed-full-rail-ops.mjs --port=<its port> --home=<its HOME>.
// FRIZZ_FULL_RAIL_OPS_E2E_URL=http://127.0.0.1:<port> nub --test <this file>
const baseUrl = process.env.FRIZZ_FULL_RAIL_OPS_E2E_URL

test("/full lists the thread's ops in its rail, and under the prompt box only once the rail is gone", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(String(e)))
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
    await page.setRequestInterception(true)
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/_frizz/control/status") {
        void r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ protocol: 1, state: "ready", updateRestart: false }) })
      } else void r.continue()
    })
    const railKinds = () => page.$$eval("[data-focus-rail] [data-wait-row]", (rows) => rows.map((r) => (r as HTMLElement).dataset.waitKind).sort())
    const stripIn = (scope: string) => page.$(`${scope} [data-background-ops]`)

    // 1. Wide enough for the rail: every row is there, and none of them is under the prompt box.
    await page.setViewport({ width: 1440, height: 900 })
    await page.goto(`${baseUrl}/thread/full-rail-ops/full`, { waitUntil: "networkidle2" })
    await page.waitForFunction(() => document.querySelectorAll("[data-focus-rail] [data-wait-row]").length === 4)
    assert.deepEqual(await railKinds(), ["agent", "link", "link", "shell"])
    assert.equal(await stripIn("main[data-standalone-thread]"), null, "the strip must not repeat the rail's rows")
    // A saved URL is a real link out; a saved file opens in the page's own viewer.
    assert.equal(await page.$eval('[data-focus-rail] [data-wait-kind="link"] a', (a) => a.getAttribute("href")), "http://127.0.0.1:5173/project/demo")
    await page.click('[data-focus-rail] [data-wait-kind="link"] button')
    await page.waitForFunction(() => document.querySelectorAll("[data-file-viewer-slot]").length === 1)
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => document.querySelectorAll("[data-file-viewer-slot]").length === 0)

    // 2. Narrower than the split: the rail is not drawn, so the strip is the only place these rows are.
    // A live resize, not a fresh load — the page has to follow the window as it changes.
    await page.setViewport({ width: 1000, height: 900 })
    await page.waitForSelector("main[data-standalone-thread] [data-background-ops]")
    const strip = await page.$eval("main[data-standalone-thread] [data-background-ops]", (el) => (el as HTMLElement).innerText)
    for (const row of ["Verify the rail carries every row", "Run the dev server", "Open dev server", "Working plan"]) {
      assert.ok(strip.includes(row), `the narrow strip lists "${row}"`)
    }

    // 3. Back to wide: the strip yields to the rail again.
    await page.setViewport({ width: 1440, height: 900 })
    await page.waitForFunction(() => !document.querySelector("main[data-standalone-thread] [data-background-ops]"))

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
