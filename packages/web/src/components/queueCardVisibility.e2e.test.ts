import assert from "node:assert/strict"
import test, { after, before } from "node:test"

// A LONG QUEUE BUILDS AND LAYS OUT ONLY THE CARDS NEAR THE SCREEN (lib/cardVisibility.ts), against the
// real AllQueuesCard on queue-card-states-fixture.html?case=many — 60 cards, every third one long enough to
// clamp, only the network stubbed. What it pins:
//
//   1  before anything is idle, the cards on screen are built and drawn unclipped (`data-near`, so no
//      paint containment), and the cards far below are stand-ins — what took a 244-card load from one 7s
//      task to ~1.3s (2026-10-02);
//   2  left alone, every card gets built, and every far card is SKIPPED at exactly the height it really
//      has — a skipped card sized by a stale guess is a jump waiting for the reader to scroll to it;
//   3  a far card's clamp is measured once it is drawn, not at mount, and still clamps ("Show more");
//   4  a board delta re-renders NO card: every card's reply box and model strip used to read the board's
//      threads, so each delta re-rendered every card on the page;
//   5  typing `@` into a card's reply box still offers the board's threads — the box subscribes to them only
//      once its draft holds an `@`, so this pins that the switch turns on.
//
// Skipped unless a Vite URL serving the fixtures is provided: `nub run test:e2e` sets it, or start
// `vite` in packages/web and set FRIZZ_QUEUE_CARD_VISIBILITY_E2E_URL to its origin.
const baseUrl = process.env.FRIZZ_QUEUE_CARD_VISIBILITY_E2E_URL

type PuppeteerModule = typeof import("puppeteer")
type Browser = Awaited<ReturnType<PuppeteerModule["launch"]>>
type Page = Awaited<ReturnType<Browser["newPage"]>>

let browser: Browser | undefined
let page: Page | undefined
const errors: string[] = []
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const URL_MANY = () => `${baseUrl}/queue-card-states-fixture.html?case=many&n=60`

before(async () => {
  if (!baseUrl) return
  const { default: puppeteer } = await import("puppeteer")
  browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
  page = await browser.newPage()
  page.setDefaultTimeout(60_000)
  await page.setViewport({ width: 900, height: 1000, deviceScaleFactor: 1 })
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  // WARM A COLD VITE before any timed step (its first load optimizes dependencies and reloads the page).
  await page.goto(URL_MANY(), { waitUntil: "networkidle0", timeout: 120_000 })
  await page.waitForSelector("[data-xq-card]", { timeout: 120_000 })
})

after(async () => { await browser?.close() })

