// THE END-TO-END SUITE — runs INSIDE a real VS Code (scripts/e2e.ts launches it as
// `--extensionTestsPath`), against the extension under development, and drives both directions:
// Frizz → editor (an `open` landing at its line, the status bar's count) and editor → Frizz (ask, send
// to thread, add to prompt), plus a dropped connection coming back.
//
// FAKE mode (default) talks to e2e/fake-frizz.ts through its /__e2e control surface and asserts on the
// exact frames and RPC calls it received. REAL mode points the extension at a real Frizz
// (FRIZZ_E2E_ORIGIN, with FRIZZ_E2E_PROJECT_DIR as the opened folder, which must be a registered
// project) and asserts through the server's own RPCs instead; the steps that would start a real agent
// run only with FRIZZ_E2E_DISPATCH=1 (and Send to thread also needs FRIZZ_E2E_THREAD, a thread's slug).

import assert from "node:assert/strict"
import { realpathSync } from "node:fs"
import { join } from "node:path"
import * as vscode from "vscode"
import type { EditorClientMessage, EditorComposed, EditorProject } from "@frizz/shared/editor-protocol"
import { parseSentContext } from "../../web/src/lib/composerContext.ts"
import type { FrizzExtensionApi } from "../src/app.ts"
import { projectForPath } from "../src/projects.ts"
import { FrizzRpc } from "../src/rpc.ts"

const mode = process.env.FRIZZ_E2E_MODE === "real" ? "real" : "fake"
const workspace = realpathSync(process.env.FRIZZ_E2E_WORKSPACE ?? "")
const sample = join(workspace, "src", "sample.ts")
const control = process.env.FRIZZ_E2E_CONTROL ?? ""

interface FakeLog {
  frames: EditorClientMessage[]
  refused: string[]
  rpc: { projectId: string; procedure: string; input: Record<string, unknown> }[]
  origins: string[]
}

async function fake<T = unknown>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${control}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  return (await response.json()) as T
}

const fakeLog = () => fake<FakeLog>("/__e2e/log")

async function until(what: string, condition: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function openSample(selection?: [number, number, number, number?]): Promise<vscode.TextEditor> {
  await vscode.commands.executeCommand("workbench.action.closeAllEditors")
  const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(sample))
  if (selection) {
    const [startLine, startCharacter, endLine, endCharacter] = selection
    editor.selection = new vscode.Selection(startLine, startCharacter, endLine, endCharacter ?? editor.document.lineAt(endLine).text.length)
  }
  return editor
}

/** The sample's 1-based lines `from`..`to`, as the extension quotes them. */
function sampleLines(document: vscode.TextDocument, from: number, to: number): string {
  return document.getText(new vscode.Range(from - 1, 0, to - 1, document.lineAt(to - 1).text.length))
}

interface Step {
  name: string
  modes: ("fake" | "real")[]
  run: (context: { api: FrizzExtensionApi; project: EditorProject; rpc: FrizzRpc }) => Promise<void>
}

