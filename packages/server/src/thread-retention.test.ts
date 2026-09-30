// DELETING THREADS at the RPC boundary — the real router against real SQLite and a real project folder.
//
// What a delete has to buy is the reason it exists: the slug is free again (the next "Shell budgets"
// is `shell-budgets`, not `shell-budgets-2`), the `@handle` no longer resolves, and nothing Frizz keeps
// for the thread survives it. The bulk and automatic doors must take exactly the done threads the
// predicate names, and nothing open, recent or pinned.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BoardSnapshot, Settings } from "@frizz/shared"
import type { BoardManager } from "./board.ts"
import type { AppContext } from "./context.ts"
import { resolveSlug } from "./dispatch.ts"
import type { Project } from "./project.ts"
import { createRouter, deleteExpiredDoneThreads } from "./router.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import type { Tailer } from "./tailer.ts"
import { resolveThreadHandle } from "./thread-mentions.ts"
import { projectThreadNames } from "./thread-names.ts"
import { DAY_MS, expiredDoneThreads } from "./thread-retention.ts"

const NOW = Date.parse("2026-09-30T12:00:00.000Z")
const daysAgo = (days: number) => new Date(NOW - days * DAY_MS).toISOString()

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "frizz-thread-delete-"))
  const project: Project = { dir, id: "del", name: "test", label: "test", stateDir: dir, cwdSlug: "test" }
  const storage = createStorage(join(dir, "ui.db"), "p")
  const snapshot: BoardSnapshot = { projectDir: dir, projectName: "test", projectLabel: "test", threads: [], errors: [], warnings: [] }
  let refreshes = 0
  const board: BoardManager = {
    snapshot: async () => snapshot,
    currentSeq: () => 0,
    rebuild: async () => snapshot,
    refresh: () => { refreshes++; return snapshot },
    start: async () => {},
    stop: async () => {},
  }
  const tailerForgot: string[] = []
  const tailer: Tailer = {
    get: () => undefined, foreignIds: () => [], subAgent: () => undefined,
    forget: (slug: string) => { tailerForgot.push(slug) }, start: () => {}, stop: () => {}, tick: () => {},
  }
  const terminalsForgot: string[] = []
  const ctx = {
    project, storage, board, tailer,
    terminalRunner: { live: () => [], stopThread: async () => {}, closeThread: async () => {}, forgetThread: async (slug: string) => { terminalsForgot.push(slug) } },
    // Worktree cleanup is off here: it is its own feature, with its own tests.
    getSettings: () => ({ removeWorktreesOnDone: false }) as unknown as Settings,
  } as unknown as AppContext
  return {
    dir, storage, ctx, tailerForgot, terminalsForgot,
    router: createRouter(ctx),
    refreshes: () => refreshes,
    close: () => { storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

function row(slug: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug, session_id: `sid-${slug}`, thread_name: `frizz-${slug}`, spawned_at: daysAgo(60),
    last_read_at: null, unread: 0, exited: 1, archived: 0, rested_at: null, title_auto: 0,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null, ...over,
  }
}
const done = (slug: string, over: Partial<SessionRow> = {}) => row(slug, { state: "archived", archived: 1, ...over })

/** The upsert writes a dispatch's columns only; rest time and state have writers of their own. */
function seed(storage: ReturnType<typeof createStorage>, slug: string, opts: { done?: boolean; restedAt?: string; title?: string } = {}) {
  storage.upsertSession(row(slug, opts.title ? { title: opts.title, title_locked: 1 } : {}))
  if (opts.restedAt) storage.setRestedAt(slug, opts.restedAt)
  if (opts.done) storage.setState(slug, "archived")
}

test("deleting a thread frees its slug and its @handle, and removes everything Frizz kept for it", async () => {
  const h = harness()
  try {
    seed(h.storage, "shell-budgets", { done: true, title: "Shell budgets" })
    h.storage.markThreadDone("shell-budgets", "- shipped", NOW)
    const scratch = join(h.dir, ".frizz", "threads", "sid-shell-budgets")
    mkdirSync(scratch, { recursive: true })
    writeFileSync(join(scratch, "notes.md"), "notes")
    const frizzDir = join(h.dir, ".frizz")
    const taken = (s: string) => h.storage.getSession(s) !== undefined
    // The control: while it exists, the next thread of that name is pushed to -2 and the handle finds it.
    assert.equal(resolveSlug(frizzDir, "shell-budgets", taken), "shell-budgets-2")
    assert.equal(resolveThreadHandle("@shell-budgets", projectThreadNames(h.storage.allSessions()))?.slug, "shell-budgets")

    await h.router.deleteThread.handler({ input: { slug: "shell-budgets" } })

    assert.equal(h.storage.getSession("shell-budgets"), undefined)
    assert.equal(h.storage.getThreadDone("shell-budgets"), undefined)
    assert.equal(resolveSlug(frizzDir, "shell-budgets", taken), "shell-budgets")
    assert.equal(resolveThreadHandle("@shell-budgets", projectThreadNames(h.storage.allSessions())), undefined)
    assert.equal(existsSync(scratch), false, "the scratch directory goes with the thread")
    assert.ok(h.storage.forgottenIds().has("sid-shell-budgets"), "its transcript is tombstoned so discovery cannot bring it back")
    assert.deepEqual(h.tailerForgot, ["shell-budgets"])
    assert.deepEqual(h.terminalsForgot, ["shell-budgets"])
    assert.equal(h.refreshes(), 1)

    // Idempotent: a second delete is a no-op, not an error, and rebuilds nothing.
    await h.router.deleteThread.handler({ input: { slug: "shell-budgets" } })
    assert.equal(h.refreshes(), 1)
  } finally { h.close() }
})

test("an open thread can be deleted too — the old exited-only gate is gone", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("in-flight", { exited: 0 }))
    await h.router.deleteThread.handler({ input: { slug: "in-flight" } })
    assert.equal(h.storage.getSession("in-flight"), undefined)
  } finally { h.close() }
})

