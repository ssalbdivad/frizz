#!/usr/bin/env node
// Check, against a REAL two-project Frizz seeded by scripts/seed-queue-stays-put.mjs, the guarantee the
// maintainer asked for on 2026-09-28: "it needs to be guaranteed that cards that I'm currently viewing on
// the screen don't move in their position."
//
// Every scenario measures every card on screen (and the sidebar's prompt box) before and after one thing
// that is NOT the human's doing — a thread arriving (FIFO, and newest-first above the screen), a thread
// on screen or above it waking itself and resting again, an arrival while the human types in a card, an
// arrival behind an open drawer — and fails if any of them moved by a pixel or more. (Not zero: a scroll
// offset snaps to whole device pixels, so a correction by a fractional height leaves up to half a device
// pixel, which no display can draw. Every move is printed exactly.) The page is also sampled after every
// painted frame in between, so a jump corrected a frame later is reported too. A card whose OWN thread
// spoke again is exempt from its own measurement — new words are a new height — but not from anyone
// else's: the card the human is on holds still, and it is the one that spoke that gives.
// Runs on the board (lib/stableQueue.ts + lib/viewportLock.ts in TodosView) and on Everything.
//
// Usage: node scripts/verify-queue-stays-put.mjs --stack=/abs/stack.log --seed='<SEED json>' [--shots=/abs/dir] [--only=board|everything]
// Exits non-zero when any check fails.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import puppeteer from "puppeteer"

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
// The agent comes to rest, saying exactly what it said last time: same card, same height.
const rest = (key) => record(key, {
  type: "assistant",
  message: { model: "claude-opus-5", id: `msg_again_${serial}`, type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: seed.sessions[key].handoff }], usage: { input_tokens: 2, output_tokens: 200 } },
})
// What Frizz writes when a finished shell wakes the worker: nobody touched the thread.
const wake = (key) => record(key, { type: "user", message: { role: "user", content: `⏰ Your background shell finished: \`bsh${serial}\` — tests.\n\n<!-- frizz-wake:selfwake${serial} -->` } })

