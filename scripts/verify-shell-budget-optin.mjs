// THE OPT-IN SHELL BUDGET against REAL background shells (server shell-budget.ts, scheduler SOURCE 13).
//
// A real Claude worker launches four real `sleep` processes with `run_in_background`, and the real
// scheduler has to treat each one by what the worker DECLARED — never by a default:
//
//   A  sleep 1781, `timeout: 60000`          declared 1m          → warned at 1m, STOPPED 10m later
//   B  sleep 1782, no timeout                unbudgeted           → never warned, still running  (control)
//   C  sleep 1783, `timeout: 60000` + watch  held by a 30m watch  → not warned, still running    (control)
//   D  sleep 1784, no timeout + extend 1m    budget GIVEN later   → warned at 1m, STOPPED 10m later
//
// …and the PreToolUse hook's spawn-time prompt must reach the model for B and D (no `timeout`) and for
// neither A nor C. Liveness is asked of the OS (`ps`), not of frizz's own view.
//
// Needs a stack with real credentials AND the scheduler armed:
//   nub scripts/adhoc-stack.mjs --port=45580 --project=/tmp/<throwaway git repo> --creds --wakers > /tmp/stack.log 2>&1
//   nub scripts/verify-shell-budget-optin.mjs 45580
// Takes ~13 minutes of wall clock: the grace is the production constant, not shortened for a test.
// Afterwards kill the stack by pid and any broker daemon under its HOME; this kills the sleeps it made.
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createRpcClient } from "./lib/rpc-client.mjs"

const port = process.argv[2] ?? "45580"
const api = createRpcClient(`http://127.0.0.1:${port}/`)
await api.waitForHealth()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const board0 = await api.query("board")
const cwdSlug = board0.projectDir.replace(/[^A-Za-z0-9]/g, "-")
const t0 = Date.now()
const stamp = () => `[+${Math.round((Date.now() - t0) / 1000)}s]`
let failed = 0
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${stamp()} ${what}`)
  if (!ok) failed++
}

const SECS = { A: 1781, B: 1782, C: 1783, D: 1784 }
const alive = (secs) => {
  const out = execFileSync("ps", ["-Ao", "pid,args"], { encoding: "utf8" })
  return out.split("\n").some((l) => new RegExp(`\\bsleep ${secs}\\b`).test(l) && !/\bps\b/.test(l))
}
for (const [k, s] of Object.entries(SECS)) if (alive(s)) throw new Error(`a stray \`sleep ${s}\` (${k}) is already running — kill it first`)

const PROMPT = [
  "This is a scripted test. Do exactly these steps, in order, and nothing else.",
  "1. Bash with run_in_background: true, timeout: 60000, description: \"shell sleep 1781\", command: sleep 1781",
  "2. Bash with run_in_background: true, NO timeout parameter at all, description: \"shell sleep 1782\", command: sleep 1782",
  "3. Bash with run_in_background: true, timeout: 60000, description: \"shell sleep 1783\", command: sleep 1783",
  "4. Bash with run_in_background: true, NO timeout parameter at all, description: \"shell sleep 1784\", command: sleep 1784",
  "5. Call mcp__frizz__watch with kind \"shell\", target = the background task ID step 3 returned, for \"30m\".",
  "6. Call mcp__frizz__extend_shell with shell = the background task ID step 4 returned, for \"1m\".",
  "7. Reply with exactly: LAUNCHED and end your turn. Do not stop, check or wait on any shell.",
  "Later you may be woken by Frizz messages about these shells. For every such message: make NO tool",
  "calls at all (never TaskStop, never extend_shell), reply with exactly NOTED, and end your turn.",
].join("\n")
const { slug, sessionId } = await api.mutate("dispatch", { prompt: PROMPT, backend: "claude", model: "haiku", effort: "low" })
console.log(`dispatched ${slug} (${sessionId}) — http://127.0.0.1:${port}/thread/${slug}`)

const transcript = () => {
  const p = join(homedir(), ".claude", "projects", cwdSlug, `${sessionId}.jsonl`)
  return existsSync(p) ? readFileSync(p, "utf8") : ""
}
const records = () => transcript().split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
const assistantText = () => records().filter((r) => r.type === "assistant")
  .flatMap((r) => (Array.isArray(r.message?.content) ? r.message.content : [])).filter((b) => b?.type === "text").map((b) => b.text).join("\n")
const thread = async () => (await api.query("board")).threads.find((t) => t.id === slug)
const shellOf = (th, secs) => (th?.bgShells ?? []).find((s) => s.label.includes(`sleep ${secs}`))

// ---- 1. the launch, and the spawn-time prompt ----
for (let deadline = Date.now() + 300_000; ;) {
  if (/LAUNCHED/.test(assistantText())) break
  if (Date.now() > deadline) throw new Error("TIMEOUT: the worker never finished launching")
  await sleep(3_000)
}
const tLaunched = Date.now()
for (const [k, s] of Object.entries(SECS)) check(alive(s), `${k} (sleep ${s}) is a real running process after launch`)

// Which Bash calls the hook's context was attached to: Claude Code records it as a
// `hook_additional_context` attachment carrying the tool_use id it annotates — the proof that the text
// reached the model's context, not only the hook's stdout. (Run 3's first cut matched by file position
// and misattributed a parallel batch; the id is exact.)
const PROMPT_MARK = "background shell with no `timeout`"
const commandOf = new Map()
for (const r of records()) {
  if (r.type !== "assistant") continue
  for (const b of r.message?.content ?? []) {
    const m = b?.type === "tool_use" && b.name === "Bash" ? /^sleep (178\d)$/.exec(String(b.input?.command ?? "")) : null
    if (m) commandOf.set(b.id, Number(m[1]))
  }
}
const annotated = records()
  .filter((r) => r.attachment?.type === "hook_additional_context" && JSON.stringify(r.attachment.content ?? "").includes(PROMPT_MARK))
  .map((r) => commandOf.get(r.attachment.toolUseID))
