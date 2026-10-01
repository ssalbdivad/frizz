// THE EDITOR SOCKET — this window's one live line to Frizz (`/_frizz/editor`, packages/shared
// editor-protocol.ts; design in plans/vscode-extension.md).
//
// The extension dials out: Frizz is a singleton with a known way to find it, every editor window is a
// client of it. Over the socket this window says which folders it has open and whether it has focus,
// and Frizz sends it files to open, folders to raise and the projects its folders belong to.
//
// What keeps it honest:
//   - Discovery runs again before EVERY attempt. The private port behind the restart supervisor moves on
//     each restart, and a Frizz started after this window opened has to be found, not remembered.
//   - The upgrade carries `Origin: http://127.0.0.1:<port>` — the server refuses a socket without one,
//     and the restart supervisor destroys it without even a status line. That is why this uses the `ws`
//     package: the WHATWG WebSocket cannot set Origin.
//   - Backoff from 1s to 30s, jittered so N windows a restart dropped do not stampede it together, and
//     reset by a `welcome` — not by a bare TCP connect, which a broken server also accepts.
//   - Silence is a dead link. Frizz sends `hb` every 15s; 45s without any frame and the socket is torn
//     down and dialled again (a sleeping laptop's socket can stay "open" for minutes after the far end
//     is gone).
//   - One log line per change of state, not per retry: a window left open on a stopped Frizz would
//     otherwise write a line every 30s for days.
//
// Pure node (no `vscode` import): the host interface is how the window is reached, and the tests drive
// this against a real `ws` server in-process.

import { randomUUID } from "node:crypto"
import WebSocket from "ws"
import {
  EDITOR_CLOSE,
  EDITOR_PROTOCOL_VERSION,
  EDITOR_SOCKET_PATH,
  type EditorClientMessage,
  type EditorComposeInput,
  type EditorComposed,
  type EditorFocus,
  type EditorHello,
  type EditorOpen,
  type EditorProject,
  type EditorServerMessage,
  type EditorState,
} from "@frizz/shared/editor-protocol"

export type ConnectionStatus =
  | { kind: "connecting" }
  | { kind: "connected"; origin: string; bootId: string }
  | { kind: "offline"; reason: string }
  | { kind: "incompatible"; reason: string }

export interface ConnectionLog {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface OpenResult {
  ok: boolean
  error?: string
}

export interface ConnectionHost {
  /** Where Frizz is now, or undefined; `detail` is for the log. */
  discover(): Promise<{ origin: string; detail: string } | undefined>
  /** Everything the hello carries about this window, read at the moment it is sent. */
  hello(): Omit<EditorHello, "t" | "v">
  state(): Omit<EditorState, "t">
  open(message: EditorOpen): Promise<OpenResult>
  focus(message: EditorFocus): Promise<OpenResult>
  projects(projects: EditorProject[]): void
  status(status: ConnectionStatus): void
  log: ConnectionLog
}

export interface ConnectionOptions {
  minBackoffMs?: number
  maxBackoffMs?: number
  /** No frame for this long and the link is presumed dead. */
  silenceMs?: number
  composeTimeoutMs?: number
  handshakeTimeoutMs?: number
  random?: () => number
}

/** Why the server closed us, in words the log and the status bar can use. */
export function describeClose(code: number, reason: string): { reason: string; incompatible: boolean } {
  const said = reason ? ` (${reason})` : ""
  switch (code) {
    case EDITOR_CLOSE.unsupportedVersion:
      return { reason: "This Frizz speaks a different version of the editor connection. Update Frizz or the extension.", incompatible: true }
    case EDITOR_CLOSE.invalidMessage:
      return { reason: `Frizz refused a message from this window${said}.`, incompatible: false }
    case EDITOR_CLOSE.helloRequired:
      return { reason: `Frizz expected this window to introduce itself first${said}.`, incompatible: false }
    case 1000:
      return { reason: `Frizz closed the connection${said}.`, incompatible: false }
    case 1001:
      return { reason: "Frizz is restarting.", incompatible: false }
    case 1006:
      return { reason: "The connection to Frizz dropped.", incompatible: false }
    default:
      return { reason: `Frizz closed the connection: code ${code}${said}.`, incompatible: false }
  }
}

function stateKey(state: Omit<EditorState, "t">): string {
  return JSON.stringify([state.folders, state.focused, state.acceptsOpens])
}

/** 1s, 2s, 4s … 30s, each ±20%. `attempt` counts from 0. */
export function backoffDelay(attempt: number, minMs: number, maxMs: number, random: () => number): number {
  const base = Math.min(maxMs, minMs * 2 ** Math.min(attempt, 30))
  return Math.min(maxMs, Math.round(base * (0.8 + 0.4 * random())))
}

export class EditorConnection {
  readonly #host: ConnectionHost
  readonly #minBackoffMs: number
  readonly #maxBackoffMs: number
  readonly #silenceMs: number
  readonly #composeTimeoutMs: number
  readonly #handshakeTimeoutMs: number
  readonly #random: () => number

