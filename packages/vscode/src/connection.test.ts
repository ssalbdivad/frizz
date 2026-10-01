import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { WebSocket, WebSocketServer } from "ws"
import { EDITOR_CLOSE, EDITOR_MAX_FOLDERS, EDITOR_MAX_PATH, EDITOR_SOCKET_PATH, type EditorClientMessage, type EditorOpen, type EditorProject, type EditorServerMessage } from "@frizz/shared/editor-protocol"
// The server's OWN frame rules (the extension never bundles these): a frame Frizz would refuse fails here.
import { EditorClientMessageSchema } from "@frizz/shared"
import { EDITOR_MAX_FRAME_BYTES, EDITOR_MAX_PAYLOAD_BYTES } from "../../server/src/editor-bridge.ts"
import { notConnectedMessage } from "./status.ts"
import { backoffDelay, EditorConnection, fitFolders, FocusRecency, FOLDERS_MAX_BYTES, type ConnectionHost, type ConnectionOptions, type ConnectionStatus, type OpenResult } from "./connection.ts"

// A real `ws` server speaking the server's half of the editor protocol, in-process — with the origin
// gate the real one has (an upgrade without `Origin: http://127.0.0.1:<port>` is refused), its frame
// ceilings, and its schema: a frame the server would close 4401 is closed 4401 here too, and recorded,
// and `close()` fails the test that sent it.
class FakeFrizz {
  readonly frames: EditorClientMessage[] = []
  /** Frames the real server would have refused, with why. */
  readonly refused: string[] = []
  readonly origins: (string | undefined)[] = []
  readonly sockets: WebSocket[] = []
  /** Answer each hello with welcome + projects, as the server does. */
  welcome = true
  projects: EditorProject[] = [{ id: "p1", slug: "repo", name: "repo", dir: "/home/me/repo", ready: 2, working: 1 }]
  readonly #server: Server
  readonly #wss = new WebSocketServer({ noServer: true, maxPayload: EDITOR_MAX_PAYLOAD_BYTES })
  port = 0

