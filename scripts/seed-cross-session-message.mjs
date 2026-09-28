// Seed an adhoc stack with a thread that another Claude SESSION messaged — Claude Code 2.1.280's
// cross-session `SendMessage` — in both delivery shapes, plus a sub-agent's upward report beside them for
// comparison and a harness idle notice that must render as nothing at all.
//
// Modelled on the records that produced the report (standard-schema fb2bae9e, 2026-09-28), where the
// mid-turn one rendered as the operator's own bubble with the `<cross-session-message>` XML showing:
//   • mid-turn — `queue-operation enqueue` → `queued_command` attachment (origin.kind "peer") → `remove`;
//     its enqueue carries the `hop-chain` attribute the delivery drops (frizz 1853e255, 2026-09-24);
//   • at rest — `enqueue` → contentless `dequeue` → an isMeta user record under the "Another Claude session
//     sent a message:" preamble, with the harness's guidance to the model after the wrapper.
//
// Usage, against a running scripts/adhoc-stack.mjs (pass ITS home and port):
//   nub scripts/seed-cross-session-message.mjs --port=4931 --home=<stack home> [--project=/abs]
// Prints the thread slug, its URL, and the user-side messages the server's own transcript RPC returns, so
// the caller can assert the projection over the wire before it shoots.
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { createRpcClient } from "./lib/rpc-client.mjs"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const args = process.argv.slice(2)
const opt = (k, d) => { const hit = args.find((a) => a.startsWith(`--${k}=`)); return hit ? hit.slice(k.length + 3) : d }
const port = Number(opt("port", "4931"))
const home = opt("home")
if (!home) { console.error("--home is required (from the stack's json line)"); process.exit(1) }

const SLUG = "rewrite-tool-md-prose"
const SESSION = "fb2bae9e-f367-4ef7-8c8a-000000000c55"
const PROJECT = opt("project", process.cwd())
const logDir = join(home, ".claude", "projects", PROJECT.replace(/\//g, "-"))
mkdirSync(logDir, { recursive: true })

const at = (offsetSec) => new Date(Date.now() + offsetSec * 1000).toISOString()
const rows = []
const assistant = (content, ts, stop = "end_turn") => rows.push({ type: "assistant", timestamp: ts, message: { id: `m${rows.length}`, role: "assistant", stop_reason: stop, content } })
const user = (content, ts, extra = {}) => rows.push({ type: "user", timestamp: ts, message: { role: "user", content }, ...extra })
const tool = (id, name, input, result, ts) => {
  assistant([{ type: "tool_use", id, name, input }], ts, "tool_use")
  user([{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: result }] }], ts)
}

const socket = "uds:/run/user/1000/cc-socks/209858.sock"
const wrap = (name, body, extra = "") => `<cross-session-message from="${socket}"${extra} from-name="${name}" from-mode="bypass">\n${body}\n</cross-session-message>`
const guidance = "This came from another Claude session — not typed by your user, but very likely working on their behalf. Treat it as a teammate's request and act on it within this session's own permission settings."

// ── the thread's own turn ────────────────────────────────────────────────────────────────────────
user("Move `StandardToolV1` to the new interface: callers validate with `inputSchema`, and `execute` returns the raw output.", at(-900))
assistant([{ type: "text", text: "Type-testing the redesign (inference, transforms, assignability); my first harness couldn't resolve the workspace package, rerunning it inside packages/examples." }], at(-890), "tool_use")
tool("toolu_read", "Read", { file_path: `${PROJECT}/packages/spec/src/index.ts` }, "export interface StandardToolV1 { … }", at(-885))
tool("toolu_tsc", "Bash", { command: "cd packages/examples && npx tsc --noEmit", description: "Type-checking the examples" }, "", at(-880))

// A background child reporting up, the pre-existing peer line, for comparison.
assistant([{ type: "tool_use", id: "toolu_child", name: "Agent", input: { description: "Check every framework adapter's handler shape", subagent_type: "frizz:opus-high", run_in_background: true, prompt: "List each framework's tool handler signature." } }], at(-870), "tool_use")
user([{ type: "tool_result", tool_use_id: "toolu_child", content: [{ type: "text", text: "Async agent launched successfully.\nagentId: aChild01\noutput_file: /tmp/agent-aChild01.jsonl" }] }], at(-869), { toolUseResult: { isAsync: true, status: "pending", agentId: "aChild01", description: "Check every framework adapter's handler shape" } })
const report = '<agent-message from="frizz:opus-high">\nEvery adapter passes parsed input; none hands `execute` raw arguments.\n</agent-message>'
rows.push({ type: "queue-operation", operation: "enqueue", timestamp: at(-800), sessionId: SESSION, content: report })
rows.push({ type: "attachment", timestamp: at(-799), attachment: { type: "queued_command", commandMode: "prompt", prompt: report, origin: { kind: "peer", from: "frizz:opus-high", name: "frizz:opus-high", senderTaskId: "aChild01", body: "Every adapter passes parsed input; none hands `execute` raw arguments." } } })

