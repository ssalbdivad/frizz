// WHICH ROUTE A SPINOFF TAKES (router.ts forkSource / forkSpinoff) — the real router and the real
// dispatcher against real SQLite, with only the provider bridges stubbed.
//
// A Claude broker thread with a transcript is FORKED: the dispatcher starts the child as a fork of the
// parent's session under a minted anchor, the edge is complete at birth, and the parent receives nothing
// at all. Everything else — a Codex or ACP parent, a cross-project target, a Claude parent with nothing
// on disk to fork yet — takes the brief route exactly as before: the request is delivered to the parent's
// own worker and the row waits for its spawn_thread.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

const HOME = mkdtempSync(join(tmpdir(), "frizz-fork-router-home-"))
process.env.HOME = HOME
process.on("exit", () => rmSync(HOME, { recursive: true, force: true }))

import { parseSpinoffChildPrompt, spinoffForkPrompt, spinoffRequestMessage, type BoardSnapshot } from "@frizz/shared"
import type { BoardManager } from "./board.ts"
import { Emitter } from "./bus.ts"
import { createClaudeBackend } from "./backend/claude.ts"
import { createRouter } from "./router.ts"
import { createDispatcher } from "./dispatch.ts"
import { defaultSettings } from "./settings.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import type { AppContext } from "./context.ts"
import type { Project } from "./project.ts"
import type { Tailer } from "./tailer.ts"
import type { ClaudeAgentBrokerBridge, ClaudeSpawnDispatchInput } from "./backend/claude-agent-broker-bridge.ts"

const slug = "parent"
const sessionId = "11111111-1111-4111-8111-111111111111"

function harness(opts: { backend?: "claude" | "codex"; transcript?: boolean; failSpawn?: boolean; otherProject?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "frizz-fork-router-"))
  const cwdSlug = `fork-router-${Math.random().toString(16).slice(2)}`
  const project: Project = { dir, id: "fork-router", name: "test", label: "test", stateDir: dir, cwdSlug }
  const logDir = join(homedir(), ".claude", "projects", cwdSlug)
  mkdirSync(logDir, { recursive: true })
  const storage = createStorage(join(dir, "ui.db"), "p")
  const snapshot: BoardSnapshot = { projectDir: dir, projectName: "test", projectLabel: "test", threads: [], errors: [], warnings: [] }
  const board: BoardManager = {
    snapshot: async () => snapshot, currentSeq: () => 0, rebuild: async () => snapshot, refresh: () => snapshot,
    start: async () => {}, stop: async () => {},
  }
  const tailer: Tailer = {
    get: () => ({ turn: "idle", subAgents: [], bgShells: [], permPrompt: false, pendingQuestion: false }),
    foreignIds: () => [], subAgent: () => undefined, forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
  }
  const backend = createClaudeBackend({ logDir })
  const sent: string[] = []
  const spawned: ClaudeSpawnDispatchInput[] = []
  const claudeBroker = {
    followUp: async (input: { text: string }) => void sent.push(input.text),
    spawnDispatch: async (input: ClaudeSpawnDispatchInput) => {
      if (opts.failSpawn) throw new Error("the daemon did not start")
      spawned.push(input)
      return { binding: { threadSlug: input.threadSlug, sessionId: input.sessionId, cwd: input.cwd, generation: "g", state: "active" } }
    },
    releaseSession: () => {},
  } as unknown as ClaudeAgentBrokerBridge
  const codexAppServer = {
    binding: () => ({ state: "active", currentTurnId: null }),
    turnLiveness: () => undefined,
    followUp: async (input: { text: string }) => void sent.push(input.text),
  }
  const dispatcher = createDispatcher({ project, storage, board, getSettings: () => ({ ...defaultSettings(), model: "sonnet", effort: "low" }), claudeBroker })
  const transcriptChange = new Emitter<string[]>()
  const changed: string[][] = []
  transcriptChange.on((slugs) => void changed.push(slugs))
  const other = { project: { id: "elsewhere", name: "Elsewhere", dir: join(dir, "other") }, ctx: { project: { id: "elsewhere", name: "Elsewhere", dir: join(dir, "other") }, board } }
  const ctx = {
    project, storage, board, tailer, dispatcher, transcriptChange, claudeBroker, codexAppServer,
    backendFor: () => backend,
    getSettings: () => ({ permissionMode: "auto" }),
    ...(opts.otherProject ? { activeTenants: () => [other] } : {}),
  } as unknown as AppContext
  const row: SessionRow = {
    slug, session_id: sessionId, thread_name: `frizz-${slug}`, spawned_at: "2026-09-30T08:00:00.000Z", last_read_at: "2026-09-30T09:00:00.000Z",
    unread: 0, exited: 0, archived: 0, rested_at: "2026-09-30T09:00:00.000Z", title_auto: 0, title: "Cache fix", state: "open", meta: null, seen_at: null,
    transcript_id: null, model: "opus[1m]", effort: "high",
  }
  storage.upsertSession(row)
  storage.setBackend(slug, opts.backend ?? "claude")
  if ((opts.backend ?? "claude") === "claude") storage.setClaudeRuntime(slug, "broker")
  else storage.setCodexRuntime(slug, "app-server")
  if (opts.transcript !== false) {
    writeFileSync(join(logDir, `${sessionId}.jsonl`), JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-09-30T08:00:01.000Z", message: { role: "user", content: "fix the cache" } }) + "\n")
  }
  return {
    storage, sent, spawned, changed, router: createRouter(ctx),
    close: () => { storage.close(); rmSync(dir, { recursive: true, force: true }); rmSync(logDir, { recursive: true, force: true }) },
  }
}

