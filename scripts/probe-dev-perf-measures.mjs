// Does a DEV tab's performance-entry buffer stay bounded, and do React's DevTools tracks still reach a
// trace? Samples the buffered measure count every 4s for 24s while tracing blink.user_timing, then counts
// React component-track events (names start with U+200B) in the trace.
//
//   nub scripts/probe-dev-perf-measures.mjs <url>
//
// Before main.tsx cleared the buffer, the real board grew it by ~177 entries/s with the tab idle.
import puppeteer from "puppeteer"
const b = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] })
const p = await b.newPage()
await p.goto(process.argv[2], { waitUntil: "networkidle2" })
await p.tracing.start({ categories: ["blink.user_timing", "devtools.timeline"] })
const samples = []
for (let i = 0; i < 6; i++) { await new Promise(r => setTimeout(r, 4000)); samples.push(await p.evaluate(() => performance.getEntriesByType("measure").length)) }
const trace = JSON.parse(Buffer.from(await p.tracing.stop()).toString("utf8"))
const reactEvents = trace.traceEvents.filter(e => typeof e.name === "string" && e.name.startsWith("​")).length
console.log(JSON.stringify({ bufferedMeasuresEvery4s: samples, reactTrackEventsInTrace: reactEvents }))
await b.close()