const steps: Step[] = [
  {
    name: "the window says hello with its workspace folder, over the origin-gated socket",
    modes: ["fake", "real"],
    async run({ api, project, rpc }) {
      if (mode === "fake") {
        const log = await fakeLog()
        const hello = log.frames.find((frame) => frame.t === "hello")
        assert.ok(hello && hello.t === "hello")
        assert.deepEqual(hello.folders.map((folder) => realpathSync(folder)), [workspace])
        assert.equal(hello.app, vscode.env.appName)
        assert.equal(hello.v, 1)
        assert.equal(hello.acceptsOpens, true)
        assert.equal(hello.platform, process.platform)
        assert.equal(hello.windowId, api.windowId)
        assert.ok(log.origins.length > 0 && log.origins.every((origin) => origin === control))
        assert.deepEqual(log.refused, [], "every frame is one the server's own schema takes")
        assert.deepEqual(api.discovered(), { origin: control, port: Number(new URL(control).port), source: "setting" }, "the page opener knows where the address came from")
      } else {
        const { windows } = await rpc.query(project.id, "editorWindows")
        assert.ok(windows.some((window) => window.app === vscode.env.appName && window.acceptsOpens), JSON.stringify(windows))
      }
    },
  },
  {
    name: "a file link from Frizz opens at its line and column, and a range selects its whole lines",
    modes: ["fake", "real"],
    async run({ project, rpc }) {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors")
      if (mode === "fake") {
        const result = await fake<{ ok: boolean; error?: string }>("/__e2e/open", { path: sample, line: 5, column: 3 })
        assert.deepEqual({ ok: result.ok, error: result.error }, { ok: true, error: undefined })
      } else {
        const opened = await rpc.mutation(project.id, "openLocalFile", { path: sample, line: 5, column: 3 })
        assert.equal(opened.action, "opened")
      }
      await until("the sample in front", () => vscode.window.activeTextEditor?.document.uri.fsPath === sample)
      const editor = vscode.window.activeTextEditor!
      await until("the cursor at 5:3", () => editor.selection.isEmpty && editor.selection.active.line === 4 && editor.selection.active.character === 2)

      if (mode === "fake") {
        const range = await fake<{ ok: boolean }>("/__e2e/open", { path: sample, line: 2, endLine: 4 })
        assert.equal(range.ok, true)
      } else {
        await rpc.mutation(project.id, "openLocalFile", { path: sample, line: 2, endLine: 4 })
      }
      await until("lines 2-4 selected", () => {
        const s = vscode.window.activeTextEditor?.selection
        return !!s && s.start.line === 1 && s.start.character === 0 && s.end.line === 3 && s.end.character === editor.document.lineAt(3).text.length
      })

      if (mode === "fake") {
        const missing = await fake<{ ok: boolean; error?: string }>("/__e2e/open", { path: join(workspace, "nope.ts"), line: 1 })
        assert.equal(missing.ok, false)
        assert.match(missing.error ?? "", /doesn't exist/)
      }
    },
  },
  {
    name: "a focus request and an open on a folder answer ok, even where the editor cannot bring its window to the front",
    modes: ["fake"],
    async run() {
      // `workbench.action.focusWindow` arrived in VS Code 1.128: on the oldest VS Code the manifest
      // admits (FRIZZ_E2E_VSCODE=oldest), and in Cursor and Windsurf, raising the window throws. The
      // work it follows has already happened, so the answer is still ok.
      const focused = await fake<{ ok: boolean; error?: string }>("/__e2e/focus", { path: workspace })
      assert.deepEqual({ ok: focused.ok, error: focused.error }, { ok: true, error: undefined })
      const folder = await fake<{ ok: boolean; error?: string }>("/__e2e/open", { path: join(workspace, "src") })
      assert.deepEqual({ ok: folder.ok, error: folder.error }, { ok: true, error: undefined })
    },
  },
  {
    name: "the status bar shows this workspace's Ready count, and only when there is one",
    modes: ["fake", "real"],
    async run({ api, project }) {
      if (mode === "real") {
        assert.match(api.statusBar().text, /^Frizz/)
        return
      }
      await fake("/__e2e/projects", { projects: [{ ...project, ready: 3, working: 1 }] })
      await until("Frizz · 3 ready", () => api.statusBar().text === "Frizz · 3 ready")
      assert.match(api.statusBar().tooltip, /3 ready · 1 working/)
      assert.equal(api.statusBar().command, "frizz.open")
      await fake("/__e2e/projects", { projects: [{ ...project, ready: 0, working: 1 }] })
      await until("a bare Frizz", () => api.statusBar().text === "Frizz")
    },
  },
  {
    name: "Ask Frizz dispatches the selection as the page's chip, with the saved backend, model and effort",
    modes: ["fake", "real"],
    async run({ project, rpc }) {
      if (mode === "real" && process.env.FRIZZ_E2E_DISPATCH !== "1") return skip("starts a real agent; set FRIZZ_E2E_DISPATCH=1")
      const editor = await openSample([1, 0, 3])
      const asked = await vscode.commands.executeCommand<{ slug: string } | undefined>("frizz.ask", { question: "why does this loop?" })
      assert.ok(asked?.slug, "the command returns the new thread")
      const expected = sampleLines(editor.document, 2, 4)
      let prompt: string
      if (mode === "fake") {
        assert.equal(asked.slug, "asked-thread")
        const log = await fakeLog()
        const dispatch = log.rpc.find((call) => call.procedure === "dispatch")
        assert.ok(dispatch)
        assert.equal(dispatch.projectId, project.id)
        assert.deepEqual({ backend: dispatch.input.backend, model: dispatch.input.model, effort: dispatch.input.effort }, { backend: "claude", model: "sonnet", effort: "low" })
        assert.ok(log.rpc.findIndex((call) => call.procedure === "dispatchPreferencesGet") < log.rpc.indexOf(dispatch))
        prompt = String(dispatch.input.prompt)
      } else {
        // The prompt's format is pinned in FAKE mode and by message.test.ts; here, that the thread exists.
        const board = await rpc.query(project.id, "board")
        assert.ok(board.threads.some((t) => t.id === asked.slug), `thread ${asked.slug} on the board`)
        return
      }
      const parsed = parseSentContext(prompt)
      assert.ok(parsed, `the page parses it as a chip: ${prompt}`)
      assert.equal(parsed.body, "@sample.ts:2-4 why does this loop?")
      assert.deepEqual(parsed.items, [{ token: "@sample.ts:2-4", display: "src/sample.ts", startLine: 2, endLine: 4, text: expected }])
    },
  },
  {
    name: "Send to Frizz thread follows up the named thread, once, with an idempotent delivery id",
    modes: ["fake", "real"],
    async run({ project }) {
      if (mode === "real" && (process.env.FRIZZ_E2E_DISPATCH !== "1" || !process.env.FRIZZ_E2E_THREAD)) return skip("delivers to a real agent; set FRIZZ_E2E_DISPATCH=1 and FRIZZ_E2E_THREAD")
      const thread = mode === "fake" ? "@fake-thread" : process.env.FRIZZ_E2E_THREAD!
      const editor = await openSample([2, 0, 2])
      const sent = await vscode.commands.executeCommand<{ slug: string; deliveryId: string } | undefined>("frizz.sendToThread", { thread, message: "look here" })
      assert.ok(sent, "the command returns the delivery")
      assert.match(sent.deliveryId, /^[0-9a-f-]{36}$/)
      if (mode === "real") return
      const followUps = (await fakeLog()).rpc.filter((call) => call.procedure === "followUp")
      assert.equal(followUps.length, 1)
      const input = followUps[0]!.input
      assert.equal(followUps[0]!.projectId, project.id)
      assert.deepEqual({ slug: input.slug, sessionId: input.sessionId, deliveryId: input.deliveryId }, { slug: "fake-thread", sessionId: "fake-session", deliveryId: sent.deliveryId })
      const parsed = parseSentContext(String(input.message))
      assert.ok(parsed)
      assert.equal(parsed.body, "@sample.ts:3 look here")
      assert.equal(parsed.items[0]?.text, sampleLines(editor.document, 3, 3))
    },
  },
  {
    name: "Send to Frizz thread refuses a selection in an untitled buffer rather than sending the message without it",
    modes: ["fake"],
    async run() {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors")
      const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content: "a pasted log\nERROR the part that matters\n" }))
      editor.selection = new vscode.Selection(1, 0, 1, 26)
      const before = (await fakeLog()).rpc.length
      const sent = await vscode.commands.executeCommand<unknown>("frizz.sendToThread", { thread: "@fake-thread", message: "why?" })
      assert.equal(sent, undefined, "nothing was sent")
      assert.deepEqual((await fakeLog()).rpc.slice(before).map((call) => call.procedure), [], "not even the thread list was asked for")
      await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor")
    },
  },
  {
    name: "Add to Frizz prompt hands the selection to Frizz for the page's prompt box",
    modes: ["fake", "real"],
    async run({ project, rpc }) {
      const editor = await openSample([1, 0, 2])
      const composed = await vscode.commands.executeCommand<EditorComposed | undefined>("frizz.addToPrompt")
      assert.equal(composed?.ok, true, JSON.stringify(composed))
      const expected = { projectId: project.id, path: sample, text: sampleLines(editor.document, 2, 3), startLine: 2, endLine: 3 }
      if (mode === "fake") {
        const compose = (await fakeLog()).frames.find((frame) => frame.t === "compose")
        assert.ok(compose && compose.t === "compose")
        assert.equal(compose.id, composed!.id)
        assert.deepEqual(compose.item, expected)
      } else if (process.env.FRIZZ_E2E_PAGE_CLAIMS === "1") {
        // A real page is open on this Frizz and claims it itself; the harness beside it asserts the chip.
        return
      } else {
        const { item } = await rpc.mutation(project.id, "composeTake", {})
        assert.ok(item, "the server holds it for a page to claim")
        assert.deepEqual({ projectId: item.projectId, path: item.path, text: item.text, startLine: item.startLine, endLine: item.endLine }, expected)
      }
    },
  },
  {
    name: "turning off Open file links tells Frizz at once",
    modes: ["fake", "real"],
    async run({ project, rpc }) {
      const config = vscode.workspace.getConfiguration("frizz")
      await config.update("openFileLinks", false, vscode.ConfigurationTarget.Global)
      try {
        if (mode === "fake") {
          await until("a state frame with acceptsOpens false", async () => (await fakeLog()).frames.some((frame) => frame.t === "state" && !frame.acceptsOpens))
        } else {
          await until("the window listed as not taking opens", async () => (await rpc.query(project.id, "editorWindows")).windows.some((w) => w.app === vscode.env.appName && !w.acceptsOpens))
        }
      } finally {
        await config.update("openFileLinks", undefined, vscode.ConfigurationTarget.Global)
      }
    },
  },
  {
    name: "a dropped connection comes back on its own and says hello again",
    modes: ["fake"],
    async run({ api }) {
      const before = (await fakeLog()).frames.filter((frame) => frame.t === "hello").length
      await fake("/__e2e/drop", {})
      await until("a second hello", async () => (await fakeLog()).frames.filter((frame) => frame.t === "hello").length > before, 15_000)
      await until("connected again", () => api.status().kind === "connected")
    },
  },
]