  constructor(readonly options: { editorPath?: boolean } = {}) {
    this.#server = createServer((_request, response) => {
      response.statusCode = 404
      response.end("Not Found")
    })
    if (options.editorPath !== false) {
      this.#server.on("upgrade", (request, socket, head) => {
        if (request.url !== EDITOR_SOCKET_PATH || request.headers.origin !== `http://127.0.0.1:${this.port}`) {
          socket.end("HTTP/1.1 403 Forbidden\r\n\r\n")
          return
        }
        this.origins.push(request.headers.origin)
        this.#wss.handleUpgrade(request, socket, head, (ws) => this.#accept(ws))
      })
    }
  }

  async listen(): Promise<this> {
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve))
    this.port = (this.#server.address() as AddressInfo).port
    return this
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`
  }

  #accept(ws: WebSocket): void {
    this.sockets.push(ws)
    ws.on("close", (code) => {
      if (code === 1009) this.refused.push("a frame past the socket's ceiling (1009)")
    })
    ws.on("message", (data) => {
      const text = data.toString()
      const decoded: unknown = JSON.parse(text)
      const parsed = EditorClientMessageSchema.safeParse(decoded)
      const t = (decoded as { t?: unknown }).t
      const oversize = t !== "compose" && Buffer.byteLength(text, "utf8") > EDITOR_MAX_FRAME_BYTES
      if (!parsed.success || oversize) {
        this.refused.push(`${String(t)}: ${oversize ? "frame too large" : parsed.error?.message}`)
        ws.close(EDITOR_CLOSE.invalidMessage, "invalid frame")
        return
      }
      const frame = decoded as EditorClientMessage
      this.frames.push(frame)
      if (frame.t === "hello" && this.welcome) {
        this.send(ws, { t: "welcome", v: 1, bootId: "boot-1" })
        this.send(ws, { t: "projects", projects: this.projects })
      }
    })
  }

  get live(): WebSocket {
    const socket = this.sockets.at(-1)
    assert.ok(socket, "no editor socket yet")
    return socket
  }

  send(ws: WebSocket, message: EditorServerMessage): void {
    ws.send(JSON.stringify(message))
  }

  of<T extends EditorClientMessage["t"]>(t: T): Extract<EditorClientMessage, { t: T }>[] {
    return this.frames.filter((frame): frame is Extract<EditorClientMessage, { t: T }> => frame.t === t)
  }

  async close(): Promise<void> {
    for (const ws of this.sockets) ws.terminate()
    this.#wss.close()
    await new Promise((resolve) => this.#server.close(resolve))
    assert.deepEqual(this.refused, [], "every frame the window sent is one the real server takes")
  }
}

interface TestHost extends ConnectionHost {
  statuses: ConnectionStatus[]
  logs: string[]
  received: EditorProject[][]
  opened: EditorOpen[]
  discovered: number
  current: { folders: string[]; focused: boolean; acceptsOpens: boolean }
  reachable: boolean
  answer: (message: EditorOpen) => Promise<OpenResult>
}

function makeHost(frizz: FakeFrizz): TestHost {
  const host: TestHost = {
    statuses: [],
    logs: [],
    received: [],
    opened: [],
    discovered: 0,
    current: { folders: ["/home/me/repo"], focused: false, acceptsOpens: true },
    reachable: true,
    answer: async () => ({ ok: true }),
    async discover() {
      host.discovered++
      return host.reachable ? { origin: frizz.origin, detail: "test" } : undefined
    },
    hello: () => ({ windowId: "w-1", app: "Visual Studio Code", extensionVersion: "0.1.0", ...host.current, home: "/home/me", platform: "linux" }),
    state: () => ({ ...host.current }),
    open: async (message) => {
      host.opened.push(message)
      return host.answer(message)
    },
    focus: async () => ({ ok: true }),
    projects: (projects) => void host.received.push(projects),
    status: (status) => void host.statuses.push(status),
    log: {
      info: (line) => void host.logs.push(`info ${line}`),
      warn: (line) => void host.logs.push(`warn ${line}`),
      error: (line) => void host.logs.push(`error ${line}`),
    },
  }
  return host
}

const FAST: ConnectionOptions = { minBackoffMs: 20, maxBackoffMs: 200, random: () => 0.5 }

async function until(what: string, condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function connected(options: ConnectionOptions = FAST): Promise<{ frizz: FakeFrizz; host: TestHost; connection: EditorConnection; done: () => Promise<void> }> {
  const frizz = await new FakeFrizz().listen()
  const host = makeHost(frizz)
  const connection = new EditorConnection(host, options)
  const done = async () => {
    connection.stop()
    await frizz.close()
  }
  connection.start()
  try {
    await until("the welcome", () => connection.status.kind === "connected")
  } catch (error) {
    // A failed setup must not leave a redialling client and a listener holding the test process open.
    await done()
    throw error
  }
  return { frizz, host, connection, done }
}

test("the hello introduces the window, over an upgrade carrying the Origin the server's gate demands", async () => {
  const { frizz, host, connection, done } = await connected()
  try {
    assert.deepEqual(frizz.origins, [frizz.origin])
    assert.deepEqual(frizz.of("hello"), [{
      t: "hello", v: 1, windowId: "w-1", app: "Visual Studio Code", extensionVersion: "0.1.0",
      folders: ["/home/me/repo"], focused: false, acceptsOpens: true, home: "/home/me", platform: "linux",
    }])
    assert.deepEqual(connection.status, { kind: "connected", origin: frizz.origin, bootId: "boot-1" })
    assert.equal(connection.origin, frizz.origin)
    await until("the projects push", () => host.received.length === 1)
    assert.deepEqual(host.received[0], frizz.projects)
    assert.deepEqual(host.statuses.map((s) => s.kind), ["connecting", "connected"])
  } finally {
    await done()
  }
})

test("state is sent whole when it changes, and not at all when it has not", async () => {
  const { frizz, host, connection, done } = await connected()
  try {
    connection.sendState()
    await sleep(60)
    assert.equal(frizz.of("state").length, 0, "nothing changed since the hello")
    host.current = { ...host.current, focused: true }
    connection.sendState()
    await until("a state frame", () => frizz.of("state").length === 1)
    assert.deepEqual(frizz.of("state")[0], { t: "state", folders: ["/home/me/repo"], focused: true, acceptsOpens: true })
    connection.sendState()
    host.current = { ...host.current, folders: ["/home/me/repo", "/home/me/other"], acceptsOpens: false }
    connection.sendState()
    await until("the second state frame", () => frizz.of("state").length === 2)
    assert.deepEqual(frizz.of("state")[1], { t: "state", folders: ["/home/me/repo", "/home/me/other"], focused: true, acceptsOpens: false })
  } finally {
    await done()
  }
})

test("a change between the hello and the welcome is sent as soon as Frizz welcomes the window", async () => {
  const frizz = await new FakeFrizz().listen()
  frizz.welcome = false
  const host = makeHost(frizz)
  const connection = new EditorConnection(host, FAST)
  try {
    connection.start()
    await until("the hello", () => frizz.of("hello").length === 1)
    host.current = { ...host.current, focused: true }
    connection.sendState()
    assert.equal(frizz.of("state").length, 0, "not before the welcome")
    frizz.send(frizz.live, { t: "welcome", v: 1, bootId: "b" })
    await until("the catch-up state", () => frizz.of("state").length === 1)
    assert.equal(frizz.of("state")[0]?.focused, true)
  } finally {
    connection.stop()
    await frizz.close()
  }
})

test("every open and focus is answered with a result: ok, the window's own refusal, or what it threw", async () => {
  const { frizz, host, done } = await connected()
  try {
    frizz.send(frizz.live, { t: "open", id: "o1", path: "/home/me/repo/a.ts", line: 12, column: 3 })
    await until("result o1", () => frizz.of("result").length === 1)
    assert.deepEqual(host.opened[0], { t: "open", id: "o1", path: "/home/me/repo/a.ts", line: 12, column: 3 })
    assert.deepEqual(frizz.of("result")[0], { t: "result", id: "o1", ok: true })

    host.answer = async () => ({ ok: false, error: "/gone.ts doesn't exist." })
    frizz.send(frizz.live, { t: "open", id: "o2", path: "/gone.ts" })
    await until("result o2", () => frizz.of("result").length === 2)
    assert.deepEqual(frizz.of("result")[1], { t: "result", id: "o2", ok: false, error: "/gone.ts doesn't exist." })

    host.answer = async () => { throw new Error("editor exploded") }
    frizz.send(frizz.live, { t: "open", id: "o3", path: "/x.ts" })
    await until("result o3", () => frizz.of("result").length === 3)
    assert.deepEqual(frizz.of("result")[2], { t: "result", id: "o3", ok: false, error: "editor exploded" })

    frizz.send(frizz.live, { t: "focus", id: "f1", path: "/home/me/repo" })
    await until("result f1", () => frizz.of("result").length === 4)
    assert.deepEqual(frizz.of("result")[3], { t: "result", id: "f1", ok: true })
  } finally {
    await done()
  }
})

test("compose resolves with Frizz's own answer; offline or unanswered, it fails with words to show", async () => {
  const frizz = await new FakeFrizz().listen()
  const host = makeHost(frizz)
  const connection = new EditorConnection(host, { ...FAST, composeTimeoutMs: 150 })
  try {
    const offline = await connection.compose({ path: "/home/me/repo/a.ts" })
    assert.equal(offline.ok, false)
    assert.equal(offline.error, "Frizz isn't running.")

    connection.start()
    await until("the welcome", () => connection.status.kind === "connected")
    frizz.live.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as EditorClientMessage
      if (frame.t === "compose" && frame.item.path.endsWith("a.ts")) frizz.send(frizz.live, { t: "composed", id: frame.id, ok: true })
    })
    const item = { projectId: "p1", path: "/home/me/repo/a.ts", text: "x", startLine: 3, endLine: 3 }
    const answered = await connection.compose(item)
    assert.equal(answered.ok, true)
    assert.deepEqual(frizz.of("compose")[0]?.item, item)
    assert.equal(answered.id, frizz.of("compose")[0]?.id)

    const unanswered = await connection.compose({ path: "/home/me/repo/b.ts" })
    assert.deepEqual([unanswered.ok, unanswered.error], [false, "Frizz didn't answer."])
  } finally {
    connection.stop()
    await frizz.close()
  }
})

test("a dropped socket is dialled again from a fresh discovery, and says hello again", async () => {
  const { frizz, host, done } = await connected()
  try {
    const discoveredBefore = host.discovered
    frizz.live.close(1001, "restarting")
    await until("the second hello", () => frizz.of("hello").length === 2)
    assert.ok(host.discovered > discoveredBefore, "discovery ran again before the redial")
    await until("connected again", () => host.statuses.at(-1)?.kind === "connected")
    const kinds = host.statuses.map((s) => s.kind)
    assert.deepEqual(kinds.slice(-2), ["offline", "connected"])
    assert.match(host.logs.join("\n"), /Frizz is restarting\. \[1001\]/)
  } finally {
    await done()
  }
})

test("no Frizz is offline, retried on the backoff, and logged once rather than once per retry", async () => {
  const frizz = await new FakeFrizz().listen()
  const host = makeHost(frizz)
  host.reachable = false
  const connection = new EditorConnection(host, FAST)
  try {
    connection.start()
    await until("several attempts", () => host.discovered >= 4)
    assert.deepEqual(connection.status, { kind: "offline", reason: "Frizz isn't running." })
    assert.equal(host.logs.filter((line) => /isn't running/.test(line)).length, 1)
    host.reachable = true
    await until("the connection once Frizz is up", () => connection.status.kind === "connected", 2_000)
  } finally {
    connection.stop()
    await frizz.close()
  }
})

test("silence is a dead link: 45s (here 150ms) without a frame tears the socket down and redials", async () => {
  const { frizz, done } = await connected({ ...FAST, silenceMs: 150 })
  try {
    await until("a redial after the silence", () => frizz.of("hello").length >= 2, 2_000)
  } finally {
    await done()
  }
})

test("negative control: a heartbeat inside the silence window keeps the one socket", async () => {
  const { frizz, done } = await connected({ ...FAST, silenceMs: 150 })
  const beat = setInterval(() => frizz.sockets.forEach((ws) => ws.readyState === WebSocket.OPEN && frizz.send(ws, { t: "hb" })), 40)
  try {
    await sleep(500)
    assert.equal(frizz.of("hello").length, 1)
  } finally {
    clearInterval(beat)
    await done()
  }
})

test("close 4400 says to update Frizz or the extension, and retries only at the slowest pace", async () => {
  const { frizz, host, connection, done } = await connected({ minBackoffMs: 10, maxBackoffMs: 400, random: () => 0.5 })
  try {
    frizz.live.close(EDITOR_CLOSE.unsupportedVersion, "protocol 1 unsupported")
    await until("the incompatible status", () => connection.status.kind === "incompatible")
    assert.match((connection.status as { reason: string }).reason, /Update Frizz or the extension/)
    assert.match(notConnectedMessage(connection.status), /Update Frizz or the extension/)
    assert.ok(host.logs.some((line) => line.startsWith("error ") && line.includes("[4400]")))
    await sleep(250)
    assert.equal(frizz.of("hello").length, 1, "no quick retry against a server that cannot speak to us")
    await until("the slow retry", () => frizz.of("hello").length === 2, 1_000)
  } finally {
    await done()
  }
})

test("4401 and 4402 are refusals worth logging, then an ordinary reconnect", async () => {
  const { frizz, host, done } = await connected()
  try {
    frizz.live.close(EDITOR_CLOSE.invalidMessage, "bad frame")
    await until("the reconnect", () => frizz.of("hello").length === 2)
    assert.match(host.logs.join("\n"), /Frizz refused a message from this window \(bad frame\)\. \[4401\]/)
    frizz.live.close(EDITOR_CLOSE.helloRequired, "")
    await until("the next reconnect", () => frizz.of("hello").length === 3)
    assert.match(host.logs.join("\n"), /introduce itself first\. \[4402\]/)
  } finally {
    await done()
  }
})

test("a Frizz from before the editor connection (a plain 404 on the upgrade) is told to update", async () => {
  const frizz = await new FakeFrizz({ editorPath: false }).listen()
  const host = makeHost(frizz)
  const connection = new EditorConnection(host, FAST)
  try {
    connection.start()
    await until("the offline status", () => connection.status.kind === "offline")
    assert.deepEqual(connection.status, { kind: "offline", reason: "This Frizz has no editor connection yet. Update Frizz." })
    assert.equal(notConnectedMessage(connection.status), "This Frizz has no editor connection yet. Update Frizz.", "a command says so too, not that Frizz is stopped")
  } finally {
    connection.stop()
    await frizz.close()
  }
})

test("a Frizz that hangs up on the upgrade (one from before the editor connection, behind its supervisor) is told to update", async () => {
  const server = createServer()
  server.on("upgrade", (_request, socket) => socket.destroy())
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const host = makeHost({ origin } as FakeFrizz)
  const connection = new EditorConnection(host, FAST)
  try {
    connection.start()
    await until("the offline status", () => connection.status.kind === "offline")
    assert.deepEqual(connection.status, { kind: "offline", reason: "Frizz didn't accept the editor connection. Update Frizz if this keeps happening." })
    assert.equal(notConnectedMessage(connection.status), "Frizz didn't accept the editor connection. Update Frizz if this keeps happening.")
  } finally {
    connection.stop()
    await new Promise((resolve) => server.close(resolve))
  }
})

test("stop closes the socket cleanly and nothing redials", async () => {
  const { frizz, connection, done } = await connected()
  const closed = new Promise<number>((resolve) => frizz.live.on("close", (code) => resolve(code)))
  connection.stop()
  assert.equal(await closed, 1000)
  await sleep(150)
  assert.equal(frizz.of("hello").length, 1)
  await done()
})

test("a window with more folders than Frizz takes still connects: the hello and every state are fitted, and the log says so once", async () => {
  // 70 roots and one path past the cap: sent whole, the hello is refused (4401) on every redial, forever.
  const many = Array.from({ length: 70 }, (_, i) => `/home/me/roots/r${String(i).padStart(2, "0")}`)
  const long = `/home/me/${"x".repeat(EDITOR_MAX_PATH)}`
  const frizz = await new FakeFrizz().listen()
  const host = makeHost(frizz)
  host.current = { ...host.current, folders: [long, ...many] }
  const connection = new EditorConnection(host, FAST)
  try {
    connection.start()
    await until("the welcome", () => connection.status.kind === "connected")
    const hello = frizz.of("hello")[0]!
    assert.deepEqual(hello.folders, many.slice(0, EDITOR_MAX_FOLDERS), "the first 64 that fit, in the workspace's order")
    host.current = { ...host.current, folders: [...many, "/home/me/one-more"], focused: true }
    connection.sendState()
    await until("the state frame", () => frizz.of("state").length === 1)
    assert.equal(frizz.of("state")[0]!.folders.length, EDITOR_MAX_FOLDERS)
    assert.deepEqual(host.logs.filter((line) => /Frizz takes/.test(line)), [
      "warn This window has 71 folders; Frizz takes 64 of them (at most 64, none over 4096 characters), so file links to the rest open elsewhere.",
    ], "said once, not on every frame")
  } finally {
    connection.stop()
    await frizz.close()
  }
})

test("folders fit by count, by path length and by encoded bytes, in order", () => {
  assert.deepEqual(fitFolders(["/a", "", `/${"y".repeat(EDITOR_MAX_PATH)}`, "/b"]), ["/a", "/b"])
  assert.equal(fitFolders(Array.from({ length: 100 }, (_, i) => `/r${i}`)).length, EDITOR_MAX_FOLDERS)
  // 64 maximal paths in three-byte characters would be 768 KiB; they stop at the byte budget instead.
  const wide = Array.from({ length: 64 }, (_, i) => `/${String(i).padStart(2, "0")}${"€".repeat(EDITOR_MAX_PATH - 3)}`)
  const fitted = fitFolders(wide)
  assert.ok(fitted.length > 0 && fitted.length < 64)
  assert.deepEqual(fitted, wide.slice(0, fitted.length))
  assert.ok(Buffer.byteLength(JSON.stringify(fitted), "utf8") <= FOLDERS_MAX_BYTES + 2)
  const hello = { t: "hello", v: 1, windowId: "w", app: "Visual Studio Code", extensionVersion: "0.1.0", folders: fitted, focused: false, acceptsOpens: true, home: `/${"h".repeat(4095)}`, platform: "linux" }
  assert.ok(EditorClientMessageSchema.safeParse(hello).success)
  assert.ok(Buffer.byteLength(JSON.stringify(hello), "utf8") <= EDITOR_MAX_FRAME_BYTES)
})

test("the hello says how long ago an unfocused window last had focus, so a reconnect keeps its rank", async () => {
  let now = 1_000
  const focus = new FocusRecency(() => now)
  assert.equal(focus.agoMs(false), undefined, "never focused since activation: nothing to say")
  focus.observe(true)
  now += 60_000
  assert.equal(focus.agoMs(true), undefined, "focused now: the hello's `focused` says it")
  focus.observe(false)
  now += 5_000
  assert.equal(focus.agoMs(false), 5_000, "focused until it lost focus, 5s ago")
  focus.observe(false)
  now += 1_000
  assert.equal(focus.agoMs(false), 6_000, "a repeated unfocused report does not reset the moment")

  const frizz = await new FakeFrizz().listen()
  const host = makeHost(frizz)
  const hello = host.hello
  host.hello = () => ({ ...hello(), focusedAgoMs: focus.agoMs(false) })
  const connection = new EditorConnection(host, FAST)
  try {
    connection.start()
    await until("the welcome", () => connection.status.kind === "connected")
    assert.equal(frizz.of("hello")[0]?.focusedAgoMs, 6_000)
  } finally {
    connection.stop()
    await frizz.close()
  }
})

test("the backoff doubles from 1s to a 30s ceiling, jittered ±20%", () => {
  const mid = Array.from({ length: 8 }, (_, attempt) => backoffDelay(attempt, 1_000, 30_000, () => 0.5))
  assert.deepEqual(mid, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000])
  assert.equal(backoffDelay(0, 1_000, 30_000, () => 0), 800)
  assert.equal(backoffDelay(0, 1_000, 30_000, () => 1), 1_200)
  assert.equal(backoffDelay(9, 1_000, 30_000, () => 1), 30_000, "jitter never pushes past the ceiling")
})
