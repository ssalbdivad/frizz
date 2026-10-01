import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { basename, sep } from "node:path"
import { WebSocketServer, type RawData, type WebSocket } from "ws"
import {
  EDITOR_CLOSE,
  EDITOR_PROTOCOL_VERSION,
  EDITOR_SOCKET_PATH,
  EditorClientMessageSchema,
  editorKindOf,
  queuedThread,
  workingThread,
  type EditorComposeItem,
  type EditorHello,
  type EditorKind,
  type EditorProject,
  type EditorServerMessage,
  type EditorWindowSummary,
  type FilePosition,
  type ServerEvent,
  type ThreadView,
} from "@frizz/shared"
import { isHomeWorkspace } from "./home-workspace.ts"
import { isUnder } from "./local-file.ts"
import { isTrustedLocalWebSocketRequest, rejectWebSocketUpgrade } from "./local-origin.ts"

// THE EDITOR BRIDGE — the server end of `/_frizz/editor`, the socket every VS Code / Cursor / Windsurf
// window running the Frizz extension (packages/vscode) dials. Design: plans/vscode-extension.md; the
// wire: @frizz/shared editor-protocol.ts.
//
// ONE PER MACHINE, like the server. index.ts builds it once beside the tenant map and answers the
// upgrade before tenant routing, and every project's router reaches it through `ctx.editors`: a
// window's folders can span several projects, and a file link clicked in any project's page has to be
// able to land in any window.
//
// What it holds is small and all in memory: the connected windows (their folders, focus and app), the
// requests waiting on a window's answer, and the selections an editor sent to the prompt box until a
// page claims one. Nothing survives a restart, and nothing needs to — the extension reconnects and says
// it all again in its hello.

export const EDITOR_MAX_WINDOWS = 32
/**
 * `ws`'s own frame ceiling, sized for a compose: its text may be 64 Ki UTF-16 units (the shared schema),
 * which is 64 KiB of ASCII but up to three times that as UTF-8. A frame past this is closed 1009 by `ws`
 * before it reaches a schema, so the extension caps a selection by its encoded size, not its length.
 */
export const EDITOR_MAX_PAYLOAD_BYTES = 128 * 1024
/** Every other frame is a hello, a state or a result, and none of those is anywhere near this. */
export const EDITOR_MAX_FRAME_BYTES = 64 * 1024
export const EDITOR_HEARTBEAT_MS = 15_000
export const EDITOR_PROJECTS_POLL_MS = 2_000
export const EDITOR_REQUEST_TIMEOUT_MS = 5_000
export const EDITOR_HELLO_TIMEOUT_MS = 10_000
export const EDITOR_COMPOSE_TTL_MS = 10 * 60_000
export const EDITOR_COMPOSE_MAX_ITEMS = 20

export interface EditorBridgeDeps {
  /** The server's boot id, read at each hello (the launching context's, which exists only once boot has built it). */
  bootId: () => string
  /** Every registered project and Home, with counts for the open ones (listEditorProjects). */
  listProjects: () => EditorProject[] | Promise<EditorProject[]>
  /** Publish on EVERY open project's bus: a page hears only its own project's. */
  publish: (event: ServerEvent) => void
  now?: () => number
  /** This server's `os.homedir()` / `process.platform` — what a window must share before it may take a file no folder of it holds. */
  home?: string
  platform?: string
  requestTimeoutMs?: number
  heartbeatMs?: number
  projectsPollMs?: number
  helloTimeoutMs?: number
  composeTtlMs?: number
  maxComposeItems?: number
  maxWindows?: number
}

export interface EditorBridge {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean
  close(): Promise<void>
  /** The connected windows, in the order they connected. */
  windows(): EditorWindowSummary[]
  /**
   * Hand a file to the editor window that should show it. True: a window opened it. False: no window
   * of `kinds` may take it, it did not answer in time, or it went away — the caller spawns the opener
   * instead. THROWS with the window's own words when it answered that it could not, because a second
   * opener would only fail the same way in another window.
   */
  openFile(path: string, position: FilePosition | undefined, kinds: readonly EditorKind[]): Promise<boolean>
  /** Raise a window of `kinds` that has `dir` open as a workspace folder. Same answers as openFile. */
  focusFolder(dir: string, kinds: readonly EditorKind[]): Promise<boolean>
  /** Claim a held compose item: that one, or with no id the oldest. Null when there is none (or it expired). */
  takeCompose(id?: string): EditorComposeItem | null
}

