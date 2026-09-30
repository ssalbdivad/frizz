#!/usr/bin/env node
// A STANDUP DEMO: one command boots a disposable, fully-isolated Frizz and fills it with fake threads in
// as many board states as the app has, weighted toward what changed on 2026-09-29/30 (the audit at
// .frizz/threads/054bee45-…/audit-standup.md). Nothing real is touched: the stack is scripts/adhoc-stack.mjs
// (sandbox HOME, throwaway port, scheduler off), and the three projects are fresh git repos under /tmp.
//
//   nub scripts/demo-standup.mjs [--port=4960]
//
// It prints the URL and stays up, TICKING the live threads (new tool calls on the working ones, lines on
// the agent shells, fresh records on the running sub-agents) so the board keeps moving while it is shown.
// Ctrl-C tears everything down: the stack deletes its HOME, and this deletes the demo repos.
//
// Every thread is the frizz-stack recipe — a session row plus a JSONL the REAL tailer reads — and every
// row the app has an RPC for (timers, the Goal, a thread message, a terminal) is made through that RPC.
// The only hand-written rows are the ones only a worker's MCP tool makes: questions, the spinoff edge and
// the permission interaction, as scripts/seed-all-queues.mjs and seed-permission-cards.mjs do.
//
// What is where (the `frizz` project; arktype and pullfrog carry a few more for All projects):
//   Ready    settingsStore   two open questions in one ask (one multi-select)
//            parserAudit     "2 of 3 sub-agents returned", with Snooze until all return
//            cacheKeys       a done card, after a sub-agent's report
//            releasePublish  your terminal on the thread, waiting at npm's OTP prompt
//            docsSweep       a message from @changelogDraft, which is waiting on its reply
//            lockfileBump    an approval card for a Bash command
//            loginFlake      a bare "Not fixed" handoff
//            terminalStrip   done; spun off @opsPolish
//   Working  folderHint      in a WORKTREE, status line, two live agent shells + one finished + your terminal
//            waveTwo         a live Workflow run, its agents as sub-agents
//            nightlyBench    a Goal: 2 of 5 runs, 4h limit
//            handleSweep     three live sub-agents, folded to one line in the rail (pinned)
//            opsPolish       the spinoff child, headed by its spinoff card
//   Snoozed  releaseWindow   parked on two timers
//            changelogDraft  waiting on @docsSweep's reply
//            schemaAudit     snoozed until all sub-agents return
//            bundleTrim      snoozed until tomorrow
//   Done     routerSplit, iconRhythm — and changelogPass, a Done row that is still working (spinner)
import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFileSync, closeSync, existsSync, openSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { restPromptMessage, spinoffChildPrompt, spinoffRequestMessage, wakeDeliveryToken } from "../packages/shared/src/index.ts"
import { threadMessageBody } from "../packages/server/src/thread-mentions.ts"
import Database from "../packages/server/src/sqlite.ts"
import { buildClaudePermissionInteraction } from "../packages/server/src/backend/claude-permission-interactions.ts"
import { createInteractionStore } from "../packages/server/src/interaction-store.ts"
import { createRpcClient } from "./lib/rpc-client.mjs"

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const port = Number(arg("port", "4960"))
const repo = realpathSync(join(import.meta.dirname, ".."))

// ── the demo repos ───────────────────────────────────────────────────────────────────────────────────
const root = realpathSync(mkdtempSync(join(tmpdir(), "frizz-standup-")))
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { stdio: "ignore" })
function makeRepo(name, files) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true })
    writeFileSync(join(dir, path), body)
  }
  git(dir, "init", "-q", "-b", "main")
  git(dir, "add", "-A")
  git(dir, "-c", "user.name=demo", "-c", "user.email=demo@example.com", "commit", "-qm", "init")
  return dir
}
const frizzDir = makeRepo("frizz", {
  "README.md": "# Frizz\n\nA board for your agents.\n",
  "packages/web/src/components/ChildOpRow.tsx": "export function ChildOpRow() { return null }\n",
  "packages/server/src/thread-cwd.ts": "export function liftCheckout() {}\n",
  ".gitignore": ".frizz/\n",
})
// A REAL worktree, so the folder hint reads "worktree": thread-cwd.ts calls a checkout a worktree when
// its `.git` is a FILE.
const worktree = join(frizzDir, ".frizz", "worktrees", "folder-hint")
git(frizzDir, "worktree", "add", "-q", worktree, "-b", "folder-hint")
const arktypeDir = makeRepo("arktype", { "README.md": "# ArkType\n", "ark/type/scope.ts": "export {}\n" })
const pullfrogDir = makeRepo("pullfrog", { "README.md": "# Pullfrog\n", "app/api/webhook/github/route.ts": "export {}\n" })

// ── the stack ────────────────────────────────────────────────────────────────────────────────────────
const stackLog = join(root, "stack.log")
const stackProc = spawn(
  process.execPath,
  [...process.execArgv, join(repo, "scripts/adhoc-stack.mjs"), `--port=${port}`, `--project=${frizzDir}`, `--also-project=${arktypeDir}`, `--also-project=${pullfrogDir}`],
  { cwd: repo, stdio: ["ignore", "pipe", "pipe"] },
)
stackProc.stdout.on("data", (b) => appendFileSync(stackLog, b))
stackProc.stderr.on("data", (b) => appendFileSync(stackLog, b))
const daemon = spawn("sleep", ["86400"], { detached: true, stdio: "ignore" })
daemon.unref()