test("only done, unpinned threads idle past the cutoff expire", () => {
  const rows = [
    done("old-done", { rested_at: daysAgo(40) }),
    done("old-done-never-rested", { spawned_at: daysAgo(40) }),
    done("recent-done", { rested_at: daysAgo(2) }),
    done("old-pinned", { rested_at: daysAgo(40), pinned_at: daysAgo(40) }),
    row("old-open", { rested_at: daysAgo(40) }),
  ]
  assert.deepEqual(expiredDoneThreads(rows, 30, NOW).map((r) => r.slug), ["old-done", "old-done-never-rested"])
  assert.deepEqual(expiredDoneThreads(rows, 0, NOW), [], "0 days is never")
})

test("deleteDoneThreads counts on a dry run, then deletes exactly that set", async () => {
  const h = harness()
  try {
    // spawned_at is 60 days back for every row, so the rest time decides.
    const ago = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString()
    seed(h.storage, "old-done", { done: true, restedAt: ago(40) })
    seed(h.storage, "recent-done", { done: true, restedAt: ago(1) })
    seed(h.storage, "old-open", { restedAt: ago(40) })

    assert.deepEqual(await h.router.deleteDoneThreads.handler({ input: { olderThanDays: 30, dryRun: true } }), { count: 1 })
    assert.equal(h.storage.allSessions().length, 3, "a dry run deletes nothing")
    assert.equal(h.refreshes(), 0)

    assert.deepEqual(await h.router.deleteDoneThreads.handler({ input: { olderThanDays: 30 } }), { count: 1 })
    assert.deepEqual(h.storage.allSessions().map((r) => r.slug).sort(), ["old-open", "recent-done"])
    assert.equal(h.refreshes(), 1, "one rebuild for the whole batch")
  } finally { h.close() }
})

test("the retention sweep's delete takes the same set, and does nothing at 0", async () => {
  const h = harness()
  try {
    seed(h.storage, "old-done", { done: true, restedAt: daysAgo(10) })
    assert.equal(await deleteExpiredDoneThreads(h.ctx, 0, NOW), 0)
    assert.equal(await deleteExpiredDoneThreads(h.ctx, 30, NOW), 0)
    assert.equal(await deleteExpiredDoneThreads(h.ctx, 7, NOW), 1)
    assert.equal(h.storage.getSession("old-done"), undefined)
  } finally { h.close() }
})
