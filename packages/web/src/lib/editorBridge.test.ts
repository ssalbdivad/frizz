import assert from "node:assert/strict"
import test from "node:test"
import type { BoardSnapshot } from "@frizz/shared"
import { resetProjectState, store } from "../store.ts"
import { sendCodeFilesTo, threadInFront } from "./editorBridge.ts"
import { prefs } from "./prefs.ts"

function at<T>(pathname: string, run: () => T): T {
  const previous = globalThis.location
  globalThis.location = { pathname, search: "", origin: "http://127.0.0.1:4100" } as unknown as Location
  try {
    return run()
  } finally {
    globalThis.location = previous
  }
}

// The /full page's thread is the one the ADDRESS names, at any width. It was read off the split file
// viewer's layout flag (true only at 1200px and wider), so beside VS Code in a half-width window an insert
// went to a new-thread draft the page never shows, or navigated off the thread (review C4).
test("the /full page's thread is in front whatever the window's width", () => {
  resetProjectState()
  store.board = { threads: [{ id: "fix-auth", sessionId: "s1" }] } as unknown as BoardSnapshot
  store.splitFileViewer = false
  try {
    assert.deepEqual(at("/thread/fix-auth/full", threadInFront), { slug: "fix-auth", sessionId: "s1" })
    assert.deepEqual(at("/all/nub/thread/fix-auth/full", threadInFront), { slug: "fix-auth", sessionId: "s1" })
    // The board, with no drawer open: no thread in front.
    assert.equal(at("/", threadInFront), undefined)
    // A thread the board does not have is no target.
    assert.equal(at("/thread/elsewhere/full", threadInFront), undefined)
  } finally {
    resetProjectState()
  }
})

const settings = { localFileOpener: "system" }

async function withFetch(answer: (url: string) => Response | Promise<Response>, run: () => Promise<void>): Promise<string[]> {
  const original = globalThis.fetch
  const previous = globalThis.location
  const calls: string[] = []
  globalThis.location = { pathname: "/", search: "", origin: "http://127.0.0.1:4100" } as unknown as Location
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    calls.push(url)
    return answer(url)
  }) as typeof fetch
  try {
    await run()
  } finally {
    globalThis.fetch = original
    globalThis.location = previous
  }
  return calls
}

// The procedure a request names: the last segment of its path, whatever prefix the page's apiBase gave it
// (a query is an absolute URL with `?input=`, a mutation a bare path).
const procedure = (url: string) => url.replace(/[?#].*$/u, "").split("/").pop()

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

// "Use VS Code" switches this browser's code files only once the External app has landed. Switched first,
// a failed write left every code-file click going to the OLD External app instead of the reader (review C7).
test("the offer's action leaves this browser's code files alone when the settings write fails", async () => {
  prefs.codeFiles = "frizz"
  for (const fail of ["settingsGet", "settingsSet"]) {
    const calls = await withFetch((url) => {
      if (procedure(url) === fail) return json({ error: "Frizz is restarting" }, 500)
      return json({ result: settings })
    }, () => sendCodeFilesTo("vscode"))
    assert.equal(calls.map(procedure).at(-1), fail, "the failure is the one this case meant")
    assert.equal(prefs.codeFiles, "frizz", `${fail} failed: the browser half stays as it was`)
    assert.equal(store.toast?.text, "Couldn't set the External app to VS Code")
  }
  // A network failure, not an answer: the same.
  await withFetch(() => Promise.reject(new TypeError("fetch failed")), () => sendCodeFilesTo("vscode"))
  assert.equal(prefs.codeFiles, "frizz")
})

test("the offer's action switches both halves once the write lands", async () => {
  prefs.codeFiles = "frizz"
  const calls = await withFetch((url) => json({ result: procedure(url) === "settingsSet" ? { localFileOpener: "vscode" } : settings }), () => sendCodeFilesTo("vscode"))
  assert.ok(calls.some((url) => procedure(url) === "settingsSet"))
  assert.equal(prefs.codeFiles, "editor")
  assert.equal(store.toast?.text, "Code files open in VS Code")
  prefs.codeFiles = "frizz"
})