const shellPids = []
let tearingDown = false
function teardown(code = 0) {
  if (tearingDown) return
  tearingDown = true
  for (const pid of [daemon.pid, ...shellPids.map((p) => -p)]) try { process.kill(pid) } catch {}
  stackProc.once("exit", () => {
    rmSync(root, { recursive: true, force: true })
    process.exit(code)
  })
  stackProc.kill("SIGTERM")
  setTimeout(() => { rmSync(root, { recursive: true, force: true }); process.exit(code) }, 10_000).unref()
}
process.on("SIGINT", () => teardown(0))
process.on("SIGTERM", () => teardown(0))
// A terminal's Ctrl-C reaches the stack too, and it exits cleanly: only an unasked-for exit is a failure.
stackProc.on("exit", (c, signal) => {
  if (tearingDown) return
  if (c === 0 || signal) return teardown(0)
  console.error(`stack exited (${c}); see ${stackLog}`)
  teardown(1)
})

let stack
for (let i = 0; !stack; i++) {
  if (i > 600) { console.error(`stack never came up; see ${stackLog}`); teardown(1) }
  await new Promise((r) => setTimeout(r, 200))
  const line = existsSync(stackLog) && readFileSync(stackLog, "utf8").split("\n").find((l) => l.startsWith("{\"url\""))
  if (line) stack = JSON.parse(line)
}
const home = stack.home
const origin = new URL(stack.url).origin
const db = join(home, ".frizz", "ui.db")
const projects = {
  frizz: { id: stack.launcher.id, dir: frizzDir },
  ...Object.fromEntries(stack.tenants.map((t) => [t.slug, { id: t.id, dir: realpathSync(t.dir) }])),
}
for (const p of Object.values(projects)) {
  p.stateDir = join(home, ".frizz", "projects", p.id)
  p.logDir = join(home, ".claude", "projects", p.dir.replace(/[/.]/g, "-"))
  p.api = createRpcClient(`${origin}/`, p.id)
  mkdirSync(p.logDir, { recursive: true })
  mkdirSync(join(p.stateDir, "claude-broker"), { recursive: true })
}
await projects.frizz.api.waitForHealth()

// ── record builders ──────────────────────────────────────────────────────────────────────────────────
const now = Date.now()
const ago = (m) => new Date(now - m * 60_000).toISOString()
const q = (s) => (s === null || s === undefined ? "NULL" : `'${String(s).replace(/'/g, "''")}'`)
const sql = (text) => execFileSync("sqlite3", ["-cmd", ".timeout 10000", db, text])
const hex = (s) => createHash("sha256").update(s).digest("hex")
const uuidOf = (s) => { const h = hex(s); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-9${h.slice(17, 20)}-${h.slice(20, 32)}` }
let seq = 0

/** A transcript under construction. Every record carries the thread's CURRENT folder, which is what the
 *  tailer folds into the header's worktree hint. */
function transcript(p, slug) {
  const sessionId = uuidOf(`${p.id}/${slug}`)
  const rows = []
  let cwd = p.dir
  const base = (ts) => ({ parentUuid: null, isSidechain: false, uuid: uuidOf(`r${++seq}`), timestamp: ts, sessionId, session_id: sessionId, cwd })
  const t = {
    sessionId, rows, p, slug,
    cd(dir) { cwd = dir; return t },
    get cwd() { return cwd },
    user(content, ts, extra = {}) { rows.push({ ...base(ts), type: "user", message: { role: "user", content }, ...extra }); return t },
    say(text, ts, stop = "end_turn") { rows.push({ ...base(ts), type: "assistant", message: { model: "claude-opus-5-5", id: `m${++seq}`, type: "message", role: "assistant", stop_reason: stop, content: [{ type: "text", text }], usage: { input_tokens: 2, output_tokens: 80 } } }); return t },
    call(id, name, input, ts) { rows.push({ ...base(ts), type: "assistant", message: { model: "claude-opus-5-5", id: `m${++seq}`, type: "message", role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }], usage: { input_tokens: 2, output_tokens: 40 } } }); return t },
    result(id, text, ts, extra = {}) { t.user([{ type: "tool_result", tool_use_id: id, content: text }], ts, extra); return t },
    tool(id, name, input, out, ts) { return t.call(id, name, input, ts).result(id, out, ts) },
    notify(id, status, summary, ts) {
      rows.push({ type: "queue-operation", operation: "remove", uuid: uuidOf(`r${++seq}`), timestamp: ts, session_id: sessionId, cwd, content: `<task-notification>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>` })
      return t
    },
    /** A background sub-agent, launched. `live` gives it a fresh transcript the ticker keeps touching. */
    agent(id, description, prompt, ts, subagentType = "frizz:high") {
      const dir = join(p.logDir, sessionId, "subagents")
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `agent-${id}.jsonl`)
      writeFileSync(file, `${JSON.stringify({ type: "user", timestamp: ts, isSidechain: true, agentId: id, message: { role: "user", content: prompt } })}\n${JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), isSidechain: true, agentId: id, message: { id: `x${id}`, role: "assistant", stop_reason: "tool_use", content: [{ type: "text", text: `Reading the code for: ${description}` }] } })}\n`)
      t.call(id, "Agent", { description, prompt, run_in_background: true, subagent_type: subagentType }, ts)
      t.result(id, [{ type: "text", text: `Async agent launched successfully.\nagentId: ${id}\noutput_file: ${file}` }], ts, { toolUseResult: { isAsync: true, status: "pending", agentId: id, description } })
      liveChildren.push(file)
      return t
    },
    /** A background agent shell, with a real `tasks/<id>.output` the drawer streams. A `loop` makes it
     *  LIVE: Frizz asks the OS whether a process still holds the log (tailer.ts shellIsGone) and where
     *  that process is (shell-cwd-probe.ts), so a real one runs in the thread's folder, printing it. */
    shell(id, command, description, lines, ts, loop) {
      const tasks = join(home, "claude-tmp", sessionId, "tasks")
      mkdirSync(tasks, { recursive: true })
      const out = join(tasks, `${id}.output`)
      writeFileSync(out, lines.join("\n") + "\n")
      if (loop) {
        const fd = openSync(out, "a")
        const proc = spawn("sh", ["-c", `while sleep 15; do ${loop}; done`], { cwd, detached: true, stdio: ["ignore", fd, fd] })
        proc.unref()
        // Closed HERE, or this process holds the log too and the folder probe may read ITS folder.
        closeSync(fd)
        shellPids.push(proc.pid)
      }
      t.call(id, "Bash", { command, description, run_in_background: true }, ts)
      t.result(id, `Command running in background with ID: ${id}. Output is being written to: ${out}`, ts)
      return out
    },
  }
  return t
}

const liveChildren = []
const ticking = [] // in-flight threads the ticker advances

/** Register a thread: write its transcript, its broker record and its row. */
function register(t, { title, rest = null, archived = false, snoozedUntil = null, pinned = false, status = null, statusAgo = 6, model = "opus", effort = "high", live = true, unread = false }) {
  const { p, slug, sessionId, rows } = t
  const file = join(p.logDir, `${sessionId}.jsonl`)
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n")
  if (live) {
    writeFileSync(join(p.stateDir, "claude-broker", `${hex(sessionId).slice(0, 16)}.json`), JSON.stringify({ sessionId, daemonPid: daemon.pid, socketPath: join(p.stateDir, "claude-broker", `${slug}.sock`) }))
  }
  sql(`INSERT OR REPLACE INTO session (project_id, slug, session_id, thread_name, spawned_at, title, title_auto, title_agent, backend, claude_runtime, model, effort, permission_mode, state, unread, exited, archived, rested_at, snoozed_until, pinned_at, status, status_at)
       VALUES (${q(p.id)}, ${q(slug)}, ${q(sessionId)}, ${q(`frizz-${slug}`)}, ${q(rows[0].timestamp)}, ${q(title)}, 0, 1, 'claude', ${live ? "'broker'" : "NULL"}, ${q(model)}, ${q(effort)}, 'bypassPermissions', ${archived ? "'archived'" : "'open'"}, ${unread ? 1 : 0}, 0, ${archived ? 1 : 0}, ${q(rest === null ? null : ago(rest))}, ${q(snoozedUntil)}, ${q(pinned ? ago(300) : null)}, ${q(status)}, ${q(status ? ago(statusAgo) : null)})`)
  return { ...t, file }
}

const ask = (p, slug, spec, minutesAgo, n = 0) =>
  sql(`INSERT OR REPLACE INTO thread_question (id, project_id, thread_slug, spec, state, answer, delivered, asked_at, settled_at)
       VALUES (${q(`qst_${hex(`${p.id}/${slug}/${n}`).slice(0, 8)}`)}, ${q(p.id)}, ${q(slug)}, ${q(JSON.stringify(spec))}, 'open', NULL, 0, ${now - minutesAgo * 60_000}, NULL)`)

const fence = (kind, body) => `\`\`\`${kind}\n${body}\n\`\`\``
const F = projects.frizz

