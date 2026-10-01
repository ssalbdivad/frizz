import { test } from "node:test"
import assert from "node:assert/strict"
import type { EditorWindowSummary } from "@frizz/shared"
import { codeFilesDestination, connectedOpeners, editorOffer, parseOffered } from "./editorWindows.ts"

const vscode: EditorWindowSummary = { app: "Visual Studio Code", kind: "vscode", acceptsOpens: true }
const cursor: EditorWindowSummary = { app: "Cursor", kind: "cursor", acceptsOpens: true }
const windsurf: EditorWindowSummary = { app: "Windsurf", kind: "windsurf", acceptsOpens: true }
const closed: EditorWindowSummary = { app: "Visual Studio Code", kind: "vscode", acceptsOpens: false }
const none = new Set<string>()

test("the settings mark names only an External app choice with an accepting window behind it", () => {
  assert.deepEqual([...connectedOpeners([vscode, windsurf])], ["vscode"])
  assert.deepEqual([...connectedOpeners([closed, cursor])], ["cursor"])
  assert.deepEqual([...connectedOpeners([closed, windsurf, { app: "VSCodium", kind: "other", acceptsOpens: true }])], [])
})

test("the offer: an accepting editor this browser's code files do not go to yet", () => {
  const offer = (over: Partial<Parameters<typeof editorOffer>[0]>) =>
    editorOffer({ windows: [vscode], codeFiles: "frizz", opener: "system", offered: none, phone: false, remote: false, ...over })
  assert.equal(offer({}), "vscode")
  // Either half of "code files go there" missing is still an offer.
  assert.equal(offer({ codeFiles: "editor", opener: "cursor" }), "vscode")
  assert.equal(offer({ codeFiles: "frizz", opener: "vscode" }), "vscode")
  // Both halves already there: nothing to offer. Automatic with External app already that editor sends
  // code files there while it is connected, so there is nothing to offer either.
  assert.equal(offer({ codeFiles: "editor", opener: "vscode" }), null)
  assert.equal(offer({ codeFiles: "auto", opener: "vscode" }), null)
  assert.equal(offer({ codeFiles: "auto", opener: "system" }), "vscode")
  // Once per editor per browser, and never on the phone layout.
  assert.equal(offer({ offered: new Set(["vscode"]) }), null)
  assert.equal(offer({ phone: true }), null)
  // Nor to a remote-access session at any width: its clicks would open in a window on the desk (review C8).
  assert.equal(offer({ remote: true }), null)
  assert.equal(offer({ remote: true, windows: [cursor, vscode] }), null)
  // Only an accepting window, only an editor the setting can name.
  assert.equal(offer({ windows: [closed] }), null)
  assert.equal(offer({ windows: [windsurf] }), null)
  assert.equal(offer({ windows: [] }), null)
  // Two editors: the first not yet offered, in the server's order.
  assert.equal(offer({ windows: [cursor, vscode] }), "cursor")
  assert.equal(offer({ windows: [cursor, vscode], offered: new Set(["cursor"]) }), "vscode")
})

test("the offered marker reads damage as nothing offered", () => {
  assert.deepEqual([...parseOffered(JSON.stringify(["vscode"]))], ["vscode"])
  for (const raw of [null, "", "{", "\"vscode\"", JSON.stringify([1, null])]) assert.deepEqual([...parseOffered(raw)], [], String(raw))
})

test("where a code file goes: a choice is final; automatic is the External app while that editor takes opens", () => {
  const to = (over: Partial<Parameters<typeof codeFilesDestination>[0]>) =>
    codeFilesDestination({ codeFiles: "auto", windows: [vscode], opener: "vscode", phone: false, remote: false, ...over })
  assert.equal(to({}), "editor")
  assert.equal(to({ windows: [cursor], opener: "cursor" }), "editor")
  // The External app is not the connected editor — nor an editor at all.
  assert.equal(to({ opener: "cursor" }), "frizz")
  assert.equal(to({ opener: "system" }), "frizz")
  assert.equal(to({ opener: "editor" }), "frizz")
  assert.equal(to({ opener: undefined }), "frizz")
  // No window, or one that turned file opens off.
  assert.equal(to({ windows: [] }), "frizz")
  assert.equal(to({ windows: [closed] }), "frizz")
  // Never from the phone layout or a remote session: the open would land on the desk.
  assert.equal(to({ phone: true }), "frizz")
  assert.equal(to({ remote: true }), "frizz")
  // A choice this browser made stands whatever is connected.
  assert.equal(to({ codeFiles: "frizz" }), "frizz")
  assert.equal(to({ codeFiles: "editor", windows: [], opener: "system", remote: true }), "editor")
})
