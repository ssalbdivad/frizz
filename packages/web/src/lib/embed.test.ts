import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import { hostKeyChord, parseHostMessage, readEmbedState } from "./embed.ts"

// Embed mode's pure halves (lib/embed.ts): the boot read, the host messages the page accepts, and the
// key chords it hands the editor. The contract is packages/shared/src/embed-protocol.ts.

test("embed mode is read from the first address, and from the frame's session record after that", () => {
  assert.deepEqual(readEmbedState("?embed=vscode&theme=dark&project=nub", null), { host: "vscode", theme: "dark" })
  // In-app navigation dropped the query; a reload of the frame still knows.
  assert.deepEqual(readEmbedState("", JSON.stringify({ host: "vscode", theme: "light" })), { host: "vscode", theme: "light" })
  // The address is the extension's latest word, so it wins over an older record.
  assert.deepEqual(readEmbedState("?embed=vscode&theme=light", JSON.stringify({ host: "vscode", theme: "dark" })), { host: "vscode", theme: "light" })
  assert.deepEqual(readEmbedState("?embed=vscode&theme=sepia", null), { host: "vscode" })
  for (const [search, stored] of [["", null], ["?embed=other", null], ["?theme=dark", null], ["", "not json"], ["", JSON.stringify({ host: "other" })]] as const) {
    assert.equal(readEmbedState(search, stored), null, `${search} ${stored}`)
  }
})

test("the pre-paint guard applies the editor's theme over the stored one, and marks the page embedded", () => {
  const entry = readFileSync(new URL("../../index.html", import.meta.url), "utf8")
  const script = [...entry.matchAll(/<script>([\s\S]*?)<\/script>/g)][0]?.[1]
  assert.ok(script)
  const run = (search: string, session: string | null, stored: string | null) => {
    const meta = { content: "", setAttribute(_: string, value: string) { this.content = value } }
    const documentElement = { dataset: {} as Record<string, string>, style: {} as Record<string, string> }
    vm.runInNewContext(script, {
      URLSearchParams,
      location: { search },
      sessionStorage: { getItem: () => session },
      localStorage: { getItem: () => stored },
      matchMedia: () => ({ matches: false }),
      document: { documentElement, querySelector: () => meta },
    })
    return documentElement.dataset
  }
  assert.deepEqual(run("?embed=vscode&theme=dark", null, "light"), { embed: "vscode", theme: "dark" })
  assert.deepEqual(run("", JSON.stringify({ host: "vscode", theme: "dark" }), "light"), { embed: "vscode", theme: "dark" })
  // Embedded with no theme named: the page's own resolution, still marked embedded.
  assert.deepEqual(run("?embed=vscode", null, "dark"), { embed: "vscode", theme: "dark" })
  assert.deepEqual(run("?theme=dark", null, "light"), { theme: "light" })
})

const compose = {
  type: "frizz:compose",
  id: "n1",
  item: { app: "Visual Studio Code", path: "/repo/a.ts", text: "const a = 1", startLine: 3, endLine: 5, projectId: "p1" },
  target: "front",
  focus: false,
}

