import assert from "node:assert/strict"
import test from "node:test"

// THE PAGE IN EMBED MODE, end to end through the real modules: this file boots them under a frame's
// globals — `?embed=vscode&theme=dark` on the address, a parent that records what it is posted — and
// then asks the questions a sidebar depends on. Embed mode is read once per page (lib/embed.ts), so it
// has a test file, and a process, of its own; everything is imported only after the globals are set.

const posted: unknown[] = []
const session = new Map<string, string>()
const local = new Map<string, string>([["frizz-theme", "light"]])
const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> }
const fetched: string[] = []

Object.assign(globalThis, {
  window: Object.assign(globalThis, {
    parent: { postMessage: (message: unknown) => posted.push(message) },
    // A sidebar dragged wide: the 700px phone query does NOT match.
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {},
    removeEventListener() {},
  }),
  location: { search: "?embed=vscode&theme=dark&project=nub", pathname: "/", href: "http://127.0.0.1:9393/?embed=vscode&theme=dark&project=nub", origin: "http://127.0.0.1:9393" },
  sessionStorage: { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => void session.set(k, v), removeItem: (k: string) => void session.delete(k) },
  localStorage: { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => void local.set(k, v), removeItem: (k: string) => void local.delete(k) },
  document: { documentElement: root, querySelector: () => null, hasFocus: () => false, visibilityState: "visible", addEventListener() {} },
  fetch: async (url: string) => {
    fetched.push(String(url))
    throw new Error("no server in this test")
  },
})

const { embedded } = await import("./embed.ts")
const { phoneLayout } = await import("./mobile.ts")
const { openLocalPath } = await import("./local-file-links.ts")
const { openExternalUrl } = await import("./external-links.ts")
const { getThemeSnapshot, initTheme, setHostTheme } = await import("./theme.ts")
const { prefs } = await import("./prefs.ts")
const { store } = await import("../store.ts")
const { composePending } = await import("./editorBridge.ts")

test("the address's embed mode is kept for the frame's session", () => {
  assert.equal(embedded(), true)
  assert.deepEqual(JSON.parse(session.get("frizz.embed")!), { host: "vscode", theme: "dark" })
})

test("a sidebar is the phone layout at any width", () => {
  assert.equal(phoneLayout(), true)
})

test("a code file goes to the editor with its place, never to the reader or the server", async () => {
  for (const codeFiles of ["auto", "frizz", "editor"] as const) {
    prefs.codeFiles = codeFiles
    posted.length = 0
    openLocalPath("/repo/src/a.ts", null, null, { line: 12, column: 3, endLine: 20 })
    assert.deepEqual(posted, [{ type: "frizz:open-file", path: "/repo/src/a.ts", line: 12, column: 3, endLine: 20 }], codeFiles)
  }
  posted.length = 0
  openLocalPath("/repo/Makefile")
  assert.deepEqual(posted, [{ type: "frizz:open-file", path: "/repo/Makefile" }])
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(store.drawers.length, 0, "no reader opened")
  assert.deepEqual(fetched, [], "nothing asked of the server")
})

test("Markdown still opens in Frizz's reader", () => {
  posted.length = 0
  openLocalPath("/repo/README.md")
  assert.deepEqual(posted, [])
  assert.deepEqual(store.drawers.map((drawer) => drawer.kind === "file" && drawer.path), ["/repo/README.md"])
})

test("a web page opened from code goes to the editor, and only http(s) does", () => {
  posted.length = 0
  openExternalUrl("https://github.com/acme/app/pull/12")
  openExternalUrl("javascript:alert(1)")
  assert.deepEqual(posted, [{ type: "frizz:open-external", url: "https://github.com/acme/app/pull/12" }])
})

test("the editor's theme wins for the session and never touches the stored preference", () => {
  initTheme()
  assert.deepEqual(getThemeSnapshot(), { preference: "light", resolved: "dark" })
  assert.equal(root.dataset.theme, "dark")
  setHostTheme("light")
  assert.deepEqual(getThemeSnapshot(), { preference: "light", resolved: "light" })
  setHostTheme("dark")
  assert.equal(root.dataset.theme, "dark")
  assert.equal(local.get("frizz-theme"), "light", "the preference is the human's, untouched")
  assert.equal(JSON.parse(session.get("frizz.embed")!).theme, "dark", "a reload of this frame keeps the editor's latest")
})

test("a sidebar never claims an item the server holds for a browser tab", async () => {
  // Focused, with a board in: everything a browser tab needs to claim on `compose-pending`. The extension
  // posts its own selections into the sidebar (frizz:compose); a held item is a window WITHOUT a sidebar's.
  const document = globalThis.document as unknown as { hasFocus(): boolean }
  const hasFocus = document.hasFocus
  document.hasFocus = () => true
  store.board = { threads: [], projectDir: "/repo" } as unknown as typeof store.board
  fetched.length = 0
  try {
    composePending()
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(fetched.filter((url) => url.includes("composeTake")), [])
  } finally {
    document.hasFocus = hasFocus
    store.board = null
  }
})
