// End-to-end: a queued parent's sub-agents on its queue card, and "Snooze until all sub-agents return".
//
// A REAL worker, on a REAL disposable stack, dispatches three background sub-agents that finish at
// different times and rests on an ```awaiting fence that is not an honoured park — the shape that queues
// once per return. Two identical parents run side by side:
//
//   P1 — snoozed "until all return" from its card, by a real click in a real browser, once its first
//        child is back. It must stay OUT of the queue through the second child's return (which still
//        wakes it — it runs and rests again) and come back in only after the last one.
//   P2 — the NEGATIVE CONTROL, left alone. It must re-queue after every return, which is both the
//        behaviour P1's snooze exists to stop and proof that this harness can see a re-queue at all.
//
// Along the way it photographs the cards (the count in the heading, the rows) and writes every board
// reading to a timeline, so the result can be re-derived from the evidence rather than from this log.
//
// Usage (against `nub scripts/adhoc-stack.mjs --creds --project=/tmp/<scratch-repo>`):
//   nub scripts/verify-subagent-wait.mjs --url=http://127.0.0.1:45917 --shots=/abs/dir
// Costs two parent turns (sonnet) and six haiku sleepers; takes ~6m. The sleepers wait with `timeout S tail
// -f /dev/null`, not `sleep`: the provider's own sandbox refuses a long foreground `sleep`, and a sleeper
// that is refused returns in seconds (the first run of this script, 2026-09-29).
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import puppeteer from "puppeteer"
import { createRpcClient } from "./lib/rpc-client.mjs"
import { sectionOf } from "../packages/web/src/groups.ts"

const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => { const s = a.slice(2); const i = s.indexOf("="); return i < 0 ? [s, true] : [s.slice(0, i), s.slice(i + 1)] }))
const url = flags.url
const shots = flags.shots ?? "/tmp/subagent-wait"
const sleeps = String(flags.sleeps ?? "40,130,220").split(",").map(Number)
if (!url) {
  console.error("usage: nub scripts/verify-subagent-wait.mjs --url=http://127.0.0.1:<port> [--shots=/abs/dir] [--sleeps=40,130,220]")
  process.exit(1)
}
mkdirSync(shots, { recursive: true })
const timeline = join(shots, "timeline.jsonl")
writeFileSync(timeline, "")

let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

const FENCE = "```"
const prompt = [
  "This is an automated test of Frizz's queue. Follow these steps exactly and do nothing else: do not call any mcp__frizz tool, and do not read or edit any file.",
  "",
  `1. In ONE message, dispatch three background sub-agents with the Agent tool — run_in_background: true, subagent_type "general-purpose", model "haiku" — with the descriptions "Sleeper 1", "Sleeper 2" and "Sleeper 3". Sleeper N's prompt is: "Run this single Bash command in the foreground with timeout 600000: timeout S tail -f /dev/null; echo ok — then reply with exactly: sleeper N done. Do nothing else." where S is ${sleeps[0]} for Sleeper 1, ${sleeps[1]} for Sleeper 2 and ${sleeps[2]} for Sleeper 3.`,
  "",
  "2. End your turn with one short sentence followed by this fence, verbatim. The fence must contain only that one line — no `agents:`, `for:`, `title:` or any other key:",
  "",
  `${FENCE}awaiting`,
  "Waiting on the three sleepers.",
  FENCE,
  "",
  "3. Each time a sleeper reports back: if any sleeper is still running, reply with one sentence naming the one that returned and end with the same fence again, verbatim. When all three have reported, reply exactly \"All three sleepers returned.\" with no fence.",
].join("\n")

const api = createRpcClient(url)
await api.waitForHealth()
const board0 = await api.query("board")
// The card's DOM key is `<project id>/<slug>` (lib/allQueues.ts threadKey), and the board names the slug only.
const projectId = (await api.query("projectsQueues")).find((q) => q.projectSlug === board0.projectSlug)?.projectId
check("the stack names its project", Boolean(projectId), String(projectId))

