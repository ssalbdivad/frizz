import assert from "node:assert/strict"
import test, { after, before } from "node:test"
import { SCHEDULE_GRAMMAR_VERSION } from "@frizz/shared"

// THE LIVE SCHEDULE READING in the real prompt box (plans/schedule-live-reading.md §15.2): the box reads its
// own words for WHEN as they are typed, offers a schedule under a dotted underline and a ledge, and only an
// explicit act (Tab, the glyph, ⌘⌥↵) turns the box into SCHEDULE MODE, where Enter creates instead of
// starting a thread. The unit tests pin each piece (the grammar, the publish policy, the key matrix); this
// file pins what only a browser can: that the pieces, mounted together in <DispatchForm>, put the right
// thing on the wire for each key — and never the other thing.
//
// Drives schedule-live-fixture (the real DispatchForm, the `c` dialog and the Toaster over a stubbed RPC
// seam that COUNTS dispatch, createLazyThread, createSchedule, deleteSchedule and interpretSchedule, at a
// fixed clock: Mon Oct 5 2026, 2:32pm New York). Every assertion about a key is a count on that seam.
//
// Skipped unless a Vite URL serving the fixtures is provided: start `vite` in packages/web and set
// FRIZZ_SCHEDULE_E2E_URL to its origin (scripts/e2e-web.mjs does both).
const baseUrl = process.env.FRIZZ_SCHEDULE_E2E_URL

const NY = "America/New_York"
const PAGE_BOX = `[data-dispatch-form]:not([role="dialog"] [data-dispatch-form])`
const DIALOG_BOX = `[role="dialog"] [data-dispatch-form]`
const ta = (box: string) => `${box} textarea[data-surface="newComposer"]`
const PHRASE_TASK = "every Monday at 9am triage new issues"

type PuppeteerModule = typeof import("puppeteer")
type Browser = Awaited<ReturnType<PuppeteerModule["launch"]>>
type Page = Awaited<ReturnType<Browser["newPage"]>>
type Counts = Record<"dispatch" | "createLazyThread" | "createSchedule" | "deleteSchedule" | "interpretSchedule", number>
type ModelAnswer = { phrase: string; rrule: string; dtstart: string; condition?: string; title: string; delayMs?: number }

let browser: Browser | undefined

before(async () => {
  if (!baseUrl) return
  const { default: puppeteer } = await import("puppeteer")
  browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb", "--use-mock-keychain"] })
})

after(async () => { await browser?.close() })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A fresh tab (so a fresh sessionStorage: drafts start empty), the box mounted and its profile known. */
async function open(opts: { reducedMotion?: boolean } = {}) {
  const page = await browser!.newPage()
  page.setDefaultTimeout(30_000)
  await page.emulateTimezone(NY)
  await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: 1 })
  await page.emulateMediaFeatures([
    { name: "prefers-color-scheme", value: "dark" },
    ...(opts.reducedMotion ? [{ name: "prefers-reduced-motion", value: "reduce" }] : []),
  ])
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon|Failed to load resource/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.evaluateOnNewDocument(INSTRUMENT)
  await page.goto(`${baseUrl}/schedule-live-fixture.html`, { waitUntil: "networkidle0" })
  await ready(page)
  return { page, errors }
}

async function ready(page: Page, box = PAGE_BOX) {
  await page.waitForSelector(ta(box))
  await page.waitForSelector(`${box} button[aria-label="Model and effort"][data-profile-known="true"]`)
  await focusEnd(page, box)
}

// A rAF loop that records every change of the page box's slot (open, ledge/panel, its line) with
// performance.now(), and a capture-phase listener for each key: "the ledge appeared 812ms after the last
// key" is then a measurement, not a sleep.
const INSTRUMENT = () => {
  const w = window as unknown as { __live: { keys: number[]; slots: { t: number; open: boolean; form: string | null }[] } }
  w.__live = { keys: [], slots: [] }
  document.addEventListener("keydown", () => w.__live.keys.push(performance.now()), true)
  let last = ""
  const tick = () => {
    const form = document.querySelector('[data-dispatch-form]:not([role="dialog"] [data-dispatch-form])')
    const open = form?.querySelector("[data-schedule-slot-wrap]")?.hasAttribute("data-open") ?? false
    const formName = form?.querySelector("[data-schedule-slot]")?.getAttribute("data-schedule-slot") ?? null
    const key = `${open}|${formName}`
    if (key !== last) {
      w.__live.slots.push({ t: performance.now(), open, form: formName })
      last = key
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

const counts = (page: Page): Promise<Counts> => page.evaluate(() => ({ ...window.__sched.counts }))
const bodies = (page: Page, name: keyof Counts): Promise<Record<string, unknown>[]> =>
  page.evaluate((n) => window.__sched.bodies[n].map((b) => ({ ...b })), name)
const armModel = (page: Page, answer: ModelAnswer | null) => page.evaluate((a) => { window.__sched.answer = a }, answer)
const resetLive = (page: Page) => page.evaluate(() => {
  const l = (window as unknown as { __live: { keys: number[]; slots: unknown[] } }).__live
  l.keys = []
  l.slots = []
})
const live = (page: Page) => page.evaluate(() => (window as unknown as { __live: { keys: number[]; slots: { t: number; open: boolean; form: string | null }[] } }).__live)

/** What the box shows, read the way the eye reads it. */
const state = (page: Page, box = PAGE_BOX) => page.evaluate((sel) => {
  const form = document.querySelector(sel)
  if (!form) return null
  const q = <T extends Element = HTMLElement>(s: string) => form.querySelector<T>(s)
  const text = (s: string) => {
    const el = q(s)
    return el ? (el as HTMLElement).innerText.replace(/\s+/g, " ").trim() : null
  }
  const open = q("[data-schedule-slot-wrap]")?.hasAttribute("data-open") ?? false
  const send = q<HTMLButtonElement>("[data-composer-send]")
  const lazy = q<HTMLButtonElement>("[data-composer-lazy]")
  const glyph = q<HTMLButtonElement>("[data-composer-schedule]")
  const create = q<HTMLButtonElement>("[data-schedule-create]")
  const area = q<HTMLTextAreaElement>('textarea[data-surface="newComposer"]')
  const toast = document.querySelector<HTMLElement>("[data-toast]")
  return {
    text: area?.value ?? null,
    focused: document.activeElement === area,
    open,
    slot: open ? (q("[data-schedule-slot]")?.getAttribute("data-schedule-slot") ?? null) : null,
    // The ledge's reading row is clipped to one line and a segment that does not fit wraps below the clip,
    // so only the children on its first line are on screen.
    ledge: open ? (() => {
      const row = q("[data-schedule-ledge-reading]")
      if (!row) return null
      const bottom = row.getBoundingClientRect().bottom - 1
      return [...row.children].filter((c) => c.getBoundingClientRect().top < bottom).map((c) => (c as HTMLElement).innerText).join("").replace(/\s+/g, " ").trim()
    })() : null,
    line: open ? text("[data-schedule-line]") : null,
    accept: !!q("[data-schedule-accept]"),
    startNow: !!q("[data-schedule-start-now]"),
    dismiss: !!q("[data-schedule-dismiss]"),
    echo: text("[data-schedule-echo]"),
    next: text("[data-schedule-next]"),
    each: text("[data-schedule-each]"),
    refusal: text("[data-schedule-refusal]"),
    copy: text("[data-schedule-copy]"),
    notice: text("[data-schedule-notice]"),
    reading: text("[data-schedule-reading]"),
    disagree: text("[data-schedule-disagree]"),
    create: create ? { disabled: create.disabled, title: create.title } : null,
    send: send?.getAttribute("data-composer-send") ?? null,
    sendTitle: send?.title ?? null,
    lazyDisabled: lazy?.disabled ?? null,
    glyph: glyph?.getAttribute("data-composer-schedule") ?? null,
    marks: [...form.querySelectorAll("[data-composer-mark]")].map((m) => ({ tone: m.getAttribute("data-composer-mark"), text: m.textContent })),
    toast: toast ? { text: toast.innerText.replace(/\s+/g, " ").trim(), actions: [...toast.querySelectorAll("[data-toast-action]")].map((a) => a.getAttribute("data-toast-action")) } : null,
  }
}, box)
type State = NonNullable<Awaited<ReturnType<typeof state>>>
const marksOf = (s: State | null, tone: string) => (s?.marks ?? []).filter((m) => m.tone === tone).map((m) => m.text).join("")

async function focusEnd(page: Page, box = PAGE_BOX) {
  await page.evaluate((s) => {
    const area = document.querySelector<HTMLTextAreaElement>(s)!
    area.focus()
    area.setSelectionRange(area.value.length, area.value.length)
  }, ta(box))
}
async function clearBox(page: Page) {
  await focusEnd(page)
  await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control")
  await page.keyboard.press("Backspace")
  await sleep(500)
}
async function typeFast(page: Page, text: string, delay = 25) {
  for (const ch of text) {
    await page.keyboard.type(ch)
    await sleep(delay)
  }
}
/** Select `word` in the page box and type `by` over it, one key at a time. */
async function replace(page: Page, word: string, by: string) {
  await page.evaluate((sel, w) => {
    const area = document.querySelector<HTMLTextAreaElement>(sel)!
    const i = area.value.indexOf(w)
    area.focus()
    area.setSelectionRange(i, i + w.length)
  }, ta(PAGE_BOX), word)
  await typeFast(page, by, 60)
}
const chord = async (page: Page, mods: string[], key: string) => {
  for (const m of mods) await page.keyboard.down(m)
  await page.keyboard.press(key)
  for (const m of [...mods].reverse()) await page.keyboard.up(m)
}
const waitFor = async (pred: () => Promise<boolean>, ms: number, step = 50) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await pred()) return true
    await sleep(step)
  }
  return false
}
/** Type a phrase-and-task and wait for its offer at the open edge. */
async function offer(page: Page, text = PHRASE_TASK) {
  await typeFast(page, text)
  assert.ok(await waitFor(async () => (await state(page))?.slot === "ledge", 3_000), `an offer for ${JSON.stringify(text)}`)
}
/** Offer, then Tab into the mode with its panel up. */
async function accept(page: Page, text = PHRASE_TASK) {
  await offer(page, text)
  await focusEnd(page)
  await page.keyboard.press("Tab")
  assert.ok(await waitFor(async () => (await state(page))?.slot === "panel", 3_000), "Tab opens the panel")
}

const LEDGE_FULL = "Every Monday at 9am · next Mon Oct 12, in 6d"

