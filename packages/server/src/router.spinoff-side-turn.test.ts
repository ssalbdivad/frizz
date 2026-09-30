// A SPINOFF REQUEST IS DELIVERED AS A SIDE REQUEST (router.ts FollowUpDelivery) — the real router against
// real SQLite, with only the session broker stubbed.
//
// The request rides the follow-up path to reach the worker, and that path does everything a follow-up does
// BECAUSE the human re-engaged with the thread: it reopens a done thread, clears a snooze, and tells the
// worker how long the human was away and which questions are still open. None of that is true of a
// request for ANOTHER thread, and every one of those effects outlived the side turn the request became
// (spinoff-side-turn.ts). These pin that it does none of them — each beside an ordinary follow-up on the
// same row that does, so the harness is shown able to see the difference.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spinoffRequestMessage, type BoardSnapshot, type Settings } from "@frizz/shared"
import type { BoardManager } from "./board.ts"
import { Emitter } from "./bus.ts"
import { createClaudeBackend } from "./backend/claude.ts"
import { parseDeliveryLedger } from "./delivery-ledger.ts"
import { createRouter, handoffOf } from "./router.ts"
import { operatorMessages } from "./periodic-status.ts"
import type { TranscriptMessage } from "@frizz/shared"
import { createStorage, type SessionRow } from "./storage.ts"
import type { AppContext } from "./context.ts"
import type { Project } from "./project.ts"
import type { Tailer } from "./tailer.ts"

const slug = "parent"
const sessionId = "sid-parent"