// ═══ READY — the queue ═══════════════════════════════════════════════════════════════════════════════

{ // Two questions in one ask; each answer goes to the agent the moment it is picked.
  const t = transcript(F, "settings-store")
  t.user("Move the user settings out of localStorage into something the server owns.", ago(52))
    .tool("s1", "Read", { file_path: `${frizzDir}/packages/server/src/thread-cwd.ts` }, "export function liftCheckout() {}", ago(50))
    .tool("s2", "Grep", { pattern: "localStorage", path: `${frizzDir}/packages/web` }, "packages/web/src/lib/settings.ts:14\npackages/web/src/lib/settings.ts:31", ago(48))
    .say("**Needs you** — the settings store is scaffolded behind one interface, and two calls are yours before persistence goes in.\n\nToday every setting lives in the browser, so a second window or a second machine starts from defaults. Both options below keep the current keys and migrate them on first load; they differ in what a hand-edit and a concurrent write do.", ago(21))
  register(t, { title: "Settings store", rest: 21, unread: true })
  ask(F, t.slug, {
    question: "Store settings in the server's SQLite or in a JSON file beside it?", header: "Settings store", kind: "question",
    options: [
      { label: "SQLite", description: "transactional, and where sessions already live", recommended: true },
      { label: "JSON file", description: "hand-editable, but two tabs writing at once can lose one" },
    ],
  }, 21, 0)
  ask(F, t.slug, {
    question: "Which settings should follow the operator across machines?", header: "Synced settings", kind: "multi",
    options: [
      { label: "Theme", description: "light / dark / system", recommended: true },
      { label: "Queue filter", description: "the focused project and All projects" },
      { label: "Snooze default", description: "until tomorrow at 5am" },
      { label: "Keyboard map", description: "custom bindings" },
    ],
  }, 21, 1)
}

let parserAudit
{ // A fan-out: 2 of 3 back, the third still running.
  const t = transcript(F, "parser-audit")
  t.user("Audit the transcript parser for records it drops. Fan it out.", ago(95))
    .say("Splitting the audit three ways: queue operations, attachments, and sidechains.", ago(94), "tool_use")
    .agent("aQueueOps", "Queue ops", "Audit queue-operation handling in transcript.ts. Report every operation it drops.", ago(94))
    .agent("aAttach", "Attachments", "Audit attachment records. Report every attachment type the projection ignores.", ago(94))
    .agent("aSidechain", "Sidechains", "Audit sidechain handling. Report any sidechain record that leaks into the parent.", ago(94))
    .say(`Three audits are out.\n\n${fence("awaiting", "agents: [aQueueOps, aAttach, aSidechain]\nfor: 2h\ntitle: Parser audit, three prongs\n---\nWaiting on the three audits before touching the parser.")}`, ago(93))
    .notify("aQueueOps", "completed", "Agent \"Queue ops\" completed", ago(61))
    .say(`**Queue ops** found one: a \`dequeue\` with no content is dropped, which is correct — it carries nothing.\n\n${fence("awaiting", "agents: [aAttach, aSidechain]\nfor: 2h\n---\nOne of three back, nothing to fix from it.")}`, ago(60))
    .notify("aAttach", "completed", "Agent \"Attachments\" completed", ago(18))
    .say(`**Attachments** found a real one: a \`queued_command\` with \`origin.kind: "peer"\` rendered as the operator's own bubble. The fix is a one-line branch in the projection; it waits on the sidechain audit, which touches the same function.\n\n${fence("awaiting", "Two of three back. Folding both into one change once sidechains reports.")}`, ago(17))
  // Two came back: their transcripts are finished, not live.
  liveChildren.splice(liveChildren.findIndex((f) => f.endsWith("agent-aQueueOps.jsonl")), 1)
  liveChildren.splice(liveChildren.findIndex((f) => f.endsWith("agent-aAttach.jsonl")), 1)
  parserAudit = register(t, { title: "Parser audit", rest: 17 })
}

