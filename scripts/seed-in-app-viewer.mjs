// Seed a disposable adhoc stack with a rested thread that puts every kind of local file in front of the
// reader, so the in-app picture viewer and file reader can be driven on the REAL page rather than a
// fixture: pictures as bare paths (BlockImage) and as Markdown `![](…)`, and paths to a log, a JSON file,
// a TypeScript file and a PDF. Frizz shows the first three kinds itself; the PDF is the control that must
// still go to the desktop opener (lib/localViewer.ts decides which is which).
//
// The files must be real — /local-image serves real bytes, the reader's localFile RPC reads the real
// file, and a backticked path only becomes a link once the server has resolved it on disk — so they are
// written into `--dir`, which must sit under one of the server's open roots (a temp dir does).
//
// The final message is the thread's handoff, so the everything page's card renders it too: its picture
// opens a gallery of ONE (the card), while the thread's drawer holds all three.
//
// `--project-id` seeds into a TENANT of a multi-project stack rather than the launcher. That is the case
// worth running (scripts/verify-in-app-viewer.mjs): a tenant checked out outside the sandbox's home and
// temp trees, whose files only its OWN project's gate admits, cited on its card on the everything page.
//
// Follows the frizz-stack recipe: a session row + a JSONL the REAL tailer reads.
//
// Usage: nub scripts/seed-in-app-viewer.mjs --home=/abs/temp-home --cwd=/abs/project --dir=/abs/project/artifacts \
//          --shots=/abs/a.png,/abs/b.png,/abs/c.png [--project-id=<tenant id>] [--slug=x]
import { execFileSync } from "node:child_process"
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, cwd, dir, shots } = flags
const shotList = shots?.split(",") ?? []
if (!home || !cwd || !dir || shotList.length !== 3) {
  console.error("usage: nub scripts/seed-in-app-viewer.mjs --home=/abs/temp-home --cwd=/abs/project --dir=/tmp/abs-dir --shots=a.png,b.png,c.png")
  process.exit(1)
}

// The files the worker "cites".
mkdirSync(dir, { recursive: true })
const [before, beforeCrop, after] = ["board-before.png", "board-before-crop.png", "board-after.png"].map((name, i) => {
  const path = join(dir, name)
  copyFileSync(shotList[i], path)
  return path
})
const log = join(dir, "run.log")
writeFileSync(log, [
  "12:00:01.114 frizz  booting server (pid 48213)",
  "12:00:01.402 frizz  listening on http://127.0.0.1:4321",
  "12:00:02.018 worker dispatched thread in-app-viewer (claude-opus-5-5, xhigh)",
  `12:00:09.771 worker tool Read {"file_path":"${before}"}`,
  "12:00:10.003 worker rested — awaiting review",
].join("\n") + "\n")
const config = join(dir, "config.json")
writeFileSync(config, JSON.stringify({ localFileOpener: "system", viewer: { fit: true, gutter: 64 }, roots: ["~", "/tmp"] }, null, 2) + "\n")
const source = join(dir, "fit.ts")
writeFileSync(source, [
  "// Fit a picture into the stage without ever upscaling it.",
  "export function fitSize(natural: { width: number; height: number }, box: { width: number; height: number }) {",
  "  const scale = Math.min(1, box.width / natural.width, box.height / natural.height)",
  "  return { width: natural.width * scale, height: natural.height * scale, scale }",
  "}",
].join("\n") + "\n")
// Never a real PDF: the check is only that a click on it asks for the desktop opener.
const pdf = join(dir, "spec.pdf")
writeFileSync(pdf, "%PDF-1.4\n%stub\n")

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns({ ...sandbox, projectId: flags["project-id"] ?? sandbox.projectId })
const cwdSlug = cwd.replace(/[/.]/g, "-")
const jsonlDir = join(home, ".claude", "projects", cwdSlug)
mkdirSync(jsonlDir, { recursive: true })

const now = () => new Date().toISOString()
let uuidN = 0
const uuid = () => `0000000${(++uuidN).toString().padStart(4, "0")}-0000-4000-8000-000000000000`.slice(-36)

// `--slug` lets a re-seed land in a FRESH thread: the tailer tracks byte offsets, so overwriting an
// already-tailed JSONL in place leaves the projection stuck on the old content.
const slug = flags.slug ?? "in-app-viewer"
const sessionId = `${slug}-0000-4000-8000-000000000000`.slice(0, 36)

const user = (text) => ({
  parentUuid: null, isSidechain: false, type: "user", uuid: uuid(), timestamp: now(), session_id: sessionId, cwd,
  message: { role: "user", content: text },
})
const assistant = (text) => ({
  parentUuid: null, isSidechain: false, type: "assistant", uuid: uuid(), timestamp: now(), session_id: sessionId, cwd,
  message: {
    model: "claude-opus-5", id: `msg_${uuid()}`, type: "message", role: "assistant",
    content: [{ type: "text", text }], stop_reason: "end_turn",
    usage: { input_tokens: 2, output_tokens: 120 },
  },
})

const records = [
  user("TASK:\nShow the board before and after the fix, and attach what the run wrote."),
  assistant([
    "The board before the fix, as the screenshot tool returned it:",
    "",
    before,
    "",
    beforeCrop,
    "",
    `The run's log is \`${log}\`, the settings it read are in [config.json](${config}), the fitting code is \`${source}\`, and the spec it was checked against is \`${pdf}\`.`,
  ].join("\n")),
  user("And after?"),
  assistant([
    "**Fixed** — the board after the fix:",
    "",
    `![the board after the fix](${after})`,
    "",
    `The log for this run is \`${log}\`.`,
  ].join("\n")),
]

writeFileSync(join(jsonlDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")

execFileSync("sqlite3", [
  db,
  `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, title_auto, backend, model, effort, permission_mode, state, unread, exited, archived, rested_at)
   VALUES (${sessionVals}'${slug}', '${sessionId}', 'frizz-${slug}', '${now()}', 'Board screenshots and run files', 0, 'claude', 'opus', 'high', 'default', 'open', 1, 0, 0, '${now()}')`,
])
console.log(JSON.stringify({ slug, sessionId, files: { before, beforeCrop, after, log, config, source, pdf } }))
