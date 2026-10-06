import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import test, { after, before } from "node:test"
import { SCHEDULE_SPACING_COPY } from "@frizz/shared"

// THE SCHEDULE IN THE WORDS, in the real prompt box (plans/schedule-live-reading.md, the 2026-10-06 design):
// there is no schedule button and no mode. A prompt with a schedule word in it is read by the model as it is
// typed; a schedule reading hangs a strip under the box and turns the send glyph ↻, and Enter — the only submit —
// creates it. The unit tests pin each piece (the read scheduler, the reader, the submit machine); this file pins
// what only a browser can: that the pieces, mounted together in <DispatchForm>, put the right thing on screen and
// on the wire for every branch — and never the other thing.
//
// Drives schedule-live-fixture (the real DispatchForm, the `c` dialog and the Toaster over a stubbed RPC seam
// that COUNTS dispatch, createLazyThread, createSchedule, deleteSchedule and interpretSchedule, at a fixed clock:
// Mon Oct 5 2026, 2:32pm New York). The model is the fixture's stub, armed per case with canned answers, delays,
// a gate that holds every answer until released, failures and calls that never answer.
//
// Skipped unless a Vite URL serving the fixtures is provided: start `vite` in packages/web and set
// FRIZZ_SCHEDULE_E2E_URL to its origin (scripts/e2e-web.mjs does both: `nub run test:e2e -- composerScheduleLive`).
// FRIZZ_SCHEDULE_SHOTS=<dir> also saves the evidence screenshots (intent-*.png) at the moments named below.
const baseUrl = process.env.FRIZZ_SCHEDULE_E2E_URL
const shotsDir = process.env.FRIZZ_SCHEDULE_SHOTS

const NY = "America/New_York"
const PAGE_BOX = `[data-dispatch-form]:not([role="dialog"] [data-dispatch-form])`
const DIALOG_BOX = `[role="dialog"] [data-dispatch-form]`
const ta = (box: string) => `${box} textarea[data-surface="newComposer"]`
const PHRASE = "every Monday at 9am"
const PHRASE_TASK = "every Monday at 9am triage new issues"
const MONDAY = { match: PHRASE, phrase: PHRASE, rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0", dtstart: "2026-10-12T09:00", title: "Triage issues" }
const READING = "Every Monday at 9am · next Mon Oct 12, in 6d"

type PuppeteerModule = typeof import("puppeteer")
type Browser = Awaited<ReturnType<PuppeteerModule["launch"]>>
type Page = Awaited<ReturnType<Browser["newPage"]>>
type Counts = Record<"dispatch" | "createLazyThread" | "createSchedule" | "deleteSchedule" | "interpretSchedule", number>
type Rule = { match: string; delayMs?: number } & Record<string, unknown>

let browser: Browser | undefined

before(async () => {
  if (!baseUrl) return
  if (shotsDir) mkdirSync(shotsDir, { recursive: true })
  const { default: puppeteer } = await import("puppeteer")
  browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb", "--use-mock-keychain"] })
})

after(async () => { await browser?.close() })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A fresh tab (so a fresh sessionStorage: drafts start empty), the box mounted and its profile known. */
async function open(opts: { width?: number; height?: number; phone?: boolean; dsf?: number } = {}) {
  const page = await browser!.newPage()
  page.setDefaultTimeout(30_000)
  await page.emulateTimezone(NY)
  await page.setViewport({
    width: opts.width ?? (opts.phone ? 360 : 1100),
    height: opts.height ?? (opts.phone ? 740 : 900),
    deviceScaleFactor: opts.dsf ?? (shotsDir ? 2 : 1),
    ...(opts.phone ? { isMobile: true, hasTouch: true } : {}),
  })
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }])
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !/404|502|favicon|Failed to load resource/i.test(m.text())) errors.push(m.text()) })
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