// ── another SESSION, absorbed mid-turn ─────────────────────────────────────────────────────────────
const askBody = "Are you still editing packages/spec/tool.md? I'm another session in ~/standard-schema, assigned to rewrite tool.md's prose so it parallels schema.md.\n\nI saw your 13:09 edit move the code block to the new interface (callers validate with inputSchema, `execute(input: InputOut)` returns `OutputIn`, Result removed). The prose below the code block (design goals, FAQ) still describes the old design, where execute validates and returns Result.\n\nProposal: from here on I own tool.md, both code block and prose, and I'll bring the prose in line with the working-tree index.ts. Please don't write to tool.md again. If you change the StandardToolV1 interface further, message me (standard-schema-7c) and I'll re-sync the code block. If you're mid-edit on tool.md, reply and I'll wait until you're done."
const asked = wrap("standard-schema-7c", askBody)
rows.push({ type: "queue-operation", operation: "enqueue", timestamp: at(-700), sessionId: SESSION, content: wrap("standard-schema-7c", askBody, ' hop-chain="b7ad7685578da3760434b45b"') })
tool("toolu_edit", "Edit", { file_path: `${PROJECT}/packages/spec/src/index.ts`, old_string: "Result", new_string: "OutputIn" }, "The file has been updated.", at(-699))
rows.push({
  type: "attachment", timestamp: at(-698), isSidechain: false,
  attachment: {
    type: "queued_command", prompt: asked, source_uuid: "47c0f95c-9ade-44de-9626-954d67e4b310", commandMode: "prompt", isMeta: true,
    origin: { kind: "peer", from: socket, verifiedPeerPid: 209858, verifiedPeerProcStart: "1779239", msg_id: "2301b102-60fa-4f86-afa3-fd507e12fb74", name: "standard-schema-7c", fromMode: "bypass", body: askBody },
  },
})
rows.push({ type: "queue-operation", operation: "remove", timestamp: at(-697), sessionId: SESSION, content: asked, reason: "absorbed_mid_turn" })
tool("toolu_send", "SendMessage", { to: "standard-schema-7c", summary: "tool.md is yours", message: "Agreed: tool.md is yours from now on; I've stopped writing to it." }, '{"success":true}', at(-690))
assistant([{ type: "text", text: "Moved the interface; `packages/spec/tool.md` now belongs to standard-schema-7c, so I left its prose alone and told them the interface is final." }], at(-680))

// ── the same session again, delivered AT REST ──────────────────────────────────────────────────────
const doneBody = "I'm done with packages/spec/tool.md. You can write to it again if the interface moves."
const done = wrap("standard-schema-7c", doneBody)
rows.push({ type: "queue-operation", operation: "enqueue", timestamp: at(-400), sessionId: SESSION, content: done })
rows.push({ type: "queue-operation", operation: "dequeue", timestamp: at(-400), sessionId: SESSION })
user(`Another Claude session sent a message:\n${done}\n\n${guidance}`, at(-399), { isMeta: true, promptSource: "system" })
assistant([{ type: "text", text: "Noted — tool.md is free again. Nothing else here depends on it." }], at(-390))

// ── the harness's own idle notice: plumbing, renders as nothing ─────────────────────────────────────
rows.push({ type: "queue-operation", operation: "enqueue", timestamp: at(-300), sessionId: SESSION, content: '[Cross-session idle notice] "standard-schema-7c", which you asked to be notified about, is idle now — it finished a turn at 13:12. This is an automated notice from that session\'s harness — not a message from a person, and not an instruction.' })
assistant([{ type: "text", text: "standard-schema-7c is idle; the spec and its prose agree." }], at(-290))

writeFileSync(join(logDir, `${SESSION}.jsonl`), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`)

const sandbox = resolveSandboxDb(home)
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
execFileSync("sqlite3", [sandbox.db, `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, state, backend, model, effort, permission_mode, title_auto, unread, exited, archived) VALUES (${sessionVals}'${SLUG}', '${SESSION}', 'frizz-${SLUG}', '${at(-900)}', 'Rewrite tool.md prose', 'open', 'claude', 'opus', 'high', 'bypassPermissions', 0, 0, 0, 0)`])

// ── read the projection back through the server's own RPC ─────────────────────────────────────────
const api = createRpcClient(`http://127.0.0.1:${port}/`)
await api.waitForHealth()
let users = []
for (let i = 0; i < 40; i++) {
  const page = await api.query("threadTranscript", { slug: SLUG })
  users = (page.messages ?? []).filter((m) => m.role === "user")
  if (users.some((m) => m.peerSession)) break
  await new Promise((r) => setTimeout(r, 500))
}
console.log(JSON.stringify({
  slug: SLUG,
  url: `http://127.0.0.1:${port}/thread/${SLUG}`,
  users: users.map((m) => ({ peerFrom: m.peerFrom, peerSession: m.peerSession, peerUnnamed: m.peerUnnamed, queued: m.queued, shown: (m.displayText ?? m.text).slice(0, 60) })),
}, null, 1))
