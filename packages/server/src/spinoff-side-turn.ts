import { parseSpinoffRequest, shellWriteTargets, spinoffIdOfSpawnCall, stripFollowUpRiders } from "@frizz/shared"
import type { FoldState, NormalizedEvent } from "./backend/types.ts"

// THE SPINOFF SIDE TURN (2026-09-30).
//
// A spinoff request reaches the parent's worker as a message (router.ts `spinoff`), and the worker answers
// it with one `spawn_thread` call. When the worker was AT REST, that answer used to be an ordinary turn of
// the parent's conversation, and everything a turn does followed from it: the request cleared the rest's
// ```done fence, the spawn call spent its registered done, the turn's end moved `rested_at` and badged the
// thread unread, and the rest it left had no sign-off — so Frizz nudged the worker for one, and the
// worker filed a second Done card reading "Nothing new landed here. The evaluation is running on its own
// thread." under "I started [Sub-agent addresses](…)" (maintainer: "very confusing and doesn't explicitly
// just link and mention the spinoff by name"). The chat's spinoff card already says which thread the
// request became; the parent's own state should not have moved at all.
//
// So a request that finds the worker at rest opens a SIDE TURN, and a side turn that does only what was
// asked is kept out of the thread: the chat drops what the worker wrote in it (transcript.ts), and the
// tailer presents the thread's rest exactly as it was before the request — fence, registered done, card,
// rest time, unread (tailer.ts), and so its place in the queue (board.ts). The request's delivery does not
// reopen, unsnooze or brief the thread either (router.ts FollowUpDelivery). This module is the ONE
// definition the tailer and the chat read, driven record by record by both folds, so the board and the
// chat can never disagree about which turns were side turns.
//
// A side turn is CLEAN — and only a clean one is hidden — when all of these hold:
//   (a) it contains a `spawn_thread` call naming its own request (spinoffIdOfSpawnCall);
//   (b) that call's result reports the thread it started — positive evidence, never "no error seen";
//   (c) the worker called nothing AFTER that call: a worker that carried on with real work made the turn a
//       real turn, and it must surface;
//   (d) the turn ENDED before anything else reached the worker — a human message, a wake, a sub-agent's
//       report, another spinoff request. Whatever arrived shares the turn, so the turn is not the side
//       request's alone.
// Calls BEFORE the spawn are the brief being gathered (reading the code the new thread will need), and
// they are allowed — except a call that WRITES files (an Edit, or a shell command that writes: see
// writesFiles), which is the new thread's work being done here and
// would otherwise vanish from the chat and the edited-files rail with the turn. Anything this module cannot
// classify errs toward showing the turn: an unclean side turn behaves exactly as every turn did before.
//
// "At rest" is the tailer's own definitive idle reading (computeTurn): the worker's last record ENDED its
// turn (Claude `end_turn`, Codex/ACP `turn-end`) and nothing has re-invoked it since. A request delivered
// mid-turn — queued behind a running turn, or steered into it — is part of that turn and is never a side
// turn. A rest that followed a FAILED turn is not a rest here either: that failure is the thread's news.
//
// The request's own message is not hidden: the chat draws it as the spinoff card. Only the worker's side of
// the side turn goes.
//
// WHAT IT CANNOT SEE, and so shows (2026-09-30): a background command or sub-agent launched BEFORE the
// spawn reads as an ordinary call (the ops strip still shows it, and its completion re-invokes the worker
// visibly); a spawn Codex makes from inside its `exec` script wrapper is not recognized as the spawn, nor
// one an ACP agent names by a title of its own (opencode's `frizz_spawn_thread`) or whose input arrives
// only on the completing update — each of those turns is simply not hidden, exactly as before.

/** The delivery id a spinoff request is sent under (router.ts `spinoff`), so the ledger item that carries
 *  it can be told from the human's own sends: the board keeps the thread's queue place through it
 *  (board.ts hasFreshDelivery), and taking it back out of the queue drops the request (unqueueFollowUp). */
export const SPINOFF_DELIVERY_PREFIX = "spinoff-"

