// Seed a disposable adhoc stack with ```lightbox galleries — the fence a worker writes to show several
// screenshots as ONE gallery the human can click through (packages/web/src/components/Lightbox.tsx).
//
// Each message is one layout the gallery has to get right, read off REAL files through the real
// /local-image route (a plain vite has none, so the fixture's e2e test intercepts it and draws
// stand-ins): a captioned before/after pair; three widths of one page, whose shapes differ wildly and
// must sit in one row at their real aspect ratios; one picture alone, which must match a bare framed
// picture; and a long set in every line shape the grammar accepts, one of whose files is MISSING. The
// last message closes on a ```done fence BELOW its gallery, the order the worker contract asks for, so
// the card and the gallery are checked together.
//
// `--shots` is a directory holding desktop-a.png and desktop-b.png (1440×900), phone.png (375×812),
// tablet.png (768×1024) and wide.png (1600×600). Any screenshots at those shapes will do; the stack's own
// pages, captured with scripts/shot.mjs at `--dsf=1`, are what it was written against.
//
// Follows the frizz-stack recipe: a session row + a JSONL the REAL tailer reads.
//
// Usage: nub scripts/seed-lightbox-gallery.mjs --home=/abs/temp-home --shots=/abs/dir [--slug=x] [--cwd=/abs/project]
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, cwd = process.cwd() } = flags
if (!home || !flags.shots) {
  console.error("usage: nub scripts/seed-lightbox-gallery.mjs --home=/abs/temp-home --shots=/abs/dir [--cwd=/abs/project]")
  process.exit(1)
}
const shots = resolve(flags.shots)
for (const name of ["desktop-a.png", "desktop-b.png", "phone.png", "tablet.png", "wide.png"]) {
  if (!existsSync(join(shots, name))) {
    console.error(`missing ${join(shots, name)} — see the header for the shots this seed expects`)
    process.exit(1)
  }
}
const shot = (name) => join(shots, name)

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
const cwdSlug = cwd.replace(/[/.]/g, "-")
const jsonlDir = join(home, ".claude", "projects", cwdSlug)
mkdirSync(jsonlDir, { recursive: true })

const now = () => new Date().toISOString()
let uuidN = 0
const uuid = () => `0000000${(++uuidN).toString().padStart(4, "0")}-0000-4000-8000-000000000000`.slice(-36)

// `--slug` lets a re-seed land in a FRESH thread: the tailer tracks byte offsets, so overwriting an
// already-tailed JSONL in place leaves the projection stuck on the old content.
const slug = flags.slug ?? "lightbox-gallery"
const sessionId = `${slug}-0000-4000-8000-000000000000`.slice(0, 36)
const MISSING = "/tmp/frizz-lightbox-this-file-does-not-exist.png"

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
  user("TASK:\nShow me the board before and after, at every width."),
  assistant([
    "Before and after, side by side:",
    "",
    "```lightbox",
    `${shot("desktop-a.png")}  Before — the project grid`,
    `${shot("desktop-b.png")}  After — the board`,
    "```",
    "",
    "And the board at three widths, each at its real shape:",
    "",
    "```lightbox",
    `${shot("phone.png")}  375px`,
    `${shot("tablet.png")}  768px`,
    `${shot("desktop-b.png")}  1440px`,
    "```",
  ].join("\n")),
  user("What does one picture alone look like?"),
  assistant([
    "One picture alone sits in the same frame as a bare path:",
    "",
    "```lightbox",
    shot("desktop-b.png"),
    "```",
    "",
    "…and here is that bare path, for comparison:",
    "",
    shot("desktop-b.png"),
  ].join("\n")),
  user("Show me everything from the run."),
  assistant([
    "Every capture from the run, in each line shape the fence accepts. One file was cleaned up:",
    "",
    "```lightbox",
    `- ${shot("desktop-a.png")}`,
    `- ${shot("phone.png")}`,
    `- \`${shot("tablet.png")}\``,
    `- ![The wide composer](${shot("wide.png")})`,
    `- ${MISSING}`,
    `- ${shot("desktop-b.png")} | The board again`,
    "```",
    "",
    "**Fixed** — the gallery renders every line shape.",
    "",
    "```done",
    "- **Rendered the gallery** in every line shape the fence accepts.",
    "```",
  ].join("\n")),
]

writeFileSync(join(jsonlDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")

execFileSync("sqlite3", [
  db,
  `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, title_auto, backend, model, effort, permission_mode, state, unread, exited, archived, rested_at)
   VALUES (${sessionVals}'${slug}', '${sessionId}', 'frizz-${slug}', '${now()}', 'Lightbox galleries', 0, 'claude', 'opus', 'high', 'default', 'open', 1, 0, 0, '${now()}')`,
])
console.log(`seeded ${slug} → ${sessionId} (pair, three widths, single, long set with a missing file; shots=${shots})`)
