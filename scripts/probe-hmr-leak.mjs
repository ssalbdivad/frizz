// Does a long-lived DEV tab accumulate state across Vite hot updates? Opens a headless tab on a running
// adhoc stack, then edits a web module N times (append a comment, wait for the hot update, revert) and
// reports, after each round: open /ws connections the SERVER sees from this tab, window/document
// listener counts, and JS heap.
//
//   nub scripts/probe-hmr-leak.mjs <url> <port> <relative/module/path.ts> [rounds=6]
//
// Run it against a stack booted from a WORKTREE — it edits the module it is given, and every dev tab
// served from that tree takes the hot update too.
import { readFileSync, writeFileSync } from "node:fs"
import { execSync } from "node:child_process"
import puppeteer from "puppeteer"

const [url, port, modulePath, roundsArg] = process.argv.slice(2)
const rounds = Number(roundsArg) || 6
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const serverSockets = () =>
  Number(execSync(`ss -tn state established '( sport = :${port} )' | tail -n +2 | wc -l`).toString().trim())

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] })
const original = readFileSync(modulePath, "utf8")
try {
  const page = await browser.newPage()
  const cdp = await page.createCDPSession()
  let wsOpened = 0, wsClosed = 0
  cdp.on("Network.webSocketCreated", () => wsOpened++)
  cdp.on("Network.webSocketClosed", () => wsClosed++)
  await cdp.send("Network.enable")
  await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 })
  await sleep(3000)

  const listeners = async (expr) => {
    const { result } = await cdp.send("Runtime.evaluate", { expression: expr })
    const { listeners } = await cdp.send("DOMDebugger.getEventListeners", { objectId: result.objectId })
    const byType = {}
    for (const l of listeners) byType[l.type] = (byType[l.type] ?? 0) + 1
    return byType
  }
  const sample = async (label) => {
    await cdp.send("HeapProfiler.collectGarbage")
    const heap = await page.evaluate(() => performance.memory.usedJSHeapSize)
    const win = await listeners("window")
    const doc = await listeners("document")
    console.log(JSON.stringify({
      label, reloaded: await page.evaluate(() => window.__probeMarker !== 1), serverSockets: serverSockets(), wsOpen: wsOpened - wsClosed, heapMB: +(heap / 1e6).toFixed(1),
      winFocus: win.focus ?? 0, winKeydown: win.keydown ?? 0, docClick: doc.click ?? 0, docVisibility: doc.visibilitychange ?? 0,
      winTotal: Object.values(win).reduce((a, b) => a + b, 0), docTotal: Object.values(doc).reduce((a, b) => a + b, 0),
    }))
  }

  await page.evaluate(() => { window.__probeMarker = 1 })
  await sample("baseline")
  for (let i = 1; i <= rounds; i++) {
    writeFileSync(modulePath, `${original}\n// hmr probe ${i}\n`)
    await sleep(2500)
    writeFileSync(modulePath, original)
    await sleep(2500)
    await sample(`after ${i * 2} hot updates`)
  }
} finally {
  writeFileSync(modulePath, original)
  await browser.close()
}
