// Seed a disposable adhoc stack with TWO simulated workers that each asked two questions at one rest,
// were replied past, and rested again with both questions still open — the shape that drew every old
// card under the newest handoff, superseding the worker's own sign-off (maintainer 2026-10-05: "the
// pending questions that may or may not be relevant kind of supersede how the agent actually signed
// off").
//
// Since 2026-10-05 a card stays where it was asked until a later ```awaiting fence names it under
// `questions:` (web/src/lib/questionAnchor.ts questionClaims):
//
// - `question-claims-left`: the final fence names only the dist-tag question. The cache question, placed
//   by a marker in the ASKING handoff, stays in that prose; the dist-tag card renders under the fence.
//   (A worker under the new contract is bumped for leaving an open question out — this is what a legacy
//   thread, or one past the bump cap, leaves behind.)
// - `question-claims-both`: the control. The final fence names both, and its prose carries the cache
//   question's marker — so the cache card moves INTO the final handoff and the dist-tag card sits under
//   the fence. A run that draws the two threads identically proves nothing.
// - `question-claims-bare`: only the cache question is open, and the final rest is BARE — no fence, no
//   marker. The card stays in the asking handoff, and the tail draws "Rested without a sign-off": the
//   old question is not that rest's ending (RestedCard questionsHere). The server nudges this shape.
//
// Follows the frizz-stack recipe: a session row + a JSONL the REAL tailer reads. No process.
// Usage: nub scripts/seed-question-claims.mjs --home=/abs/temp-home --port=NNNN
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { createRpcClient } from "./lib/rpc-client.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, port, cwd = process.cwd() } = flags
if (!home || !port) {
  console.error("usage: nub scripts/seed-question-claims.mjs --home=/abs/temp-home --port=NNNN")
  process.exit(1)
}

const db = join(home, ".frizz", "ui.db")
if (!existsSync(db)) throw new Error(`no ui.db at ${db} — is the stack booted?`)
const registry = JSON.parse(readFileSync(join(home, ".frizz", "registry.json"), "utf8"))
const projectId = registry.projects.find((p) => p.path === cwd)?.id
if (!projectId) throw new Error(`${cwd} is not registered in ${home}/.frizz/registry.json`)
const jsonlDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(jsonlDir, { recursive: true })

const T0 = Date.now() - 3 * 60 * 60_000
const at = (m) => new Date(T0 + m * 60_000).toISOString()
const fence = (body) => `\`\`\`awaiting\n${body}\n\`\`\``
const marker = (id) => `\`\`\`question ${id}\n\`\`\``

