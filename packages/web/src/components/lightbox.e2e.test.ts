import assert from "node:assert/strict"
import test from "node:test"
import { crc32, deflateSync } from "node:zlib"

// Runtime coverage for the ```lightbox fence (components/Lightbox.tsx): the gallery's justified rows,
// the viewer's paging and dismissal, and the three things only a browser settles — that an Escape the
// viewer handled never reaches the page (where it would unwind a drawer or leave the fullscreen page),
// that focus comes back to the picture that opened it, and that a phone's Back closes the viewer
// rather than leaving the page. Skipped unless a Vite URL serving the fixtures is provided: start
// `vite` in packages/web and set FRIZZ_LIGHTBOX_E2E_URL to its origin (or run `nub run test:e2e`,
// which does both).
//
// The pictures are drawn HERE. A plain Vite has no /_frizz/local-image route, so the test intercepts it
// and answers with a PNG of the size the fixture's path names; `missing` paths get the real route's 404.
const baseUrl = process.env.FRIZZ_LIGHTBOX_E2E_URL

// A solid-colour RGB PNG of the given size — enough to give the gallery real shapes to lay out.
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body), body.length + 4)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8) // 8-bit, truecolour, deflate, no filter, no interlace
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x++) row.set([60, 90, 140], 1 + x * 3)
  const pixels = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

const DESKTOP = { width: 1000, height: 900, deviceScaleFactor: 1 }
const PHONE = { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true }

async function launch(viewport: typeof DESKTOP | typeof PHONE = DESKTOP) {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
  const page = await browser.newPage()
  await page.setViewport(viewport)
  const errors: string[] = []
  // The deliberately missing picture's 404 is the one expected failure.
  page.on("console", (m) => { if (m.type() === "error" && !/404/.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.setRequestInterception(true)
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.pathname !== "/_frizz/local-image") return void request.continue()
    const path = url.searchParams.get("path") ?? ""
    const size = /-(\d+)x(\d+)\.png$/.exec(path)
    if (!size || path.includes("missing")) return void request.respond({ status: 404, body: "404" })
    void request.respond({ status: 200, contentType: "image/png", body: png(Number(size[1]), Number(size[2])) })
  })
  await page.goto(new URL("/lightbox-fixture.html", baseUrl).href, { waitUntil: "networkidle2" })
  // Every picture settled — decoded, or failed and dropped — and the rows re-justified on real shapes.
  await page.waitForFunction(() =>
    document.querySelectorAll("[data-lightbox-tile] img").length === 7
    && [...document.querySelectorAll<HTMLImageElement>("[data-lightbox-tile] img")].every((img) => img.complete && img.naturalWidth > 0))
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  return { browser, page, errors }
}

type Page = Awaited<ReturnType<typeof launch>>["page"]

const viewer = (page: Page) => page.evaluate(() => {
  const v = document.querySelector("[data-lightbox]")
  if (!v) return null
  return {
    counter: v.querySelector("[data-lightbox-counter]")?.textContent ?? null,
    title: v.querySelector("h2")?.textContent ?? null,
    picture: decodeURIComponent(v.querySelector("img")?.getAttribute("src")?.split("path=")[1] ?? ""),
  }
})

const pageKeys = (page: Page) => page.evaluate(() => window.__pageKeys!.splice(0))

