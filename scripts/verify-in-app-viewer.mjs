#!/usr/bin/env node
// Drive the in-app picture viewer and file reader on a REAL, seeded, two-project stack — the half of the
// feature no fixture reaches: real pictures from /local-image, real reads through each project's gate,
// real links that only exist once the server has resolved a path on disk. Checks:
//   · a picture on a TENANT's card on the everything page opens in the viewer, alone (its card's gallery),
//     and a queue letter key typed over it (D, mark as done) never reaches the card beneath;
//   · a log cited on that card opens in the reader, read through the TENANT's gate — the tenant is checked
//     out outside the sandbox's home and temp trees, and the control below proves the page's own
//     project refuses that file, so a reader that asked the page would show an error instead;
//   · in the thread's drawer, a picture steps through all three of the thread's pictures, and Escape
//     closes the viewer and leaves the drawer standing;
//   · a JSON file and a TypeScript file open in the reader as source; a PDF still asks the desktop
//     opener — and only the PDF does (the opener is intercepted here, so nothing launches on this machine).
//
// Usage:
//   nub scripts/adhoc-stack.mjs --port=45817 --project=/tmp/x/launcher --also-project=/home/me/x/acme-api \
//     --prime > /tmp/stack.log 2>&1                                                    # background
//   nub scripts/seed-in-app-viewer.mjs --home=<stack home> --cwd=/home/me/x/acme-api --dir=/home/me/x/acme-api/artifacts \
//     --shots=a.png,b.png,c.png --project-id=<tenant id> > /tmp/seed.json
//   nub scripts/verify-in-app-viewer.mjs --stack=/tmp/stack.log --seed=/tmp/seed.json [--shots=/abs/dir]
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import puppeteer from "puppeteer"
import { createRpcClient } from "./lib/rpc-client.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => { const s = a.slice(2); const i = s.indexOf("="); return i < 0 ? [s, true] : [s.slice(0, i), s.slice(i + 1)] }),
)
if (!flags.stack || !flags.seed) {
  console.error("usage: nub scripts/verify-in-app-viewer.mjs --stack=/abs/stack.log --seed=/abs/seed.json [--shots=/abs/dir]")
  process.exit(1)
}
const line = readFileSync(flags.stack, "utf8").split("\n").find((l) => l.startsWith("{\"url\""))
if (!line) throw new Error(`no stack json line in ${flags.stack}`)
const stack = JSON.parse(line)
const origin = new URL(stack.url).origin
const tenant = stack.tenants[0]
if (!tenant) throw new Error("the stack has no tenant — boot it with --also-project")
const seed = JSON.parse(readFileSync(flags.seed, "utf8").trim().split("\n").at(-1))
const { files } = seed
const shots = flags.shots ?? join(process.cwd(), ".adhoc-shots")
mkdirSync(shots, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let failures = 0
function check(name, ok, detail) {
  if (!ok) failures++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`)
}
let page
async function step(name, run) {
  try {
    await run()
  } catch (error) {
    const shot = join(shots, `in-app-viewer-fail-${failures + 1}.png`)
    await page?.screenshot({ path: shot }).catch(() => {})
    check(name, false, `${error instanceof Error ? error.message : String(error)} (${shot})`)
  }
}

// THE CONTROL: the page's own (launching) project refuses the tenant's file, and the tenant admits it.
// Without the first half, a green reader below would prove nothing about whose gate read it.
await step("control: only the tenant's own gate admits a file in its out-of-home checkout", async () => {
  const launcherRead = await createRpcClient(origin).query("localFile", { path: files.log }).then(() => "read", (error) => String(error.message))
  const tenantRead = await createRpcClient(origin, tenant.id).query("localFile", { path: files.log })
  check("control: the launcher's gate refuses the tenant's log", launcherRead !== "read", launcherRead.slice(0, 120))
  check("control: the tenant's gate reads it", tenantRead.text.includes("booting server"))
})

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--force-color-profile=srgb"] })
try {
  page = await browser.newPage()
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }])
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  const errors = []
  page.on("pageerror", (error) => errors.push(`pageerror: ${error}`))
  page.on("console", (message) => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(`console: ${message.text()}`) })
  // A disposable stack runs no supervisor, so its control endpoint 404s on every page, and its throwaway
  // projects have no icon to serve (the rail draws their initials instead); nothing else may fail.
  page.on("response", (response) => { if (response.status() >= 400 && !/\/_frizz\/control\/status$|\/_frizz\/project-icon\?/.test(response.url())) errors.push(`${response.status()} ${response.url()}`) })
  // Every file read and open the page makes, by route — and the opener answered HERE, never by the server.
  // And every write, so a key that reached a card through the viewer would show up.
  const reads = []
  const opens = []
  const posts = []
  await page.setRequestInterception(true)
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (request.method() === "POST" && url.pathname.includes("/rpc/")) posts.push(url.pathname)
    if (url.pathname.endsWith("/rpc/openLocalFile")) {
      const input = JSON.parse(request.postData() ?? "{}")
      opens.push({ route: url.pathname, ...input })
      void request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { action: "opened", path: input.path } }) })
      return
    }
    if (/\/rpc\/local(File|Markdown)$/.test(url.pathname)) reads.push({ route: url.pathname, path: JSON.parse(url.searchParams.get("input") ?? "{}").path })
    void request.continue()
  })

  const card = `[data-xq-card="${tenant.id}/${seed.slug}"]`
  const viewer = "[data-image-viewer]"
  const headerText = () => page.$eval(`${viewer} header`, (el) => el.textContent ?? "")
  const pictureShown = () => page.waitForFunction((sel) => {
    const img = document.querySelector(`${sel} img`)
    return !!img && img.complete && img.naturalWidth > 0 && getComputedStyle(img).opacity === "1"
  }, { timeout: 10_000 }, viewer)
  const settle = async (name) => { await sleep(300); await page.screenshot({ path: join(shots, name) }) }
  // Click where the element is VISIBLE, as a person would. A card's long handoff is clipped to its
  // opening lines (AllQueuesCard ClampedBody), so a picture in it can be mostly out of view, and a click
  // at its box's centre lands on whatever is under the clip instead.
  const clickVisible = async (selector) => {
    const point = await page.$eval(selector, (el) => {
      el.scrollIntoView({ block: "center" })
      const r = el.getBoundingClientRect()
      let [top, bottom, left, right] = [r.top, r.bottom, r.left, r.right]
      for (let a = el.parentElement; a; a = a.parentElement) {
        const cs = getComputedStyle(a)
        if (cs.overflowX === "visible" && cs.overflowY === "visible") continue
        const b = a.getBoundingClientRect()
        ;[top, bottom, left, right] = [Math.max(top, b.top), Math.min(bottom, b.bottom), Math.max(left, b.left), Math.min(right, b.right)]
      }
      // The upper third of what shows: a clipped body fades out toward its bottom edge.
      const x = (left + right) / 2
      const y = top + (bottom - top) / 3
      return { x, y, hit: document.elementFromPoint(x, y) === el }
    })
    if (!point.hit) throw new Error(`nothing of ${selector} is under its own visible centre`)
    await page.mouse.click(point.x, point.y)
  }

  // A fresh dev server optimizes its dependencies on the first load and reloads the page once it has
  // (a 504 on a `.vite` dep is that, not the app). Load twice, and count errors from the settled page.
  await page.goto(`${origin}/`, { waitUntil: "networkidle2" })
  await sleep(1500)
  await page.goto(`${origin}/`, { waitUntil: "networkidle2" })
  errors.length = 0

  await step("the tenant's card shows its handoff picture, loaded from disk", async () => {
    await page.waitForSelector(`${card} img[data-local-path="${files.after}"]`, { timeout: 20_000 })
    await page.waitForFunction((sel) => { const img = document.querySelector(sel); return !!img && img.complete && img.naturalWidth > 0 }, { timeout: 10_000 }, `${card} img[data-local-path="${files.after}"]`)
    check("the tenant's card shows its handoff picture, loaded from disk", true)
  })

  await step("a picture on the card opens in the viewer, alone", async () => {
    await clickVisible(`${card} img[data-local-path="${files.after}"]`)
    await page.waitForSelector(viewer, { timeout: 5_000 })
    await pictureShown()
    const text = await headerText()
    check("a picture on the card opens in the viewer, alone", text.includes("board-after.png") && !/\d+ \/ \d+/.test(text), JSON.stringify(text))
    await settle("real-card-viewer.png")
    // The queue's letter keys act on the card under the cursor — D marks it done. Over the viewer they
    // must not: it is a modal, and the keyboard runtime stands down for one (keyboardRuntime overlayOpen).
    // The control at the end proves D is live on this page, so this silence is the viewer's doing.
    const before = posts.length
    await page.keyboard.press("d")
    await sleep(800)
    check("D typed over the viewer does nothing to the card beneath", posts.length === before && !!(await page.$(`${card}[data-queue-leaving="false"]`)), JSON.stringify(posts.slice(before)))
    await page.keyboard.press("Escape")
    await page.waitForFunction((sel) => !document.querySelector(sel), { timeout: 5_000 }, viewer)
  })

  await step("a log cited on the card opens in the reader, read through the tenant's gate", async () => {
    // A backticked path is a link only once the tenant's gate has resolved it on disk (localFileCode.ts).
    const link = `${card} [data-local-path="${files.log}"]`
    await page.waitForSelector(link, { timeout: 10_000 })
    await page.click(link)
    await page.waitForFunction(() => [...document.querySelectorAll("[data-drawer-layer] pre.hljs")].some((pre) => pre.textContent?.includes("booting server")), { timeout: 10_000 })
    const read = reads.find((r) => r.path === files.log)
    check("a log cited on the card opens in the reader, read through the tenant's gate", read?.route === `/_frizz/${tenant.id}/rpc/localFile`, JSON.stringify(read))
    const error = await page.$$eval("[data-drawer-layer]", (layers) => layers.map((l) => l.textContent ?? "").find((t) => t.includes("Couldn’t read")) ?? "")
    check("the reader shows the file, not a gate refusal", error === "", error.slice(0, 120))
    await settle("real-card-reader.png")
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !document.querySelector("[data-drawer-layer]:not([data-closing])") || ![...document.querySelectorAll("[data-drawer-layer] pre.hljs")].some((pre) => pre.textContent?.includes("booting server")), { timeout: 5_000 })
    await sleep(400)
  })

  await step("in the thread's drawer a picture steps through all three, and Escape leaves the drawer", async () => {
    await page.click(`${card} a[href="/all/${tenant.slug}/thread/${seed.slug}"]`)
    const first = `[data-drawer-layer] img[data-local-path="${files.before}"]`
    await page.waitForSelector(first, { timeout: 15_000 })
    await page.waitForFunction((sel) => { const img = document.querySelector(sel); return !!img && img.complete && img.naturalWidth > 0 }, { timeout: 10_000 }, first)
    await page.click(first)
    await page.waitForSelector(viewer, { timeout: 5_000 })
    await pictureShown()
    const opened = await headerText()
    await page.keyboard.press("ArrowRight")
    await page.waitForFunction((sel) => document.querySelector(`${sel} header`)?.textContent?.includes("2 / 3"), { timeout: 5_000 }, viewer)
    await pictureShown()
    check("the drawer's gallery is the thread's three pictures, in order", opened.includes("board-before.png") && opened.includes("1 / 3") && (await headerText()).includes("board-before-crop.png"), JSON.stringify(opened))
    await settle("real-drawer-gallery.png")
    await page.keyboard.press("Escape")
    await page.waitForFunction((sel) => !document.querySelector(sel), { timeout: 5_000 }, viewer)
    await sleep(400)
    check("Escape closes the viewer and leaves the thread's drawer standing", !!(await page.$(first)), await page.evaluate(() => location.pathname))
  })

  await step("a JSON and a TypeScript file open in the reader as source", async () => {
    for (const [file, needle] of [[files.config, "localFileOpener"], [files.source, "fitSize"]]) {
      await page.click(`[data-drawer-layer] [data-local-path="${file}"]`)
      await page.waitForFunction((n) => [...document.querySelectorAll("[data-drawer-layer] pre.hljs")].some((pre) => pre.textContent?.includes(n)), { timeout: 10_000 }, needle)
      if (file === files.source) await settle("real-drawer-reader-ts.png")
      await page.keyboard.press("Escape")
      await sleep(450)
    }
    check("a JSON and a TypeScript file open in the reader as source", true)
  })

  await step("only the PDF asks the desktop opener", async () => {
    await page.click(`[data-drawer-layer] [data-local-path="${files.pdf}"]`)
    await sleep(800)
    check("only the PDF asks the desktop opener", opens.length === 1 && opens[0].path === files.pdf, JSON.stringify(opens))
  })

  check("no console errors, page errors or failed requests", errors.length === 0, errors.slice(0, 5).join(" | "))

  // LAST, because it finishes the thread: with no viewer up, the same D does act on the card.
  await step("control: D marks the card done when no viewer is up", async () => {
    await page.goto(`${origin}/`, { waitUntil: "networkidle2" })
    await page.waitForSelector(`${card}[data-queue-leaving="false"]`, { timeout: 10_000 })
    const before = posts.length
    await page.keyboard.press("d")
    await page.waitForFunction((sel) => !document.querySelector(`${sel}[data-queue-leaving="false"]`), { timeout: 5_000 }, card)
    check("control: D marks the card done when no viewer is up", posts.length > before, JSON.stringify(posts.slice(before)))
  })
} finally {
  await browser.close()
}
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
