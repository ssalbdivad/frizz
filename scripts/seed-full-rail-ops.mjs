// Seed a disposable adhoc stack with ONE resting thread that owns every kind of row the ops strip under
// the prompt box draws — a live sub-agent, a background shell, a saved link and a saved file — for
// fullscreenOpsInRail.e2e.test.ts. On /full beside its rail the strip must draw none of them, and the
// rail must draw all of them; below the split the strip is the only place they are.
//
// Follows the frizz-stack recipe: a broker session row + a JSONL the REAL tailer folds, then the saved
// links through the worker's own RPC (upsertOwnLink), the way `mcp__frizz__link` creates them. The tailer
// drops a thread's shells the moment its owner looks gone, and for a broker row "gone" is an absent
// broker record — so, as in seed-resting-thread.mjs, the seed writes one naming a real live `sleep`.
// Kill both pids (printed as `daemonPid` and `shellPid`) when you tear the stack down.
//
// Usage: nub scripts/seed-full-rail-ops.mjs --port=<stack port> --home=<adhoc-stack HOME>
import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createRpcClient } from "./lib/rpc-client.mjs"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, port, cwd = process.cwd() } = flags
if (!home || !port) {
  console.error("usage: nub scripts/seed-full-rail-ops.mjs --port=<stack port> --home=/abs/temp-home")
  process.exit(1)
}

const sandbox = resolveSandboxDb(home)
const { cols, vals } = sessionProjectColumns(sandbox)
const jsonlDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(jsonlDir, { recursive: true })

const SLUG = "full-rail-ops"
const SESSION = "7c0110ff-0000-4000-8000-0000000f0001"
const now = () => new Date().toISOString()
let n = 0
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`

const daemon = spawn("sleep", ["7200"], { detached: true, stdio: "ignore" })
daemon.unref()
mkdirSync(join(sandbox.stateDir, "claude-broker"), { recursive: true })
writeFileSync(
  join(sandbox.stateDir, "claude-broker", `${createHash("sha256").update(SESSION).digest("hex").slice(0, 16)}.json`),
  JSON.stringify({ sessionId: SESSION, daemonPid: daemon.pid, socketPath: join(sandbox.stateDir, "claude-broker", `${SLUG}.sock`) }),
)

const AGENT = { id: "toolu_fro_agent", agent: "froA", type: "frizz:opus-xhigh", label: "Verify the rail carries every row" }
const SHELL = { id: "toolu_fro_sh1", op: "bgfro001", label: "Run the dev server" }

// A FRESH mtime on the sub-agent's transcript is what makes the child read `running`.
const subagentsDir = join(jsonlDir, SESSION, "subagents")
mkdirSync(subagentsDir, { recursive: true })
writeFileSync(
  join(subagentsDir, `agent-${AGENT.agent}.meta.json`),
  JSON.stringify({ agentType: AGENT.type, description: AGENT.label, toolUseId: AGENT.id, spawnDepth: 1 }),
)
writeFileSync(
  join(subagentsDir, `agent-${AGENT.agent}.jsonl`),
  JSON.stringify({
    parentUuid: null, isSidechain: true, type: "assistant", uuid: uuid(), timestamp: now(), session_id: SESSION, cwd,
    message: { model: "claude-opus-5", id: `msg_${AGENT.agent}`, type: "message", role: "assistant", stop_reason: null, content: [{ type: "text", text: `Working on: ${AGENT.label}` }], usage: { input_tokens: 2, output_tokens: 20 } },
  }) + "\n",
)

const tasksDir = join(home, "tasks")
mkdirSync(tasksDir, { recursive: true })
writeFileSync(join(tasksDir, `${SHELL.op}.output`), "listening on :5173\n")
// The shell's LIVENESS is an open handle on its output file (tailer.shellIsGone asks lsof), so a real
// process holds it — without one the board demotes the shell to "stale" once its grace window passes,
// and the rail lists running shells only.
const outFd = openSync(join(tasksDir, `${SHELL.op}.output`), "a")
const shellProc = spawn("sleep", ["7200"], { detached: true, stdio: ["ignore", outFd, "ignore"] })
shellProc.unref()
closeSync(outFd)

// The harness's own auto-background ack — LAUNCH_ACK_RE in tailer.ts turns it into a TRACKED shell.
const autoBg =
  `Command did not complete within its 590s timeout and was moved to the background (ID: ${SHELL.op}). ` +
  `Output is being written to: ${join(tasksDir, `${SHELL.op}.output`)}. ` +
  "You will be notified when it completes. To check interim output, use Read on that file path."

const records = [
  { type: "user", message: { role: "user", content: "TASK:\nMove the ops rows into the rail." } },
  {
    type: "assistant",
    message: {
      model: "claude-opus-5", id: "msg_fro_dispatch", type: "message", role: "assistant", stop_reason: "tool_use",
      content: [
        { type: "tool_use", name: "Agent", id: AGENT.id, input: { description: AGENT.label, prompt: `${AGENT.label}. Report back.`, run_in_background: true, subagent_type: AGENT.type } },
        { type: "tool_use", name: "Bash", id: SHELL.id, input: { command: `# ${SHELL.label}\nsleep 7200`, description: SHELL.label, timeout: 590000 } },
      ],
      usage: { input_tokens: 2, output_tokens: 120 },
    },
  },
  {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: AGENT.id, content: `Async agent launched successfully.\nagentId: ${AGENT.agent}\noutput_file: ${join(subagentsDir, `agent-${AGENT.agent}.jsonl`)}` },
        { type: "tool_result", tool_use_id: SHELL.id, content: autoBg },
      ],
    },
  },
  {
    type: "assistant",
    message: {
      model: "claude-opus-5", id: "msg_fro_rest", type: "message", role: "assistant", stop_reason: "end_turn",
      content: [{ type: "text", text: "The sub-agent is verifying the rail and the dev server is up; both are saved below." }],
      usage: { input_tokens: 2, output_tokens: 30 },
    },
  },
].map((r) => ({ ...r, parentUuid: null, isSidechain: false, uuid: uuid(), timestamp: now(), session_id: SESSION, cwd }))
writeFileSync(join(jsonlDir, `${SESSION}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")

execFileSync("sqlite3", [
  sandbox.db,
  `INSERT OR REPLACE INTO session (${cols}slug, session_id, thread_name, spawned_at, title, title_auto, backend, claude_runtime, model, effort, permission_mode, state, unread, exited, archived, rested_at)
   VALUES (${vals}'${SLUG}', '${SESSION}', 'frizz-${SLUG}', '${now()}', 'Move the ops rows into the rail', 0, 'claude', 'broker', 'opus', 'xhigh', 'default', 'open', 0, 0, 0, '${now()}')`,
])

const api = createRpcClient(`http://127.0.0.1:${port}/`)
await api.waitForHealth()
await api.mutate("upsertOwnLink", { slug: SLUG, label: "Open dev server", target: "http://127.0.0.1:5173/project/demo" })
await api.mutate("upsertOwnLink", { slug: SLUG, label: "Working plan", target: join(cwd, "README.md") })
console.log(JSON.stringify({ slug: SLUG, session: SESSION, daemonPid: daemon.pid, shellPid: shellProc.pid }))
