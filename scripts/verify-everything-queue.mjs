#!/usr/bin/env node
// Check, against a REAL two-project Frizz seeded by scripts/seed-everything-queue.mjs, the three answers
// the maintainer gave on 2026-09-28 to the queue-as-a-stack report:
//
//   1. EVERYTHING IS ONE QUEUE. The project listed first in the rail gets its first ready thread while the
//      operator reads the second project's card: it must land at the BOTTOM, not as a lane above the
//      reader, and the reader's card must not move. Each card names its project.
//   2. A SELF-WOKEN THREAD KEEPS ITS PLACE. The card being read is woken by Frizz (a wake delivery, as a
//      finished shell's would be) and rests again with nobody acting on it: it leaves the queue while it
//      runs and comes back to the SAME place, not the bottom.
//   3. THE BOARD IS TOP-ALIGNED. An arrival at the bottom of a project's queue moves neither the card
//      above it nor the sidebar's prompt box.
//
// Usage: node scripts/verify-everything-queue.mjs --stack=/abs/stack.log --seed='<SEED json>' [--shots=/abs/dir]
// Exits non-zero when any check fails.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import puppeteer from "puppeteer"
import { createRpcClient } from "./lib/rpc-client.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => { const s = a.slice(2); const i = s.indexOf("="); return i < 0 ? [s, true] : [s.slice(0, i), s.slice(i + 1)] }),
)
if (!flags.stack || !flags.seed) {
  console.error("usage: node scripts/verify-everything-queue.mjs --stack=/abs/stack.log --seed='<json>' [--shots=/abs/dir]")
  process.exit(1)
}
const stack = JSON.parse(readFileSync(flags.stack, "utf8").split("\n").find((l) => l.startsWith("{\"url\"")))
const seed = JSON.parse(flags.seed)
const origin = new URL(stack.url).origin
const firstApi = createRpcClient(`${origin}/`, seed.first)
const secondApi = createRpcClient(`${origin}/`, seed.second)
const db = join(stack.home, ".frizz/ui.db")
const shots = flags.shots ?? join(process.cwd(), ".adhoc-shots")
mkdirSync(shots, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(what, predicate, ms = 30_000, every = 250) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const got = await predicate()
    if (got) return got
    await sleep(every)
  }
  throw new Error(`timed out waiting for ${what}`)
}
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`)
}
const threadOf = async (api, slug) => (await api.query("board")).threads.find((t) => t.id === slug)
const key = (project, slug) => `${project}/${slug}`

await firstApi.waitForHealth()
await waitFor("the second project's two plain rests to queue", async () => {
  const [a, b] = await Promise.all([threadOf(secondApi, "login-test"), threadOf(secondApi, "settings")])
  return a?.queuedAt && b?.queuedAt
})

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--force-color-profile=srgb"] })
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 2 })
  const errors = []
  page.on("pageerror", (error) => errors.push(`pageerror: ${error}`))
  // The app renders in sans; pin it for every measurement (CLAUDE.md: the stylesheet still defaults to mono).
  await page.evaluateOnNewDocument(() => document.addEventListener("DOMContentLoaded", () => document.documentElement.setAttribute("data-font", "sans")))

  // ---- 1. EVERYTHING IS ONE QUEUE ---------------------------------------------------------------------
  await page.goto(`${origin}/all/${encodeURIComponent(seed.secondSlug)}`, { waitUntil: "domcontentloaded", timeout: 90_000 })
  const cardOrder = () => page.$$eval("[data-xq-card]", (els) => els.map((el) => el.getAttribute("data-xq-card")))
  const top = (selector) => page.$eval(selector, (el) => el.getBoundingClientRect().top)
  await waitFor("both queued cards on the Everything page", async () => (await cardOrder()).length >= 2)
  const reader = `[data-xq-card="${key(seed.second, "login-test")}"]`
  const beforeOrder = await cardOrder()
  const readerTop = await top(reader)
  console.log(`…waiting for the first-listed project's thread to become ready (its snooze ends)`)
  await waitFor("the arrival on the Everything page", async () => (await cardOrder()).includes(key(seed.first, "pr-review")), 120_000, 200)
  await sleep(600) // one frame for anything that would shift to shift
  const afterOrder = await cardOrder()
  check("the first-listed project's arrival joins the BOTTOM of the one queue",
    afterOrder.join() === [key(seed.second, "login-test"), key(seed.second, "settings"), key(seed.first, "pr-review")].join(),
    `before: ${beforeOrder.join(" → ")}; after: ${afterOrder.join(" → ")}`)
  const lanes = await page.$$("[data-xq-lane]")
  check("…as one queue: no per-project lanes (the rail order that put its lane on top)", lanes.length === 0, `rail order: ${seed.firstSlug}, ${seed.secondSlug}`)
  const readerMoved = (await top(reader)) - readerTop
  check("the card being read did not move", Math.abs(readerMoved) < 0.5, `moved ${readerMoved.toFixed(2)}px`)
  const chips = await page.$$eval("[data-xq-card]", (els) => els.map((el) => el.querySelector("[data-xq-chip]")?.getAttribute("data-xq-chip")))
  check("every card names its project", chips.join() === [seed.second, seed.second, seed.first].join(), chips.join())
  await page.screenshot({ path: join(shots, "everything-one-queue.png"), clip: { x: 0, y: 0, width: 1400, height: 900 } })

  // ---- 2. A SELF-WOKEN THREAD KEEPS ITS PLACE ---------------------------------------------------------
  const held = (await threadOf(secondApi, "login-test")).queuedAt
  const jsonl = join(stack.home, ".claude", "projects", seed.secondDir.replace(/[/.]/g, "-"), "7e000000-0000-4000-9000-00000000000b.jsonl")
  const record = (r) => appendFileSync(jsonl, `${JSON.stringify({ parentUuid: null, isSidechain: false, session_id: "7e000000-0000-4000-9000-00000000000b", cwd: seed.secondDir, ...r })}\n`)
  // What Frizz writes when a finished shell wakes the worker — a user turn exactly like a typed one.
  record({ type: "user", uuid: "00000000-0000-4000-9000-0000000000f1", timestamp: new Date().toISOString(), message: { role: "user", content: "⏰ Your background shell finished: `bsh1` — tests.\n\n<!-- frizz-wake:selfwake1 -->" } })
  await waitFor("the woken thread to leave the queue", async () => (await threadOf(secondApi, "login-test"))?.needsYou !== true)
  record({
    type: "assistant", uuid: "00000000-0000-4000-9000-0000000000f2", timestamp: new Date().toISOString(),
    message: { model: "claude-opus-5", id: "msg_selfwake", type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Tests are green now — still over to you." }], usage: { input_tokens: 2, output_tokens: 12 } },
  })
  const back = await waitFor("the woken thread to rest again", async () => { const t = await threadOf(secondApi, "login-test"); return t?.needsYou === true && t })
  check("the self-woken thread came back to its own place", back.queuedAt === held, `queuedAt ${back.queuedAt} (held ${held}); its new rest ${back.lastAssistantAt}`)
  const stored = execFileSync("sqlite3", [db, `SELECT queued_at FROM session WHERE project_id='${seed.second}' AND slug='login-test'`], { encoding: "utf8" }).trim()
  check("…and that place is persisted", stored === held, stored)
  await waitFor("the page to draw it back", async () => (await cardOrder()).includes(key(seed.second, "login-test")), 15_000)
  const wokenOrder = await cardOrder()
  check("…still first in the one queue, not last", wokenOrder[0] === key(seed.second, "login-test"), wokenOrder.join(" → "))

  // ---- 3. THE BOARD IS TOP-ALIGNED --------------------------------------------------------------------
  await page.goto(`${origin}/project/${encodeURIComponent(seed.secondSlug)}`, { waitUntil: "domcontentloaded", timeout: 90_000 })
  await page.waitForSelector("[data-queue-card]", { timeout: 20_000 })
  await sleep(800)
  const boardCards = () => page.$$eval("[data-queue-card]", (els) => els.map((el) => el.getAttribute("data-queue-card")))
  const firstCard = `[data-queue-card="${(await boardCards())[0]}"]`
  const geometry = async () => ({
    card: await top(firstCard),
    header: await top("[data-inbox-header]"),
    prompt: await top("[data-dispatch-form] textarea"),
    status: await top("[data-status-row]"),
  })
  const beforeBoard = await geometry()
  console.log(`…waiting for an arrival on the board (its snooze ends)  ${JSON.stringify(beforeBoard)}`)
  await waitFor("the board's arrival", async () => (await boardCards()).includes("release-pin"), 120_000, 200)
  await sleep(600)
  const afterBoard = await geometry()
  const order = await boardCards()
  check("the board's arrival joins the bottom", order.at(-1) === "release-pin", order.join(" → "))
  for (const part of ["card", "header", "prompt", "status"]) {
    const moved = afterBoard[part] - beforeBoard[part]
    check(`…and the ${part === "card" ? "card above it" : part === "header" ? "READY header" : part === "prompt" ? "sidebar's prompt box" : "sidebar's status row"} did not move`, Math.abs(moved) < 0.5, `moved ${moved.toFixed(2)}px`)
  }
  const middle = (selector) => page.$eval(selector, (el) => { const r = el.getBoundingClientRect(); return (r.top + r.bottom) / 2 })
  const [statusMid, headerMid] = [await middle("[data-status-row]"), await middle("[data-inbox-header]")]
  check("the status row's middle sits level with the READY header's across the gutter", Math.abs(statusMid - headerMid) < 6, `status ${statusMid.toFixed(2)} vs header ${headerMid.toFixed(2)}`)
  await page.screenshot({ path: join(shots, "board-top-aligned.png"), clip: { x: 0, y: 0, width: 1400, height: 900 } })
  check("no page errors", errors.length === 0, errors.join("; "))
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