test("a Claude parent is forked: the child starts from its session, the edge is complete, and the parent hears nothing", async () => {
  const h = harness()
  try {
    const before = h.storage.getSession(slug)!
    const { id } = await h.router.spinoff.handler({ input: { slug, sessionId, instructions: "load test the fix" } })
    assert.deepEqual(h.sent, [], "no request reaches the parent's worker")
    assert.equal(h.spawned.length, 1)
    const spawn = h.spawned[0]!
    assert.equal(spawn.forkFrom, sessionId, "forked from the parent's session")
    assert.match(spawn.inputId ?? "", /^[0-9a-f-]{36}$/, "the opening prompt is sent under a minted anchor")
    assert.equal(spawn.model, "opus[1m]", "the parent's model: the prompt cache is per model")
    assert.equal(spawn.effort, "high")
    // The parent by the handle the board shows for "Cache fix" (the router's own name registry).
    assert.ok(spawn.prompt.includes(spinoffForkPrompt({ parentSlug: slug, parentTitle: "Cache fix", parentHandle: "cache-fix", instructions: "load test the fix" })), "the fork prompt, below Frizz's envelope")
    assert.deepEqual(parseSpinoffChildPrompt(spawn.prompt.slice(spawn.prompt.indexOf("A spinoff of"))), { instructions: "load test the fix", brief: "" })

    const edge = h.storage.getSpinoff(id)!
    assert.equal(edge.forked, 1)
    assert.equal(edge.parent_slug, slug)
    assert.ok(edge.child_slug, "complete at birth")
    const child = h.storage.getSession(edge.child_slug!)!
    assert.equal(child.session_id, spawn.sessionId)
    assert.equal(child.fork_anchor, spawn.inputId, "the row carries the anchor its readers start at")
    assert.equal(h.storage.pendingSpinoffs().length, 0, "never pending, so nothing reads the parent for it")

    const after = h.storage.getSession(slug)!
    for (const k of ["state", "rested_at", "unread", "last_read_at", "snoozed_until", "delivery_ledger", "session_id"] as const) {
      assert.equal(after[k] ?? null, before[k] ?? null, `the parent's ${k} is untouched`)
    }
    assert.deepEqual(h.changed, [[slug]], "the parent's chat is re-pushed so its card appears")
  } finally {
    h.close()
  }
})

test("a fork that fails to start leaves no edge behind and says so", async () => {
  const h = harness({ failSpawn: true })
  try {
    await assert.rejects(h.router.spinoff.handler({ input: { slug, sessionId, instructions: "x" } }), /could not start this thread/)
    assert.equal(h.storage.spinoffsBySlug().get(slug), undefined)
    assert.deepEqual(h.sent, [])
  } finally {
    h.close()
  }
})

test("a Codex parent takes the brief route, unchanged", async () => {
  const h = harness({ backend: "codex" })
  try {
    const { id } = await h.router.spinoff.handler({ input: { slug, sessionId, instructions: "load test the fix" } })
    assert.deepEqual(h.sent, [spinoffRequestMessage({ id, instructions: "load test the fix" })], "the request goes to the parent's worker")
    assert.equal(h.spawned.length, 0, "nothing is forked")
    assert.equal(h.storage.getSpinoff(id)?.forked, 0)
    assert.equal(h.storage.getSpinoff(id)?.child_slug, null, "pending until its spawn_thread")
  } finally {
    h.close()
  }
})

test("a Claude parent with no transcript yet, or a cross-project target, takes the brief route", async () => {
  const bare = harness({ transcript: false })
  try {
    const { id } = await bare.router.spinoff.handler({ input: { slug, sessionId, instructions: "x" } })
    assert.deepEqual(bare.sent, [spinoffRequestMessage({ id, instructions: "x" })])
    assert.equal(bare.spawned.length, 0)
  } finally {
    bare.close()
  }
  const cross = harness({ otherProject: true })
  try {
    const { id } = await cross.router.spinoff.handler({ input: { slug, sessionId, instructions: "x", project: "elsewhere" } })
    assert.equal(cross.spawned.length, 0, "nothing is forked into another checkout")
    assert.equal(cross.sent.length, 1)
    assert.match(cross.sent[0]!, new RegExp(`<spinoff-request id="${id}">`))
    assert.match(cross.sent[0]!, /starts in the Elsewhere project/)
  } finally {
    cross.close()
  }
})
