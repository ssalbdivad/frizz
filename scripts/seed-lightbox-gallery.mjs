// Seed a disposable adhoc stack with ```lightbox galleries — the fence a worker writes to show several
// screenshots as ONE gallery the human can click through (packages/web/src/components/Lightbox.tsx).
//
// Each message is one layout the gallery has to get right, read off REAL files through the real
// /local-image route (a plain vite has none, so the fixture's e2e test intercepts it and draws
// stand-ins): a captioned before/after pair; three widths of one page, whose shapes differ wildly and
// must sit in one row at their real aspect ratios; one picture alone, which must match a bare framed
// picture; and a long set in every line shape the grammar accepts, one of whose files is MISSING. That
// message closes on a ```done fence BELOW its gallery, the order the worker contract asks for, so the
// card and the gallery are checked together.
//
// The last turn reaches every OTHER surface the viewer opens from: a message's loose pictures (a
// Markdown image, a bare path line, a link to a picture), which page together; a done card with a
// gallery in its body (`~~~lightbox`, since a ``` fence cannot nest inside the ```done one); and a link
// to a `.md` report, written beside the shots, whose gallery names its pictures RELATIVE to the report —
// the reader resolves them against the document's own directory. The reader only opens files under the
// project, so keep `--shots` inside `--cwd` for that one. With `--origin` (the stack's URL) it also
// REGISTERS a question through the running server's own `ask` RPC — what a worker's mcp__frizz__ask
// does — whose first option's description is a gallery and whose second is a picture: a registered
// question draws a multi-line description as the option's body, where the fence becomes a gallery.
//
// `--shots` is a directory holding desktop-a.png and desktop-b.png (1440×900), phone.png (375×812),
// tablet.png (768×1024) and wide.png (1600×600). Any screenshots at those shapes will do; the stack's own
// pages, captured with scripts/shot.mjs at `--dsf=1`, are what it was written against.
//
// The LAST turn is what a worker's own looking and showing look like since 2026-10-03, when the lightbox
// became the one way to put media in front of the human: an image `Read` and a `take_screenshot` whose
// pictures must FOLD into the "Ran N tool calls" digest, a SendUserFile delivery drawn open as a gallery,
// and a fence that holds a picture and two videos, played through the real route's byte ranges. It needs
// tour.mp4 and tour.webm in `--shots` too — any short screen recording, H.264 and VP9; without them the
// turn is skipped.
//
// Follows the frizz-stack recipe: a session row + a JSONL the REAL tailer reads.
//
// Usage: nub scripts/seed-lightbox-gallery.mjs --home=/abs/temp-home --shots=/abs/dir [--slug=x] [--cwd=/abs/project]
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { createRpcClient } from "./lib/rpc-client.mjs"
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
const report = join(shots, "lightbox-report.md")
writeFileSync(report, [
  "# Design review",
  "",
  "Every page, as it stands — each path relative to this report:",
  "",
  "```lightbox",
  "desktop-a.png  The first page",
  "desktop-b.png  The second page",
  "tablet.png     At tablet width",
  "```",
  "",
].join("\n"))

const toolUse = (blocks) => ({
  parentUuid: null, isSidechain: false, type: "assistant", uuid: uuid(), timestamp: now(), session_id: sessionId, cwd,
  message: {
    model: "claude-opus-5", id: `msg_${uuid()}`, type: "message", role: "assistant",
    content: blocks, stop_reason: "tool_use",
    usage: { input_tokens: 2, output_tokens: 60 },
  },
})
const toolResults = (results) => ({
  parentUuid: null, isSidechain: false, type: "user", uuid: uuid(), timestamp: now(), session_id: sessionId, cwd,
  message: { role: "user", content: results },
})
const pngBlock = (path) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: readFileSync(path).toString("base64") } })
const videos = ["tour.mp4", "tour.webm"].map((name) => join(shots, name)).filter((path) => existsSync(path))

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
  user("Which layout should ship? And where do things stand?"),
  assistant([
    "Where things stand:",
    "",
    `![The first page, at desktop width](${shot("desktop-a.png")})`,
    "",
    shot("desktop-b.png"),
    "",
    `The [phone layout](${shot("phone.png")}) is its own picture.`,
  ].join("\n")),
  assistant([
    `The full review is in [the report](${report}).`,
    "",
    "```done",
    "- **Reviewed every page**, before and after:",
    "",
    "~~~lightbox",
    `${shot("desktop-a.png")}  Before`,
    `${shot("desktop-b.png")}  After`,
    "~~~",
    "```",
  ].join("\n")),
]

