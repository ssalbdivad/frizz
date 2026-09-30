// Seed a disposable adhoc stack for THREAD DELETION (thread-retention.ts): four simulated threads that
// differ on exactly the axes the delete doors read — done or open, touched by the human long ago or not,
// pinned or not — plus
// a scratch directory on the one that should go, so a run proves the ⋯ menu's Delete, Settings'
// "Delete old threads now" and the automatic sweep on the real app.
//
//   shell-budgets   done, untouched 40d (its agent rested an hour ago) → the only one "untouched for 30d" takes
//   focus-mode      done, untouched 2d            → kept by 30d, taken by 1d
//   release-notes   done, untouched 40d, pinned   → always kept
//   perf-bench      open, untouched 40d           → never taken in bulk; the ⋯ menu deletes it
//
// Rows are the fixture (frizz-stack § Simulating a worker); state and pins go through the real RPCs.
// Usage: nub scripts/seed-old-threads.ts --home=/abs/temp-home --port=NNNN [--cwd=/abs/project]
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createRpcClient } from "./lib/rpc-client.mjs"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
) as Record<string, string | undefined>
const { home, port, cwd = process.cwd() } = flags
if (!home || !port) {
  console.error("usage: nub scripts/seed-old-threads.ts --home=/abs/temp-home --port=NNNN")
  process.exit(1)
}

const sandbox = resolveSandboxDb(home)
const { cols, vals } = sessionProjectColumns(sandbox)
const jsonlDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(jsonlDir, { recursive: true })
const api = createRpcClient(`http://127.0.0.1:${port}/`)
await api.waitForHealth()

const DAY = 86_400_000
let n = 0
const uuid = () => `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}`

const threads = [
  { slug: "shell-budgets", title: "Shell budgets", untouchedDays: 40, restedHoursAgo: 1, done: true, pinned: false },
  { slug: "focus-mode", title: "Focus mode", untouchedDays: 2, restedHoursAgo: 48, done: true, pinned: false },
  { slug: "release-notes", title: "Release notes", untouchedDays: 40, restedHoursAgo: 960, done: true, pinned: true },
  { slug: "perf-bench", title: "Perf bench", untouchedDays: 40, restedHoursAgo: 960, done: false, pinned: false },
]

for (const [i, t] of threads.entries()) {
  const sessionId = `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`
  const touched = new Date(Date.now() - t.untouchedDays * DAY)
  const rested = new Date(Date.now() - t.restedHoursAgo * 3_600_000)
  const spawned = new Date(touched.getTime() - 10 * 60_000)
  const records = [
    { parentUuid: null, isSidechain: false, type: "user", uuid: uuid(), timestamp: spawned.toISOString(), session_id: sessionId, cwd, message: { role: "user", content: `TASK:\nWork on ${t.title.toLowerCase()}.` } },
    {
      parentUuid: null, isSidechain: false, type: "assistant", uuid: uuid(), timestamp: rested.toISOString(), session_id: sessionId, cwd,
      message: { model: "claude-opus-5", id: `msg_${i}`, type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: `Finished ${t.title.toLowerCase()}.` }], usage: { input_tokens: 1000, output_tokens: 20 } },
    },
  ]
  writeFileSync(join(jsonlDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
  execFileSync("sqlite3", [sandbox.db, `INSERT OR REPLACE INTO session (${cols}slug, session_id, thread_name, spawned_at, title, title_locked, backend, model, effort, permission_mode, rested_at, exited)
    VALUES (${vals}'${t.slug}', '${sessionId}', 'frizz-${t.slug}', '${spawned.toISOString()}', '${t.title}', 1, 'claude', 'opus', 'high', 'default', '${rested.toISOString()}', 1)`])
  mkdirSync(join(cwd, ".frizz", "threads", sessionId), { recursive: true })
  writeFileSync(join(cwd, ".frizz", "threads", sessionId, "notes.md"), `notes for ${t.slug}\n`)
  if (t.done) await api.mutate("setThreadState", { slug: t.slug, state: "archived" })
  // Marking it done through the real verb stamped "now" as its last touch; set the touch the case needs.
  execFileSync("sqlite3", [sandbox.db, `UPDATE session SET interacted_at = '${touched.toISOString()}' WHERE slug = '${t.slug}'`])
  if (t.pinned) execFileSync("sqlite3", [sandbox.db, `UPDATE session SET pinned_at = '${touched.toISOString()}' WHERE slug = '${t.slug}'`])
  console.log(`seeded ${t.slug} (${t.done ? "done" : "open"}, untouched ${t.untouchedDays}d${t.pinned ? ", pinned" : ""}) → ${sessionId}`)
}