{ // Done, after a sub-agent's report.
  const t = transcript(F, "cache-keys")
  t.user("The resolver cache collides when two projects share a thread slug. Fix it.", ago(130))
    .agent("aRepro", "Collision repro", "Write the smallest repro of two projects colliding in the resolver cache.", ago(128))
    .notify("aRepro", "completed", "Agent \"Collision repro\" completed", ago(110))
    .tool("c1", "Edit", { file_path: `${frizzDir}/packages/server/src/thread-cwd.ts`, old_string: "slug", new_string: "`${projectId}/${slug}`" }, "The file has been updated.", ago(100))
    .tool("c2", "Bash", { command: "nub --test packages/server/src/thread-cwd.test.ts", description: "Running the resolver tests" }, "✔ 14 tests passed", ago(98))
    .say(`**Fixed** — the resolver cache keys on project and slug, so two projects' \`fix-login\` threads no longer read each other's folder. Landed on \`main\` as \`4e1a9c2\`.\n\n${fence("done", "- **Keyed the cache** in `packages/server/src/thread-cwd.ts` on `projectId/slug`.\n- **Added the repro** as a regression test; `nub --test` green (14/14).")}`, ago(96))
  liveChildren.splice(liveChildren.findIndex((f) => f.endsWith("agent-aRepro.jsonl")), 1)
  register(t, { title: "Cache keys", rest: 96 })
}

{ // Your terminal on the thread, waiting at a prompt: its screen is on the card.
  const t = transcript(F, "release-publish")
  t.user("Publish frizz-server 0.14.2.", ago(40))
    .tool("p1", "Bash", { command: "git log release..main --oneline", description: "Listing what ships" }, "4e1a9c2 fix(cwd): key the resolver cache on project\n9b0c1d3 feat(terminals): one strip", ago(38))
    .tool("p2", "Bash", { command: "nub run typecheck && nub run test", description: "Verifying the release commit" }, "typecheck ✔\n1,284 tests ✔", ago(30))
    .say("**Ready to publish** — `release` is at `4e1a9c2` and the suite is green on that sha. `npm stage approve` is open in a terminal on this thread, waiting for the one-time password.", ago(12))
  register(t, { title: "Release publish", rest: 12 })
}

{ // Received a message from another thread, which is waiting on the answer.
  const t = transcript(F, "docs-sweep")
  t.user("Sweep ARCHITECTURE.md for statements the singleton made false.", ago(80))
    .tool("d1", "Grep", { pattern: "one server per repo", path: frizzDir }, "ARCHITECTURE.md:212\nREADME.md:40", ago(75))
    .say("Found two stale lines; fixing both.", ago(74), "tool_use")
    .tool("d2", "Edit", { file_path: `${frizzDir}/README.md`, old_string: "one server per repo", new_string: "one server, every project" }, "The file has been updated.", ago(73))
    .user(`${threadMessageBody({ fromHandle: "changelogDraft", message: "Did the terminals section in ARCHITECTURE.md change today? I'm writing the 0.14 changelog and want to link the right heading.", awaitsReply: true })}\n\n${wakeDeliveryToken(hex("docs-sweep-msg"))}`, ago(9))
    .say("**Needs you** — both stale lines are fixed. @changelogDraft asked whether the terminals section moved; it did (now § Board nomenclature), and the reply is drafted but not sent, because it names a heading the maintainer is still renaming.", ago(8))
  register(t, { title: "Docs sweep", rest: 8, unread: true })
}

{ // An approval card.
  const t = transcript(F, "lockfile-bump")
  t.user("Bump node-pty to beta.16 and regenerate the lockfile.", ago(6))
    .tool("l1", "Read", { file_path: `${frizzDir}/README.md` }, "# Frizz", ago(5))
    .say("Regenerating the lockfile.", ago(4), "tool_use")
  const r = register(t, { title: "Lockfile bump" })
  const database = new Database(db)
  createInteractionStore(database).create(buildClaudePermissionInteraction(
    { requestId: "lockfile-req", toolUseId: "lockfile-tool", toolName: "Bash", input: { command: "nub install --lockfile-only", description: "Regenerating the lockfile" }, description: "Regenerating the lockfile", suggestions: [] },
    { projectId: F.id, threadSlug: r.slug, sessionId: r.sessionId, sessionEpoch: 0, capabilityRevision: 0, cwd: frizzDir },
  ))
  database.close()
}

{ // A bare "Not fixed" handoff.
  const t = transcript(F, "login-flake")
  t.user("The login e2e test fails about one run in ten. Find out why.", ago(160))
    .tool("f1", "Bash", { command: "for i in $(seq 50); do nub --test e2e/login.test.ts || echo FAIL; done | grep -c FAIL", description: "Looping the login test fifty times" }, "4", ago(150))
    .tool("f2", "Bash", { command: "FRIZZ_TRACE=1 nub --test e2e/login.test.ts", description: "Tracing a failing run" }, "… cookie set at +612ms, assertion at +500ms", ago(140))
    .say("**Not fixed** — the test asserts the session cookie on a fixed 500ms timer, and slow runs set it at ~610ms. Waiting on the `Set-Cookie` response instead fixes it, but three other tests share the helper and one of them *wants* the timeout (it asserts a slow path). Next: split the helper, then loop 200 runs.", ago(135))
  register(t, { title: "Login flake", rest: 135 })
}