const annotatedSet = new Set(annotated)
check(annotatedSet.has(SECS.B) && annotatedSet.has(SECS.D), `the spawn-time prompt reached the model after the untimed launches (B, D): saw ${JSON.stringify([...annotatedSet])}`)
check(!annotatedSet.has(SECS.A) && !annotatedSet.has(SECS.C), "…and after neither timed launch (A, C) — a declared timeout is not nagged")

// ---- 2. what the board says each shell's budget is ----
// The row's label is the call's `description`, which the prompt pins to contain the command. Wait for all
// four rows AND D's extension to reach the board before reading it.
let th = await thread()
const ready = () => Object.values(SECS).every((s) => shellOf(th, s)) && shellOf(th, SECS.D)?.budgetEndsAt
for (let deadline = Date.now() + 60_000; !ready() && Date.now() < deadline; ) { await sleep(2_000); th = await thread() }
if (!ready()) console.log("board labels seen:", JSON.stringify((th?.bgShells ?? []).map((s) => s.label)))
const view = Object.fromEntries(Object.entries(SECS).map(([k, s]) => [k, shellOf(th, s)]))
console.log("board budgets:", JSON.stringify(Object.fromEntries(Object.entries(view).map(([k, v]) => [k, v && { budgetMs: v.budgetMs, budgetEndsAt: v.budgetEndsAt }]))))
check(view.A?.budgetMs === 60_000 && !!view.A?.budgetEndsAt, "A carries its declared 1m budget and an end")
check(view.B && view.B.budgetMs === undefined && view.B.budgetEndsAt === undefined, "B carries NO budget and no end — there is no default")
check(view.C?.budgetEndsAt && Date.parse(view.C.budgetEndsAt) - Date.parse(view.C.startedAt) > 25 * 60_000, "C's end is held to its 30m watch, not its 1m budget")
check(view.D && view.D.budgetMs === undefined && !!view.D.budgetEndsAt, "D launched without a budget and was GIVEN one by extend_shell")

// ---- 3. the warnings, then the grace, against the OS ----
const warnedFor = () => {
  const out = new Set()
  for (const r of records()) {
    if (r.type !== "user") continue
    const text = JSON.stringify(r.message?.content ?? "")
    if (!/past its/.test(text)) continue
    for (const [k, s] of Object.entries(SECS)) if (text.includes(`sleep ${s}`)) out.add(k)
  }
  return out
}
// Up to the grace itself: two warnings due within seconds on ONE thread are delivered one wake at a time,
// and the second was measured arriving ~5m after the first (run 1, 2026-09-29) — the outbox's per-thread
// pacing, which predates this change. Each arrival instant is printed so that delay stays visible.
for (let deadline = Date.now() + 10 * 60_000; ;) {
  const w = warnedFor()
  if (w.has("A") && w.has("D")) break
  if (Date.now() > deadline) break
  await sleep(5_000)
}
let w = warnedFor()
for (const r of records()) {
  if (r.type === "user" && /past its/.test(JSON.stringify(r.message?.content ?? ""))) console.log(`  warning delivered ${r.timestamp}: ${JSON.stringify(r.message.content).slice(0, 90)}`)
}
check(w.has("A") && w.has("D"), `the declared (A) and given (D) budgets were warned: ${JSON.stringify([...w])}`)
check(!w.has("B") && !w.has("C"), "the unbudgeted (B) and watched (C) shells were not")

console.log(`${stamp()} waiting out the 10m grace against the OS…`)
for (let deadline = Date.now() + 14 * 60_000; ;) {
  if (!alive(SECS.A) && !alive(SECS.D)) break
  // Early exit on the failure signal: a control dying means the harness already has its answer.
  if (!alive(SECS.B) || !alive(SECS.C)) break
  if (Date.now() > deadline) break
  await sleep(10_000)
}
check(!alive(SECS.A), "A's real process is gone — stopped after the grace")
check(!alive(SECS.D), "D's real process is gone — the budget extend_shell gave it was enforced")
check(alive(SECS.B), "B's real process is STILL running — an undeclared shell is never stopped")
check(alive(SECS.C), "C's real process is STILL running — its watch held it past its own budget")
console.log(`${stamp()} ${Math.round((Date.now() - tLaunched) / 60_000)}m since launch`)
w = warnedFor()
check(!w.has("B") && !w.has("C"), `still no warning for B or C at the end: ${JSON.stringify([...w])}`)
const notices = records().filter((r) => r.type === "user" && /Frizz stopped your background command/.test(JSON.stringify(r.message?.content ?? "")))
check(notices.length === 2, `the worker was told of exactly two budget stops (saw ${notices.length})`)

// Clean up the sleeps this run made (exact commands only).
for (const s of Object.values(SECS)) {
  const out = execFileSync("ps", ["-Ao", "pid,args"], { encoding: "utf8" })
  for (const l of out.split("\n")) {
    const m = l.trim().match(new RegExp(`^(\\d+)\\s+sleep ${s}$`))
    if (m) try { process.kill(Number(m[1])) } catch {}
  }
}
console.log(failed ? `\n${failed} FAILED` : "\nALL PASS")
process.exitCode = failed ? 1 : 0
