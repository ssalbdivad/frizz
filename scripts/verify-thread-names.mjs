#!/usr/bin/env node
// verify-thread-names.mjs — a thread's NAME and its STATUS, on a REAL Frizz with REAL Claude workers.
//
// What it proves, end to end (dispatch → the one-shot namer → the registry → the board, and the tailer's
// rest edge → the status writer → the board):
//   1. two threads dispatched with near-identical prompts are minted DISTINCT names of one or two words;
//   2. the uniqueness rule holds at the human's rename — NEGATIVE CONTROL: renaming B to A's name is
//      refused, and a distinct name goes through (which also locks it);
//   3. after the 5th operator message on A, a STATUS lands on A — and A's name does not move.
//
// Needs a stack booted from THIS checkout with real credentials (the workers and the namer are real):
//
//   nub scripts/adhoc-stack.mjs --port=45881 --project=/tmp/names-proj --creds > /tmp/names-stack.log 2>&1 &
//   nub scripts/verify-thread-names.mjs --url=http://127.0.0.1:45881/ --home=<the stack's "home">
//
// The workers are dispatched on haiku at low effort; each asks a trivial question about the throwaway
// project, so a full run is a handful of cheap turns. Exits 1 on any failed assertion.
import { DatabaseSync } from "node:sqlite"
import { createRpcClient } from "./lib/rpc-client.mjs"
import { resolveSandboxDb } from "./lib/sandbox-db.mjs"
import { foldThreadName } from "../packages/server/src/thread-names.ts"

const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3)
const url = arg("url")
const home = arg("home")
if (!url || !home) {
  console.error("usage: verify-thread-names.mjs --url=<stack url> --home=<stack home>")
  process.exit(2)
}

const api = createRpcClient(url)
const { db: dbPath } = resolveSandboxDb(home)
const sessionRow = (slug) => {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return db.prepare("SELECT slug, session_id, title, title_agent, title_locked, title_worker_renamed, status FROM session WHERE slug = ?").get(slug)
  } finally {
    db.close()
  }
}

let failures = 0
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const words = (name) => name.trim().split(/\s+/).length

async function boardThread(slug) {
  const board = await api.query("board")
  return board.threads.find((t) => t.id === slug)
}

/** Wait for `pred(row, thread)`; give up early when the thread has errored out. */
async function waitFor(what, slug, pred, timeoutMs) {
  const start = Date.now()
  for (;;) {
    const row = sessionRow(slug)
    const t = await boardThread(slug)
    if (row && pred(row, t)) return { row, t }
    if (Date.now() - start > timeoutMs) throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what} on ${slug} (row: ${JSON.stringify(row)}, runtime: ${t?.runtime})`)
    await sleep(2000)
  }
}

const atRest = (t) => Boolean(t) && (t.runtime === "turn-idle" || t.runtime === "exited") && !(t.subAgents ?? []).some((s) => s.state === "running")

await api.waitForHealth()

// ---- 1. two near-identical dispatches get distinct 1-2 word names ------------------------------------
const profile = { model: "haiku", effort: "low" }
const [a, b] = await Promise.all([
  api.mutate("dispatch", { prompt: "Read README.md and tell me in one sentence what this project is about. Do not edit anything.", ...profile }),
  api.mutate("dispatch", { prompt: "Read the README.md and tell me, in one sentence, what this project is about — don't edit anything.", ...profile }),
])
console.log(`dispatched ${a.slug} and ${b.slug}`)
const minted = async (slug) => (await waitFor("a minted name", slug, (row) => row.title_agent !== 0, 180_000)).row.title
const [nameA, nameB] = await Promise.all([minted(a.slug), minted(b.slug)])
console.log(`names: A=${JSON.stringify(nameA)} B=${JSON.stringify(nameB)}`)
check(words(nameA) <= 2, "A's name is one or two words", nameA)
check(words(nameB) <= 2, "B's name is one or two words", nameB)
check(foldThreadName(nameA) !== foldThreadName(nameB), "the two names are distinct (case/punctuation folded)", `${nameA} vs ${nameB}`)
const shownA = (await boardThread(a.slug))?.aiTitle
check(shownA === nameA, "the board shows A's minted name", String(shownA))

// ---- 3. status after the 5th operator message on A ---------------------------------------------------
let replied = (await waitFor("A's first rest", a.slug, (_row, t) => atRest(t) && Boolean(t.lastAssistantAt), 240_000)).t.lastAssistantAt
const followUps = [
  "How many markdown files are in the project root? Just the number.",
  "Which of them is the largest by line count?",
  "Give me that file's first heading, verbatim.",
  "Thanks — that's all I need from this thread for now.",
]
for (const [i, message] of followUps.entries()) {
  await api.mutate("followUp", { slug: a.slug, sessionId: a.sessionId, message, deliveryId: `verify-names-${Date.now()}-${i}` })
  // The send is accepted before the turn starts: a rest only counts once the worker has REPLIED since.
  replied = (await waitFor(`A's rest after message ${i + 2}`, a.slug, (_row, t) => atRest(t) && t.lastAssistantAt !== replied, 240_000)).t.lastAssistantAt
  console.log(`A rested after operator message ${i + 2}`)
}
const { row: statusRow } = await waitFor("A's status line", a.slug, (row) => Boolean(row.status), 120_000)
console.log(`status: ${JSON.stringify(statusRow.status)}`)
check(statusRow.status.length <= 80, "the status is a short line", `${statusRow.status.length} chars`)
const nameAfter = sessionRow(a.slug).title
check(nameAfter === nameA || sessionRow(a.slug).title_worker_renamed === 1, "the status never moved A's name", `${nameA} → ${nameAfter}`)
const tA = await boardThread(a.slug)
check(tA?.statusLine === statusRow.status, "the board carries the status as statusLine", String(tA?.statusLine))

// ---- 2. the human rename is held to the rule (negative control, then the positive) -------------------
const holderName = (await boardThread(a.slug))?.aiTitle ?? nameA
let refused = ""
try {
  await api.mutate("renameThread", { slug: b.slug, title: holderName.toUpperCase() })
} catch (error) {
  refused = error instanceof Error ? error.message : String(error)
}
check(/is already another open thread's name/.test(refused), "NEGATIVE CONTROL: renaming B to A's name is refused", refused || "it was accepted")
check(sessionRow(b.slug).title_locked === 0 || sessionRow(b.slug).title !== holderName, "the refused name never landed on B")
await api.mutate("renameThread", { slug: b.slug, title: "Verify harness" })
const renamed = sessionRow(b.slug)
check(renamed.title === "Verify harness" && renamed.title_locked === 1, "a distinct human rename lands and locks", JSON.stringify(renamed))

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS")
console.log(JSON.stringify({ a: a.slug, b: b.slug, nameA, nameB, statusA: statusRow.status }))
process.exit(failures ? 1 : 0)
