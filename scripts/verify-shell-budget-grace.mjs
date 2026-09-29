// THE BUDGET GRACE RUNS FROM DELIVERY, against REAL background shells (scheduler SOURCE 13,
// shellBudgetGraceFrom; wake-store's `shell-budget:` quiet-window exemption).
//
// The bug this pins (2026-09-29, run 1 of verify-shell-budget-optin.mjs): two shells whose warnings fell
// due seconds apart had them DELIVERED ~5m apart — the first warning's handoff opened the thread's 5m
// quiet window, which held the second — while the kill clock ran from the instant each was QUEUED. The
// second worker got ~5 of its 10 minutes.
//
// A real Claude worker launches two real `sleep`s with `run_in_background` and `timeout: 60000`, ~8s
// apart, so their deadlines fall on different 10s scheduler ticks (the case the quiet window caught; two
// on the same tick were always merged into one frame). For each shell, measured off the worker's own
// transcript and the OS process table:
//   · its warning reached the worker within ~30s of its deadline — not a quiet window later;
//   · its real process was killed no sooner than the full grace after THAT delivery, and within ~30s of it.
//
// Needs a stack with real credentials AND the scheduler armed:
//   nub scripts/adhoc-stack.mjs --port=45581 --project=/tmp/<throwaway git repo> --creds --wakers > /tmp/stack.log 2>&1
//   nub scripts/verify-shell-budget-grace.mjs 45581
// ~13 minutes of wall clock: the grace is the production constant. Afterwards kill the stack by pid and
// any broker daemon under its HOME; this kills the sleeps it made.
//
// Recorded 2026-09-29 (haiku worker, transcripts kept under ~/.claude/projects/-tmp-grace-proj/):
//   FIXED  (ccced037)  A: deadline→warning 6s, warning→kill 612s · B: 5s, 611s          ALL PASS
//   CONTROL (the two source files at ccced037~1, same harness):
//                      A: 270s, 342s · B: 256s, 351s — both held by the quiet window     4 FAILED
//   (The control run's two warnings were merged into one frame at 19:20:30; a wake handed to the thread
//   just before their deadlines had opened the window. Either way the kill clock ran from the queue.)
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createRpcClient } from "./lib/rpc-client.mjs"

const GRACE_MS = 10 * 60_000 // shell-budget.ts SHELL_BUDGET_GRACE_MS
const SLACK_MS = 30_000 // three scheduler ticks: the kill and the delivery each resolve at the 10s tick

const port = process.argv[2] ?? "45581"
const api = createRpcClient(`http://127.0.0.1:${port}/`)
await api.waitForHealth()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const board0 = await api.query("board")
// The sandbox HOME, when the stack has one: the transcript lives under the HOME the WORKER sees.
const home = process.env.STACK_HOME ?? homedir()
const cwdSlug = board0.projectDir.replace(/[^A-Za-z0-9]/g, "-")
const t0 = Date.now()
const stamp = () => `[+${Math.round((Date.now() - t0) / 1000)}s]`
let failed = 0
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${stamp()} ${what}`)
  if (!ok) failed++
}

const SECS = { A: 1791, B: 1792 }
const pidOf = (secs) => {
  const out = execFileSync("ps", ["-Ao", "pid,args"], { encoding: "utf8" })
  for (const l of out.split("\n")) {
    const m = l.trim().match(new RegExp(`^(\\d+)\\s+sleep ${secs}$`))
    if (m) return Number(m[1])
  }
  return undefined
}
for (const [k, s] of Object.entries(SECS)) if (pidOf(s)) throw new Error(`a stray \`sleep ${s}\` (${k}) is already running — kill it first`)

const PROMPT = [
  "This is a scripted test. Do exactly these steps, in order, one tool call per step, and nothing else.",
  "1. Bash with run_in_background: true, timeout: 60000, description: \"shell sleep 1791\", command: sleep 1791",
  "2. Bash (NOT in the background), description: \"pause\", command: sleep 8",
  "3. Bash with run_in_background: true, timeout: 60000, description: \"shell sleep 1792\", command: sleep 1792",
  "4. Reply with exactly: LAUNCHED and end your turn. Do not stop, check or wait on any shell.",
  "Later you may be woken by Frizz messages about these shells. For every such message: make NO tool",
  "calls at all (never TaskStop, never extend_shell), reply with exactly NOTED, and end your turn.",
].join("\n")
const { slug, sessionId } = await api.mutate("dispatch", { prompt: PROMPT, backend: "claude", model: "haiku", effort: "low" })
console.log(`dispatched ${slug} (${sessionId})`)

const transcriptPath = join(home, ".claude", "projects", cwdSlug, `${sessionId}.jsonl`)
const records = () => (existsSync(transcriptPath) ? readFileSync(transcriptPath, "utf8") : "")
  .split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
