#!/usr/bin/env node
// Check, against a REAL two-project Frizz seeded by scripts/seed-queue-stays-put.mjs, the guarantee the
// maintainer asked for on 2026-09-28: "it needs to be guaranteed that cards that I'm currently viewing on
// the screen don't move in their position."
//
// Every scenario measures every card on screen (and the sidebar's prompt box) before and after one thing
// that is NOT the human's doing — a thread arriving (at the bottom of the page, oldest-first or
// newest-first alike), a thread on screen or above it waking itself and resting
// again, a card marked done from another window, an arrival while the human types in a card, an arrival
// behind an open drawer — and fails if any of them moved by a pixel or more. Then the human's own moves
// that must not move anything either: opening a card's drawer and closing it, "Show more" (the card grows
// DOWN), and a reload (the page comes back on the card that was being read). (Not zero: a scroll
// offset snaps to whole device pixels, so a correction by a fractional height leaves up to half a device
// pixel, which no display can draw. Every move is printed exactly.) The page is also sampled after every
// painted frame in between, so a jump corrected a frame later is reported too. A card whose OWN thread
// spoke again is exempt from its own measurement — new words are a new height — but not from anyone
// else's: the card the human is on holds still, and it is the one that spoke that gives.
// Runs on Everything (lib/stableQueue.ts + lib/viewportLock.ts in AllQueues.tsx), the one queue page.
//
// Usage: node scripts/verify-queue-stays-put.mjs --stack=/abs/stack.log --seed='<SEED json>' [--shots=/abs/dir]
// On a freshly seeded stack: the seeded running threads last only a few minutes (see below).
// Exits non-zero when any check fails.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import puppeteer from "puppeteer"
import { createRpcClient } from "./lib/rpc-client.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => { const s = a.slice(2); const i = s.indexOf("="); return i < 0 ? [s, true] : [s.slice(0, i), s.slice(i + 1)] }),
)
if (!flags.stack || !flags.seed) {
  console.error("usage: node scripts/verify-queue-stays-put.mjs --stack=/abs/stack.log --seed='<json>' [--shots=/abs/dir]")
  process.exit(1)
}
const stack = JSON.parse(readFileSync(flags.stack, "utf8").split("\n").find((l) => l.startsWith("{\"url\"")))
const seed = JSON.parse(flags.seed)
const origin = new URL(stack.url).origin
const shots = flags.shots ?? join(process.cwd(), ".adhoc-shots")
mkdirSync(shots, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`)
}

// ---- the threads' transcripts ------------------------------------------------------------------------
let serial = 0
function record(key, fields) {
  const s = seed.sessions[key]
  serial++
  appendFileSync(s.jsonl, `${JSON.stringify({ parentUuid: null, isSidechain: false, session_id: s.sessionId, cwd: s.cwd, uuid: `00000000-0000-4000-9000-9${String(serial).padStart(11, "0")}`, timestamp: new Date().toISOString(), ...fields })}\n`)
}
// A turn silent for 15 minutes surfaces in the queue on its own (board.ts QUIET_TURN_MS), so a seeded
// running thread stays running only for a few minutes (a stand-in daemon is not a broker, and the server
// soon calls the turn stalled): the scenarios that need one run first, on a freshly seeded stack.
// The agent comes to rest, saying exactly what it said last time: same card, same height.
const rest = (key) => record(key, {
  type: "assistant",
  message: { model: "claude-opus-5", id: `msg_again_${serial}`, type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: seed.sessions[key].handoff }], usage: { input_tokens: 2, output_tokens: 200 } },
})
// What Frizz writes when a finished shell wakes the worker: nobody touched the thread.
const wake = (key) => record(key, { type: "user", message: { role: "user", content: `⏰ Your background shell finished: \`bsh${serial}\` — tests.\n\n<!-- frizz-wake:selfwake${serial} -->` } })
// Marked done from ANOTHER window: the RPC, straight from here, not through the page.
const doneElsewhere = (key) => createRpcClient(`${origin}/`, seed.sessions[key].project).mutate("setThreadState", { slug: seed.sessions[key].slug, state: "archived" })

