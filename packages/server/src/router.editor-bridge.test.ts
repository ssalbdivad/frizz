import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EditorComposeItem, EditorKind, FilePosition, LocalFileOpener } from "@frizz/shared"
import { createRouter } from "./router.ts"
import type { AppContext } from "./context.ts"
import type { EditorBridge } from "./editor-bridge.ts"

// The router's half of the editor bridge: which opener a click reaches. The fallback spawn is REAL — a
// stand-in `code` on disk that logs its argv — so "the bridge declined, the editor was spawned at the
// line" is the actual child process's argv, not a stub's say-so.

interface Calls {
  open: [string, FilePosition | undefined, readonly EditorKind[]][]
  focus: [string, readonly EditorKind[]][]
}

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "frizz-router-editor-")))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const project = join(root, "project")
  const bin = join(root, "bin")
  mkdirSync(project)
  mkdirSync(bin)
  const file = join(project, "a.ts")
  writeFileSync(file, "x")
  const log = join(root, "opener.log")
  const code = join(bin, "code")
  writeFileSync(code, `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\n`)
  chmodSync(code, 0o755)
  const saved = { VISUAL: process.env.VISUAL, EDITOR: process.env.EDITOR, PATH: process.env.PATH }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  // `$EDITOR` names the stand-in, so the External app "editor" maps to the VS Code family and spawns it.
  process.env.VISUAL = code
  delete process.env.EDITOR
  const spawned = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : null)
  return { root, project, file, spawned }
}

function router(dir: string, opener: LocalFileOpener, editors?: Partial<EditorBridge>) {
  const ctx = {
    project: { dir, stateDir: dir, id: "p", name: "p", label: "p", cwdSlug: "p" },
    storage: {},
    board: {},
    tailer: {},
    getSettings: () => ({ localFileOpener: opener }),
    editors,
  } as unknown as AppContext
  return createRouter(ctx)
}

function bridge(answer: boolean | Error, calls: Calls): Partial<EditorBridge> {
  const settle = async () => {
    if (answer instanceof Error) throw answer
    return answer
  }
  return {
    openFile: (path, position, kinds) => {
      calls.open.push([path, position, kinds])
      return settle()
    },
    focusFolder: (dir, kinds) => {
      calls.focus.push([dir, kinds])
      return settle()
    },
  }
}

test("a connected editor gets the file at the asked position, and nothing is spawned", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t)
  const calls: Calls = { open: [], focus: [] }
  const r = router(f.project, "editor", bridge(true, calls))
  assert.deepEqual(await r.openLocalFile.handler({ input: { path: f.file, line: 12, column: 3, endLine: 20 } }), { action: "opened", path: f.file })
  // The page sent no position, but the path carries one: it is split off and handed over.
  assert.deepEqual(await r.openLocalFile.handler({ input: { path: `${f.file}:7` } }), { action: "opened", path: f.file })
  assert.deepEqual(calls.open, [
    [f.file, { line: 12, column: 3, endLine: 20 }, ["vscode"]],
    [f.file, { line: 7 }, ["vscode"]],
  ])
  assert.equal(f.spawned(), null)
})

test("no window takes it: the editor is spawned, at the position", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t)
  const calls: Calls = { open: [], focus: [] }
  const r = router(f.project, "editor", bridge(false, calls))
  assert.deepEqual(await r.openLocalFile.handler({ input: { path: f.file, line: 12, column: 3 } }), { action: "opened", path: f.file })
  assert.equal(calls.open.length, 1)
  assert.deepEqual(f.spawned(), ["-g", `${f.file}:12:3`])
  // No bridge at all (a context the server did not build) spawns the same way.
  rmSync(join(f.root, "opener.log"))
  await router(f.project, "editor").openLocalFile.handler({ input: { path: f.file, line: 5 } })
  assert.deepEqual(f.spawned(), ["-g", `${f.file}:5`])
})

