// A SPINOFF INTO ANOTHER PROJECT (2026-09-30) — the real router and real SQLite, two projects in ONE
// database the way the singleton serves them, with only the session broker and the dispatchers stubbed.
//
// The request is filed under the PARENT's project and names the child's; the parent's worker dispatches
// through its own project's `spawn_thread` as always, and the router sends that dispatch to the chosen
// project. Each end of the edge then shows on its own project's board, and nowhere else.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spinoffRequestMessage, type BoardSnapshot, type DispatchInput, type Settings } from "@frizz/shared"
import type { BoardManager } from "./board.ts"
import { Emitter } from "./bus.ts"
import { createClaudeBackend } from "./backend/claude.ts"
import { createRouter } from "./router.ts"
import Database from "./sqlite.ts"
import { createStorage, type SessionRow, type Storage } from "./storage.ts"
import type { AppContext } from "./context.ts"
import type { Project } from "./project.ts"
import type { Tailer } from "./tailer.ts"

const sessionRow = (slug: string): SessionRow => ({
  slug, session_id: `sid-${slug}`, thread_name: `frizz-${slug}`, spawned_at: "2026-09-30T08:00:00.000Z", last_read_at: null,
  unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: slug, state: "open", meta: null, seen_at: null,
  transcript_id: null,
})

function tenant(root: string, db: Database, id: string) {
  const dir = join(root, id)
  const project: Project = { dir, id, name: id, label: id, stateDir: dir, cwdSlug: id }
  const storage = createStorage(db, id)
  const snapshot: BoardSnapshot = { projectDir: dir, projectName: id, projectLabel: id, threads: [], errors: [], warnings: [] }
  let refreshes = 0
  const board: BoardManager = {
    snapshot: async () => snapshot, currentSeq: () => 0, rebuild: async () => snapshot,
    refresh: () => (refreshes++, snapshot), start: async () => {}, stop: async () => {},
  }
  const tailer: Tailer = {
    get: () => ({ turn: "idle", subAgents: [], bgShells: [], permPrompt: false, pendingQuestion: false }),
    foreignIds: () => [], subAgent: () => undefined, forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
  }
  const dispatched: DispatchInput[] = []
  const backend = createClaudeBackend({ logDir: join(dir, "logs") })
  const sent: string[] = []
  const ctx = {
    project, storage, board, tailer,
    transcriptChange: new Emitter<string[]>(),
    backendFor: () => backend,
    getSettings: () => ({ permissionMode: "auto" }) as unknown as Settings,
    claudeBroker: { followUp: async (input: { text: string }) => void sent.push(input.text) },
    dispatcher: {
      dispatch: async (input: DispatchInput) => {
        dispatched.push(input)
        const slug = `child-in-${id}`
        storage.upsertSession(sessionRow(slug))
        return { slug, sessionId: `sid-${slug}` }
      },
    },
  } as unknown as AppContext
  return { ctx, storage, dispatched, sent, refreshes: () => refreshes }
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), "frizz-spinoff-cross-"))
  const db = new Database(join(root, "frizz.db"))
  const alpha = tenant(root, db, "alpha")
  const beta = tenant(root, db, "beta")
  const open = [alpha, beta].map((t) => ({ project: t.ctx.project, board: t.ctx.board, ctx: t.ctx }))
  for (const t of [alpha, beta]) (t.ctx as { activeTenants?: AppContext["activeTenants"] }).activeTenants = () => open
  alpha.storage.upsertSession(sessionRow("parent"))
  alpha.storage.setBackend("parent", "claude")
  alpha.storage.setClaudeRuntime("parent", "broker")
  return {
    alpha, beta, router: createRouter(alpha.ctx),
    close: () => { alpha.storage.close(); beta.storage.close(); db.close(); rmSync(root, { recursive: true, force: true }) },
  }
}

const brief = { prompt: "the context", model: "opus", effort: "high" } as const