if (videos.length === 2) {
  records.push(
    user("Check the pages again and show me the whole flow."),
    // The worker LOOKING: two pictures it took to check its own work. Neither may reach the human's
    // screen — both fold into the digest, one click from their collapsed cards.
    toolUse([
      { type: "text", text: "Reading back the captures first." },
      { type: "tool_use", id: "toolu_lbmedia_read", name: "Read", input: { file_path: shot("desktop-a.png") } },
      { type: "tool_use", id: "toolu_lbmedia_shot", name: "mcp__chrome-devtools__take_screenshot", input: { fullPage: false } },
    ]),
    toolResults([
      { type: "tool_result", tool_use_id: "toolu_lbmedia_read", content: [pngBlock(shot("desktop-a.png"))] },
      { type: "tool_result", tool_use_id: "toolu_lbmedia_shot", content: [{ type: "text", text: "Took a screenshot of the current page's viewport." }, pngBlock(shot("phone.png"))] },
    ]),
    // The worker SHOWING, the old way: a delivery stays an open card, drawn as a gallery.
    toolUse([
      { type: "tool_use", id: "toolu_lbmedia_send", name: "SendUserFile", input: { files: [shot("tablet.png"), shot("wide.png")], caption: "The two pages that changed" } },
    ]),
    toolResults([{ type: "tool_result", tool_use_id: "toolu_lbmedia_send", content: "Sent 2 files." }]),
    // …and the one way: a fence, with the recording in it.
    assistant([
      "The whole flow, recorded, beside where it starts:",
      "",
      "```lightbox",
      `${shot("desktop-b.png")}  Where it starts`,
      `${videos[0]}  The tour, recorded (MP4)`,
      `${videos[1]}  The same tour (WebM)`,
      "```",
    ].join("\n")),
  )
}

writeFileSync(join(jsonlDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")

execFileSync("sqlite3", [
  db,
  `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, title_auto, backend, model, effort, permission_mode, state, unread, exited, archived, rested_at)
   VALUES (${sessionVals}'${slug}', '${sessionId}', 'frizz-${slug}', '${now()}', 'Lightbox galleries', 0, 'claude', 'opus', 'high', 'default', 'open', 1, 0, 0, '${now()}')`,
])
console.log(`seeded ${slug} → ${sessionId} (pair, three widths, single, long set with a missing file, loose pictures, a done card, a report${videos.length === 2 ? ", folded tool pictures, a delivery, a gallery with two videos" : ""}; shots=${shots})`)

if (flags.origin) {
  const api = createRpcClient(flags.origin)
  await api.waitForHealth()
  // The board learns the session row on its own refresh; until then the ask is refused as unregistered.
  for (let attempt = 0; ; attempt++) {
    try {
      await api.mutate("ask", {
        slug,
        questions: [{
          question: "Which layout should ship?",
          kind: "question",
          options: [
            { label: "Two columns", recommended: true, description: ["Search beside the map, at both widths:", "", "```lightbox", `${shot("desktop-a.png")}  Desktop`, `${shot("phone.png")}  Phone`, "```"].join("\n") },
            { label: "One column", description: [`![One column](${shot("tablet.png")})`, "", "Everything in one scrolling page."].join("\n") },
          ],
        }],
      })
      break
    } catch (error) {
      if (attempt >= 20) throw error
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  console.log(`registered a question on ${slug} whose options carry a gallery and a picture`)
}
