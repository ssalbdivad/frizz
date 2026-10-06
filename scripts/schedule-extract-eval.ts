// THE SCHEDULE EXTRACTION BENCHMARK — kept, because the interpreter's prompt and its model will keep changing.
//
// The prompt box asks a model whether a prompt is a schedule whenever the prompt holds a trigger word
// (packages/shared/src/schedule-trigger.ts), and the model decides INTENT as well as the rule
// (packages/server/src/schedule-interpreter.ts). This runs that exact path — createScheduleInterpreter over
// createClaudeOneShot, the real CLI, the real retry and validation — over a hand-checked fixture, per model:
//
//   positives  realistic schedule requests (the phrase at the start, mid-text and at the end; zones,
//              conditions, every other, ordinals, business days, intervals, several times a day, limits).
//              Graded on the NEXT 5 RUNS at the fixture's clock, not on the rule's spelling: two rules that
//              fire at the same times are the same schedule. `alt` lists the other defensible readings.
//   field      "Change when" texts read against an existing schedule (the drawer's field, D7).
//   one-offs   one later time and no repetition — not a schedule under the decided intent.
//   negatives  prompts holding a trigger word that ask for no schedule.
//   history    at run time only: the maintainer's own past prompts (~/.claude/history.jsonl) that hold a
//              trigger word. They predate schedules, so every schedule found in one is a false positive.
//              They are NEVER written to the repo, the fixture or `--out`: only counts leave this process,
//              and the found ones print to the terminal for review.
//
// What it reports, per model: positives with the same 5 runs; WRONG schedules (a schedule whose runs differ —
// the worst failure, since the human may not read the preview closely); missed schedules; false positives
// on each negative set; latency median and p90 per read (one `interpret` call, retries included); and the
// paired McNemar p-value of each model's wrong and missed counts against the best model's, so a gap of a few
// cases is not mistaken for a difference. Plus the TRIGGER RATE: the share of the maintainer's prompts that
// would call the model at least once, and how many reads typing one would cost.
//
//   nub scripts/schedule-extract-eval.ts                                haiku and sonnet, every set
//   nub scripts/schedule-extract-eval.ts --models haiku --sets negatives,history
//   nub scripts/schedule-extract-eval.ts --check                        the fixture's own integrity, no model
//   nub scripts/schedule-extract-eval.ts --trigger-rate                 the history's trigger rate, no model
//     --concurrency 4   reads in flight at once across all models (latency under 4 is the box's 1 plus load)
//     --limit N         the first N of each set (a smoke run)
//     --repeat N        every case N times (run-to-run noise)
//     --history-file P  another history file; --history-limit N reads only the first N triggered prompts
//     --out P           the per-case results as JSON (no history text)
//     --replay P        report a saved `--out` file again, with no model call (models from the file)
//
// Run it from a plain shell, or it strips this process's own CLAUDE_CODE_* session variables first: a
// child CLI that inherits an agent session's variables is not the CLI the server spawns.
//
// The fixture (scripts/schedule-extract-eval.fixture.json) stores every expectation as a rule and a start
// beside the runs computed from them, and this re-derives the runs on every load — a change to the rule
// engine that moves a run fails `--check` instead of silently re-grading the models. Its positives began as
// the exact readings of the retired local grammar's corpus (packages/shared/src/schedule-phrase.corpus.ts at
// 7e0b68b5), each kept only after a hand check, plus hand-written prompts; it was built on 2026-10-06.
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { compileSchedule, localWallString, occurrencesAfter } from "../packages/shared/src/schedule-rule.ts"
import { hasScheduleTrigger, scheduleTriggerSpans } from "../packages/shared/src/schedule-trigger.ts"
import { createClaudeOneShot, type ClaudeOneShotRequest } from "../packages/server/src/backend/claude-oneshot.ts"
import { createScheduleInterpreter, SCHEDULE_INTERPRETER_MODEL } from "../packages/server/src/schedule-interpreter.ts"
import type { ThreadScheduleRow } from "../packages/server/src/schedule-store.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..")
const FIXTURE = join(HERE, "schedule-extract-eval.fixture.json")

