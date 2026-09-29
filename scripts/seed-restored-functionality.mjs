#!/usr/bin/env node
// Seed an adhoc stack with the three shapes the 2026-09-29 restorations draw, so each can be judged in a
// real browser against the real tailer → board → page pipeline:
//
//   done-still-running  — marked done while its turn is still in flight: a Done row wearing the SPINNER
//                         (shared doneButRunning), and a running count on the project's rail badge.
//   limit-paused        — killed by a session usage limit: a queue card with the LimitPauseCard, the ⤢
//                         beside Retry in its header, and the AI-rename mark beside its title.
//   plain-handoff       — an ordinary queued rest: the ⤢ alone in the card header.
//
// Follows the frizz-stack recipe (seed-all-queues.mjs is the fuller example): a session row plus a JSONL
// the REAL tailer folds, and a broker record naming a live stand-in pid so an open rest reads turn-idle.
//
// Usage: nub scripts/seed-restored-functionality.mjs --stack=/abs/stack.log
import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createRpcClient } from "./lib/rpc-client.mjs"

const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")))
if (!flags.stack) {
  console.error("usage: nub scripts/seed-restored-functionality.mjs --stack=/abs/stack.log")
  process.exit(1)
}
const line = readFileSync(flags.stack, "utf8").split("\n").find((l) => l.startsWith("{\"url\""))
if (!line) throw new Error(`no stack json line in ${flags.stack}`)
const stack = JSON.parse(line)
const home = stack.home
const db = join(home, ".frizz", "ui.db")
const project = { id: stack.launcher.id, slug: stack.launcher.slug, dir: stack.launcher.dir ?? stack.project }

const daemon = spawn("sleep", ["14400"], { detached: true, stdio: "ignore" })
daemon.unref()

const now = Date.now()
const ago = (minutes) => new Date(now - minutes * 60_000).toISOString()
const q = (s) => `'${String(s).replace(/'/g, "''")}'`
const sessionIdFor = (slug) => {
  const h = createHash("sha256").update(`${project.slug}/${slug}`).digest("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-9${h.slice(17, 20)}-${h.slice(20, 32)}`
}

function seed(t) {
  const dir = realpathSync(project.dir)
  const transcriptDir = join(home, ".claude", "projects", dir.replace(/[/.]/g, "-"))
  mkdirSync(transcriptDir, { recursive: true })
  const sessionId = sessionIdFor(t.slug)
  const records = [
    { type: "user", sessionId, cwd: dir, timestamp: ago(t.rest + 10), message: { role: "user", content: [{ type: "text", text: t.prompt }] } },
    ...t.tail(sessionId, dir),
  ]
  writeFileSync(join(transcriptDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
  const stateDir = join(home, ".frizz", "projects", project.id)
  mkdirSync(join(stateDir, "claude-broker"), { recursive: true })
  const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 16)
  writeFileSync(join(stateDir, "claude-broker", `${key}.json`), JSON.stringify({ sessionId, daemonPid: daemon.pid, socketPath: join(stateDir, "claude-broker", `${t.slug}.sock`) }))
  execFileSync("sqlite3", ["-cmd", ".timeout 10000", db,
    `INSERT OR REPLACE INTO session (project_id, slug, session_id, thread_name, spawned_at, title, title_auto, backend, claude_runtime, model, effort, permission_mode, state, unread, exited, archived, rested_at)
     VALUES (${q(project.id)}, ${q(t.slug)}, ${q(sessionId)}, ${q(`frizz-${t.slug}`)}, ${q(ago(t.rest + 11))}, ${q(t.title)}, 0, 'claude', 'broker', 'opus', 'high', 'default', ${t.archived ? "'archived'" : "'open'"}, 0, 0, ${t.archived ? 1 : 0}, ${t.inFlight ? "NULL" : q(ago(t.rest))})`,
  ])
  console.log(`seeded ${project.slug}/${t.slug}`)
}

seed({
  slug: "done-still-running", title: "Finish the migration sweep", rest: 1, archived: true, inFlight: true,
  prompt: "Sweep the remaining migrations.",
  tail: (sessionId, cwd) => [{
    type: "assistant", sessionId, cwd, timestamp: ago(1),
    message: { role: "assistant", id: "m-run", stop_reason: "tool_use", content: [{ type: "tool_use", id: "b-run", name: "Bash", input: { command: "pnpm test", description: "Running the test suite" } }] },
  }],
})
seed({
  slug: "limit-paused", title: "Backfill the audit log", rest: 4,
  prompt: "Backfill the audit log for September.",
  tail: (sessionId, cwd) => [{
    type: "assistant", sessionId, cwd, timestamp: ago(4), isApiErrorMessage: true, error: "rate_limit",
    message: { role: "assistant", id: "m-limit", model: "<synthetic>", stop_reason: "stop_sequence", content: [{ type: "text", text: "You've hit your session limit · resets 11:50pm" }] },
  }],
})
seed({
  slug: "plain-handoff", title: "Tighten the checkout retry policy", rest: 7,
  prompt: "Tighten the checkout retry policy.",
  tail: (sessionId, cwd) => [{
    type: "assistant", sessionId, cwd, timestamp: ago(7),
    message: { role: "assistant", id: "m-done", stop_reason: "end_turn", content: [{ type: "text", text: "**Fixed** — retries now back off exponentially and stop after five attempts." }], usage: { input_tokens: 2, output_tokens: 40 } },
  }],
})

await createRpcClient(`${new URL(stack.url).origin}/`, project.id).query("board")
console.log(JSON.stringify({ daemonPid: daemon.pid }))
