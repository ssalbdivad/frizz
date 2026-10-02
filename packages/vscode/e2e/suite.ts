// THE END-TO-END SUITE — runs INSIDE a real VS Code (scripts/e2e.ts launches it as
// `--extensionTestsPath`), against the extension under development, and drives both directions:
// Frizz → editor (an `open` landing at its line, the status bar's count) and editor → Frizz (ask, send
// to thread, add to prompt), plus a dropped connection coming back. Then the Frizz sidebar (fake mode
// only): its frame of a fake page that speaks the embed contract (fake-frizz.ts), the same three
// commands landing in that page instead, and what the page can ask of the editor.
//
// FAKE mode (default) talks to e2e/fake-frizz.ts through its /__e2e control surface and asserts on the
// exact frames and RPC calls it received. REAL mode points the extension at a real Frizz
// (FRIZZ_E2E_ORIGIN, with FRIZZ_E2E_PROJECT_DIR as the opened folder, which must be a registered
// project) and asserts through the server's own RPCs instead; the steps that would start a real agent
// run only with FRIZZ_E2E_DISPATCH=1; Send to thread follows up FRIZZ_E2E_THREAD, or else the thread
// Ask just started.

import assert from "node:assert/strict"
import { realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import * as vscode from "vscode"
import type { EditorClientMessage, EditorComposed, EditorProject } from "@frizz/shared/editor-protocol"
import type { EmbedEditorContextMessage } from "@frizz/shared/embed-protocol"
import { parseSentContext } from "../../web/src/lib/composerContext.ts"
import type { FrizzExtensionApi } from "../src/app.ts"
import { projectForPath } from "../src/projects.ts"
import { FrizzRpc } from "../src/rpc.ts"

const mode = process.env.FRIZZ_E2E_MODE === "real" ? "real" : "fake"
const workspace = realpathSync(process.env.FRIZZ_E2E_WORKSPACE ?? "")
const sample = join(workspace, "src", "sample.ts")
const control = process.env.FRIZZ_E2E_CONTROL ?? ""
const elsewhere = process.env.FRIZZ_E2E_CONTROL_ELSEWHERE ?? ""

interface FakeLog {
  frames: EditorClientMessage[]
  refused: string[]
  rpc: { projectId: string; procedure: string; input: Record<string, unknown> }[]
  origins: string[]
  page: { loads: string[]; received: { origin: string; data: { type?: string } & Record<string, unknown> }[] }
}

async function fake<T = unknown>(path: string, body?: unknown, at = control): Promise<T> {
  const response = await fetch(`${at}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  return (await response.json()) as T
}

const fakeLog = (at = control) => fake<FakeLog>("/__e2e/log", undefined, at)

/** What the fake page received from the sidebar after `from` messages, by type. */
async function pageReceived(type: string, from = 0, at = control) {
  return (await fakeLog(at)).page.received.slice(from).map((entry) => entry.data).filter((data) => data.type === type)
}

/**
 * A command that should land in the sidebar, bounded: when it does not, Ask and Send fall back to an
 * input box that would wait for a human forever. Dismissed, so the next step starts clean.
 */
async function landsInSidebar<T>(command: Thenable<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} did not land in the sidebar within 30s`)), 30_000)))
  try {
    return await Promise.race([command, late])
  } catch (error) {
    await vscode.commands.executeCommand("workbench.action.closeQuickOpen")
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** Have the fake page post `message` to the sidebar, as the real page would. */
const pagePosts = (message: unknown) => fake("/__e2e/page-post", { message })

/** Every `frizz:editor-context` the page was told, after `from` messages. */
const contexts = async (from = 0) => (await pageReceived("frizz:editor-context", from)) as unknown as EmbedEditorContextMessage[]
const received = async () => (await fakeLog()).page.received.length
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The workbench itself, over the harness's debugging port: an expression's value, a trusted key, a trusted click. */
async function workbench<T>(expression: string): Promise<T> {
  const answer = await fake<{ value?: T; error?: string }>("/__e2e/workbench", { expression })
  if (answer.error) throw new Error(answer.error)
  return answer.value as T
}
async function press(chord: string): Promise<void> {
  const answer = await fake<{ error?: string }>("/__e2e/press", { chord })
  if (answer.error) throw new Error(answer.error)
}
const click = async (selector: string) => (await fake<{ clicked?: boolean; error?: string }>("/__e2e/click", { selector })).clicked === true

/** What VS Code's title row above the sidebar shows: its heading and the buttons in it, by their labels. */
const titleRow = () => workbench<{ heading: string; buttons: string[] }>(`(() => {
  const title = document.querySelector(".part.sidebar .composite.title")
  return {
    heading: title?.querySelector(".title-label")?.textContent ?? "",
    buttons: [...(title?.querySelectorAll(".title-actions .action-label") ?? [])].filter((a) => a.offsetWidth > 0).map((a) => a.getAttribute("aria-label") ?? ""),
  }
})()`)

/** The extension's own manifest, as the editor loaded it. */
const manifest = () => vscode.extensions.getExtension("ssalbdivad.frizz-vscode")!.packageJSON as {
  contributes: { keybindings: unknown[]; menus: Record<string, { command?: string; when?: string; group?: string }[]> }
}

/** A second file in the workspace for the steps that need more than one open. */
function workspaceFile(name: string): string {
  const path = join(workspace, "src", name)
  writeFileSync(path, `export const ${name.replace(/\W/gu, "_")} = 1\n`)
  return path
}

/** The query the sidebar's frame carries for this window. */
function embedQuery(project: EditorProject): string {
  const light = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light || vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight
  return `?embed=vscode&theme=${light ? "light" : "dark"}&project=${project.slug}`
}

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

/** The thread the real-mode Ask step started, for Send to follow up when no FRIZZ_E2E_THREAD is named. */
let askedThread: string | undefined

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
    name: "a focus request says whether the window came to the front; an open on a folder answers ok either way",
    modes: ["fake"],
    async run() {
      // `workbench.action.focusWindow` arrived in VS Code 1.128: on the oldest VS Code the manifest
      // admits (FRIZZ_E2E_VSCODE=oldest), and in Cursor and Windsurf, raising the window throws. A focus
      // request is only the raise, so there it answers that it could not, and Frizz falls back to the
      // editor's command line; an open has already happened by then, so it is ok on every version.
      const canRaise = (await vscode.commands.getCommands(true)).includes("workbench.action.focusWindow")
      const focused = await fake<{ ok: boolean; error?: string }>("/__e2e/focus", { path: workspace })
      if (canRaise) assert.deepEqual({ ok: focused.ok, error: focused.error }, { ok: true, error: undefined })
      else {
        assert.equal(focused.ok, false)
        assert.match(focused.error ?? "", /can't bring its window to the front/)
      }
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
      assert.equal(api.statusBar().command, "frizz.sidebar.focus", "a click shows the sidebar")
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
      askedThread = asked.slug
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
      const realThread = process.env.FRIZZ_E2E_THREAD || askedThread
      if (mode === "real" && (process.env.FRIZZ_E2E_DISPATCH !== "1" || !realThread)) return skip("delivers to a real agent; set FRIZZ_E2E_DISPATCH=1")
      const thread = mode === "fake" ? "@fake-thread" : realThread!
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
    name: "with the sidebar off, Add to Frizz prompt hands the selection to Frizz for the page's prompt box",
    modes: ["fake", "real"],
    async run({ project, rpc }) {
      const editor = await openSample([1, 0, 2])
      // With the sidebar on, Add opens it (the sidebar steps below); off, it is the browser's path.
      const frizz = vscode.workspace.getConfiguration("frizz")
      await frizz.update("useSidebar", false, vscode.ConfigurationTarget.Global)
      let composed: EditorComposed | undefined
      try {
        composed = await vscode.commands.executeCommand<EditorComposed | undefined>("frizz.addToPrompt")
      } finally {
        await frizz.update("useSidebar", undefined, vscode.ConfigurationTarget.Global)
      }
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

  // ── the sidebar ────────────────────────────────────────────────────────────────────────────────────
  // Every step above ran with the sidebar never opened: Add to Frizz prompt with the setting off, and Ask
  // and Send passing their text, which is sent directly whatever the sidebar does.
  {
    name: "Add to Frizz prompt opens the sidebar in a window that never had it, framing Frizz's page with the embed params, and lands there with the caret",
    modes: ["fake"],
    async run({ api, project }) {
      assert.equal(api.sidebar().opened, false, "nothing has opened it yet")
      const editor = await openSample([1, 0, 1])
      const composed = await landsInSidebar(vscode.commands.executeCommand<EditorComposed | undefined>("frizz.addToPrompt"), "Add")
      assert.equal(composed?.ok, true, JSON.stringify(composed))
      assert.equal(api.sidebar().opened, true)
      assert.equal(api.sidebar().ready, true)
      assert.deepEqual(await pageReceived("frizz:compose"), [{
        type: "frizz:compose",
        id: composed!.id,
        item: { projectId: project.id, path: sample, text: sampleLines(editor.document, 2, 2), startLine: 2, endLine: 2, app: vscode.env.appName },
        target: "front",
        focus: true,
      }])
      const query = embedQuery(project)
      assert.equal(api.sidebar().url, `${control}/${query}`)
      const log = await fakeLog()
      assert.deepEqual(log.page.loads, [`/${query}`], "Frizz served the page once, with those params")
      // Whatever the page reads from its URL, the theme follows once it is ready.
      await until("the theme posted", async () => (await pageReceived("frizz:theme")).length > 0)
      assert.ok(log.page.received.every((entry) => entry.origin.startsWith("vscode-webview://")), "everything reached the page from the sidebar's own document")
    },
  },
  {
    name: "the sidebar's badge is the workspace's Ready count",
    modes: ["fake"],
    async run({ api, project }) {
      await fake("/__e2e/projects", { projects: [{ ...project, ready: 2, working: 0 }] })
      await until("a badge of 2", () => api.sidebar().badge === 2)
      await fake("/__e2e/projects", { projects: [{ ...project, ready: 0, working: 0 }] })
      await until("no badge", () => api.sidebar().badge === undefined)
    },
  },
  {
    name: "Add to Frizz prompt puts the selection into the prompt box the sidebar shows, with the caret, not through Frizz",
    modes: ["fake"],
    async run({ api, project }) {
      const editor = await openSample([1, 0, 2])
      const before = await fakeLog()
      const composed = await vscode.commands.executeCommand<EditorComposed | undefined>("frizz.addToPrompt")
      assert.equal(composed?.ok, true, JSON.stringify(composed))
      const composes = await pageReceived("frizz:compose", before.page.received.length)
      assert.deepEqual(composes, [{
        type: "frizz:compose",
        id: composed!.id,
        // The very item the server path carries (the step above), so the page writes the same chip.
        item: { projectId: project.id, path: sample, text: sampleLines(editor.document, 2, 3), startLine: 2, endLine: 3, app: vscode.env.appName },
        target: "front",
        // The caret goes after the chip, as Cursor's Cmd+L and Frizz's own ⌘I put it.
        focus: true,
      }])
      assert.equal((await fakeLog()).frames.filter((frame) => frame.t === "compose").length, before.frames.filter((frame) => frame.t === "compose").length, "nothing went to Frizz to hold")
      assert.equal(api.sidebar().visible, true)
      // Focus is in the sidebar now; the editor in front is still the one the selection came from.
      assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, sample)
    },
  },
  {
    name: "Ask Frizz… opens the sidebar's new-thread box with the selection, and starts nothing itself",
    modes: ["fake"],
    async run({ project }) {
      const editor = await openSample([1, 0, 3])
      const before = await fakeLog()
      const asked = await landsInSidebar(vscode.commands.executeCommand<{ composed?: EditorComposed } | undefined>("frizz.ask"), "Ask")
      assert.equal(asked?.composed?.ok, true, JSON.stringify(asked))
      assert.deepEqual(await pageReceived("frizz:compose", before.page.received.length), [{
        type: "frizz:compose",
        id: asked!.composed!.id,
        item: { projectId: project.id, path: sample, text: sampleLines(editor.document, 2, 4), startLine: 2, endLine: 4, app: vscode.env.appName },
        target: "new",
        focus: true,
      }])
      assert.deepEqual((await fakeLog()).rpc.slice(before.rpc.length).map((call) => call.procedure), [], "no dispatch: the human writes the question in the sidebar")
    },
  },
  {
    name: "Send to Frizz thread… opens the picked thread in the sidebar with the selection in its reply box",
    modes: ["fake"],
    async run({ project }) {
      const editor = await openSample([2, 0, 2])
      const before = await fakeLog()
      const sent = await landsInSidebar(vscode.commands.executeCommand<{ slug: string; composed?: EditorComposed } | undefined>("frizz.sendToThread", { thread: "@fake-thread" }), "Send")
      assert.equal(sent?.composed?.ok, true, JSON.stringify(sent))
      assert.deepEqual(await pageReceived("frizz:compose", before.page.received.length), [{
        type: "frizz:compose",
        id: sent!.composed!.id,
        item: { projectId: project.id, path: sample, text: sampleLines(editor.document, 3, 3), startLine: 3, endLine: 3, app: vscode.env.appName },
        target: { thread: "fake-thread", project: project.slug },
        focus: true,
      }])
      assert.deepEqual((await fakeLog()).rpc.slice(before.rpc.length).map((call) => call.procedure), ["board"], "the picker's thread list, and no follow-up")
    },
  },
  {
    name: "a file the page links opens here at its position; a missing one is said, not opened",
    modes: ["fake"],
    async run({ api }) {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors")
      await pagePosts({ type: "frizz:open-file", path: sample, line: 6, column: 3 })
      await until("the sample in front", () => vscode.window.activeTextEditor?.document.uri.fsPath === sample)
      const editor = vscode.window.activeTextEditor!
      await until("the cursor at 6:3", () => editor.selection.isEmpty && editor.selection.active.line === 5 && editor.selection.active.character === 2)
      await pagePosts({ type: "frizz:open-file", path: join(workspace, "nope.ts"), line: 1 })
      await until("the missing file reported", () => api.sidebar().events.some((event) => event.type === "frizz:open-file" && event.outcome === "missing"))
      assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, sample, "nothing else opened")
    },
  },
  {
    name: "a chord the page forwards runs its VS Code command",
    modes: ["fake"],
    async run({ api }) {
      assert.equal(api.sidebar().visible, true)
      const mac = process.platform === "darwin"
      // Ctrl+Shift+E (⌘⇧E): the Explorer takes the side bar, so the Frizz view is no longer visible.
      await pagePosts({ type: "frizz:key", key: "E", code: "KeyE", ctrl: !mac, meta: mac, shift: true, alt: false })
      await until("the explorer shown", () => !api.sidebar().visible)
      assert.deepEqual(api.sidebar().events.at(-1), { type: "frizz:key", outcome: "workbench.view.explorer" })
      await vscode.commands.executeCommand("frizz.sidebar.focus")
      await until("the sidebar back", () => api.sidebar().visible)
    },
  },
  {
    name: "a message the sidebar does not know, a chord off its list, a link that is not a web page: nothing happens",
    modes: ["fake"],
    async run({ api }) {
      await openSample()
      const from = api.sidebar().events.length
      const mac = process.platform === "darwin"
      await pagePosts({ type: "frizz:bogus", path: sample })
      // Ctrl+W would close the editor were it run.
      await pagePosts({ type: "frizz:key", key: "w", code: "KeyW", ctrl: !mac, meta: mac, shift: false, alt: false })
      await pagePosts({ type: "frizz:open-external", url: "javascript:alert(1)" })
      await until("three messages handled", () => api.sidebar().events.length >= from + 3)
      assert.deepEqual(api.sidebar().events.slice(from), [
        { type: "frizz:bogus", outcome: "ignored" },
        { type: "frizz:key", outcome: "ignored" },
        { type: "frizz:open-external", outcome: "ignored" },
      ])
      assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, sample, "the editor is still open")
      assert.equal(api.sidebar().visible, true)
    },
  },
  {
    name: "a theme change reaches the page",
    modes: ["fake"],
    async run() {
      const workbench = vscode.workspace.getConfiguration("workbench")
      const from = (await fakeLog()).page.received.length
      const light = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light
      await workbench.update("colorTheme", light ? "Default Dark Modern" : "Default Light Modern", vscode.ConfigurationTarget.Global)
      try {
        const want = light ? "dark" : "light"
        await until(`frizz:theme ${want}`, async () => (await pageReceived("frizz:theme", from)).some((data) => data.theme === want))
      } finally {
        await workbench.update("colorTheme", undefined, vscode.ConfigurationTarget.Global)
      }
    },
  },
  // ── the editor in the sidebar ───────────────────────────────────────────────────────────────────────
  {
    name: "the page is told the editor's context: the file in front, its selection's lines and characters, the other open files most recent first, never the text",
    modes: ["fake"],
    async run({ api, project }) {
      const a = workspaceFile("a.ts")
      const b = workspaceFile("b.ts")
      await vscode.commands.executeCommand("workbench.action.closeAllEditors")
      // Not previews: each would take the last one's tab, and only one file would be open.
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(a), { preview: false })
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(b), { preview: false })
      const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(sample), { preview: false })
      // Lines 2-3 dragged whole: the caret ends at column 1 of line 4, which is not in the selection.
      editor.selection = new vscode.Selection(1, 0, 3, 0)
      const document = editor.document
      const chars = document.offsetAt(new vscode.Position(3, 0)) - document.offsetAt(new vscode.Position(1, 0))
      const file = (path: string, label: string) => ({ path, label, projectId: project.id })
      const want = { type: "frizz:editor-context", active: { ...file(sample, "src/sample.ts"), selection: { startLine: 2, endLine: 3, chars } }, open: [file(b, "src/b.ts"), file(a, "src/a.ts")] }
      await until("lines 2-3 of the sample in front, with b.ts and a.ts open", async () => isDeepStrictEqual((await contexts()).at(-1), want)).catch(async (error: unknown) => {
        assert.deepEqual((await contexts()).at(-1), want)
        throw error
      })
      assert.deepEqual(api.editorContext(), want)

      // Multi-cursor: the primary selection's lines, every selection's characters.
      editor.selections = [new vscode.Selection(4, 2, 4, 7), new vscode.Selection(0, 0, 0, 6)]
      await until("line 5, 11 characters", async () => isDeepStrictEqual((await contexts()).at(-1)?.active?.selection, { startLine: 5, endLine: 5, chars: 11 }))

      // a.ts in a second group too: still listed once, and first, being the most recent.
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(a), { viewColumn: vscode.ViewColumn.Two, preview: false })
      await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false })
      await until("a.ts once, most recent first", async () => {
        const last = (await contexts()).at(-1)
        return last?.active?.path === sample && isDeepStrictEqual(last.open.map((entry) => entry.path), [a, b])
      })

      // Nothing that is not a file on disk in front, and no diff: the bar names no file.
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content: "a scratch buffer\n" }), vscode.ViewColumn.One)
      await until("an untitled buffer is no file", async () => (await contexts()).at(-1)?.active === null)
      await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor")
      await vscode.window.showTextDocument(document, vscode.ViewColumn.One)
      await until("the sample back", async () => (await contexts()).at(-1)?.active?.path === sample)
      await vscode.commands.executeCommand("vscode.diff", vscode.Uri.file(a), vscode.Uri.file(b), "a.ts ↔ b.ts")
      await until("a diff is no file", async () => (await contexts()).at(-1)?.active === null)

      // Every message the page was told: paths and lines, never a line of the code.
      const told = JSON.stringify(await contexts())
      assert.ok(!told.includes("total") && !told.includes("export"), "no selected text reached the page")
      await vscode.commands.executeCommand("workbench.action.closeAllEditors")
    },
  },
  {
    name: "a drag is one message, not one per line, and a context that ends where it started is not sent again",
    modes: ["fake"],
    async run() {
      const editor = await openSample()
      editor.selection = new vscode.Selection(0, 0, 0, 0)
      await until("the sample with a caret", async () => {
        const last = (await contexts()).at(-1)
        return last?.active?.path === sample && !last.active.selection
      })
      const from = await received()
      for (let line = 1; line <= 6; line++) {
        editor.selection = new vscode.Selection(0, 0, line, 0)
        await sleep(15)
      }
      await sleep(500)
      const sent = await contexts(from)
      assert.ok(sent.length >= 1 && sent.length <= 2, `${sent.length} messages for a six-step drag`)
      assert.deepEqual(sent.at(-1)?.active?.selection?.endLine, 6)
      const settled = await received()
      editor.selection = new vscode.Selection(0, 0, 2, 0)
      editor.selection = new vscode.Selection(0, 0, 6, 0)
      await sleep(500)
      assert.deepEqual(await contexts(settled), [], "the same context as last time")
    },
  },
  {
    name: "the page's context bar adds the selection, or a whole file, to the composer it shows; nothing when it is gone",
    modes: ["fake"],
    async run({ api, project }) {
      const b = join(workspace, "src", "b.ts")
      const editor = await openSample([1, 0, 3])
      await until("the selection told", async () => (await contexts()).at(-1)?.active?.selection?.endLine === 4)
      const from = await received()
      await pagePosts({ type: "frizz:add-context", what: "selection" })
      await pagePosts({ type: "frizz:add-context", what: "file", path: b })
      await until("two composes", async () => (await pageReceived("frizz:compose", from)).length === 2)
      const [selection, file] = (await pageReceived("frizz:compose", from)).map(({ id: _, ...rest }) => rest)
      assert.deepEqual(selection, {
        type: "frizz:compose",
        item: { projectId: project.id, path: sample, text: sampleLines(editor.document, 2, 4), startLine: 2, endLine: 4, app: vscode.env.appName },
        target: "front",
        focus: true,
      })
      assert.deepEqual(file, { type: "frizz:compose", item: { projectId: project.id, path: b, app: vscode.env.appName }, target: "front", focus: true })

      editor.selection = new vscode.Selection(2, 1, 2, 1)
      const events = api.sidebar().events.length
      const before = await received()
      await pagePosts({ type: "frizz:add-context", what: "selection" })
      await pagePosts({ type: "frizz:add-context", what: "file", path: join(workspace, "src", "gone.ts") })
      await until("both answered", () => api.sidebar().events.length >= events + 2)
      assert.deepEqual(api.sidebar().events.slice(events).map((event) => event.outcome), ["nothing selected", "missing"])
      assert.deepEqual(await pageReceived("frizz:compose", before), [])
    },
  },
  {
    name: "Ctrl+I in the editor puts the selection in the sidebar's prompt with the caret; with no selection the chord is VS Code's own",
    modes: ["fake"],
    async run({ project }) {
      assert.deepEqual(manifest().contributes.keybindings, [{ command: "frizz.addToPrompt", key: "ctrl+i", mac: "cmd+i", when: "editorTextFocus && editorHasSelection" }])
      const chord = process.platform === "darwin" ? "meta+i" : "ctrl+i"
      const editor = await openSample([4, 0, 4])
      await sleep(500)
      const from = await received()
      await press(chord)
      await until("the chip in the page", async () => (await pageReceived("frizz:compose", from)).length === 1, 15_000)
      const [compose] = await pageReceived("frizz:compose", from)
      assert.deepEqual({ ...compose, id: undefined }, {
        type: "frizz:compose",
        id: undefined,
        item: { projectId: project.id, path: sample, text: sampleLines(editor.document, 5, 5), startLine: 5, endLine: 5, app: vscode.env.appName },
        target: "front",
        focus: true,
      })

      // A caret, no selection: the binding's `when` does not match, so nothing reaches Frizz.
      const caret = await openSample()
      caret.selection = new vscode.Selection(5, 2, 5, 2)
      // The selection crosses to the window's renderer, where `editorHasSelection` is kept, on its own
      // channel; the key must not overtake it.
      await sleep(500)
      const before = await received()
      await press(chord)
      await sleep(1_500)
      assert.deepEqual(await pageReceived("frizz:compose", before), [])
      await press("escape")
    },
  },
  {
    name: "a problem's quick fix asks Frizz to fix it: its lines in the prompt and the problem written after the chip",
    modes: ["fake"],
    async run({ project }) {
      const diagnostics = vscode.languages.createDiagnosticCollection("frizz-e2e")
      const frizz = vscode.workspace.getConfiguration("frizz")
      try {
        const editor = await openSample()
        const uri = editor.document.uri
        const problem = new vscode.Diagnostic(new vscode.Range(3, 4, 3, 9), "Cannot find name 'total'.", vscode.DiagnosticSeverity.Error)
        problem.source = "ts"
        problem.code = 2304
        diagnostics.set(uri, [problem])
        const fixes = async () => {
          const actions = (await vscode.commands.executeCommand<vscode.CodeAction[]>("vscode.executeCodeActionProvider", uri, new vscode.Range(3, 6, 3, 6))) ?? []
          return actions.filter((action) => action.title.startsWith("Ask Frizz to fix"))
        }
        let offered: vscode.CodeAction[] = []
        await until("the fix offered", async () => (offered = await fixes()).length === 1)
        assert.equal(offered[0]!.title, "Ask Frizz to fix")
        assert.equal(offered[0]!.kind?.value, vscode.CodeActionKind.QuickFix.value)
        const from = await received()
        const command = offered[0]!.command!
        await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []))
        const [compose] = await pageReceived("frizz:compose", from)
        assert.deepEqual({ ...compose, id: undefined }, {
          type: "frizz:compose",
          id: undefined,
          item: { projectId: project.id, path: sample, text: sampleLines(editor.document, 4, 4), startLine: 4, endLine: 4, app: vscode.env.appName },
          target: "front",
          focus: true,
          note: "Fix: Cannot find name 'total'. ts(2304)",
        })

        // Two problems under the caret: one fix each, told apart by their messages.
        const lint = new vscode.Diagnostic(new vscode.Range(3, 2, 3, 12), "Assignment to a loop's sum.", vscode.DiagnosticSeverity.Warning)
        lint.source = "eslint"
        lint.code = { value: "no-sum", target: vscode.Uri.parse("https://eslint.org/docs/rules/no-sum") }
        diagnostics.set(uri, [problem, lint])
        await until("two fixes", async () => (offered = await fixes()).length === 2)
        assert.deepEqual(offered.map((action) => action.title).sort(), ["Ask Frizz to fix: Assignment to a loop's sum.", "Ask Frizz to fix: Cannot find name 'total'."])

        // The sidebar off: nowhere for the problem's words to go, so nothing is offered.
        await frizz.update("useSidebar", false, vscode.ConfigurationTarget.Global)
        assert.deepEqual(await fixes(), [])
      } finally {
        diagnostics.dispose()
        await frizz.update("useSidebar", undefined, vscode.ConfigurationTarget.Global)
      }
    },
  },
  {
    name: "a tab's menu and the explorer add whole files — every file selected, never a folder",
    modes: ["fake"],
    async run({ project }) {
      const menus = manifest().contributes.menus
      assert.deepEqual(menus["editor/title/context"], [{ command: "frizz.addFileToPrompt", when: "resourceScheme == file", group: "frizz@1" }])
      assert.ok(menus["explorer/context"]!.some((entry) => entry.command === "frizz.addFileToPrompt" && entry.when === "!explorerResourceIsFolder"))
      const a = join(workspace, "src", "a.ts")
      const b = join(workspace, "src", "b.ts")
      const item = (path: string) => ({ type: "frizz:compose", item: { projectId: project.id, path, app: vscode.env.appName }, target: "front", focus: true })
      const composes = async (from: number) => (await pageReceived("frizz:compose", from)).map(({ id: _, ...rest }) => rest)

      // A tab's menu hands the command the tab's file and the group it is in.
      let from = await received()
      await vscode.commands.executeCommand("frizz.addFileToPrompt", vscode.Uri.file(a), { groupId: 0 })
      assert.deepEqual(await composes(from), [item(a)])

      // The explorer hands it the file right-clicked and everything selected, a folder among them.
      from = await received()
      await vscode.commands.executeCommand("frizz.addFileToPrompt", vscode.Uri.file(b), [vscode.Uri.file(a), vscode.Uri.file(b), vscode.Uri.file(join(workspace, "src"))])
      assert.deepEqual(await composes(from), [item(a), item(b)])
    },
  },
  {
    name: "the terminal's menu adds its selection as @terminal, and the clipboard is the human's again after",
    modes: ["fake"],
    async run({ project }) {
      assert.deepEqual(manifest().contributes.menus["terminal/context"], [{ command: "frizz.addTerminalSelection", when: "terminalTextSelected && config.frizz.useSidebar", group: "frizz@1" }])
      const clipboard = "the human's own clipboard"
      await vscode.env.clipboard.writeText(clipboard)
      const terminal = vscode.window.createTerminal({ name: "frizz e2e", shellPath: "/bin/sh" })
      try {
        terminal.show()
        terminal.sendText("echo frizz-from-the-terminal")
        await sleep(1_500)
        await vscode.commands.executeCommand("workbench.action.terminal.selectAll")
        const from = await received()
        const composed = await vscode.commands.executeCommand<EditorComposed | undefined>("frizz.addTerminalSelection")
        assert.equal(composed?.ok, true, JSON.stringify(composed))
        const [compose] = await pageReceived("frizz:compose", from)
        const item = compose!.item as { path: string; text: string; projectId?: string }
        assert.equal(item.path, "terminal")
        assert.equal(item.projectId, project.id)
        assert.match(item.text, /frizz-from-the-terminal/u)
        assert.deepEqual({ target: compose!.target, focus: compose!.focus }, { target: "front", focus: true })
        assert.equal(await vscode.env.clipboard.readText(), clipboard, "the clipboard is as the human left it")

        // Nothing selected: nothing added, and the clipboard still kept.
        await vscode.commands.executeCommand("workbench.action.terminal.clearSelection")
        const before = await received()
        assert.equal(await vscode.commands.executeCommand("frizz.addTerminalSelection"), undefined)
        assert.deepEqual(await pageReceived("frizz:compose", before), [])
        assert.equal(await vscode.env.clipboard.readText(), clipboard)
      } finally {
        terminal.dispose()
      }
    },
  },
  {
    name: "where the page is becomes VS Code's title row: the thread's title or the scope, the counts, and the buttons for that view",
    modes: ["fake"],
    async run({ api }) {
      await vscode.commands.executeCommand("frizz.sidebar.focus")
      await pagePosts({ type: "frizz:route", view: "thread", title: "Fake thread", description: "Waiting on you" })
      await until("the thread in the title row", () => api.sidebar().title === "Fake thread" && api.sidebar().description === "Waiting on you" && api.sidebar().view === "thread")
      let row = await titleRow()
      await until("the thread's buttons", async () => (row = await titleRow()).buttons.includes("Back to queue"))
      assert.match(row.heading, /Fake thread/u)
      assert.deepEqual(row.buttons.filter((label) => !/More Actions/u.test(label)), ["Back to queue", "Jump to a thread", "Settings"])

      await pagePosts({ type: "frizz:route", view: "queue", title: "", description: "2 ready" })
      await until("the queue in the title row", () => api.sidebar().view === "queue" && api.sidebar().title === undefined && api.sidebar().description === "2 ready")
      await until("the queue's buttons", async () => (row = await titleRow()).buttons.includes("New thread"))
      assert.deepEqual(row.buttons.filter((label) => !/More Actions/u.test(label)), ["New thread", "Jump to a thread", "Settings"])
      assert.doesNotMatch(row.heading, /Fake thread/u)
    },
  },
  {
    name: "each title-row command opens its door in the page, bringing the sidebar back first when it was hidden",
    modes: ["fake"],
    async run({ api }) {
      await vscode.commands.executeCommand("workbench.view.explorer")
      await until("the sidebar hidden", () => !api.sidebar().visible)
      let from = await received()
      assert.equal(await vscode.commands.executeCommand("frizz.sidebar.jump"), true)
      assert.equal(api.sidebar().visible, true)
      for (const command of ["frizz.sidebar.newThread", "frizz.sidebar.queue", "frizz.sidebar.settings"]) assert.equal(await vscode.commands.executeCommand(command), true, command)
      await until("four doors", async () => (await pageReceived("frizz:command", from)).length === 4)
      assert.deepEqual((await pageReceived("frizz:command", from)).map((data) => data.command), ["jump", "new-thread", "queue", "settings"])

      // The button itself, clicked with a mouse: the queue's row has New thread.
      await pagePosts({ type: "frizz:route", view: "queue", title: "", description: "2 ready" })
      await until("the New thread button", async () => (await titleRow()).buttons.includes("New thread"))
      from = await received()
      assert.equal(await click('.part.sidebar .title-actions .action-label[aria-label="New thread"]'), true, "the New thread button is in the title row")
      await until("the click's door", async () => isDeepStrictEqual((await pageReceived("frizz:command", from)).map((data) => data.command), ["new-thread"]))
    },
  },
  {
    name: "a page that loads again starts with no title-row view and is told the editor's context at once",
    modes: ["fake"],
    async run({ api }) {
      await openSample([2, 0, 2])
      await until("line 3 told", async () => (await contexts()).at(-1)?.active?.selection?.startLine === 3)
      const loads = (await fakeLog()).page.loads.length
      const from = await received()
      await vscode.commands.executeCommand("frizz.sidebar.reload")
      await until("the new page ready", async () => (await fakeLog()).page.loads.length === loads + 1 && api.sidebar().ready, 30_000)
      assert.equal(api.sidebar().view, "", "no page has said where it is yet")
      assert.equal(api.sidebar().title, undefined)
      await until("the context told to the new page", async () => (await contexts(from)).some((message) => message.active?.selection?.startLine === 3))
    },
  },
  {
    name: "a page that doesn't answer leaves Add to Frizz prompt to Frizz, and so does turning the setting off",
    modes: ["fake"],
    async run() {
      await openSample([1, 0, 1])
      const composes = async () => (await fakeLog()).frames.filter((frame) => frame.t === "compose").length
      await fake("/__e2e/page-answer", { answer: "silent" })
      try {
        const before = await composes()
        const composed = await vscode.commands.executeCommand<EditorComposed | undefined>("frizz.addToPrompt")
        assert.equal(composed?.ok, true, JSON.stringify(composed))
        assert.equal(await composes(), before + 1, "after the page's silence, Frizz holds it for a page to claim")
      } finally {
        await fake("/__e2e/page-answer", { answer: "ok" })
      }

      const frizz = vscode.workspace.getConfiguration("frizz")
      await frizz.update("useSidebar", false, vscode.ConfigurationTarget.Global)
      try {
        const before = await composes()
        const pageBefore = (await fakeLog()).page.received.length
        const composed = await vscode.commands.executeCommand<EditorComposed | undefined>("frizz.addToPrompt")
        assert.equal(composed?.ok, true)
        assert.equal(await composes(), before + 1)
        assert.deepEqual(await pageReceived("frizz:compose", pageBefore), [], "the open sidebar was left alone")
      } finally {
        await frizz.update("useSidebar", undefined, vscode.ConfigurationTarget.Global)
      }
    },
  },
  {
    name: "Frizz on a new port re-frames the sidebar there; a page that never loads offers Reload; no Frizz at all says so",
    modes: ["fake"],
    async run({ api, project }) {
      const frizz = vscode.workspace.getConfiguration("frizz")
      try {
        await frizz.update("serverUrl", elsewhere, vscode.ConfigurationTarget.Global)
        await until("the frame on the new port, ready", () => api.sidebar().url === `${elsewhere}/${embedQuery(project)}` && api.sidebar().ready, 30_000)
        assert.deepEqual((await fakeLog(elsewhere)).page.loads, [`/${embedQuery(project)}`])
        assert.equal(api.sidebar().hinted, false)

        // The setting is taken at its word, so the frame goes to port 1, where nothing listens; its
        // page never says it is ready, and the view offers Reload and Open in browser over it.
        await frizz.update("serverUrl", "http://127.0.0.1:1", vscode.ConfigurationTarget.Global)
        await until("the frame on port 1", () => api.sidebar().url === `http://127.0.0.1:1/${embedQuery(project)}`)
        assert.equal(api.sidebar().ready, false)
        await until("the hint", () => api.sidebar().hinted, 15_000)

        // No address at all: discovery finds nothing. The page that was showing stays until Reload, which
        // then says why there is nothing to show.
        await frizz.update("serverUrl", "not an address", vscode.ConfigurationTarget.Global)
        await until("offline", () => api.status().kind === "offline")
        await new Promise((resolve) => setTimeout(resolve, 500))
        assert.equal(api.sidebar().url, `http://127.0.0.1:1/${embedQuery(project)}`)
        await vscode.commands.executeCommand("frizz.sidebar.reload")
        // Reload looks again first ("Looking for Frizz…"), then says what it found.
        await until("a message instead of the page", () => api.sidebar().url === undefined && api.sidebar().message === "Frizz isn't running.")
      } finally {
        await frizz.update("serverUrl", control, vscode.ConfigurationTarget.Global)
      }
      await until("the frame back on the first Frizz, ready", () => api.sidebar().url === `${control}/${embedQuery(project)}` && api.sidebar().ready, 30_000)
      assert.equal(api.sidebar().hinted, false)
    },
  },
]

class Skipped extends Error {}
function skip(why: string): never {
  throw new Skipped(why)
}

export async function run(): Promise<void> {
  console.log(`frizz e2e: ${mode} mode, workspace ${workspace}, ${vscode.env.appName} ${vscode.version}`)
  const extension = vscode.extensions.getExtension<FrizzExtensionApi>("ssalbdivad.frizz-vscode")
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
