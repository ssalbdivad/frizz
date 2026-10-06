// The live schedule reading's history gate (plans/schedule-live-reading.md §2.6 and §15.1).
//
// Runs the local grammar (packages/shared/src/schedule-phrase.ts) the way the prompt box does — scope
// "edges", outside schedule mode — over every prompt in ~/.claude/history.jsonl, and counts how many it
// would OFFER as a schedule. Those prompts were written before schedules existed, so every offer is a
// false one: this measures how often the box lights up uninvited, not how often it catches a schedule.
//
//   nub scripts/schedule-phrase-history.ts                 the gate, with each offered prompt listed
//   nub scripts/schedule-phrase-history.ts --quiet         the counts only
//   nub scripts/schedule-phrase-history.ts --file <path>   another history file
//
// It FAILS (exit 1) if more than 1% of prompts get an offer, or more than 0.25% get an open-edge exact
// offer — the grammar has grown past what the box can afford. Kept as a regression gate for grammar
// growth; local only and never a fixture, because the history is the maintainer's private prompts. With no
// history file it skips (exit 0).
//
// Prompts are filtered as §2.6 measured them: no slash commands, nothing of 3 characters or fewer. The
// clock is the spec's (Mon Oct 5 2026 14:32 New York), so a rerun is comparable; only one-offs and the
// first run depend on it, and the box reads neither.
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { NY, SPEC_NOW, summarizeReading } from "../packages/shared/src/schedule-phrase.corpus.ts"
import { isScheduleOffer, readSchedulePhrase, SCHEDULE_GRAMMAR_VERSION } from "../packages/shared/src/schedule-phrase.ts"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const file = flag("--file") ?? join(homedir(), ".claude", "history.jsonl")
const quiet = args.includes("--quiet")

const OFFER_GATE = 0.01
const OPEN_EXACT_GATE = 0.0025

if (!existsSync(file)) {
  console.log(`schedule-phrase-history: no ${file}, skipped`)
  process.exit(0)
}

const prompts: string[] = []
for (const raw of readFileSync(file, "utf8").split("\n")) {
  if (!raw.trim()) continue
  let display: unknown
  try {
    display = (JSON.parse(raw) as { display?: unknown }).display
  } catch {
    continue
  }
  if (typeof display !== "string") continue
  const text = display.trim()
  if (text.length <= 3 || text.startsWith("/")) continue
  prompts.push(display)
}

const counts = { offer: 0, openExact: 0, closeExact: 0, cue: 0, ambiguous: 0, vetoed: 0, spacing: 0, event: 0, presence: 0, darkCue: 0 }
const offered: string[] = []
let slowest = 0
let slowestLength = 0
const started = performance.now()
for (const text of prompts) {
  const t = performance.now()
  const r = readSchedulePhrase(text, { nowMs: SPEC_NOW, tz: NY, scope: "edges" })
  const ms = performance.now() - t
  if (ms > slowest) [slowest, slowestLength] = [ms, text.length]
  if (r.kind === "event") counts.event++
  if (r.kind === "presence") counts.presence++
  if (r.kind === "exact" && r.veto) counts.vetoed++
  if (r.kind === "exact" && r.spacing) counts.spacing++
  if (!isScheduleOffer(r)) {
    if (r.kind === "cue" || r.kind === "ambiguous") counts.darkCue++
    continue
  }
  counts.offer++
  if (r.kind === "exact") counts[r.edge === "open" ? "openExact" : "closeExact"]++
  if (r.kind === "cue") counts.cue++
  if (r.kind === "ambiguous") counts.ambiguous++
  const span = "span" in r ? r.span : { start: 0, end: 0 }
  const context = text.slice(Math.max(0, span.start - 40), span.end + 40).replace(/\s+/g, " ")
  offered.push(`  ${summarizeReading(text, r)}\n    …${context}… (${text.length} chars)`)
}
const total = performance.now() - started

const pct = (n: number) => `${((100 * n) / Math.max(1, prompts.length)).toFixed(2)}%`
console.log(`schedule-phrase-history: grammar v${SCHEDULE_GRAMMAR_VERSION}, ${prompts.length} prompts from ${file}`)
console.log(`  offers                 ${counts.offer} (${pct(counts.offer)}; gate ${OFFER_GATE * 100}%)`)
console.log(`    open-edge exact      ${counts.openExact} (${pct(counts.openExact)}; gate ${OPEN_EXACT_GATE * 100}%)`)
console.log(`    close-edge exact     ${counts.closeExact} (${pct(counts.closeExact)})`)
console.log(`    cue (open edge)      ${counts.cue} (${pct(counts.cue)})`)
console.log(`    ambiguous            ${counts.ambiguous} (${pct(counts.ambiguous)})`)
console.log(`  dark: vetoed close    ${counts.vetoed}, spacing ${counts.spacing}, event ${counts.event}, presence ${counts.presence}, close-edge cue ${counts.darkCue}`)
console.log(`  time: ${Math.round(total)}ms total, ${(total / Math.max(1, prompts.length)).toFixed(2)}ms mean, ${slowest.toFixed(1)}ms slowest (${slowestLength} chars)`)
if (!quiet && offered.length) console.log(`\nOffered (each is a false offer: these prompts predate schedules):\n${offered.join("\n")}`)

const failures = [
  ...(counts.offer / Math.max(1, prompts.length) > OFFER_GATE ? [`offers ${pct(counts.offer)} > ${OFFER_GATE * 100}%`] : []),
  ...(counts.openExact / Math.max(1, prompts.length) > OPEN_EXACT_GATE ? [`open-edge exact offers ${pct(counts.openExact)} > ${OPEN_EXACT_GATE * 100}%`] : []),
]
if (failures.length) {
  console.error(`\nFAIL: ${failures.join("; ")}`)
  process.exit(1)
}
console.log("\nPASS")