// A rAF loop that records every change of the page box's slot (open, what it shows, whether it is updating) and
// of its marks, with performance.now(): "the strip never opened" is then a fact about every frame, not a sample.
const INSTRUMENT = () => {
  type Frame = { t: number; open: boolean; slot: string | null; updating: boolean; marks: string }
  const w = window as unknown as { __live: { frames: Frame[] } }
  w.__live = { frames: [] }
  let last = ""
  const tick = () => {
    const form = document.querySelector('[data-dispatch-form]:not([role="dialog"] [data-dispatch-form])')
    const open = form?.querySelector("[data-schedule-slot-wrap]")?.hasAttribute("data-open") ?? false
    const slotEl = form?.querySelector("[data-schedule-slot]")
    const slot = open ? (slotEl?.getAttribute("data-schedule-slot") ?? null) : null
    const updating = slotEl?.hasAttribute("data-schedule-updating") ?? false
    const marks = [...(form?.querySelectorAll("[data-composer-mark]") ?? [])].map((m) => `${m.getAttribute("data-composer-mark")}:${m.textContent}`).join("|")
    const key = `${open}|${slot}|${updating}|${marks}`
    if (key !== last) {
      w.__live.frames.push({ t: performance.now(), open, slot, updating, marks })
      last = key
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}
type Frame = { t: number; open: boolean; slot: string | null; updating: boolean; marks: string }
const frames = (page: Page): Promise<Frame[]> => page.evaluate(() => (window as unknown as { __live: { frames: Frame[] } }).__live.frames)
const resetFrames = (page: Page) => page.evaluate(() => { (window as unknown as { __live: { frames: unknown[] } }).__live.frames = [] })

const counts = (page: Page): Promise<Counts> => page.evaluate(() => ({ ...window.__sched.counts }))
const bodies = (page: Page, name: keyof Counts): Promise<Record<string, unknown>[]> =>
  page.evaluate((n) => window.__sched.bodies[n].map((b) => ({ ...b })), name)
const arm = (page: Page, rules: Rule[]) => page.evaluate((r) => { window.__sched.rules = r as never }, rules)
const closeGate = (page: Page) => page.evaluate(() => { window.__sched.gate = true })
const release = (page: Page) => page.evaluate(() => window.__sched.release())

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
  const slot = q("[data-schedule-slot]")
  const send = q<HTMLButtonElement>("[data-composer-send]")
  const area = q<HTMLTextAreaElement>('textarea[data-surface="newComposer"]')
  const toast = document.querySelector<HTMLElement>("[data-toast]")
  // The reading row is clipped to one line and a segment that does not fit wraps below the clip, so only the
  // children on its first line are on screen.
  const reading = (() => {
    const row = q("[data-schedule-reading]")
    if (!row || !open) return null
    const bottom = row.getBoundingClientRect().top + 20
    const visible = (el: Element): string => {
      const kids = [...el.children]
      if (kids.length === 0) return el.getBoundingClientRect().top < bottom ? (el as HTMLElement).innerText : ""
      return kids.filter((c) => !c.hasAttribute("aria-hidden")).map(visible).join("")
    }
    return visible(row).replace(/\s+/g, " ").trim()
  })()
  return {
    text: area?.value ?? null,
    focused: document.activeElement === area,
    open,
    slot: open ? (slot?.getAttribute("data-schedule-slot") ?? null) : null,
    updating: open && (slot?.hasAttribute("data-schedule-updating") ?? false),
    reading,
    each: open ? text("[data-schedule-each]") : null,
    copy: open ? text("[data-schedule-copy]") : null,
    action: open ? (q("[data-schedule-action]")?.getAttribute("data-schedule-action") ?? null) : null,
    dismiss: open && !!q("[data-schedule-dismiss]"),
    send: send?.getAttribute("data-composer-send") ?? null,
    sendPending: send?.hasAttribute("data-composer-send-pending") ?? false,
    sendTitle: send?.title ?? null,
    marks: [...form.querySelectorAll("[data-composer-mark]")].map((m) => ({ tone: m.getAttribute("data-composer-mark"), text: m.textContent })),
    toast: toast ? { text: toast.innerText.replace(/\s+/g, " ").trim(), actions: [...toast.querySelectorAll("[data-toast-action]")].map((a) => a.getAttribute("data-toast-action")) } : null,
  }
}, box)
type State = NonNullable<Awaited<ReturnType<typeof state>>>
const marksOf = (s: State | null, tone: string) => (s?.marks ?? []).filter((m) => m.tone === tone).map((m) => m.text).join("|")

