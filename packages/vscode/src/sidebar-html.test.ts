import { test } from "node:test"
import assert from "node:assert/strict"
import { runInNewContext } from "node:vm"
import { contentSecurityPolicy, frameDocument, messageDocument } from "./sidebar-html.ts"

const FRIZZ = "http://127.0.0.1:9393"
const URL_ = `${FRIZZ}/?embed=vscode&theme=dark&project=a%22b`
const WEBVIEW = "vscode-webview://0abc"

const cspOf = (html: string) => /http-equiv="Content-Security-Policy" content="([^"]*)"/u.exec(html)?.[1]

test("the frame document frames exactly Frizz's origin and runs only its own nonce'd code", () => {
  const html = frameDocument({ nonce: "N0nce", url: URL_, origin: FRIZZ })
  assert.equal(cspOf(html), `default-src 'none'; frame-src ${FRIZZ}; style-src 'nonce-N0nce'; script-src 'nonce-N0nce'`)
  const frames = [...html.matchAll(/<iframe [^>]*>/gu)].map((match) => match[0])
  assert.deepEqual(frames, [
    `<iframe id="frizz" title="Frizz" src="${FRIZZ}/?embed=vscode&amp;theme=dark&amp;project=a%22b" allow="clipboard-read; clipboard-write; local-network-access">`,
  ])
  assert.deepEqual([...html.matchAll(/<script\b[^>]*>/gu)].map((match) => match[0]), ['<script nonce="N0nce">'])
  assert.deepEqual([...html.matchAll(/<style\b[^>]*>/gu)].map((match) => match[0]), ['<style nonce="N0nce">'])
  assert.doesNotMatch(html, /\son[a-z]+=/u, "no inline handlers, which the policy would block anyway")
})

test("the frame document refuses an origin that is not the URL's, or not a plain web origin", () => {
  assert.throws(() => frameDocument({ nonce: "n", url: "http://evil.example/", origin: FRIZZ }))
  assert.throws(() => frameDocument({ nonce: "n", url: "http://a;b/", origin: "http://a;b" }))
})

test("a message document escapes its copy and frames nothing", () => {
  const html = messageDocument({ nonce: "n", text: `Frizz said <img src=x onerror="alert(1)">`, actions: [{ action: "retry", label: "Try <again>" }] })
  assert.equal(cspOf(html), contentSecurityPolicy("n"))
  assert.doesNotMatch(cspOf(html)!, /frame-src/u)
  assert.match(html, /Frizz said &lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/u)
  assert.match(html, /<button type="button" data-action="retry">Try &lt;again&gt;<\/button>/u)
  assert.doesNotMatch(html, /<iframe/u)
})

// ── the relay, run for real against stand-ins for the three windows ────────────────────────────────────

interface Relay {
  toHost: unknown[]
  toPage: { data: unknown; targetOrigin: string }[]
  frameWindow: object
  parent: object
  hint: { hidden: boolean }
  focused: number
  dispatch(event: { source: unknown; origin: string; data: unknown }): void
}

function relay(html: string): Relay {
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/u.exec(html)![1]!
  const toHost: unknown[] = []
  const toPage: { data: unknown; targetOrigin: string }[] = []
  const frameWindow = { postMessage: (data: unknown, targetOrigin: string) => toPage.push({ data, targetOrigin }) }
  const parent = {}
  const hint = { hidden: true }
  const listeners: ((event: unknown) => void)[] = []
  const state = { focused: 0 }
  const frame = { contentWindow: frameWindow, focus: () => state.focused++ }
  const window = {
    origin: WEBVIEW,
    parent,
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      if (type === "message") listeners.push(listener)
    },
  }
  runInNewContext(script, {
    // A clone, as postMessage makes one — and out of the script's realm, so deepEqual compares values.
    acquireVsCodeApi: () => ({ postMessage: (message: unknown) => toHost.push(structuredClone(message)) }),
    window,
    document: { getElementById: (id: string) => (id === "frizz" ? frame : id === "hint" ? hint : null), addEventListener() {}, body: {} },
    navigator: { platform: "Linux x86_64" },
    Element: class {},
    setTimeout,
  })
  return {
    toHost,
    toPage,
    frameWindow,
    parent,
    hint,
    get focused() {
      return state.focused
    },
    dispatch: (event) => listeners.forEach((listener) => listener(event)),
  }
}

test("the relay hands the host only what its own frame sent from Frizz's origin", () => {
  const r = relay(frameDocument({ nonce: "n", url: URL_, origin: FRIZZ }))
  assert.deepEqual(r.toHost, [{ view: "platform", mac: false }], "it says which platform the UI is on")
  r.toHost.length = 0
  const ready = { type: "frizz:ready", v: 1 }
  r.dispatch({ source: r.frameWindow, origin: FRIZZ, data: ready })
  assert.deepEqual(r.toHost, [{ page: ready }], "passed on unchanged, in the page envelope")
  r.dispatch({ source: r.frameWindow, origin: "http://evil.example", data: ready })
  r.dispatch({ source: r.frameWindow, origin: "http://127.0.0.1:9394", data: ready })
  r.dispatch({ source: {}, origin: FRIZZ, data: ready })
  assert.equal(r.toHost.length, 1, "another origin in the frame, or another window at Frizz's origin, is dropped")
  // Nothing from the page reaches the page back, or passes for one of the view's own messages.
  r.dispatch({ source: r.frameWindow, origin: FRIZZ, data: { view: "reload" } })
  assert.deepEqual(r.toHost[1], { page: { view: "reload" } })
  assert.deepEqual(r.toPage, [])
})

test("the relay posts the host's frizz: messages to the page at Frizz's origin only, and keeps its own", () => {
  const r = relay(frameDocument({ nonce: "n", url: URL_, origin: FRIZZ }))
  const compose = { type: "frizz:compose", id: "1", item: { path: "/r/a.ts", app: "Code" }, target: "front", focus: false }
  r.dispatch({ source: r.parent, origin: WEBVIEW, data: compose })
  assert.deepEqual(r.toPage, [{ data: compose, targetOrigin: FRIZZ }])
  assert.equal(r.focused, 0, "focus false leaves focus alone")
  r.dispatch({ source: r.parent, origin: WEBVIEW, data: { ...compose, id: "2", focus: true } })
  assert.equal(r.focused, 1, "focus true gives the frame the focus, so the page's caret shows")
  assert.equal(r.toPage.length, 2)

  r.dispatch({ source: r.parent, origin: "http://evil.example", data: compose })
  r.dispatch({ source: {}, origin: WEBVIEW, data: compose })
  r.dispatch({ source: r.parent, origin: WEBVIEW, data: { type: "other" } })
  r.dispatch({ source: r.parent, origin: WEBVIEW, data: "frizz:compose" })
  assert.equal(r.toPage.length, 2, "only a frizz: object from the host frame")

  r.dispatch({ source: r.parent, origin: WEBVIEW, data: { view: "hint", show: true } })
  assert.equal(r.hint.hidden, false)
  r.dispatch({ source: r.parent, origin: WEBVIEW, data: { view: "hint", show: false } })
  assert.equal(r.hint.hidden, true)
  assert.equal(r.toPage.length, 2, "the view's own message never reaches the page")
})