  #running = false
  /** Bumped by every dial, so a dead socket's late events cannot touch the live one. */
  #generation = 0
  #socket: WebSocket | undefined
  #attempt = 0
  #retryTimer: NodeJS.Timeout | undefined
  #silenceTimer: NodeJS.Timeout | undefined
  #status: ConnectionStatus = { kind: "offline", reason: "Not started." }
  #origin: string | undefined
  #bootId: string | undefined
  #welcomed = false
  #lastState: string | undefined
  /** The state the hello carried, which becomes `#lastState` once Frizz welcomes it. */
  #helloState: string | undefined
  #lastLogged: string | undefined
  readonly #composes = new Map<string, { resolve: (value: EditorComposed) => void; timer: NodeJS.Timeout }>()

  constructor(host: ConnectionHost, options: ConnectionOptions = {}) {
    this.#host = host
    this.#minBackoffMs = options.minBackoffMs ?? 1_000
    this.#maxBackoffMs = options.maxBackoffMs ?? 30_000
    this.#silenceMs = options.silenceMs ?? 45_000
    this.#composeTimeoutMs = options.composeTimeoutMs ?? 10_000
    this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000
    this.#random = options.random ?? Math.random
  }

  get status(): ConnectionStatus {
    return this.#status
  }

  /** The origin of the Frizz this window is connected to (welcomed), else undefined. */
  get origin(): string | undefined {
    return this.#welcomed ? this.#origin : undefined
  }