const assistantText = () => records().filter((r) => r.type === "assistant")
  .flatMap((r) => (Array.isArray(r.message?.content) ? r.message.content : [])).filter((b) => b?.type === "text").map((b) => b.text).join("\n")
const thread = async () => (await api.query("board")).threads.find((t) => t.id === slug)

for (let deadline = Date.now() + 300_000; ;) {
  if (/LAUNCHED/.test(assistantText())) break
  if (Date.now() > deadline) throw new Error(`TIMEOUT: the worker never finished launching (transcript ${transcriptPath} exists: ${existsSync(transcriptPath)})`)
  await sleep(3_000)
}
const pids = Object.fromEntries(Object.entries(SECS).map(([k, s]) => [k, pidOf(s)]))
check(!!pids.A && !!pids.B, `both sleeps are real running processes: ${JSON.stringify(pids)}`)

// Each shell's deadline, off the board (launch + its declared budget).
let th = await thread()
for (let d = Date.now() + 60_000; Date.now() < d && !Object.values(SECS).every((s) => th?.bgShells?.some((x) => x.label.includes(`sleep ${s}`))); ) { await sleep(2_000); th = await thread() }
const deadlineOf = {}
for (const [k, s] of Object.entries(SECS)) {
  const v = th?.bgShells?.find((x) => x.label.includes(`sleep ${s}`))
  deadlineOf[k] = v?.budgetEndsAt ? Date.parse(v.budgetEndsAt) : v ? Date.parse(v.startedAt) + (v.budgetMs ?? NaN) : NaN
}
console.log(`deadlines: A ${new Date(deadlineOf.A).toISOString()}  B ${new Date(deadlineOf.B).toISOString()}  (${(deadlineOf.B - deadlineOf.A) / 1000}s apart)`)
check(deadlineOf.B - deadlineOf.A >= 5_000, "the deadlines fall on different scheduler ticks (the case the quiet window used to hold)")

// The earliest transcript record carrying a shell's warning — a user message when the worker was idle,
// a queue-operation / queued_command when it arrived mid-turn: either is the instant the runtime had it.
const deliveredAt = (secs) => {
  let at
  for (const r of records()) {
    if (r.type === "assistant") continue
    const text = JSON.stringify(r)
    if (!/past its/.test(text) || !text.includes(`sleep ${secs}`) || !r.timestamp) continue
    const ms = Date.parse(r.timestamp)
    if (at === undefined || ms < at) at = ms
  }
  return at
}

// Poll the OS until both processes are gone, recording each kill instant. Early exit on the failure
// signal: a process killed BEFORE its warning was ever delivered is the answer already.
const killedAt = {}
for (let deadline = Date.now() + 16 * 60_000; ;) {
  for (const k of Object.keys(SECS)) {
    if (killedAt[k] === undefined && !pidOf(SECS[k])) {
      killedAt[k] = Date.now()
      console.log(`${stamp()} ${k} (sleep ${SECS[k]}) gone at ${new Date(killedAt[k]).toISOString()}`)
    }
  }
  if (Object.keys(SECS).every((k) => killedAt[k] !== undefined)) break
  if (Object.keys(SECS).some((k) => killedAt[k] !== undefined && deliveredAt(SECS[k]) === undefined)) break
  if (Date.now() > deadline) break
  await sleep(2_000)
}

for (const k of Object.keys(SECS)) {
  const warned = deliveredAt(SECS[k])
  console.log(`${k}: deadline ${new Date(deadlineOf[k]).toISOString()}  warning delivered ${warned ? new Date(warned).toISOString() : "NEVER"}  killed ${killedAt[k] ? new Date(killedAt[k]).toISOString() : "NOT"}`)
  check(warned !== undefined && warned - deadlineOf[k] <= SLACK_MS, `${k}'s warning reached the worker within ${SLACK_MS / 1000}s of its deadline (${warned ? Math.round((warned - deadlineOf[k]) / 1000) : "∞"}s)`)
  const grace = killedAt[k] !== undefined && warned !== undefined ? killedAt[k] - warned : NaN
  check(grace >= GRACE_MS - 5_000, `${k} lived the full ${GRACE_MS / 60_000}m after its warning landed (${Math.round(grace / 1000)}s; 5s allowed for transcript write lag)`)
  check(grace <= GRACE_MS + SLACK_MS, `…and was stopped within ${SLACK_MS / 1000}s of the grace running out`)
}
const notices = records().filter((r) => /Frizz stopped your background command/.test(JSON.stringify(r)) && r.type !== "assistant")
check(notices.length >= 2, `the worker was told of both budget stops (saw ${notices.length} records)`)

for (const s of Object.values(SECS)) { const p = pidOf(s); if (p) try { process.kill(p) } catch {} }
console.log(failed ? `\n${failed} FAILED` : "\nALL PASS")
process.exitCode = failed ? 1 : 0