interface EditorWindow {
  windowId: string
  app: string
  kind: EditorKind
  folders: string[]
  focused: boolean
  /** The last moment this window was seen focused: when it gained focus, and again when it lost it. */
  lastFocusedAt: number
  acceptsOpens: boolean
  home: string
  platform: string
}

/** How a request to a window ended: its answer, or "gone" for a timeout or a dropped socket. */
type Outcome = { ok: true } | { ok: false; error?: string } | "gone"

interface Connection {
  ws: WebSocket
  /** Order of arrival — the last tie-break, so of two windows nobody has focused the newer one wins. */
  seq: number
  /** Set by the hello; until then the socket is not a window and nothing is routed to it. */
  window?: EditorWindow
  helloTimer?: NodeJS.Timeout
  missedPongs: number
  pending: Map<string, (outcome: Outcome) => void>
  /** The projects frame this window last got, so the poll re-sends only what changed. */
  sentProjects?: string
}

function rawText(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw
  if (Array.isArray(raw)) return Buffer.concat(raw)
  return Buffer.from(raw)
}

function realpathOrUndefined(path: string): string | undefined {
  try { return realpathSync(path) } catch { return undefined }
}

/**
 * `real` (a file under `realFolder`) spelled through the folder the WINDOW has open. A window whose
 * folder is a symlink (`/tmp` on macOS is `/private/tmp`; a checkout linked into `~/src`) shows a file
 * opened by its real path as one OUTSIDE its workspace — a separate tab with no git decorations — so
 * the path goes back in the window's own terms. Where the two do not share a string prefix (a Windows
 * path in another case, matched by identity) the real path is the honest answer.
 */
function spelledThrough(folder: string, realFolder: string, real: string): string {
  if (real === realFolder) return folder
  const prefix = realFolder.endsWith(sep) ? realFolder : realFolder + sep
  if (!real.startsWith(prefix)) return real
  const rest = real.slice(prefix.length)
  return folder.endsWith(sep) ? folder + rest : folder + sep + rest
}

/** Whether `a` was focused more recently than `b`; a window focused right now beats every other. */
function moreRecentlyFocused(a: Connection, b: Connection): boolean {
  const rank = (c: Connection) => (c.window!.focused ? Number.POSITIVE_INFINITY : c.window!.lastFocusedAt)
  const ra = rank(a)
  const rb = rank(b)
  return ra !== rb ? ra > rb : a.seq > b.seq
}

