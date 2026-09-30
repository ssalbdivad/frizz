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

// AN ARCHIVED OR SNOOZED PARENT'S SIDE TURN THAT STOPS BEING QUIET COMES OUT (board.ts surfaceSideTurn,
// review 2026-09-30). The request's delivery leaves Done and Snoozed alone, which is right only while the
// side turn stays clean: blocked on an approval, or gone unclean, the parent is taken out through the same
// helpers a follow-up uses — once per side turn, so a human who puts it back is not overruled — and a
// clean one leaves the row exactly where it was.
test("an archived or snoozed parent comes out when its side turn blocks on the human or goes unclean, and only then", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-spinoff-surface-"))
  const project: Project = { dir, id: "project-spinoff-surface", name: "fixture", label: "fixture", stateDir: dir, cwdSlug: "fixture" }
  const SPN = "spn_0123456789abcdef"
  const tele = (turn: "idle" | "in-flight", over: Partial<SessionTelemetry> = {}): SessionTelemetry =>
    ({ turn, permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, lastAssistantAt: iso("09:30:00"), ...over })
  const side = (over: Partial<NonNullable<SessionTelemetry["sideTurn"]>>): NonNullable<SessionTelemetry["sideTurn"]> =>
    ({ id: SPN, spawned: false, ended: false, clean: true, ...over })
  const FRIDAY = "2026-10-02T09:00:00.000Z"
  const telemetry = new Map<string, SessionTelemetry>([
    ["done-blocked", tele("idle")],
    ["done-clean", tele("idle")],
    ["snoozed-unclean", tele("idle")],
  ])
  const tailer = {
    get: (slug: string) => telemetry.get(slug),
    foreignIds: () => [], subAgent: () => undefined, forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
  } satisfies Tailer
  let nowMs = Date.parse(iso("10:00:00"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  storage.upsertSession(row("done-blocked", { state: "archived" }))
  storage.upsertSession(row("done-clean", { state: "archived" }))
  storage.upsertSession(row("snoozed-unclean"))
  storage.setSnoozedUntil("snoozed-unclean", FRIDAY, null)
  for (const slug of telemetry.keys()) storage.setClaudeRuntime(slug, "broker")
  const bus = new Bus()
  const notified: string[] = []
  bus.subscribe((event) => { if (event.type === "notify" && event.kind === "needs-decision") notified.push(event.slug) })
  const board = createBoard(project, storage, bus, tailer, "spinoff-surface", { now: () => nowMs })
  const where = () => Object.fromEntries([...telemetry.keys()].map((slug) => {
    const r = storage.getSession(slug)!
    return [slug, r.state === "archived" ? "done" : r.snoozed_until ? "snoozed" : "open"]
  }))
  // A build, then the refresh a surfaced row queues for itself (a microtask), then what the queue reads.
  const read = async (time: string) => {
    nowMs = Date.parse(iso(time))
    board.refresh()
    await new Promise<void>((resolve) => setImmediate(resolve))
    return Object.fromEntries(board.refresh().threads.map((t) => [t.id, t.needsYou ?? false]))
  }

  try {
    await read("10:00:00")
    assert.deepEqual(where(), { "done-blocked": "done", "done-clean": "done", "snoozed-unclean": "snoozed" })
    // A spinoff request reaches all three; each worker starts gathering its brief. Nothing surfaces.
    for (const slug of telemetry.keys()) telemetry.set(slug, tele("in-flight", { sideTurn: side({}) }))
    await read("10:00:05")
    assert.deepEqual(where(), { "done-blocked": "done", "done-clean": "done", "snoozed-unclean": "snoozed" }, "a side turn still clean moves nothing")
    // `done-blocked`'s `git log` raises a permission prompt. `done-clean` spawns and ends clean.
    // `snoozed-unclean` writes a file before its spawn: a real turn, which then ends.
    telemetry.set("done-blocked", tele("in-flight", { permPrompt: true, sideTurn: side({}) }))
    telemetry.set("done-clean", tele("idle", { sideTurn: side({ spawned: true, ended: true }) }))
    telemetry.set("snoozed-unclean", tele("idle", { lastAssistantAt: iso("10:00:09"), sideTurn: side({ spawned: true, ended: true, clean: false }) }))
    const queue = await read("10:00:10")
    assert.deepEqual(where(), { "done-blocked": "open", "done-clean": "done", "snoozed-unclean": "open" })
    assert.deepEqual(queue, { "done-blocked": true, "done-clean": false, "snoozed-unclean": true }, "both surfaced parents reach the queue")
    assert.deepEqual(notified.sort(), ["done-blocked", "snoozed-unclean"], "and are announced")

    // The human looks, and puts `done-blocked` back in Done while it still waits: once per side turn.
    storage.setStateIfCurrent("done-blocked", "done-blocked-session", 0, "archived")
    await read("10:00:30")
    assert.equal(where()["done-blocked"], "done", "a parent put back by the human stays put")
    // …even when the SAME side turn then goes on to a second reason: the human denied the prompt and the
    // worker ended without spawning. It surfaced once already; the human's call stands.
    telemetry.set("done-blocked", tele("idle", { lastAssistantAt: iso("10:00:40"), sideTurn: side({ ended: true, clean: false }) }))
    await read("10:00:45")
    assert.equal(where()["done-blocked"], "done", "once per side turn, not once per reason")
    // (Back to blocked for the restart below, which must still surface a side turn waiting on the human.)
    telemetry.set("done-blocked", tele("in-flight", { permPrompt: true, sideTurn: side({}) }))
    await read("10:00:50")
    assert.equal(where()["done-blocked"], "done", "and flipping back to blocked is still the same side turn")

    // A RESTART re-primes: a side turn that went unclean before it is history, but one blocked on the
    // human right now still surfaces.
    await board.stop()
    storage.setSnoozedUntil("snoozed-unclean", FRIDAY, null)
    const rebooted = createBoard(project, storage, bus, tailer, "spinoff-surface", { now: () => nowMs })
    try {
      rebooted.refresh()
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.deepEqual(where(), { "done-blocked": "open", "done-clean": "done", "snoozed-unclean": "snoozed" })
    } finally {
      await rebooted.stop()
    }
  } finally {
    await board.stop()
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