class Skipped extends Error {}
function skip(why: string): never {
  throw new Skipped(why)
}

export async function run(): Promise<void> {
  console.log(`frizz e2e: ${mode} mode, workspace ${workspace}, ${vscode.env.appName} ${vscode.version}`)
  const extension = vscode.extensions.getExtension<FrizzExtensionApi>("colinhacks.frizz-vscode")
  assert.ok(extension, "the extension under development is installed")
  const api = await extension.activate()
  await until("the connection to Frizz", () => api.status().kind === "connected", 30_000)
  const origin = api.origin()!
  await until("the projects push", () => api.projects().length > 0)
  const project = projectForPath(workspace, api.projects())?.project
  assert.ok(project, `a project holds ${workspace}: ${JSON.stringify(api.projects())}`)
  const rpc = new FrizzRpc(origin)

  // REAL mode: file links reach an editor only when Frizz's External app setting is VS Code.
  let restoreSettings: (() => Promise<unknown>) | undefined
  if (mode === "real" && process.env.FRIZZ_E2E_SET_OPENER === "1") {
    const settings = await rpc.query(project.id, "settingsGet")
    await rpc.mutation(project.id, "settingsSet", { ...settings, localFileOpener: "vscode" })
    restoreSettings = () => rpc.mutation(project.id, "settingsSet", settings)
  }

  const failures: string[] = []
  try {
    for (const step of steps) {
      if (!step.modes.includes(mode)) continue
      try {
        await step.run({ api, project, rpc })
        console.log(`  ✔ ${step.name}`)
      } catch (error) {
        if (error instanceof Skipped) {
          console.log(`  - ${step.name} (skipped: ${error.message})`)
          continue
        }
        failures.push(step.name)
        console.log(`  ✖ ${step.name}\n${(error as Error).stack ?? error}`)
      }
    }
  } finally {
    await restoreSettings?.()
  }
  if (failures.length) throw new Error(`${failures.length} end-to-end step(s) failed: ${failures.join("; ")}`)
}
