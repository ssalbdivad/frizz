import assert from "node:assert/strict"
import test from "node:test"

// Runtime coverage for "focusing the free-text box unselects the chosen option" on a REGISTERED
// question (maintainer 2026-08-28: "Focusing the free text option is supposed to unselect the other
// options"). The card's onFocus hands the producer its unchanged text and relies on THAT clearing the
// pick; this producer wrote only the draft and left the chip lit beside a focused box. Skipped unless a
// Vite URL serving the fixtures is provided (same pattern as the other *.e2e.test.ts here): start
// `vite` in packages/web and set FRIZZ_REGISTERED_QUESTION_FOCUS_E2E_URL to its origin.
const baseUrl = process.env.FRIZZ_REGISTERED_QUESTION_FOCUS_E2E_URL

type Page = import("puppeteer").Page

async function launch() {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
  const page = await browser.newPage()
  await page.setViewport({ width: 900, height: 1200, deviceScaleFactor: 2 })
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  return { browser, page, errors }
}

// A real mouse click at the centre of the i-th element `selector` matches. A chip's hit area is a
// stretched button whose mousedown is prevented, so only a pointer click exercises the focus dance the
// bug lives in — `el.click()` would skip it.
async function mouseClick(page: Page, selector: string, i = 0) {
  const box = await page.$$eval(selector, (ns, i) => {
    const r = ns[i as number]!.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }, i)
  await page.mouse.click(box.x, box.y)
}

// Which option rows of the card wear the selection border, by index.
// `border-selection-border` since 457ad8eb (2026-09-19, the neutral palette); this read `border-accent`
// until 2026-09-28 and so failed on every surface — QuestionBlockCard paints the selected row.
const selectedRows = (page: Page, card: string) =>
  page.$$eval(`${card} [data-question-option]`, (ns) => ns.flatMap((n, i) => (n.classList.contains("border-selection-border") ? [i] : [])))
const boxFocused = (page: Page, card: string) =>
  page.$eval(`${card} textarea[data-surface='questionAnswer']`, (ta) => document.activeElement === ta)