type Alt = { rule: string; dtstart: string; runs: string[]; why: string }
type Positive = { id: string; text: string; tz?: string; rule: string; dtstart: string; runs: string[]; alt?: Alt[]; condition?: true; phrase?: string; where?: string; source: string; note?: string }
type Field = { id: string; text: string; rule: string; dtstart: string; runs: string[]; alt?: Alt[] }
type Plain = { id: string; text: string; kind?: string }
type Fixture = {
  now: string
  tz: string
  existing: { title: string; when_text: string; rrule: string; dtstart: string; condition: string | null }
  positives: Positive[]
  field: Field[]
  oneOffs: Plain[]
  negatives: Plain[]
}

// ---- arguments --------------------------------------------------------------------------------------------
const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const models = (flag("--models") ?? "haiku,sonnet").split(",").map((m) => m.trim()).filter(Boolean)
const SETS = ["positives", "field", "oneOffs", "negatives", "history"] as const
type SetName = (typeof SETS)[number]
const sets = new Set<SetName>((flag("--sets")?.split(",") ?? [...SETS]).map((s) => (s === "oneoffs" ? "oneOffs" : s) as SetName))
const concurrency = Math.max(1, Number(flag("--concurrency") ?? 4))
const limit = flag("--limit") ? Number(flag("--limit")) : Infinity
const replay = flag("--replay")
const replayed = replay ? (JSON.parse(readFileSync(replay, "utf8")) as Result[]) : undefined
if (replayed) models.splice(0, models.length, ...new Set(replayed.map((r) => r.model)))
const repeat = replayed
  ? Math.max(1, ...Object.values(replayed.reduce((m: Record<string, number>, r) => ((m[`${r.model}:${r.set}:${r.id}`] = (m[`${r.model}:${r.set}:${r.id}`] ?? 0) + 1), m), {})))
  : Math.max(1, Number(flag("--repeat") ?? 1))
const historyFile = flag("--history-file") ?? join(homedir(), ".claude", "history.jsonl")
const historyLimit = flag("--history-limit") ? Number(flag("--history-limit")) : Infinity
const out = flag("--out")

for (const key of Object.keys(process.env)) {
  if (/^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_PID$|CLAUDE_EFFORT$)/.test(key)) delete process.env[key]
}

// ---- the fixture, re-derived ------------------------------------------------------------------------------
const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture
const NOW = Date.parse(fixture.now)

function runsOf(rule: string, dtstart: string, tz: string): string[] | string {
  const compiled = compileSchedule({ rrule: rule, dtstart, tz })
  if (!compiled.ok) return compiled.error
  return occurrencesAfter(compiled.value, NOW, 5).map((ms) => localWallString(ms, tz))
}

function checkFixture(): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  const expect = (id: string, rule: string, dtstart: string, tz: string, runs: string[]) => {
    const got = runsOf(rule, dtstart, tz)
    if (typeof got === "string") problems.push(`${id}: ${rule} @${dtstart} no longer compiles: ${got}`)
    else if (got.join() !== runs.join()) problems.push(`${id}: ${rule} @${dtstart} now runs ${got.join(" ")}, the fixture says ${runs.join(" ")}`)
  }
  for (const p of fixture.positives) {
    expect(p.id, p.rule, p.dtstart, p.tz ?? fixture.tz, p.runs)
    for (const [i, a] of (p.alt ?? []).entries()) expect(`${p.id} alt ${i}`, a.rule, a.dtstart, p.tz ?? fixture.tz, a.runs)
    if (p.phrase && !p.text.includes(p.phrase)) problems.push(`${p.id}: phrase "${p.phrase}" is not in its text`)
  }
  for (const f of fixture.field) {
    expect(f.id, f.rule, f.dtstart, fixture.tz, f.runs)
    for (const [i, a] of (f.alt ?? []).entries()) expect(`${f.id} alt ${i}`, a.rule, a.dtstart, fixture.tz, a.runs)
  }
  for (const n of [...fixture.negatives, ...fixture.oneOffs]) {
    if (!hasScheduleTrigger(n.text)) problems.push(`${n.id}: "${n.text}" holds no trigger word, so the box would never ask`)
  }
  for (const c of [...fixture.positives, ...fixture.field, ...fixture.oneOffs, ...fixture.negatives]) {
    if (seen.has(c.id)) problems.push(`duplicate id ${c.id}`)
    seen.add(c.id)
  }
  return problems
}

