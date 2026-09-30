import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBoard } from "./board.ts"
import { Bus } from "./bus.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import type { Project } from "./project.ts"
import type { SessionTelemetry, Tailer } from "./tailer.ts"

// A QUEUED THREAD ASKED FOR A SPINOFF KEEPS ITS PLACE (board.ts hasFreshDelivery, notifyNeedsYou). The
// request rides the delivery ledger like the human's own follow-up, but it answers nothing on the card:
// the thread stays queued until its worker starts the side turn, leaves for the seconds the turn runs, and
// comes back to the place it had — with the rest it had, which the tailer puts back (spinoff-side-turn.ts)
// — and without announcing a card the human was already told about. A human follow-up on a twin thread,
// through the same steps, goes to the back and notifies: that is the contrast the rule has to keep.

const iso = (time: string) => `2026-09-30T${time}.000Z`

function row(slug: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug, session_id: `${slug}-session`, thread_name: `frizz-${slug}`, spawned_at: iso("08:00:00"), last_read_at: null,
    unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: null,
    state: "open", meta: null, seen_at: null, transcript_id: null, ...over,
  }
}

test("a queued thread keeps its place and stays quiet through a spinoff request's side turn; a follow-up does not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-spinoff-claim-"))
  const project: Project = { dir, id: "project-spinoff", name: "fixture", label: "fixture", stateDir: dir, cwdSlug: "fixture" }
  const tele = (turn: "idle" | "in-flight", rested: string): SessionTelemetry =>
    ({ turn, permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, lastAssistantAt: iso(rested) })
  const telemetry = new Map<string, SessionTelemetry>([
    ["parent", tele("idle", "09:30:00")],
    ["steered", tele("idle", "09:35:00")],
    ["later", tele("idle", "09:40:00")],
  ])
  const tailer = {
    get: (slug: string) => telemetry.get(slug),
    foreignIds: () => [], subAgent: () => undefined, forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
  } satisfies Tailer
  let nowMs = Date.parse(iso("10:00:00"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  for (const slug of telemetry.keys()) {
    storage.upsertSession(row(slug))
    storage.setClaudeRuntime(slug, "broker")
  }
  const bus = new Bus()
  const notified: string[] = []
  bus.subscribe((event) => { if (event.type === "notify" && event.kind === "needs-decision") notified.push(event.slug) })
  const board = createBoard(project, storage, bus, tailer, "spinoff-claim", { now: () => nowMs })
  const read = (time: string) => {
    nowMs = Date.parse(iso(time))
    return Object.fromEntries(board.refresh().threads.map((t) => [t.id, t.queuedAt]))
  }
  const ledger = (id: string, time: string) => JSON.stringify([{ id, text: "…", state: "delivered", at: iso(time), updatedAt: iso(time) }])

  try {
    assert.deepEqual(read("10:00:00"), { parent: iso("09:30:00"), steered: iso("09:35:00"), later: iso("09:40:00") })
    // Sent: a spinoff request to `parent`, the human's follow-up to `steered`. Neither worker has read it.
    storage.setDeliveryLedger("parent", ledger("spinoff-spn_0123456789abcdef", "10:00:01"))
    storage.setDeliveryLedger("steered", ledger("d1", "10:00:01"))
    assert.deepEqual(read("10:00:01"), { parent: iso("09:30:00"), steered: undefined, later: iso("09:40:00") }, "the card the request answers nothing on stays queued")
    // Both workers pick theirs up and run.
    for (const slug of ["parent", "steered"]) {
      storage.setDeliveryLedger(slug, null)
      telemetry.set(slug, tele("in-flight", slug === "parent" ? "09:30:00" : "09:35:00"))
    }
    assert.deepEqual(read("10:00:05"), { parent: undefined, steered: undefined, later: iso("09:40:00") })
    // Both come back to the rest they left with — `parent`'s put back by the tailer after a clean side turn.
    telemetry.set("parent", tele("idle", "09:30:00"))
    telemetry.set("steered", tele("idle", "09:35:00"))
    assert.deepEqual(read("10:00:20"), { parent: iso("09:30:00"), steered: iso("10:00:20"), later: iso("09:40:00") }, "the spinoff's parent retakes its place")
    assert.deepEqual(notified, ["steered"], "and only the thread a person acted on announces itself again")
  } finally {
    await board.stop()
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