let terminalStrip
{ // Spinoff: the parent's done card stays put; the child starts with its brief.
  const t = transcript(F, "terminal-strip")
  t.user("Put the agent's shells and my terminals in one strip.", ago(240))
    .tool("ts1", "Edit", { file_path: `${frizzDir}/packages/web/src/components/ChildOpRow.tsx`, old_string: "return null", new_string: "return <Row />" }, "The file has been updated.", ago(220))
    .say(`**Fixed** — one strip for both owners, the robot mark for the agent's shells and the terminal mark for yours. Landed as \`9b0c1d3\`.\n\n${fence("done", "- **Merged the two strips** in `packages/web/src/components/ChildOpRow.tsx`.\n- **Every row opens** to its output in the drawer.")}`, ago(200))
  terminalStrip = t
}

// ═══ WORKING ═════════════════════════════════════════════════════════════════════════════════════════

let folderHint
{ // In a worktree, with agent shells and a status line.
  const t = transcript(F, "folder-hint")
  t.user("Show the agent's current folder in the thread header, and flag a worktree.", ago(48))
    .tool("h1", "Bash", { command: `git worktree add .frizz/worktrees/folder-hint -b folder-hint && cd .frizz/worktrees/folder-hint && nub install`, description: "Creating the folder-hint worktree" }, "Preparing worktree (new branch 'folder-hint')\ndone in 4.1s", ago(46))
    .cd(worktree)
  t.shell("bdev1", "nub run dev -- --port 5190", "Starting the dev server", ["  VITE v7.1.3  ready in 812 ms", "", "  ➜  Local:   http://127.0.0.1:5190/", "  ➜  press h + enter to show help"], ago(44), `echo "$(date +%T) [vite] hmr update /src/components/ThreadHeader.tsx"`)
  t.shell("btest2", "nub --test --watch packages/server/src/thread-cwd.test.ts", "Watching the cwd tests", ["▶ liftCheckout", "  ✔ the project root draws nothing", "  ✔ a worktree reads worktree", "✔ 11 tests passed"], ago(43), `echo "$(date +%T) ✔ 11 tests passed (watching)"`)
  t.shell("bshot3", "nub scripts/shot.mjs --url=http://127.0.0.1:5190/ --out=/tmp/hint.png", "Capturing the header", ["shot → /tmp/hint.png (1440×900 @2x)"], ago(30))
  t.notify("bshot3", "completed", "Background command \"Capturing the header\" completed (exit code 0)", ago(29))
  t.tool("h2", "Read", { file_path: `${worktree}/packages/server/src/thread-cwd.ts` }, "export function liftCheckout() {}", ago(20))
    .call("h3", "Bash", { command: "nub scripts/ink-gaps.mjs --url=http://127.0.0.1:5190/", description: "Measuring the hint's ink gaps" }, ago(1))
  folderHint = register(t, { title: "Folder hint", status: "Measuring the folder hint's ink gaps against the header title", statusAgo: 14 })
  ticking.push(folderHint)
}

{ // A live Workflow run: its agents are sub-agents, each transcript one click away.
  const t = transcript(F, "wave-two")
  const runDir = join(F.logDir, t.sessionId, "subagents", "workflows", "wf_8c21d0e4-001")
  mkdirSync(runDir, { recursive: true })
  t.user("Run wave 2 of the rail density push as a workflow.", ago(35))
    .say("Launching wave 2: implement, review and verify each of the three rail changes.", ago(34), "tool_use")
    .call("wfTool", "Workflow", { script: "export const meta = { name: 'rail-density-w2', description: 'Rail density wave 2', phases: [{ title: 'Implement' }, { title: 'Review' }, { title: 'Verify' }] }" }, ago(33))
    .result("wfTool", `Workflow launched in background. Task ID: wy4e6vc5c\nSummary: Rail density wave 2\nTranscript dir: ${runDir}\nScript file: ${join(F.logDir, t.sessionId, "workflows", "scripts", "rail-density-w2.js")}`, ago(33))
    .say("Waiting on the wave 2 workflow; I review the whole branch when it lands.", ago(32))
  const agents = [["w1", "impl:row icons", "Implement", "result", 30], ["w2", "impl:tight rows", "Implement", "result", 26], ["w3", "impl:one-line sub-agents", "Implement", "running", 20], ["w4", "review:row icons", "Review", "result", 18], ["w5", "review:tight rows", "Review", "running", 8], ["w6", "verify:row icons", "Verify", "running", 4]]
  const journal = [{ type: "launched" }]
  for (const [id, label, phase, outcome, age] of agents) {
    writeFileSync(join(runDir, `agent-${id}.meta.json`), JSON.stringify({ agentType: "workflow-subagent", description: label, workflowPhase: phase, spawnDepth: 1, requestShape: "foreground", requestNonInteractive: true }))
    const file = join(runDir, `agent-${id}.jsonl`)
    writeFileSync(file, [
      { type: "user", timestamp: ago(age), isSidechain: true, agentId: id, message: { role: "user", content: `${label}: implement and report.` } },
      { type: "assistant", timestamp: ago(age - 1), isSidechain: true, agentId: id, message: { id: `x${id}`, role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: `Working on ${label}. Reading the rail first.` }] } },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n")
    if (outcome === "running") liveChildren.push(file)
    journal.push({ type: "started", key: `v2:${id}`, agentId: id, label, phase })
    if (outcome !== "running") journal.push({ type: outcome, key: `v2:${id}`, agentId: id, result: `${label} done` })
  }
  writeFileSync(join(runDir, "journal.jsonl"), journal.map((r) => JSON.stringify(r)).join("\n") + "\n")
  register(t, { title: "Wave two", status: "Waiting on the rail density workflow, 3 of 6 agents done", statusAgo: 32 })
}

