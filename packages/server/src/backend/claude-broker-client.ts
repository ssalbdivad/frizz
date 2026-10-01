// The frizz SIDE of the Claude session broker: a typed client that connects to a broker daemon's
// socket (see claude-agent-broker.ts) and speaks the same newline-delimited typed protocol. It
// auto-reconnects — both while the daemon is still binding right after spawn, and if the connection
// drops — which is exactly what lets frizz reattach to a LIVE session after frizz itself restarts.
import net from "node:net"
import { ThreadSkillSource } from "@frizz/shared"
import type {
  ClaudeDiagnostic,
  ClaudeInputMessage,
  ClaudePermissionDecision,
  ClaudePermissionRequest,
  ClaudePluginReload,
  ClaudeSkillInfo,
  ClaudeQueryEvent,
} from "./claude-agent-sdk-protocol.ts"

export interface ClaudeBrokerClientHandlers {
  /** A session/transcript event (init/assistant/user/result/…) from the live SDK session. */
  onEvent?: (event: ClaudeQueryEvent) => void
  /** A tool-permission request that must be answered with answerPermission(requestId, …). */
  onPermissionRequest?: (requestId: string, request: ClaudePermissionRequest) => void
  onDiagnostic?: (diagnostic: ClaudeDiagnostic) => void
  /** Sent on every (re)connect; carries the broker's session id. */
  onHello?: (sessionId: string) => void
  onConnect?: () => void
  onDisconnect?: () => void
}

export interface ClaudeBrokerClient {
  sendInput(message: ClaudeInputMessage): void
  answerPermission(requestId: string, decision: ClaudePermissionDecision): void
  /**
   * Abort the running turn. `ifQueued` makes it a PUSH: the daemon interrupts only while an input is
   * still waiting to be read, so a push behind a queue that has already been read cannot abort the turn
   * reading it. A daemon predating the flag ignores it and interrupts as before.
   */
  interrupt(options?: { ifQueued?: boolean }): void
  /**
   * Take a still-queued input back out of the session, by the id `sendInput` supplied. The ONE
   * round-trip in this protocol: resolves with the CLI's own verdict (true ⇒ the agent will never
   * read it), rejects when the daemon does not answer inside the deadline. Never resolves optimistically —
   * a caller that cannot tell "unqueued" from "already delivered" has nothing to tell the operator.
   */
  cancelInput(id: string): Promise<boolean>
  /** Stop one provider background task and resolve only after the daemon confirms the SDK call. */
  stopTask(taskId: string): Promise<void>
  /**
   * Re-read the worker plugin closure from disk in the LIVE session — hooks, skills, agent profiles,
   * MCP servers — and resolve with what changed. Resolves only after the SDK answered, so the operator
   * is told what actually reloaded rather than that a frame was written.
   */
  reloadPlugins(): Promise<ClaudePluginReload>
  /** Re-title the live session through the provider (the SDK's `generateSessionTitle`). */
  renameSession(description: string): Promise<string | undefined>
  /** The session's invocable skills, as the harness reports them (names + descriptions). */
  listSkills(): Promise<ClaudeSkillInfo[]>
  setPermissionMode(mode: string): void
  connected(): boolean
  /**
   * Has this client PERMANENTLY given up? Distinct from `connected()`, and the distinction is the
   * whole point: a disconnected client is reconnecting and will flush what it buffered, while a
   * closed one never will — every frame handed to it from here is discarded.
   *
   * Callers holding a session across time need this to tell "wait, it's coming back" from "this
   * client is a corpse, get a new one". `connected()` cannot answer that: it reads false during an
   * ordinary blip, so keying liveness on it would churn a healthy session.
   */
  isClosed(): boolean
  close(): void
}

interface Options {
  /** Give up (call onDisconnect for good) after this long without a connection. Default 30s. */
  connectDeadlineMs?: number
  retryDelayMs?: number
  /** How long a `cancelInput` waits for the daemon's verdict before rejecting. Default 10s. */
  cancelTimeoutMs?: number
  reloadTimeoutMs?: number
}