// ---- the maintainer's history (never persisted) -----------------------------------------------------------
/** Prompts as scripts/schedule-phrase-history.ts read them (7e0b68b5): no slash commands, nothing of 3
 *  characters or fewer. */
function loadHistory(): string[] | undefined {
  if (!existsSync(historyFile)) return undefined
  const prompts: string[] = []
  for (const raw of readFileSync(historyFile, "utf8").split("\n")) {
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
  return prompts
}

const BOUNDARY = /[\s.,;:!?]/
/** How many reads typing `text` would start (D3): a read fires when a word completes or after a 500ms pause,
 *  only once a trigger word has completed; one is in flight at a time and only the LATEST text waits behind
 *  it; at most 40 per draft; and a submit whose text was never read reads once more. Typed at `cps`
 *  characters a second with no pauses, then submitted a second after the last key; each read takes
 *  `latencyMs`. With `latencyMs` 0 it is the upper bound: one read per completed word. */
function readsWhileTyping(text: string, cps: number, latencyMs: number): number {
  const first = scheduleTriggerSpans(text)[0]
  if (!first) return 0
  const fires: { at: number; upTo: number }[] = []
  for (let i = first.end; i < text.length; i++) if (BOUNDARY.test(text[i]!) && !BOUNDARY.test(text[i - 1]!)) fires.push({ at: (i + 1) / cps * 1000, upTo: i + 1 })
  if (!BOUNDARY.test(text.at(-1)!)) fires.push({ at: text.length / cps * 1000 + 500, upTo: text.length })
  let reads = 0, busyUntil = -1, lastRead = -1
  let queued: { upTo: number } | undefined
  const fire = (upTo: number, at: number) => {
    if (reads >= 40) return
    reads++
    lastRead = upTo
    busyUntil = at + latencyMs
  }
  for (const f of fires) {
    if (queued && busyUntil <= f.at) { fire(queued.upTo, busyUntil); queued = undefined }
    if (f.at >= busyUntil) fire(f.upTo, f.at)
    else queued = f
  }
  if (queued) fire(queued.upTo, busyUntil)
  if (lastRead !== text.length && reads < 40) reads++
  return reads
}

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "–")
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!
}
const median = (xs: number[]) => quantile(xs, 0.5)

