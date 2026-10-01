import { test } from "node:test"
import assert from "node:assert/strict"
import type { EditorWindowSummary } from "@frizz/shared"
import { connectedOpeners, editorOffer, parseOffered } from "./editorWindows.ts"

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
    editorOffer({ windows: [vscode], codeFiles: "frizz", opener: "system", offered: none, phone: false, ...over })
  assert.equal(offer({}), "vscode")
  // Either half of "code files go there" missing is still an offer.
  assert.equal(offer({ codeFiles: "editor", opener: "cursor" }), "vscode")
  assert.equal(offer({ codeFiles: "frizz", opener: "vscode" }), "vscode")
  // Both halves already there: nothing to offer.
  assert.equal(offer({ codeFiles: "editor", opener: "vscode" }), null)
  // Once per editor per browser, and never on the phone layout.
  assert.equal(offer({ offered: new Set(["vscode"]) }), null)
  assert.equal(offer({ phone: true }), null)
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