// Derived from the shared enum rather than re-spelled, so the router's strict zod and this guard can
// never drift apart — which is the only way an out-of-vocabulary value could reach the wire check.
const SKILL_SOURCES: ReadonlySet<string> = new Set(ThreadSkillSource.options)

export function connectClaudeBroker(
  socketPath: string,
  handlers: ClaudeBrokerClientHandlers,
  options: Options = {},
): ClaudeBrokerClient {
  const retryDelayMs = options.retryDelayMs ?? 250
  const cancelTimeoutMs = options.cancelTimeoutMs ?? 10_000
  // A reload re-scans the plugin closure and may re-handshake MCP servers, so it is genuinely slower
  // than the bookkeeping answers cancel/stop give. Still bounded: a wedged daemon must not hang a click.
  const reloadTimeoutMs = options.reloadTimeoutMs ?? 30_000
  let sock: net.Socket | null = null
  let closed = false
  let buf = ""
  const outbound: string[] = [] // frames queued while not connected (e.g. the first prompt sent right after spawn)
  let firstConnectDeadline = Date.now() + (options.connectDeadlineMs ?? 30_000)
  // In-flight cancelInput round-trips, keyed by the request id echoed on the reply.
  const pendingCancels = new Map<string, { settle: (cancelled: boolean) => void; fail: (error: Error) => void; timer: NodeJS.Timeout }>()
  const pendingStops = new Map<string, { settle: () => void; fail: (error: Error) => void; timer: NodeJS.Timeout }>()
  const pendingReloads = new Map<string, { settle: (r: ClaudePluginReload) => void; fail: (error: Error) => void; timer: NodeJS.Timeout }>()
  const pendingRenames = new Map<string, { settle: (t: string | undefined) => void; fail: (error: Error) => void; timer: NodeJS.Timeout }>()
  const pendingSkills = new Map<string, { settle: (s: ClaudeSkillInfo[]) => void; fail: (error: Error) => void; timer: NodeJS.Timeout }>()
  let cancelSeq = 0

  // Buffering while DISCONNECTED is the feature — `connect` flushes `outbound` — but buffering while
  // CLOSED is a silent hole: nothing will ever reconnect to drain it, so the frame is discarded with
  // the caller told nothing. That is the exact shape of "the thread went quiet": `sendInput` returns
  // void, so followUp resolves, so the router opens an `enqueued` ledger item, and the operator
  // watches a message the agent will never see render as delivered until it ages out an hour later.
  // Throw instead, so the refusal reaches the operator's own send and the optimistic bubble rolls back.
  const send = (frame: unknown): void => {
    if (closed) throw new Error("the broker connection is closed")
    const line = JSON.stringify(frame) + "\n"
    if (sock && !sock.destroyed) sock.write(line)
    else outbound.push(line)
  }

  const onData = (chunk: Buffer): void => {
    buf += chunk
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      let frame: Record<string, unknown>
      try { frame = JSON.parse(line) } catch { continue }
      switch (frame.t) {
        case "hello": handlers.onHello?.(frame.sessionId as string); break
        case "event": handlers.onEvent?.(frame.event as ClaudeQueryEvent); break
        case "permission-request": handlers.onPermissionRequest?.(frame.requestId as string, frame.request as ClaudePermissionRequest); break
        case "diagnostic": handlers.onDiagnostic?.(frame.diagnostic as ClaudeDiagnostic); break
        case "cancel-result": {
          const entry = pendingCancels.get(frame.requestId as string)
          if (!entry) break
          pendingCancels.delete(frame.requestId as string)
          clearTimeout(entry.timer)
          // The daemon reports its own failure rather than dropping the request; surface it verbatim
          // so the operator learns WHY their message could not be taken back.
          if (typeof frame.error === "string" && frame.error) entry.fail(new Error(frame.error))
          else entry.settle(frame.cancelled === true)
          break
        }
        case "stop-result": {
          const entry = pendingStops.get(frame.requestId as string)
          if (!entry) break
          pendingStops.delete(frame.requestId as string)
          clearTimeout(entry.timer)
          if (typeof frame.error === "string" && frame.error) entry.fail(new Error(frame.error))
          else entry.settle()
          break
        }
        case "rename-result": {
          const entry = pendingRenames.get(frame.requestId as string)
          if (!entry) break
          pendingRenames.delete(frame.requestId as string)
          clearTimeout(entry.timer)
          if (typeof frame.error === "string" && frame.error) entry.fail(new Error(frame.error))
          else entry.settle(typeof frame.title === "string" ? frame.title : undefined)
          break
        }
        case "reload-result": {
          const entry = pendingReloads.get(frame.requestId as string)
          if (!entry) break
          pendingReloads.delete(frame.requestId as string)
          clearTimeout(entry.timer)
          if (typeof frame.error === "string" && frame.error) entry.fail(new Error(frame.error))
          else entry.settle(frame.reloaded as ClaudePluginReload)
          break
        }
        case "skills-result": {
          const entry = pendingSkills.get(frame.requestId as string)
          if (!entry) break
          pendingSkills.delete(frame.requestId as string)
          clearTimeout(entry.timer)
          if (typeof frame.error === "string" && frame.error) entry.fail(new Error(frame.error))
          // Keep only well-shaped rows: the daemon already bounds them, but a frame is still a frame.
          // `source` is re-checked against the closed set rather than relayed: the router hands these
          // straight to a strict zod enum, so an out-of-vocabulary value from a mismatched daemon would
          // fail the WHOLE listing instead of costing one row its label.
          else entry.settle((Array.isArray(frame.skills) ? frame.skills : [])
            .filter((s: unknown): s is ClaudeSkillInfo => typeof (s as ClaudeSkillInfo)?.name === "string" && typeof (s as ClaudeSkillInfo)?.description === "string")
            .map((s) => ({ name: s.name, description: s.description, source: SKILL_SOURCES.has(s.source as string) ? s.source : undefined })))
          break
        }
      }
    }
  }

  const connect = (): void => {
    if (closed) return
    const next = net.connect(socketPath)
    next.on("connect", () => { sock = next; buf = ""; firstConnectDeadline = Number.POSITIVE_INFINITY; while (outbound.length) next.write(outbound.shift()!); handlers.onConnect?.() })
    next.on("data", onData)
    const drop = (): void => {
      if (next === sock) { sock = null; handlers.onDisconnect?.() }
      if (closed) return
      // Keep retrying: the daemon may still be binding (right after spawn), or the link dropped and
      // the session is still alive behind it. Only give up if we never connected within the deadline.
      if (sock === null && Date.now() > firstConnectDeadline) { closed = true; return }
      setTimeout(connect, retryDelayMs)
    }
    next.on("close", drop)
    next.on("error", () => next.destroy())
  }
  connect()

  return {
    sendInput: (message: ClaudeInputMessage) => send({ t: "input", message }),
    answerPermission: (requestId: string, decision: ClaudePermissionDecision) => send({ t: "permission", requestId, decision }),
    interrupt: (options?: { ifQueued?: boolean }) => send(options?.ifQueued ? { t: "interrupt", ifQueued: true } : { t: "interrupt" }),
    cancelInput: (id: string) => new Promise<boolean>((resolve, reject) => {
      if (closed) { reject(new Error("the broker connection is closed")); return }
      const requestId = `cancel-${++cancelSeq}`
      const timer = setTimeout(() => {
        pendingCancels.delete(requestId)
        reject(new Error("the Claude session did not answer the unqueue request"))
      }, cancelTimeoutMs)
      if (timer.unref) timer.unref()
      pendingCancels.set(requestId, { settle: resolve, fail: reject, timer })
      // Rides the same `send` as every other frame, so a request issued in the sliver between a socket
      // blip and its reconnect is replayed rather than lost — and if the daemon never comes back, the
      // deadline above is what answers instead.
      send({ t: "cancel-input", requestId, id })
    }),
    stopTask: (taskId: string) => new Promise<void>((resolve, reject) => {
      if (closed) { reject(new Error("the broker connection is closed")); return }
      const requestId = `stop-${++cancelSeq}`
      const timer = setTimeout(() => {
        pendingStops.delete(requestId)
        reject(new Error("the Claude session did not answer the stop request"))
      }, cancelTimeoutMs)
      if (timer.unref) timer.unref()
      pendingStops.set(requestId, { settle: resolve, fail: reject, timer })
      send({ t: "stop-task", requestId, taskId })
    }),
    // A reload re-scans the plugin closure and can re-handshake MCP servers, so it gets a longer
    // deadline than an unqueue/stop — those are answered by bookkeeping the CLI already holds.
    reloadPlugins: () => new Promise<ClaudePluginReload>((resolve, reject) => {
      if (closed) { reject(new Error("the broker connection is closed")); return }
      const requestId = `reload-${++cancelSeq}`
      const timer = setTimeout(() => {
        pendingReloads.delete(requestId)
        reject(new Error("the Claude session did not answer the plugin reload"))
      }, reloadTimeoutMs)
      if (timer.unref) timer.unref()
      pendingReloads.set(requestId, { settle: resolve, fail: reject, timer })
      send({ t: "reload-plugins", requestId })
    }),
    // The skill list is answered from the SDK's own memory (captured at initialize), so it shares the
    // short cancel deadline rather than the reload one.
    listSkills: () => new Promise<ClaudeSkillInfo[]>((resolve, reject) => {
      if (closed) { reject(new Error("the broker connection is closed")); return }
      const requestId = `skills-${++cancelSeq}`
      const timer = setTimeout(() => {
        pendingSkills.delete(requestId)
        reject(new Error("the Claude session did not answer the skill listing"))
      }, cancelTimeoutMs)
      if (timer.unref) timer.unref()
      pendingSkills.set(requestId, { settle: resolve, fail: reject, timer })
      send({ t: "list-skills", requestId })
    }),
    // Shares the reload deadline: a re-title is a provider round trip, not local bookkeeping.
    renameSession: (description: string) => new Promise<string | undefined>((resolve, reject) => {
      if (closed) { reject(new Error("the broker connection is closed")); return }
      const requestId = `rename-${++cancelSeq}`
      const timer = setTimeout(() => {
        pendingRenames.delete(requestId)
        reject(new Error("the Claude session did not answer the rename request"))
      }, reloadTimeoutMs)
      if (timer.unref) timer.unref()
      pendingRenames.set(requestId, { settle: resolve, fail: reject, timer })
      send({ t: "rename", requestId, description })
    }),
    setPermissionMode: (mode: string) => send({ t: "set-mode", mode }),
    connected: () => sock !== null && !sock.destroyed,
    isClosed: () => closed,
    close: () => {
      closed = true
      for (const [, entry] of pendingCancels) { clearTimeout(entry.timer); entry.fail(new Error("the broker connection closed before the unqueue was answered")) }
      pendingCancels.clear()
      for (const [, entry] of pendingStops) { clearTimeout(entry.timer); entry.fail(new Error("the broker connection closed before the stop was answered")) }
      pendingStops.clear()
      for (const [, entry] of pendingReloads) { clearTimeout(entry.timer); entry.fail(new Error("the broker connection closed before the plugin reload was answered")) }
      pendingReloads.clear()
      for (const [, entry] of pendingRenames) { clearTimeout(entry.timer); entry.fail(new Error("the broker connection closed before the rename was answered")) }
      pendingRenames.clear()
      for (const [, entry] of pendingSkills) { clearTimeout(entry.timer); entry.fail(new Error("the broker connection closed before the skill listing was answered")) }
      pendingSkills.clear()
      pendingStops.clear()
      sock?.destroy(); sock = null
    },
  }
}