let nightlyBench
{ // A Goal with limits: stop after 5 runs or 4h.
  const t = transcript(F, "nightly-bench")
  t.user("Get the cold-start benchmark under 400ms. Keep going until it is.", ago(70))
    .tool("n1", "Bash", { command: "nub scripts/bench-cold-start.mjs", description: "Benchmarking cold start" }, "cold start p50 612ms", ago(66))
    .say("612ms. The tailer's first read is 180ms of it; making it lazy next.", ago(60))
    .user(`${restPromptMessage("Keep going until cold start is under 400ms.")}\n\n${wakeDeliveryToken(hex("bench1"))}`, ago(59))
    .tool("n2", "Edit", { file_path: `${frizzDir}/packages/server/src/thread-cwd.ts`, old_string: "export", new_string: "export /* lazy */" }, "The file has been updated.", ago(50))
    .tool("n3", "Bash", { command: "nub scripts/bench-cold-start.mjs", description: "Benchmarking cold start" }, "cold start p50 451ms", ago(44))
    .say("451ms. The rest is the board's first projection.", ago(40))
    .user(`${restPromptMessage("Keep going until cold start is under 400ms.")}\n\n${wakeDeliveryToken(hex("bench2"))}`, ago(39))
    .call("n4", "Bash", { command: "nub --cpu-prof scripts/bench-cold-start.mjs", description: "Profiling the first projection" }, ago(2))
  nightlyBench = register(t, { title: "Nightly bench", status: "Profiling the board's first projection, 451ms to go under 400", statusAgo: 38 })
  ticking.push(nightlyBench)
}

let handleSweep
{ // Three live sub-agents, folded into one line in the rail.
  const t = transcript(F, "handle-sweep")
  t.user("Every place a thread is named should use its @handle. Sweep the web and the server.", ago(25))
    .say("Three prongs: the web, the server, and the worker prompt.", ago(24), "tool_use")
    .agent("aWeb", "Web mentions", "Find every place the web names a thread by title instead of @handle.", ago(24), "frizz:medium")
    .agent("aServer", "Server mentions", "Find every server string that names a thread by slug where a handle reads better.", ago(24), "frizz:medium")
    .agent("aPrompt", "Prompt wording", "Audit the worker prompt for 'another agent' where an @address belongs.", ago(24), "frizz:low")
    .tool("hs1", "Grep", { pattern: "thread.title", path: `${frizzDir}/packages/web` }, "12 matches", ago(22))
    .call("hs2", "Read", { file_path: `${frizzDir}/packages/web/src/components/ChildOpRow.tsx` }, ago(1))
  handleSweep = register(t, { title: "Handle sweep", pinned: true, status: "Reading the rail's row component while three sub-agents sweep", statusAgo: 22 })
  ticking.push(handleSweep)
}

{ // The spinoff child, and the edge that ties it to its parent.
  const brief = "The terminal strip landed in `9b0c1d3`. Its rows use `ChildOpRow` in `packages/web/src/components/`. Tighten the gap between the owner glyph and the label: it measures 9px of ink where the rest of the rail reads 5px. Use `scripts/ink-gaps.mjs`."
  const instructions = "Polish the ops strip's spacing — the glyph-to-label gap looks loose."
  const spn = `spn_${hex("spinoff").slice(0, 16)}`
  terminalStrip
    .user(spinoffRequestMessage({ id: spn, instructions }), ago(15), { isMeta: true })
    .tool("sp1", "mcp__frizz__spawn_thread", { spinoff: spn, prompt: brief, model: "opus", effort: "medium" }, '{"slug":"ops-polish"}', ago(14))
    .say("Spun off.", ago(14))
  register(terminalStrip, { title: "Terminal strip", rest: 200 })
  const c = transcript(F, "ops-polish")
  c.user(spinoffChildPrompt({ parentSlug: "terminal-strip", parentTitle: "Terminal strip", parentHandle: "terminalStrip", instructions, brief }), ago(14))
    .tool("op1", "Read", { file_path: `${frizzDir}/packages/web/src/components/ChildOpRow.tsx` }, "export function ChildOpRow() { return null }", ago(12))
    .call("op2", "Bash", { command: "nub scripts/ink-gaps.mjs --selector='[data-op-row]'", description: "Measuring the strip's ink gaps" }, ago(1))
  const child = register(c, { title: "Ops polish", model: "opus", effort: "medium", status: "Measuring the glyph-to-label ink gap on each strip row", statusAgo: 10 })
  ticking.push(child)
  sql(`INSERT OR REPLACE INTO thread_spinoff (id, project_id, parent_slug, source_id, excerpt, instructions, child_slug, created_at, spawned_at)
       VALUES (${q(spn)}, ${q(F.id)}, 'terminal-strip', '', '', ${q(instructions)}, 'ops-polish', ${now - 15 * 60_000}, ${now - 14 * 60_000})`)
}

// ═══ SNOOZED ═════════════════════════════════════════════════════════════════════════════════════════

const releaseWindow = transcript(F, "release-window")
releaseWindow.user("Hold 0.14 until main is quiet, then cut it.", ago(90))
  .tool("rw1", "Bash", { command: "git log -5 --since=1.hour main --oneline", description: "Checking how busy main is" }, "7 commits in the last hour", ago(88))
register(releaseWindow, { title: "Release window", rest: 3 })

let changelogDraft = transcript(F, "changelog-draft")
changelogDraft.user("Draft the 0.14 changelog from git log.", ago(30))
  .tool("cd1", "Bash", { command: "git log v0.13.5..main --oneline | wc -l", description: "Counting commits since 0.13.5" }, "506", ago(28))
  .tool("cd2", "mcp__frizz__message_thread", { handle: "docsSweep", message: "Did the terminals section in ARCHITECTURE.md change today?", await_reply: true }, '{"sent":true}', ago(10))
  .say("Asked @docsSweep which heading the terminals section lives under; parked until it answers.", ago(9))
