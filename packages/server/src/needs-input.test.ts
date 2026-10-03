// THE WORKER SAYS WHETHER A REST NEEDS THE HUMAN (maintainer 2026-10-01) — the queue rule for a thread
// dispatched under the `needs_input:` contract, and the grammar that carries the answer. See
// NEEDS_INPUT_REQUIRED_AT in @frizz/shared for the decision, board.needsInputQueues for the rule, and
// declared-park.test.ts for the scheduler's correction of a fence that gives no answer.
import { test } from "node:test"
import assert from "node:assert/strict"
import { awaitingNeedsInput, NEEDS_INPUT_REQUIRED_AT, needsInputRequired, splitAwaitingFrontmatter, type AwaitingHint } from "@frizz/shared"
import { deriveAwaitingBackground, deriveNeedsYou, type RegisteredWatch } from "./board.ts"
import type { GithubStatusBook } from "./awaiting.ts"
import type { SessionRow } from "./storage.ts"
import type { SessionTelemetry } from "./tailer.ts"

const CUT = Date.parse(NEEDS_INPUT_REQUIRED_AT)
const NEW_SPAWN = new Date(CUT + 60_000).toISOString()
const LEGACY_SPAWN = new Date(CUT - 86_400_000).toISOString()
const AT = new Date(CUT + 3_600_000).toISOString() // the rest
const NOW = Date.parse(AT) + 5 * 60_000

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug: "t", session_id: "s", thread_name: "frizz-t", spawned_at: NEW_SPAWN, last_read_at: null,
    unread: 0, exited: 0, archived: 0, rested_at: AT, title_auto: 0, title: null,
    state: "open", meta: null, seen_at: null, transcript_id: null, ...over,
  }
}
const LIVE_AGENT = { id: "toolu_agent", taskId: "a01b2d20", label: "audit the auth module", startedAt: AT, state: "running" as const }
const LIVE_SHELL = { id: "toolu_shell", taskId: "bzvtnt3ig", label: "nub run test", startedAt: AT, state: "running" as const }
function tele(over: Partial<SessionTelemetry> = {}): SessionTelemetry {
  return { turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, lastAssistantAt: AT, ...over } as SessionTelemetry
}
const awaiting = (...hints: AwaitingHint[]) => ({ lastFence: { kind: "awaiting" as const, body: "", hints } })
const agentPark = (answer?: string, forValue = "2h") => awaiting(
  { kind: "agent", value: "a01b2d20" },
  { kind: "for", value: forValue },
  ...(answer === undefined ? [] : [{ kind: "needs_input" as const, value: answer }]),
)

// deriveNeedsYou's positional tail, named — so each case reads as the fact it changes.
function needsYou(r: SessionRow, t: SessionTelemetry, extra: { now?: number; github?: GithubStatusBook; prs?: string[]; watches?: RegisteredWatch[]; questions?: number; runtime?: "turn-idle" | "exited" } = {}) {
  return deriveNeedsYou(r, t, extra.runtime ?? "turn-idle", false, extra.now ?? NOW, undefined, true, false, extra.github ?? {}, new Set(extra.prs ?? []), new Set(), extra.watches ?? [], extra.questions ?? 0)
}

// ---- THE GRAMMAR ---------------------------------------------------------------------------------

test("the fence carries the answer as structure, never as prose", () => {
  const { hints, body } = splitAwaitingFrontmatter("agents: [a01b2d20]\nneeds_input: false\nfor: 1h")
  assert.deepEqual(hints, [{ kind: "agent", value: "a01b2d20" }, { kind: "needs_input", value: "false" }, { kind: "for", value: "1h" }])
  assert.equal(body, "", "a quiet park is the fence alone")
  assert.equal(awaitingNeedsInput(hints), false)

  const loud = splitAwaitingFrontmatter("agents: [a01b2d20]\nneeds_input: true\nfor: 1h\n---\nThree audits are ready to read.")
  assert.equal(awaitingNeedsInput(loud.hints), true)
  assert.equal(loud.body, "Three audits are ready to read.")
  // The underscore is what the key regex used to refuse: the line fell to the BODY as a sentence and the
  // fence carried no answer at all.
  assert.doesNotMatch(loud.body, /needs_input/)
})

test("the hyphenated spelling is the same key; anything but true or false is no answer", () => {
  assert.equal(awaitingNeedsInput(splitAwaitingFrontmatter("shells: [x]\nneeds-input: true\nfor: 1h").hints), true)
  const yes = splitAwaitingFrontmatter("shells: [x]\nneeds_input: yes\nfor: 1h").hints
  assert.deepEqual(yes.find((h) => h.kind === "needs_input"), { kind: "needs_input", value: "yes" }, "kept as written, so the correction can quote it")
  assert.equal(awaitingNeedsInput(yes), null)
  assert.equal(awaitingNeedsInput(splitAwaitingFrontmatter("shells: [x]\nfor: 1h").hints), null)
})

test("the contract is by dispatch instant, and an unknown instant is legacy", () => {
  assert.equal(needsInputRequired(NEW_SPAWN), true)
  assert.equal(needsInputRequired(NEEDS_INPUT_REQUIRED_AT), true, "the cut instant itself is the new contract")
  assert.equal(needsInputRequired(LEGACY_SPAWN), false)
  assert.equal(needsInputRequired(undefined), false)
  assert.equal(needsInputRequired("not a date"), false)
})

// ---- THE QUEUE RULE ------------------------------------------------------------------------------

test("false on a park frizz can honour keeps the thread out of the queue — and the card still states the wait", () => {
  const t = tele({ subAgents: [LIVE_AGENT], ...agentPark("false") })
  assert.equal(needsYou(row(), t), false)
  // The FACT survives the excusal: the drawer and the full-screen page still say what it waits on.
  assert.equal(deriveAwaitingBackground(row(), t, "turn-idle", false, NOW), true)
})

