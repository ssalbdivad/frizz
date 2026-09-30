// The Claude session broker DAEMON: a detached process that owns one Claude Agent SDK session and
// relays it over a local socket. This is the piece Claude Code doesn't ship (codex's app-server is
// the same shape): the session OUTLIVES frizz, so frizz reconnects to the LIVE session after a restart
// instead of cold resume-from-disk, while keeping structured TYPED control (no TUI scraping, no PTY,
// no terminal of any kind — stream-json over pipes). The SDK stays as this daemon's implementation detail; frizz speaks a
// small typed socket protocol (claude-broker-client.ts), never the SDK directly.
//
// Wire protocol — newline-delimited JSON frames:
//   frizz -> broker:  {t:"input", message} | {t:"permission", requestId, decision} | {t:"interrupt"} | {t:"set-mode", mode}
//                  | {t:"cancel-input", requestId, id} | {t:"stop-task", requestId, taskId}
//                  | {t:"reload-plugins", requestId} | {t:"rename", requestId, description} | {t:"list-skills", requestId}
//   broker -> frizz:  {t:"hello", sessionId, generation} | {t:"event", event} | {t:"permission-request", requestId, request} | {t:"diagnostic", diagnostic}
//                  | {t:"cancel-result", requestId, cancelled, error?} | {t:"stop-result", requestId, error?}
//                  | {t:"reload-result", requestId, reloaded?, error?} | {t:"rename-result", requestId, title?, error?} | {t:"skills-result", requestId, skills?, error?}
//
// Control actions that make a user-visible promise are REQUEST/RESPONSE pairs: `cancel-input` carries
// the CLI's verdict about whether a message will still run, and `stop-task` returns only after the SDK
// accepted or rejected the task stop. "We wrote a socket frame" is not either answer.
//
// Lifecycle mirrors codex-app-server-daemon.ts (record-after-listen, owner-checked cleanup, idle
// exit, reachability self-collection). The recovered session-broker daemon's NAIVE unconditional
// cleanup is exactly the corpse-deletes-successor bug this guards against.
import net from "node:net"
import { readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { createClaudeQueryFactory } from "./claude-agent-sdk.ts"
import { inheritWorkerEnvironment } from "./worker-env.ts"
import { leaseRuntime } from "../runtime-lease.ts"
import { projectMcpServers, workerMcpServers, type WorkerMcpServers } from "./project-mcp-servers.ts"
import { WORKER_DISALLOWED_TOOLS, claudeCompactionWindowOf } from "./types.ts"
import { createClaudeBrokerDiagnosticWriter, createClaudeBrokerExitWriter, type ClaudeBrokerExitReason } from "./claude-broker-diagnostics.ts"
import { CLAUDE_BROKER_CAPABILITY_CANCEL_INPUT, CLAUDE_BROKER_CAPABILITY_LIST_SKILLS, CLAUDE_BROKER_CAPABILITY_RELOAD_PLUGINS, CLAUDE_BROKER_CAPABILITY_RENAME, CLAUDE_BROKER_CAPABILITY_STOP_TASK, CLAUDE_BROKER_CAPABILITY_SUBAGENT_STEER, CLAUDE_INPUT_DROP_DIAGNOSTIC_PREFIX } from "./claude-agent-sdk-protocol.ts"
import type {
  ClaudeDiagnostic,
  ClaudeInputMessage,
  ClaudePermissionDecision,
  ClaudePermissionMode,
  ClaudePermissionRequest,
  ClaudeQueryEvent,
} from "./claude-agent-sdk-protocol.ts"

export interface ClaudeBrokerConfig {
  socketPath: string
  cwd: string
  sessionId: string
  executablePath: string
  permissionMode?: ClaudePermissionMode
  /** Allowlisted keys only — the SDK validates and rejects anything else. */
  env: Record<string, string>
  /** Appended to Claude's default system prompt — carries the frizz worker contract. */
  appendSystemPrompt?: string
  model?: string
  effort?: string
  /** Resume the session from its on-disk transcript instead of starting a fresh one. Set when a
   *  follow-up cold-starts a daemon after the previous one died (the live-daemon reconnect never forks). */
  resume?: boolean
  /** The frizz WORKER ENVIRONMENT — the SDK equivalents of the argv path's --plugin-dir/--mcp-config
   *  injection. Without these a broker worker is bare: no frizz sub-agent profiles, no frizz MCP,
   *  no cc-worker hooks. `pluginDir` loads the local cc-worker plugin; `mcpServers`/`allowedTools` mount + pre-approve
   *  the MCP servers; `workerEnv` carries the per-thread frizz vars the plugin hooks gate on (FRIZZ_THREAD,
   *  FRIZZ_PERM_DIR) — merged into the SDK env AFTER the ambient allowlist. */
  pluginDir?: string
  mcpServers?: WorkerMcpServers
  allowedTools?: string[]
  workerEnv?: Record<string, string>
  /** When set, the daemon writes a discovery record here after its socket is listening. */
  recordPath?: string
  /** When set, the daemon appends its OWN lifecycle/stderr diagnostics here, synchronously. This is
   *  how a crash survives: relaying to an attached client loses every death that happens while frizz is
   *  detached (a restart), and an in-memory backlog dies with the process it is recording. */
  diagnosticLogPath?: string
  /** Stable identity of THIS app-server process — unchanged across frizz restarts, new only when the
   *  session itself is re-forked. Lets frizz tell whether in-flight work survived a reconnect. */
  generation?: string
}

export interface BrokerRecord {
  daemonPid: number
  socketPath: string
  sessionId: string
  generation: string
  createdAt: string
  capabilities?: string[]
  /** The auto-compact ceiling this daemon's worker environment actually carries
   *  (CLAUDE_CODE_AUTO_COMPACT_WINDOW), echoed onto the record because it is a FORK-TIME property: a
   *  daemon keeps the value it was forked with while Settings moves on underneath it, and after a frizz
   *  restart the record is the only thing left that remembers which value that was. Read by the bridge
   *  to give the board a denominator the session genuinely runs under. Absent ⇒ nothing was set, or the
   *  daemon predates this field. */
  compactionWindow?: number
}

// What THIS daemon build understands, stamped into its record so the bridge can tell an old surviving
// daemon from a current one. The constant itself lives in the PROTOCOL module, not here: this file is
// also the detached daemon's process entry point and throws at module scope when it is loaded as one
// without FRIZZ_CLAUDE_BROKER. In the promoted artifact every module is one bundle, so a plain `import`
// of a VALUE from here — rather than an `import type` — initializes this module inside the server
// process, where the entry-point check is satisfied by the bundle's own path and the guard fires. That
// took down the whole control plane on the artifact while dev source (separate files) stayed green.
const BROKER_CAPABILITIES = [CLAUDE_BROKER_CAPABILITY_SUBAGENT_STEER, CLAUDE_BROKER_CAPABILITY_CANCEL_INPUT, CLAUDE_BROKER_CAPABILITY_STOP_TASK, CLAUDE_BROKER_CAPABILITY_RELOAD_PLUGINS, CLAUDE_BROKER_CAPABILITY_RENAME, CLAUDE_BROKER_CAPABILITY_LIST_SKILLS]

const IDLE_EXIT_MS = 6 * 60 * 60 * 1000
const REACHABILITY_CHECK_MS = 30_000
const REACHABILITY_STRIKES = 2
// Consecutive event-stream mapping failures tolerated before the session is treated as genuinely
// broken. One bad event must not end hours of work; an endlessly throwing stream must not spin.
const EVENT_ERROR_TOLERANCE = 5

export interface RunningBroker { close: () => Promise<void>; sessionId: string; generation: string }

export function runClaudeBroker(config: ClaudeBrokerConfig): RunningBroker {
  const generation = config.generation ?? randomUUID()
  let client: net.Socket | null = null
  // 20,000 frames was the only bound; see emitEvent for why bytes matter more than count.
  const MAX_BACKLOG_FRAMES = 20_000
  /** 64 MB of replay is a long detached window at the measured mean (~5 KB/frame ⇒ ~12,000 frames). */
  const MAX_BACKLOG_BYTES = 64 * 1024 * 1024
  const eventBacklog: string[] = []
  let eventBacklogBytes = 0
  const pendingPermissions = new Map<string, { request: ClaudePermissionRequest; resolve: (d: ClaudePermissionDecision) => void }>()
  let permSeq = 0
  let published = false
  let idleTimer: NodeJS.Timeout | undefined
  let strikes = 0

  const write = (sock: net.Socket, frame: unknown) => sock.write(JSON.stringify(frame) + "\n")
  const emitEvent = (event: ClaudeQueryEvent) => {
    if (client) write(client, { t: "event", event })
    else {
      // CAPPED ON BOTH AXES. The count cap alone bounds the wrong quantity: measured over 108,718 real
      // records of the maintainer's largest thread, a frame is 0.7 KB at p50 but 193 KB at p99 and
      // 568 KB at the max — so 20,000 frames is ~105 MB of backlog at the MEAN and ~500 MB at the
      // large end, per detached session. And it only fills WHILE DETACHED, which is precisely a frizz
      // restart, when several daemons are detached at once.
      const frame = JSON.stringify({ t: "event", event }) + "\n"
      eventBacklog.push(frame)
      eventBacklogBytes += Buffer.byteLength(frame)
      // Drops the OLDEST first, the same semantic the count cap already had: a reconnecting client
      // would rather have the recent story complete than the whole story truncated at the end.
      while (eventBacklog.length > MAX_BACKLOG_FRAMES || eventBacklogBytes > MAX_BACKLOG_BYTES) {
        const dropped = eventBacklog.shift()
        if (dropped === undefined) break
        eventBacklogBytes -= Buffer.byteLength(dropped)
      }
    }
  }

  const writeDiagnostic = config.diagnosticLogPath
    ? createClaudeBrokerDiagnosticWriter(config.diagnosticLogPath, { daemonPid: process.pid, generation })
    : undefined
  // WHY this daemon ended, written by the daemon on its way out. The bridge only ever observes an
  // absent record + a closed socket, which is the same picture for an idle collection, a SIGTERM, a
  // self-collection and a crash — so without this every broker death reported as the generic "the
  // thread went quiet." Same file as the diagnostics above, so the stderr that preceded a death and
  // the death itself read as one story. See ClaudeBrokerExitReason for the vocabulary.
  const writeExit = config.diagnosticLogPath
    ? createClaudeBrokerExitWriter(config.diagnosticLogPath, { daemonPid: process.pid, generation })
    : undefined

  // Tell a sweeping Frizz (runtimes.ts) that this daemon still runs out of that version directory.
  // A daemon outlives the server that forked it, so the server's own lease is not enough.
  const releaseRuntimeLease = leaseRuntime(config.executablePath, "claude-broker")
  const factory = createClaudeQueryFactory({ enabled: true, executablePath: config.executablePath })
  // The worker inherits frizz's environment minus frizz's own control plane (see worker-env.ts). The
  // frizz worker vars it DOES need (FRIZZ_THREAD, FRIZZ_PERM_DIR) ride workerEnv and are merged on
  // top — which is also what gives them THIS thread's values instead of the server's.
  const env = { ...inheritWorkerEnvironment(config.env), ...(config.workerEnv ?? {}) }
  const handle = factory.start({
    cwd: config.cwd,
    session: config.resume ? { kind: "resume", sessionId: config.sessionId } : { kind: "new", sessionId: config.sessionId },
    permissionMode: config.permissionMode ?? "default",
    env,
    persistSession: true, // write the tailer-readable transcript JSONL
    appendSystemPrompt: config.appendSystemPrompt,
    model: config.model,
    effort: config.effort,
    pluginDir: config.pluginDir,
    // The WHOLE MCP surface of this thread, and STRICT so the CLI discovers nothing else: the project's
    // approved `.mcp.json` (and the operator's remote user-scope servers) under the frizz mount, which
    // wins a name collision. Read at every fork, not once per project, so a `.mcp.json` edit reaches the
    // next dispatch the way it reaches the next plain `claude`. project-mcp-servers.ts has the reasons.
    mcpServers: workerMcpServers(projectMcpServers(config.cwd, { env }), config.mcpServers),
    strictMcpConfig: true,
    allowedTools: config.allowedTools,
    // The same prohibition as the argv path (WORKER_DISALLOWED_TOOLS). This path kept AskUserQuestion
    // until 2026-09-30 because canUseTool could render it as a real dashboard card — but the tool's own
    // schema caps a question at FOUR options, and a worker asked to "suggest 10 names" answered with three
    // and "keep it". `mcp__frizz__ask` has no cap, so the capped tool is taken away rather than rendered.
    disallowedTools: WORKER_DISALLOWED_TOOLS,
    canUseTool: async (request, context) => {
      const requestId = `perm-${++permSeq}`
      return await new Promise<ClaudePermissionDecision>((resolve) => {
        // Abort-aware: interrupting the turn (or the session ending) aborts the SDK's permission
        // callback, and a request left in `pendingPermissions` after that is not merely a leak — the
        // reconnect handler REPLAYS every pending request to the next frizz that attaches, which would
        // put a card in front of the operator for a tool call that no longer exists. So an abort
        // settles the waiter with a deny and drops it, exactly like an answer would.
        let settled = false
        const settle = (decision: ClaudePermissionDecision) => {
          if (settled) return
          settled = true
          pendingPermissions.delete(requestId)
          resolve(decision)
        }
        pendingPermissions.set(requestId, { request, resolve: settle })
        if (context.signal.aborted) settle({ behavior: "deny", message: "The turn was interrupted before this was answered." })
        else context.signal.addEventListener("abort", () => settle({ behavior: "deny", message: "The turn was interrupted before this was answered." }), { once: true })
        if (!settled && client) write(client, { t: "permission-request", requestId, request })
      })
    },
    onDiagnostic: (diagnostic: ClaudeDiagnostic) => {
      // Persist FIRST, then relay. A `crashed` diagnostic is emitted with the process seconds from
      // gone, and relaying only reaches a frizz that happens to be attached right now.
      writeDiagnostic?.(diagnostic)
      if (client) write(client, { t: "diagnostic", diagnostic })
    },
  })

  // ASK Claude to name the session, once, from the dispatch prompt.
  //
  // Claude Code normally titles a session by itself on the first user message and appends an
  // `ai-title` record to the session JSONL — the record frizz's tailer folds into the board's
  // `aiTitle`, and without which the board shows "Spinning up a thread…" for 60s and then falls back
  // to a truncation of the raw dispatch prompt forever. That automatic titling is SUPPRESSED on the
  // Agent-SDK (headless) transport whenever a `SessionStart` hook is registered — and frizz's broker
  // always loads the cc-worker plugin, whose hooks.json registers SessionStart. Bisected live against
  // 2.1.220: a plugin carrying ONLY a no-op `SessionStart` hook yields NO ai-title and never even
  // dispatches the titler's API request, while the same plugin carrying only PreToolUse / PostToolUse
  // / PermissionRequest hooks titles normally. It is provider behavior frizz cannot switch off without
  // giving up the worker seeding, so the broker asks explicitly instead: the SDK's
  // `generate_session_title` control request with `persist: true` runs the SAME titler and writes the
  // SAME `ai-title` record, so nothing downstream of the JSONL changes.
  //
  // Fired on the FIRST input only, and only for a session this daemon STARTED: a resume re-attaches to
  // a transcript that already carries its title, and a follow-up must never rename the thread.
  // Deliberately not awaited by the caller (a title must never delay the turn) but tracked here so a
  // failure is a diagnostic rather than an unhandled rejection.
  let titleSeeded = config.resume === true
  const seedSessionTitle = (message: ClaudeInputMessage): void => {
    if (titleSeeded) return
    // An ADDRESSED message is a steer aimed at one running sub-agent, not this thread's opening
    // prompt. Titling the whole thread "fix the flaky assertion in the child you dispatched" would
    // name the session after a side conversation, so addressing disqualifies a message from seeding.
    if (message?.parentToolUseId) return
    const text = typeof message?.text === "string" ? message.text.trim() : ""
    if (!text) return
    titleSeeded = true
    void handle.generateSessionTitle(text).catch((error: unknown) => {
      writeDiagnostic?.({ kind: "stderr", message: `session-title request failed: ${error instanceof Error ? error.message : String(error)}`, truncated: false })
    })
  }

  // The session ending (claude exits) tears the daemon down — there is nothing left to hold.
  // The session ending (claude exits) tears the daemon down — there is nothing left to hold. But an
  // error out of the ITERATOR is a different thing entirely and used to be conflated with it: any
  // failure mapping one event to frizz's typed shape landed in this `.catch` and killed the daemon,
  // the claude process, and every in-flight sub-agent. Live on 2026-07-27 a single control character
  // in a Bash command did exactly that to a multi-hour orchestrator thread.
  //
  // The mapper no longer throws for that case (claude-agent-sdk.ts degrades an unrepresentable tool
  // input instead), but the conflation itself was the deeper bug: losing one telemetry event must
  // never be a reason to destroy hours of an operator's work. So a mapping failure is now recorded
  // and the pump continues; only the stream genuinely ENDING tears the session down.
  // `handle` is its own async iterator (claude-agent-sdk.ts: `[Symbol.asyncIterator]() { return this }`),
  // so pulling with next() is exactly what `for await` did — it just lets ONE bad event be survivable.
  // Bounded: a stream that keeps throwing is genuinely broken, and retrying it forever would spin the
  // daemon at 100% CPU, which is a worse failure than the one being fixed.
  const pump = (async (): Promise<{ reason: ClaudeBrokerExitReason; detail?: string }> => {
    let consecutiveErrors = 0
    for (;;) {
      let next: IteratorResult<ClaudeQueryEvent>
      try {
        next = await handle.next()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        writeDiagnostic?.({
          kind: "stderr",
          message: `event stream error ${++consecutiveErrors}/${EVENT_ERROR_TOLERANCE} (session continues): ${message}`,
          truncated: false,
        })
        // genuinely broken → end the session, and say which of the two endings this was: a stream that
        // kept throwing is a very different post-mortem from claude simply exiting.
        if (consecutiveErrors >= EVENT_ERROR_TOLERANCE) return { reason: "session-stream-broken", detail: message }
        continue
      }
      consecutiveErrors = 0
      if (next.done) return { reason: "session-stream-ended" }
      emitEvent(next.value)
    }
  })().then(
    (end) => shutdown(0, end.reason, end.detail),
    (error) => shutdown(0, "event-pump-failed", error instanceof Error ? error.message : String(error)),
  )

  // `closed` guards the re-arm: shutdown() clears this timer and THEN destroys the client, whose async
  // "close" handler lands here. Unguarded, that re-armed a fresh 6h timer on a dead broker — invisible
  // in the standalone daemon (process.exit follows) but it held an in-process host's event loop open
  // for 6h, which is how `claude-agent-broker.test.ts` hung a `nub --test` run for hours.
  const armIdle = () => { if (client || closed) return; clearTimeout(idleTimer); idleTimer = setTimeout(() => shutdown(0, "idle-timeout"), IDLE_EXIT_MS) }

  const server = net.createServer((sock) => {
    client = sock; clearTimeout(idleTimer)
    write(sock, { t: "hello", sessionId: handle.sessionId, generation })
    for (const [requestId, { request }] of pendingPermissions) write(sock, { t: "permission-request", requestId, request })
    while (eventBacklog.length) sock.write(eventBacklog.shift()!)
    eventBacklogBytes = 0
    let buf = ""
    sock.on("data", (chunk) => {
      buf += chunk
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (!line.trim()) continue
        let msg: Record<string, unknown>; try { msg = JSON.parse(line) } catch { continue }
        if (msg.t === "input") {
          const message = msg.message as ClaudeInputMessage
          // Record RECEIPT, not only failure. The drop path below fires ONLY when `handle.send`
          // REJECTS; a send that simply never completes — the agent wedged before it drains stdin — is
          // identically silent, so from this log the two were indistinguishable. That cost a whole
          // investigation on 2026-07-31: a thread whose agent never produced a transcript left a
          // diagnostics file containing one `started` line and nothing else, with no way to tell whether
          // the opening prompt had ever crossed this socket. One line per input settles it forever.
          // PERSISTED ONLY, never relayed to frizz: this is forensics, not an event the operator needs,
          // and the relay channel surfaces as worker stderr. Ids and sizes only — the message TEXT is
          // the operator's content and must never land in a diagnostics file.
          writeDiagnostic?.({
            kind: "stderr",
            message: `input received: id=${message?.id ?? "?"} chars=${typeof message?.text === "string" ? message.text.length : 0}${message?.parentToolUseId ? ` addressed=${message.parentToolUseId}` : ""}`,
            truncated: false,
          })
          // NEVER swallow this. The `input` frame carries no reply, so this catch was the only place a
          // refused send existed at all — and it threw the evidence away. frizz had already answered the
          // operator's RPC with success and opened an `enqueued` ledger item that by design never times
          // out, so the message rendered as delivered forever while the agent never saw a byte of it.
          // Measured live in _live_broker_input_drop.mts before the fix: zero diagnostics, zero errors,
          // message gone. The bridge now validates before the frame so the common refusals fail the
          // operator's own send; this reports the residue (a duplicate uuid, a full input queue, a handle
          // closing under the frame) on the same diagnostic channel every other drop site here uses.
          void handle.send(message).catch((error: unknown) => {
            const detail = error instanceof Error ? error.message : String(error)
            // NAME THE MESSAGE. The prefix alone told frizz that *something* was thrown away, which is
            // one grep better than silence but still leaves the ledger unable to act: it cannot tombstone
            // a row it cannot identify, so a refused send sat at `enqueued` for the full hour
            // `ageDeliveries` grants a queue entry — pretending to be held by a daemon that had in fact
            // refused it. The id is the DELIVERY id frizz opened the ledger row under, so carrying it here
            // is what lets the server retire exactly that row and hand the operator their text back.
            // Ids only, never the text — same rule as the `input received` line above.
            const droppedId = typeof message?.id === "string" ? ` id=${message.id}` : ""
            const diagnostic = { kind: "stderr" as const, message: `${CLAUDE_INPUT_DROP_DIAGNOSTIC_PREFIX}:${droppedId} ${detail}`, truncated: false }
            // Persist FIRST, then relay — same order and reasoning as the SDK's onDiagnostic above: a
            // drop is worth attributing even when no frizz is attached to hear it right now.
            writeDiagnostic?.(diagnostic)
            if (client) write(client, { t: "diagnostic", diagnostic })
          })
          seedSessionTitle(message)
        }
        else if (msg.t === "permission") { const e = pendingPermissions.get(msg.requestId as string); if (e) { pendingPermissions.delete(msg.requestId as string); e.resolve(msg.decision as ClaudePermissionDecision) } }
        else if (msg.t === "interrupt") void handle.interrupt().catch(() => {})
        else if (msg.t === "cancel-input") {
          // ALWAYS answer, including on failure: the caller is blocked on this reply and a silent drop
          // would be indistinguishable from a wedged daemon. `sock` rather than `client` is deliberate —
          // the answer belongs to the connection that asked, even if a reconnect has already replaced it.
          const requestId = msg.requestId as string
          const id = typeof msg.id === "string" ? msg.id : ""
          void handle.cancelInput(id).then(
            (cancelled) => write(sock, { t: "cancel-result", requestId, cancelled }),
            (error: unknown) => write(sock, { t: "cancel-result", requestId, cancelled: false, error: error instanceof Error ? error.message : String(error) }),
          )
        }
        else if (msg.t === "stop-task") {
          const requestId = msg.requestId as string
          const taskId = typeof msg.taskId === "string" ? msg.taskId : ""
          void handle.stopTask(taskId).then(
            () => write(sock, { t: "stop-result", requestId }),
            (error: unknown) => write(sock, { t: "stop-result", requestId, error: error instanceof Error ? error.message : String(error) }),
          )
        }
        else if (msg.t === "rename") {
          // On-demand re-title, the SDK equivalent of typing `/rename` at an interactive prompt. Same
          // request/response discipline as the other control actions: the caller is blocked on the
          // title, so a silent drop would read as a wedged daemon rather than a failed rename.
          const requestId = msg.requestId as string
          const description = typeof msg.description === "string" ? msg.description : ""
          void handle.generateSessionTitle(description).then(
            (title) => write(sock, { t: "rename-result", requestId, title }),
            (error: unknown) => write(sock, { t: "rename-result", requestId, error: error instanceof Error ? error.message : String(error) }),
          )
        }
        else if (msg.t === "reload-plugins") {
          // Answers on `sock` for the same reason cancel-input does: the caller is blocked on this
          // reply, and a silent drop reads as a wedged daemon rather than a failed reload.
          const requestId = msg.requestId as string
          void handle.reloadPlugins().then(
            (reloaded) => write(sock, { t: "reload-result", requestId, reloaded }),
            (error: unknown) => write(sock, { t: "reload-result", requestId, error: error instanceof Error ? error.message : String(error) }),
          )
        }
        else if (msg.t === "list-skills") {
          // Same request/response discipline as reload-plugins: the composer typeahead is blocked on
          // this answer, and a silent drop reads as a wedged daemon rather than an unlistable session.
          const requestId = msg.requestId as string
          void handle.listSkills().then(
            (skills) => write(sock, { t: "skills-result", requestId, skills }),
            (error: unknown) => write(sock, { t: "skills-result", requestId, error: error instanceof Error ? error.message : String(error) }),
          )
        }
        else if (msg.t === "set-mode") void handle.setPermissionMode(msg.mode as never).catch(() => {})
      }
    })
    sock.on("close", () => { if (client === sock) { client = null; armIdle() } }) // frizz gone; the session stays alive
    sock.on("error", () => {})
  })

  const recordOwner = (): number | null => {
    if (!config.recordPath) return null
    try { return (JSON.parse(readFileSync(config.recordPath, "utf8")) as BrokerRecord).daemonPid } catch { return null }
  }
  let closed = false
  // `reason` is recorded FIRST, before any teardown: `handle.close()` below can hang on a wedged CLI,
  // and a breadcrumb that only lands after a clean teardown is missing from exactly the deaths worth
  // attributing. Best-effort by construction (createClaudeBrokerExitWriter swallows everything), so
  // this can never be what stops a shutdown.
  async function shutdown(code: number, reason: ClaudeBrokerExitReason, detail?: string): Promise<void> {
    if (closed) return; closed = true
    writeExit?.(reason, detail)
    releaseRuntimeLease()
    clearTimeout(idleTimer); clearInterval(reach)
    // Owner-checked cleanup: never delete a successor's record/socket. A corpse whose record was
    // already overwritten must leave the live daemon's socket alone.
    const owner = recordOwner()
    if (config.recordPath && owner === process.pid) { try { unlinkSync(config.recordPath) } catch {} }
    if (!(published && owner !== null && owner !== process.pid) && published && process.platform !== "win32") { try { unlinkSync(config.socketPath) } catch {} }
    try { client?.destroy() } catch {}
    try { (server as { closeAllConnections?: () => void }).closeAllConnections?.() } catch {}
    try { server.close() } catch {}
    await handle.close().catch(() => {})
    if (config.recordPath) process.exit(code) // standalone daemon
  }

  // Reachability self-collection: if UNATTACHED and the record no longer names this pid (a successor
  // stole it, or it vanished), strike out and exit — so a claude process can't leak forever.
  const reach = setInterval(() => {
    if (client || !config.recordPath) { strikes = 0; return }
    const owner = recordOwner()
    if (owner === process.pid) { strikes = 0; return }
    // Undiscoverable and unattached: a successor stole the record, or a sweep removed it. If a turn was
    // mid-flight this is where it dies, and this reason is the fingerprint of that class of loss.
    if (++strikes >= REACHABILITY_STRIKES) void shutdown(0, "self-collected-record-reassigned")
  }, REACHABILITY_CHECK_MS)
  if (reach.unref) reach.unref()

  // A bind failure used to be an UNHANDLED 'error' event: node prints a stack and exits, and the host
  // spawns this daemon with stdio:"ignore" — so the stack goes nowhere, frizz sees only a 30s "did not
  // become ready", and the operator gets "the thread went quiet". Note the `claude` child is already
  // running by this point, so this is also the moment it leaks. Record the cause, then shut down.
  // Reachable via a swept stateDir, EACCES, a >104-byte socket path on macOS, or an EADDRINUSE race.
  server.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error)
    writeDiagnostic?.({ kind: "lifecycle", phase: "crashed", message: `socket listen failed: ${message}` })
    void shutdown(1, "socket-listen-failed", message)
  })
  try { unlinkSync(config.socketPath) } catch {} // sweep a stale unix socket before binding
  server.listen(config.socketPath, () => {
    published = true
    if (config.recordPath) {
      const record: BrokerRecord = { daemonPid: process.pid, socketPath: config.socketPath, sessionId: config.sessionId, generation, createdAt: new Date().toISOString(), capabilities: BROKER_CAPABILITIES, compactionWindow: claudeCompactionWindowOf(config.workerEnv) }
      try { writeFileSync(config.recordPath, JSON.stringify(record), { mode: 0o600 }) } catch {}
    }
    armIdle()
  })

  return { close: async () => { await shutdown(0, "frizz-requested") }, sessionId: handle.sessionId, generation }
}

