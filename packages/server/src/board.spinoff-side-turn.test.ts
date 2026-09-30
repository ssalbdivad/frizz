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

// …BUT A THREAD THAT COMES BACK WITH A NEW REASON TO BE QUEUED IS NEWS (review, 2026-09-30). A timer, a PR
// watcher or a shell wakes a queued Codex/ACP thread with no ledger entry, so its claim survives and the
// queue clock hands it the old place back; its rest does not move until a final answer. When that turn
// stops on an approval, the same place and the same rest used to read as "the card you already saw", and
// a thread blocked on the human went unannounced. A rest that already asked a question, through its own
// clean spinoff, is the contrast: urgent both times, the same urgency, still quiet.
test("a queued thread woken without a person, that comes back blocked on an approval, announces itself", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-spinoff-urgent-"))
  const project: Project = { dir, id: "project-spinoff-urgent", name: "fixture", label: "fixture", stateDir: dir, cwdSlug: "fixture" }
  const tele = (turn: "idle" | "in-flight", rested: string, over: Partial<SessionTelemetry> = {}): SessionTelemetry =>
    ({ turn, permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, lastAssistantAt: iso(rested), ...over })
  const telemetry = new Map<string, SessionTelemetry>([
    ["woken", tele("idle", "09:30:00")],
    ["asking", tele("idle", "09:35:00", { pendingQuestion: true })],
  ])
  const tailer = {
    get: (slug: string) => telemetry.get(slug),
    foreignIds: () => [], subAgent: () => undefined, forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
  } satisfies Tailer
  let nowMs = Date.parse(iso("10:00:00"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  for (const slug of telemetry.keys()) {
    // Before the question-fence cutover, so a ```question at rest is still this worker's ask.
    storage.upsertSession(row(slug, { spawned_at: "2026-09-01T08:00:00.000Z" }))
    storage.setClaudeRuntime(slug, "broker")
  }
  const bus = new Bus()
  const notified: string[] = []
  bus.subscribe((event) => { if (event.type === "notify" && event.kind === "needs-decision") notified.push(event.slug) })
  const board = createBoard(project, storage, bus, tailer, "spinoff-urgent", { now: () => nowMs })
  const read = (time: string) => {
    nowMs = Date.parse(iso(time))
    return Object.fromEntries(board.refresh().threads.map((t) => [t.id, t.queuedAt]))
  }

  try {
    assert.deepEqual(read("10:00:00"), { woken: iso("09:30:00"), asking: iso("09:35:00") })
    // `woken`: a scheduler wake — no delivery, nobody acted. `asking`: its spinoff request's side turn.
    telemetry.set("woken", tele("in-flight", "09:30:00"))
    telemetry.set("asking", tele("in-flight", "09:35:00"))
    assert.deepEqual(read("10:00:05"), { woken: undefined, asking: undefined })
    // `woken` stops on a permission prompt, its rest unmoved; `asking` comes back to the rest it left.
    telemetry.set("woken", tele("in-flight", "09:30:00", { permPrompt: true }))
    telemetry.set("asking", tele("idle", "09:35:00", { pendingQuestion: true }))
    assert.deepEqual(read("10:00:20"), { woken: iso("09:30:00"), asking: iso("09:35:00") }, "both keep their places")
    assert.deepEqual(notified, ["woken"], "the approval is announced; the question the human was already told about is not")
  } finally {
    await board.stop()
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
