#!/usr/bin/env node
// verify-spinoff.mjs — a SPINOFF, end to end, on a REAL Frizz with REAL Claude workers.
//
// What it proves (the human's Spinoff button → the `spinoff` RPC → the parent worker's side turn →
// `spawn_thread` → the child's dispatch → the tailer, board and chat projection at both ends):
//   1. PARENT AT REST ON A DONE CARD: the spinoff starts a child, and the parent comes back EXACTLY as it
//      was — same fence and body, same queue place, rested_at and unread untouched — with nothing of the
//      briefing turn left in its chat but the spinoff request itself. (Maintainer 2026-09-30: the worker's
//      "I started [Sub-agent addresses](…)" and a second Done card, "Nothing new landed here", were "very
//      confusing".) With the scheduler armed (--wakers on the stack), no sign-off nudge follows it.
//   2. THE CHILD: its first turn projects to the spinoff header's parts — the human's instructions as its
//      request, the parent's brief as context — never one user bubble; its name is not minted from the
//      "A spinoff of …" boilerplate.
//   3. PARENT IN DONE (archived): a spinoff from it leaves it in Done.
//   4. NEGATIVE CONTROL: an ordinary follow-up DOES move the parent's rest (rested_at advances), so the
//      "unchanged" checks above are able to fail.
//
// Needs a stack booted from THIS checkout with real credentials and the scheduler armed:
//
//   P=/tmp/spinoff-proj; rm -rf $P; mkdir -p $P && git -C $P init -q && printf '# Demo\n\nA tiny demo repo.\n' > $P/README.md && git -C $P add -A && git -C $P commit -qm init
//   nub scripts/adhoc-stack.mjs --port=45931 --project=/tmp/spinoff-proj --creds --wakers > /tmp/spinoff-stack.log 2>&1 &
//   nub scripts/verify-spinoff.mjs --url=http://127.0.0.1:45931/ --home=<the stack's "home">
//
// Workers run on haiku at low effort. Prints the parent and child slugs for screenshots; exits 1 on any
// failed assertion. Clean up afterwards: kill both threads' daemons (killAgent), the stack by its PID,
// and rm -rf the throwaway repo and ~/.claude/projects/-tmp-spinoff-proj.
import { DatabaseSync } from "node:sqlite"
import { createRpcClient } from "./lib/rpc-client.mjs"
import { resolveSandboxDb } from "./lib/sandbox-db.mjs"

const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3)
const url = arg("url")
const home = arg("home")
if (!url || !home) {
  console.error("usage: verify-spinoff.mjs --url=<stack url> --home=<stack home>")
  process.exit(2)
}

