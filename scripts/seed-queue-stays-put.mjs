// Seed a disposable TWO-project adhoc stack for scripts/verify-queue-stays-put.mjs, which checks the
// guarantee the maintainer asked for on 2026-09-28: "it needs to be guaranteed that cards that I'm
// currently viewing on the screen don't move in their position."
//
// The launcher project gets FIVE queued threads (q1…q5, rested 50m…10m ago, oldest first) with long
// handoffs, so each card is tall and the queue scrolls; and FIVE running ones (r1…r5), whose last
// record is the human's turn — the verifier makes one rest on demand (an ARRIVAL) by appending the
// agent's end_turn, and makes a queued one leave on its own (a SELF-WAKE) by appending a Frizz wake. The
// other project gets one queued thread (p1) and two running (p2, p3), for the Everything page.
//
// Broker rows with one live stand-in daemon (a `sleep`), for the reason seed-queue-arrival.mjs gives: a
// thread whose transcript ends on a human turn reads RUNNING only while its broker daemon is alive. Kill
// the printed pid when the stack comes down.
//
// Usage: node scripts/seed-queue-stays-put.mjs --stack=/abs/stack.log
import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createRpcClient } from "./lib/rpc-client.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => { const s = a.slice(2); const i = s.indexOf("="); return i < 0 ? [s, true] : [s.slice(0, i), s.slice(i + 1)] }),
)
if (!flags.stack) {
  console.error("usage: node scripts/seed-queue-stays-put.mjs --stack=/abs/stack.log")
  process.exit(1)
}
const stack = JSON.parse(readFileSync(flags.stack, "utf8").split("\n").find((l) => l.startsWith("{\"url\"")))
const home = stack.home
const db = join(home, ".frizz/ui.db")
const api = createRpcClient(`${new URL(stack.url).origin}/`)
await api.waitForHealth()

const launcher = { id: stack.launcher.id, slug: stack.launcher.slug, dir: stack.launcher.dir ?? stack.project, stateDir: join(home, ".frizz/projects", stack.launcher.id) }
const tenant = stack.tenants[0] && { id: stack.tenants[0].id, slug: stack.tenants[0].slug, dir: stack.tenants[0].dir, stateDir: stack.tenants[0].stateDir }
if (!tenant) throw new Error("need a second project: boot the stack with --also-project")

const daemon = spawn("sleep", ["7200"], { detached: true, stdio: "ignore" })
daemon.unref()
const now = Date.now()
const ago = (m) => new Date(now - m * 60_000).toISOString()
let n = 0
const uuid = () => `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}`

// A handoff long enough that a card is most of a screen tall.
const handoff = (title) =>
  `${title} — done, over to you.\n\n` +
  Array.from({ length: 14 }, (_, i) => `${i + 1}. A line of the handoff that says something specific about ${title.toLowerCase()}, long enough to wrap once in the card.`).join("\n")

const sessions = {}
function seed(project, { slug, title, restedMinutesAgo, running = false }) {
  const sessionId = `7f000000-0000-4000-9000-${String(Object.keys(sessions).length + 1).padStart(12, "0")}`
  const jsonlDir = join(home, ".claude", "projects", project.dir.replace(/[/.]/g, "-"))
  mkdirSync(jsonlDir, { recursive: true })
  const brokerDir = join(project.stateDir, "claude-broker")
  mkdirSync(brokerDir, { recursive: true })
  const records = [
    { parentUuid: null, isSidechain: false, type: "user", uuid: uuid(), timestamp: ago(restedMinutesAgo + 5), session_id: sessionId, cwd: project.dir, message: { role: "user", content: `TASK:\n${title}` } },
    {
      parentUuid: null, isSidechain: false, type: "assistant", uuid: uuid(), timestamp: ago(restedMinutesAgo), session_id: sessionId, cwd: project.dir,
      message: { model: "claude-opus-5", id: `msg_${slug}`, type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: handoff(title) }], usage: { input_tokens: 2, output_tokens: 200 } },
    },
  ]
  // Running: the human has spoken since, and the agent has not answered yet.
  if (running) records.push({ parentUuid: null, isSidechain: false, type: "user", uuid: uuid(), timestamp: ago(1), session_id: sessionId, cwd: project.dir, message: { role: "user", content: `Keep going on ${title.toLowerCase()}.` } })
  const jsonl = join(jsonlDir, `${sessionId}.jsonl`)
  writeFileSync(jsonl, records.map((r) => JSON.stringify(r)).join("\n") + "\n")
  writeFileSync(
    join(brokerDir, `${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}.json`),
    JSON.stringify({ sessionId, daemonPid: daemon.pid, socketPath: join(brokerDir, `${slug}.sock`) }),
  )
  // `.timeout`: the server writes this same file continually, and a bare sqlite3 fails "database is locked".
  execFileSync("sqlite3", [
    "-cmd", ".timeout 10000",
    db,
    `INSERT OR REPLACE INTO session (project_id, slug, session_id, thread_name, spawned_at, title, backend, claude_runtime, model, effort, permission_mode, rested_at)
     VALUES ('${project.id}', '${slug}', '${sessionId}', 'frizz-${slug}', '${ago(restedMinutesAgo + 5)}', '${title}', 'claude', 'broker', 'opus', 'high', 'default', '${ago(restedMinutesAgo)}')`,
  ])
  // `handoff`: what the verifier appends when it makes the thread rest again, so a card that comes back
  // is exactly as tall as it was and any move it measures is a move, not new content.
  sessions[`${project === launcher ? "a" : "b"}/${slug}`] = { project: project.id, slug, sessionId, jsonl, cwd: project.dir, handoff: handoff(title) }
  console.log(`seeded ${project.slug}/${slug}${running ? " (running)" : ` (rested ${restedMinutesAgo}m ago)`}`)
}

seed(launcher, { slug: "q1", title: "Review the parser change", restedMinutesAgo: 50 })
seed(launcher, { slug: "q2", title: "Fix the flaky login test", restedMinutesAgo: 40 })
seed(launcher, { slug: "q3", title: "Tidy the settings drawer", restedMinutesAgo: 30 })
seed(launcher, { slug: "q4", title: "Bump the release pin", restedMinutesAgo: 20 })
seed(launcher, { slug: "q5", title: "Answer the PR review", restedMinutesAgo: 10 })
seed(launcher, { slug: "r1", title: "Port the v2 drivers", restedMinutesAgo: 70, running: true })
seed(launcher, { slug: "r2", title: "Rewrite the importer", restedMinutesAgo: 70, running: true })
seed(launcher, { slug: "r3", title: "Profile the cold start", restedMinutesAgo: 70, running: true })
seed(launcher, { slug: "r4", title: "Split the router module", restedMinutesAgo: 70, running: true })
seed(launcher, { slug: "r5", title: "Trim the bundle", restedMinutesAgo: 70, running: true })
seed(tenant, { slug: "p1", title: "Triage the crash report", restedMinutesAgo: 45 })
seed(tenant, { slug: "p2", title: "Draft the migration guide", restedMinutesAgo: 70, running: true })
seed(tenant, { slug: "p3", title: "Check the backup job", restedMinutesAgo: 70, running: true })
// A tenant's board opens on first use; the Everything page reads only boards that are open, so open it.
await createRpcClient(`${new URL(stack.url).origin}/`, tenant.id).query("board")
console.log(`SEED ${JSON.stringify({ a: launcher.id, aSlug: launcher.slug, b: tenant.id, bSlug: tenant.slug, daemon: daemon.pid, sessions })}`)