export function createEditorBridge(deps: EditorBridgeDeps): EditorBridge {
  const now = deps.now ?? Date.now
  const home = deps.home ?? homedir()
  const platform = deps.platform ?? process.platform
  const requestTimeoutMs = deps.requestTimeoutMs ?? EDITOR_REQUEST_TIMEOUT_MS
  const heartbeatMs = deps.heartbeatMs ?? EDITOR_HEARTBEAT_MS
  const projectsPollMs = deps.projectsPollMs ?? EDITOR_PROJECTS_POLL_MS
  const helloTimeoutMs = deps.helloTimeoutMs ?? EDITOR_HELLO_TIMEOUT_MS
  const composeTtlMs = deps.composeTtlMs ?? EDITOR_COMPOSE_TTL_MS
  const maxComposeItems = deps.maxComposeItems ?? EDITOR_COMPOSE_MAX_ITEMS
  const maxWindows = deps.maxWindows ?? EDITOR_MAX_WINDOWS

  const wss = new WebSocketServer({ noServer: true, maxPayload: EDITOR_MAX_PAYLOAD_BYTES })
  wss.on("error", () => {})
  const connections = new Set<Connection>()
  const terminationTimers = new WeakMap<WebSocket, NodeJS.Timeout>()
  let pendingUpgrades = 0
  let seq = 0
  let closing = false
  let closePromise: Promise<void> | null = null
  let heartbeatTimer: NodeJS.Timeout | undefined
  let projectsTimer: NodeJS.Timeout | undefined
  let projectsPoll: Promise<void> | null = null
  let projectsPollAgain = false
  // What the pages were last told, so a window's focus moving (which they do not show) publishes nothing.
  let publishedEditors = "[]"
  const compose: { item: EditorComposeItem; expiresAt: number }[] = []

  function send(conn: Connection, msg: EditorServerMessage): boolean {
    if (conn.ws.readyState !== conn.ws.OPEN) return false
    try {
      conn.ws.send(JSON.stringify(msg), () => {})
      return true
    } catch {
      return false
    }
  }

  function closeWith(conn: Connection, code: number, reason: string): void {
    const { ws } = conn
    if (ws.readyState === ws.CLOSED || ws.readyState === ws.CLOSING) return
    try {
      ws.close(code, reason)
      // A peer that stopped reading may never take the close frame; reclaim it after a short grace, as
      // the application socket does.
      const timer = setTimeout(() => {
        try { ws.terminate() } catch {}
      }, 250)
      timer.unref?.()
      terminationTimers.set(ws, timer)
    } catch {
      try { ws.terminate() } catch {}
    }
  }

  function summaries(): EditorWindowSummary[] {
    const out: EditorWindowSummary[] = []
    for (const conn of connections) {
      if (conn.window) out.push({ app: conn.window.app, kind: conn.window.kind, acceptsOpens: conn.window.acceptsOpens })
    }
    return out
  }

  // The `editors` event carries exactly what the page shows — app, family, whether opens are on — so it
  // goes out when one of those changes or a window comes or goes, and never for a focus change.
  function publishEditorsIfChanged(): void {
    if (closing) return
    const windows = summaries()
    const json = JSON.stringify(windows)
    if (json === publishedEditors) return
    publishedEditors = json
    try { deps.publish({ type: "editors", windows }) } catch {}
  }

  // An in-memory diff of the projects list, re-sent to each window whose last copy differs. Polled
  // rather than evented because the counts it carries are board facts of EVERY open project, and two
  // seconds of lag on a status-bar number is worth not threading a listener through each tenant's bus.
  async function pollProjects(): Promise<void> {
    if (projectsPoll) {
      projectsPollAgain = true
      return projectsPoll
    }
    projectsPoll = (async () => {
      do {
        projectsPollAgain = false
        if (closing || ![...connections].some((c) => c.window)) return
        let projects: EditorProject[]
        try {
          projects = await deps.listProjects()
        } catch {
          return // a registry read failing mid-write; the next tick tries again
        }
        const json = JSON.stringify(projects)
        for (const conn of connections) {
          if (!conn.window || conn.sentProjects === json) continue
          if (send(conn, { t: "projects", projects })) conn.sentProjects = json
        }
      } while (projectsPollAgain)
    })().finally(() => { projectsPoll = null })
    return projectsPoll
  }

  // Protocol pings reap a socket whose peer vanished without a close (a laptop lid, a killed extension
  // host); the `hb` frame is the extension's half — it reconnects when it hears none for 45s.
  function heartbeat(): void {
    for (const conn of connections) {
      if (conn.missedPongs >= 2) {
        try { conn.ws.terminate() } catch {}
        continue
      }
      conn.missedPongs++
      try { conn.ws.ping() } catch {}
      if (conn.window) send(conn, { t: "hb" })
    }
  }

  function startTimers(): void {
    if (!heartbeatTimer) {
      heartbeatTimer = setInterval(heartbeat, heartbeatMs)
      heartbeatTimer.unref?.()
    }
    if (!projectsTimer) {
      projectsTimer = setInterval(() => void pollProjects(), projectsPollMs)
      projectsTimer.unref?.()
    }
  }

  function stopTimers(): void {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    if (projectsTimer) clearInterval(projectsTimer)
    heartbeatTimer = undefined
    projectsTimer = undefined
  }

  function drop(conn: Connection): void {
    if (!connections.delete(conn)) return
    if (conn.helloTimer) clearTimeout(conn.helloTimer)
    const timer = terminationTimers.get(conn.ws)
    if (timer) clearTimeout(timer)
    for (const settle of [...conn.pending.values()]) settle("gone")
    if (conn.window) {
      conn.window = undefined
      publishEditorsIfChanged()
    }
    if (connections.size === 0) stopTimers()
  }

  function onHello(conn: Connection, msg: EditorHello): void {
    if (conn.helloTimer) clearTimeout(conn.helloTimer)
    // A window that reconnected before its old socket was reaped: the old one is dead weight that would
    // otherwise win an open, time out, and cost the human five seconds before the fallback.
    for (const other of connections) {
      if (other !== conn && other.window?.windowId === msg.windowId) {
        other.window = undefined
        closeWith(other, 1000, "superseded")
      }
    }
    conn.window = {
      windowId: msg.windowId,
      app: msg.app,
      kind: editorKindOf(msg.app),
      folders: msg.folders,
      focused: msg.focused,
      lastFocusedAt: msg.focused ? now() : 0,
      acceptsOpens: msg.acceptsOpens,
      home: msg.home,
      platform: msg.platform,
    }
    send(conn, { t: "welcome", v: EDITOR_PROTOCOL_VERSION, bootId: deps.bootId() })
    publishEditorsIfChanged()
    void pollProjects()
  }

  function onFrame(conn: Connection, raw: RawData, isBinary: boolean): void {
    const { ws } = conn
    if (closing || ws.readyState !== ws.OPEN) return
    if (isBinary) return closeWith(conn, EDITOR_CLOSE.invalidMessage, "text frames only")
    const bytes = rawText(raw)
    let decoded: unknown
    try {
      decoded = JSON.parse(bytes.toString("utf8"))
    } catch {
      return closeWith(conn, EDITOR_CLOSE.invalidMessage, "invalid frame")
    }
    const t = typeof decoded === "object" && decoded !== null ? (decoded as { t?: unknown }).t : undefined
    if (!conn.window) {
      if (t !== "hello") return closeWith(conn, EDITOR_CLOSE.helloRequired, "hello required")
      // Before the schema, which would call any other version merely invalid: the extension has to be
      // able to tell "update one of us" from "a bug".
      if ((decoded as { v?: unknown }).v !== EDITOR_PROTOCOL_VERSION) {
        return closeWith(conn, EDITOR_CLOSE.unsupportedVersion, `unsupported version; this Frizz speaks ${EDITOR_PROTOCOL_VERSION}`)
      }
    }
    if (t !== "compose" && bytes.length > EDITOR_MAX_FRAME_BYTES) return closeWith(conn, EDITOR_CLOSE.invalidMessage, "frame too large")
    const parsed = EditorClientMessageSchema.safeParse(decoded)
    if (!parsed.success) return closeWith(conn, EDITOR_CLOSE.invalidMessage, "invalid frame")
    const msg = parsed.data
    if (msg.t === "hello") {
      if (conn.window) return closeWith(conn, EDITOR_CLOSE.invalidMessage, "hello twice")
      return onHello(conn, msg)
    }
    const window = conn.window!
    if (msg.t === "state") {
      // Gaining focus and losing it both mean "focused until now"; that moment is what ranks windows.
      if (msg.focused || window.focused) window.lastFocusedAt = now()
      window.folders = msg.folders
      window.focused = msg.focused
      window.acceptsOpens = msg.acceptsOpens
      publishEditorsIfChanged()
      return
    }
    if (msg.t === "result") {
      conn.pending.get(msg.id)?.(msg.ok ? { ok: true } : { ok: false, error: msg.error })
      return
    }
    // compose: held for whichever page claims it (composeTake), announced to every open project's pages.
    pruneCompose()
    if (compose.length >= maxComposeItems) {
      send(conn, { t: "composed", id: msg.id, ok: false, error: `${maxComposeItems} selections are already waiting. Open Frizz to insert them.` })
      return
    }
    const at = now()
    const item: EditorComposeItem = { ...msg.item, id: randomUUID(), app: window.app, at: new Date(at).toISOString() }
    compose.push({ item, expiresAt: at + composeTtlMs })
    send(conn, { t: "composed", id: msg.id, ok: true })
    try { deps.publish({ type: "compose-pending", id: item.id }) } catch {}
  }

  function pruneCompose(): void {
    const at = now()
    for (let i = compose.length - 1; i >= 0; i--) if (compose[i]!.expiresAt <= at) compose.splice(i, 1)
  }

  function accept(ws: WebSocket): void {
    const conn: Connection = { ws, seq: ++seq, missedPongs: 0, pending: new Map() }
    connections.add(conn)
    conn.helloTimer = setTimeout(() => {
      if (!conn.window) closeWith(conn, EDITOR_CLOSE.helloRequired, "hello required")
    }, helloTimeoutMs)
    conn.helloTimer.unref?.()
    ws.on("pong", () => { conn.missedPongs = 0 })
    ws.on("message", (raw, isBinary) => onFrame(conn, raw, isBinary))
    ws.on("close", () => drop(conn))
    ws.on("error", () => closeWith(conn, 1011, "transport failed"))
    startTimers()
  }

  /** Send `open`/`focus` and wait for the window's `result`. */
  function request(conn: Connection, frame: { t: "open"; path: string } & Partial<FilePosition> | { t: "focus"; path: string }): Promise<boolean> {
    const id = randomUUID()
    const app = conn.window!.app
    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => settle("gone"), requestTimeoutMs)
      function settle(outcome: Outcome): void {
        clearTimeout(timer)
        conn.pending.delete(id)
        if (outcome === "gone") resolve(false)
        else if (outcome.ok) resolve(true)
        else reject(new Error(outcome.error || `${app} could not open ${basename(frame.path)}`))
      }
      conn.pending.set(id, settle)
      if (!send(conn, { ...frame, id } as EditorServerMessage)) settle("gone")
    })
  }

  function eligible(kinds: readonly EditorKind[]): Connection[] {
    return [...connections].filter((c) => c.window && c.window.acceptsOpens && kinds.includes(c.window.kind))
  }

  function mostRecent(candidates: readonly Connection[]): Connection | undefined {
    let best: Connection | undefined
    for (const c of candidates) if (!best || moreRecentlyFocused(c, best)) best = c
    return best
  }

  return {
    handleUpgrade(req, socket, head) {
      if ((req.url ?? "").split("?")[0] !== EDITOR_SOCKET_PATH) return false
      if (closing) {
        rejectWebSocketUpgrade(socket, 503, "Service Unavailable")
        return true
      }
      // The same mandatory Origin as the application socket: a page on another origin must not be able
      // to pose as an editor and be handed every file link the human clicks.
      if (!isTrustedLocalWebSocketRequest(req)) {
        rejectWebSocketUpgrade(socket)
        return true
      }
      if (connections.size + pendingUpgrades >= maxWindows) {
        rejectWebSocketUpgrade(socket, 503, "Too many editor windows")
        return true
      }
      pendingUpgrades++
      let reserved = true
      const release = () => {
        if (!reserved) return
        reserved = false
        pendingUpgrades = Math.max(0, pendingUpgrades - 1)
      }
      try {
        wss.handleUpgrade(req, socket, head, (ws) => {
          release()
          if (closing) {
            try { ws.terminate() } catch {}
            return
          }
          accept(ws)
        })
      } catch {
        release()
        rejectWebSocketUpgrade(socket, 400, "Bad Request")
      }
      return true
    },

    close() {
      if (closePromise) return closePromise
      closing = true
      stopTimers()
      for (const conn of connections) for (const settle of [...conn.pending.values()]) settle("gone")
      // Terminate rather than handshake, as the application socket does: the extension reconnects on
      // any close, and a polite close can keep a replaced server alive while a sleeping peer dawdles.
      const drains = [...wss.clients].map((ws) => new Promise<void>((resolve) => {
        if (ws.readyState === ws.CLOSED) return resolve()
        ws.once("close", () => resolve())
        try { ws.terminate() } catch { resolve() }
      }))
      closePromise = Promise.allSettled(drains).then(() => {
        try { wss.close() } catch {}
      })
      return closePromise
    },

    windows: summaries,

    async openFile(path, position, kinds) {
      if (closing || kinds.length === 0) return false
      const real = realpathOrUndefined(path)
      if (!real) return false
      const candidates = eligible(kinds)
      // The window whose workspace folder holds the file — the deepest folder, so a window on a package
      // beats one on the whole monorepo — and among equals the one the human was in last.
      let best: { conn: Connection; depth: number; path: string } | undefined
      for (const conn of candidates) {
        for (const folder of conn.window!.folders) {
          const realFolder = realpathOrUndefined(folder)
          if (!realFolder || !isUnder(real, folder)) continue
          const depth = realFolder.length
          if (!best || depth > best.depth || (depth === best.depth && moreRecentlyFocused(conn, best.conn))) {
            best = { conn, depth, path: spelledThrough(folder, realFolder, real) }
          }
        }
      }
      // No folder holds it: what `code -g` would do, the last window the human was in — but only one
      // that reads this server's filesystem, or the path means nothing there (a Windows-side window
      // beside a WSL server, a Remote-SSH window on another box).
      const target = best ?? (() => {
        const conn = mostRecent(candidates.filter((c) => c.window!.home === home && c.window!.platform === platform))
        return conn ? { conn, path: real } : undefined
      })()
      if (!target) return false
      return request(target.conn, {
        t: "open",
        path: target.path,
        ...(position ? { line: position.line } : {}),
        ...(position?.column !== undefined ? { column: position.column } : {}),
        ...(position?.endLine !== undefined ? { endLine: position.endLine } : {}),
      })
    },

    async focusFolder(dir, kinds) {
      if (closing || kinds.length === 0) return false
      const realDir = realpathOrUndefined(dir)
      if (!realDir) return false
      // A window whose folder IS this folder: contained both ways, the same identity isUnder gives a
      // file, so a symlinked spelling and a Windows case difference still match.
      const matches: { conn: Connection; folder: string }[] = []
      for (const conn of eligible(kinds)) {
        for (const folder of conn.window!.folders) {
          const realFolder = realpathOrUndefined(folder)
          if (realFolder && isUnder(realDir, folder) && isUnder(realFolder, dir)) {
            matches.push({ conn, folder })
            break
          }
        }
      }
      const conn = mostRecent(matches.map((m) => m.conn))
      if (!conn) return false
      return request(conn, { t: "focus", path: matches.find((m) => m.conn === conn)!.folder })
    },

    takeCompose(id) {
      pruneCompose()
      const index = id === undefined ? 0 : compose.findIndex((entry) => entry.item.id === id)
      if (index < 0 || index >= compose.length) return null
      return compose.splice(index, 1)[0]!.item
    },
  }
}

