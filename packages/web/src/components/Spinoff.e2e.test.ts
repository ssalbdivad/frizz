import assert from "node:assert/strict"
import test from "node:test"

// Browser coverage for SPINOFFS' own UI (Spinoff.tsx), driven through the real drawer — ThreadView with
// the virtualized transcript — on spinoff-fixture.html. Skipped unless a Vite URL serving the fixtures is
// provided: start `vite` in packages/web and set FRIZZ_SPINOFF_E2E_URL to its origin (or run it through
// `nub run test:e2e`, which does both).
//
// What only a browser settles: that the whole pipeline (not the card alone) hides the `spawn_thread` call
// a spinoff card stands for; that the delivery ledger's raw envelope never reaches the screen; that the
// brief stays folded until asked for and then renders as markdown; and the thread link's click contract —
// a plain click opens the drawer in place, a modified click is left to the browser.
const baseUrl = process.env.FRIZZ_SPINOFF_E2E_URL

async function launch() {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
  const page = await browser.newPage()
  await page.setViewport({ width: 640, height: 1000, deviceScaleFactor: 1 })
  const errors: string[] = []
  // A fixture stubs only the RPCs it draws; a query answered `undefined` (settledQuestions) or a missing
  // asset is fixture noise, not the component's.
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon|Query data cannot be undefined|Outdated Optimize Dep/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  return { browser, page, errors }
}

const fixtureUrl = (query: string) => new URL(`/spinoff-fixture.html${query}`, baseUrl).href

test("the parent draws each request as its card, and never the spawn_thread call behind one", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await page.goto(fixtureUrl("?panel=parent"), { waitUntil: "domcontentloaded" })
    await page.waitForSelector("[data-spinoff-card=request][data-spinoff-state=unstarted]")
    const read = await page.evaluate(() => ({
      cards: [...document.querySelectorAll<HTMLElement>("[data-spinoff-card=request]")].map((c) => ({
        state: c.dataset.spinoffState,
        link: c.querySelector("a")?.textContent ?? null,
        header: c.firstElementChild!.firstElementChild!.textContent,
      })),
      digests: [...document.querySelectorAll("[data-tool-activity] button")].map((b) => b.getAttribute("aria-label")),
      bubbles: [...document.querySelectorAll(".bg-user-bubble")].map((b) => b.textContent),
      text: document.body.innerText,
    }))
    assert.deepEqual(read.cards, [
      { state: "started", link: "@evaluateSubAgentAddresses", header: "Spinoff@evaluateSubAgentAddresses" },
      { state: "started", link: "@auditEveryTranscriptProjectionPath", header: "Spinoff@auditEveryTranscriptProjectionPath" },
      { state: "unstarted", link: null, header: "Spinoffdidn't start" },
    ])
    // The two ordinary runs keep their digests; the two spawn calls add none (a spawn-only message would
    // have drawn `Ran 1 tool call`, and the mid-work one would have been folded into the run after it).
    assert.deepEqual(read.digests, ["Expand 2 tool calls: Ran 2 tool calls", "Expand 2 tool calls: Ran 2 tool calls, edited 1 file"])
    assert.deepEqual(read.bubbles, ["Why do live sub-agents read as not running in the rail?"], "a request is not the human's bubble")
    assert.doesNotMatch(read.text, /spinoff-request|spawn_thread|Do this now/, "neither the envelope nor the brief to the worker reaches the screen")

    // A PLAIN click on the child's handle opens its drawer in place and keeps the page where it is.
    const plain = await page.evaluate(() => {
      let prevented: boolean | null = null
      // On React's own root, registered after React's listener there, so it reads the verdict React left
      // — the link stops propagation, so nothing above the root would see the click at all — and then
      // keeps the page from navigating whatever that verdict was.
      document.getElementById("root")!.addEventListener("click", (e) => { prevented = e.defaultPrevented; e.preventDefault() }, { once: true })
      document.querySelector<HTMLAnchorElement>("[data-spinoff-card=request] a")!.click()
      const drawers = (window as unknown as { __store: { drawers: { kind: string; slug: string }[] } }).__store.drawers
      return { prevented, drawers: drawers.map((d) => `${d.kind}:${d.slug}`), href: location.href }
    })
    assert.equal(plain.prevented, true, "the link took the click")
    assert.deepEqual(plain.drawers, ["thread:evaluate-addresses"])
    assert.match(plain.href, /spinoff-fixture\.html/)

    // A MODIFIED click is the browser's: ⌘-click opens the thread's address in a new tab.
    const modified = await page.evaluate(() => {
      let prevented: boolean | null = null
      // On React's own root, registered after React's listener there, so it reads the verdict React left
      // — the link stops propagation, so nothing above the root would see the click at all — and then
      // keeps the page from navigating whatever that verdict was.
      document.getElementById("root")!.addEventListener("click", (e) => { prevented = e.defaultPrevented; e.preventDefault() }, { once: true })
      const a = document.querySelectorAll<HTMLAnchorElement>("[data-spinoff-card=request] a")[1]!
      a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true, button: 0 }))
      const drawers = (window as unknown as { __store: { drawers: { slug: string }[] } }).__store.drawers
      return { prevented, href: a.getAttribute("href"), opened: drawers.some((d) => d.slug === "audit-projection-paths") }
    })
    assert.deepEqual(modified, { prevented: false, href: "/thread/audit-projection-paths", opened: false })
    assert.deepEqual(errors, [], "no console/page errors")
  } finally {
    await browser.close()
  }
})

