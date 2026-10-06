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

test("15. Undo of an older schedule never ends a mode entered since for new text (X1)", { skip: !baseUrl, timeout: 60_000 }, async () => {
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
    await sleep(500)
    const s = (await state(page))!
    assert.ok(s.text?.includes(PHRASE_TASK) && s.text.includes(next), `both texts kept: ${JSON.stringify(s.text)}`)
    assert.equal(s.glyph, "on", "the mode entered for the new text is still on")
    assert.equal(s.send, "schedule", "so Enter still says it schedules")
    await focusEnd(page)
    await page.keyboard.press("Enter")
    await sleep(600)
    assert.equal((await counts(page)).dispatch, 0, "Enter never dispatched the merged text")
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