test("a lightbox fence lays its pictures out in justified rows at their real shapes", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    const galleries = await page.$$eval("[data-lightbox-gallery]", (els) => els.map((gallery) => {
      const width = gallery.getBoundingClientRect().width
      return {
        width,
        rows: [...gallery.querySelectorAll("[data-lightbox-row]")].map((row) => ({
          width: row.getBoundingClientRect().width,
          pictures: [...row.querySelectorAll("img")].map((img) => {
            const box = img.getBoundingClientRect()
            return { w: box.width, h: box.height, ratio: img.naturalWidth / img.naturalHeight }
          }),
        })),
        missing: [...gallery.querySelectorAll("[data-lightbox-missing]")].map((el) => el.textContent),
      }
    }))
    assert.equal(galleries.length, 3)
    // The three widths of one page share ONE row, at one height, each at its own shape, edge to edge.
    const [widths] = galleries[1].rows
    assert.equal(galleries[1].rows.length, 1)
    assert.equal(widths.pictures.length, 3)
    for (const picture of widths.pictures) {
      assert.ok(Math.abs(picture.h - widths.pictures[0].h) < 0.5, `heights differ: ${JSON.stringify(widths.pictures)}`)
      assert.ok(Math.abs(picture.w / picture.h - picture.ratio) < 0.02, `a picture was stretched: ${JSON.stringify(picture)}`)
    }
    assert.ok(Math.abs(widths.width - galleries[1].width) < 0.5, "the row spans the frame")
    // The missing file is listed as its path, and only the two real pictures take a place in the rows.
    assert.deepEqual(galleries[2].missing, ["/fixture/lightbox/missing-1440x900.png"])
    assert.equal(galleries[2].rows.flatMap((row) => row.pictures).length, 2)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("the viewer pages with the arrow keys, stops at the ends, and Escape closes it without reaching the page", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    const tiles = await page.$$("[data-lightbox-gallery] [data-lightbox-tile]")
    await tiles[1].click() // "After", the second of the first gallery
    await page.waitForSelector("[data-lightbox]")
    assert.deepEqual(await viewer(page), { counter: "2 / 2", title: "After", picture: "/fixture/lightbox/after-1440x900.png" })
    await page.keyboard.press("ArrowRight")
    assert.equal((await viewer(page))?.counter, "2 / 2", "the last picture is the end, not a wrap")
    await page.keyboard.press("ArrowLeft")
    assert.deepEqual(await viewer(page), { counter: "1 / 2", title: "Before", picture: "/fixture/lightbox/before-1440x900.png" })
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !document.querySelector("[data-lightbox]"))
    assert.deepEqual(await pageKeys(page), [], "a key the viewer handled must not reach the page")
    // Radix hands focus back one task AFTER the dialog unmounts (its focus scope restores on a timeout),
    // so wait for it to land on a tile before asserting which one.
    await page.waitForFunction(() => document.activeElement?.hasAttribute("data-lightbox-tile"), { timeout: 5000 })
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "View After", "focus returns to the opener")
    // The control: with the viewer closed, the same key does reach the page listener.
    await page.keyboard.press("Escape")
    assert.deepEqual(await pageKeys(page), ["Escape"])

    // A gallery with a missing file pages through the pictures that are there.
    const third = await page.$$("[data-fixture-message='2'] [data-lightbox-tile]")
    await third[0].click()
    await page.waitForSelector("[data-lightbox]")
    assert.equal((await viewer(page))?.counter, "1 / 2")
    await page.keyboard.press("End")
    assert.equal((await viewer(page))?.picture, "/fixture/lightbox/last-1440x900.png")
    await page.keyboard.press("Home")
    assert.equal((await viewer(page))?.picture, "/fixture/lightbox/first-1440x900.png")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("a click on the backdrop closes the viewer, and a click on the picture does not", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await (await page.$("[data-fixture-message='1'] [data-lightbox-tile]"))!.click()
    await page.waitForSelector("[data-lightbox] img")
    const picture = (await (await page.$("[data-lightbox] img"))!.boundingBox())!
    await page.mouse.click(picture.x + picture.width / 2, picture.y + picture.height / 2)
    assert.notEqual(await viewer(page), null, "the picture itself is not the backdrop")
    const stage = (await (await page.$("[data-lightbox-stage]"))!.boundingBox())!
    await page.mouse.click(stage.x + 8, stage.y + stage.height - 8)
    await page.waitForFunction(() => !document.querySelector("[data-lightbox]"))
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("on a phone, Back closes the viewer and leaves the page where it was", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { browser, page, errors } = await launch(PHONE)
  try {
    const url = page.url()
    const depth = await page.evaluate(() => history.length)
    await (await page.$("[data-fixture-message='1'] [data-lightbox-tile]"))!.tap()
    await page.waitForSelector("[data-lightbox]")
    // The viewer holds a history entry of its own, so Back pops that rather than the page's.
    assert.equal(await page.evaluate(() => history.length), depth + 1)
    await page.evaluate(() => history.back())
    await page.waitForFunction(() => !document.querySelector("[data-lightbox]"))
    assert.equal(page.url(), url, "Back closed the viewer, not the page")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
