// ONE THREAD READING OR MESSAGING ANOTHER BY HANDLE — the resolver, and both RPCs against the real
// router over real SQLite. Delivery itself (the wake outbox → the recipient's runtime) is pinned in
// scheduler.test.ts, "thread message: …".
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BoardSnapshot, Settings } from "@frizz/shared"
import type { BoardManager } from "./board.ts"
import { createRouter } from "./router.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import type { AppContext } from "./context.ts"
import type { Project } from "./project.ts"
import type { Tailer } from "./tailer.ts"
import { createWakeDeliveryStore } from "./wake-store.ts"
import { knownHandles, resolveThreadHandle, THREAD_MESSAGE_HOURLY_CAP } from "./thread-mentions.ts"
import type { NamedThread } from "./thread-names.ts"

const named = (slug: string, name: string, open = true, at = 0): NamedThread => ({ slug, name, open, at })

test("a handle resolves in any spelling, including one whose last word is short", () => {
  const threads = [named("a", "Shell budgets"), named("b", "Dev ops"), named("c", "ArkType perf")]
  for (const h of ["shellBudgets", "@shellBudgets", "@shellbudgets", "shell-budgets", "ShellBudget"]) {
    assert.equal(resolveThreadHandle(h, threads)?.slug, "a", h)
  }
  // "Dev ops" folds as two words and `devOps` as one — folding both from the handle keeps them equal.
  assert.equal(resolveThreadHandle("@devOps", threads)?.slug, "b")
  assert.equal(resolveThreadHandle("arkTypePerf", threads)?.slug, "c")
  assert.equal(resolveThreadHandle("c", threads)?.slug, "c", "a raw slug resolves too")
  assert.equal(resolveThreadHandle("@nothing", threads), undefined)
})