  start(): void {
    if (this.#running) return
    this.#running = true
    this.#setStatus({ kind: "connecting" })
    void this.#dial()
  }

  /** Drop whatever is in flight and dial now, from a fresh discovery and a reset backoff. */
  reconnect(): void {
    if (!this.#running) return this.start()
    this.#attempt = 0
    this.#teardown(1000, "reconnecting")
    this.#setStatus({ kind: "connecting" })
    void this.#dial()
  }

  stop(): void {
    this.#running = false
    this.#teardown(1000, "window closing")
  }

  /** Tell Frizz this window's folders, focus or open-links setting changed. Unchanged state is not resent. */
  sendState(): void {
    if (!this.#welcomed) return
    const state = this.#host.state()
    const key = stateKey(state)
    if (key === this.#lastState) return
    if (this.#send({ t: "state", ...state })) this.#lastState = key
  }

  /** Hand Frizz something for the page's prompt box; resolves with its `composed` answer. */
  compose(item: EditorComposeInput): Promise<EditorComposed> {
    const id = randomUUID()
    if (!this.#welcomed || !this.#send({ t: "compose", id, item })) {
      return Promise.resolve({ t: "composed", id, ok: false, error: "Frizz isn't running." })
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#composes.delete(id)
        resolve({ t: "composed", id, ok: false, error: "Frizz didn't answer." })
      }, this.#composeTimeoutMs)
      this.#composes.set(id, { resolve, timer })
    })
  }

  #setStatus(status: ConnectionStatus): void {
    this.#status = status
    this.#host.status(status)
  }

  /** Log a line only when it differs from the last one — retries of one failure say it once. */
  #logOnce(level: keyof ConnectionLog, line: string): void {
    if (line === this.#lastLogged) return
    this.#lastLogged = line
    this.#host.log[level](line)
  }

  #teardown(code: number, reason: string): void {
    this.#generation++
    clearTimeout(this.#retryTimer)
    clearTimeout(this.#silenceTimer)
    this.#retryTimer = undefined
    this.#silenceTimer = undefined
    const socket = this.#socket
    this.#socket = undefined
    this.#welcomed = false
    this.#lastState = undefined
    this.#failComposes("The connection to Frizz closed.")
    if (socket) {
      socket.removeAllListeners()
      // A listener stays on 'error': a socket closed mid-handshake emits one, and an unheard 'error' throws.
      socket.on("error", () => {})
      if (socket.readyState === WebSocket.OPEN) socket.close(code, reason)
      else socket.terminate()
    }
  }

  #failComposes(error: string): void {
    for (const [id, pending] of this.#composes) {
      clearTimeout(pending.timer)
      pending.resolve({ t: "composed", id, ok: false, error })
    }
    this.#composes.clear()
  }

  #scheduleRetry(incompatible = false): void {
    if (!this.#running) return
    clearTimeout(this.#retryTimer)
    // An incompatible Frizz stays incompatible until someone updates it; ask at the slowest pace.
    const delay = incompatible ? this.#maxBackoffMs : backoffDelay(this.#attempt++, this.#minBackoffMs, this.#maxBackoffMs, this.#random)
    this.#retryTimer = setTimeout(() => void this.#dial(), delay)
  }

  #armSilence(generation: number): void {
    clearTimeout(this.#silenceTimer)
    this.#silenceTimer = setTimeout(() => {
      if (generation !== this.#generation) return
      this.#host.log.warn(`Frizz sent nothing for ${Math.round(this.#silenceMs / 1000)}s; reconnecting.`)
      this.#lastLogged = undefined
      this.#socket?.terminate()
    }, this.#silenceMs)
  }

  #send(message: EditorClientMessage): boolean {
    const socket = this.#socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(message))
    return true
  }

  async #dial(): Promise<void> {
    if (!this.#running) return
    const generation = ++this.#generation
    clearTimeout(this.#retryTimer)
    let found: { origin: string; detail: string } | undefined
    try {
      found = await this.#host.discover()
    } catch (error) {
      this.#host.log.error(`Looking for Frizz failed: ${(error as Error).message}`)
    }
    if (generation !== this.#generation || !this.#running) return
    if (!found) {
      const reason = "Frizz isn't running."
      this.#logOnce("info", `Frizz isn't running; looking again shortly.`)
      if (this.#status.kind !== "offline" || this.#status.reason !== reason) this.#setStatus({ kind: "offline", reason })
      this.#scheduleRetry()
      return
    }

    const { origin, detail } = found
    const url = `${origin.replace(/^http/u, "ws")}${EDITOR_SOCKET_PATH}`
    const socket = new WebSocket(url, { origin, handshakeTimeout: this.#handshakeTimeoutMs, maxPayload: 8 * 1024 * 1024 })
    this.#socket = socket
    this.#origin = origin
    let refusal: string | undefined

    socket.on("unexpected-response", (_request, response) => {
      // A Frizz from before the editor connection answers the upgrade with a plain 404.
      refusal = response.statusCode === 404
        ? "This Frizz has no editor connection yet. Update Frizz."
        : `Frizz refused the connection (HTTP ${response.statusCode}).`
      socket.terminate()
    })
    socket.on("error", (error) => {
      if (generation !== this.#generation) return
      refusal ??= (error as NodeJS.ErrnoException).code === "ECONNREFUSED" ? "Frizz isn't running." : `Couldn't reach Frizz: ${error.message}`
    })
    socket.on("open", () => {
      if (generation !== this.#generation) return
      this.#armSilence(generation)
      const hello = this.#host.hello()
      this.#helloState = stateKey(hello)
      this.#send({ t: "hello", v: EDITOR_PROTOCOL_VERSION, ...hello })
    })
    socket.on("message", (data) => {
      if (generation !== this.#generation) return
      this.#armSilence(generation)
      let message: EditorServerMessage
      try {
        message = JSON.parse(data.toString()) as EditorServerMessage
      } catch {
        this.#host.log.warn("Frizz sent a frame that is not JSON; ignored.")
        return
      }
      void this.#receive(message, generation, origin, detail)
    })
    socket.on("close", (code, buffer) => {
      if (generation !== this.#generation) return
      clearTimeout(this.#silenceTimer)
      this.#socket = undefined
      const wasWelcomed = this.#welcomed
      this.#welcomed = false
      this.#lastState = undefined
      this.#failComposes("The connection to Frizz closed.")
      const closed = refusal && !wasWelcomed ? { reason: refusal, incompatible: false } : describeClose(code, buffer.toString())
      this.#logOnce(closed.incompatible ? "error" : "warn", `${closed.reason}${refusal && !wasWelcomed ? "" : ` [${code}]`}`)
      this.#setStatus(closed.incompatible ? { kind: "incompatible", reason: closed.reason } : { kind: "offline", reason: closed.reason })
      this.#scheduleRetry(closed.incompatible)
    })
  }

  async #receive(message: EditorServerMessage, generation: number, origin: string, detail: string): Promise<void> {
    switch (message.t) {
      case "welcome": {
        const restarted = this.#bootId !== undefined && this.#bootId !== message.bootId
        this.#bootId = message.bootId
        this.#welcomed = true
        this.#attempt = 0
        this.#lastState = this.#helloState
        this.#lastLogged = undefined
        this.#host.log.info(`Connected to Frizz at ${origin} (${detail})${restarted ? "; Frizz restarted since the last connection" : ""}.`)
        this.#setStatus({ kind: "connected", origin, bootId: message.bootId })
        // Anything that changed between the hello and the welcome.
        this.sendState()
        return
      }
      case "projects":
        this.#host.projects(Array.isArray(message.projects) ? message.projects : [])
        return
      case "open":
      case "focus": {
        let result: OpenResult
        try {
          result = message.t === "open" ? await this.#host.open(message) : await this.#host.focus(message)
        } catch (error) {
          result = { ok: false, error: (error as Error).message }
        }
        if (generation !== this.#generation) return
        this.#send({ t: "result", id: message.id, ok: result.ok, ...(result.ok || !result.error ? {} : { error: result.error.slice(0, 1000) }) })
        return
      }
      case "composed": {
        const pending = this.#composes.get(message.id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.#composes.delete(message.id)
        pending.resolve(message)
        return
      }
      case "hb":
        return
      default:
        // A newer Frizz may say things this version does not know; ignoring them is the compatible answer.
        return
    }
  }
}