test("a window that answers it could not is the error, and no second opener is spawned", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t)
  const r = router(f.project, "editor", bridge(new Error("Could not open a.ts"), { open: [], focus: [] }))
  await assert.rejects(r.openLocalFile.handler({ input: { path: f.file, line: 1 } }), /^Error: Could not open a\.ts$/)
  assert.equal(f.spawned(), null)
})

test("a setting that is not an editor, or an image, never asks the bridge", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t)
  const calls: Calls = { open: [], focus: [] }
  assert.deepEqual(await router(f.project, "copy", bridge(true, calls)).openLocalFile.handler({ input: { path: f.file, line: 3 } }), { action: "copy", path: f.file })
  // An image goes to the system viewer. Nothing is on PATH, so the spawn fails — which proves it was tried.
  const empty = join(f.root, "empty")
  mkdirSync(empty)
  process.env.PATH = empty
  await assert.rejects(
    router(f.project, "editor", bridge(true, calls)).openLocalFile.handler({ input: { path: f.file, image: true } }),
    /xdg-open is not installed/,
  )
  assert.deepEqual(calls.open, [])
})

test("Open in editor raises the window that has the folder open, else spawns the editor on it", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t)
  const calls: Calls = { open: [], focus: [] }
  // "system" is not an editor, so a folder goes to $EDITOR (folderEditor) — and the bridge is asked for
  // THAT family.
  assert.deepEqual(await router(f.project, "system", bridge(true, calls)).openProjectFolder.handler({ input: {} }), { path: f.project })
  assert.deepEqual(calls.focus, [[f.project, ["vscode"]]])
  assert.equal(f.spawned(), null)
  assert.deepEqual(await router(f.project, "editor", bridge(false, calls)).openProjectFolder.handler({ input: {} }), { path: f.project })
  assert.deepEqual(f.spawned(), [f.project])
  // No editor to open a folder in at all: the reason, and the bridge is never asked.
  process.env.VISUAL = "nvim"
  await assert.rejects(router(f.project, "system", bridge(true, calls)).openProjectFolder.handler({ input: {} }), /Set External app to an editor/)
  assert.equal(calls.focus.length, 2)
})

test("editorWindows and composeTake answer from the bridge, and from nothing without one", async () => {
  const item: EditorComposeItem = { id: "c1", app: "Cursor", at: "2026-10-01T00:00:00.000Z", path: "/p/a.ts", text: "x", startLine: 1 }
  const taken: (string | undefined)[] = []
  const r = router(tmpdir(), "vscode", {
    windows: () => [{ app: "Cursor", kind: "cursor", acceptsOpens: true }],
    takeCompose: (id) => {
      taken.push(id)
      return id === "c1" ? item : null
    },
  })
  assert.deepEqual(await r.editorWindows.handler({}), { windows: [{ app: "Cursor", kind: "cursor", acceptsOpens: true }] })
  assert.deepEqual(await r.composeTake.handler({ input: { id: "c1" } }), { item })
  assert.deepEqual(await r.composeTake.handler({ input: {} }), { item: null })
  assert.deepEqual(taken, ["c1", undefined])
  const bare = router(tmpdir(), "vscode")
  assert.deepEqual(await bare.editorWindows.handler({}), { windows: [] })
  assert.deepEqual(await bare.composeTake.handler({ input: {} }), { item: null })
})

test("openLocalFile takes a position only as positive whole numbers, and still nothing else", () => {
  const input = router(tmpdir(), "vscode").openLocalFile.input
  assert.equal(input.safeParse({ path: "/a", line: 1, column: 2, endLine: 3 }).success, true)
  for (const bad of [{ line: 0 }, { line: 1.5 }, { column: -1 }, { endLine: "3" }, { lineNumber: 3 }]) {
    assert.equal(input.safeParse({ path: "/a", ...bad }).success, false, JSON.stringify(bad))
  }
  assert.equal(router(tmpdir(), "vscode").composeTake.input.safeParse({ id: "x", extra: 1 }).success, false)
})
