import { test } from "node:test"
import assert from "node:assert/strict"
import { runInNewContext } from "node:vm"
import { contentSecurityPolicy, frameDocument, HINT, HINT_OLD_FRIZZ, messageDocument } from "./sidebar-html.ts"

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
  /** VS Code's host frame, which is NOT `window.parent` in a webview document. */
  hostFrame: object
  hint: { hidden: boolean }
  hintText: { textContent: string }
  focused: number
  /** Times the PAGE's window was focused (`frame.contentWindow.focus()`). */
  pageFocused: number
  dispatch(event: { source: unknown; origin: string; data: unknown }): void
  /** The relay's window gains focus with `active` its focused element; the listener's timer has run when it resolves. */
  windowFocus(active: "body" | "frame"): Promise<void>
}

function relay(html: string): Relay {
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/u.exec(html)![1]!
  const toHost: unknown[] = []
  const toPage: { data: unknown; targetOrigin: string }[] = []
  const frameWindow = { postMessage: (data: unknown, targetOrigin: string) => toPage.push({ data, targetOrigin }), focus: () => state.pageFocused++ }
  const hostFrame = {}
  const hint = { hidden: true }
  const hintText = { textContent: "" }
  const listeners: ((event: unknown) => void)[] = []
  const focusListeners: (() => void)[] = []
  const state = { focused: 0, pageFocused: 0 }
  const frame = { contentWindow: frameWindow, focus: () => state.focused++ }
  const window = {
    origin: WEBVIEW,
    // As VS Code's injected API script leaves it in a webview document.
    get parent() {
      return window
    },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      if (type === "message") listeners.push(listener)
      if (type === "focus") focusListeners.push(listener as () => void)
    },
  }
  const document = { getElementById: (id: string) => (id === "frizz" ? frame : id === "hint" ? hint : id === "hint-text" ? hintText : null), addEventListener() {}, body: {}, activeElement: null as unknown }
  runInNewContext(script, {
    // A clone, as postMessage makes one — and out of the script's realm, so deepEqual compares values.
    acquireVsCodeApi: () => ({ postMessage: (message: unknown) => toHost.push(structuredClone(message)) }),
    window,
    document,
    navigator: { platform: "Linux x86_64" },
    Element: class {},
    setTimeout,
  })
  return {
    toHost,
    toPage,
    frameWindow,
    hostFrame,
    hint,
    hintText,
    get focused() {
      return state.focused
    },
    get pageFocused() {
      return state.pageFocused
    },
    dispatch: (event) => listeners.forEach((listener) => listener(event)),
    async windowFocus(active) {
      document.activeElement = active === "body" ? document.body : frame
      focusListeners.forEach((listener) => listener())
      await new Promise((resolve) => setTimeout(resolve, 5))
    },
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
  r.dispatch({ source: r.hostFrame, origin: WEBVIEW, data: compose })
  assert.deepEqual(r.toPage, [{ data: compose, targetOrigin: FRIZZ }])
  assert.equal(r.focused, 0, "focus false leaves focus alone")
  r.dispatch({ source: r.hostFrame, origin: WEBVIEW, data: { ...compose, id: "2", focus: true } })
  assert.equal(r.focused, 1, "focus true gives the frame the focus, so the page's caret shows")
  assert.equal(r.toPage.length, 2)

  r.dispatch({ source: r.hostFrame, origin: "http://evil.example", data: compose })
  r.dispatch({ source: r.hostFrame, origin: "vscode-webview://another-webview", data: compose })
  r.dispatch({ source: r.hostFrame, origin: WEBVIEW, data: { type: "other" } })
  r.dispatch({ source: r.hostFrame, origin: WEBVIEW, data: "frizz:compose" })
  assert.equal(r.toPage.length, 2, "only a frizz: object from the host frame")

  r.dispatch({ source: r.hostFrame, origin: WEBVIEW, data: { view: "hint", show: true } })
  assert.equal(r.hint.hidden, false)
  r.dispatch({ source: r.hostFrame, origin: WEBVIEW, data: { view: "hint", show: false } })
  assert.equal(r.hint.hidden, true)
  // A Frizz from before the sidebar: the bar says so, in the extension's words.
  r.dispatch({ source: r.hostFrame, origin: WEBVIEW, data: { view: "hint", show: true, text: HINT_OLD_FRIZZ } })
  assert.equal(r.hint.hidden, false)
  assert.equal(r.hintText.textContent, HINT_OLD_FRIZZ)
  assert.equal(r.toPage.length, 2, "the view's own message never reaches the page")
})

test("the bar is drawn shut with the loading words, or open from the first paint with the words it is given", () => {
  const plain = frameDocument({ nonce: "n", url: URL_, origin: FRIZZ })
  assert.match(plain, new RegExp(`<div class="hint" id="hint" role="status" hidden><p id="hint-text">${HINT.text.replace(/'/gu, "&#39;")}</p>`, "u"))
  const old = frameDocument({ nonce: "n", url: URL_, origin: FRIZZ, hint: HINT_OLD_FRIZZ })
  assert.match(old, /<div class="hint" id="hint" role="status"><p id="hint-text">This Frizz is older than the sidebar\. Update Frizz to use it here, or open it in your browser\.<\/p>/u)
})

test("focus landing on the relay goes on to the page — including when the frame is already its focused element", async () => {
  const r = relay(frameDocument({ nonce: "n", url: URL_, origin: FRIZZ }))
  await r.windowFocus("body")
  assert.equal(r.focused, 1, "a view revealed, a click on its edge: the frame takes the focus")
  // VS Code's webview host focuses this WINDOW while it settles a view's focus. The relay's focused element is
  // still the frame, so nothing here moved — but the focused frame is now the relay's, and the page lost the
  // keyboard a beat after its caret landed (real VS Code e2e, c2: New thread after Back to queue, 1 run in 3).
  await r.windowFocus("frame")
  assert.equal(r.pageFocused, 1, "the page's window is focused, the frame element being focused already")
  assert.equal(r.focused, 1)
})
