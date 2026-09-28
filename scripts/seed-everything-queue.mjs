// Seed a disposable TWO-project adhoc stack with the shape the Everything page got wrong (maintainer
// 2026-09-24: "when a new thread is ready, it moves to the top of the *stack*"): the project listed FIRST
// in the rail gets a ready thread AFTER the second project's, while the operator reads the second
// project's card. With one lane per project in rail order, the first project's whole lane appeared ABOVE
// the card being read; as one queue (lib/allQueues.ts mergedQueue) the arrival joins the bottom.
//
//   first project  — `pr-review`   rested 60m ago, snoozed until --first-s after this runs (the arrival)
//   second project — `login-test`  rested 30m ago, queued since (the card being read)
//                    `settings`    rested 20m ago, queued since
//                    `release-pin` rested 50m ago, snoozed until --second-s (an arrival on its own board)
//
// Broker rows with one live stand-in daemon (a `sleep`), for the reason seed-queue-arrival.mjs gives: a
// row the tailer reads as RUNNING when it wakes — which scripts/verify-everything-queue.mjs drives on
// `login-test` by appending a Frizz wake and a fresh rest to its transcript. Kill the printed pid when the
// stack comes down.
//
// Usage: node scripts/seed-everything-queue.mjs --stack=/abs/stack.log [--first-s=45] [--second-s=75]
import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createRpcClient } from "./lib/rpc-client.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => { const s = a.slice(2); const i = s.indexOf("="); return i < 0 ? [s, true] : [s.slice(0, i), s.slice(i + 1)] }),
)
if (!flags.stack) {
  console.error("usage: node scripts/seed-everything-queue.mjs --stack=/abs/stack.log [--first-s=45] [--second-s=75]")
  process.exit(1)
}
const firstS = Number(flags["first-s"] ?? 45)
const secondS = Number(flags["second-s"] ?? 75)
const stack = JSON.parse(readFileSync(flags.stack, "utf8").split("\n").find((l) => l.startsWith("{\"url\"")))
const home = stack.home
const db = join(home, ".frizz/ui.db")
const api = createRpcClient(`${new URL(stack.url).origin}/`)
await api.waitForHealth()

// The RAIL's order, which is what put a lane above another: the first listed project is the one whose
// arrival must NOT land above the reader.
const listed = await api.query("projectsList")
const known = [
  { id: stack.launcher.id, dir: stack.launcher.dir ?? stack.project, stateDir: join(home, ".frizz/projects", stack.launcher.id) },
  ...stack.tenants.map((t) => ({ id: t.id, dir: t.dir, stateDir: t.stateDir })),
]
const byRail = listed.map((card) => known.find((p) => p.id === card.id)).filter(Boolean)
if (byRail.length < 2) throw new Error(`need two registered projects, found ${JSON.stringify(listed.map((c) => c.id))}`)
const [first, second] = byRail

const daemon = spawn("sleep", ["7200"], { detached: true, stdio: "ignore" })
daemon.unref()
const now = Date.now()
const ago = (m) => new Date(now - m * 60_000).toISOString()
let n = 0
const uuid = () => `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}`

function seed(project, { slug, sessionId, title, restedMinutesAgo, snoozedUntil = null }) {
  const jsonlDir = join(home, ".claude", "projects", project.dir.replace(/[/.]/g, "-"))
  mkdirSync(jsonlDir, { recursive: true })
  const brokerDir = join(project.stateDir, "claude-broker")
  mkdirSync(brokerDir, { recursive: true })
  const records = [
    { parentUuid: null, isSidechain: false, type: "user", uuid: uuid(), timestamp: ago(restedMinutesAgo + 5), session_id: sessionId, cwd: project.dir, message: { role: "user", content: `TASK:\n${title}` } },
    {
      parentUuid: null, isSidechain: false, type: "assistant", uuid: uuid(), timestamp: ago(restedMinutesAgo), session_id: sessionId, cwd: project.dir,
      message: { model: "claude-opus-5", id: `msg_${slug}`, type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: `${title} — done, over to you.` }], usage: { input_tokens: 2, output_tokens: 20 } },
    },
  ]
  writeFileSync(join(jsonlDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
  writeFileSync(
    join(brokerDir, `${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}.json`),
    JSON.stringify({ sessionId, daemonPid: daemon.pid, socketPath: join(brokerDir, `${slug}.sock`) }),
  )
  // `.timeout`: the server writes this same file continually, and a bare sqlite3 fails "database is locked".
  execFileSync("sqlite3", [
    "-cmd", ".timeout 10000",
    db,
    `INSERT OR REPLACE INTO session (project_id, slug, session_id, thread_name, spawned_at, title, backend, claude_runtime, model, effort, permission_mode, rested_at, snoozed_until)
     VALUES ('${project.id}', '${slug}', '${sessionId}', 'frizz-${slug}', '${ago(restedMinutesAgo + 5)}', '${title}', 'claude', 'broker', 'opus', 'high', 'default', '${ago(restedMinutesAgo)}', ${snoozedUntil ? `'${snoozedUntil}'` : "NULL"})`,
  ])
  console.log(`seeded ${project.id.slice(0, 8)}/${slug} → rested ${restedMinutesAgo}m ago${snoozedUntil ? `, snoozed until ${snoozedUntil}` : ""}`)
}

seed(first, { slug: "pr-review", sessionId: "7e000000-0000-4000-9000-00000000000a", title: "Answer the PR review", restedMinutesAgo: 60, snoozedUntil: new Date(now + firstS * 1000).toISOString() })
seed(second, { slug: "login-test", sessionId: "7e000000-0000-4000-9000-00000000000b", title: "Fix the flaky login test", restedMinutesAgo: 30 })
seed(second, { slug: "settings", sessionId: "7e000000-0000-4000-9000-00000000000c", title: "Tidy the settings drawer", restedMinutesAgo: 20 })
seed(second, { slug: "release-pin", sessionId: "7e000000-0000-4000-9000-00000000000d", title: "Bump the release pin", restedMinutesAgo: 50, snoozedUntil: new Date(now + secondS * 1000).toISOString() })
console.log(`SEED ${JSON.stringify({ first: first.id, firstSlug: listed[0].slug, second: second.id, secondSlug: listed[1].slug, secondDir: second.dir, daemon: daemon.pid })}`)