test("a request still in the delivery ledger draws as the starting card, not its raw envelope", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await page.goto(fixtureUrl("?panel=busy"), { waitUntil: "domcontentloaded" })
    await page.waitForSelector("[data-spinoff-card=request]")
    const read = await page.evaluate(() => ({
      state: document.querySelector<HTMLElement>("[data-spinoff-card=request]")!.dataset.spinoffState,
      spinner: Boolean(document.querySelector("[data-spinoff-card=request] .animate-spin")),
      body: document.querySelector("[data-spinoff-card=request] p")!.textContent,
      text: document.body.innerText,
    }))
    assert.equal(read.state, "starting")
    assert.equal(read.spinner, true)
    assert.equal(read.body, "Profile the cold-start path while I keep going on the cache.")
    assert.doesNotMatch(read.text, /spinoff-request|<instructions>|Do this now/)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("the child heads itself with the spinoff card, its brief folded until asked for", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await page.goto(fixtureUrl("?panel=child"), { waitUntil: "domcontentloaded" })
    await page.waitForSelector("[data-spinoff-card=origin]")
    const collapsed = await page.evaluate(() => ({
      header: document.querySelector("[data-spinoff-of]")?.textContent,
      card: document.querySelector("[data-spinoff-card=origin]")!.firstElementChild!.firstElementChild!.textContent,
      toggle: document.querySelector("[data-spinoff-context-toggle]")!.textContent,
      expanded: document.querySelector("[data-spinoff-context-toggle]")!.getAttribute("aria-expanded"),
      context: Boolean(document.querySelector("[data-spinoff-context]")),
      bubbles: document.querySelectorAll(".bg-user-bubble").length,
      text: document.body.innerText,
    }))
    assert.equal(collapsed.header, "Spinoff of @subAgentLiveness", "the drawer header names the parent by handle")
    assert.equal(collapsed.card, "Spinoff of@subAgentLiveness")
    assert.equal(collapsed.toggle, "Context from @subAgentLiveness")
    assert.equal(collapsed.expanded, "false")
    assert.equal(collapsed.context, false)
    assert.equal(collapsed.bubbles, 0, "the first turn is not a user bubble")
    assert.doesNotMatch(collapsed.text, /Where this came from|A spinoff of|gathered for you/, "neither the brief nor the prompt's framing shows folded")

    await page.click("[data-spinoff-context-toggle]")
    const open = await page.evaluate(() => ({
      expanded: document.querySelector("[data-spinoff-context-toggle]")!.getAttribute("aria-expanded"),
      headings: [...document.querySelectorAll("[data-spinoff-context] h2")].map((h) => h.textContent),
      code: document.querySelectorAll("[data-spinoff-context] code").length,
    }))
    assert.equal(open.expanded, "true")
    assert.deepEqual(open.headings, ["Where this came from", "What exists today", "The open question"], "the brief renders as markdown")
    assert.ok(open.code > 5, "inline code in the brief is code, not backticks")

    await page.click("[data-spinoff-context-toggle]")
    assert.equal(await page.$("[data-spinoff-context]"), null, "a second click folds it again")

    // The header's parent link is the same link: a plain click opens the parent's drawer.
    const drawers = await page.evaluate(() => {
      document.querySelector<HTMLAnchorElement>("[data-spinoff-card=origin] a")!.click()
      return (window as unknown as { __store: { drawers: { kind: string; slug: string }[] } }).__store.drawers.map((d) => `${d.kind}:${d.slug}`)
    })
    assert.deepEqual(drawers, ["thread:sub-agent-liveness"])
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("a spinoff child's queue card names its parent in the card's own project", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await page.goto(fixtureUrl("?panel=queue"), { waitUntil: "domcontentloaded" })
    await page.waitForSelector("[data-xq-card-root] [data-spinoff-of]")
    const read = await page.evaluate(() => [...document.querySelectorAll("[data-xq-card-root] [data-spinoff-of] a")].map((a) => ({ text: a.textContent, href: a.getAttribute("href") })))
    assert.deepEqual(read, [
      { text: "@subAgentLiveness", href: "/all/frizz/thread/sub-agent-liveness" },
      { text: "@subAgentLiveness", href: "/all/frizz/thread/sub-agent-liveness" },
    ])
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