test("host messages are accepted in the contract's shapes only", () => {
  assert.deepEqual(parseHostMessage({ type: "frizz:theme", theme: "light" }), { type: "frizz:theme", theme: "light" })
  assert.deepEqual(parseHostMessage(compose), compose)
  assert.deepEqual(parseHostMessage({ ...compose, target: { thread: "fix", project: "nub" }, focus: true }), { ...compose, target: { thread: "fix", project: "nub" }, focus: true })
  assert.deepEqual(parseHostMessage({ type: "frizz:navigate", to: "queue" }), { type: "frizz:navigate", to: "queue" })
  assert.deepEqual(parseHostMessage({ type: "frizz:navigate", to: { project: "nub" } }), { type: "frizz:navigate", to: { project: "nub" } })
  assert.deepEqual(parseHostMessage({ type: "frizz:navigate", to: { project: "nub", thread: "fix" } }), { type: "frizz:navigate", to: { thread: "fix", project: "nub" } })
  // Only the fields the contract names travel on: a stray one is not passed into the prompt box's code.
  assert.deepEqual(parseHostMessage({ ...compose, item: { ...compose.item, extra: "x" }, more: 1 }), compose)
  // A note is one line of prose: newlines and runs of space fold to one space.
  assert.deepEqual(parseHostMessage({ ...compose, note: "Fix: Cannot find\n  name 'a'." }), { ...compose, note: "Fix: Cannot find name 'a'." })
  assert.deepEqual(parseHostMessage({ ...compose, note: "" }), compose)
  const file = { path: "/repo/a.ts", label: "src/a.ts", projectId: "p1" }
  const context = { type: "frizz:editor-context", active: { ...file, selection: { startLine: 3, endLine: 9, chars: 120 } }, open: [{ path: "/repo/b.ts", label: "b.ts" }] }
  assert.deepEqual(parseHostMessage(context), context)
  assert.deepEqual(parseHostMessage({ ...context, active: { ...file, extra: 1 } }), { ...context, active: file })
  assert.deepEqual(parseHostMessage({ type: "frizz:editor-context", active: null, open: [] }), { type: "frizz:editor-context", active: null, open: [] })
  for (const command of ["new-thread", "queue", "jump", "settings"]) assert.deepEqual(parseHostMessage({ type: "frizz:command", command }), { type: "frizz:command", command })

  const refused: unknown[] = [
    null,
    "frizz:theme",
    { type: "frizz:theme", theme: "sepia" },
    { type: "frizz:unknown" },
    { type: "frizz:navigate", to: "everything" },
    { type: "frizz:navigate", to: { thread: "fix" } },
    { ...compose, id: "" },
    { ...compose, focus: "yes" },
    { ...compose, target: "back" },
    { ...compose, target: { thread: "fix" } },
    { ...compose, item: { ...compose.item, path: "" } },
    { ...compose, item: { ...compose.item, app: undefined } },
    { ...compose, item: { ...compose.item, text: 7 } },
    { ...compose, item: { ...compose.item, text: "x".repeat(64 * 1024 + 1) } },
    { ...compose, item: { ...compose.item, startLine: 0 } },
    { ...compose, item: { ...compose.item, endLine: 2.5 } },
    { ...compose, note: 5 },
    { ...compose, note: "x".repeat(2001) },
    { ...context, open: undefined },
    { ...context, open: Array.from({ length: 51 }, () => file) },
    { ...context, open: [{ path: "/repo/b.ts" }] },
    { ...context, active: undefined },
    { ...context, active: { ...file, label: "" } },
    { ...context, active: { ...file, selection: { startLine: 9, endLine: 3, chars: 1 } } },
    { ...context, active: { ...file, selection: { startLine: 3, endLine: 9, chars: 0 } } },
    { ...context, active: { ...file, selection: { startLine: 3, chars: 4 } } },
    { type: "frizz:command", command: "close" },
    { type: "frizz:command" },
  ]
  for (const message of refused) assert.equal(parseHostMessage(message), null, JSON.stringify(message)?.slice(0, 120))
})

const key = (over: Partial<KeyboardEvent>) =>
  ({ key: "p", code: "KeyP", ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, defaultPrevented: false, repeat: false, isComposing: false, ...over }) as KeyboardEvent

test("Ctrl and Cmd chords the page left alone go to the editor; the editing chords never do", () => {
  assert.deepEqual(hostKeyChord(key({})), { type: "frizz:key", key: "p", code: "KeyP", ctrl: true, meta: false, shift: true, alt: false })
  assert.deepEqual(hostKeyChord(key({ key: "b", code: "KeyB", ctrlKey: false, metaKey: true, shiftKey: false })), { type: "frizz:key", key: "b", code: "KeyB", ctrl: false, meta: true, shift: false, alt: false })
  for (const editing of ["c", "x", "v", "z", "y", "a", "C", "Z", "V", "Insert"]) {
    assert.equal(hostKeyChord(key({ key: editing, shiftKey: editing !== editing.toLowerCase() })), null, editing)
    assert.equal(hostKeyChord(key({ key: editing, ctrlKey: false, metaKey: true })), null, `⌘${editing}`)
  }
  assert.equal(hostKeyChord(key({ ctrlKey: false, metaKey: false })), null, "no Ctrl or Cmd")
  assert.equal(hostKeyChord(key({ defaultPrevented: true })), null, "the page took it")
  assert.equal(hostKeyChord(key({ repeat: true })), null, "auto-repeat")
  assert.equal(hostKeyChord(key({ isComposing: true })), null, "IME composition")
  assert.equal(hostKeyChord(key({ key: "Control", code: "ControlLeft" })), null, "a bare modifier")
})
