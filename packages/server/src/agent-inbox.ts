import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { randomUUID } from "node:crypto"

// ── A MAILBOX FOR WORKFLOW AGENTS ────────────────────────────────────────────────────────────────────
//
// Claude Code gives a parent no way to reach an agent running inside a `Workflow`. `SendMessage` looks
// its target up in the session's task table, and a Workflow's agents are run by the workflow and never
// entered there — so the lookup reads the agent as evicted and RESUMES A SECOND COPY from its transcript
// beside the live one (read off the 2.1.287 bundle; seen live 2026-09-29, two writers in one worktree).
// Frizz's own drawer steer cannot reach one either: it rides an input frame the CLI only routes to
// tool_use ids its main thread issued.
//
// Hooks DO reach them. Measured on 2.1.287 (2026-10-06): a PostToolUse hook fires for every tool call
// a Workflow agent makes, its input carries `agent_id` and `agent_type: "workflow-subagent"`, and its
// `additionalContext` reached the agent's model; a SubagentStop hook fires as the agent finishes, and
// `decision: "block"` kept it going with the reason as its next input. So a message is a FILE: whoever
// sends writes it into the agent's mailbox, and the worker plugin's `agent-inbox.mjs` hook hands it to
// the agent after its next tool call, or as it tries to finish.
//
// THE FORMAT IS A CONTRACT WITH `cc-worker/hooks/agent-inbox.mjs`, which reads it and also writes it
// (when it diverts a `SendMessage`). The hook is plain JS because it runs under bare `node` down to the
// engines floor, so the format is two short implementations pinned by one test
// (`agent-inbox-hook.test.ts`), not a shared module:
//
//   <session-dir>/frizz-inbox/<agentId>/<ms>-<hrtime>-<uuid>.json   {"from": "...", "text": "...", "at": <ms>}
//
// Names sort oldest first. The monotonic clock breaks a tie between two messages one sender posted in
// the same millisecond; between two processes in one millisecond the order is arbitrary, and nothing
// a sender could mean depends on it.
//
// One file per message, written to a temp name and renamed in, so a reader never sees half of one. The
// reader claims each file by renaming it, so two hooks firing at once for parallel tool calls cannot
// both deliver it. The session dir is the one Claude Code keeps beside the session transcript
// (`<transcript without .jsonl>/`), which both sides can find without knowing anything of Frizz's.

export const INBOX_DIRNAME = "frizz-inbox"

export type InboxSender = "parent" | "operator"

/** A Workflow run's agents live in `<session-dir>/subagents/workflows/<run>` (workflow-runs.ts). */
export function workflowSessionDir(runDir: string): string {
  return resolve(runDir, "..", "..", "..")
}

const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/

/** Queue one message for a Workflow agent. Throws on a malformed id rather than write outside the box. */
export function postToAgentInbox(sessionDir: string, agentId: string, message: { from: InboxSender; text: string }): void {
  if (!AGENT_ID.test(agentId)) throw new Error(`not an agent id: ${JSON.stringify(agentId)}`)
  const dir = join(sessionDir, INBOX_DIRNAME, agentId)
  mkdirSync(dir, { recursive: true })
  const at = Date.now()
  const name = `${String(at).padStart(15, "0")}-${String(process.hrtime.bigint()).padStart(20, "0")}-${randomUUID()}`
  const tmp = join(dir, `.${name}.tmp`)
  writeFileSync(tmp, JSON.stringify({ from: message.from, text: message.text, at }))
  renameSync(tmp, join(dir, `${name}.json`))
}