changelogDraft = register(changelogDraft, { title: "Changelog draft", rest: 9 })

{ // Snoozed until all sub-agents return.
  const t = transcript(F, "schema-audit")
  t.user("Check every SQLite migration against a real pre-cutover database.", ago(55))
    .agent("aMig1", "Session table", "Replay the session-table migrations on the fixture DB.", ago(54))
    .agent("aMig2", "Question table", "Replay the question-table migrations on the fixture DB.", ago(54))
    .agent("aMig3", "Watch table", "Replay the watch-table migrations on the fixture DB.", ago(54))
    .notify("aMig1", "completed", "Agent \"Session table\" completed", ago(20))
    .say(`**Session table** replays clean.\n\n${fence("awaiting", "agents: [aMig2, aMig3]\nfor: 2h\n---\nOne of three back.")}`, ago(19))
  liveChildren.splice(liveChildren.findIndex((f) => f.endsWith("agent-aMig1.jsonl")), 1)
  const r = register(t, { title: "Schema audit", rest: 19 })
  sql(`UPDATE session SET subagents_snoozed_at = ${q(ago(18))} WHERE project_id = ${q(F.id)} AND slug = ${q(r.slug)}`)
}

{ // Snoozed until tomorrow (5am rollover).
  const t = transcript(F, "bundle-trim")
  t.user("Trim the web bundle below 400kB.", ago(300))
    .tool("b1", "Bash", { command: "nub run build && du -h dist/assets/*.js", description: "Measuring the bundle" }, "462K dist/assets/index.js", ago(290))
    .say("**Not fixed** — 462kB; shiki's grammars are 70kB of it and can load lazily. Picking it up tomorrow.", ago(280))
  const tomorrow = new Date(now + 24 * 3600_000)
  tomorrow.setHours(5, 0, 0, 0)
  register(t, { title: "Bundle trim", rest: 280, snoozedUntil: tomorrow.toISOString() })
}

// ═══ DONE ════════════════════════════════════════════════════════════════════════════════════════════

for (const [slug, title, text] of [
  ["router-split", "Router split", "**Fixed** — `router.ts` is split by surface. Landed as `c2e11f0`.\n\n" + fence("done", "- **Split** the router into board, thread and terminal modules.")],
  ["icon-rhythm", "Icon rhythm", "**Fixed** — the rail's row icons sit on the cap band in sans. Landed as `8d77a41`.\n\n" + fence("done", "- **Measured and corrected** each glyph in `em`.")],
]) {
  const t = transcript(F, slug)
  t.user(`${title}.`, ago(900)).say(text, ago(880))
  register(t, { title, rest: 880, archived: true, live: false })
}

let changelogPass
{ // A Done row that is still working: it keeps its spinner.
  const t = transcript(F, "changelog-pass")
  t.user("Proofread CHANGELOG.md once more.", ago(600))
    .say(`**Fixed** — proofread.\n\n${fence("done", "- **Fixed** four typos in `CHANGELOG.md`.")}`, ago(580))
    .user("One more pass over the 0.14 section, please.", ago(3))
    .call("cp1", "Read", { file_path: `${frizzDir}/README.md` }, ago(2))
  changelogPass = register(t, { title: "Changelog pass", archived: true, status: "Proofreading the 0.14 section", statusAgo: 3 })
  ticking.push(changelogPass)
}

// ═══ OTHER PROJECTS — for All projects ═══════════════════════════════════════════════════════════════

const A = projects.arktype
const P = projects.pullfrog
{
  const t = transcript(A, "union-discrimination")
  t.user("Discriminate unions on nested keys, not just top-level ones.", ago(70))
    .tool("u1", "Read", { file_path: `${arktypeDir}/ark/type/scope.ts` }, "export {}", ago(65))
    .say("**Needs you** — nested discrimination works, but picking the discriminant is now ambiguous when two nested paths both discriminate.", ago(33))
  register(t, { title: "Union discrimination", rest: 33 })
  ask(A, t.slug, {
    question: "When two nested paths both discriminate a union, which one wins?", header: "Discriminant", kind: "question",
    options: [
      { label: "The shallowest path", description: "predictable; matches how people read the type", recommended: true },
      { label: "The path with the most branches", description: "fewest checks at runtime, less predictable" },
    ],
  }, 33)
}
{
  const t = transcript(A, "scope-exports")
  t.user("Export `scope` types from the root entrypoint.", ago(120))
    .say(`**Fixed** — \`scope\` types are exported from the root. Landed as \`a31f9e0\`.\n\n${fence("done", "- **Re-exported** `Scope` and `Module` from `ark/type/index.ts`.")}`, ago(64))
  register(t, { title: "Scope exports", rest: 64 })
}
{
  const t = transcript(A, "perf-regression")
  t.user("Instantiation got 20% slower in the last release. Find it.", ago(15))
    .call("pr1", "Bash", { command: "pnpm bench --filter instantiation", description: "Benchmarking instantiation" }, ago(1))
  ticking.push(register(t, { title: "Perf regression", status: "Bisecting instantiation time between 2.1.20 and 2.1.21", statusAgo: 9 }))
}
{
  const t = transcript(P, "webhook-retries")
  t.user("Retry failed Hookdeck deliveries with backoff.", ago(200))
    .say(`**Fixed** — failed deliveries retry at 1m, 5m and 30m. Landed as \`e02b7c1\`.\n\n${fence("done", "- **Added backoff** in `app/api/webhook/github/route.ts`.")}`, ago(47))
  register(t, { title: "Webhook retries", rest: 47 })
}
{
  const t = transcript(P, "billing-page")
  t.user("Show the plan's usage on the billing page.", ago(20))
    .call("bp1", "Read", { file_path: `${pullfrogDir}/README.md` }, ago(1))
  ticking.push(register(t, { title: "Billing page", status: "Wiring the Stripe usage records into the billing page", statusAgo: 12 }))
}