test("an open thread outranks a finished one carrying the same name", () => {
  const threads = [named("old", "Focus mode", false, 5), named("new", "Focus mode", true, 1)]
  assert.equal(resolveThreadHandle("focusMode", threads)?.slug, "new")
  assert.deepEqual(knownHandles(threads), ["@focusMode", "@focusMode (done)"])
})

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "frizz-mentions-rpc-"))
  const project: Project = { dir, id: "m", name: "test", label: "test", stateDir: dir, cwdSlug: "test" }
  const storage = createStorage(join(dir, "ui.db"), "p")
  const snapshot: BoardSnapshot = { projectDir: dir, projectName: "test", projectLabel: "test", threads: [], errors: [], warnings: [] }
  const board: BoardManager = {
    snapshot: async () => snapshot, currentSeq: () => 0, rebuild: async () => snapshot,
    refresh: () => snapshot, start: async () => {}, stop: async () => {},
  }
  const tailer: Tailer = {
    get: () => undefined, foreignIds: () => [], subAgent: () => undefined,
    forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
  }
  let kicks = 0
  const ctx = {
    project, storage, board, tailer,
    scheduler: { kick: () => { kicks++ } },
    getSettings: () => ({ permissionMode: "auto" }) as unknown as Settings,
  } as unknown as AppContext
  return {
    storage, router: createRouter(ctx), kicks: () => kicks,
    close: () => { storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

function row(slug: string, title: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug, session_id: `sid-${slug}`, thread_name: `frizz-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0,
    title, state: "open", meta: null, seen_at: null, transcript_id: null, ...over,
  }
}

test("readThread answers by handle, and a miss lists the handles that exist", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("me", "Mentions"))
    h.storage.upsertSession(row("sb", "Shell budgets"))
    h.storage.setStatus("sb", "sid-sb", "Moving the cap into one module")
    const hit = await h.router.readThread.handler({ input: { slug: "me", handle: "@shellBudgets" } })
    assert.equal(hit.found, true)
    assert.equal(hit.handle, "shellBudgets")
    assert.equal(hit.slug, "sb")
    assert.equal(hit.status, "Moving the cap into one module")
    const miss = await h.router.readThread.handler({ input: { slug: "me", handle: "@shelBudget" } })
    assert.equal(miss.found, false)
    assert.deepEqual(miss.known, ["@shellBudgets"], "the caller is not offered to itself")
  } finally { h.close() }
})

test("messageThread queues a signed message for the other thread, and refuses self, done and a loop", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("me", "Mentions"))
    h.storage.upsertSession(row("sb", "Shell budgets"))
    h.storage.upsertSession(row("fm", "Focus mode", { state: "archived", archived: 1 }))
    const sent = await h.router.messageThread.handler({ input: { slug: "me", handle: "shellBudgets", message: "Which file owns the cap?" } })
    assert.deepEqual(sent, { sent: true, handle: "shellBudgets", from: "mentions" })
    assert.equal(h.kicks(), 1, "the scheduler is kicked so it goes out now, not on the next poll")
    const queued = createWakeDeliveryStore(h.storage.scope).list()
    assert.equal(queued.length, 1)
    assert.equal(queued[0]!.slug, "sb")
    assert.match(queued[0]!.fenceId, /^thread-message:/)
    assert.match(queued[0]!.message, /^Message from @mentions, another Frizz thread/)
    assert.match(queued[0]!.message, /Which file owns the cap\?/)

    const self = await h.router.messageThread.handler({ input: { slug: "me", handle: "@mentions", message: "hi" } })
    assert.equal(self.sent, false)
    const done = await h.router.messageThread.handler({ input: { slug: "me", handle: "focusMode", message: "hi" } })
    assert.equal(done.sent, false)
    assert.match(done.refusal ?? "", /is done/)

    for (let i = 1; i < THREAD_MESSAGE_HOURLY_CAP; i++) {
      assert.equal((await h.router.messageThread.handler({ input: { slug: "me", handle: "sb", message: `m${i}` } })).sent, true)
    }
    const capped = await h.router.messageThread.handler({ input: { slug: "me", handle: "sb", message: "one more" } })
    assert.equal(capped.sent, false)
    assert.match(capped.refusal ?? "", /cap/)
    assert.equal(createWakeDeliveryStore(h.storage.scope).list().length, THREAD_MESSAGE_HOURLY_CAP)
  } finally { h.close() }
})

test("await_reply parks the asker on a timer that the ANSWER cancels, and the answer says so", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("me", "Mentions"))
    h.storage.upsertSession(row("sb", "Shell budgets"))
    const asked = await h.router.messageThread.handler({ input: { slug: "me", handle: "shellBudgets", message: "Which file owns the cap?", awaitReply: true, for: "30m" } })
    assert.equal(asked.sent, true)
    assert.match(asked.timerId ?? "", /^tmr_/)
    const waits = h.storage.listThreadTimers("me", { armedOnly: true })
    assert.equal(waits.length, 1, "the asker holds one armed wait")
    assert.match(waits[0]!.prompt, /^Waiting on @shellBudgets to reply \(thread `sb`\)/)
    assert.ok(Math.abs(waits[0]!.fire_at - Date.now() - 30 * 60_000) < 5_000)
    assert.match(createWakeDeliveryStore(h.storage.scope).list()[0]!.message, /@mentions is WAITING on your answer/)

    // An unrelated thread messaging the asker does not end the wait; the one it waits on does.
    h.storage.upsertSession(row("fm", "Focus mode"))
    const other = await h.router.messageThread.handler({ input: { slug: "fm", handle: "mentions", message: "fyi" } })
    assert.equal(other.answered, undefined)
    assert.equal(h.storage.listThreadTimers("me", { armedOnly: true }).length, 1)
    const reply = await h.router.messageThread.handler({ input: { slug: "sb", handle: "@mentions", message: "src/shell-budget.ts" } })
    assert.equal(reply.answered, true)
    assert.equal(h.storage.listThreadTimers("me", { armedOnly: true }).length, 0, "the answer settled the wait")
    const delivered = createWakeDeliveryStore(h.storage.scope).list().find((d) => d.slug === "me" && /shell-budget\.ts/.test(d.message))
    assert.match(delivered?.message ?? "", /this answers the message you were waiting on/)
  } finally { h.close() }
})

test("a bad await_reply duration refuses before anything is sent", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("me", "Mentions"))
    h.storage.upsertSession(row("sb", "Shell budgets"))
    const bad = await h.router.messageThread.handler({ input: { slug: "me", handle: "sb", message: "q", awaitReply: true, for: "soon" } })
    assert.equal(bad.sent, false)
    assert.equal(createWakeDeliveryStore(h.storage.scope).list().length, 0)
    assert.equal(h.storage.listThreadTimers("me", { armedOnly: true }).length, 0)
  } finally { h.close() }
})