function seed({ slug, sessionId, cache, distTag, title, finalHandoff, register = [cache, distTag] }) {
  let n = 0
  const uuid = () => `${sessionId.slice(0, 24)}${String(++n).padStart(12, "0")}`
  const user = (min, content) => ({
    parentUuid: null, isSidechain: false, type: "user", uuid: uuid(), timestamp: at(min), session_id: sessionId, cwd,
    message: { role: "user", content },
  })
  const assistant = (min, text) => ({
    parentUuid: null, isSidechain: false, type: "assistant", uuid: uuid(), timestamp: at(min), session_id: sessionId, cwd,
    message: {
      model: "claude-opus-5", id: `msg_${n}`, type: "message", role: "assistant", stop_reason: "end_turn",
      content: [{ type: "text", text }],
      usage: { input_tokens: 38_000, output_tokens: 280 },
    },
  })
  const ASKING_HANDOFF = [
    "The resolver fix is in and the suite is green. Two calls are still open before the release.",
    "",
    "## The cache key",
    "",
    "The collision came from keying on the raw id. Normalizing it fixes the bug, but every cached entry written by the old key is now unreachable until it expires.",
    "",
    marker(cache),
    "",
    "## Publishing",
    "",
    "The package is ready to publish once the tag is settled.",
  ].join("\n")
  const records = [
    user(0, "fix the cache collision in the resolver and get it ready to publish"),
    assistant(4, "Reading `src/resolver.ts` and the cache layer."),
    assistant(12, ASKING_HANDOFF),
    user(30, "Also bump the changelog while you're in there."),
    assistant(34, "Adding the changelog entry for the resolver fix."),
    assistant(41, "Changelog updated; CI is running on the new commit."),
    user(44, "🔔 CI finished on acme/resolver#391: all checks passed."),
    assistant(48, finalHandoff),
  ]
  writeFileSync(join(jsonlDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
  execFileSync("sqlite3", [
    db,
    `INSERT OR REPLACE INTO session (project_id, slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, rested_at)
     VALUES ('${projectId}', '${slug}', '${sessionId}', 'frizz-${slug}', '${at(0)}', '${title}', 'claude', 'opus', 'high', 'default', '${at(48)}')`,
  ])
  // The registrations. Hand-written for the same reason the session row is: the row IS the fixture, and
  // everything downstream of it — the board projection, the anchor, the placement, the card — is real.
  const questions = [
    [cache, {
      question: "Old cache entries written under the raw-id key become unreachable after the fix. Flush the cache on deploy, or let the old entries expire on their own?",
      header: "Cache flush", kind: "question",
      options: [
        { label: "Let them expire", description: "No deploy step; stale entries age out within the 24h TTL.", recommended: true },
        { label: "Flush on deploy", description: "Clean cut-over; the first minutes after deploy run cold." },
      ],
    }],
    [distTag, {
      question: "Which dist-tag should resolver 2.4.0 publish under?",
      header: "Dist-tag", kind: "question",
      options: [
        { label: "latest", description: "Every install picks the fix up at once.", recommended: true },
        { label: "next", description: "Opt-in for a week before it reaches latest." },
      ],
    }],
  ]
  for (const [id, spec] of questions.filter(([id]) => register.includes(id))) {
    execFileSync("sqlite3", [
      db,
      `INSERT OR REPLACE INTO thread_question (id, project_id, thread_slug, spec, state, answer, delivered, asked_at, settled_at)
       VALUES ('${id}', '${projectId}', '${slug}', '${JSON.stringify(spec).replace(/'/g, "''")}', 'open', NULL, 0, ${Date.parse(at(12))}, NULL)`,
    ])
  }
}

seed({
  slug: "question-claims-left",
  sessionId: "c1a1e000-0000-4000-9000-0000000000aa",
  cache: "qst_c1cache00001",
  distTag: "qst_c1dist000001",
  title: "Resolver fix — one question left behind",
  finalHandoff: [
    "CI is green on acme/resolver#391 with the changelog entry. The only thing between this and a publish is the dist-tag.",
    "",
    fence(["title: Dist-tag for resolver 2.4.0", "questions: [qst_c1dist000001]", "---", "The publish runs the moment the tag is chosen; nothing else is pending."].join("\n")),
  ].join("\n"),
})
seed({
  slug: "question-claims-both",
  sessionId: "c2a1e000-0000-4000-9000-0000000000bb",
  cache: "qst_c2cache00001",
  distTag: "qst_c2dist000001",
  title: "Resolver fix — both questions restated",
  finalHandoff: [
    "CI is green on acme/resolver#391 with the changelog entry.",
    "",
    "The cache question still matters: the deploy plan differs depending on it.",
    "",
    marker("qst_c2cache00001"),
    "",
    fence(["title: Two calls before resolver 2.4.0 publishes", "questions: [qst_c2cache00001, qst_c2dist000001]", "---", "The publish runs the moment both are settled."].join("\n")),
  ].join("\n"),
})

seed({
  slug: "question-claims-bare",
  sessionId: "c3a1e000-0000-4000-9000-0000000000cc",
  cache: "qst_c3cache00001",
  distTag: "qst_c3dist000001",
  register: ["qst_c3cache00001"],
  title: "Resolver fix — bare rest beside an old question",
  finalHandoff: "CI is green on acme/resolver#391 with the changelog entry.",
})

const api = createRpcClient(`http://127.0.0.1:${port}/`)
await api.waitForHealth()
const slugs = ["question-claims-left", "question-claims-both", "question-claims-bare"]
for (let i = 0; i < 40; i++) {
  const board = await api.query("board")
  if (slugs.every((s) => board.threads.some((t) => t.id === s))) break
  await new Promise((r) => setTimeout(r, 250))
}
const board = await api.query("board")
for (const slug of slugs) {
  const t = board.threads.find((x) => x.id === slug)
  console.log(JSON.stringify({ slug, runtime: t?.runtime, fence: t?.lastFence?.hints, questions: t?.questions?.map((q) => q.id) }))
}
