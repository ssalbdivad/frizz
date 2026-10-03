// Seed the shapes the PHONE answers in place (components/PhoneQuestionCards.tsx, 2026-10-03): one tap on
// a plain single-choice option sends it; a follow-up, a rich option body or a typed answer opens the sheet
// at that question; a multi toggles in place under its own Send. Same recipe as
// seed-question-set-aside.ts — session row + JSONL for the REAL tailer, the question rows as fixture.
//
//   • q-phone-one  — ONE plain yes/no question: the case that must never need the sheet.
//   • q-phone-mix  — four at one rest: plain single, single whose first option opens follow-ups, a multi,
//                    and free text; plus a single whose option carries a multi-line body.
//
// Open a thread at a phone width (<700px) through its drawer: `<url>/thread/q-phone-one`.
// Usage: nub scripts/seed-phone-question-answering.ts <home> <projectId> <projectDir>
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const [home, projectId, projectDir] = process.argv.slice(2)
if (!home || !projectId || !projectDir) throw new Error("usage: seed-phone-question-answering.ts <home> <projectId> <projectDir>")

const transcriptDir = path.join(home, ".claude", "projects", projectDir.replace(/[/.]/g, "-"))
fs.mkdirSync(transcriptDir, { recursive: true })
const db = path.join(home, ".frizz", "ui.db")

const T = (n: number) => new Date(Date.UTC(2026, 9, 3, 12, n, 0)).toISOString()
const MS = (n: number) => Date.UTC(2026, 9, 3, 12, n, 0)
let clock = 0
const human = (sessionId: string, text: string) => ({ type: "user", sessionId, timestamp: T(clock++), message: { role: "user", content: [{ type: "text", text }] } })
const prose = (sessionId: string, text: string) => ({ type: "assistant", sessionId, timestamp: T(clock++), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] } })

function write(slug: string, sessionId: string, title: string, records: unknown[]) {
  fs.writeFileSync(path.join(transcriptDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
  execFileSync("sqlite3", [
    db,
    `INSERT OR REPLACE INTO session (project_id, slug, session_id, thread_name, spawned_at, title, title_auto, backend, model, effort, permission_mode, state, unread, exited, archived, rested_at)
     VALUES ('${projectId}', '${slug}', '${sessionId}', 'frizz-${slug}', '${T(0)}', '${title}', 0, 'claude', 'opus', 'high', 'default', 'open', 0, 0, 0, '${T(clock)}')`,
  ])
  console.log(`seeded ${slug}`)
}

function ask(slug: string, id: string, spec: unknown) {
  execFileSync("sqlite3", [
    db,
    `INSERT OR REPLACE INTO thread_question (id, project_id, thread_slug, spec, state, answer, delivered, asked_at, settled_at, kept_at)
     VALUES ('${id}', '${projectId}', '${slug}', '${JSON.stringify(spec).replace(/'/g, "''")}', 'open', NULL, 0, ${MS(clock)}, NULL, NULL)`,
  ])
}

{
  const s = "dddddddd-1111-4111-8111-dddddddddddd"
  clock = 0
  write("q-phone-one", s, "Settings store question", [
    human(s, "TASK:\nMove the settings out of localStorage."),
    prose(s, "**Needs you** — the store's backing format is the one call left; everything else is done on `main`."),
  ])
  ask("q-phone-one", "qst_phone_one", {
    question: "Should the settings store use SQLite or a JSON file?",
    kind: "question",
    options: [
      { label: "SQLite", description: "transactional, matches how sessions are already stored", recommended: true },
      { label: "JSON file", description: "zero deps, human-editable, racy under concurrent writes" },
    ],
  })
}
{
  const s = "eeeeeeee-2222-4222-8222-eeeeeeeeeeee"
  clock = 0
  write("q-phone-mix", s, "Release prep questions", [
    human(s, "TASK:\nPrep the 0.14 release."),
    prose(s, "**Needs you** — four calls before the release can be cut."),
  ])
  ask("q-phone-mix", "qst_phone_a", {
    question: "Cut it as a patch or a minor?",
    kind: "question",
    options: [{ label: "Minor", description: "the protocol epoch moved", recommended: true }, { label: "Patch" }],
  })
  ask("q-phone-mix", "qst_phone_b", {
    question: "Publish the desktop installers too?",
    kind: "question",
    options: [
      { label: "Yes", description: "the tray fix is in this range", followUps: [{ question: "Which platforms?", kind: "multi", options: [{ label: "macOS" }, { label: "Windows" }, { label: "Linux" }] }] },
      { label: "No", description: "npm only" },
    ],
  })
  ask("q-phone-mix", "qst_phone_c", {
    question: "Which changelog sections ship?",
    kind: "multi",
    options: [{ label: "Features" }, { label: "Fixes" }, { label: "Internal" }],
  })
  ask("q-phone-mix", "qst_phone_d", { question: "Anything to add to the release note?", kind: "question" })
  ask("q-phone-mix", "qst_phone_e", {
    question: "Which lockfile fix goes in?",
    kind: "question",
    options: [
      { label: "Regenerate with pnpm", description: "Matches CI exactly.\n\n- rewrites 400 lines\n- drops the nub-written entries", recommended: true },
      { label: "Patch the two entries", description: "smallest diff" },
    ],
  })
}
