// Seed an adhoc stack with a worker resting on a live `Workflow` run — the shape of the arktype thread
// that prompted workflow tracking (session a627551f, "waiting on the wave 2 workflow", 2026-09-29):
// a Workflow tool call, its launch ack naming the run's transcript dir, and that dir's journal + agent
// sidecars + agent transcripts, across two phases, with running, finished and failed agents.
//
// Usage (against a running scripts/adhoc-stack.mjs — pass ITS home and project):
//   nub scripts/seed-workflow-run.mjs --port=4937 --home=<stack home> --project=<stack project>
// Prints the thread slug and the board's own view of the run, so the caller can assert before it shoots.
import { execFileSync } from "node:child_process"
import { mkdirSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { createRpcClient } from "./lib/rpc-client.mjs"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const args = process.argv.slice(2)
const opt = (k, d) => { const hit = args.find((a) => a.startsWith(`--${k}=`)); return hit ? hit.slice(k.length + 3) : d }
const port = Number(opt("port", "4937"))
const home = opt("home")
if (!home) { console.error("--home is required (from the stack's json line)"); process.exit(1) }

const SLUG = "featherduster-wave-2"
const SESSION = "a627551f-f848-413c-b2c1-989ee08a17c0"
const TOOL = "toolu_01SQopyabJgNSAsiYao87TCA"
const PROJECT = opt("project", process.cwd())
const logDir = join(home, ".claude", "projects", PROJECT.replace(/\//g, "-"))
const runDir = join(logDir, SESSION, "subagents", "workflows", "wf_45e1076e-215")
mkdirSync(runDir, { recursive: true })

const at = (offsetSec) => new Date(Date.now() + offsetSec * 1000).toISOString()
const rows = []
const assistant = (content, ts, stop = "end_turn") => rows.push({ type: "assistant", timestamp: ts, message: { id: `m${rows.length}`, role: "assistant", stop_reason: stop, content } })
const user = (content, ts) => rows.push({ type: "user", timestamp: ts, message: { role: "user", content } })

const script = `export const meta = {
  name: 'featherduster-wave2',
  description: 'Finish the interrupted wave-1 fix stage, then wave 2 of the featherduster push (W1..W5) with pipelined read-only reviews, adversarial verification and a final fix stage',
  phases: [{ title: 'Implement' }, { title: 'Review' }, { title: 'Verify' }],
}
const STEPS = ['W1', 'W2', 'W3']
for (const s of STEPS) await agent(\`Implement \${s}\`, { label: \`impl:\${s}\`, phase: 'Implement' })`

user([{ type: "text", text: "Run wave 2 of the featherduster push." }], at(-1500))
assistant([{ type: "text", text: "Launching wave 2 as a workflow." }], at(-1490))
assistant([{ type: "tool_use", id: TOOL, name: "Workflow", input: { script } }], at(-1480), "tool_use")
user([{ type: "tool_result", tool_use_id: TOOL, content: `Workflow launched in background. Task ID: wy4e6vc5c\nSummary: Finish the interrupted wave-1 fix stage, then wave 2 of the featherduster push\nTranscript dir: ${runDir}\nScript file: ${join(logDir, SESSION, "workflows", "scripts", "featherduster-wave2-wf_45e1076e-215.js")}` }], at(-1479))
assistant([{ type: "text", text: "Waiting on the wave 2 workflow. When it finishes: a review of the whole branch, the full set of checks, final measurements, then corrected commit messages and the report." }], at(-1470))
writeFileSync(join(logDir, `${SESSION}.jsonl`), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`)

const agents = [
  // [agentId, label, phase, outcome, spawned seconds ago]
  ["a1d0", "impl:W1 lazy keywords", "Implement", "result", 1400],
  ["a2d0", "impl:W2 lean registrations", "Implement", "result", 1100],
  ["a3d0", "impl:W3 node shapes", "Implement", "running", 700],
  ["a4d0", "review:W1", "Review", "result", 1000],
  ["a5d0", "review:W2", "Review", "failed", 800],
  ["a6d0", "review:W2 retry", "Review", "running", 400],
  ["a7d0", "verify:W1:0.1", "Verify", "running", 200],
]
const journal = [{ type: "launched" }]
for (const [id, label, phase, outcome, age] of agents) {
  const meta = join(runDir, `agent-${id}.meta.json`)
  writeFileSync(meta, JSON.stringify({ agentType: "workflow-subagent", description: label, workflowPhase: phase, spawnDepth: 1, requestShape: "foreground", requestNonInteractive: true }))
  const t = (Date.now() - age * 1000) / 1000
  utimesSync(meta, t, t)
  writeFileSync(join(runDir, `agent-${id}.jsonl`), [
    { type: "user", timestamp: at(-age), isSidechain: true, agentId: id, message: { role: "user", content: `[Workflow harness — computed task] ${label}: implement and report.` } },
    { type: "assistant", timestamp: at(-age + 5), isSidechain: true, agentId: id, message: { id: `x${id}`, role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: `Working on ${label}. Reading the relevant files first.` }] } },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n")
  journal.push({ type: "started", key: `v2:${id}`, agentId: id, label, phase })
  if (outcome !== "running") journal.push({ type: outcome, key: `v2:${id}`, agentId: id, ...(outcome === "result" ? { result: `${label} done` } : {}) })
}
writeFileSync(join(runDir, "journal.jsonl"), `${journal.map((r) => JSON.stringify(r)).join("\n")}\n`)

const sandbox = resolveSandboxDb(home)
const { cols, vals } = sessionProjectColumns(sandbox)
execFileSync("sqlite3", [sandbox.db, `INSERT OR REPLACE INTO session (${cols}slug, session_id, thread_name, spawned_at, title, state, backend, model, effort, permission_mode, title_auto, unread, exited, archived) VALUES (${vals}'${SLUG}', '${SESSION}', 'frizz-${SLUG}', '${at(-1500)}', 'Featherduster wave 2', 'open', 'claude', 'opus', 'high', 'bypassPermissions', 0, 0, 0, 0)`])

const api = createRpcClient(`http://127.0.0.1:${port}/`)
await api.waitForHealth()
let branch = []
for (let i = 0; i < 40; i++) {
  const board = await api.query("board")
  const thread = (board.threads ?? []).find((t) => t.id === SLUG || t.slug === SLUG)
  branch = thread?.subAgents ?? []
  if (branch.length >= 4) break
  await new Promise((r) => setTimeout(r, 500))
}
console.log(JSON.stringify({ slug: SLUG, tool: TOOL, branch: branch.map((a) => [a.label, a.state, a.depth ?? 1, a.phase ?? null]) }, null, 1))