test("1. recognition: nothing until the space after Monday, nothing mid-word, the underline under the phrase, no model call", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { page, errors } = await open()
  try {
    const timeline: { typed: string; open: boolean; ledge: string | null; offer: string }[] = []
    for (const ch of PHRASE_TASK) {
      await page.keyboard.type(ch)
      const s = await state(page)
      timeline.push({ typed: s!.text!, open: s!.open, ledge: s!.ledge, offer: marksOf(s, "offer") })
      await sleep(90)
    }
    const at = (typed: string) => timeline.find((t) => t.typed === typed)
    const first = timeline.findIndex((t) => t.open)
    assert.equal(timeline[first]?.typed, "every Monday ", "the first ledge comes with the space after Monday")
    assert.equal(at("every Monday")?.open, false)
    assert.equal(at("every Monday ")?.offer, "every Monday", "the underline is drawn under the words it read")
    const moved = timeline
      .map((t, i) => ({ t, prev: timeline[i - 1] }))
      .filter(({ t, prev }) => prev && /[A-Za-z0-9]$/.test(t.typed) && /[A-Za-z0-9]$/.test(prev.typed))
      .filter(({ t, prev }) => t.open !== prev!.open || t.ledge !== prev!.ledge || t.offer !== prev!.offer)
    assert.deepEqual(moved.map(({ t }) => t.typed), [], "no key inside a word changed the ledge or the underline")
    assert.equal(at("every Monday at 9am ")?.offer, "every Monday at 9am", "the underline extends at the space after 9am")

    await sleep(400)
    const s = (await state(page))!
    assert.ok(s.ledge?.startsWith(LEDGE_FULL), `the ledge reads the rule and its next run: ${s.ledge}`)
    assert.ok(s.accept && s.startNow && s.dismiss, "⇥ Schedule, ↵ Start now and × are on the ledge")
    assert.equal(s.send, "send", "the offer never touches the send button")
    assert.equal(s.glyph, "hint")
    // The marks sit in the highlight mirror behind the textarea: their rects ARE where the phrase lies.
    const geometry = await page.evaluate((sel) => {
      const form = document.querySelector(sel)!
      const area = form.querySelector("textarea")!.getBoundingClientRect()
      const layer = form.querySelector("[data-composer-highlight]")
      const rects = [...form.querySelectorAll('[data-composer-mark="offer"]')].flatMap((m) => [...m.getClientRects()])
      return { layer: !!layer, area: { l: area.left, t: area.top, r: area.right, b: area.bottom }, rects: rects.map((r) => ({ l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width })) }
    }, PAGE_BOX)
    assert.ok(geometry.layer, "the marks are drawn in [data-composer-highlight]")
    assert.ok(geometry.rects.length >= 1 && geometry.rects.every((r) => r.w > 20 && r.l >= geometry.area.l && r.r <= geometry.area.r && r.t >= geometry.area.t && r.b <= geometry.area.b), `offer rects inside the box: ${JSON.stringify(geometry)}`)
    assert.equal((await counts(page)).interpretSchedule, 0, "no model call while an offer is merely showing")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("2. Enter with the offer showing starts the thread: dispatch 1, create 0", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open()
  try {
    await offer(page)
    await focusEnd(page)
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => (await counts(page)).dispatch === 1, 3_000))
    await sleep(300)
    const c = await counts(page)
    assert.equal(c.createSchedule, 0)
    assert.equal(c.createLazyThread, 0)
    assert.equal((await bodies(page, "dispatch"))[0]?.prompt, PHRASE_TASK, "the whole text is the thread's prompt")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("3. Tab accepts with no model call, the send glyph swaps, and Enter creates the local reading", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open()
  try {
    await accept(page)
    const s = (await state(page))!
    assert.equal(s.echo, "Triage issues · every Monday at 9am")
    assert.equal(s.next, "Next: Mon Oct 12, in 6d · Mon Oct 19 · Mon Oct 26")
    assert.equal(s.each, "Each run: triage new issues")
    assert.equal(s.create?.disabled, false, "Create is enabled at once")
    assert.equal(s.send, "schedule", "the send button wears Repeat")
    assert.equal(s.sendTitle, "Create schedule (Enter)")
    assert.equal(s.lazyDisabled, true, "the snail is disabled in the mode")
    assert.equal(marksOf(s, "accepted"), "every Monday at 9am")
    assert.equal((await counts(page)).interpretSchedule, 0)

    await focusEnd(page)
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => (await counts(page)).createSchedule === 1, 3_000))
    const body = (await bodies(page, "createSchedule"))[0]!
    assert.equal(body.rrule, "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0")
    assert.equal(body.prompt, "triage new issues")
    assert.equal(body.whenText, "every Monday at 9am")
    assert.deepEqual(body.source, { kind: "local", grammar: SCHEDULE_GRAMMAR_VERSION })
    assert.equal(body.titleAuto, true)
    assert.equal(body.title, "Triage issues")
    assert.equal(body.tz, NY)
    assert.ok(await waitFor(async () => !!(await state(page))?.toast, 3_000), "the toast")
    const after = (await state(page))!
    assert.match(after.toast!.text, /^Triage issues scheduled Every Monday at 9am · next Mon Oct 12, in 6d/)
    assert.deepEqual(after.toast!.actions, ["Undo", "Open"])
    assert.equal(after.text, "", "the box cleared")
    assert.equal(after.send, "send", "and is out of the mode")
    assert.ok(await page.$("[data-sched-flash]"), "the project row's count is told to flash")
    assert.equal((await counts(page)).dispatch, 0, "nothing dispatched")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("4. the incident: the mode survives a remount and a reload, and Enter after either creates, never dispatches", { skip: !baseUrl, timeout: 90_000 }, async () => {
  const { page, errors } = await open()
  try {
    await accept(page)
    await page.evaluate(() => window.__sched.remount())
    await page.waitForFunction((sel) => !document.querySelector(sel), {}, ta(PAGE_BOX)).catch(() => {})
    await ready(page)
    await sleep(300)
    let s = (await state(page))!
    assert.equal(s.glyph, "on", "the remounted box is still in the mode")
    assert.equal(s.send, "schedule")
    assert.equal(s.text, PHRASE_TASK)
    await focusEnd(page)
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => (await counts(page)).createSchedule === 1, 3_000), "Enter after the remount created")
    assert.equal((await counts(page)).dispatch, 0, "and never dispatched")
    await sleep(600)

    await accept(page)
    await page.reload({ waitUntil: "networkidle0" })
    await ready(page)
    await sleep(400)
    s = (await state(page))!
    assert.equal(s.glyph, "on", "the reloaded box is still in the mode")
    assert.equal(s.slot, "panel")
    assert.equal(s.create?.disabled, false)
    await focusEnd(page)
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => (await counts(page)).createSchedule === 1, 3_000), "Enter after the reload created (counts restart with the page)")
    assert.equal((await counts(page)).dispatch, 0, "and never dispatched")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("5. the `c` dialog over the page box shares the mode; its first Esc leaves the mode and keeps the dialog", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open()
  try {
    await offer(page)
    await page.evaluate(() => window.__sched.openDialog())
    await ready(page, DIALOG_BOX)
    await sleep(300)
    let dlg = (await state(page, DIALOG_BOX))!
    assert.equal(dlg.text, PHRASE_TASK, "one draft: the dialog box holds the page box's text")
    await focusEnd(page, DIALOG_BOX)
    await page.keyboard.press("Tab")
    await sleep(400)
    dlg = (await state(page, DIALOG_BOX))!
    const under = (await state(page))!
    assert.equal(dlg.glyph, "on", "the mode on in the dialog")
    assert.equal(under.glyph, "on", "…and in the page box under it")
    assert.equal(under.send, "schedule")
    await page.keyboard.press("Escape")
    await sleep(400)
    assert.ok(await page.$(DIALOG_BOX), "the first Esc keeps the dialog open")
    assert.notEqual((await state(page, DIALOG_BOX))!.glyph, "on", "…and leaves the mode")
    assert.notEqual((await state(page))!.glyph, "on", "…in both boxes")
    await page.keyboard.press("Escape")
    assert.ok(await waitFor(async () => !(await page.$(DIALOG_BOX)), 2_000), "the second Esc closes the dialog")
    assert.equal((await state(page))!.text, PHRASE_TASK, "the draft is kept")
    const c = await counts(page)
    assert.equal(c.dispatch + c.createSchedule, 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("6. nothing saves lazily in the mode, and ⌘↵ there creates, never dispatches", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open()
  try {
    await accept(page)
    await chord(page, ["Control", "Shift"], "Enter")
    await sleep(400)
    let s = (await state(page))!
    assert.equal((await counts(page)).createLazyThread, 0, "⌘⇧↵ saved nothing")
    assert.equal(s.lazyDisabled, true, "the snail is disabled")
    assert.equal(s.glyph, "on", "the mode kept")
    assert.equal(s.text, PHRASE_TASK, "the text kept")
    await page.$eval(`${PAGE_BOX} [data-composer-lazy]`, (el) => (el as HTMLButtonElement).click())
    await sleep(200)
    assert.equal((await counts(page)).createLazyThread, 0, "a click on the snail saved nothing")
    await focusEnd(page)
    await chord(page, ["Control"], "Enter")
    assert.ok(await waitFor(async () => (await counts(page)).createSchedule === 1, 3_000), "⌘↵ created")
    s = (await state(page))!
    assert.equal((await counts(page)).dispatch, 0, "⌘↵ never dispatched")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("7. Tab with a slash menu open takes the menu row, not the schedule", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open()
  try {
    // A leading /command is skipped by the reading's window (§2.2), so the phrase after it is offered; the
    // caret put back inside the command opens the menu over that offer. (A user command is offered only as
    // the draft's first token, which is why the menu is opened there and not mid-text.)
    await offer(page, "/review every Monday at 9am triage new issues")
    await page.evaluate((sel) => document.querySelector<HTMLTextAreaElement>(sel)!.setSelectionRange(4, 4), ta(PAGE_BOX))
    await page.keyboard.press("ArrowLeft")
    await page.keyboard.press("ArrowRight")
    assert.ok(await waitFor(async () => !!(await page.$(`${PAGE_BOX} [data-slash-menu]`)), 3_000), "the slash menu is open")
    assert.equal((await state(page))!.slot, "ledge", "…over a visible offer")
    await page.keyboard.press("Tab")
    await sleep(400)
    const s = (await state(page))!
    const caret = await page.$eval(ta(PAGE_BOX), (el) => (el as HTMLTextAreaElement).selectionStart)
    assert.equal(await page.$(`${PAGE_BOX} [data-slash-menu]`), null, "Tab closed the menu")
    assert.equal(caret, "/review ".length, "by completing the command")
    assert.notEqual(s.glyph, "on", "and did not enter the mode")
    assert.equal(s.send, "send")
    assert.equal((await counts(page)).interpretSchedule, 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("8. a dismissal sticks through a remount, a reload and refinements, and re-arms when the phrase is deleted", { skip: !baseUrl, timeout: 90_000 }, async () => {
  const { page, errors } = await open()
  try {
    await offer(page)
    await page.keyboard.press("Escape")
    await sleep(300)
    let s = (await state(page))!
    assert.equal(s.open, false, "Esc on the offer puts it away")
    assert.equal(s.focused, true, "and keeps the caret in the box")
    assert.equal(s.glyph, "hint", "the glyph keeps the way back")

    await page.evaluate(() => window.__sched.remount())
    await ready(page)
    await sleep(1_000)
    assert.equal((await state(page))!.open, false, "still dark after a remount")
    await page.reload({ waitUntil: "networkidle0" })
    await ready(page)
    await sleep(1_000)
    assert.equal((await state(page))!.open, false, "still dark after a reload")

    await resetLive(page)
    await replace(page, "9am", "10am")
    await sleep(900)
    await replace(page, "Monday", "Tuesday")
    await sleep(900)
    s = (await state(page))!
    assert.equal(s.text, "every Tuesday at 10am triage new issues")
    assert.equal((await live(page)).slots.some((x) => x.open), false, "9am → 10am, Monday → Tuesday: still dark")

    await clearBox(page)
    await offer(page)
    assert.equal((await state(page))!.slot, "ledge", "deleted and retyped: offered again")
    await page.click(`${PAGE_BOX} [data-schedule-dismiss]`)
    await sleep(300)
    assert.equal((await state(page))!.open, false, "the ledge's × puts it away too")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("9. the close edge waits ~800ms after the last key; a time box never offers", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open()
  try {
    await resetLive(page)
    await typeFast(page, "triage new issues every Monday at 9am", 50)
    await sleep(1_500)
    const lv = await live(page)
    const lastKey = lv.keys.at(-1)!
    const opened = lv.slots.find((x) => x.open)
    assert.ok(opened, "the close edge offered")
    const delay = opened!.t - lastKey
    assert.ok(delay >= 700, `no ledge at 700ms (it came at ${Math.round(delay)}ms)`)
    assert.ok(delay >= 790 && delay <= 1_000, `a ledge at ~800ms (it came at ${Math.round(delay)}ms)`)
    assert.ok((await state(page))!.ledge?.startsWith(LEDGE_FULL))

    await clearBox(page)
    await resetLive(page)
    await typeFast(page, "go until 10am tomorrow", 50)
    await sleep(1_600)
    assert.equal((await live(page)).slots.some((x) => x.open), false, "`go until 10am tomorrow` never offers")
    assert.equal((await counts(page)).interpretSchedule, 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

const CUE = "every Monday unless it's a holiday post the digest"
const CONSISTENT: ModelAnswer = { phrase: "every Monday unless it's a holiday", rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0", dtstart: "2026-10-12T09:00", condition: "unless it's a holiday", title: "Post digest", delayMs: 700 }
const INCONSISTENT: ModelAnswer = { ...CONSISTENT, rrule: "FREQ=WEEKLY;BYDAY=TU;BYHOUR=9;BYMINUTE=0", dtstart: "2026-10-06T09:00" }

test("10a. a cue: offered with no model call; Tab reads it once; a consistent answer grows the mark; a task-only edit keeps it", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open()
  try {
    await armModel(page, CONSISTENT)
    await offer(page, CUE)
    let s = (await state(page))!
    assert.equal(marksOf(s, "offer"), "every Monday", "the core dotted")
    assert.equal(marksOf(s, "unread"), "unless it's a holiday", "the unread words dashed")
    assert.ok((s.ledge ?? "").startsWith("Every Monday at 9am, “unless it's a holiday”"), `the cue ledge: ${s.ledge}`)
    assert.equal((await counts(page)).interpretSchedule, 0, "no model call for an offer")

    await focusEnd(page)
    await page.keyboard.press("Tab")
    await sleep(100)
    s = (await state(page))!
    assert.equal(s.slot, "panel")
    assert.equal(s.create?.disabled, true, "Create waits while it reads")
    assert.equal(s.create?.title, "Still reading")
    assert.equal(marksOf(s, "reading"), "unless it's a holiday")
    assert.equal((await counts(page)).interpretSchedule, 1, "Tab reads it once")

    assert.ok(await waitFor(async () => !!(await state(page))?.echo, 5_000), "the answer lands")
    s = (await state(page))!
    assert.match(s.echo ?? "", /^Post digest · every Monday at 9am · unless it.s a holiday$/)
    assert.equal(s.create?.disabled, false, "Create enables")
    assert.equal(marksOf(s, "accepted"), "every Monday")
    assert.equal(marksOf(s, "grow"), " unless it's a holiday", "the mark grew over the words the model read")

    await focusEnd(page)
    await typeFast(page, " to #eng")
    await sleep(1_200)
    s = (await state(page))!
    assert.equal((await counts(page)).interpretSchedule, 1, "a task-only edit asks nothing again")
    assert.match(s.echo ?? "", /^Post digest · every Monday at 9am/, "the reading is kept")
    assert.equal(s.each, "Each run: post the digest to #eng", "and Each run follows the text")
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => (await counts(page)).createSchedule === 1, 3_000))
    const body = (await bodies(page, "createSchedule"))[0]!
    assert.equal(body.condition, "unless it's a holiday")
    assert.equal(body.prompt, "post the digest to #eng")
    assert.equal("source" in body, false, "a model reading carries no local source")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("10b. an inconsistent model answer: the disagree state, and neither Enter nor a click creates", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open()
  try {
    await armModel(page, INCONSISTENT)
    await offer(page, CUE)
    await focusEnd(page)
    await page.keyboard.press("Tab")
    assert.ok(await waitFor(async () => !!(await state(page))?.disagree, 5_000), "the disagree state")
    const s = (await state(page))!
    assert.match(s.disagree ?? "", /^Those words read two ways: every Monday at 9am, or every Tuesday at 9am\.$/)
    assert.equal(s.create?.disabled, true)
    assert.equal(s.create?.title, "Reword it first")
    await focusEnd(page)
    await page.keyboard.press("Enter")
    await sleep(400)
    await page.$eval(`${PAGE_BOX} [data-schedule-create]`, (el) => (el as HTMLButtonElement).click())
    await sleep(400)
    const c = await counts(page)
    assert.equal(c.createSchedule, 0, "neither Enter nor a click created")
    assert.equal(c.dispatch, 0)
    assert.equal(c.interpretSchedule, 1)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("11. an event phrase stays dark, and ⌘⌥↵ refuses it locally with no model call", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open()
  try {
    await resetLive(page)
    await typeFast(page, "every time the build fails, fix it", 50)
    await sleep(1_400)
    let s = (await state(page))!
    assert.equal((await live(page)).slots.some((x) => x.open), false, "no ledge")
    assert.equal(s.glyph, "off")
    await chord(page, ["Control", "Alt"], "Enter")
    await sleep(500)
    s = (await state(page))!
    assert.equal(s.refusal, "Schedules run on the clock. Try “every hour, check whether the build failed”.")
    assert.equal(s.create, null, "no Create to press")
    await sleep(900)
    assert.equal((await counts(page)).interpretSchedule, 0, "zero model calls, even past the idle")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("12. T3: a time that passes before Enter creates nothing and says so; the server's two refusals", { skip: !baseUrl, timeout: 90_000 }, async () => {
  const { page, errors } = await open()
  try {
    // The fixture's clock starts at 2:32pm: 2:40pm is today's, until the clock jumps past it.
    await accept(page, "every day at 2:40pm check the logs")
    let s = (await state(page))!
    assert.match(s.next ?? "", /^Next: Mon Oct 5, in \d+m · Tue Oct 6/, `today's run first: ${s.next}`)
    await page.evaluate(() => (window as unknown as { __clock: { skew: (ms: number) => void } }).__clock.skew(10 * 60_000))
    await focusEnd(page)
    await page.keyboard.press("Enter")
    await sleep(500)
    s = (await state(page))!
    assert.equal((await counts(page)).createSchedule, 0, "nothing created")
    assert.equal(s.notice, "Updated for the current time. Press Enter to create.")
    assert.match(s.next ?? "", /^Next: Tue Oct 6/, `the panel now shows tomorrow's: ${s.next}`)
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => (await counts(page)).createSchedule === 1, 3_000), "the next Enter creates")
    assert.match(String((await bodies(page, "createSchedule"))[0]!.dtstart), /^2026-10-06T14:40/)
    await sleep(800)

    // The server re-read the phrase at its own clock and got something else.
    await page.evaluate(() => { window.__sched.createFail = ["schedule-reading-moved: the server read those words differently just now"] })
    await accept(page)
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => (await state(page))?.notice === "Updated for the current time. Press Enter to create.", 3_000), "a moved reading: the panel re-reads and says so")
    assert.equal((await counts(page)).createSchedule, 2, "the refused request was made, and nothing more")
    assert.equal((await state(page))!.glyph, "on", "still in the mode")
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => (await counts(page)).createSchedule === 3, 3_000), "the next Enter creates")
    await sleep(800)

    // An old bundle against a newer server's grammar: only a reload settles it.
    await page.evaluate(() => { window.__sched.createFail = ["schedule-grammar-stale: this page reads schedules with grammar 1, the server with 2"] })
    await accept(page)
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => (await state(page))?.refusal === "Frizz has updated since this page loaded. Reload the page to create this schedule.", 3_000), "the stale-bundle copy")
    assert.equal((await counts(page)).createSchedule, 4)
    assert.equal((await counts(page)).dispatch, 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("13. Undo deletes, restores the text with the offer and the mode off, and keeps what was typed since", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open()
  try {
    await accept(page)
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => !!(await state(page))?.toast?.actions.includes("Undo"), 3_000))
    await page.click('[data-toast-action="Undo"]')
    assert.ok(await waitFor(async () => (await counts(page)).deleteSchedule === 1, 3_000), "Undo deleted it")
    assert.ok(await waitFor(async () => (await state(page))?.slot === "ledge", 3_000), "the offer is back")
    let s = (await state(page))!
    assert.equal(s.text, PHRASE_TASK)
    assert.equal(s.send, "send", "the mode is off")
    assert.equal(s.glyph, "hint")
    assert.equal(s.focused, true, "focus back in the box")

    await page.keyboard.press("Tab")
    await sleep(300)
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => (await counts(page)).createSchedule === 2, 3_000))
    assert.ok(await waitFor(async () => (await state(page))?.text === "", 3_000))
    await focusEnd(page)
    await typeFast(page, "check the flaky tests")
    await page.click('[data-toast-action="Undo"]')
    assert.ok(await waitFor(async () => (await counts(page)).deleteSchedule === 2, 3_000))
    await sleep(500)
    s = (await state(page))!
    assert.ok(s.text?.includes(PHRASE_TASK) && s.text.includes("check the flaky tests"), `both texts kept: ${JSON.stringify(s.text)}`)
    assert.equal((await counts(page)).dispatch, 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("14. under reduced motion every state arrives with no draw", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open({ reducedMotion: true })
  try {
    // MOTION, not colour: a keyframe animation (the dots' reveal, the ledge's slide, Create's pop-in, the
    // fill, the wash) or a transition of a property that moves something, recorded on EVERY frame from
    // before the first key — the offer's reveal is over 180ms after the space that publishes it, so a
    // sample taken after typing would see nothing either way. The house leaves its 120ms colour and opacity
    // fades (`transition-colors` on every icon button, Create's disabled fade) running under reduced motion
    // app-wide — styles.css suppresses animations, not colour — so those are not counted here. Without the
    // emulation the same recorder sees sched-reveal, sched-ledge-in and the slot's grid-template-rows at the
    // offer alone (run against this fixture, 2026-10-06), so an empty set here is a reading, not a dead probe.
    await page.evaluate((sel) => {
      const w = window as unknown as { __motion: Set<string> }
      w.__motion = new Set()
      const MOTION = /^(transform|translate|scale|rotate|top|left|right|bottom|margin|height|width|max-height|grid-template-rows|mask-size|-webkit-mask-size|background-size|background-position)/
      const tick = () => {
        const form = document.querySelector(sel)
        for (const e of form?.querySelectorAll("*") ?? []) {
          for (const a of e.getAnimations()) {
            if ("animationName" in a) w.__motion.add(`animation ${(a as CSSAnimation).animationName}`)
            else if (MOTION.test((a as CSSTransition).transitionProperty)) w.__motion.add(`transition ${(a as CSSTransition).transitionProperty}`)
          }
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }, PAGE_BOX)
    const motion = () => page.evaluate(() => [...(window as unknown as { __motion: Set<string> }).__motion])
    await typeFast(page, PHRASE_TASK)
    assert.ok(await waitFor(async () => !!(await state(page))?.open, 3_000, 10))
    await sleep(300)
    assert.deepEqual(await motion(), [], "the offer, its underline and the ledge")
    await page.keyboard.press("Tab")
    await sleep(300)
    assert.deepEqual(await motion(), [], "the accept, the panel and the send glyph")
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => (await counts(page)).createSchedule === 1, 3_000))
    await sleep(600)
    assert.deepEqual(await motion(), [], "the commit")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

// ---- fix round 1 (2026-10-06): the break-it findings that only a browser shows ----------------------------------

// Case 15 pinned fix round 1's X1 (a mode entered since stayed ON through Undo) until fix round 3 reversed it:
// the kept mode read the merged text as the UNDONE schedule whenever the new text had no phrase of its own (case
// 28). §1.3.1 holds in every case now: Undo restores the pre-accept state, and the ledge prints what Enter does.
test("15. Undo of an older schedule ends a mode entered since for new text: the pre-accept state, its Enter printed (fix round 3 reverses X1)", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open()
  try {
    await accept(page)
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => !!(await state(page))?.toast?.actions.includes("Undo"), 3_000))
    assert.ok(await waitFor(async () => (await state(page))?.text === "", 3_000), "the box cleared")
    // Inside the Undo window, the human sets up the NEXT schedule.
    const next = "every Friday at 4pm write the changelog"
    await focusEnd(page)
    await accept(page, next)
    assert.equal((await state(page))!.send, "schedule")
    await page.click('[data-toast-action="Undo"]')
    assert.ok(await waitFor(async () => (await counts(page)).deleteSchedule === 1, 3_000), "Undo deleted the first")
    assert.ok(await waitFor(async () => (await state(page))?.slot === "ledge", 3_000), "the undone words' offer is back")
    const s = (await state(page))!
    assert.ok(s.text?.includes(PHRASE_TASK) && s.text.includes(next), `both texts kept: ${JSON.stringify(s.text)}`)
    assert.notEqual(s.glyph, "on", "the mode is off")
    assert.equal(s.send, "send", "the send button says Enter starts it")
    assert.equal(s.startNow, true, "and the ledge prints ↵ Start now")
    await focusEnd(page)
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => (await counts(page)).dispatch === 1, 3_000), "Enter did what the ledge said")
    assert.equal((await counts(page)).createSchedule, 1, "and created nothing more")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("16. a prompt that starts with whitespace: the model's marks and Each run sit on the right words (X8)", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open()
  try {
    await armModel(page, CONSISTENT)
    // Shift-Enter first: the box's text starts with a newline, which the server trims before it reads.
    await chord(page, ["Shift"], "Enter")
    await offer(page, CUE)
    await focusEnd(page)
    await page.keyboard.press("Tab")
    assert.ok(await waitFor(async () => !!(await state(page))?.echo, 5_000), "the answer lands")
    const s = (await state(page))!
    assert.equal(s.each, "Each run: post the digest")
    assert.equal(marksOf(s, "accepted"), "every Monday")
    assert.equal(marksOf(s, "grow"), " unless it's a holiday")
    assert.equal(s.create?.disabled, false)
    await focusEnd(page)
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => (await counts(page)).createSchedule === 1, 3_000), "Enter creates")
    assert.equal((await bodies(page, "createSchedule"))[0]!.prompt, "post the digest")
    assert.equal((await counts(page)).interpretSchedule, 1)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("17. the `c` dialog over the page box: one model read for one text, not one per box (X2)", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open()
  try {
    await armModel(page, { ...CONSISTENT, delayMs: 3_000 })
    await page.evaluate(() => window.__sched.openDialog())
    await ready(page, DIALOG_BOX)
    await typeFast(page, CUE)
    assert.ok(await waitFor(async () => (await state(page, DIALOG_BOX))?.slot === "ledge", 3_000), "the dialog offers it")
    await focusEnd(page, DIALOG_BOX)
    await page.keyboard.press("Tab")
    // Past the page box's own idle (700ms), with the dialog's read still out.
    await sleep(2_000)
    assert.equal((await state(page))!.glyph, "on", "the page box under the dialog is in the mode too")
    assert.equal((await counts(page)).interpretSchedule, 1, "one read, though two boxes show the mode")
    assert.ok(await waitFor(async () => !!(await state(page, DIALOG_BOX))?.echo, 5_000), "the answer lands in the dialog")
    assert.ok(await waitFor(async () => !!(await state(page))?.echo, 2_000), "…and in the page box")
    await sleep(1_000)
    assert.equal((await counts(page)).interpretSchedule, 1)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("18. a panel folding away after Esc is inert: a click on its Create creates nothing (X3)", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open()
  try {
    await accept(page)
    // The old panel stays mounted for 160ms after Esc while its slot folds from the bottom, so Create is
    // clipped away within a few tens of ms — a real press one CDP round trip behind the key found it in one
    // run of two. The slot is held still here (the test's only change to the page: its row pinned open and
    // every transition and animation in it off) so the press reliably meets a Create that is still DRAWN,
    // inside the 160ms the panel lingers: what is under test is whether that drawn Create still acts, not
    // how fast a mouse is.
    const at = await page.evaluate((sel) => {
      const wrap = document.querySelector<HTMLElement>(`${sel} [data-schedule-slot-wrap]`)!
      const still = document.createElement("style")
      still.textContent = `${sel} [data-schedule-slot-wrap] { grid-template-rows: 1fr !important }
        ${sel} [data-schedule-slot-wrap], ${sel} [data-schedule-slot-wrap] * { transition: none !important; animation: none !important }`
      document.head.append(still)
      const r = document.querySelector(`${sel} [data-schedule-create]`)!.getBoundingClientRect()
      const at = { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      const w = window as unknown as { __press: { t: number; drawn: boolean; hit: string }[]; __esc: number }
      w.__press = []
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") w.__esc = performance.now() }, true)
      document.addEventListener("pointerdown", (e) => {
        const create = document.querySelector(`${sel} [data-schedule-create]`)
        const box = create?.getBoundingClientRect()
        const clip = (wrap.firstElementChild as HTMLElement).getBoundingClientRect()
        w.__press.push({
          t: Math.round(performance.now() - w.__esc),
          drawn: !!box && at.x >= box.left && at.x <= box.right && at.y >= box.top && at.y <= box.bottom && clip.bottom >= box.bottom && !wrap.hasAttribute("data-open"),
          hit: (e.target as Element).closest("[data-schedule-create]") ? "create" : (e.target as Element).tagName,
        })
      }, true)
      return at
    }, PAGE_BOX)
    await page.mouse.move(at.x, at.y)
    await page.keyboard.press("Escape")
    await page.mouse.click(at.x, at.y)
    const press = await page.evaluate(() => (window as unknown as { __press: { t: number; drawn: boolean; hit: string }[] }).__press)
    // `drawn` needs the old Create still in the page, so it also says the press came inside the linger.
    assert.ok(press[0]?.drawn, `the press came while the folded-away panel's Create was still drawn (the test is not vacuous): ${JSON.stringify(press)}`)
    await sleep(800)
    const c = await counts(page)
    assert.equal(c.createSchedule, 0, `the folding panel created nothing: ${JSON.stringify(press)}`)
    assert.equal(c.dispatch, 0)
    assert.notEqual((await state(page))!.glyph, "on", "Esc left the mode")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("19. in the `c` dialog an open slash menu takes the first Esc, before the mode (X4)", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open()
  try {
    await page.evaluate(() => window.__sched.openDialog())
    await ready(page, DIALOG_BOX)
    await typeFast(page, PHRASE_TASK)
    assert.ok(await waitFor(async () => (await state(page, DIALOG_BOX))?.slot === "ledge", 3_000))
    await focusEnd(page, DIALOG_BOX)
    await page.keyboard.press("Tab")
    assert.ok(await waitFor(async () => (await state(page, DIALOG_BOX))?.glyph === "on", 3_000), "in the mode")
    await page.evaluate((sel) => document.querySelector<HTMLTextAreaElement>(sel)!.setSelectionRange(0, 0), ta(DIALOG_BOX))
    await typeFast(page, "/re", 60)
    assert.ok(await waitFor(async () => !!(await page.$(`${DIALOG_BOX} [data-slash-menu]`)), 3_000), "the slash menu is open")
    await page.keyboard.press("Escape")
    await sleep(300)
    assert.equal(await page.$(`${DIALOG_BOX} [data-slash-menu]`), null, "the first Esc closed the menu")
    assert.ok(await page.$(DIALOG_BOX), "…kept the dialog")
    assert.equal((await state(page, DIALOG_BOX))!.glyph, "on", "…and kept the mode")
    await page.keyboard.press("Escape")
    await sleep(300)
    assert.ok(await page.$(DIALOG_BOX), "the second Esc keeps the dialog")
    assert.notEqual((await state(page, DIALOG_BOX))!.glyph, "on", "…and leaves the mode")
    const c = await counts(page)
    assert.equal(c.dispatch + c.createSchedule, 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("20. the server refusing the same words twice is a clock disagreement: read again, never reload", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open()
  try {
    // A page whose clock runs behind the server's re-reads the same first run, and is refused again.
    const moved = "schedule-reading-moved: the server read those words differently just now"
    await page.evaluate((m) => { window.__sched.createFail = [m, m] }, moved)
    await accept(page)
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => (await state(page))?.notice === "Updated for the current time. Press Enter to create.", 3_000), "the first refusal re-reads and says so")
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => (await counts(page)).createSchedule === 2, 3_000))
    assert.ok(await waitFor(async () => !!(await state(page))?.refusal, 3_000), "the second refusal shows a line")
    let s = (await state(page))!
    assert.equal(s.refusal, "This computer's clock is off from Frizz's. Press Enter to read it again.")
    assert.doesNotMatch(s.refusal ?? "", /Reload/)
    assert.equal(s.glyph, "on", "still in the mode")
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => !(await state(page))?.refusal && !!(await state(page))?.echo, 3_000), "Enter read it again")
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => (await counts(page)).createSchedule === 3, 3_000), "and the next Enter creates")
    s = (await state(page))!
    assert.equal((await counts(page)).dispatch, 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

// ---- end-to-end round 2 (2026-10-06): the fixed findings no case above reached ------------------------------------
// Each finding below was fixed and pinned at the unit level in fix round 1 (the grammar's break-it battery,
// scheduleOffer's simulated-timer typing, readingsConsistent, the model-echo phrasing). These cases put the same
// words through the real box — the windows, composerExcludeRuns, the edge gates, the publish policy and the
// panel — because a unit test of the grammar cannot see what the box hands it or what it does with the answer.

/** Clear the box, type `text`, and wait out the close edge's idle: what does the box show for it? */
async function settle(page: Page, text: string, delay = 8) {
  await clearBox(page)
  await resetLive(page)
  await typeFast(page, text, delay)
  await sleep(1_300)
  return { s: (await state(page))!, everOpen: (await live(page)).slots.some((x) => x.open) }
}

test("21. the grammar's break-it words in the real box: dark stays dark, a qualifier is never left in the task, a night clock is the night (I-9)", { skip: !baseUrl, timeout: 180_000 }, async () => {
  const { page, errors } = await open()
  try {
    // A bug report, a negation, a statement, code, a date: never an offer (false-offer-*, on-the-15th,
    // weekday-list-swallows-negated-day). `see packages/web/src/daily` is the case composerExcludeRuns
    // cannot mask (the path does not open a word), so it is the grammar's code guard that keeps it dark.
    const dark = [
      "Every night the backup job fails with ENOSPC, fix it",
      "Every 15 minutes the health check flaps, find out why",
      "don't deploy on Fridays",
      "the meeting is every Monday at 9am",
      "see packages/web/src/daily",
      "set FREQ=DAILY",
      "ship the release on the 15th",
      "every Monday, Friday is off-limits, triage new issues",
    ]
    // An open-edge text is offered while it is still only "Every night " — nothing can know the words to
    // come — so what is pinned for those is the settled screen; a close-edge one must never open at all.
    for (const text of dark) {
      const { s, everOpen } = await settle(page, text)
      assert.equal(s.open, false, `dark once typed: ${JSON.stringify(text)}`)
      if (!/^every/i.test(text)) assert.equal(everOpen, false, `never offered while typed: ${JSON.stringify(text)}`)
    }
    // A qualifier, a zone, an unparsed clock, a fraction: offered only as a CUE — its leftover words dashed as
    // unread, never an exact reading that would leave them in the task (X6, named-zone-ignored,
    // unparsed-clock-assumed-9am, and-a-half-dropped, ordinal-unit-dropped).
    const cues: [string, string][] = [
      ["every weekday at 9am apart from Fridays triage new issues", "apart from Fridays"],
      ["every Monday at 9am stopping Oct 30 triage new issues", "stopping Oct"],
      ["every Monday at 9am Berlin time triage new issues", "Berlin"],
      ["every Monday at 0900 triage new issues", "0900"],
      ["every hour and a half check CI", "and a half"],
      ["every 2nd week review billing", ""],
    ]
    for (const [text, unread] of cues) {
      const { s } = await settle(page, text)
      assert.equal(s.slot, "ledge", `offered: ${JSON.stringify(text)}`)
      assert.ok(marksOf(s, "unread").includes(unread), `${JSON.stringify(unread)} is dashed as unread in ${JSON.stringify(text)}: ${JSON.stringify(s.marks)}`)
      assert.ok(/“/.test(s.ledge ?? "") || marksOf(s, "offer") === "", `the ledge quotes what it did not read: ${s.ledge}`)
    }
    // X6 end to end: Tab on the qualifier asks the model (it is not accepted locally), and with the model
    // answering nothing usable, Enter creates nothing — the qualifier never silently drops.
    await settle(page, "every weekday at 9am apart from Fridays triage new issues")
    await focusEnd(page)
    await page.keyboard.press("Tab")
    assert.ok(await waitFor(async () => (await counts(page)).interpretSchedule === 1, 3_000), "Tab sent the qualifier to the model")
    assert.ok(await waitFor(async () => !!(await state(page))?.refusal, 3_000), "the model's 'no' is shown")
    await focusEnd(page)
    await page.keyboard.press("Enter")
    await sleep(500)
    assert.equal((await counts(page)).createSchedule, 0, "nothing created over a qualifier the box could not read")
    await page.keyboard.press("Escape")
    await sleep(300)

    // night-hour-pm: "every night at 2" is 2am, and the toast-bound create says so.
    await settle(page, "every night at 2 back up the db")
    let s = (await state(page))!
    assert.ok((s.ledge ?? "").startsWith("Every day at 2am"), `the night clock: ${s.ledge}`)
    await focusEnd(page)
    await page.keyboard.press("Tab")
    assert.ok(await waitFor(async () => (await state(page))?.slot === "panel", 3_000))
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => (await counts(page)).createSchedule === 1, 3_000))
    const body = (await bodies(page, "createSchedule"))[0]!
    assert.equal(body.rrule, "FREQ=DAILY;BYHOUR=2;BYMINUTE=0")
    assert.equal(body.prompt, "back up the db")
    // abbrev-dot-ends-window: "Wed." does not end the reading.
    s = (await settle(page, "every Wed. at 3 review billing")).s
    assert.ok((s.ledge ?? "").startsWith("Every Wednesday at 3pm"), `an abbreviation's dot: ${s.ledge}`)
    assert.equal(marksOf(s, "offer"), "every Wed. at 3")
    const c = await counts(page)
    assert.equal(c.dispatch, 0)
    // The fixture's "no" is not one of the server's verdicts, so Enter over it reads again (M4): one or two
    // reads, and every one of them for the qualifier's words — each other reading above was local.
    const asked = (await bodies(page, "interpretSchedule")).map((b) => String(b.text).trim())
    assert.ok(asked.length >= 1 && asked.every((t) => t === "every weekday at 9am apart from Fridays triage new issues"), `model reads: ${JSON.stringify(asked)}`)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("22. a model reading the core's assumed day and time cannot hold, and a month filter, in words (X5, model-raw-rrule-echo)", { skip: !baseUrl, timeout: 90_000 }, async () => {
  const { page, errors } = await open()
  try {
    // X5: "every week" assumes Monday 9am; an HOURLY answer is not a reading of it.
    const WEEK = "every week unless it's a holiday post the digest"
    await armModel(page, { phrase: "every week unless it's a holiday", rrule: "FREQ=HOURLY;BYMINUTE=0", dtstart: "2026-10-05T15:00", condition: "unless it's a holiday", title: "Post digest" })
    await offer(page, WEEK)
    await focusEnd(page)
    await page.keyboard.press("Tab")
    assert.ok(await waitFor(async () => !!(await state(page))?.disagree, 5_000), "the disagree state")
    let s = (await state(page))!
    assert.match(s.disagree ?? "", /every hour/, `it names the model's reading: ${s.disagree}`)
    assert.equal(s.create?.disabled, true)
    await page.keyboard.press("Enter")
    await sleep(500)
    assert.equal((await counts(page)).createSchedule, 0, "Enter created nothing over the disagreement")
    await page.keyboard.press("Escape")
    await sleep(300)

    // model-raw-rrule-echo: Sonnet's real answer for this text, a month filter on a weekly rule, reads in words.
    const DEC = "every Friday except in December write the changelog"
    await clearBox(page)
    await armModel(page, { phrase: "every Friday except in December", rrule: "FREQ=WEEKLY;BYMONTH=1,2,3,4,5,6,7,8,9,10,11;BYDAY=FR;BYHOUR=9;BYMINUTE=0", dtstart: "2026-10-09T09:00", title: "Write changelog" })
    await offer(page, DEC)
    await focusEnd(page)
    await page.keyboard.press("Tab")
    assert.ok(await waitFor(async () => !!(await state(page))?.echo, 5_000), "the answer lands")
    s = (await state(page))!
    assert.equal(s.echo, "Write changelog · every Friday at 9am, except in December")
    assert.doesNotMatch(JSON.stringify(s), /FREQ=|on the rule/, "no RRULE text anywhere on screen")
    assert.equal(s.create?.disabled, false)
    await page.keyboard.press("Escape")
    await sleep(300)

    // …and a month set no words cover is refused with copy, never confirmed as raw RRULE. (Other words than
    // DEC's: the reader caches its answer for those for 10m.)
    await clearBox(page)
    await armModel(page, { phrase: "every Friday except in December", rrule: "FREQ=WEEKLY;BYMONTH=1,3,5,8,11;BYDAY=FR;BYHOUR=9;BYMINUTE=0", dtstart: "2026-11-06T09:00", title: "Write release notes" })
    await offer(page, "every Friday except in December write the release notes")
    await focusEnd(page)
    await page.keyboard.press("Tab")
    assert.ok(await waitFor(async () => !!(await state(page))?.refusal, 5_000), "the refusal")
    s = (await state(page))!
    assert.equal(s.refusal, "That schedule is too intricate to show here. Try saying it more simply, like “every Friday at 9am”.")
    assert.doesNotMatch(JSON.stringify(s), /FREQ=|on the rule/)
    assert.equal(s.create, null, "no Create to press")
    await page.keyboard.press("Enter")
    await sleep(500)
    const c = await counts(page)
    assert.equal(c.createSchedule, 0)
    assert.equal(c.dispatch, 0)
    assert.equal(c.interpretSchedule, 3)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("23. a pause inside a clock or a colon never puts a half-typed time on screen (publish-flicker-colon-and-rest)", { skip: !baseUrl, timeout: 90_000 }, async () => {
  const { page, errors } = await open()
  try {
    // Sample the ledge on every frame, not per key: a pause publishes on a timer, between keys.
    await page.evaluate((sel) => {
      const w = window as unknown as { __ledges: string[] }
      w.__ledges = []
      const tick = () => {
        const form = document.querySelector(sel)
        const open = form?.querySelector("[data-schedule-slot-wrap]")?.hasAttribute("data-open")
        const row = open ? form?.querySelector<HTMLElement>("[data-schedule-ledge-reading]") : null
        const unread = [...(form?.querySelectorAll('[data-composer-mark="unread"]') ?? [])].map((m) => m.textContent).join("")
        // The rule and its next run: Each run follows the task as it is typed, which is not a reading changing.
        const v = `${row ? row.innerText.replace(/\s+/g, " ").replace(/ · Each run:.*$/, "").trim() : "∅"}${unread ? ` [unread ${unread}]` : ""}`
        if (w.__ledges.at(-1) !== v) w.__ledges.push(v)
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }, PAGE_BOX)
    const ledges = () => page.evaluate(() => (window as unknown as { __ledges: string[] }).__ledges)

    // (D) a 400ms pause between the "1" and the "0" of 10am.
    await typeFast(page, "every Monday at 1", 120)
    await sleep(400)
    await typeFast(page, "0am triage new issues", 120)
    await sleep(1_000)
    let seen = await ledges()
    assert.ok(seen.every((l) => !/at 1(am|pm)\b/.test(l)), `never "at 1pm" through the pause: ${JSON.stringify(seen)}`)
    assert.ok(seen.at(-1)!.startsWith("Every Monday at 10am"), `ends on 10am: ${seen.at(-1)}`)
    assert.ok(seen.filter((l) => l !== "∅").length <= 4, `at most 4 readings shown: ${JSON.stringify(seen)}`)

    // (A) a colon is mid-word: "at 10:" is never a cue.
    await clearBox(page)
    await page.evaluate(() => { (window as unknown as { __ledges: string[] }).__ledges = [] })
    await typeFast(page, "every weekday at 10:30am check CI", 120)
    await sleep(1_000)
    seen = await ledges()
    assert.ok(seen.every((l) => !l.includes("[unread")), `no cue while the clock is typed: ${JSON.stringify(seen)}`)
    assert.ok(seen.at(-1)!.startsWith("Every weekday at 10:30am"), `ends on 10:30am: ${seen.at(-1)}`)
    assert.ok(seen.filter((l) => l !== "∅").length <= 4, `at most 4 readings shown: ${JSON.stringify(seen)}`)
    assert.equal((await counts(page)).interpretSchedule, 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("24. on a phone a failed model read names the tap, never a key (X7)", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const page = await browser!.newPage()
  const errors: string[] = []
  try {
    page.setDefaultTimeout(30_000)
    await page.emulateTimezone(NY)
    await page.setViewport({ width: 420, height: 860, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }])
    page.on("console", (m) => { if (m.type() === "error" && !/404|500|favicon|Failed to load resource/i.test(m.text())) errors.push(m.text()) })
    page.on("pageerror", (e) => errors.push(String(e)))
    await page.evaluateOnNewDocument(INSTRUMENT)
    await page.goto(`${baseUrl}/schedule-live-fixture.html`, { waitUntil: "networkidle0" })
    await ready(page)
    // The model is down: interpretSchedule answers 500 (counted first by the fixture's own seam).
    await page.evaluate(() => {
      const inner = window.fetch
      window.fetch = async (input, init) => {
        const r = await inner(input, init)
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        return /\/rpc\/interpretSchedule$/.test(new URL(url, location.origin).pathname)
          ? new Response(JSON.stringify({ error: "the model is down" }), { status: 500, headers: { "content-type": "application/json" } })
          : r
      }
    })
    await offer(page, CUE)
    let s = (await state(page))!
    assert.equal(s.startNow, false, "the phone's row has no Start now")
    await page.tap(`${PAGE_BOX} [data-schedule-accept]`)
    assert.ok(await waitFor(async () => (await counts(page)).interpretSchedule === 1, 3_000), "the tap read it")
    assert.ok(await waitFor(async () => !!(await state(page))?.refusal, 5_000), "the failure is shown")
    s = (await state(page))!
    assert.equal(s.refusal, "Couldn't read that just now. Tap the repeat button to try again.")
    assert.doesNotMatch(`${s.refusal} ${s.notice ?? ""} ${s.sendTitle}`, /Enter|Esc|Tab/, "no key named on a phone")
    assert.equal(s.sendTitle, "Create schedule")
    assert.equal((await counts(page)).createSchedule + (await counts(page)).dispatch, 0)
    // The tap it names does what it says: the send button reads it again.
    await page.tap(`${PAGE_BOX} [data-composer-send]`)
    assert.ok(await waitFor(async () => (await counts(page)).interpretSchedule === 2, 3_000), "the repeat button read it again")
    assert.equal((await counts(page)).createSchedule + (await counts(page)).dispatch, 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

// ---- end-to-end round 3: the fix-round-2 findings through the real box ------------------------------------------

/** What the box settled on, as one line a failure message can show. */
const settledAs = (s: State) => s.open ? `${s.slot} ${JSON.stringify(s.ledge)} unread=${JSON.stringify(marksOf(s, "unread"))} offer=${JSON.stringify(marksOf(s, "offer"))}` : "dark"

test("25. the round-2 break-it words in the real box: a minute, a count, a limiting adjective, a calendar abbreviation, an unlisted qualifier, a zone or a spelled clock is never left in the task", { skip: !baseUrl, timeout: 240_000 }, async () => {
  const { page, errors } = await open()
  try {
    // Open edge: each settles as a CUE with its leftover dashed as unread — never an exact reading that
    // would create the rule with those words left in the run's prompt. One per repro family.
    const cues: [finding: string, text: string, unread: string][] = [
      ["hourly-minute-dropped", "every hour at half past check CI", "at half"],
      ["hourly-minute-dropped", "every hour at :15 and :45 check CI", "and :45"],
      ["hourly-minute-dropped", "every 30 minutes offset by 10 check CI", "offset by 10"],
      ["count-before-adverb-dropped", "twice daily, check the queue", "twice daily"],
      ["abbreviated-calendar-residue", "every weekday at 9am Oct 12-30 triage new issues", "Oct"],
      ["abbreviated-calendar-residue", "every Monday at 9am Sep–Dec triage new issues", "Sep"],
      ["abbreviated-calendar-residue", "every day at 9am triage new issues, Mon-Fri only", "Mon-Fri"],
      ["abbreviated-calendar-residue", "every day at 9am triage new issues for 2 wks", "for 2 wks"],
      ["unlisted-qualifier-silent-prefix", "every Monday at 9am fortnightly triage new issues", "fortnightly"],
      ["unlisted-qualifier-silent-prefix", "every Monday at 9am barring outages triage new issues", "barring outages"],
      ["unlisted-qualifier-silent-prefix", "every Monday at 9am triage new issues. Stop after Christmas.", "Stop after"],
      ["unlisted-zones", "every Monday at 9am NZT triage new issues", "NZT"],
      ["unlisted-zones", "every Monday at 9am Kyiv triage new issues", "Kyiv"],
      ["unlisted-zones", "every Monday at 9am -0500 triage new issues", "-0500"],
      ["spelled-or-second-clock-dropped", "every weekday at quarter to 5 write the summary", "at quarter"],
      ["spelled-or-second-clock-dropped", "every day at 9 thirty check the queue", "thirty"],
      ["spelled-or-second-clock-dropped", "every weekday at 9 and again at 5 check", "and again at 5"],
      ["spelled-or-second-clock-dropped", "every day at lunch post the menu", "at lunch"],
    ]
    const wrong: string[] = []
    for (const [finding, text, unread] of cues) {
      const { s } = await settle(page, text)
      const ok = s.slot === "ledge" && marksOf(s, "unread").includes(unread) && /“/.test(s.ledge ?? "")
      if (!ok) wrong.push(`${finding}: ${JSON.stringify(text)} settled ${settledAs(s)}`)
    }

    // Close edge: a count glued to an adverb, a limiting adjective, a zone after the phrase — never offered,
    // not even for the ~800ms the close edge waits.
    const neverOffered: [string, string][] = [
      ["count-before-adverb-dropped", "check the queue twice daily"],
      ["count-before-adverb-dropped", "back up the db 4x nightly"],
      ["count-before-adverb-dropped", "check CI half-hourly"],
      ["alternate-adjective-dropped", "sync with design on alternate Thursdays"],
      ["alternate-adjective-dropped", "check CI on the first two Mondays at 9am"],
      ["alternate-adjective-dropped", "deploy on odd Fridays"],
      ["unlisted-zones", "triage new issues every Monday at 9am NZT"],
    ]
    const offered: string[] = []
    for (const [finding, text] of neverOffered) {
      const { s, everOpen } = await settle(page, text)
      if (everOpen || s.open) offered.push(`${finding}: ${JSON.stringify(text)} settled ${settledAs(s)} (ever open: ${everOpen})`)
    }
    // Both lists asserted only here, so one run names every text that regressed, not just the first family.
    assert.deepEqual({ wrong, offered }, { wrong: [], offered: [] }, "each open-edge text settles as a cue with its leftover dashed; no close-edge one is ever offered")

    // An open-edge limiting adjective is read only once the box is told: the glyph puts it in the mode,
    // where the whole text is read and the adjective is still unread, so Enter asks the model rather
    // than creating every Monday.
    const ALT = "alternate Mondays at 9am check CI"
    const before = await counts(page)
    const { s: alt } = await settle(page, ALT)
    assert.equal(alt.open, false, `dark at the open edge: ${settledAs(alt)}`)
    await page.click(`${PAGE_BOX} [data-composer-schedule]`)
    assert.ok(await waitFor(async () => (await state(page))?.glyph === "on", 3_000), "the glyph enters the mode")
    await focusEnd(page)
    await page.keyboard.press("Enter")
    await sleep(800)
    let c = await counts(page)
    assert.equal(c.createSchedule, before.createSchedule, `nothing created locally over "alternate": ${settledAs((await state(page))!)}`)
    assert.equal(c.dispatch, before.dispatch, "and nothing dispatched in the mode")
    assert.ok(c.interpretSchedule > before.interpretSchedule, "the model was asked")
    await page.keyboard.press("Escape")
    await sleep(300)

    // Tab on a minute the grammar used to drop goes to the model; with nothing usable back, Enter creates nothing.
    await settle(page, "every hour at half past check CI")
    const asked0 = (await counts(page)).interpretSchedule
    await focusEnd(page)
    await page.keyboard.press("Tab")
    assert.ok(await waitFor(async () => (await counts(page)).interpretSchedule === asked0 + 1, 3_000), "Tab sent the minute to the model")
    assert.ok(await waitFor(async () => !!(await state(page))?.refusal, 3_000), "the model's 'no' is shown")
    await focusEnd(page)
    await page.keyboard.press("Enter")
    await sleep(500)
    assert.equal((await counts(page)).createSchedule, before.createSchedule, "no hourly-on-the-hour schedule over 'at half past'")
    await page.keyboard.press("Escape")
    await sleep(300)

    // The one the round turned EXACT: a guess landing on a stated hour is the other one — 6 and 18.
    await settle(page, "every day at 6 and 18 check the backups")
    let s = (await state(page))!
    assert.equal(marksOf(s, "unread"), "", `read whole: ${settledAs(s)}`)
    assert.ok((s.ledge ?? "").startsWith("Every day at 6am and 6pm"), `both clocks: ${s.ledge}`)
    await focusEnd(page)
    await page.keyboard.press("Tab")
    assert.ok(await waitFor(async () => (await state(page))?.slot === "panel", 3_000))
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => (await counts(page)).createSchedule === before.createSchedule + 1, 3_000), "created")
    const body = (await bodies(page, "createSchedule")).at(-1)!
    assert.equal(body.rrule, "FREQ=DAILY;BYHOUR=6,18;BYMINUTE=0")
    assert.equal(body.prompt, "check the backups")
    assert.deepEqual(body.source, { kind: "local", grammar: SCHEDULE_GRAMMAR_VERSION })
    c = await counts(page)
    assert.equal(c.dispatch, 0)
    s = (await state(page))!
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("26. re-aiming the box at another project carries the mode with its text: Enter there creates, never dispatches (carry-drops-mode)", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open()
  try {
    await accept(page)
    const keys = () => page.evaluate(() => {
      const raw = sessionStorage.getItem("frizz-drafts:v1")
      const entries = raw ? (JSON.parse(raw) as { entries: Record<string, { value: string }> }).entries : {}
      return Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, v.value]))
    })
    const OTHER = "/fixture/other-project"
    await page.evaluate((dir) => window.__sched.reaim(dir), OTHER)
    await sleep(400)
    let s = (await state(page))!
    assert.equal(s.text, PHRASE_TASK, "the text moved")
    assert.equal(s.glyph, "on", "the re-aimed box is still in the mode")
    assert.equal(s.send, "schedule", "and Enter still says Create schedule")
    const modeKeys = Object.entries(await keys()).filter(([k]) => k.startsWith("dispatch-schedule:"))
    assert.deepEqual(modeKeys.map(([k]) => k.includes(encodeURIComponent(OTHER))), [true], `the mode is filed under the new project alone: ${JSON.stringify(modeKeys)}`)
    await focusEnd(page)
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => (await counts(page)).createSchedule === 1, 3_000), "Enter created")
    assert.equal((await counts(page)).dispatch, 0, "Enter never dispatched the text set up as a schedule")
    // Back to the first project: new text there starts out of the mode (nothing orphaned behind).
    await page.evaluate(() => window.__sched.reaim("/fixture/schedule-live"))
    await sleep(400)
    await focusEnd(page)
    await typeFast(page, "fix the flaky test")
    await sleep(600)
    s = (await state(page))!
    assert.notEqual(s.glyph, "on", "new text in the first project is out of the mode")
    assert.equal(s.send, "send")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

// Open from end-to-end round 2 (§15.3) through round 3: `pausePublishes` refused a rest or idle whenever the
// reading ended before the caret's word, which at the open edge is every task word, so the ledge's `Each run`
// kept the text of the last word BOUNDARY and dropped the last word for good. Fixed at the final gate: the IDLE
// publishes a reading that is the one already on screen (scheduleOffer.test.ts pins the policy half).
test("27. the ledge's Each run reads the whole task once typing stops", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open()
  try {
    await offer(page)
    await sleep(1_500)
    const each = await page.evaluate((sel) => {
      const form = document.querySelector(sel)!
      return {
        segment: (form.querySelector("[data-schedule-ledge-each]") as HTMLElement | null)?.innerText.replace(/\s+/g, " ").trim() ?? null,
        title: form.querySelector("[data-schedule-slot]")?.closest("[title]")?.getAttribute("title") ?? null,
      }
    }, PAGE_BOX)
    assert.equal(each.segment, "· Each run: triage new issues", `the ledge segment: ${JSON.stringify(each)}`)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

// ---- fix round 3 (2026-10-06): verify round 3's safety findings, each through the real box -------------------

const draftEntries = (page: Page) => page.evaluate(() => {
  const raw = sessionStorage.getItem("frizz-drafts:v1")
  const entries = raw ? (JSON.parse(raw) as { entries: Record<string, { value: string }> }).entries : {}
  return Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, v.value]))
})
const OTHER_PROJECT = "/fixture/other-project"

// undo-into-mode-recreates-undone: X1 kept a mode found ON at Undo. With the box empty (⌘⌥↵ there: M5) or
// holding words the model had refused (M4), the undone words came back FIRST, read `exact` in the mode, and
// the panel was ready with the rule just undone — the next Enter created it again (create 2, delete 1), the
// new words folded into its prompt.
test("28. Undo into a mode on an empty box or over plain words: the undone schedule comes back as an offer, and Enter starts the thread", { skip: !baseUrl, timeout: 90_000 }, async () => {
  for (const since of ["", "fix the flaky login test"]) {
    const { page, errors } = await open()
    try {
      await accept(page)
      await page.keyboard.press("Enter")
      assert.ok(await waitFor(async () => !!(await state(page))?.toast?.actions.includes("Undo"), 3_000))
      assert.ok(await waitFor(async () => (await state(page))?.text === "", 3_000))
      await focusEnd(page)
      if (since) {
        await typeFast(page, since)
        await sleep(400)
      }
      await chord(page, ["Control", "Alt"], "Enter") // ⌘⌥↵ off a Mac: into the mode, empty (M5) or refused (M4)
      await sleep(since ? 900 : 300)
      assert.equal((await state(page))!.send, "schedule", `${JSON.stringify(since)}: in the mode before Undo`)
      await page.click('[data-toast-action="Undo"]')
      assert.ok(await waitFor(async () => (await counts(page)).deleteSchedule === 1, 3_000))
      assert.ok(await waitFor(async () => (await state(page))?.slot === "ledge", 3_000), `${JSON.stringify(since)}: the offer is back`)
      const s = (await state(page))!
      const restored = since ? `${PHRASE_TASK}\n\n${since}` : PHRASE_TASK
      assert.equal(s.text, restored)
      assert.notEqual(s.glyph, "on", "the mode is off")
      assert.equal(s.create, null, "no Create to press")
      assert.equal(s.send, "send")
      assert.equal(s.startNow, true)
      await focusEnd(page)
      await page.keyboard.press("Enter")
      assert.ok(await waitFor(async () => (await counts(page)).dispatch === 1, 3_000), `${JSON.stringify(since)}: Enter dispatched`)
      await sleep(300)
      const c = await counts(page)
      assert.equal(c.createSchedule, 1, `${JSON.stringify(since)}: the undone schedule was not created again`)
      assert.equal((await bodies(page, "dispatch"))[0]?.prompt, restored)
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  }
})

// undo-during-next-create: Undo of the last schedule, clicked while the next one is still in its RPC or wash,
// merged its words ABOVE the next one's; the next create's onCreated no longer found its own words at the
// start and kept them all, the mode off — the next Enter dispatched both texts.
test("29. Undo of the last schedule clicked while the next one creates: the next one's words leave, and only the undone ones come back", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open()
  try {
    await accept(page)
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => !!(await state(page))?.toast?.actions.includes("Undo"), 3_000))
    assert.ok(await waitFor(async () => (await state(page))?.text === "", 3_000))
    await focusEnd(page)
    await accept(page, "every Friday at 5pm post the summary")
    // The next create takes 1.5s, so the Undo below is clicked inside its flight — on the FIRST schedule's toast,
    // which a 0ms create plus the 220ms wash replaced before a loaded machine's click landed.
    await page.evaluate(() => { window.__sched.createDelayMs = 1_500 })
    await page.keyboard.press("Enter")
    assert.match((await state(page))!.toast?.text ?? "", /^Triage issues scheduled/, "the toast clicked is the first schedule's")
    await page.click('[data-toast-action="Undo"]')
    assert.ok(await waitFor(async () => (await counts(page)).deleteSchedule === 1, 1_000), "Undo deleted the first at once")
    await sleep(300)
    let mid = (await state(page))!
    assert.equal(mid.text, "every Friday at 5pm post the summary", "while the next one creates, its words are still its own")
    assert.equal(mid.send, "schedule")
    assert.ok(await waitFor(async () => (await counts(page)).createSchedule === 2, 3_000))
    assert.ok(await waitFor(async () => (await state(page))?.slot === "ledge", 3_000), "the undone words' offer")
    await sleep(300)
    mid = (await state(page))!
    const s = mid
    assert.match(s.toast?.text ?? "", /^Post summary scheduled/, "the next one was created")
    assert.equal(s.text, PHRASE_TASK, "the created words left; only the undone ones are back")
    assert.notEqual(s.glyph, "on")
    assert.equal(s.send, "send")
    await focusEnd(page)
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => (await counts(page)).dispatch === 1, 3_000))
    assert.equal((await bodies(page, "dispatch"))[0]?.prompt, PHRASE_TASK, "the thread carries the undone words alone")
    assert.equal((await counts(page)).createSchedule, 2)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

// reaim-during-wash: the box re-aimed (and so remounted, as AllQueues keys it by project) inside the create's
// RPC and 220ms wash. The carry took the words and their {on:true} to the other project; the create then
// cleared the OLD key, already empty, and the same schedule sat one Enter away in the new project's box.
test("30. a create in flight across a re-aim or a remount: its words leave from where they were created, and no box is left one Enter from a second", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open()
  try {
    await accept(page)
    // The create takes 1s, so the re-aim and the remount land inside its flight on any machine.
    await page.evaluate(() => { window.__sched.createDelayMs = 1_000 })
    await page.keyboard.press("Enter")
    await page.evaluate((dir) => { window.__sched.reaim(dir); window.__sched.remount() }, OTHER_PROJECT)
    await ready(page)
    assert.equal((await counts(page)).createSchedule, 1)
    assert.equal((await state(page))!.text, "", "the re-aimed box opens on the other project's own (empty) draft")
    assert.ok(await waitFor(async () => !!(await state(page))?.toast, 3_000))
    await sleep(600)
    let s = (await state(page))!
    assert.equal(s.text, "", "the other project's box is empty")
    assert.notEqual(s.glyph, "on")
    assert.equal(s.send, "send")
    assert.deepEqual(Object.keys(await draftEntries(page)).filter((k) => k.startsWith("dispatch")), [], "no draft left in either project")
    await focusEnd(page)
    await page.keyboard.press("Enter")
    await sleep(400)
    assert.equal((await counts(page)).createSchedule, 1, "Enter there created nothing")
    // (Enter on an empty box is the textarea's own newline; take it out before the box goes back.)
    await clearBox(page)

    // The same box remounted inside the wash (a layout pass, the incident's viewport change): it reads the
    // create in flight and does not create the same words a second time.
    await page.evaluate((dir) => window.__sched.reaim(dir), "/fixture/schedule-live")
    await sleep(300)
    await focusEnd(page)
    await accept(page)
    await page.keyboard.press("Enter")
    await page.evaluate(() => window.__sched.remount())
    await ready(page)
    s = (await state(page))!
    assert.equal(s.text, PHRASE_TASK, "remounted inside the flight: the words are still there…")
    assert.equal((await counts(page)).createSchedule, 2)
    await focusEnd(page)
    await page.keyboard.press("Enter")
    await sleep(300)
    assert.equal((await counts(page)).createSchedule, 2, "…and Enter there is not a second create")
    assert.ok(await waitFor(async () => (await state(page))?.text === "", 3_000), "the create's words leave the remounted box")
    await sleep(300)
    s = (await state(page))!
    assert.equal((await counts(page)).createSchedule, 2, "one create for one Enter, across the remount")
    assert.equal(s.text, "")
    assert.equal((await counts(page)).dispatch, 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

// relocate-blind-behind-punctuation: a model reading survived an edit that extended its condition after a
// comma — no second read, and the schedule was created with the old condition and the new words in its task.
test("31. a model reading is dropped by an edit that continues its clause past a comma, and kept by an edit to its task", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open()
  try {
    const P = "every day unless it's a holiday"
    await armModel(page, { phrase: P, rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0", dtstart: "2026-10-06T09:00", condition: "unless it's a holiday", title: "Post digest" })
    await accept(page, `${P}, post the digest`)
    assert.ok(await waitFor(async () => !!(await state(page))?.echo, 3_000), "the model's reading lands")
    assert.equal((await counts(page)).interpretSchedule, 1)
    // An edit to the task, after the comma: the reading stands, re-cut.
    await focusEnd(page)
    await typeFast(page, " to #eng")
    await sleep(1_200)
    let s = (await state(page))!
    assert.equal((await counts(page)).interpretSchedule, 1, "a task-only edit asks nothing again")
    assert.match(s.echo ?? "", /^Post digest · every day at 9am · unless it.s a holiday$/)
    assert.equal(s.each, "Each run: post the digest to #eng")
    // An edit that continues the condition past the comma: the reading goes, and the model reads it again.
    await armModel(page, { phrase: `${P}, or a weekend`, rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0", dtstart: "2026-10-06T09:00", condition: "unless it's a holiday or a weekend", title: "Post digest" })
    await page.evaluate((sel) => {
      const area = document.querySelector<HTMLTextAreaElement>(sel)!
      const i = area.value.indexOf(", post") + 2
      area.focus()
      area.setSelectionRange(i, i)
    }, ta(PAGE_BOX))
    await typeFast(page, "or a weekend, ", 60)
    assert.ok(await waitFor(async () => (await counts(page)).interpretSchedule === 2, 3_000), "the edited words went to the model")
    assert.ok(await waitFor(async () => /or a weekend$/.test((await state(page))?.echo ?? ""), 3_000), "and its new reading is on screen")
    s = (await state(page))!
    assert.equal(s.each, "Each run: post the digest to #eng")
    await focusEnd(page)
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => (await counts(page)).createSchedule === 1, 3_000))
    const body = (await bodies(page, "createSchedule"))[0]!
    assert.equal(body.condition, "unless it's a holiday or a weekend", "the created schedule carries the whole condition")
    assert.equal(body.prompt, "post the digest to #eng", "and none of it is left in the task")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

// dialog-hidden-box-rearms-dismissal: the page box under the `c` dialog got each of the dialog's keystrokes as
// a wholesale change — a publish point — so a typo fixed mid-word in the gate word (`every` → `ever` →
// `every`, never published by the dialog itself) read to it as the phrase deleted, and it wrote the re-armed
// dismissal back to the shared draft: the offer came back in the dialog.
test("32. in the `c` dialog a dismissed offer stays dismissed through a typo fixed in its gate word, and re-arms when the phrase is deleted there", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open()
  try {
    await page.evaluate(() => window.__sched.openDialog())
    await ready(page, DIALOG_BOX)
    await typeFast(page, PHRASE_TASK)
    assert.ok(await waitFor(async () => (await state(page, DIALOG_BOX))?.slot === "ledge", 3_000), "the offer in the dialog")
    await page.keyboard.press("Escape")
    await sleep(400)
    assert.ok(await page.$(DIALOG_BOX), "the claim kept the dialog")
    assert.equal((await state(page, DIALOG_BOX))!.open, false, "dismissed")
    await page.evaluate((sel) => {
      const area = document.querySelector<HTMLTextAreaElement>(sel)!
      area.focus()
      area.setSelectionRange(5, 5)
    }, ta(DIALOG_BOX))
    await page.keyboard.press("Backspace")
    await sleep(80)
    await page.keyboard.type("y")
    await sleep(1_200)
    let dlg = (await state(page, DIALOG_BOX))!
    assert.equal(dlg.text, PHRASE_TASK)
    assert.equal(dlg.open, false, "still dismissed: nobody deleted the phrase")
    assert.equal(dlg.glyph, "hint", "the glyph keeps the way back")
    const record = JSON.parse(Object.entries(await draftEntries(page)).find(([k]) => k.startsWith("dispatch-schedule:"))?.[1] ?? "{}") as { dismissed?: { open?: boolean } }
    assert.equal(record.dismissed?.open, true, "the shared draft still says so")
    // The control: the phrase deleted in the dialog itself re-arms the edge, as §8 says.
    await focusEnd(page, DIALOG_BOX)
    await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control")
    await page.keyboard.press("Backspace")
    await sleep(500)
    await typeFast(page, PHRASE_TASK)
    assert.ok(await waitFor(async () => (await state(page, DIALOG_BOX))?.slot === "ledge", 3_000), "deleted and retyped: offered again")
    dlg = (await state(page, DIALOG_BOX))!
    assert.equal(dlg.startNow, true)
    const c = await counts(page)
    assert.equal(c.dispatch + c.createSchedule, 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

// Undo after a re-aim (fix round 3, the orchestrator's case): the undone words go back to the project the
// schedule was created in, with the mode off; the box re-aimed elsewhere — its own text and mode — is not
// touched.
test("33. Undo after a re-aim restores into the schedule's own project with the mode off, and leaves the other box alone", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open()
  try {
    await accept(page)
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => !!(await state(page))?.toast?.actions.includes("Undo"), 3_000))
    assert.ok(await waitFor(async () => (await state(page))?.text === "", 3_000))
    const next = "every Friday at 4pm write the changelog"
    await focusEnd(page)
    await accept(page, next)
    await page.evaluate((dir) => window.__sched.reaim(dir), OTHER_PROJECT)
    await sleep(400)
    assert.equal((await state(page))!.send, "schedule", "the next schedule's mode went with its words")
    await page.click('[data-toast-action="Undo"]')
    assert.ok(await waitFor(async () => (await counts(page)).deleteSchedule === 1, 3_000))
    await sleep(600)
    let s = (await state(page))!
    assert.equal(s.text, next, "the box on screen keeps its own words…")
    assert.equal(s.glyph, "on", "…and its own mode: Undo is not about them")
    const store = await draftEntries(page)
    assert.equal(store[`dispatch:${encodeURIComponent("/fixture/schedule-live")}:new`], PHRASE_TASK, "the undone words are back where they were created")
    assert.equal(store[`dispatch-schedule:${encodeURIComponent("/fixture/schedule-live")}:new`], undefined, "with the mode off (the absent record)")
    // Back in that project, the undone words' offer, and Enter starts them.
    await page.evaluate(() => window.__sched.reaim("/fixture/schedule-live"))
    assert.ok(await waitFor(async () => (await state(page))?.slot === "ledge", 3_000))
    s = (await state(page))!
    assert.equal(s.text, PHRASE_TASK)
    assert.equal(s.send, "send")
    await focusEnd(page)
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => (await counts(page)).dispatch === 1, 3_000))
    assert.equal((await counts(page)).createSchedule, 1)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
