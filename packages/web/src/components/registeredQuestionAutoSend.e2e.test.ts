import assert from "node:assert/strict"
import test from "node:test"

// Runtime coverage for "a pick is an answer, and a reply carries it" on a REGISTERED question (maintainer
// 2026-09-29: "i selected an answer then typed some additional info then hit answer, but it seems like
// only send answers actually works"). Before this, a chip only STAGED: the reply box sent the reply alone,
// replying past the question and dropping the pick. Now (RegisteredQuestionCards useRegisteredAnswering):
//   · a single-choice pick that leaves every owed question answered sends at once;
//   · a reply sent with answers staged sends the answers FIRST, then the reply;
//   · a pick made while the reply box holds a draft waits for that reply's Enter.
// Skipped unless a Vite URL serving the fixtures is provided (same pattern as the other *.e2e.test.ts
// here): start `vite` in packages/web and set FRIZZ_REGISTERED_QUESTION_AUTOSEND_E2E_URL to its origin.
const baseUrl = process.env.FRIZZ_REGISTERED_QUESTION_AUTOSEND_E2E_URL

type Page = import("puppeteer").Page

async function launch(query: string) {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
  const page = await browser.newPage()
  await page.setViewport({ width: 900, height: 1400, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.goto(`${baseUrl}/registered-question-fixture.html${query}`, { waitUntil: "networkidle0" })
  await page.waitForSelector("[data-question-option]")
  // The two SENDS this is about, in the order they went out — the fixture's fetch stub logs every RPC,
  // since a stubbed fetch never reaches the network where puppeteer could see it; reads are dropped.
  const rpcs = async () =>
    (await page.evaluate(() => (window as unknown as { __rpcs?: string[] }).__rpcs ?? [])).filter((r) => r === "answerQuestions" || r === "followUp")
  return { browser, page, errors, rpcs }
}

// A real pointer click: a chip's mousedown is prevented, so `el.click()` would skip the path the card uses.
async function mouseClick(page: Page, selector: string, i = 0) {
  const box = await page.$$eval(selector, (ns, i) => {
    const r = ns[i as number]!.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }, i)
  await page.mouse.click(box.x, box.y)
}

const settle = (page: Page) => page.evaluate(() => new Promise((r) => setTimeout(r, 300)))
const reply = "textarea[data-surface='queueComposer']"

test("a single-choice pick that completes the ask sends it", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors, rpcs } = await launch("")
  try {
    await mouseClick(page, "[data-question-id='qst_0001aaaa'] [data-question-option]", 0)
    await settle(page)
    assert.deepEqual((await rpcs()).filter((r) => r === "answerQuestions"), ["answerQuestions"], "the pick sent the answer")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("a pick with other questions still owed stages; the reply sends the answers, then itself", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors, rpcs } = await launch("?many=1")
  try {
    await mouseClick(page, "[data-question-id='qst_0001aaaa'] [data-question-option]", 0)
    await settle(page)
    assert.equal((await rpcs()).includes("answerQuestions"), false, "two questions are still owed, so nothing sent")
    assert.equal(await page.$eval(reply, (ta) => (ta as HTMLTextAreaElement).placeholder), "Add a note to your answers…")

    const body = new Promise<{ answers: { questionId: string; chosen: string[] }[] }>((resolve) => {
      void page.exposeFunction("__answered", resolve).then(() =>
        page.evaluate(() => window.addEventListener("fixture-rpc", (e) => (window as unknown as { __answered: (b: unknown) => void }).__answered((e as CustomEvent).detail.body))))
    })
    await page.focus(reply)
    await page.keyboard.type("SQLite, but keep the JSON export")
    await page.keyboard.press("Enter")
    await settle(page)
    const sent = await body
    assert.deepEqual(sent.answers.map((a) => [a.questionId, a.chosen]), [["qst_0001aaaa", ["SQLite"]]])
    assert.deepEqual(await rpcs(), ["answerQuestions", "followUp"], "the staged answer first, then the reply")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("a pick made while the reply box holds a draft waits for the reply's Enter", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, rpcs } = await launch("")
  try {
    await page.focus(reply)
    await page.keyboard.type("one more thing")
    await mouseClick(page, "[data-question-id='qst_0001aaaa'] [data-question-option]", 1)
    await settle(page)
    assert.equal((await rpcs()).includes("answerQuestions"), false, "a draft in the reply box holds the auto-send")
    await page.focus(reply)
    await page.keyboard.press("Enter")
    await settle(page)
    assert.deepEqual(await rpcs(), ["answerQuestions", "followUp"], "the answer first, then the reply")
  } finally {
    await browser.close()
  }
})