// ---- the page ---------------------------------------------------------------------------------------
const BOARD = { name: "board", url: `${origin}/project/${encodeURIComponent(seed.aSlug)}`, cards: "[data-queue-card]", key: "queueCard" }
const EVERYTHING = { name: "Everything", url: `${origin}/all/${encodeURIComponent(seed.aSlug)}`, cards: "[data-xq-card]", key: "xqCard" }
const PROMPT = '[data-dispatch-form] textarea'

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--force-color-profile=srgb"] })
let failed = true
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 })
  const errors = []
  page.on("pageerror", (error) => errors.push(`pageerror: ${error}`))
  await page.evaluateOnNewDocument(() => document.addEventListener("DOMContentLoaded", () => document.documentElement.setAttribute("data-font", "sans")))

  let surface = BOARD
  const open = async (target, order) => {
    surface = target
    await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.evaluate((order) => {
      const stored = JSON.parse(localStorage.getItem("frizz.prefs.v1") ?? "{}")
      localStorage.setItem("frizz.prefs.v1", JSON.stringify({ ...stored, queueOrder: order }))
    }, order)
    await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.waitForSelector(target.cards, { timeout: 30_000 })
    await sleep(2500)
  }

  // Every card's key, top, on-screen-ness and ghostliness, in DOM order; the prompt box; the offset.
  const snap = () => page.evaluate((cards, key, prompt) => {
    const vh = window.innerHeight
    const list = [...document.querySelectorAll(cards)].map((el) => {
      const r = el.getBoundingClientRect()
      return { key: el.dataset[key], top: r.top, bottom: r.bottom, visible: r.bottom > 0 && r.top < vh, ghost: el.hasAttribute("data-queue-ghost") }
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
    const observer = new ResizeObserver(() => {
      if (sampler.stop) return
      sampler.frames++
      for (const el of document.querySelectorAll(cards)) {
        const was = tracked[el.dataset[key]]
        if (was === undefined) continue
        const off = Math.abs(el.getBoundingClientRect().top - was)
        if (off > sampler.max) { sampler.max = off; sampler.worst = el.dataset[key] }
      }
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
    try {
      await waitFor(name, until)
      await sleep(1500)
      after = await snap()
    } finally {
      sampled = await stopSampler()
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
    const promptMoved = before.prompt !== null && after.prompt !== null ? Math.abs(after.prompt - before.prompt) : 0
    const ok = worst.by < 1 && missing.length === 0 && promptMoved < 1 && (sampled.max < 1 || spoke.includes(slugOf(sampled.worst ?? "")))
    check(`${surface.name}: ${name}`, ok,
      `on screen before: ${before.list.filter((c) => c.visible).map((c) => slugOf(c.key)).join(" ")}; ` +
      `largest move ${worst.by.toFixed(2)}px${worst.key ? ` (${worst.key})` : ""}, in any frame ${sampled.max.toFixed(2)}px over ${sampled.frames} frames; ` +
      `prompt box ${promptMoved.toFixed(2)}px${missing.length ? `; GONE from screen: ${missing.join(" ")}` : ""}; ` +
      `order ${order(after)}; scrollY ${before.scrollY} → ${after.scrollY}`)
    if (expect) expect(before, after)
    return { before, after }
  }

  const only = flags.only
  if (only !== "everything") {
  // ==== THE BOARD, oldest first ========================================================================
  await open(BOARD, "fifo")
  console.log(`board order: ${order(await snap())}`)

  await scrollToY(0)
  await pointerAway()
  await stays("an arrival joins the bottom while the first card is read at the top of the page", {
    act: () => rest("a/r1"),
    until: (s) => find(s, "r1"),
    expect: (_, after) => check("board: …and it is last", slugOf(after.list.at(-1).key) === "r1", order(after)),
  })

  await straddle("q1", "q2")
  await pointerOn("q2")
  await stays("a card on screen that wakes itself stays where it is, as a ghost", {
    act: () => wake("a/q1"),
    until: (s) => find(s, "q1")?.ghost,
  })
  await page.screenshot({ path: join(shots, "board-ghost.png") })
  await stays("…and when it rests again it is the card again, in the same place: the card under the pointer holds", {
    spoke: ["q1"],
    act: () => rest("a/q1"),
    until: (s) => find(s, "q1") && !find(s, "q1").ghost,
    expect: (_, after) => check("board: …still first in line", slugOf(after.list[0].key) === "q1", order(after)),
  })

  // A card ABOVE the screen wakes itself: it simply goes, and comes back to its place in line above.
  {
    const s = await snap()
    await scrollToY(find(s, "q4").top + s.scrollY - 100)
    await pointerAway()
  }
  await stays("a card above the screen that wakes itself goes, and nothing on screen moves", {
    act: () => wake("a/q1"),
    until: (s) => !find(s, "q1"),
  })
  await stays("…and it comes back to its old place above, and nothing on screen moves", {
    act: () => rest("a/q1"),
    until: (s) => find(s, "q1"),
    expect: (_, after) => check("board: …first in line again", slugOf(after.list[0].key) === "q1", order(after)),
  })

  // ==== THE BOARD, newest first: every arrival is above the screen ==================================
  await open(BOARD, "lifo")
  console.log(`board order (newest first): ${order(await snap())}`)
  await scrollToY(0)
  await pointerAway()
  await stays("newest first: an arrival at the top of the page lands above the screen", {
    act: () => rest("a/r2"),
    until: (s) => find(s, "r2"),
    expect: (_, after) => {
      const r2 = find(after, "r2")
      check("board: …first in line, and off screen above", slugOf(after.list[0].key) === "r2" && r2.bottom <= 0, `r2 at ${r2.top.toFixed(1)}…${r2.bottom.toFixed(1)}`)
    },
  })

  // Typing: the reply box of a card on screen holds the caret; an arrival above must not move it.
  {
    const box = `${BOARD.cards}[data-queue-card="q3"] [data-surface="queueComposer"]`
    await page.evaluate((box) => document.querySelector(box).scrollIntoView({ block: "center", behavior: "instant" }), box)
    await sleep(300)
    await page.click(box)
    await page.keyboard.type("a reply I am in the middle of writing")
    await pointerAway()
  }
  await stays("typing in a card's reply box: an arrival above moves neither the box nor the caret", {
    act: () => rest("a/r3"),
    until: (s) => find(s, "r3"),
    expect: (before, after) =>
      check("board: …the box kept the keyboard and the text", after.focus !== null && before.focus !== null && Math.abs(after.focus.top - before.focus.top) < 0.5 && after.focus.value === "a reply I am in the middle of writing",
        `box ${before.focus?.top.toFixed(2)} → ${after.focus?.top.toFixed(2)}, "${after.focus?.value}"`),
  })
  await page.evaluate(() => document.activeElement?.blur())

  // A drawer over the queue: an arrival lands behind it, and closing it returns the page as it was.
  {
    const s = await snap()
    await scrollToY(find(s, "q2").top + s.scrollY - 120)
    await pointerAway()
  }
  await settle()
  const beforeDrawer = await snap()
  // A working thread's row opens its drawer (a Ready row scrolls to its card instead).
  await page.click('[data-sidebar-item="r5"] button')
  await page.waitForFunction(() => document.body.style.position === "fixed", { timeout: 10_000 })
  await sleep(800)
  rest("a/r4")
  await sleep(4000)
  await page.keyboard.press("Escape")
  await page.waitForFunction(() => document.body.style.position !== "fixed", { timeout: 10_000 })
  await sleep(1500)
  {
    const after = await snap()
    let worst = { key: null, by: 0 }
    for (const card of beforeDrawer.list.filter((c) => c.visible)) {
      const now = after.list.find((c) => c.key === card.key)
      const by = now ? Math.abs(now.top - card.top) : Infinity
      if (by > worst.by) worst = { key: slugOf(card.key), by }
    }
    check("board: an arrival behind an open drawer — closing it returns every card on screen to where it was",
      worst.by < 1 && find(after, "r4") !== undefined, `largest move ${worst.by.toFixed(2)}px${worst.key ? ` (${worst.key})` : ""}; order ${order(after)}`)
  }

  }
  if (only !== "board") {
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
  {
    const s = await snap()
    const [first, second] = s.list.map((c) => slugOf(c.key))
    await straddle(first, second)
    await pointerOn(second)
    const key = Object.keys(seed.sessions).find((k) => k.endsWith(`/${first}`))
    await stays("a card on screen that wakes itself stays where it is, as a ghost", {
      act: () => wake(key),
      until: (snapshot) => find(snapshot, first)?.ghost,
    })
    await page.screenshot({ path: join(shots, "everything-ghost.png") })
    await stays("…and when it rests again it is the card again, in the same place: the card under the pointer holds", {
      spoke: [first],
      act: () => rest(key),
      until: (snapshot) => find(snapshot, first) && !find(snapshot, first).ghost,
      expect: (_, after) => check("Everything: …still first in line", slugOf(after.list[0].key) === first, order(after)),
    })
  }
  await open(EVERYTHING, "lifo")
  await scrollToY(0)
  await pointerAway()
  await stays("newest first: an arrival at the top of the page lands above the screen", {
    act: () => rest("a/r5"),
    until: (s) => find(s, "r5"),
    expect: (_, after) => {
      const r5 = find(after, "r5")
      check("Everything: …first in line, and off screen above", slugOf(after.list[0].key) === "r5" && r5.bottom <= 0, `r5 at ${r5.top.toFixed(1)}…${r5.bottom.toFixed(1)}`)
    },
  })
  await stays("newest first: the other project's arrival lands above the screen too", {
    act: () => rest("b/p3"),
    until: (s) => find(s, "p3"),
  })
  }

  check("no page errors", errors.length === 0, errors.join("; "))
  failed = results.some((r) => !r.ok)
} finally {
  await browser.close()
}

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`)
process.exit(failed ? 1 : 0)