function triggerRate(history: string[]): string[] {
  const unique = [...new Set(history)]
  const hit = unique.filter((t) => hasScheduleTrigger(t))
  const reads = (latencyMs: number) => {
    const xs = hit.map((t) => readsWhileTyping(t, 5, latencyMs))
    return `median ${median(xs)}, p90 ${quantile(xs, 0.9)}, mean ${(xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)).toFixed(1)}`
  }
  const words = new Map<string, number>()
  for (const t of hit) for (const w of new Set(scheduleTriggerSpans(t).map((s) => s.word))) words.set(w, (words.get(w) ?? 0) + 1)
  return [
    `trigger rate: ${hit.length} of ${unique.length} unique past prompts (${pct(hit.length, unique.length)}) would call the model at least once`,
    `  reads typing one at 5 chars/s, submit included: ${reads(2000)} at 2s a read; ${reads(4000)} at 4s; upper bound (a read per word, cap 40) ${reads(0)}`,
    `  prompts per word: ${[...words].sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w} ${n}`).join(", ")}`,
  ]
}

// ---- grading ----------------------------------------------------------------------------------------------
type Outcome =
  | { kind: "same"; alt: boolean; phraseExact?: boolean; condition?: boolean }
  | { kind: "wrong"; got: string[]; rrule: string; dtstart: string; phrase: string }
  | { kind: "missed"; error: string }
  | { kind: "none"; error: string }
  | { kind: "found"; rrule: string; dtstart: string; phrase: string }
  | { kind: "failed"; error: string }
type Result = { set: SetName; id: string; model: string; ms: number; calls: number; outcome: Outcome; text?: string }

const MODEL_FAILURE = /^Couldn't read that just now|did not answer within/
function grade(set: SetName, expected: { runs: string[]; alt?: Alt[]; phrase?: string; condition?: true; tz?: string } | undefined, r: Awaited<ReturnType<ReturnType<typeof createScheduleInterpreter>["interpret"]>>): Outcome {
  if (!r.ok) {
    if (MODEL_FAILURE.test(r.error)) return { kind: "failed", error: r.error }
    return expected ? { kind: "missed", error: r.error } : { kind: "none", error: r.error }
  }
  if (!expected) return { kind: "found", rrule: r.rrule, dtstart: r.dtstart, phrase: r.phrase }
  const got = runsOf(r.rrule, r.dtstart, r.tz)
  const gotRuns = typeof got === "string" ? [got] : got
  const main = gotRuns.join() === expected.runs.join()
  const alt = !main && (expected.alt ?? []).some((a) => a.runs.join() === gotRuns.join())
  if (!main && !alt) return { kind: "wrong", got: gotRuns, rrule: r.rrule, dtstart: r.dtstart, phrase: r.phrase }
  return {
    kind: "same",
    alt,
    ...(expected.phrase ? { phraseExact: r.phrase.trim().toLowerCase() === expected.phrase.trim().toLowerCase() } : {}),
    ...(expected.condition ? { condition: !!r.condition } : {}),
  }
}

/** Exact two-sided McNemar p for paired binary outcomes: b = cases only A failed, c = only B failed. */
function mcnemar(b: number, c: number): number {
  const n = b + c
  if (!n) return 1
  const k = Math.min(b, c)
  let tail = 0
  let coef = 1
  for (let i = 0; i <= n; i++) {
    if (i > 0) coef = (coef * (n - i + 1)) / i
    if (i <= k) tail += coef
  }
  return Math.min(1, (2 * tail) / 2 ** n)
}

// ---- main -------------------------------------------------------------------------------------------------
const problems = checkFixture()
if (problems.length) {
  console.error(`schedule-extract-eval: the fixture no longer re-derives:\n  ${problems.join("\n  ")}`)
  process.exit(1)
}
const history = loadHistory()
if (args.includes("--check")) {
  console.log(`schedule-extract-eval: fixture OK — ${fixture.positives.length} positives, ${fixture.field.length} field, ${fixture.oneOffs.length} one-offs, ${fixture.negatives.length} negatives`)
  process.exit(0)
}
if (args.includes("--trigger-rate")) {
  if (!history) console.log(`schedule-extract-eval: no ${historyFile}`)
  else for (const line of triggerRate(history)) console.log(line)
  process.exit(0)
}

type Case = { set: SetName; id: string; text: string; tz: string; expected?: Positive | Field; existing?: boolean; private?: boolean }
const cases: Case[] = []
const take = <T,>(xs: T[]) => xs.slice(0, limit)
if (sets.has("positives")) for (const p of take(fixture.positives)) cases.push({ set: "positives", id: p.id, text: p.text, tz: p.tz ?? fixture.tz, expected: p })
if (sets.has("field")) for (const f of take(fixture.field)) cases.push({ set: "field", id: f.id, text: f.text, tz: fixture.tz, expected: f, existing: true })
if (sets.has("oneOffs")) for (const o of take(fixture.oneOffs)) cases.push({ set: "oneOffs", id: o.id, text: o.text, tz: fixture.tz })
if (sets.has("negatives")) for (const n of take(fixture.negatives)) cases.push({ set: "negatives", id: n.id, text: n.text, tz: fixture.tz })
let historyTriggered = 0
if (sets.has("history") && history) {
  const triggered = [...new Set(history)].filter((t) => hasScheduleTrigger(t))
  historyTriggered = triggered.length
  for (const [i, text] of take(triggered.slice(0, historyLimit)).entries()) cases.push({ set: "history", id: `h${i + 1}`, text, tz: fixture.tz, private: true })
}

const existing = { ...fixture.existing, tz: fixture.tz } as unknown as ThreadScheduleRow
// One completer per model, shared by every read of that model, so `concurrency` bounds its live CLIs as the
// server's does. Each read gets its own interpreter over it only to count the model calls the read made.
const completers = new Map(models.map((model) => [model, createClaudeOneShot({ cwd: ROOT, model, concurrency, timeoutMs: 90_000 })]))

// Round-robin by case, alternating the model order, so load drift lands on every model alike.
const jobs: { c: Case; model: string; rep: number }[] = []
for (let rep = 0; rep < repeat; rep++) {
  for (const [i, c] of cases.entries()) for (const model of i % 2 ? [...models].reverse() : models) jobs.push({ c, model, rep })
}
if (!replayed) console.log(`schedule-extract-eval: ${cases.length} cases × ${models.length} models × ${repeat} = ${jobs.length} reads, ${concurrency} at a time, clock ${fixture.now}`)

const results: Result[] = replayed ? [...replayed] : []
if (replayed) jobs.length = 0
let next = 0
let done = 0
const started = performance.now()
async function worker() {
  for (;;) {
    const job = jobs[next++]
    if (!job) return
    const { c, model } = job
    let calls = 0
    const counting = createScheduleInterpreter({
      complete: (request: ClaudeOneShotRequest) => (calls++, completers.get(model)!(request)),
      now: () => NOW,
      model,
    })
    const t = performance.now()
    let outcome: Outcome
    try {
      const r = await counting.interpret({ text: c.text, tz: c.tz, ...(c.existing ? { existing } : {}) })
      outcome = grade(c.set, c.expected, r)
    } catch (error) {
      outcome = { kind: "failed", error: error instanceof Error ? error.message : String(error) }
    }
    const ms = performance.now() - t
    results.push({ set: c.set, id: c.id, model, ms, calls, outcome, ...(c.private ? {} : { text: c.text }) })
    done++
    if (done % 20 === 0 || done === jobs.length) {
      process.stderr.write(`  ${done}/${jobs.length} reads, ${Math.round((performance.now() - started) / 1000)}s\n`)
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, worker))

// ---- report -----------------------------------------------------------------------------------------------
const lines: string[] = []
const byModel = (model: string, set: SetName) => results.filter((r) => r.model === model && r.set === set)
const count = (rs: Result[], kind: Outcome["kind"]) => rs.filter((r) => r.outcome.kind === kind).length
// A replay names history cases by position only; the history file may have changed since, so their text is
// not looked up again.
const caseText = new Map(cases.filter((c) => !(replayed && c.private)).map((c) => [`${c.set}:${c.id}`, c.text]))
for (const model of models) {
  const all = results.filter((r) => r.model === model)
  const ms = all.filter((r) => r.outcome.kind !== "failed").map((r) => r.ms)
  lines.push(`\n== ${model} ==  latency per read: median ${(median(ms) / 1000).toFixed(2)}s, p90 ${(quantile(ms, 0.9) / 1000).toFixed(2)}s (n=${ms.length}, ${concurrency} in flight); second model calls ${all.filter((r) => r.calls > 1).length}; failed calls ${count(all, "failed")}`)
  for (const set of ["positives", "field"] as const) {
    const rs = byModel(model, set)
    if (!rs.length) continue
    const same = rs.filter((r) => r.outcome.kind === "same")
    const viaAlt = same.filter((r) => r.outcome.kind === "same" && r.outcome.alt).length
    const phrase = same.filter((r) => r.outcome.kind === "same" && r.outcome.phraseExact !== undefined)
    const phraseExact = phrase.filter((r) => r.outcome.kind === "same" && r.outcome.phraseExact).length
    const cond = same.filter((r) => r.outcome.kind === "same" && r.outcome.condition !== undefined)
    const condOk = cond.filter((r) => r.outcome.kind === "same" && r.outcome.condition).length
    lines.push(`  ${set.padEnd(10)} same runs ${same.length}/${rs.length} (${pct(same.length, rs.length)}; ${viaAlt} via an alt)  WRONG ${count(rs, "wrong")}  missed ${count(rs, "missed")}  failed ${count(rs, "failed")}${set === "positives" ? `  phrase exact ${phraseExact}/${phrase.length}  condition kept ${condOk}/${cond.length}` : ""}`)
  }
  for (const set of ["oneOffs", "negatives", "history"] as const) {
    const rs = byModel(model, set)
    if (!rs.length) continue
    lines.push(`  ${set.padEnd(10)} false positives ${count(rs, "found")}/${rs.length - count(rs, "failed")} (${pct(count(rs, "found"), rs.length - count(rs, "failed"))})  failed ${count(rs, "failed")}`)
  }
}

// THE CHOICE, by the rule the model was chosen with: the LIGHTEST model whose wrong schedules are no worse than
// the best model's by more than noise (paired exact McNemar on the same cases, p < 0.05 counts as worse), and
// whose false positives are low (at most FP_CEILING of every no-schedule case it read) and no worse than the
// best model's by more than noise. Wrong schedules rank first because a wrong one can be saved by a human
// who trusts the strip; a missed one only starts the task now, and the human sees no ↻.
const LIGHTNESS = ["haiku", "sonnet", "opus"]
const FP_CEILING = 0.03
const key = (r: Result) => `${r.set}:${r.id}`
/** Per case, how many of its reads (over `--repeat`) were `kind`. */
function tally(model: string, setsOf: SetName[], kind: Outcome["kind"]): Map<string, number> {
  const s = new Map<string, number>()
  for (const r of results) if (r.model === model && setsOf.includes(r.set) && r.outcome.kind !== "failed") s.set(key(r), (s.get(key(r)) ?? 0) + (r.outcome.kind === kind ? 1 : 0))
  return s
}
function paired(a: Map<string, number>, b: Map<string, number>): { onlyA: number; onlyB: number; p: number } {
  let onlyA = 0, onlyB = 0
  for (const [k, v] of a) {
    const w = b.get(k)
    if (w === undefined) continue
    if (v > w) onlyA += v - w
    if (w > v) onlyB += w - v
  }
  return { onlyA, onlyB, p: mcnemar(onlyA, onlyB) }
}
const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0)
const GRADED: SetName[] = ["positives", "field"]
const CLEAN: SetName[] = ["oneOffs", "negatives", "history"]
if (results.some((r) => GRADED.includes(r.set)) && results.some((r) => CLEAN.includes(r.set))) {
  const wrong = new Map(models.map((m) => [m, tally(m, GRADED, "wrong")]))
  const fp = new Map(models.map((m) => [m, tally(m, CLEAN, "found")]))
  const bestWrong = [...models].sort((a, b) => total(wrong.get(a)!) - total(wrong.get(b)!))[0]!
  const bestFp = [...models].sort((a, b) => total(fp.get(a)!) - total(fp.get(b)!))[0]!
  lines.push(`