// ---- the page ---------------------------------------------------------------------------------------
const EVERYTHING = { name: "Everything", url: `${origin}/`, cards: "[data-xq-card]", key: "xqCard" }
const PROMPT = '[data-dispatch-form] textarea'

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--force-color-profile=srgb"] })
let failed = true
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 })
  const errors = []
  page.on("pageerror", (error) => errors.push(`pageerror: ${error}`))
  await page.evaluateOnNewDocument(() => document.addEventListener("DOMContentLoaded", () => document.documentElement.setAttribute("data-font", "sans")))

  let surface = EVERYTHING
  const open = async (target, order) => {
    surface = target
    await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.evaluate((order) => {
      const stored = JSON.parse(localStorage.getItem("frizz.prefs.v1") ?? "{}")
      localStorage.setItem("frizz.prefs.v1", JSON.stringify({ ...stored, queueOrder: order }))
    }, order)
    // This reload is the harness starting over, not the reader's: drop the note the viewport lock writes
    // on the way out, so the page does not come back on the card last read (its own scenario checks that).
    await page.evaluate(() => window.addEventListener("pagehide", () => sessionStorage.removeItem("frizz.queueReading.v1")))
    await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.waitForSelector(target.cards, { timeout: 30_000 })
    await sleep(2500)
  }

  // Every card's key, top, on-screen-ness and ghostliness, in DOM order; the prompt box; the offset.
  const snap = () => page.evaluate((cards, key, prompt) => {
    const vh = window.innerHeight
    const list = [...document.querySelectorAll(cards)].map((el) => {
      const r = el.getBoundingClientRect()
      const ghost = el.hasAttribute("data-queue-ghost")
      return { key: el.dataset[key], top: r.top, bottom: r.bottom, visible: r.bottom > 0 && r.top < vh, ghost, text: ghost ? el.innerText.slice(0, 300) : "" }
    })
    const box = [...document.querySelectorAll(prompt)].find((el) => !el.closest('[role="dialog"]'))
    const focused = document.activeElement
    return {
      list,
      prompt: box ? box.getBoundingClientRect().top : null,
      focus: focused && focused.tagName === "TEXTAREA" ? { top: focused.getBoundingClientRect().top, value: focused.value } : null,
      scrollY: window.scrollY,
    }
  }, surface.cards, surface.key, PROMPT)
  const slugOf = (key) => key.split("/").at(-1)
  const find = (s, slug) => s.list.find((card) => slugOf(card.key) === slug)
  const order = (s) => s.list.map((card) => `${slugOf(card.key)}${card.ghost ? "(ghost)" : ""}`).join(" ")

  // Nothing moving for half a second: the page has settled before a measurement starts.
  async function settle() {
    let last = JSON.stringify((await snap()).list.map((c) => Math.round(c.top)))
    for (let i = 0; i < 40; i++) {
      await sleep(250)
      const now = JSON.stringify((await snap()).list.map((c) => Math.round(c.top)))
      if (now === last) return
      last = now
    }
  }

  // In every frame, AS IT IS PAINTED, how far each card that was on screen has strayed from where it was.
  // Read in a ResizeObserver callback, because that is the last thing a frame runs before it paints —
  // after the viewport lock's own ResizeObserver (observers run in the order they were made, and the
  // lock's was made when the page mounted), so a change the lock corrects before paint is not counted,
  // and one it misses is. A task-timed sample would also catch the layout BETWEEN a card's re-render and
  // the frame that corrects it, which no one ever sees. A throwaway fixed box resized every frame makes
  // the observer fire every frame without changing the page's own layout.
  const startSampler = (tracked) => page.evaluate((cards, key, tracked) => {
    const sampler = { max: 0, worst: null, frames: 0, stop: false }
    window.__stay = sampler
    const probe = document.createElement("div")
    probe.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none"
    document.body.appendChild(probe)
    // The frame the worst move was painted in, and the one before it: every card's top/height and the
    // offset, so a failure says what moved rather than only how far.
    let last = ""
    const observer = new ResizeObserver(() => {
      if (sampler.stop) return
      sampler.frames++
      const frame = `y=${window.scrollY} ${[...document.querySelectorAll(cards)].map((el) => { const r = el.getBoundingClientRect(); return `${el.dataset[key].split("/").at(-1)}:${r.top.toFixed(1)}/${r.height.toFixed(0)}` }).join(" ")}`
      for (const el of document.querySelectorAll(cards)) {
        const was = tracked[el.dataset[key]]
        if (was === undefined) continue
        const off = Math.abs(el.getBoundingClientRect().top - was)
        if (off > sampler.max) { sampler.max = off; sampler.worst = el.dataset[key]; sampler.at = `frame ${sampler.frames - 1}: ${last} → frame ${sampler.frames}: ${frame}` }
      }
      last = frame
    })
    observer.observe(probe)
    let wide = false
    const tick = () => {
      if (sampler.stop) { observer.disconnect(); probe.remove(); return }
      wide = !wide
      probe.style.width = wide ? "2px" : "1px"
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, surface.cards, surface.key, tracked)
  const stopSampler = () => page.evaluate(() => { window.__stay.stop = true; return window.__stay })

  async function waitFor(what, predicate, ms = 30_000) {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      const s = await snap()
      if (predicate(s)) return s
      await sleep(150)
    }
    throw new Error(`timed out waiting for ${what}`)
  }

  const pointerAway = () => page.mouse.move(1395, 895)
  const pointerOn = async (slug) => {
    const s = await snap()
    const card = find(s, slug)
    const y = Math.min(Math.max(card.top, 0) + 60, 880)
    const x = await page.evaluate((cards, key, slug) => {
      const el = [...document.querySelectorAll(cards)].find((e) => e.dataset[key].split("/").at(-1) === slug)
      const r = el.getBoundingClientRect()
      return r.left + r.width / 2
    }, surface.cards, surface.key, slug)
    await page.mouse.move(x, y)
  }
  const scrollToY = (y) => page.evaluate((y) => window.scrollTo({ top: y, behavior: "instant" }), y)
  // Put the boundary between two cards in the middle of the screen, so both are on it.
  const straddle = async (upper, lower) => {
    const s = await snap()
    const at = find(s, lower).top + s.scrollY
    await scrollToY(Math.max(0, at - 450))
    await sleep(300)
    void upper
  }

  /**
   * One thing happens that the human did not do; nothing on screen may move. `act` does it, `until`
   * says when it has landed on the page, `expect` checks where it landed.
   */
  async function stays(name, { act, until, expect, spoke = [] }) {
    await settle()
    const before = await snap()
    const tracked = Object.fromEntries(before.list.filter((c) => c.visible && !spoke.includes(slugOf(c.key))).map((c) => [c.key, c.top]))
    await startSampler(tracked)
    await act()
    let after
    let sampled
    // The first frame in which the change is on the page: where it LANDED, before anything converged.
    let landed
    try {
      landed = await waitFor(name, until)
      await sleep(1500)
      after = await snap()
    } catch (error) {
      // It never landed the way it should (no ghost on a page that has none, say): a failure, not a crash,
      // so the rest of the run still reports.
      await stopSampler()
      check(`${surface.name}: ${name}`, false, `${error.message}; order ${order(await snap())}`)
      return { before, after: await snap() }
    } finally {
      sampled ??= await stopSampler().catch(() => ({ max: 0, frames: 0 }))
    }
    let worst = { key: null, by: 0 }
    const missing = []
    for (const card of before.list.filter((c) => c.visible)) {
      const now = after.list.find((c) => c.key === card.key)
      if (!now) { missing.push(slugOf(card.key)); continue }
      if (spoke.includes(slugOf(card.key))) continue
      const by = Math.abs(now.top - card.top)
      if (by > worst.by) worst = { key: slugOf(card.key), by }
    }
    // Nothing new may slide into view ABOVE the cards the reader was on either — a card's tail over the
    // first of them, where the top of the page was, is the "something popped in at the top" this guards.
    const firstTop = Math.min(...before.list.filter((c) => c.visible).map((c) => c.top))
    const appeared = after.list.filter((c) => c.visible && c.top < firstTop && !before.list.find((b) => b.key === c.key)?.visible).map((c) => slugOf(c.key))
    const promptMoved = before.prompt !== null && after.prompt !== null ? Math.abs(after.prompt - before.prompt) : 0
    const ok = worst.by < 1 && missing.length === 0 && appeared.length === 0 && promptMoved < 1 && (sampled.max < 1 || spoke.includes(slugOf(sampled.worst ?? "")))
    check(`${surface.name}: ${name}`, ok,
      `on screen before: ${before.list.filter((c) => c.visible).map((c) => slugOf(c.key)).join(" ")}; ` +
      `largest move ${worst.by.toFixed(2)}px${worst.key ? ` (${worst.key})` : ""}, in any frame ${sampled.max.toFixed(2)}px over ${sampled.frames} frames; ` +
      `prompt box ${promptMoved.toFixed(2)}px${missing.length ? `; GONE from screen: ${missing.join(" ")}` : ""}${appeared.length ? `; APPEARED above: ${appeared.join(" ")}` : ""}; ` +
      `order ${order(after)}; scrollY ${before.scrollY} → ${after.scrollY}` +
      (ok || !sampled.at ? "" : `\n      worst ${sampled.at}`))
    if (expect) expect(before, after, landed)
    return { before, after }
  }

  // ==== EVERYTHING ==================================================================================
  await open(EVERYTHING, "fifo")
  console.log(`Everything order: ${order(await snap())}`)
  await scrollToY(0)
  await pointerAway()
  await stays("the other project's arrival joins the bottom of the one queue", {
    act: () => rest("b/p2"),
    until: (s) => find(s, "p2"),
    expect: (_, after) => check("Everything: …and it is last", slugOf(after.list.at(-1).key) === "p2", order(after)),
  })
  // The arrivals first, while the seeded running threads still are: a stand-in daemon is not a broker, and
  // after a few minutes the server calls their turns stalled and queues them all on its own.
  await open(EVERYTHING, "lifo")
  await scrollToY(0)
  await pointerAway()
  await stays("newest first: an arrival sorting to the top of the page joins the bottom instead", {
    act: () => rest("a/r5"),
    until: (s) => find(s, "r5"),
    expect: (_, after, landed) => {
      check("Everything: …landing last", slugOf(landed.list.at(-1).key) === "r5", order(landed))
      check("Everything: …and staying there", slugOf(after.list.at(-1).key) === "r5", order(after))
    },
  })
  await stays("newest first: the other project's arrival joins the bottom too", {
    act: () => rest("b/p3"),
    until: (s) => find(s, "p3"),
    expect: (_, after) => check("Everything: …after the one before it", order(after).endsWith("r5 p3"), order(after)),
  })

  // Typing: the reply box of a card on screen holds the caret; an arrival must not move it.
  {
    const s = await snap()
    const card = s.list.find((c) => c.visible && !c.ghost)
    const box = `[data-xq-card="${card.key}"] [data-surface="queueComposer"]`
    await page.evaluate((box) => document.querySelector(box).scrollIntoView({ block: "center", behavior: "instant" }), box)
    await sleep(300)
    await page.click(box)
    await page.keyboard.type("a reply I am in the middle of writing")
    await pointerAway()
  }
  await stays("typing in a card's reply box: an arrival moves neither the box nor the caret", {
    act: () => rest("a/r3"),
    until: (s) => find(s, "r3"),
    expect: (before, after) =>
      check("Everything: …the box kept the keyboard and the text", after.focus !== null && before.focus !== null && Math.abs(after.focus.top - before.focus.top) < 0.5 && after.focus.value === "a reply I am in the middle of writing",
        `box ${before.focus?.top.toFixed(2)} → ${after.focus?.top.toFixed(2)}, "${after.focus?.value}"`),
  })
  await page.evaluate(() => document.activeElement?.blur())

  // A running thread's drawer over the queue: an arrival lands behind it, and closing it returns the
  // page as it was. A DOM click: puppeteer's own scrolls the row into view first, moving the page.
  {
    const s = await snap()
    await scrollToY(Math.max(0, s.list[2].top + s.scrollY - 120))
    await pointerAway()
    await settle()
    const beforeDrawer = await snap()
    await page.evaluate(() => document.querySelector('[data-sidebar-item="r6"] button').click())
    await page.waitForFunction(() => document.body.style.position === "fixed", { timeout: 10_000 })
    await sleep(800)
    rest("a/r4")
    // Landed behind the drawer, however long the server's read of the transcript takes.
    await waitFor("r4 behind the drawer", (s) => find(s, "r4") !== undefined).catch(() => {})
    await sleep(1500)
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => document.body.style.position !== "fixed", { timeout: 10_000 })
    await sleep(1500)
    const after = await snap()
    let worst = { key: null, by: 0 }
    for (const card of beforeDrawer.list.filter((c) => c.visible)) {
      const now = after.list.find((c) => c.key === card.key)
      const by = now ? Math.abs(now.top - card.top) : Infinity
      if (by > worst.by) worst = { key: slugOf(card.key), by }
    }
    check("Everything: an arrival behind an open drawer — closing it returns every card on screen to where it was",
      worst.by < 1 && find(after, "r4") !== undefined, `largest move ${worst.by.toFixed(2)}px${worst.key ? ` (${worst.key})` : ""}; scrollY ${beforeDrawer.scrollY} → ${after.scrollY}; order ${order(after)}`)
  }
  await open(EVERYTHING, "fifo")
  {
    const s = await snap()
    const [first, second] = s.list.map((c) => slugOf(c.key))
    await straddle(first, second)
    await pointerOn(second)
    const key = Object.keys(seed.sessions).find((k) => k.endsWith(`/${first}`))
    await stays("a card on screen that wakes itself stays where it is, as a ghost", {
      act: () => wake(key),
      until: (snapshot) => find(snapshot, first)?.ghost,
      expect: (_, after) => check("Everything: …saying it is back at work", find(after, first).text.includes("Back at work"), find(after, first).text.slice(0, 120)),
    })
    await page.screenshot({ path: join(shots, "everything-ghost.png") })
    await stays("…and when it rests again it is the card again, in the same place: the card under the pointer holds", {
      spoke: [first],
      act: () => rest(key),
      until: (snapshot) => find(snapshot, first) && !find(snapshot, first).ghost,
      expect: (_, after) => check("Everything: …still first in line", slugOf(after.list[0].key) === first, order(after)),
    })
  }
  // The human's own moves that must not move anything: a card's drawer opened over it and closed again.
  // Opened from a title already on screen: a click the browser has to scroll to first is not this test.
  {
    const s0 = await snap()
    // Not the first card: a drawer over a page at offset 0 proves nothing about keeping the offset.
    const pick = s0.list.find((c, index) => index > 0 && !c.ghost && c.key.startsWith(`${seed.a}/`))
    await scrollToY(Math.max(0, pick.top + s0.scrollY - 150))
    await sleep(400)
    const titles = await page.evaluate((a) => [...document.querySelectorAll("[data-xq-card]")]
      .filter((el) => el.dataset.xqCard.startsWith(`${a}/`) && !el.hasAttribute("data-queue-ghost"))
      .filter((el) => { const r = el.querySelector("h3 a")?.getBoundingClientRect(); return r && r.top >= 0 && r.bottom <= window.innerHeight })
      .map((el) => el.dataset.xqCard), seed.a)
    const s = await snap()
    const target = s.list.find((c) => c.key === titles[0])
    await pointerAway()
    await settle()
    const before = await snap()
    await page.click(`[data-xq-card="${target.key}"] h3 a`)
    await page.waitForFunction(() => document.body.style.position === "fixed", { timeout: 10_000 })
    await sleep(1200)
    const during = await snap()
    const duringTop = await page.evaluate(() => `${document.body.style.top}, concealed ${document.querySelectorAll("[data-queue-concealed]").length}, ${location.pathname}`)
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => document.body.style.position !== "fixed", { timeout: 10_000 })
    await sleep(1500)
    const after = await snap()
    const worstOf = (then) => {
      let worst = { key: null, by: 0 }
      for (const card of before.list.filter((c) => c.visible)) {
        const now = then.list.find((c) => c.key === card.key)
        const by = now ? Math.abs(now.top - card.top) : Infinity
        if (by > worst.by) worst = { key: slugOf(card.key), by }
      }
      return `${worst.by.toFixed(2)}px${worst.key ? ` (${worst.key})` : ""}`
    }
    const held = (then) => before.list.filter((c) => c.visible).every((card) => { const now = then.list.find((c) => c.key === card.key); return now && Math.abs(now.top - card.top) < 1 })
    const concealed = await page.evaluate((key) => document.querySelector(`[data-xq-card="${key}"]`)?.hasAttribute("data-queue-concealed"), target.key)
    check("Everything: opening a card's drawer and closing it again moves no card on screen",
      held(during) && held(after) && concealed === false, `drawer on ${slugOf(target.key)}: open ${worstOf(during)}, closed ${worstOf(after)}; scrollY ${before.scrollY} → ${during.scrollY} (body top ${duringTop}) → ${after.scrollY}; order ${order(after)}`)
  }

  // "Show more" grows the card DOWN: its top, and everything above it, stays put.
  {
    const s = await snap()
    const target = await page.evaluate(() => {
      const button = [...document.querySelectorAll('[data-xq-show-more][aria-expanded="false"]')].find((b) => { const r = b.getBoundingClientRect(); return r.top > 60 && r.bottom < window.innerHeight - 20 })
      if (!button) return null
      const r = button.getBoundingClientRect()
      return { key: button.closest("[data-xq-card]").dataset.xqCard, x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })
    if (!target) check("Everything: Show more grows the card down", false, `no Show more on screen; order ${order(s)}`)
    else {
      await page.mouse.move(target.x, target.y)
      await sleep(300)
      await settle()
      const before = await snap()
      const index = before.list.findIndex((c) => c.key === target.key)
      await page.mouse.click(target.x, target.y)
      await sleep(1200)
      const after = await snap()
      const moved = before.list.slice(0, index + 1).filter((c) => c.visible).map((card) => ({ key: slugOf(card.key), by: Math.abs(after.list.find((c) => c.key === card.key).top - card.top) }))
      const worst = moved.reduce((a, b) => (b.by > a.by ? b : a), { key: null, by: 0 })
      const grew = after.list[index].bottom - after.list[index].top > before.list[index].bottom - before.list[index].top + 20
      check("Everything: Show more grows the card down — its top and every card above it stay put", grew && worst.by < 1, `${slugOf(target.key)} grew ${grew}; largest move above ${worst.by.toFixed(2)}px${worst.key ? ` (${worst.key})` : ""}`)
    }
  }

  // Marked done from THIS tab: the human's own act, so it leaves the ordinary way — no ghost.
  {
    const s = await snap()
    const target = s.list.find((c) => c.visible && !c.ghost)
    await page.click(`[data-xq-card="${target.key}"] button[aria-label="Mark as done"]`)
    let gone = false
    let ghosted = false
    for (let i = 0; i < 20 && !gone; i++) {
      await sleep(200)
      const now = find(await snap(), slugOf(target.key))
      if (now?.ghost) ghosted = true
      gone = now === undefined
    }
    check("Everything: a card marked done from this tab leaves, and is never a ghost", gone && !ghosted, `${slugOf(target.key)} gone ${gone}, ghosted ${ghosted}`)
  }


  // A reload — the dev server's, a new build's — comes back on the card being read, where it was.
  {
    const s = await snap()
    const target = s.list.find((c, index) => index >= 2 && !c.ghost)
    await scrollToY(target.top + s.scrollY - 180)
    await pointerAway()
    await settle()
    const before = find(await snap(), slugOf(target.key))
    await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 })
    // Every tenth of a second from the first frame of the new page: where the card was, the offset, the
    // page's height — printed if the check fails, so a failure says how the page got where it did.
    const timeline = []
    const t0 = Date.now()
    // Ten seconds: under load the cards above lay out at their real height well after the card is back.
    while (Date.now() - t0 < 10000) {
      timeline.push(await page.evaluate((key, cards) => {
        const el = [...document.querySelectorAll(cards)].find((e) => e.dataset.xqCard === key)
        return `+${String(Math.round(performance.now())).padStart(5)} y=${window.scrollY} h=${document.documentElement.scrollHeight} cards=${document.querySelectorAll(cards).length} card=${el ? el.getBoundingClientRect().top.toFixed(1) : "-"}`
      }, target.key, EVERYTHING.cards).catch((error) => `(${error.message.slice(0, 60)})`))
      await sleep(100)
    }
    const after = await snap()
    const now = find(after, slugOf(target.key))
    const ok = now !== undefined && Math.abs(now.top - before.top) < 2
    const trace = timeline.join("\n        ")
    check("Everything: a reload comes back on the card that was being read, at the same offset",
      ok, `${slugOf(target.key)} ${before.top.toFixed(1)} → ${now?.top.toFixed(1)}; scrollY ${after.scrollY}; order ${order(after)}${ok ? "" : `\n      timeline:\n        ${trace}`}`)
  }

  // A project's chip narrows the queue to it and glides to the top — a move the human asked for, which the
  // viewport lock must stand aside for rather than hold the page where it was mid-glide.
  {
    const s = await snap()
    await scrollToY(Math.max(0, s.list[3].top + s.scrollY - 100))
    await pointerAway()
    await settle()
    const from = (await snap()).scrollY
    const chosen = await page.evaluate(() => {
      const chip = [...document.querySelectorAll("[data-xq-card] [data-xq-chip]")].find((el) => { const r = el.getBoundingClientRect(); return r.top > 0 && r.bottom < window.innerHeight })
      if (!chip) return null
      const project = chip.closest("[data-xq-card]").dataset.xqCard.split("/")[0]
      chip.click()
      return project
    })
    let after = await snap()
    for (let i = 0; i < 30 && !(after.scrollY === 0 && after.list.every((c) => c.key.startsWith(`${chosen}/`))); i++) {
      await sleep(200)
      after = await snap()
    }
    check("Everything: a project's chip narrows the queue to it and glides to the top",
      chosen !== null && after.scrollY === 0 && after.list.length > 0 && after.list.every((c) => c.key.startsWith(`${chosen}/`)), `chip ${chosen}; scrollY ${from} → ${after.scrollY}; order ${order(after)}`)
  }

  check("no page errors", errors.length === 0, errors.join("; "))
  failed = results.some((r) => !r.ok)
} finally {
  await browser.close()
}

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`)
process.exit(failed ? 1 : 0)