async function focusEnd(page: Page, box = PAGE_BOX) {
  await page.evaluate((s) => {
    const area = document.querySelector<HTMLTextAreaElement>(s)!
    area.focus()
    area.setSelectionRange(area.value.length, area.value.length)
  }, ta(box))
}
async function typeFast(page: Page, text: string, delay = 25) {
  for (const ch of text) {
    await page.keyboard.type(ch)
    await sleep(delay)
  }
}
const waitFor = async (pred: () => Promise<boolean>, ms: number, step = 40) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await pred()) return true
    await sleep(step)
  }
  return false
}
/** Type the words and wait for their FRESH schedule strip (read for exactly these words). */
async function scheduleShown(page: Page, text = PHRASE_TASK, box = PAGE_BOX) {
  await typeFast(page, text)
  assert.ok(
    await waitFor(async () => { const s = await state(page, box); return s?.slot === "schedule" && !s.updating && s.send === "schedule" }, 6_000),
    `a schedule strip for ${JSON.stringify(text)}: ${JSON.stringify(await state(page, box))}`,
  )
}
/** Save the region around the box (and the toast, when there is one) as `name`, when shots are asked for.
 *  `sweepAtMs` holds the shimmer at that point of its 2.2s sweep for the shot: a still otherwise catches the bright
 *  band wherever it happens to be, often off the words, and the updating strip reads as a fresh one. */
async function shot(page: Page, name: string, box = PAGE_BOX, sweepAtMs?: number) {
  if (!shotsDir) return
  // Let the slot finish opening before measuring it: a clip measured mid-transition cut the Undo line in half.
  // Only animations that END are awaited; the shimmer and the spinner run forever and are the point of the shot.
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
    .map((a) => a.finished.catch(() => undefined))))
  if (sweepAtMs !== undefined) {
    await page.evaluate((ms) => {
      for (const a of document.getAnimations()) {
        if ((a as CSSAnimation).animationName !== "shimmer-sweep") continue
        a.pause()
        a.currentTime = ms
      }
    }, sweepAtMs)
  }
  const rect = await page.evaluate((sel) => {
    const form = document.querySelector(sel)!.getBoundingClientRect()
    const toast = document.querySelector("[data-toast]")?.getBoundingClientRect()
    const top = Math.max(0, form.top - 16)
    const bottom = Math.max(form.bottom, toast?.bottom ?? 0) + 16
    const left = Math.max(0, Math.min(form.left, toast?.left ?? form.left) - 16)
    const right = Math.min(window.innerWidth, Math.max(form.right, toast?.right ?? 0) + 16)
    return { x: left, y: top, width: right - left, height: bottom - top }
  }, box)
  await page.screenshot({ path: join(shotsDir, `${name}.png`), clip: rect })
  if (sweepAtMs !== undefined) {
    await page.evaluate(() => { for (const a of document.getAnimations()) if ((a as CSSAnimation).animationName === "shimmer-sweep") a.play() })
  }
}

