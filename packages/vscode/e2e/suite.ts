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

/** Have the fake page post `message` to the sidebar, as the real page would. */
const pagePosts = (message: unknown) => fake("/__e2e/page-post", { message })

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

  // ── the sidebar ────────────────────────────────────────────────────────────────────────────────────
  // Every step above ran with the sidebar never opened, so Add to Frizz prompt took the server path; Ask
  // and Send passed their text, which is sent directly whatever the sidebar does.
  {
    name: "the sidebar frames Frizz's page with the embed params, and the page says it is ready",
    modes: ["fake"],
    async run({ api, project }) {
      assert.equal(api.sidebar().opened, false, "nothing has opened it yet")
      await vscode.commands.executeCommand("frizz.sidebar.focus")
      await until("the page ready", () => api.sidebar().ready, 30_000)
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
    name: "Add to Frizz prompt puts the selection into the prompt box the sidebar shows, not through Frizz",
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
        focus: false,
      }])
      assert.equal((await fakeLog()).frames.filter((frame) => frame.t === "compose").length, before.frames.filter((frame) => frame.t === "compose").length, "nothing went to Frizz to hold")
      assert.equal(api.sidebar().visible, true)
      assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, sample)
    },
  },
  {
    name: "Ask Frizz… opens the sidebar's new-thread box with the selection, and starts nothing itself",
    modes: ["fake"],
    async run({ project }) {
      const editor = await openSample([1, 0, 3])
      const before = await fakeLog()
      const asked = await vscode.commands.executeCommand<{ composed?: EditorComposed } | undefined>("frizz.ask")
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
      const sent = await vscode.commands.executeCommand<{ slug: string; composed?: EditorComposed } | undefined>("frizz.sendToThread", { thread: "@fake-thread" })
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
    name: "Frizz on a new port re-frames the sidebar there; with no Frizz at all, Reload says so",
    modes: ["fake"],
    async run({ api, project }) {
      const frizz = vscode.workspace.getConfiguration("frizz")
      try {
        await frizz.update("serverUrl", elsewhere, vscode.ConfigurationTarget.Global)
        await until("the frame on the new port, ready", () => api.sidebar().url === `${elsewhere}/${embedQuery(project)}` && api.sidebar().ready, 30_000)
        assert.deepEqual((await fakeLog(elsewhere)).page.loads, [`/${embedQuery(project)}`])

        // Nothing listens on port 1. The page that was showing stays — it says it is offline itself —
        // until the human reloads it.
        await frizz.update("serverUrl", "http://127.0.0.1:1", vscode.ConfigurationTarget.Global)
        await until("offline", () => api.status().kind === "offline")
        await new Promise((resolve) => setTimeout(resolve, 500))
        assert.equal(api.sidebar().url, `${elsewhere}/${embedQuery(project)}`)
        await vscode.commands.executeCommand("frizz.sidebar.reload")
        await until("a message instead of the page", () => api.sidebar().message !== undefined && api.sidebar().url === undefined)
        assert.equal(api.sidebar().ready, false)
      } finally {
        await frizz.update("serverUrl", control, vscode.ConfigurationTarget.Global)
      }
      await until("the frame back on the first Frizz, ready", () => api.sidebar().url === `${control}/${embedQuery(project)}` && api.sidebar().ready, 30_000)
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