// ═══ RPC-made state — through the app's own surface ══════════════════════════════════════════════════

// Open every board, so the tenants' tailers read their threads (see seed-all-queues.mjs).
for (const p of Object.values(projects)) await p.api.query("board")
async function boardHas(p, slugs) {
  for (let i = 0; i < 80; i++) {
    const threads = (await p.api.query("board")).threads ?? []
    if (slugs.every((s) => threads.some((t) => t.id === s && t.runtime && t.runtime !== "none"))) return threads
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`the board never read ${slugs.join(", ")}`)
}
await boardHas(F, ["release-window", "changelog-draft", "nightly-bench", "release-publish", "folder-hint", "docs-sweep"])

// Two real timers, then the park that names them (armed BEFORE the rest, as a worker does).
const t1 = await F.api.mutate("setOwnThreadTimer", { slug: "release-window", prompt: "Re-check that main has been quiet for an hour", fireAt: new Date(now + 34 * 60_000).toISOString() })
const t2 = await F.api.mutate("setOwnThreadTimer", { slug: "release-window", prompt: "Cut 0.14 if the suite is still green", fireAt: new Date(now + 94 * 60_000).toISOString() })
releaseWindow.say(`Main is too busy to cut from.\n\n${fence("awaiting", `timers: [${t1.id}, ${t2.id}]\nfor: 2h\ntitle: Release window for 0.14\n---\nWaiting for \`main\` to go quiet before cutting 0.14.\n\n- the first timer re-checks the last hour of commits\n- the second cuts the release if the suite is still green`)}`, new Date().toISOString())
writeFileSync(join(F.logDir, `${releaseWindow.sessionId}.jsonl`), releaseWindow.rows.map((r) => JSON.stringify(r)).join("\n") + "\n")
sql(`UPDATE session SET rested_at = ${q(new Date().toISOString())} WHERE project_id = ${q(F.id)} AND slug = 'release-window'`)

// A thread waiting on another thread's reply: the real messageThread RPC arms the reply wait.
await F.api.mutate("messageThread", { slug: "changelog-draft", handle: "docsSweep", message: "Did the terminals section in ARCHITECTURE.md change today? I'm writing the 0.14 changelog and want to link the right heading.", awaitReply: true, for: "2h" })

// The Goal, with both limits, through the footer panel's own RPC; then two runs already spent.
await F.api.mutate("setThreadRecurringPrompt", { slug: "nightly-bench", sessionId: nightlyBench.sessionId, prompt: "Keep going until cold start is under 400ms.", stopHook: true, heartbeat: false, maxRuns: 5, forSeconds: 4 * 3600 })
sql(`UPDATE session SET recurring_runs = 2 WHERE project_id = ${q(F.id)} AND slug = 'nightly-bench'`)

// Your terminals, started through terminalStart so they run where the agent works: one at an OTP prompt
// (queues its thread with the live screen on the card), one finished in the worktree thread's strip.
// `./npm` is a stand-in the demo repo carries, so the row reads as the real command.
writeFileSync(join(frizzDir, "npm"), "#!/bin/sh\necho \"npm notice Staging frizz-server@0.14.2\"\nprintf 'Enter one-time password: '\nread otp\necho approved\n", { mode: 0o755 })
await F.api.mutate("terminalStart", { slug: "release-publish", command: "./npm stage approve frizz-server@0.14.2" })
await F.api.mutate("terminalStart", { slug: "folder-hint", command: "git status --short --branch; git log --oneline -3" })

// ── tick ─────────────────────────────────────────────────────────────────────────────────────────────
const GERUNDS = [
  ["Read", (dir) => ({ file_path: `${dir}/packages/web/src/components/ChildOpRow.tsx` })],
  ["Grep", (dir) => ({ pattern: "data-op-row", path: `${dir}/packages/web` })],
  ["Bash", () => ({ command: "nub --test packages/web/src/lib/subAgentWait.test.ts", description: "Running the sub-agent wait tests" })],
  ["Edit", (dir) => ({ file_path: `${dir}/packages/web/src/components/ChildOpRow.tsx`, old_string: "gap-2", new_string: "gap-1" })],
  ["Bash", () => ({ command: "nub scripts/ink-gaps.mjs", description: "Measuring the ink gaps" })],
  ["Bash", () => ({ command: "nub run typecheck", description: "Typechecking the workspace" })],
]
let tick = 0
setInterval(() => {
  tick++
  const ts = new Date().toISOString()
  for (const f of liveChildren) appendFileSync(f, JSON.stringify({ type: "assistant", timestamp: ts, isSidechain: true, message: { id: `k${tick}${f.length}`, role: "assistant", stop_reason: "tool_use", content: [{ type: "text", text: `Still checking (${tick}).` }] } }) + "\n")
  // Each working thread finishes its pending call and starts the next — so the board keeps moving.
  for (const t of ticking) {
    const pending = [...t.rows].reverse().find((r) => r.type === "assistant")?.message?.content?.[0]
    if (pending?.type !== "tool_use") continue
    const [name, input] = GERUNDS[(tick + t.slug.length) % GERUNDS.length]
    t.result(pending.id, "ok", ts).call(`tk${tick}${t.slug}`, name, input(t.cwd), ts)
    appendFileSync(t.file, t.rows.slice(-2).map((r) => JSON.stringify(r)).join("\n") + "\n")
  }
}, 20_000)

console.log(`\nFrizz standup demo is up:\n\n  ${origin}/all/frizz    (focused on one project; the title menu opens All projects)\n\nDemo repos: ${root}\nStack log:  ${stackLog}\nCtrl-C tears it all down.\n`)
console.log(JSON.stringify({ url: `${origin}/all/frizz`, home, root, stackPid: stackProc.pid, daemonPid: daemon.pid }))