const api = createRpcClient(url)
const { db: dbPath } = resolveSandboxDb(home)
const sessionRow = (slug) => {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return db.prepare("SELECT slug, session_id, rested_at, unread, state, title FROM session WHERE slug = ?").get(slug)
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

async function boardThread(slug) {
  const board = await api.query("board")
  return board.threads.find((t) => t.id === slug)
}

/** Wait for `pred(thread)`; give up early when the thread has errored out. */
async function waitFor(what, slug, pred, timeoutMs) {
  const start = Date.now()
  for (;;) {
    const t = await boardThread(slug)
    if (t && pred(t)) return t
    if (t?.authFault || t?.providerError) throw new Error(`${slug} errored while waiting for ${what}: ${JSON.stringify(t.authFault ?? t.providerError)}`)
    if (Date.now() - start > timeoutMs) throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what} on ${slug} (runtime: ${t?.runtime}, fence: ${JSON.stringify(t?.lastFence)})`)
    await sleep(2000)
  }
}

const atRest = (t) => Boolean(t) && (t.runtime === "turn-idle" || t.runtime === "exited") && !(t.subAgents ?? []).some((s) => s.state === "running")
const transcript = async (slug) => (await api.query("threadTranscript", { slug })).messages
const edgeOf = (t, id) => t?.spinoffs?.find((o) => o.id === id)

/** Spinoff from `parent`, wait for its child and for the parent to settle again; returns the child slug. */
async function spinoff(parent, instructions) {
  const { id } = await api.mutate("spinoff", { slug: parent.slug, sessionId: sessionRow(parent.slug).session_id, instructions })
  console.log(`spinoff ${id} requested`)
  const withChild = await waitFor("the spinoff's child", parent.slug, (t) => Boolean(edgeOf(t, id)?.childSlug), 300_000)
  const childSlug = edgeOf(withChild, id).childSlug
  console.log(`spinoff ${id} became ${childSlug}`)
  await waitFor("the parent to rest after its side turn", parent.slug, atRest, 180_000)
  // A beat for the tailer's rest edge and a board push to land.
  await sleep(4000)
  return { id, childSlug }
}

await api.waitForHealth()

// ---- 1. a parent at rest on a done card ----------------------------------------------------------------
const profile = { model: "haiku", effort: "low" }
const parent = await api.mutate("dispatch", {
  prompt: "Read README.md and tell me in one sentence what this project is. Edit nothing. Then sign off: this is the whole task.",
  ...profile,
})
console.log(`parent ${parent.slug}`)
const signed = await waitFor("the parent's done card", parent.slug, (t) => atRest(t) && t.lastFence?.kind === "done", 300_000)
await sleep(4000)
const before = { thread: await boardThread(parent.slug), row: sessionRow(parent.slug), messages: await transcript(parent.slug) }
console.log(`parent signed off: ${JSON.stringify(signed.lastFence.body).slice(0, 120)}`)

// The instructions reach the CHILD verbatim, so they say nothing to the parent: "Dispatch the new thread on
// haiku" read to the child as its own task, and it spawned a third thread (first run, 2026-09-30). The model
// hint is phrased as commentary instead, for the parent to pick up.
const instructions = "Draft a two-sentence CONTRIBUTING.md for this repo and write it to CONTRIBUTING.md (a quick job — haiku at low effort is plenty)."
const first = await spinoff(parent, instructions)
const after = { thread: await boardThread(parent.slug), row: sessionRow(parent.slug), messages: await transcript(parent.slug) }

check(after.thread.lastFence?.kind === "done" && after.thread.lastFence?.body === before.thread.lastFence?.body,
  "the parent's done card is the one it had before the spinoff", JSON.stringify(after.thread.lastFence?.body ?? null).slice(0, 120))
check(after.thread.needsYou === before.thread.needsYou && after.thread.queuedAt === before.thread.queuedAt,
  "the parent keeps its place in the queue", `needsYou ${before.thread.needsYou}→${after.thread.needsYou}, queuedAt ${before.thread.queuedAt}→${after.thread.queuedAt}`)
check(after.row.rested_at === before.row.rested_at, "the parent's rest time did not move", `${before.row.rested_at} → ${after.row.rested_at}`)
check(after.row.unread === before.row.unread, "the parent was not marked unread", `${before.row.unread} → ${after.row.unread}`)
const added = after.messages.slice(before.messages.length)
check(added.length === 1 && added[0]?.spinoff?.id === first.id,
  "the parent's chat gained the spinoff request and nothing else", added.map((m) => `${m.role}${m.spinoff ? "(spinoff)" : ""}:${(m.displayText ?? m.text).slice(0, 60)}`).join(" | "))
check(!after.messages.some((m) => (m.tools ?? []).some((c) => c.spinoff) || m.parts?.some((p) => p.kind === "tools" && p.tools.some((c) => c.spinoff))),
  "no spawn_thread call is left in the parent's chat")

// ---- 2. the child ---------------------------------------------------------------------------------------
const childMessages = await transcript(first.childSlug)
const origin = childMessages[0]
check(origin?.role === "user" && origin?.spinoffOrigin?.instructions === instructions,
  "the child's first turn is its spinoff origin, carrying the human's instructions", JSON.stringify(origin?.spinoffOrigin?.instructions ?? null))
check((origin?.spinoffOrigin?.brief ?? "").trim().length > 40, "the origin carries the parent's brief as context", `${(origin?.spinoffOrigin?.brief ?? "").length} chars`)
check(origin?.displayText === instructions, "what the child was asked reads as the human's instructions, not the brief")
check(/@\S+/.test(origin?.text ?? "") && origin.text.includes("A spinoff of @"), "the child's prompt names the parent by @handle")
check(!first.childSlug.startsWith("a-spinoff-of"), "the child is not named after the prompt's boilerplate", first.childSlug)
const childThread = await boardThread(first.childSlug)
check(childThread?.spinoffs?.some((o) => o.id === first.id && o.parentSlug === parent.slug), "the child's board row carries the edge back to its parent")

// ---- 1b. no sign-off nudge follows the side turn ------------------------------------------------------
console.log("waiting 75s for any sign-off nudge to land on the parent…")
await sleep(75_000)
const later = await transcript(parent.slug)
check(later.length === after.messages.length, "no sign-off nudge or other wake reached the parent", `${after.messages.length} → ${later.length} messages`)

// ---- 3. a parent in Done stays in Done ------------------------------------------------------------------
await api.mutate("archiveThread", { slug: parent.slug })
await waitFor("the parent to be archived", parent.slug, (t) => t.state === "archived", 30_000)
const archivedBefore = sessionRow(parent.slug)
const second = await spinoff(parent, "List the files in this repo (a quick job — haiku at low effort is plenty).")
const archivedAfter = { thread: await boardThread(parent.slug), row: sessionRow(parent.slug) }
check(archivedAfter.thread.state === "archived" && archivedAfter.row.state === "archived", "a spinoff from a thread in Done leaves it in Done", `${archivedBefore.state} → ${archivedAfter.row.state}`)
check(Boolean(second.childSlug), "the spinoff from a thread in Done still started its child", second.childSlug)

// ---- 4. negative control: a real follow-up DOES move the rest --------------------------------------------
const controlBefore = sessionRow(parent.slug)
await api.mutate("followUp", { slug: parent.slug, sessionId: controlBefore.session_id, message: "Reply with the single word ok, then sign off." })
await waitFor("the parent to answer the follow-up", parent.slug, (t) => atRest(t) && (t.lastAssistantAt ?? "") > (controlBefore.rested_at ?? ""), 180_000)
await sleep(4000)
const controlAfter = sessionRow(parent.slug)
check(controlAfter.rested_at !== controlBefore.rested_at, "CONTROL: an ordinary follow-up does move the parent's rest time", `${controlBefore.rested_at} → ${controlAfter.rested_at}`)

console.log(JSON.stringify({ parent: parent.slug, children: [first.childSlug, second.childSlug] }))
console.log(failures ? `${failures} FAILED` : "ALL PASSED")
process.exit(failures ? 1 : 0)