test("1. no schedule word: the box looks as it always has, asks the model nothing, and Enter dispatches", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open()
  try {
    await typeFast(page, "fix the flaky checkout test")
    await sleep(900)
    const seen = await frames(page)
    assert.ok(seen.length >= 1, "the instrument recorded the box")
    assert.deepEqual(seen.filter((f) => f.open || f.marks), [], "no strip and no mark in any frame")
    const s = (await state(page))!
    assert.equal(s.send, "send")
    assert.equal((await counts(page)).interpretSchedule, 0, "no model call")
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => (await counts(page)).dispatch === 1, 3_000), "Enter dispatched")
    assert.deepEqual({ ...(await counts(page)), dispatch: 1 }, { dispatch: 1, createLazyThread: 0, createSchedule: 0, deleteSchedule: 0, interpretSchedule: 0 })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("2. a schedule word that is not a schedule: never a strip, only a faint dash that fades in late, and Enter dispatches", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open()
  try {
    // The model answers "no schedule" for everything, slowly enough to see what shows while it reads.
    await arm(page, [{ match: "morning", delayMs: 2_000 } as Rule])
    await typeFast(page, "fix the bug from this morning ")
    await sleep(250)
    const early = await page.evaluate((sel) => {
      const m = document.querySelector(`${sel} [data-composer-mark="pending"]`)
      return m ? { text: m.textContent, opacity: Number(getComputedStyle(m).opacity) } : null
    }, PAGE_BOX)
    assert.equal(early?.text, "morning", "the cue sits on the schedule word itself")
    assert.ok(early!.opacity < 0.05, `inside its 900ms delay the cue is invisible: ${early!.opacity}`)
    await sleep(1_100)
    const late = await page.evaluate((sel) => Number(getComputedStyle(document.querySelector(`${sel} [data-composer-mark="pending"]`)!).opacity), PAGE_BOX)
    assert.ok(late > 0.95, `a read still out after 900ms shows the faint dash: ${late}`)
    await shot(page, "intent-pending")
    assert.ok(await waitFor(async () => (await state(page))!.marks.length === 0, 4_000), "the answer of no schedule takes the cue away")
    await sleep(300)
    const all = await frames(page)
    assert.deepEqual(all.filter((f) => f.open), [], "the strip never opened, in any frame")
    assert.deepEqual([...new Set(all.map((f) => f.marks).filter(Boolean))], ["pending:morning"], "the only mark ever drawn was the pending cue")
    assert.equal((await state(page))!.send, "send")
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => (await counts(page)).dispatch === 1, 3_000), "Enter dispatched at once: the answer was in hand")
    assert.equal((await counts(page)).createSchedule, 0)
    assert.equal((await bodies(page, "dispatch"))[0]?.prompt, "fix the bug from this morning")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("3. a schedule: the phrase marked, the strip with its rule, next run and Each run, ↻ on send; Enter creates it", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open({ width: 1440 })
  try {
    await arm(page, [MONDAY])
    await scheduleShown(page)
    const s = (await state(page))!
    assert.equal(s.reading, READING)
    assert.equal(s.each, "Each run: triage new issues")
    assert.equal(marksOf(s, "accepted"), PHRASE, "the phrase wears the highlight")
    assert.equal(s.send, "schedule")
    assert.equal(s.sendTitle, "Create schedule (Enter)")
    assert.ok(s.dismiss, "× on the strip")
    const c = await counts(page)
    // At most one per finished word plus the idle at the end — and never two out at once.
    assert.ok(c.interpretSchedule >= 1 && c.interpretSchedule <= 7, `reads: ${c.interpretSchedule}`)
    assert.equal(await page.evaluate(() => window.__sched.maxInFlight), 1, "single flight, on the wire")
    await shot(page, "intent-reading-1440")

    await focusEnd(page)
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => (await counts(page)).createSchedule === 1, 3_000), "Enter created")
    const body = (await bodies(page, "createSchedule"))[0]!
    assert.equal(body.rrule, MONDAY.rrule)
    assert.equal(body.dtstart, MONDAY.dtstart)
    assert.equal(body.prompt, "triage new issues")
    assert.equal(body.whenText, PHRASE)
    assert.equal(body.title, "Triage issues", "the model's title")
    assert.equal(body.titleAuto, undefined, "a title the model gave is not renamed")
    assert.equal(body.tz, NY)
    assert.equal(body.source, undefined)
    assert.ok(await waitFor(async () => !!(await state(page))?.toast, 3_000), "the toast")
    const done = (await state(page))!
    assert.match(done.toast!.text, /^Triage issues scheduled Every Monday at 9am · next Mon Oct 12, in 6d/)
    assert.deepEqual(done.toast!.actions, ["Undo", "Open"])
    assert.equal(done.text, "", "the box cleared")
    assert.equal(done.send, "send")
    assert.ok(await page.$("[data-sched-flash]"), "the project row's count is told to flash")
    assert.equal((await counts(page)).dispatch, 0, "nothing dispatched")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("4. a reading the model gave no title: the box's provisional title, with titleAuto for the namer", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open()
  try {
    await arm(page, [{ ...MONDAY, title: "Scheduled run" }])
    await scheduleShown(page)
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => (await counts(page)).createSchedule === 1, 3_000))
    const body = (await bodies(page, "createSchedule"))[0]!
    assert.equal(body.title, "Triage issues")
    assert.equal(body.titleAuto, true)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("5. stale-while-revalidate: newer words keep the strip, marked updating, and it updates IN PLACE; a none answer takes it away", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open()
  try {
    await arm(page, [MONDAY])
    await scheduleShown(page, "every Monday at 9am triage")
    assert.equal((await state(page))!.each, "Each run: triage")
    await page.evaluate((sel) => { (document.querySelector(`${sel} [data-schedule-slot]`) as HTMLElement & { __tag?: string }).__tag = "first" }, PAGE_BOX)
    await resetFrames(page)
    await closeGate(page)
    await typeFast(page, " new issues")
    await sleep(500)
    const mid = (await state(page))!
    assert.equal(mid.slot, "schedule", "the strip stays while the new words are read")
    assert.equal(mid.updating, true, "marked as updating")
    assert.equal(mid.reading, READING)
    assert.equal(mid.each, "Each run: triage new issues", "Each run follows the words as they are typed")
    assert.equal(mid.send, "schedule")
    assert.equal(marksOf(mid, "accepted"), PHRASE, "the mark stays on the phrase")
    await sleep(300)
    assert.equal(
      await page.evaluate((sel) => document.querySelector(`${sel} [data-schedule-reading]`)!.className.includes("shimmer-text"), PAGE_BOX),
      true,
      "the reading shimmers once the wait is worth showing",
    )
    // 715ms into the sweep the bright band crosses the reading's words, about a third of the way along the row.
    await shot(page, "intent-updating", PAGE_BOX, 715)
    await release(page)
    assert.ok(await waitFor(async () => { const s = await state(page); return s?.slot === "schedule" && !s.updating }, 4_000), "the new answer lands")
    assert.equal(
      await page.evaluate((sel) => (document.querySelector(`${sel} [data-schedule-slot]`) as HTMLElement & { __tag?: string }).__tag, PAGE_BOX),
      "first",
      "the same strip element: updated in place, never slid out and in",
    )
    const during = await frames(page)
    assert.ok(during.some((f) => f.updating), "the instrument saw the updating state")
    assert.deepEqual(during.filter((f) => !f.open), [], "the slot never closed while the words were re-read")

    // The model now finds no schedule in the words: the strip leaves, and ↻ with it.
    await arm(page, [])
    await typeFast(page, " today")
    assert.ok(await waitFor(async () => !(await state(page))!.open, 4_000), "an answer of no schedule takes the strip away")
    const after = (await state(page))!
    assert.equal(after.send, "send")
    assert.equal(marksOf(after, "accepted"), "")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("6. Enter with no answer for these words yet HOLDS: the send spins, a line says so, and the answer decides", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open()
  try {
    // (a) The answer is a schedule: created, never dispatched.
    await arm(page, [MONDAY])
    await closeGate(page)
    await typeFast(page, PHRASE_TASK)
    await page.keyboard.press("Enter")
    await sleep(80)
    let s = (await state(page))!
    assert.equal(s.sendPending, true, "the send spins at once")
    assert.equal(s.sendTitle, "Checking for a schedule…")
    assert.notEqual(s.slot, "hold", "the line waits a beat, so an answer on its way never flashes it")
    await sleep(400)
    s = (await state(page))!
    assert.equal(s.slot, "hold")
    assert.equal(s.copy, "Checking for a schedule…")
    assert.equal(s.text, PHRASE_TASK, "the words stay in the box")
    await shot(page, "intent-hold")
    assert.deepEqual([(await counts(page)).dispatch, (await counts(page)).createSchedule], [0, 0], "nothing yet")
    await release(page)
    assert.ok(await waitFor(async () => (await counts(page)).createSchedule === 1, 4_000), "the schedule answer created it")
    assert.equal((await counts(page)).dispatch, 0)

    // (b) The answer is no schedule: started now, nothing created.
    await page.evaluate(() => window.__sched.reset())
    await arm(page, [])
    await sleep(400)
    await focusEnd(page)
    await closeGate(page)
    await typeFast(page, "every time CI fails, fix it")
    await page.keyboard.press("Enter")
    await sleep(500)
    assert.equal((await state(page))!.slot, "hold")
    await release(page)
    assert.ok(await waitFor(async () => (await counts(page)).dispatch === 1, 4_000), "no schedule: dispatched")
    assert.equal((await counts(page)).createSchedule, 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("7. typing during the hold cancels it; nothing runs on the old words' answer; Enter again submits", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open()
  try {
    await arm(page, [MONDAY])
    await closeGate(page)
    await typeFast(page, PHRASE_TASK)
    await page.keyboard.press("Enter")
    await sleep(400)
    assert.equal((await state(page))!.slot, "hold")
    await typeFast(page, "!")
    await sleep(100)
    const s = (await state(page))!
    assert.equal(s.sendPending, false, "the hold is cancelled")
    assert.notEqual(s.slot, "hold")
    await release(page)
    await sleep(800)
    assert.deepEqual([(await counts(page)).dispatch, (await counts(page)).createSchedule], [0, 0], "the old words' answer acted on nothing")
    assert.ok(await waitFor(async () => { const n = await state(page); return n?.slot === "schedule" && !n.updating }, 4_000), "the new words are read")
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => (await counts(page)).createSchedule === 1, 3_000), "Enter again created")
    assert.equal((await bodies(page, "createSchedule"))[0]!.prompt, "triage new issues!")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("8. a read that fails at submit never dispatches silently: the line, and the NEXT Enter dispatches", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open()
  try {
    // Two drafts, one per way a check fails: the model's own error, and the request never reaching it.
    for (const [fail, task] of [["model", "and label them"], ["http", "and close dupes"]] as const) {
      await page.evaluate(() => window.__sched.reset())
      await arm(page, [{ match: "every Monday", fail } as Rule])
      await closeGate(page)
      await typeFast(page, `${PHRASE_TASK} ${task}`)
      await page.keyboard.press("Enter")
      await sleep(300)
      await release(page)
      assert.ok(await waitFor(async () => (await state(page))?.slot === "failed", 4_000), `${fail}: the failure line`)
      const s = (await state(page))!
      assert.equal(s.copy, "Couldn't check for a schedule. Enter starts it now.")
      assert.equal(s.action, "Try again")
      assert.equal(s.send, "send")
      assert.deepEqual([(await counts(page)).dispatch, (await counts(page)).createSchedule], [0, 0], `${fail}: nothing started`)
      if (fail === "model") await shot(page, "intent-failed")
      await focusEnd(page)
      await page.keyboard.press("Enter")
      assert.ok(await waitFor(async () => (await counts(page)).dispatch === 1, 3_000), `${fail}: the next Enter dispatched`)
      assert.equal((await counts(page)).createSchedule, 0)
      await sleep(400)
    }
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("9. a check that never answers gives up after 15s: the failure line, then Enter dispatches", { skip: !baseUrl, timeout: 90_000 }, async () => {
  const { page, errors } = await open()
  try {
    await arm(page, [{ match: "every Monday", hang: true } as Rule])
    await typeFast(page, PHRASE_TASK)
    const pressed = Date.now()
    await page.keyboard.press("Enter")
    await sleep(1_000)
    assert.equal((await state(page))!.slot, "hold")
    assert.ok(await waitFor(async () => (await state(page))?.slot === "failed", 20_000), "the failure line")
    const waited = Date.now() - pressed
    assert.ok(waited >= 14_000 && waited <= 17_500, `gave up after ~15s: ${waited}ms`)
    assert.deepEqual([(await counts(page)).dispatch, (await counts(page)).createSchedule], [0, 0])
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => (await counts(page)).dispatch === 1, 3_000), "the next Enter dispatched")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("10. × and Esc say \"not a schedule\": the strip leaves, ↻ goes, Enter starts it now — and it survives a reload", { skip: !baseUrl, timeout: 90_000 }, async () => {
  const { page, errors } = await open()
  try {
    await arm(page, [MONDAY])
    await scheduleShown(page)
    await page.click(`${PAGE_BOX} [data-schedule-dismiss]`)
    assert.ok(await waitFor(async () => !(await state(page))!.open, 2_000), "× took the strip away")
    let s = (await state(page))!
    assert.equal(s.send, "send")
    assert.equal(marksOf(s, "accepted"), "")
    assert.equal(s.focused, true, "the caret stayed in the box")

    // A reload: the dismissal is the draft's, so the same words read again stay dismissed.
    await page.reload({ waitUntil: "networkidle0" })
    await arm(page, [MONDAY])
    await ready(page)
    await sleep(1_500)
    s = (await state(page))!
    assert.equal(s.text, PHRASE_TASK)
    assert.equal(s.open, false, "still dismissed after the reload")
    assert.equal(s.send, "send")
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => (await counts(page)).dispatch === 1, 4_000), "Enter started it now")
    assert.equal((await counts(page)).createSchedule, 0)

    // Esc, on a new draft: the same, and the caret stays.
    await sleep(400)
    await focusEnd(page)
    await scheduleShown(page, "every Monday at 9am post the digest")
    await page.keyboard.press("Escape")
    assert.ok(await waitFor(async () => !(await state(page))!.open, 2_000), "Esc took the strip away")
    assert.equal((await state(page))!.focused, true, "and kept the caret in the box")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("11. Undo: deleted, the words back with their reading dismissed — Enter starts them now — and Schedule it takes that back", { skip: !baseUrl, timeout: 90_000 }, async () => {
  const { page, errors } = await open()
  try {
    await arm(page, [MONDAY])
    await scheduleShown(page)
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => !!(await state(page))?.toast?.actions.includes("Undo"), 3_000))
    await page.click('[data-toast-action="Undo"]')
    assert.ok(await waitFor(async () => (await counts(page)).deleteSchedule === 1, 3_000), "the schedule is deleted")
    assert.ok(await waitFor(async () => (await state(page))?.slot === "undone", 3_000), "the Undo line")
    let s = (await state(page))!
    assert.equal(s.text, PHRASE_TASK, "the words came back")
    assert.equal(s.copy, "Schedule undone. Enter starts it now.")
    assert.equal(s.action, "Schedule it")
    assert.equal(s.send, "send", "Enter starts it now: no ↻")
    await shot(page, "intent-undone")

    // Schedule it, after all: the strip is back, and Enter creates.
    await page.click(`${PAGE_BOX} [data-schedule-action="Schedule it"]`)
    assert.ok(await waitFor(async () => (await state(page))?.slot === "schedule", 2_000), "Schedule it brings the strip back")
    s = (await state(page))!
    assert.equal(s.send, "schedule")
    await focusEnd(page)
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => (await counts(page)).createSchedule === 2, 3_000), "created again")

    // Undo again, and this time Enter starts it now.
    assert.ok(await waitFor(async () => !!(await state(page))?.toast?.actions.includes("Undo"), 3_000))
    await page.click('[data-toast-action="Undo"]')
    assert.ok(await waitFor(async () => (await state(page))?.slot === "undone", 3_000))
    await focusEnd(page)
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => (await counts(page)).dispatch === 1, 3_000), "dispatched")
    assert.equal((await counts(page)).createSchedule, 2, "and nothing more created")
    assert.equal((await bodies(page, "dispatch"))[0]!.prompt, PHRASE_TASK, "the whole text is the thread's prompt")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("12. a refusal (too frequent) says so with what Enter does; Enter starts it now", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open()
  try {
    await arm(page, [{ match: "every 5 minutes", refuse: SCHEDULE_SPACING_COPY } as Rule])
    await typeFast(page, "every 5 minutes check the deploy")
    assert.ok(await waitFor(async () => (await state(page))?.slot === "refused", 4_000))
    const s = (await state(page))!
    assert.equal(s.copy, `${SCHEDULE_SPACING_COPY} Enter starts it now.`)
    assert.equal(s.send, "send")
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => (await counts(page)).dispatch === 1, 3_000))
    assert.equal((await counts(page)).createSchedule, 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("13. the `c` dialog over the page box: one read per text for both boxes; its first Esc dismisses the strip and keeps the dialog", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open()
  try {
    await arm(page, [MONDAY])
    await page.evaluate(() => window.__sched.openDialog())
    await ready(page, DIALOG_BOX)
    await scheduleShown(page, PHRASE_TASK, DIALOG_BOX)
    await sleep(800)
    const texts = (await bodies(page, "interpretSchedule")).map((b) => b.text as string)
    assert.equal(new Set(texts).size, texts.length, `no text read twice (the page box shares the dialog's reader): ${JSON.stringify(texts)}`)
    assert.equal((await state(page, DIALOG_BOX))!.reading, READING)
    await page.keyboard.press("Escape")
    assert.ok(await waitFor(async () => !(await state(page, DIALOG_BOX))?.open, 2_000), "the first Esc dismissed the strip")
    assert.ok(await page.$(DIALOG_BOX), "and kept the dialog")
    await page.keyboard.press("Escape")
    assert.ok(await waitFor(async () => !(await page.$(DIALOG_BOX)), 2_000), "the next Esc closed the dialog")
    assert.equal((await state(page))!.open, false, "the page box shares the dismissal")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("14. the phone: the strip is a tap row with ×, its lines name Send, and × dismisses", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open({ phone: true, dsf: shotsDir ? 3 : 1 })
  try {
    await arm(page, [MONDAY])
    await scheduleShown(page)
    const s = (await state(page))!
    assert.match(s.reading ?? "", /^Every Monday at 9am/)
    assert.equal(s.sendTitle, "Create schedule")
    const close = await page.evaluate((sel) => {
      const button = document.querySelector(`${sel} [data-schedule-dismiss]`)!
      const r = button.getBoundingClientRect()
      const ink = button.querySelector("svg")!.getBoundingClientRect()
      const slot = document.querySelector(`${sel} [data-schedule-slot]`)!.getBoundingClientRect()
      return { w: r.width, h: r.height, inside: ink.right <= slot.right - 1 && ink.left >= slot.left }
    }, PAGE_BOX)
    assert.ok(close.w >= 32 && close.h >= 32, `a 32px tap square: ${JSON.stringify(close)}`)
    assert.ok(close.inside, "its ink inside the strip")
    await shot(page, "intent-phone-360")
    await page.tap(`${PAGE_BOX} [data-schedule-dismiss]`)
    assert.ok(await waitFor(async () => !(await state(page))!.open, 2_000), "× dismissed")

    // The phone's failure line names the send button, never a key.
    await arm(page, [{ match: "every Friday", fail: "model" } as Rule])
    await page.evaluate((sel) => {
      const area = document.querySelector<HTMLTextAreaElement>(sel)!
      area.focus()
      area.setSelectionRange(0, area.value.length)
    }, ta(PAGE_BOX))
    await typeFast(page, "every Friday at 5pm post the digest")
    await page.tap(`${PAGE_BOX} [data-composer-send]`)
    assert.ok(await waitFor(async () => (await state(page))?.slot === "failed", 4_000))
    assert.equal((await state(page))!.copy, "Couldn't check for a schedule. Send starts it now.")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("15. the budget: 40 automatic reads per draft, then only a submit reads", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { page, errors } = await open()
  try {
    await arm(page, [{ match: "every", delayMs: 5 } as Rule])
    // 80 finished words, every one of them a new text with a schedule word in it — more than enough boundaries to
    // spend the budget even where a fast typist's boundaries share one queued read.
    const words = Array.from({ length: 80 }, (_, i) => `w${i}`).join(" ")
    await typeFast(page, `every ${words} `, 8)
    await sleep(1_500)
    assert.equal((await counts(page)).interpretSchedule, 40, "the 41st automatic read is not sent")
    await page.keyboard.press("Enter")
    assert.ok(await waitFor(async () => (await counts(page)).dispatch === 1, 4_000), "Enter read once more and dispatched")
    assert.equal((await counts(page)).interpretSchedule, 41)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