function harness(turn: "idle" | "in-flight") {
  const dir = mkdtempSync(join(tmpdir(), "frizz-spinoff-side-"))
  const project: Project = { dir, id: "spinoff-side", name: "test", label: "test", stateDir: dir, cwdSlug: "test" }
  const storage = createStorage(join(dir, "ui.db"), "p")
  const snapshot: BoardSnapshot = { projectDir: dir, projectName: "test", projectLabel: "test", threads: [], errors: [], warnings: [] }
  const board: BoardManager = {
    snapshot: async () => snapshot, currentSeq: () => 0, rebuild: async () => snapshot, refresh: () => snapshot,
    start: async () => {}, stop: async () => {},
  }
  // The worker rested four hours ago — long past the gap note's floor, so an ordinary follow-up carries one.
  const tailer: Tailer = {
    get: () => ({ turn, subAgents: [], bgShells: [], permPrompt: false, pendingQuestion: false, lastAssistantAt: new Date(Date.now() - 4 * 3_600_000).toISOString() }),
    foreignIds: () => [], subAgent: () => undefined, forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
  }
  const backend = createClaudeBackend({ logDir: join(dir, "logs") })
  const sent: string[] = []
  const cancelled: string[] = []
  const ctx = {
    project, storage, board, tailer,
    transcriptChange: new Emitter<string[]>(),
    backendFor: () => backend,
    getSettings: () => ({ permissionMode: "auto" }) as unknown as Settings,
    claudeBroker: {
      followUp: async (input: { text: string }) => void sent.push(input.text),
      cancelFollowUp: async (input: { deliveryId: string }) => (cancelled.push(input.deliveryId), true),
    },
  } as unknown as AppContext
  const row: SessionRow = {
    slug, session_id: sessionId, thread_name: `frizz-${slug}`, spawned_at: "2026-09-30T08:00:00.000Z", last_read_at: null,
    unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: slug, state: "open", meta: null, seen_at: null,
    transcript_id: null,
  }
  storage.upsertSession(row)
  storage.setBackend(slug, "claude")
  storage.setClaudeRuntime(slug, "broker")
  return {
    storage, sent, cancelled, router: createRouter(ctx),
    close: () => { storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

test("a spinoff request leaves a done thread done and a snoozed one snoozed, and carries no riders", async () => {
  const h = harness("idle")
  try {
    h.storage.setState(slug, "archived")
    h.storage.setSnoozedUntil(slug, "2026-10-02T09:00:00.000Z", "check the deploy")
    h.storage.askThreadQuestion({
      id: "q_open", slug, askedAtMs: Date.now(),
      spec: JSON.stringify({ question: "SQLite or a JSON file?", kind: "question", options: [{ label: "SQLite" }, { label: "JSON file" }] }),
    })

    const { id } = await h.router.spinoff.handler({ input: { slug, sessionId, instructions: "evaluate whether the idea holds up" } })
    assert.deepEqual(h.sent, [spinoffRequestMessage({ id, instructions: "evaluate whether the idea holds up" })], "the request and nothing else")
    const after = h.storage.getSession(slug)
    assert.equal(after?.state, "archived", "done stays done")
    assert.equal(after?.snoozed_until, "2026-10-02T09:00:00.000Z", "the snooze stands")
    assert.equal(after?.snooze_prompt, "check the deploy", "…with the bump it owes")
    assert.deepEqual(parseDeliveryLedger(after?.delivery_ledger).map((d) => d.id), [`spinoff-${id}`], "it still reaches the ledger like any send")

    // The same row, the human's own words: every one of those effects happens.
    await h.router.followUp.handler({ input: { slug, sessionId, message: "carry on" } })
    assert.match(h.sent[1]!, /⏱ Frizz: the message above arrived/)
    assert.match(h.sent[1]!, /SQLite or a JSON file\?/)
    const reopened = h.storage.getSession(slug)
    assert.equal(reopened?.state, "open")
    assert.equal(reopened?.snoozed_until ?? null, null)
  } finally {
    h.close()
  }
})

test("taking a queued spinoff request back drops the request; taking back anything else leaves requests alone", async () => {
  const h = harness("in-flight") // mid-turn: both sends wait in the worker's queue
  try {
    const first = await h.router.spinoff.handler({ input: { slug, sessionId, instructions: "first" } })
    const second = await h.router.spinoff.handler({ input: { slug, sessionId, instructions: "second" } })
    await h.router.followUp.handler({ input: { slug, sessionId, message: "and this", deliveryId: "d-human" } })
    assert.deepEqual(parseDeliveryLedger(h.storage.getSession(slug)?.delivery_ledger).map((d) => d.state), ["enqueued", "enqueued", "enqueued"])

    assert.deepEqual(await h.router.unqueueFollowUp.handler({ input: { slug, sessionId, deliveryId: "d-human" } }), { unqueued: true })
    assert.deepEqual(h.storage.spinoffsBySlug().get(slug)?.map((s) => s.id), [first.id, second.id])

    assert.deepEqual(await h.router.unqueueFollowUp.handler({ input: { slug, sessionId, deliveryId: `spinoff-${first.id}` } }), { unqueued: true })
    assert.equal(h.storage.getSpinoff(first.id), undefined, "a request the worker will never read is not left pending")
    assert.deepEqual(h.storage.spinoffsBySlug().get(slug)?.map((s) => s.id), [second.id])
    assert.deepEqual(h.cancelled, ["d-human", `spinoff-${first.id}`])
  } finally {
    h.close()
  }
})

// "What did the human last ask, and what did the worker say to it?" — the queue card's handoff, and the
// request live-status and the status writer describe the thread's work by. A spinoff request is neither:
// it asks for another thread, so the card quotes the ask the thread's own handoff answers.
test("a spinoff request is never the thread's latest ask", () => {
  const msg = (role: "user" | "assistant", text: string, over: Partial<TranscriptMessage> = {}): TranscriptMessage =>
    ({ role, text, tools: [], parts: [], ...over })
  const messages = [
    msg("user", "fix the cache bug", { at: "2026-09-30T10:00:01.000Z" }),
    msg("assistant", "Fixed: the cache now invalidates on write.", { at: "2026-09-30T10:00:04.000Z" }),
    msg("user", spinoffRequestMessage({ id: "spn_0123456789abcdef", instructions: "evaluate it" }), {
      at: "2026-09-30T10:00:10.000Z", displayText: "evaluate it", spinoff: { id: "spn_0123456789abcdef", instructions: "evaluate it" },
    }),
  ]
  assert.deepEqual(handoffOf(messages), {
    text: "Fixed: the cache now invalidates on write.", at: "2026-09-30T10:00:04.000Z",
    asked: "fix the cache bug", askedAt: "2026-09-30T10:00:01.000Z",
  })
  assert.deepEqual(operatorMessages(messages).map((m) => m.text), ["fix the cache bug"])
})