const p1 = await api.mutate("dispatch", { prompt, title: "Sleepers snoozed", model: "sonnet", effort: "low" })
const p2 = await api.mutate("dispatch", { prompt, title: "Sleepers control", model: "sonnet", effort: "low" })
console.log(`dispatched P1=${p1.slug} P2=${p2.slug}`)

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
const pageErrors = []
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 })
  // A failed load is read off the RESPONSE, which names the URL; its console echo does not. One is known
  // and not this change's: the adhoc stack runs no control server, so `/_frizz/control/status` 404s on
  // every page of it (reproduced on a page with no card on it at all).
  page.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) pageErrors.push(m.text()) })
  page.on("response", (r) => { if (r.status() >= 400 && !r.url().endsWith("/_frizz/control/status")) pageErrors.push(`${r.status()} ${r.url()}`) })
  page.on("pageerror", (e) => pageErrors.push(String(e)))
  await page.goto(new URL("/", url).href, { waitUntil: "networkidle2", timeout: 60_000 })

  const cardSel = (slug) => `[data-xq-card="${projectId}/${slug}"]`
  const shoot = async (name, slug) => {
    const el = await page.waitForSelector(`${cardSel(slug)} [data-xq-card-root]`, { timeout: 15_000 }).catch(() => null)
    if (!el) return check(`card on screen for ${name}`, false)
    // A beat for the poll to land the newest reading and the handoff to render.
    await new Promise((r) => setTimeout(r, 1500))
    await el.screenshot({ path: join(shots, `${name}.png`) })
    const wait = await page.$eval(cardSel(slug), (card) => {
      const block = card.querySelector("[data-subagent-wait]")
      return block ? { count: block.getAttribute("data-subagent-wait"), text: block.textContent, rows: [...block.querySelectorAll("[data-subagent-parent]")].map((r) => r.textContent) } : null
    }).catch(() => null)
    console.log(`shot ${name}: ${JSON.stringify(wait)}`)
    return wait
  }

  const state = {
    p1: { snoozedAt: null, requeuedWhileSnoozed: 0, wakesWhileSnoozed: 0, lastRuntime: null, lastRestAt: null, releasedAt: null, shots: new Set(), lastNeedsYou: false },
    p2: { queueEntries: 0, lastNeedsYou: false, shots: new Set() },
  }
  const started = Date.now()
  const deadline = started + 12 * 60_000
  while (Date.now() < deadline) {
    const board = await api.query("board")
    const at = new Date().toISOString()
    const read = (slug) => {
      const t = board.threads.find((x) => x.id === slug)
      if (!t) return undefined
      const direct = (t.subAgents ?? []).filter((a) => (a.depth ?? 1) === 1)
      return {
        t,
        runtime: t.runtime,
        needsYou: t.needsYou === true,
        running: direct.filter((a) => a.state === "running").length,
        returned: (t.returnedSubAgents ?? []).length,
        fence: t.lastFence?.kind,
        subAgentsSnoozed: t.subAgentsSnoozed === true,
        section: sectionOf(t),
      }
    }
    const a = read(p1.slug)
    const b = read(p2.slug)
    for (const [who, r] of [["P1", a], ["P2", b]]) {
      if (r) appendFileSync(timeline, JSON.stringify({ at, who, runtime: r.runtime, needsYou: r.needsYou, running: r.running, returned: r.returned, fence: r.fence, subAgentsSnoozed: r.subAgentsSnoozed, section: r.section }) + "\n")
    }

    // ---- P1: snooze it from the card once its first child is back ----
    if (a) {
      const s = state.p1
      if (!s.snoozedAt && a.needsYou && a.running > 0 && a.returned === 0 && !s.shots.has("waiting")) {
        s.shots.add("waiting")
        await shoot("p1-waiting-on-3", p1.slug)
      }
      if (!s.snoozedAt && a.needsYou && a.running > 0 && a.returned >= 1) {
        const seen = await shoot("p1-one-back", p1.slug)
        // The page polls on its own cadence, so the card may be a reading ahead of the board read that
        // triggered the shot: check it against itself — a count of the whole batch, and the heading that
        // states that count — rather than against a reading it need not share.
        const [back, of] = (seen?.count ?? "").split("/").map(Number)
        check("P1's card counts the batch in its heading", of === 3 && back >= 1 && seen.text.includes(`${back} of 3 sub-agents returned`), JSON.stringify(seen))
        // THE FOOTER'S SNOOZE MENU offers the same two, above its wall clock.
        await page.click(`${cardSel(p1.slug)} [data-command="snooze"]`)
        const menu = await page.waitForSelector('[role="menu"] [data-value="until-subagents-return"]', { timeout: 5000 }).catch(() => null)
        const items = menu ? await page.$$eval('[role="menu"] [role="menuitem"]', (els) => els.map((e) => e.textContent)) : []
        if (menu) await (await page.$('[role="menu"]')).screenshot({ path: join(shots, "p1-snooze-menu.png") })
        check("the footer's snooze menu leads with both event snoozes", /^Until all sub-agents return\d+ running$/.test(items[0] ?? "") && /^Until new activity/.test(items[1] ?? ""), JSON.stringify(items.slice(0, 3)))
        await page.keyboard.press("Escape")
        await page.click(`${cardSel(p1.slug)} [data-snooze="until-subagents-return"]`)
        s.snoozedAt = Date.now()
        s.lastNeedsYou = false
        console.log(`P1 snoozed until all return at ${at} (${a.returned} back, ${a.running} running)`)
      } else if (s.snoozedAt && !s.releasedAt) {
        // A RE-REST with a child still out: an intermediate return woke the parent, it ran, and it rested
        // again. That is the rest the one-rest snooze would have re-queued on.
        // Read off the rest instant rather than a running→idle edge, which a 1.5s poll can miss on a short turn.
        if (a.runtime === "turn-idle" && a.running > 0 && s.lastRestAt && a.t.lastAssistantAt !== s.lastRestAt) s.wakesWhileSnoozed++
        // Held while something is running: any queue reading then is the bug. A reading with nothing
        // running is the release this snooze promises.
        if (a.running > 0 && a.needsYou && Date.now() - s.snoozedAt > 3000) s.requeuedWhileSnoozed++
        if (a.running > 0 && a.runtime === "turn-idle" && Date.now() - s.snoozedAt > 3000 && !s.shots.has("snoozed")) {
          check("P1 sits in the Snoozed band while snoozed", a.section === "snoozed" && a.subAgentsSnoozed, `${a.section} subAgentsSnoozed=${a.subAgentsSnoozed}`)
          s.shots.add("snoozed")
        }
        if (a.running === 0 && a.needsYou) {
          s.releasedAt = Date.now()
          await shoot("p1-back-after-last", p1.slug)
        }
      }
      s.lastRuntime = a.runtime
      if (a.runtime === "turn-idle") s.lastRestAt = a.t.lastAssistantAt
    }

    // ---- P2: the control, never touched ----
    if (b) {
      const s = state.p2
      if (b.needsYou && !s.lastNeedsYou) s.queueEntries++
      s.lastNeedsYou = b.needsYou
      if (b.needsYou && b.running > 0 && b.returned >= 1 && !s.shots.has(`back-${b.returned}`)) {
        s.shots.add(`back-${b.returned}`)
        const seen = await shoot(`p2-${b.returned}-back`, p2.slug)
        const [back, of] = (seen?.count ?? "").split("/").map(Number)
        check(`P2's card counts the batch (board read ${b.returned} back)`, of === 3 && back >= b.returned && seen.text.includes(`${back} of 3 sub-agents returned`), JSON.stringify(seen))
      }
    }

    const p2Done = b && b.running === 0 && b.fence !== "awaiting" && b.needsYou && b.t.lastAssistant?.includes("All three")
    if (state.p1.releasedAt && p2Done) break
    await new Promise((r) => setTimeout(r, 1500))
  }

  const s1 = state.p1
  check("P1 was snoozed from its card", s1.snoozedAt !== null)
  check("P1 woke on an intermediate return and rested again while snoozed", s1.wakesWhileSnoozed >= 1, `${s1.wakesWhileSnoozed} re-rest(s) with a child still out`)
  check("P1 never re-entered the queue while a sub-agent was still running", s1.requeuedWhileSnoozed === 0, `${s1.requeuedWhileSnoozed} queued reading(s)`)
  check("P1 came back to the queue once the last sub-agent returned", s1.releasedAt !== null)
  // The control: without the snooze the same parent re-queues on every rest — initial + each return.
  check("P2 (unsnoozed control) re-queued on each return", state.p2.queueEntries >= 3, `${state.p2.queueEntries} queue entries`)
  check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "))
} finally {
  await browser.close()
}
console.log(`timeline: ${timeline}`)
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