the choice — lightest model whose wrong schedules and false positives are no worse than the best's beyond noise (exact McNemar, p < 0.05 = worse), with false positives at most ${FP_CEILING * 100}%:`)
  const passing: string[] = []
  for (const m of models) {
    const w = paired(wrong.get(m)!, wrong.get(bestWrong)!)
    const f = paired(fp.get(m)!, fp.get(bestFp)!)
    const fpRate = total(fp.get(m)!) / Math.max(1, fp.get(m)!.size * repeat)
    const ok = (m === bestWrong || w.onlyA <= w.onlyB || w.p >= 0.05) && fpRate <= FP_CEILING && (m === bestFp || f.onlyA <= f.onlyB || f.p >= 0.05)
    if (ok) passing.push(m)
    lines.push(`  ${m.padEnd(7)} wrong ${total(wrong.get(m)!)}${m === bestWrong ? " (best)" : ` vs ${bestWrong}: ${w.onlyA} only ${m}, ${w.onlyB} only ${bestWrong}, p ${w.p.toFixed(3)}`}; false positives ${pct(total(fp.get(m)!), fp.get(m)!.size * repeat)}${m === bestFp ? " (best)" : ` vs ${bestFp}: ${f.onlyA} only ${m}, ${f.onlyB} only ${bestFp}, p ${f.p.toFixed(3)}`} → ${ok ? "passes" : "fails"}`)
  }
  const rank = (m: string) => (LIGHTNESS.includes(m) ? LIGHTNESS.indexOf(m) : LIGHTNESS.length)
  const choice = [...passing].sort((a, b) => rank(a) - rank(b))[0]
  lines.push(`  → ${choice ? `choose ${choice}` : "no model passes"}; schedule-interpreter.ts has SCHEDULE_INTERPRETER_MODEL = "${SCHEDULE_INTERPRETER_MODEL}"`)
}