/**
 * The `projects` frame: every registered project and Home, minus any whose folder is gone (no file can
 * be in it, and a thread sent there could not run). A project open on this server carries its counts —
 * Ready is the queue (`queuedThread`), Working the rail's spinning count (`workingThread`), the same
 * predicates the page's rail badge uses. A project that is not open has no honest count, and getting
 * one is not worth opening it, so it has none (AppContext.activeTenants says why).
 */
export async function listEditorProjects(
  workspaces: readonly { id: string; slug: string; name?: string; path: string; stale: boolean }[],
  open: ReadonlyArray<{ project: { id: string }; board: { snapshot(): Promise<{ threads: ThreadView[] }> } }>,
): Promise<EditorProject[]> {
  const boards = new Map(open.map((tenant) => [tenant.project.id, tenant.board]))
  const out: EditorProject[] = []
  for (const entry of workspaces) {
    if (entry.stale) continue
    const project: EditorProject = {
      id: entry.id,
      slug: entry.slug,
      name: entry.name ?? (basename(entry.path) || entry.path),
      dir: entry.path,
      ...(isHomeWorkspace(entry.id) ? { home: true as const } : {}),
    }
    const board = boards.get(entry.id)
    if (board) {
      try {
        const { threads } = await board.snapshot()
        project.ready = threads.filter(queuedThread).length
        project.working = threads.filter(workingThread).length
      } catch {
        // A board stopping mid-walk: this round it reads as not open, which is what it is about to be.
      }
    }
    out.push(project)
  }
  return out
}