test("true queues it while the work keeps running, and the card's event-snooze still hides it for this rest", () => {
  const t = tele({ subAgents: [LIVE_AGENT], ...agentPark("true") })
  assert.equal(needsYou(row(), t), true)
  assert.equal(deriveAwaitingBackground(row(), t, "turn-idle", false, NOW), true, "it cards as the wait, with the live work listed")
  assert.equal(needsYou(row({ bg_snooze_rested_at: AT }), t), false, "the human's snooze for this rest")
  assert.equal(needsYou(row({ bg_snooze_rested_at: "2026-01-01T00:00:00.000Z" }), t), true, "a snooze from an earlier rest has expired")
})

test("no answer, or one that is neither true nor false, queues — it is never a park", () => {
  assert.equal(needsYou(row(), tele({ subAgents: [LIVE_AGENT], ...agentPark() })), true)
  assert.equal(needsYou(row(), tele({ subAgents: [LIVE_AGENT], ...agentPark("yes") })), true)
})

test("a false frizz cannot honour queues: a dead name, a run-out for:, no for:, a dead worker", () => {
  const dead = tele({ subAgents: [], ...agentPark("false") })
  assert.equal(needsYou(row(), dead), true, "the sub-agent it names is not running")
  const live = tele({ subAgents: [LIVE_AGENT], ...agentPark("false", "2h") })
  assert.equal(needsYou(row(), live, { now: Date.parse(AT) + 3 * 3_600_000 }), true, "its 2h ran out an hour ago")
  const noFor = tele({ subAgents: [LIVE_AGENT], ...awaiting({ kind: "agent", value: "a01b2d20" }, { kind: "needs_input", value: "false" }) })
  assert.equal(needsYou(row(), noFor), true, "no for: is no park — nothing would ever re-check it")
  assert.equal(needsYou(row(), live, { runtime: "exited" }), true, "a worker that is gone is waiting on nothing")
})

// THE GUESSES THIS REPLACES. Each pair is one wait the legacy rule excused on frizz's own inference; a
// new-contract thread that rests on it without saying so is a bare rest, and the sign-off nudge teaches
// the fence that would have kept it out.
test("the per-wait guesses are gone for a new-contract thread, and unchanged for a legacy one", () => {
  const subAgentRest = tele({ subAgents: [LIVE_AGENT] })
  assert.equal(needsYou(row(), subAgentRest), true, "a live sub-agent alone no longer keeps it out")
  assert.equal(needsYou(row({ spawned_at: LEGACY_SPAWN }), subAgentRest), false, "legacy: still excused")

  const watched = tele({ bgShells: [LIVE_SHELL] })
  const watch: RegisteredWatch = { id: "wch_1", kind: "shell", target: "bzvtnt3ig", createdAt: AT, expiresAt: new Date(NOW + 3_600_000).toISOString() }
  assert.equal(needsYou(row(), watched, { watches: [watch] }), true, "a registered watch alone no longer keeps it out")
  assert.equal(needsYou(row({ spawned_at: LEGACY_SPAWN }), watched, { watches: [watch] }), false, "legacy: still excused")

  const ci: GithubStatusBook = { "acme/app#1": { state: "open", checks: "running", running: 1, passed: 0, failed: 0 } as GithubStatusBook[string] }
  assert.equal(needsYou(row(), tele(), { github: ci, prs: ["acme/app#1"] }), true, "CI still running no longer keeps it out")
  assert.equal(needsYou(row({ spawned_at: LEGACY_SPAWN }), tele(), { github: ci, prs: ["acme/app#1"] }), false, "legacy: still held")
})

test("a PR-only false park holds whatever CI is doing — the worker said the human has nothing to do", () => {
  const prPark = tele(awaiting({ kind: "pr", value: "acme/app#1" }, { kind: "for", value: "30d" }, { kind: "needs_input", value: "false" }))
  const green: GithubStatusBook = { "acme/app#1": { state: "open", checks: "passing", running: 0, passed: 2, failed: 0 } as GithubStatusBook[string] }
  assert.equal(needsYou(row(), prPark, { github: green, prs: ["acme/app#1"] }), false)
  assert.equal(needsYou(row(), prPark, { github: green, prs: [] }), true, "an unregistered PR is nothing that will wake it")
})

// A COLD RESUME RE-APPLIES THE CURRENT PROMPT, so a thread dispatched before the cut can learn the key
// after an upgrade. Its `true` must queue it, where the legacy park rule would have excused it.
test("an explicit answer is honoured from a legacy thread too", () => {
  const legacy = row({ spawned_at: LEGACY_SPAWN })
  assert.equal(needsYou(legacy, tele({ subAgents: [LIVE_AGENT], ...agentPark("true") })), true)
  assert.equal(needsYou(legacy, tele({ subAgents: [LIVE_AGENT], ...agentPark("false") })), false)
  // …and a legacy fence that never mentions the key keeps the legacy reading.
  assert.equal(needsYou(legacy, tele({ subAgents: [LIVE_AGENT], ...agentPark() })), false)
})

test("the hard gates still outrank a false: an open question, a done handoff", () => {
  const t = tele({ subAgents: [LIVE_AGENT], ...agentPark("false") })
  assert.equal(needsYou(row(), t, { questions: 1 }), true, "a question waits on a person, whatever the fence says")
  const done = tele({ subAgents: [LIVE_AGENT], lastFence: { kind: "done", body: "- **Shipped** it", hints: [] } })
  assert.equal(needsYou(row(), done), true, "a done card queues even with a child still running")
})
