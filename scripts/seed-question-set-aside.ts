// Seed the three shapes that decide where an open REGISTERED question renders once the human types past
// it (2026-09-30: a typed message sets it aside; the worker opts back in with `keep`). Same recipe as
// seed-question-at-current-rest.mjs — session row + JSONL for the REAL tailer, the question row as fixture.
//
// Usage: nub scripts/seed-question-set-aside.ts <home> <projectId> <projectDir>
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const [home, projectId, projectDir] = process.argv.slice(2)
if (!home || !projectId || !projectDir) throw new Error("usage: seed-question-at-current-rest.mjs <home> <projectId> <projectDir>")

const cwdSlug = projectDir.replace(/[/.]/g, "-")
const transcriptDir = path.join(home, ".claude", "projects", cwdSlug)
fs.mkdirSync(transcriptDir, { recursive: true })

// ONE server, EVERY project: the tables live in the unified `~/.frizz/ui.db` and are scoped by
// `project_id`, not in a per-project file. This script takes its project id as an argument, so it
// names the file directly; the seeds that have to DISCOVER one go through scripts/lib/sandbox-db.mjs.
const db = path.join(home, ".frizz", "ui.db")

const T = (n) => new Date(Date.UTC(2026, 7, 31, 19, n, 0)).toISOString()
const MS = (n) => Date.UTC(2026, 7, 31, 19, n, 0)
const file = (p) => `${projectDir}/${p}`
const call = (id, name, input) => ({ type: "tool_use", id, name, input })
const result = (id, content) => ({ type: "tool_result", tool_use_id: id, content })

let clock = 0
const stamp = () => T(clock++)

const human = (sessionId, text) => [
  { type: "user", sessionId, timestamp: stamp(), message: { role: "user", content: [{ type: "text", text }] } },
]
const prose = (sessionId, text) => [
  { type: "assistant", sessionId, timestamp: stamp(), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] } },
]
const toolTurn = (sessionId, calls, text) => [
  { type: "assistant", sessionId, timestamp: stamp(), message: { role: "assistant", content: calls } },
  { type: "user", sessionId, timestamp: stamp(), message: { role: "user", content: calls.map((c) => result(c.id, "ok")) } },
  ...prose(sessionId, text),
]

function write(slug: string, sessionId: string, title: string, records: unknown[]) {
  fs.writeFileSync(path.join(transcriptDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
  execFileSync("sqlite3", [
    db,
    `INSERT OR REPLACE INTO session (project_id, slug, session_id, thread_name, spawned_at, title, title_auto, backend, model, effort, permission_mode, state, unread, exited, archived, rested_at)
     VALUES ('${projectId}', '${slug}', '${sessionId}', 'frizz-${slug}', '${T(0)}', '${title}', 0, 'claude', 'opus', 'high', 'default', 'open', 0, 0, 0, '${T(clock)}')`,
  ])
  console.log(`seeded ${slug} (${sessionId})`)
}

function ask(slug, id, askedAtMs, spec, keptAtMs = null) {
  execFileSync("sqlite3", [
    db,
    `INSERT OR REPLACE INTO thread_question (id, project_id, thread_slug, spec, state, answer, delivered, asked_at, settled_at, kept_at)
     VALUES ('${id}', '${projectId}', '${slug}', '${JSON.stringify(spec).replace(/'/g, "''")}', 'open', NULL, 0, ${askedAtMs}, NULL, ${keptAtMs ?? "NULL"})`,
  ])
}

const BOX_Q = {
  question: "Take the prototype-accessor representation for util.cached, or leave it exactly as it is?",
  header: "util.cached",
  kind: "question",
  options: [
    { label: "Take the prototype-accessor representation", description: "Same contract, same laziness, no call-site or type changes; -544 B per object schema.", recommended: true },
    { label: "Leave util.cached untouched", description: "The ~360 B per box and the per-parse dictionary load stay as the accepted cost of the current form." },
  ],
}

const readUtil = (id) => call(id, "Read", { file_path: file("packages/core/src/util.ts") })
const bench = (id) => call(id, "Bash", { command: "node --expose-gc --import tsx /tmp/box-read-bench.ts", description: "Measuring read speed per box representation" })

// 1 — SET ASIDE. Asked at a rest, the human typed past it, the worker rested again without `keep`: the
//     card stays at the asking rest, ABOVE the human's reply, and the thread does not queue on it.
// 2 — KEPT. Same transcript, but the worker `keep`s it (reworded) after the reply: the card rides to the
//     bottom of the newest handoff, and the thread queues on it.
// 3 — CONTROL. Asked at the newest rest, nothing since: the tail, as always.
for (const [slug, s, kept] of [
  ["q-set-aside", "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", false],
  ["q-kept", "cccccccc-3333-4333-8333-cccccccccccc", true],
] as const) {
  clock = 0
  write(slug, s, kept ? "Question kept after a reply" : "Question set aside by a reply", [
    ...human(s, "TASK:\nEvaluate the util.cached optimization proposals critically. Never assume."),
    ...toolTurn(s, [readUtil("r1")], "Read the current box. Measuring the three representations before I recommend anything."),
    ...prose(s, "The measurements are in and the trade is not what the design assumes. Registering the call as a card."),
    ...human(s, "It's about access speed versus memory, right? I don't know which one matters here?"),
    ...toolTurn(s, [bench("r2")], "Let me measure the read side properly."),
    ...prose(s, "Yes — and the current form loses both. The prototype getter reads faster in both regimes. SECOND HANDOFF."),
  ])
  ask(slug, `qst_${slug.replace(/-/g, "_")}`, MS(4), kept ? { ...BOX_Q, question: "REWORDED: take the prototype getter, now that it wins on speed too?" } : BOX_Q, kept ? MS(9) : null)
}
{
  const s = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"
  clock = 0
  write("q-fresh-ask", s, "Question asked at the current rest", [
    ...human(s, "TASK:\nEvaluate the util.cached optimization proposals critically. Never assume."),
    ...toolTurn(s, [readUtil("f1")], "Read the current box. Measuring the three representations before I recommend anything."),
    ...prose(s, "The measurements are in and the trade is not what the design assumes. Registering the call as a card."),
  ])
  ask("q-fresh-ask", "qst_fresh_ask", MS(4), BOX_Q)
}