/** Was node pointed AT THIS FILE, rather than this module being imported by something else?
 *
 *  Both sides go through realpath because the two are not otherwise comparable: node resolves ESM
 *  module URLs through the real path, while `process.argv[1]` is whatever string the spawner passed.
 *  On macOS a daemon spawned under a temp dir arrives as `/var/folders/…` and reports itself as
 *  `/private/var/folders/…` — a naive URL comparison silently answers "not the entry point" there,
 *  which is precisely the artifact-vs-dev divergence class that has bitten this daemon before. */
function startedAsProcessEntry(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry)
  } catch {
    return false
  }
}

// Standalone daemon entry: `nub claude-agent-broker.ts` with config in FRIZZ_CLAUDE_BROKER.
if (process.env.FRIZZ_CLAUDE_BROKER) {
  const config = JSON.parse(process.env.FRIZZ_CLAUDE_BROKER) as ClaudeBrokerConfig
  // A signal exits IMMEDIATELY and deliberately — it must not wait on a teardown that can hang — so it
  // never reaches shutdown()'s breadcrumb and used to leave no trace whatsoever. That covers frizz's own
  // killBroker (SIGTERM), an operator `kill`, and an OS shutdown: the three most common broker deaths
  // there are. Record the cause synchronously first; the handler is registered BEFORE the broker starts
  // (so a signal during startup is still attributed) and resolves the generation lazily.
  let running: RunningBroker | undefined
  const recordExit = (reason: ClaudeBrokerExitReason, detail?: string): void => {
    if (!config.diagnosticLogPath) return
    createClaudeBrokerExitWriter(config.diagnosticLogPath, {
      daemonPid: process.pid,
      generation: running?.generation ?? config.generation ?? "",
    })(reason, detail)
  }
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => {
      recordExit(`signal-${sig}`)
      process.exit(0)
    })
  }
  // The LAST-RESORT breadcrumb, and the reason this daemon's deaths were unattributable. Every other
  // exit path here records itself; a throw that reached nobody recorded nothing, and node's default —
  // print a stack, exit 1 — writes that stack to a stdio the host set to "ignore". So the log simply
  // ended on `started`, which is byte-identical to what a SIGKILL leaves. Measured across this machine's
  // whole broker corpus 2026-08-02: 276 daemon starts against 223 recorded exits, so 53 deaths (~19%)
  // had NO attribution at all, and no way to tell an external kill from frizz's own unhandled throw.
  //
  // Deliberately preserves node's semantics rather than swallowing: record, then exit NON-ZERO, exactly
  // as an unhandled throw would have. Installing these handlers is what suppresses the default exit, so
  // the explicit process.exit(1) is load-bearing — without it a crashed daemon would LINGER, wedged and
  // unreachable, which is strictly worse than dying.
  process.on("uncaughtException", (error) => {
    recordExit("uncaught-exception", error instanceof Error ? `${error.message}\n${error.stack ?? ""}`.slice(0, 2000) : String(error))
    process.exit(1)
  })
  process.on("unhandledRejection", (reason) => {
    recordExit("unhandled-rejection", reason instanceof Error ? `${reason.message}\n${reason.stack ?? ""}`.slice(0, 2000) : String(reason))
    process.exit(1)
  })
  running = runClaudeBroker(config)
} else if (startedAsProcessEntry()) {
  // Node was pointed AT THIS FILE and there is no configuration to broker. Exiting 0 here reports
  // success for a session that never started — the silent-death shape the detached-daemon closure
  // test exists to catch, and the reason that test has been red. Codex's daemon already fails this
  // way (readConfig throws when FRIZZ_CODEX_APP_SERVER_DAEMON is absent); match it.
  //
  // Gated on being the process ENTRY POINT, not merely on the env being absent: claude-broker-host
  // spawns `node <this file>` so argv[1] is exactly this module, while a test that IMPORTS
  // runClaudeBroker runs under the test runner's argv[1] and must keep loading cleanly.
  throw new Error("claude session broker started without FRIZZ_CLAUDE_BROKER")
}