/** The spinoff request a delivery id carries, if it is one. */
export function spinoffIdOfDelivery(deliveryId: string): string | undefined {
  return deliveryId.startsWith(SPINOFF_DELIVERY_PREFIX) ? deliveryId.slice(SPINOFF_DELIVERY_PREFIX.length) : undefined
}

/** The spinoff request id when `text` is a delivered request and NOTHING ELSE — a record that carries a
 *  request and a human's message side by side (the SDK coalesces a queue into one record) is a real turn,
 *  because the worker's answer to the message would otherwise be hidden with the side turn. Riders a build
 *  before 2026-09-30 appended to the worker's copy (the gap note, the open-questions note) come off first. */
export function sideTurnRequestId(text: string): string | undefined {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith("<spin")) return undefined
  const bare = stripFollowUpRiders(trimmed.trimEnd()).trimEnd()
  if (!/<\/(?:spinoff|spin-off)-request>$/.test(bare)) return undefined
  return parseSpinoffRequest(bare)?.id
}

// `spawn_thread`'s own success sentence (cc-worker/bin/frizz-mcp.mjs), unchanged since 2026-08-04 and
// pinned against the real MCP server by spinoff-side-turn.test.ts. Positive evidence on purpose: Codex and
// ACP carry no error flag on a tool result, and a spawn that failed must never be read as one that worked.
const SPAWN_STARTED = /Spawned a new frizz thread `[^`\s]+`/

/** Did this `spawn_thread` result start a thread? */
export function spawnStarted(text: string, isError = false): boolean {
  return !isError && SPAWN_STARTED.test(text)
}

// The tools that write files, by the names the two providers give them. Codex's exec wrapper runs any tool
// from a script, so its `tools.apply_patch(` is read out of the source.
const WRITE_TOOLS: ReadonlySet<string> = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "apply_patch"])
function writesFiles(name: string, input: unknown): boolean {
  if (WRITE_TOOLS.has(name)) return true
  if (engagesHuman(name)) return true
  if (name === "exec" && typeof input === "string") return /\btools\.apply_patch\s*\(/.test(input)
  const command = shellCommandOf(name, input)
  return command !== undefined && shellWritesFiles(command)
}

// A CALL THAT CHANGES WHAT THE HUMAN IS OWED IS WORK TOO (2026-09-30, review of the side turn). A worker
// that `ask`s the human while gathering its brief, then spawns and ends clean, had its question hidden
// with the turn — and on an archived or snoozed parent nothing surfaced it, since the side turn looked
// quiet. The same goes for the rest of the thread's own registrations (a `done`, a watch, a timer, a
// message to another thread): each moves the thread's state, which is exactly what a side turn promises
// not to do. The Frizz tools that only READ (`read_thread`, `activity`) stay allowed; `spawn_thread` is
// the side turn's own call and is judged by `call` below. Matched under any MCP prefix, like
// spinoffIdOfSpawnCall, and Claude's native AskUserQuestion with them.
const HUMAN_FACING = /(?:^|__|\.|\/)(?:ask|unask|done|watch|watch_pr|watch_issue|unwatch|timer|goal|message_thread|link|unlink|title|extend_shell)$/
function engagesHuman(name: string): boolean {
  return name === "AskUserQuestion" || HUMAN_FACING.test(name)
}

// A SHELL WRITE IS A WRITE (2026-09-30, review of the side turn). The edited-files rail has read Bash
// since 2026-09-04 (edited-files.ts), because Claude Code's `auto` permission mode TELLS the worker to
// edit "with sed, heredocs, or short scripts" rather than the Edit tool — on the maintainer's own threads
// a shell write is the ordinary write, not an exotic one. So `cat > notes.md <<EOF` before the spawn hid
// exactly what the header says must not vanish: the rail runs over the projection AFTER the side turn's
// messages are dropped, so the write left no trace in the chat or the rail, and the rest the tailer put
// back said the tree had not moved.
//
// Only a command that WRITES counts, read by the rail's own parser (shared shellWriteTargets) — never
// "any Bash call". Read-only shell (`git log`, `grep`, `cat`, `ls`) is how a worker gathers a brief, and
// treating it as work would make nearly every spinoff a real turn, which is the thing this module exists
// to stop. The parser already drops fd duplications (`2>&1`) and anything the shell would have to
// expand; what is left out here is scratch the rail never lists either — a device and the system temp
// dir. A worker's own `.frizz/threads/…` scratch is in the project, is on the rail, and so counts.
//
// NOT READ (and so allowed, as before): a `git commit`/`git stash`, a `rm`/`mv`, and a shell write made
// from inside Codex's `exec` script wrapper, whose source this does not parse (transcript.ts decodes it
// for the card; importing that here would make the fold depend on the projection).
function shellCommandOf(name: string, input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined
  const obj = input as { command?: unknown; cmd?: unknown }
  // Claude's Bash carries `command`. Codex's shell tools carry `cmd` (exec_command) or `command` as a
  // string or an argv (shell, local_shell — often ["bash","-lc","<script>"]), under whatever name the
  // build gives them, which is why the transcript projection keys on the input's shape and not the
  // name (transcript.ts codexToolCall); an ACP agent's command tool is read the same way.
  if (name !== "Bash" && name.startsWith("mcp__")) return undefined
  if (typeof obj.cmd === "string") return obj.cmd
  if (typeof obj.command === "string") return obj.command
  if (Array.isArray(obj.command)) {
    const parts = obj.command.filter((c): c is string => typeof c === "string")
    const flag = parts.findIndex((c) => c === "-c" || c === "-lc" || c === "-lic")
    return flag !== -1 && parts[flag + 1] !== undefined ? parts[flag + 1] : parts.join(" ")
  }
  return undefined
}

const SCRATCH_TARGET = /^\/(?:dev|tmp)(?:\/|$)/
function shellWritesFiles(command: string): boolean {
  return shellWriteTargets(command).some((target) => !SCRATCH_TARGET.test(target.path))
}

/** One thing a fold saw, in the terms the side turn is defined in. Each fold maps its own records onto
 *  these (claudeSideTurnSteps, normalizedSideTurnSteps) and drives stepSideTurn with them. */
export type SideTurnStep =
  // A turn opened before its words arrived — Codex's `task_started`, written ahead of the user message.
  | { kind: "open" }
  // Something reached the worker that it will answer: a human message, a wake, a sub-agent's report, a
  // compaction summary, an interrupt. `request` when it is a spinoff request and nothing else.
  | { kind: "prompt"; request?: string }
  // Something reached the worker WITHOUT opening a turn (a Codex child's report): it voids a side turn in
  // flight, since the worker may answer it there, and means nothing at rest.
  | { kind: "aside" }
  // The worker called a tool. `spawn` is the spinoff id a spawn_thread call fulfils; `writes` that it
  // writes files.
  | { kind: "call"; id: string; spawn?: string; writes?: boolean }
  // A tool's result. `started` is read only for the spawn call's result, so a fold never has to extract
  // the text of every result it passes.
  | { kind: "result"; id: string; started: () => boolean }
  // The worker wrote something without ending its turn.
  | { kind: "output" }
  // The RUNTIME re-prompted a turn that ended with no visible output (Claude Code's meta record "[Your
  // previous response had no visible output. Please continue…]"). The same turn going on, not something
  // new reaching the worker.
  | { kind: "companion" }
  // The worker ended its turn. `message` is the provider's id for the message that ended it, when it has
  // one: Claude writes one message as several records, every one of them ending the turn. `failed` when
  // the bracket itself says the turn did not succeed (a Codex/ACP turn aborted with no answer).
  | { kind: "rest"; message?: string; failed?: boolean }
  // The turn failed (a provider error the provider is not retrying).
  | { kind: "fault" }

export interface SideTurn {
  id: string // the spinoff request it answers
  call?: string // the tool call that fulfils it, once issued
  spawned: boolean // that call's result reported the new thread
  ended: boolean // the worker ended its turn and has not spoken since
  clean: boolean // nothing has disqualified it yet (see the header)
}

/** A side turn is hidden — its messages dropped, its effects on the rest undone — when it did exactly
 *  what was asked and ended. */
export function sideTurnHides(turn: SideTurn): boolean {
  return turn.clean && turn.spawned && turn.ended
}

export interface SideTurnState {
  resting: boolean // the worker's last word ended its turn, and nothing has reached it since
  opening?: boolean // a turn opened from rest and its words have not arrived yet (Codex's order)
  faulted?: boolean // the turn in progress failed, so the rest it comes to is not a rest here
  restMessage?: string // the message that ended the turn, so its other records read as the same rest
  current?: SideTurn // the side turn in progress — or just ended, until the next turn closes it
}

export interface SideTurnTransition {
  closed?: SideTurn // a side turn the next turn has put behind it; hidden or not, it will not change again
  opened?: SideTurn
}

const NONE: SideTurnTransition = {}

function close(st: SideTurnState): SideTurnTransition {
  const closed = st.current
  st.current = undefined
  return closed ? { closed } : NONE
}

// The worker said something after its rest with no prompt the fold could see — a Stop hook sent it on, or
// a message arrived by a record this definition does not model. Whatever it said shares the side turn.
function resume(st: SideTurnState): void {
  if (st.resting && st.current) st.current.clean = false
  st.resting = false
  st.opening = false
  st.restMessage = undefined
}

/** Advance the side-turn reading by one step, in place. Pure otherwise: the same steps in the same order
 *  always reach the same state, which is what lets two folds of one transcript agree. */
export function stepSideTurn(st: SideTurnState, step: SideTurnStep): SideTurnTransition {
  switch (step.kind) {
    case "open": {
      // ACP writes the user message BEFORE its turn bracket, so a bracket that finds the worker already
      // prompted belongs to that prompt's turn and changes nothing.
      if (!st.resting) return NONE
      st.resting = false
      st.opening = true
      st.faulted = false
      st.restMessage = undefined
      return close(st)
    }
    case "prompt": {
      const atRest = st.resting || st.opening === true
      st.resting = false
      st.opening = false
      st.faulted = false
      st.restMessage = undefined
      if (!atRest) {
        // Mid-turn: whatever the worker writes next answers this too, so a side turn in flight is spent.
        if (st.current) st.current.clean = false
        return NONE
      }
      const { closed } = close(st)
      if (!step.request) return closed ? { closed } : NONE
      st.current = { id: step.request, spawned: false, ended: false, clean: true }
      return { ...(closed ? { closed } : {}), opened: st.current }
    }
    case "aside": {
      if (st.current && !st.current.ended) st.current.clean = false
      return NONE
    }
    case "call": {
      resume(st)
      const turn = st.current
      if (!turn) return NONE
      if (turn.call === undefined && step.spawn === turn.id) turn.call = step.id
      else if (turn.call !== undefined || step.writes) turn.clean = false
      return NONE
    }
    case "result": {
      const turn = st.current
      if (!turn || turn.call !== step.id || turn.spawned) return NONE
      if (step.started()) turn.spawned = true
      else turn.clean = false
      return NONE
    }
    case "output": {
      resume(st)
      return NONE
    }
    case "companion": {
      // THE RUNTIME'S OWN "SAY SOMETHING" (2026-09-30, the first real run). Asked to end a side turn in
      // silence, a haiku worker did exactly that — and Claude Code, which will not let a turn end with no
      // visible output, re-prompted it with a meta record; its "Spinoff thread created." then arrived as a
      // DIFFERENT message after the rest, which `rest` below reads as the worker speaking again unprompted.
      // The side turn went unclean, the thread requeued, the sign-off nudge fired and the worker filed a
      // fresh Done card over its real one — the very thing this module exists to prevent. The re-prompt is
      // the harness finishing the turn it was already in, so the answer is the side turn's own.
      //
      // `ended` stays true on purpose. The tailer's turn reading skips meta records, so the thread reads idle
      // throughout, and the seconds between the re-prompt and the answer must not flash the raw rest — a
      // bare rest with the fence gone, exactly what the sign-off nudge fires on. Anything that makes the
      // answer real work (a call after the spawn, a message reaching the worker first) still spends it.
      if (!st.resting) return NONE
      st.resting = false
      st.restMessage = undefined
      return NONE
    }
    case "rest": {
      if (st.resting) {
        // Another record of the message that already ended the turn, or a repeated bracket (Codex writes
        // `turn_aborted` after `task_complete` on some stops — the turn it closes had already succeeded,
        // so its "failure" is nobody's). A DIFFERENT message is the worker speaking again with nothing
        // prompting it.
        if (step.message === undefined || st.restMessage === undefined || step.message === st.restMessage) return NONE
        resume(st)
      }
      if (step.failed) {
        st.faulted = true
        if (st.current) st.current.clean = false
      }
      st.opening = false
      st.restMessage = step.message
      // A turn that failed did not come to rest: the next request finds a thread whose news is the failure.
      st.resting = st.faulted !== true
      st.faulted = false
      const turn = st.current
      if (turn) {
        turn.ended = true
        if (!turn.spawned) turn.clean = false
      }
      return NONE
    }
    case "fault": {
      st.faulted = true
      if (st.current) st.current.clean = false
      return NONE
    }
  }
}

// ---- the two record vocabularies ----------------------------------------------------------------------

function text(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown } | null
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text)
  }
  return parts.join("\n")
}

// Claude Code's re-prompt of a turn that ended with nothing visible: a meta user record the SDK marks
// `turnCompanion` (2.1.282), whose text is fixed. Either tell is enough, so a build that drops the flag or
// rewords the line still reads as what it is.
const SILENT_TURN_REPROMPT = /^\[Your previous response had no visible output\b/
function isSilentTurnCompanion(record: object): boolean {
  const rec = record as { turnCompanion?: unknown; message?: { content?: unknown } }
  return rec.turnCompanion === true || SILENT_TURN_REPROMPT.test(text(rec.message?.content).trimStart())
}

/** A Claude transcript record in side-turn terms. Both Claude folds — the tailer's applyRecord and the
 *  chat's createTranscriptFold — call this on every record, in file order. */
export function claudeSideTurnSteps(record: unknown): SideTurnStep[] {
  if (!record || typeof record !== "object") return []
  const rec = record as {
    type?: unknown
    isMeta?: unknown
    isApiErrorMessage?: unknown
    attachment?: { type?: unknown; prompt?: unknown }
    message?: { id?: unknown; stop_reason?: unknown; content?: unknown }
  }
  if (rec.type === "assistant") {
    const steps: SideTurnStep[] = []
    if (rec.isApiErrorMessage === true) steps.push({ kind: "fault" })
    const content = rec.message?.content
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as { type?: unknown; id?: unknown; name?: unknown; input?: unknown } | null
        if (b?.type !== "tool_use" || typeof b.id !== "string") continue
        const name = typeof b.name === "string" ? b.name : ""
        steps.push({ kind: "call", id: b.id, spawn: spinoffIdOfSpawnCall(name, b.input), writes: writesFiles(name, b.input) })
      }
    }
    if (rec.message?.stop_reason === "end_turn") steps.push({ kind: "rest", ...(typeof rec.message.id === "string" ? { message: rec.message.id } : {}) })
    else steps.push({ kind: "output" })
    return steps
  }
  // A meta record is the harness's own (a loaded skill's body, an image's dimensions, a /rename reminder):
  // it re-invokes nothing, which is why the tailer's turn reading skips it too — except the one that
  // re-prompts a silent rest, which the worker answers inside the turn it just ended (see `companion`).
  if (rec.type === "user" && rec.isMeta === true) {
    return isSilentTurnCompanion(record) ? [{ kind: "companion" }] : []
  }
  if (rec.type === "user") {
    const content = rec.message?.content
    if (typeof content === "string") return [{ kind: "prompt", request: sideTurnRequestId(content) }]
    if (!Array.isArray(content)) return []
    const steps: SideTurnStep[] = []
    let prompt = false
    for (const block of content) {
      const b = block as { type?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown } | null
      if (b?.type === "tool_result") {
        if (typeof b.tool_use_id === "string") {
          const result = b
          steps.push({ kind: "result", id: b.tool_use_id, started: () => spawnStarted(text(result.content), result.is_error === true) })
        }
      } else {
        prompt = true
      }
    }
    // A record with words beside its results is a message delivered INTO the turn (the runtime appends a
    // queued message to a tool result) — the results land first, then the words.
    if (prompt) steps.push({ kind: "prompt", request: sideTurnRequestId(text(content)) })
    return steps
  }
  // A queued command materialized into the worker's context: a human message or a sub-agent's report that
  // arrived mid-turn, delivered at the next sampling boundary. It is the worker's input like any prompt.
  if (rec.type === "attachment" && rec.attachment?.type === "queued_command") {
    return [{ kind: "prompt", request: sideTurnRequestId(text(rec.attachment.prompt)) }]
  }
  return []
}

/** A normalized event (Codex's rollout, ACP's transcript) in side-turn terms. The tailer's applyEvent and
 *  both chat projections call this on every event, in order. */
export function normalizedSideTurnSteps(ev: NormalizedEvent): SideTurnStep[] {
  switch (ev.kind) {
    case "turn-start":
      return [{ kind: "open" }]
    case "user-message":
      return [{ kind: "prompt", request: typeof ev.text === "string" ? sideTurnRequestId(ev.text) : undefined }]
    case "agent-report":
    case "agent-instruction":
      return [{ kind: "aside" }]
    case "tool-call":
      return [{ kind: "call", id: ev.id, spawn: spinoffIdOfSpawnCall(ev.name, ev.input), writes: writesFiles(ev.name, ev.input) }]
    case "tool-result":
      return [{ kind: "result", id: ev.id, started: () => spawnStarted(ev.text) }]
    case "assistant-text":
    case "reasoning":
      return [{ kind: "output" }]
    case "turn-end":
      // A turn with no answer and no word of success is an aborted one — the human stopped it — and a
      // stopped side turn is not one that did what it was asked.
      return [{ kind: "rest", ...(ev.successful === true || ev.finalText !== undefined ? {} : { failed: true }) }]
    case "provider-error":
      return ev.error.retrying ? [] : [{ kind: "fault" }]
    default:
      return []
  }
}

// ---- the tailer's half: the rest a hidden side turn leaves as it found it ------------------------------

// Every FoldState field a turn moves that says where the THREAD stands — as opposed to what its process
// is doing (the turn itself, open calls, the context reading, background work), which stays the raw truth
// throughout. Audited against both arms of applyRecord and every arm of applyEvent (2026-09-30):
//   • the final message's reading — its preview, fence, question and ALLDONE sentinel — and the instant
//     it was written, which is the rest-time key the queue, the sign-off nudge, the Goal and the park
//     bumps all key on;
//   • the human-turn clocks the request moved (it reads as the human speaking), which decide whether a
//     registered done still stands and whether an open question was replied past;
//   • the tool-call clock the spawn moved, which is the other half of a registered done's lifetime;
//   • `lastUserText`, Codex's delivery-confirmation text, so a wake confirmed before the request stays
//     confirmed after it.
// NOT restored: the faults (a side turn that failed is never hidden, and one that succeeded proves the
// provider serves), `lastActivityAt` (the worker did run), `firstUserText` (set once, long before).
export const SIDE_TURN_REST_FIELDS = [
  "lastFence",
  "lastAssistant",
  "lastAssistantAt",
  "lastAssistantAllDone",
  "lastAssistantHasQuestion",
  "lastUserAt",
  "lastHumanAt",
  "lastToolCallAt",
  "lastUserText",
] as const satisfies readonly (keyof FoldState)[]

export type SideTurnRest = Pick<FoldState, (typeof SIDE_TURN_REST_FIELDS)[number]>

/** What a fold keeps: the reading, and the rest a side turn in progress was opened from. Plain JSON, so it
 *  rides the tail cache like every other TailState field. */
export interface SideTurnFold extends SideTurnState {
  saved?: SideTurnRest
}

function restOf(state: FoldState): SideTurnRest {
  const saved = {} as Record<string, unknown>
  for (const key of SIDE_TURN_REST_FIELDS) saved[key] = state[key]
  return saved as SideTurnRest
}

// Field by field rather than Object.assign: the tail cache's JSON round trip drops a key whose value is
// undefined, and an absent fence has to come back ABSENT — a fence the side turn wrote must not survive.
function writeRest(state: FoldState, saved: SideTurnRest): void {
  const target = state as unknown as Record<string, unknown>
  for (const key of SIDE_TURN_REST_FIELDS) target[key] = (saved as Record<string, unknown>)[key]
}

/** Drive a fold's side-turn reading with one record's steps. Call it BEFORE the record's own effects: a
 *  request's rest is saved as it stood before the request touched it, and a hidden side turn's rest is put
 *  back before the next turn's record moves anything, so every later turn proceeds as if the side turn had
 *  never happened (a registered done still stands through a prose-only reply to the human's next word). */
export function foldSideTurn(state: FoldState, steps: readonly SideTurnStep[]): void {
  if (steps.length === 0) return
  const fold = (state.sideTurn ??= { resting: false })
  for (const step of steps) {
    const { closed, opened } = stepSideTurn(fold, step)
    if (closed) {
      if (fold.saved && sideTurnHides(closed)) writeRest(state, fold.saved)
      fold.saved = undefined
    }
    if (opened) fold.saved = restOf(state)
  }
}

/** The rest to present while a hidden side turn stands — the one the request found — or undefined when
 *  the raw fold is the truth. The tailer's view gate is its one reader. */
export function hiddenSideTurnRest(state: FoldState): SideTurnRest | undefined {
  const fold = state.sideTurn
  return fold?.current && fold.saved && sideTurnHides(fold.current) ? fold.saved : undefined
}

/** A side turn is running and nothing has disqualified it yet — the worker is gathering its brief. */
export function sideTurnRunning(state: FoldState): boolean {
  const turn = state.sideTurn?.current
  return turn !== undefined && turn.clean && !turn.ended
}

// ---- the chat's half: which messages a hidden side turn drops ------------------------------------------

export interface SideTurnProjection {
  /** Feed one record's steps. */
  step(steps: readonly SideTurnStep[]): void
  /** The side turn in progress, if any — what a message the worker writes now belongs to. */
  current(): SideTurn | undefined
  /** Record that `message` is the worker's output inside `turn` — `current()` at the moment the worker
   *  wrote it, which a fold that pushes a message late (the rest divider) has to have kept. */
  own<T extends object>(message: T, turn: SideTurn | undefined): T
  /** Is `message` part of a hidden side turn? */
  hides(message: object): boolean
  /** Is `message` the request that opened a hidden side turn? It stays visible — it is the spinoff card —
   *  but a walk back to "the worker's last rest" steps over it. */
  opensHidden(message: { spinoff?: { id: string } }): boolean
  /** `messages` without every message a hidden side turn owns. The same array when nothing is hidden. */
  visible<T extends object>(messages: T[]): T[]
}

export function createSideTurnProjection(): SideTurnProjection {
  const st: SideTurnState = { resting: false }
  const owners = new WeakMap<object, SideTurn>()
  const byRequest = new Map<string, SideTurn>()
  const owned = new Set<SideTurn>()
  const api: SideTurnProjection = {
    step(steps) {
      for (const step of steps) {
        const { opened } = stepSideTurn(st, step)
        if (opened) byRequest.set(opened.id, opened)
      }
    },
    current: () => st.current,
    own(message, turn) {
      if (turn) {
        owners.set(message, turn)
        owned.add(turn)
      }
      return message
    },
    hides(message) {
      const turn = owners.get(message)
      return turn !== undefined && sideTurnHides(turn)
    },
    opensHidden(message) {
      const turn = message.spinoff ? byRequest.get(message.spinoff.id) : undefined
      return turn !== undefined && sideTurnHides(turn)
    },
    visible(messages) {
      let any = false
      for (const turn of owned) if (sideTurnHides(turn)) { any = true; break }
      return any ? messages.filter((m) => !api.hides(m)) : messages
    },
  }
  return api
}