test("a spinoff into another project dispatches there, and each end shows on its own project's board", async () => {
  const h = harness()
  try {
    const { id } = await h.router.spinoff.handler({ input: { slug: "parent", sessionId: "sid-parent", instructions: "port it to beta", project: "beta" } })
    assert.deepEqual(h.alpha.sent, [spinoffRequestMessage({ id, instructions: "port it to beta", project: { name: "beta", dir: h.beta.ctx.project.dir } })])
    assert.match(h.alpha.sent[0]!, /starts in the beta project/, "the parent's worker is told where the thread starts")
    assert.equal(h.alpha.storage.getSpinoff(id)?.child_project_id, "beta")
    assert.deepEqual(h.alpha.storage.pendingSpinoffs(), [], "the edge recovery, which looks its child up here, never sees it")

    const result = await h.router.dispatch.handler({ input: { ...brief, spinoff: id, spinoffFrom: "parent" } as DispatchInput })
    assert.equal(result.slug, "child-in-beta")
    assert.equal(h.alpha.dispatched.length, 0, "nothing starts in the parent's project")
    assert.equal(h.beta.dispatched.length, 1)
    assert.match(h.beta.dispatched[0]!.prompt, /^A spinoff of @parent[\s\S]*> port it to beta[\s\S]*the context$/)
    assert.ok(h.beta.refreshes() > 0, "the child's board learns of its edge")

    // Each end on its own board — and the child's slug never among the parent project's threads.
    assert.deepEqual([...h.alpha.storage.spinoffsBySlug().keys()], ["parent"])
    assert.deepEqual([...h.beta.storage.spinoffsBySlug().keys()], ["child-in-beta"])
    assert.equal(h.beta.storage.spinoffOfChild("child-in-beta")?.id, id, "the child's opening turn finds its request")
    assert.equal(h.alpha.storage.spinoffOfChild("child-in-beta"), undefined)

    // Forgetting the child in ITS project drops the edge, as a same-project forget does.
    h.beta.storage.forgetSession("child-in-beta")
    assert.equal(h.alpha.storage.getSpinoff(id), undefined)
  } finally {
    h.close()
  }
})

test("a spinoff that names this project, or none, starts here; one naming a project that is not open is refused", async () => {
  const h = harness()
  try {
    const here = await h.router.spinoff.handler({ input: { slug: "parent", sessionId: "sid-parent", instructions: "here", project: "alpha" } })
    assert.equal(h.alpha.storage.getSpinoff(here.id)?.child_project_id, null, "its own project is written as no project")
    await h.router.dispatch.handler({ input: { ...brief, spinoff: here.id, spinoffFrom: "parent" } as DispatchInput })
    assert.equal(h.alpha.dispatched.length, 1)
    assert.equal(h.beta.dispatched.length, 0)

    await assert.rejects(
      h.router.spinoff.handler({ input: { slug: "parent", sessionId: "sid-parent", instructions: "nowhere", project: "gamma" } }),
      /not open in Frizz/,
    )
    assert.equal(h.alpha.storage.spinoffsBySlug().get("parent")?.length, 1, "a refused request leaves no row")
  } finally {
    h.close()
  }
})

test("storage: a cross-project edge's child end is found only in the child's project", () => {
  const root = mkdtempSync(join(tmpdir(), "frizz-spinoff-cross-storage-"))
  const db = new Database(join(root, "frizz.db"))
  const a: Storage = createStorage(db, "a")
  const b: Storage = createStorage(db, "b")
  try {
    // The same slug in both projects: only the project the child was started in may claim the edge.
    for (const s of [a, b]) s.upsertSession(sessionRow("same"))
    a.insertSpinoff({ id: "spn_00000000000000a1", parentSlug: "p", instructions: "x", createdAtMs: 1, childProjectId: "b" })
    assert.ok(a.completeSpinoff("spn_00000000000000a1", "same", 2))
    assert.equal(a.spinoffOfChild("same"), undefined)
    assert.equal(b.spinoffOfChild("same")?.project_id, "a")
    assert.deepEqual(a.spinoffsBySlug().get("same"), undefined)
    assert.equal(b.spinoffsBySlug().get("same")?.length, 1)
    // A forget of the same slug in the PARENT's project leaves the other project's child edge alone.
    a.forgetSession("same")
    assert.equal(b.spinoffOfChild("same")?.id, "spn_00000000000000a1")
  } finally {
    a.close(); b.close(); db.close(); rmSync(root, { recursive: true, force: true })
  }
})