test("focusing the free-text box unselects a registered question's chosen option; a multi keeps its set", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await page.goto(`${baseUrl}/registered-question-fixture.html?many=1`, { waitUntil: "networkidle0" })
    const single = "[data-question-id='qst_0001aaaa']"
    const multi = "[data-question-id='qst_0004dddd']"
    await page.waitForSelector(`${single} [data-question-option]`)
    await page.waitForSelector(`${multi} [data-question-option]`)

    // ── EVERY pixel of a row reads as clickable, because every pixel picks the option ──
    // Sampled by hit test rather than by reading the rule, because the hit test IS the failure: an
    // option's markdown body wears `opacity-90`, which paints it in the positioned layer above the
    // stretched button, so the row showed a pointer on its label line and a plain arrow over every line
    // below it (maintainer 2026-09-03). `?many=1`'s first card is the one with multi-line bodies and a
    // code fence, so the sweep crosses prose, a `pre` and the recommended badge, not just a label.
    const nonPointer = await page.$$eval(`${single} [data-question-option]`, (rows) => {
      const bad: string[] = []
      for (const row of rows) {
        const r = row.getBoundingClientRect()
        for (let y = r.top + 4; y < r.bottom - 2; y += 6) {
          for (const fx of [0.06, 0.3, 0.6, 0.95]) {
            const el = document.elementFromPoint(r.left + r.width * fx, y)
            if (el && getComputedStyle(el).cursor !== "pointer") bad.push(`${el.tagName.toLowerCase()}@${Math.round(y - r.top)}`)
          }
        }
      }
      return bad
    })
    assert.deepEqual(nonPointer, [], "every pixel of a live option row reads as clickable")

    // ── SINGLE: pick B, then click into the box — B must let go ──
    await mouseClick(page, `${single} [data-question-option]`, 1)
    assert.deepEqual(await selectedRows(page, single), [1])
    await mouseClick(page, `${single} textarea[data-surface='questionAnswer']`)
    assert.equal(await boxFocused(page, single), true)
    assert.deepEqual(await selectedRows(page, single), [])
    // Climbing back out without typing does not resurrect the pick.
    await page.keyboard.press("Escape")
    assert.equal(await boxFocused(page, single), false)
    assert.deepEqual(await selectedRows(page, single), [])
    // A chip click still takes over from a typed answer — but it LEAVES the text. This assertion read
    // the other way until `4a6b5b49` (2026-09-02) deliberately reversed it: the typed draft stays in the
    // box as an unselected draft, and registeredAnswer submits the chip beside it. That commit did not
    // update this test, so it pinned the retired behaviour until 2026-09-03.
    await mouseClick(page, `${single} textarea[data-surface='questionAnswer']`)
    await page.keyboard.type("neither")
    assert.deepEqual(await selectedRows(page, single), [])
    await mouseClick(page, `${single} [data-question-option]`, 0)
    assert.deepEqual(await selectedRows(page, single), [0])
    assert.equal(await page.$eval(`${single} textarea[data-surface='questionAnswer']`, (ta) => (ta as HTMLTextAreaElement).value), "neither")

    // ── MULTI: the note box only adds colour, so the toggled set survives its focus ──
    await mouseClick(page, `${multi} [data-question-option]`, 0)
    await mouseClick(page, `${multi} [data-question-option]`, 2)
    assert.deepEqual(await selectedRows(page, multi), [0, 2])
    await mouseClick(page, `${multi} textarea[data-surface='questionAnswer']`)
    assert.equal(await boxFocused(page, multi), true)
    assert.deepEqual(await selectedRows(page, multi), [0, 2])

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// Enter inside one card of a batch moves to the next UNANSWERED card instead of sending the batch
// (maintainer 2026-09-29: one of seven answered, Enter pressed, all seven sent). Only once nothing is
// left unanswered does Enter send.
test("Enter in one registered question advances to the next unanswered one, and sends only when none is left", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await page.goto(`${baseUrl}/registered-question-fixture.html?many=1`, { waitUntil: "networkidle0" })
    await page.waitForSelector("[data-answerable-question]")
    await page.evaluate(() => {
      const w = window as unknown as { sends: number; answered: number }
      w.sends = 0
      window.addEventListener("fixture-rpc", (e) => {
        const { rpc, body } = (e as CustomEvent).detail
        if (rpc !== "answerQuestions") return
        w.sends += 1
        w.answered = body.answers.length
      })
    })
    const sends = () => page.evaluate(() => (window as unknown as { sends: number }).sends)
    const boxes = "textarea[data-surface='questionAnswer']"
    const focusedIdx = () => page.$$eval(boxes, (ns) => ns.indexOf(document.activeElement as HTMLTextAreaElement))
    const cards = await page.$$eval(boxes, (ns) => ns.length)
    assert.ok(cards >= 3, "the fixture renders several cards")

    // Answer the FIRST card only and press Enter: nothing is sent, and the caret lands on the second.
    await mouseClick(page, boxes, 0)
    await page.keyboard.type("first")
    await page.keyboard.press("Enter")
    assert.equal(await sends(), 0, "Enter with unanswered cards left does not send")
    assert.equal(await focusedIdx(), 1)

    // Enter on an EMPTY card skips it too — on to the next unanswered one, never back to itself.
    await page.keyboard.press("Enter")
    assert.equal(await sends(), 0)
    assert.equal(await focusedIdx(), 2)

    // Answer every card left by typing; the last Enter is the one that sends.
    for (let i = 0; i < 20 && (await sends()) === 0; i++) {
      assert.ok(await focusedIdx() >= 0, "the caret always lands in a card while any is unanswered")
      await page.keyboard.type("x")
      await page.keyboard.press("Enter")
      await new Promise((r) => setTimeout(r, 50))
    }
    assert.equal(await sends(), 1)
    assert.equal(await page.evaluate(() => (window as unknown as { answered: number }).answered), cards, "the one send carried every card's answer")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
