// Heap-snapshot diff across Vite hot updates: which object kinds does a DEV tab keep after N hot updates of
// one module? Snapshots after 2 updates (warm) and after 2+N, aggregates self size by node type + name, and
// prints the biggest growth, plus the retainer path of a sample grown string.
//
//   nub scripts/probe-hmr-heapdiff.mjs <url> <relative/module/path.tsx> [N=8]
import { readFileSync, writeFileSync } from "node:fs"
import puppeteer from "puppeteer"

const [url, modulePath, nArg] = process.argv.slice(2)
const N = Number(nArg) || 8
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const original = readFileSync(modulePath, "utf8")
let round = 0
async function bump(cdp) {
  round++
  writeFileSync(modulePath, `${original}\n// hmr probe ${round}\n`)
  await sleep(2500)
}

async function snapshot(cdp) {
  await cdp.send("HeapProfiler.collectGarbage")
  const chunks = []
  const onChunk = (e) => chunks.push(e.chunk)
  cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk)
  await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false })
  cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk)
  const snap = JSON.parse(chunks.join(""))
  const f = snap.snapshot.meta.node_fields
  const types = snap.snapshot.meta.node_types[0]
  const w = f.length
  const [iType, iName, iSize, iId] = ["type", "name", "self_size", "id"].map((k) => f.indexOf(k))
  const agg = new Map()
  const nodes = snap.nodes
  for (let i = 0; i < nodes.length; i += w) {
    const type = types[nodes[i + iType]]
    let name = snap.strings[nodes[i + iName]]
    if (type === "string" || type === "concatenated string" || type === "sliced string") name = `(${name.length > 60 ? "len>60" : "short"})`
    const key = `${type} ${name.slice(0, 80)}`
    const a = agg.get(key) ?? { count: 0, size: 0 }
    a.count++; a.size += nodes[i + iSize]
    agg.set(key, a)
  }
  return agg
}

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] })
try {
  const page = await browser.newPage()
  const cdp = await page.createCDPSession()
  await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 })
  await sleep(3000)
  await bump(cdp); await bump(cdp)
  const before = await snapshot(cdp)
  for (let i = 0; i < N; i++) await bump(cdp)
  const after = await snapshot(cdp)
  const rows = []
  for (const [k, a] of after) {
    const b = before.get(k) ?? { count: 0, size: 0 }
    rows.push({ k, dCount: a.count - b.count, dKB: +((a.size - b.size) / 1024).toFixed(1) })
  }
  rows.sort((x, y) => y.dKB - x.dKB)
  let total = 0
  for (const r of rows) total += r.dKB
  console.log(`total growth over ${N} hot updates: ${(total / 1024).toFixed(2)} MB`)
  for (const r of rows.slice(0, 30)) console.log(`${String(r.dKB).padStart(9)} KB  ${String(r.dCount).padStart(7)}  ${r.k}`)
} finally {
  writeFileSync(modulePath, original)
  await browser.close()
}