const allBuilt = () => page!.waitForFunction(() => document.querySelectorAll("[data-xq-card]").length === 60 && !document.querySelector("[data-xq-card-stand-in]"), { timeout: 60_000 })
// SETTLED: every card built, and for a second and a half no card has committed and no slot has been drawn
// or let go (a `data-near` flip) — the idle steps re-draw a skipped card whose handoff landed after it was
// first drawn, and those run after the builds. A condition the page reaches by design, not a retry.
async function settled(): Promise<void> {
  await allBuilt()
  await page!.evaluate(() => {
    const w = window as unknown as { __flips?: number }
    w.__flips = 0
    new MutationObserver((records) => { w.__flips! += records.length }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-near"] })
  })
  await page!.waitForFunction(() => {
    const w = window as unknown as { __renders: Record<string, number>; __flips: number; __quiet?: { sig: string; at: number } }
    const sig = `${Object.values(w.__renders).reduce((a, b) => a + b, 0)}/${w.__flips}`
    if (!w.__quiet || w.__quiet.sig !== sig) w.__quiet = { sig, at: performance.now() }
    return performance.now() - w.__quiet.at > 1_500
  }, { polling: 100, timeout: 60_000 })
}

test("before the page is idle, only the cards near the screen are built, and those are drawn unclipped", { skip: !baseUrl, timeout: 120_000 }, async () => {
  // Read in the page on the first frame the cards exist: idle steps build the rest soon after.
  await page!.evaluateOnNewDocument(() => {
    const w = window as unknown as { __firstFrame?: unknown }
    const look = () => {
      const slots = [...document.querySelectorAll<HTMLElement>("[data-xq-card]")]
      if (slots.length === 0) return requestAnimationFrame(look)
      const onScreen = slots.filter((slot) => { const r = slot.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight })
      w.__firstFrame = {
        slots: slots.length,
        standIns: slots.filter((slot) => slot.querySelector("[data-xq-card-stand-in]")).length,
        onScreen: onScreen.length,
        onScreenBuilt: onScreen.filter((slot) => slot.querySelector("[data-xq-card-root]")).length,
        onScreenNear: onScreen.filter((slot) => slot.hasAttribute("data-near")).length,
        onScreenContentVisibility: [...new Set(onScreen.map((slot) => getComputedStyle(slot).contentVisibility))],
        lastContentVisibility: getComputedStyle(slots.at(-1)!).contentVisibility,
      }
    }
    requestAnimationFrame(look)
  })
  await page!.goto(URL_MANY(), { waitUntil: "load" })
  await page!.waitForFunction(() => (window as unknown as { __firstFrame?: unknown }).__firstFrame !== undefined)
  const first = await page!.evaluate(() => (window as unknown as { __firstFrame: Record<string, unknown> }).__firstFrame)
  assert.equal(first.slots, 60)
  assert.ok((first.onScreen as number) > 0)
  assert.equal(first.onScreenBuilt, first.onScreen, `every card on screen is built at the first frame: ${JSON.stringify(first)}`)
  assert.equal(first.onScreenNear, first.onScreen, `and near, so nothing it draws is clipped: ${JSON.stringify(first)}`)
  assert.deepEqual(first.onScreenContentVisibility, ["visible"])
  assert.ok((first.standIns as number) >= 40, `the cards far below are stand-ins, not built: ${JSON.stringify(first)}`)
  assert.equal(first.lastContentVisibility, "auto")
})

test("left alone, every card is built, and every skipped card is the height it really has", { skip: !baseUrl, timeout: 120_000 }, async () => {
  await page!.goto(URL_MANY(), { waitUntil: "load" })
  await settled()
  const heights = await page!.evaluate(() => {
    const out: { index: number; skipped: number; real: number }[] = []
    const slots = [...document.querySelectorAll<HTMLElement>("[data-xq-card]")]
    let far = 0
    let distant = 0
    let distantRendered = 0
    for (const [index, slot] of slots.entries()) {
      if (slot.hasAttribute("data-near")) continue
      far++
      // Skipped by the browser, not merely unmarked: its content is not rendered. Asked only of a card three
      // viewports down, past the browser's own margin for drawing `auto` content early.
      if (slot.getBoundingClientRect().top > 3 * innerHeight) {
        distant++
        if (slot.firstElementChild!.checkVisibility({ contentVisibilityAuto: true })) distantRendered++
      }
      const skipped = slot.getBoundingClientRect().height
      slot.setAttribute("data-near", "")
      const real = slot.getBoundingClientRect().height
      slot.removeAttribute("data-near")
      if (Math.abs(real - skipped) > 1) out.push({ index, skipped, real })
    }
    return { far, distant, distantRendered, off: out }
  })
  assert.ok(heights.far >= 40, `most cards are far: ${heights.far}`)
  assert.ok(heights.distant >= 40, `most are well past the screen: ${heights.distant}`)
  assert.equal(heights.distantRendered, 0, "a card three viewports down that the browser still renders")
  assert.deepEqual(heights.off, [], "a skipped card sized by anything but its real height")
})

test("a far card's clamp is measured once it is drawn, and it still clamps", { skip: !baseUrl, timeout: 120_000 }, async () => {
  await page!.goto(URL_MANY(), { waitUntil: "load" })
  await settled()
  const longCards = await page!.evaluate(() => {
    const slots = [...document.querySelectorAll<HTMLElement>("[data-xq-card]")]
    // Every third card carries the long handoff (the fixture's `many` case); check the far ones.
    return slots.filter((_, index) => index % 3 === 0).slice(5).map((slot) => ({
      key: slot.dataset.xqCard,
      showMore: Boolean(slot.querySelector("[data-xq-show-more]")),
      near: slot.hasAttribute("data-near"),
    }))
  })
  assert.ok(longCards.length >= 10)
  assert.ok(longCards.some((card) => !card.near), "some of them are far (skipped)")
  assert.deepEqual(longCards.filter((card) => !card.showMore), [], "a long handoff with no Show more")
})

test("a board delta re-renders no card", { skip: !baseUrl, timeout: 120_000 }, async () => {
  await page!.goto(URL_MANY(), { waitUntil: "load" })
  await settled()
  const before = await page!.evaluate(() => ({ ...(window as unknown as { __renders: Record<string, number> }).__renders }))
  await page!.evaluate(() => {
    const w = window as unknown as { __boardDelta: () => void }
    w.__boardDelta()
    w.__boardDelta()
    w.__boardDelta()
  })
  await sleep(1_000)
  const after = await page!.evaluate(() => ({ ...(window as unknown as { __renders: Record<string, number> }).__renders }))
  const rerendered = Object.keys(after).filter((key) => after[key] !== before[key])
  assert.deepEqual(rerendered, [], `${rerendered.length} cards re-rendered on three board deltas`)
})

test("typing @ in a card's reply box offers the board's threads", { skip: !baseUrl, timeout: 120_000 }, async () => {
  await page!.goto(URL_MANY(), { waitUntil: "load" })
  const box = '[data-xq-card="fixture-card/card-1"] textarea'
  await page!.waitForSelector(box)
  await page!.click(box)
  assert.equal(await page!.$("[data-mention-menu]"), null, "no menu before the `@`")
  await page!.keyboard.type("@card-")
  await page!.waitForSelector("[data-mention-menu]", { timeout: 10_000 })
  const offered = await page!.$$eval("[data-mention-menu] [role=option]", (options) => options.map((o) => o.textContent ?? ""))
  assert.ok(offered.some((text) => text.includes("card-2")), `the menu offers the board's threads: ${JSON.stringify(offered.slice(0, 5))}`)
  assert.deepEqual(errors, [])
})