const ungated = fixture.positives.filter((p) => !hasScheduleTrigger(p.text))
lines.push(`\npositives with no trigger word, which the box never asks about: ${ungated.length} of ${fixture.positives.length}${ungated.length ? ` — ${ungated.map((p) => JSON.stringify(p.text)).join(", ")}` : ""}`)
if (history) lines.push("", ...triggerRate(history), `  history cases read here: ${results.filter((r) => r.set === "history").length / Math.max(1, models.length * repeat)} of ${historyTriggered}`)
lines.push(replayed ? `\nreplayed ${results.length} reads from ${replay}` : `\n${jobs.length} reads in ${Math.round((performance.now() - started) / 1000)}s`)

// The failures, for reading: every wrong schedule, every miss, every false positive (history ones print here
// and nowhere else).
const detail: string[] = []
for (const r of results) {
  const text = r.text ?? caseText.get(`${r.set}:${r.id}`) ?? ""
  const shown = JSON.stringify(text.length > 160 ? `${text.slice(0, 157)}…` : text)
  const o = r.outcome
  if (o.kind === "wrong") detail.push(`WRONG  ${r.model} ${r.id} ${shown}\n         «${o.phrase}» ${o.rrule} @${o.dtstart} → ${o.got.join(" ")}`)
  if (o.kind === "missed") detail.push(`MISSED ${r.model} ${r.id} ${shown}\n         ${o.error}`)
  if (o.kind === "found") detail.push(`FP     ${r.model} ${r.set} ${r.id} ${shown}\n         «${o.phrase}» ${o.rrule} @${o.dtstart}`)
  if (o.kind === "failed") detail.push(`FAILED ${r.model} ${r.id} ${o.error}`)
}
if (detail.length) console.log(`\n${detail.sort().join("\n")}`)
console.log(lines.join("\n"))

if (out) {
  writeFileSync(out, JSON.stringify(results.map(({ text: _t, ...r }) => r), null, 1) + "\n")
  console.log(`\nper-case results: ${out}`)
}
process.exit(0)
