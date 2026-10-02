// THE EXTENSION, wired to an editor window. `extension.ts` hands in the `vscode` module, so this file
// holds only `import type` from it — the logic it leans on (discovery, the socket, project matching,
// the message format, thread order) lives in vscode-free modules the unit tests run under plain node,
// and this is the glue the end-to-end harness (scripts/e2e.ts) drives inside a real VS Code.
//
// Copy follows the repo's rules: sentence case, what the human can do, never the machinery.

import { randomUUID } from "node:crypto"
import { stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname } from "node:path"
import type * as vscode from "vscode"
import type { EditorComposeInput, EditorComposed, EditorOpen, EditorProject } from "@frizz/shared/editor-protocol"
import { EMBED_TERMINAL_PATH, type EmbedAddContextMessage, type EmbedCommandMessage, type EmbedComposeMessage, type EmbedEditorContextMessage } from "@frizz/shared/embed-protocol"
import { EditorConnection, FocusRecency, type ConnectionStatus, type OpenResult } from "./connection.ts"
import { activeFileEditor, registerContextFeed } from "./context-feed.ts"
import { discoverFrizz, pageAddressNote, SOURCE_WORDS, type FoundFrizz } from "./discovery.ts"
import { fixNote, fixTitle, lineSpan, terminalText, type Problem } from "./editor-context.ts"
import { addRoute, composeInSidebar as composeVia, promptRoute } from "./embed.ts"
import { composeInput, composeMessage, normalizeNewlines, refLabel, type FileRef, type Selected } from "./message.ts"
import { projectForPath, workspaceProjects } from "./projects.ts"
import { describeRpcError, dispatchProfile, FrizzRpc, withRetry } from "./rpc.ts"
import { registerSidebar, type SidebarSnapshot } from "./sidebar.ts"
import { notConnectedMessage, statusView } from "./status.ts"
import { findThread, pickerThreads, threadHandleOf, threadItem, displayTitle, type PickerThread } from "./threads.ts"

type Vscode = typeof vscode

/** What `activate` returns — read by the end-to-end suite, since a status bar item's text cannot be queried. */
export interface FrizzExtensionApi {
  windowId: string
  status(): ConnectionStatus
  statusBar(): { text: string; tooltip: string; command: string }
  origin(): string | undefined
  /** Where the last discovery found Frizz, and how — set even when the editor connection was refused. */
  discovered(): FoundFrizz | undefined
  projects(): EditorProject[]
  /** What the Frizz sidebar shows and what its page asked of it. */
  sidebar(): SidebarSnapshot
  /** The editor's context as the sidebar's page was last told it. */
  editorContext(): EmbedEditorContextMessage | undefined
}

/** A file the command is about, with what was selected in it. */
interface Target {
  path: string
  uri: vscode.Uri
  selection?: Selected
  cursorLine?: number
}

/** Command arguments a keybinding, another extension or a test can pass to skip the prompts. */
interface CommandOptions {
  question?: string
  thread?: string
  message?: string
}

const FLASH_MS = 1_500

/** What Ask gives for a selection it cannot place; Send to thread says the same rather than dropping it. */
const OPEN_A_FILE = "Open a file to ask Frizz about it."

/**
 * How long Ask and Send to thread wait for the sidebar's page to be ready — a cold open of the view boots
 * the whole app — before falling back to the input box; and how long any command waits for the page to
 * answer a compose before handing the selection to the server instead.
 */
const SIDEBAR_READY_MS = 15_000
const SIDEBAR_COMPOSE_MS = 5_000

/** The quick fix's command: it carries the problem it was offered for, so it is never in the palette. */
const FIX_COMMAND = "frizz.askToFix"
/** Quick fixes offered per request, at most: one per problem under the caret, and a line of them is noise. */
const MAX_FIXES = 5

export function activateFrizz(api: Vscode, context: vscode.ExtensionContext): FrizzExtensionApi {
  const log = api.window.createOutputChannel("Frizz", { log: true })
  context.subscriptions.push(log)
  const windowId = randomUUID()
  const extensionVersion = String((context.extension.packageJSON as { version?: unknown }).version ?? "")
  let projects: EditorProject[] = []
  let status: ConnectionStatus = { kind: "connecting" }

  const config = () => api.workspace.getConfiguration("frizz")
  const folders = () => (api.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === "file").map((folder) => folder.uri.fsPath)
  const windowState = () => ({ folders: folders(), focused: api.window.state.focused, acceptsOpens: config().get<boolean>("openFileLinks", true) })
  const focus = new FocusRecency()
  focus.observe(api.window.state.focused)

  // ── the sidebar ──────────────────────────────────────────────────────────────────────────────────
  // Its host reads the connection, the discovery and the openers below only when the view asks, which
  // is never before activation returns.
  const sidebar = registerSidebar(api, context, {
    // Like the browser page, the sidebar needs no editor connection: a Frizz discovery found serves its page.
    origin: () => connection.origin ?? found?.origin,
    projectSlug: () => workspaceProjects(folders(), projects)[0]?.slug,
    notFound: () => (status.kind === "offline" || status.kind === "incompatible" ? status.reason : undefined),
    openFile: (message) => openFromFrizz(message),
    openInBrowser: () => openFrizz(),
    reconnect: () => connection.reconnect(),
    addContext: (message) => addContextFromPage(message),
    log: { info: (line) => log.info(line), warn: (line) => log.warn(line) },
  })
  const useSidebar = () => config().get<boolean>("useSidebar", true)
  const feed = registerContextFeed(api, context, {
    ready: () => sidebar.ready(),
    onReady: (listener) => sidebar.onReady(listener),
    post: (message) => sidebar.post(message),
    projects: () => projects,
  })

  // ── status bar ───────────────────────────────────────────────────────────────────────────────────
  const item = api.window.createStatusBarItem("frizz.status", api.StatusBarAlignment.Right, 100)
  item.name = "Frizz"
  context.subscriptions.push(item)
  let shown = statusView(status, [])
  const renderStatus = () => {
    shown = statusView(status, workspaceProjects(folders(), projects))
    item.text = shown.text
    item.tooltip = shown.tooltip
    item.command = shown.command
    item.show()
    sidebar.setBadge(shown.ready)
  }
  renderStatus()

  // ── the socket ───────────────────────────────────────────────────────────────────────────────────
  const highlight = api.window.createTextEditorDecorationType({
    backgroundColor: new api.ThemeColor("editor.rangeHighlightBackground"),
    isWholeLine: true,
  })
  context.subscriptions.push(highlight)

  // Raising the window is best-effort. `workbench.action.focusWindow` arrived in VS Code 1.128, so the
  // VS Codes the manifest's ^1.90 admits before it — and Cursor and Windsurf, which build on older
  // bases (Cursor 3.11 is 1.125) — have no such command. After an OPEN the file has already opened by
  // the time the window is raised, so the answer is still ok: refusing would toast an error over a file
  // that opened. A FOCUS request is nothing but the raise, though, so it answers that it could not, and
  // Frizz falls back to the editor's own command line, which raises the window holding the folder.
  let raiseMissing = false
  const focusWindow = async (): Promise<boolean> => {
    try {
      await api.commands.executeCommand("workbench.action.focusWindow")
      return true
    } catch (error) {
      if (!raiseMissing) log.info(`${api.env.appName} ${api.version} can't bring its own window to the front (${(error as Error).message}); Frizz's file links still open here.`)
      raiseMissing = true
      return false
    }
  }

  let lastNotes: string | undefined
  /** The last discovery's answer: the origin a page opens on even when the editor connection was refused. */
  let found: FoundFrizz | undefined
  const connection = new EditorConnection({
    async discover() {
      const result = await discoverFrizz({ serverUrl: config().get<string>("serverUrl", "") })
      // Where it looked, in full the first time and whenever the answer changes; the same misses on
      // every retry are only for the debug level.
      const notes = result.notes.join("\n")
      for (const note of result.notes) (notes === lastNotes ? log.debug : log.info).call(log, `Looked for Frizz: ${note}`)
      lastNotes = notes
      found = result.found
      return result.found ? { origin: result.found.origin, detail: `found through ${SOURCE_WORDS[result.found.source]}` } : undefined
    },
    hello() {
      const state = windowState()
      const ago = focus.agoMs(state.focused)
      return { windowId, app: api.env.appName, extensionVersion, ...state, ...(ago === undefined ? {} : { focusedAgoMs: ago }), home: homedir(), platform: process.platform }
    },
    state: windowState,
    open: (message) => openFromFrizz(message),
    async focus() {
      return (await focusWindow()) ? { ok: true } : { ok: false, error: `${api.env.appName} can't bring its window to the front.` }
    },
    projects(next) {
      projects = next
      renderStatus()
      sidebar.refresh()
      feed.refresh()
    },
    status(next) {
      status = next
      renderStatus()
      sidebar.refresh()
    },
    log: { info: (line) => log.info(line), warn: (line) => log.warn(line), error: (line) => log.error(line) },
  })
  context.subscriptions.push({ dispose: () => connection.stop() })


  async function openFromFrizz(message: EditorOpen): Promise<OpenResult> {
    let entry
    try {
      entry = await stat(message.path)
    } catch {
      return { ok: false, error: `${message.path} doesn't exist.` }
    }
    const uri = api.Uri.file(message.path)
    if (entry.isDirectory()) {
      // In the explorer when the window has it; a folder outside every one of its folders (a thread's
      // worktree elsewhere, another project) has nothing to reveal it in, and revealing it did nothing
      // visible — so it opens in a window of its own, as `code <folder>` would.
      if (api.workspace.getWorkspaceFolder(uri)) {
        await api.commands.executeCommand("revealInExplorer", uri)
        await focusWindow()
      } else await api.commands.executeCommand("vscode.openFolder", uri, { forceNewWindow: true })
      return { ok: true }
    }
    await api.commands.executeCommand("vscode.open", uri)
    const editor = [api.window.activeTextEditor, ...api.window.visibleTextEditors].find((candidate) => candidate?.document.uri.fsPath === uri.fsPath)
    if (editor && message.line) {
      const document = editor.document
      const last = document.lineCount - 1
      const startLine = Math.min(message.line - 1, last)
      let selection: vscode.Selection
      if (message.endLine && message.endLine > message.line) {
        // A range selects its whole lines, as GitHub's #L12-L20 highlights them.
        const endLine = Math.min(message.endLine - 1, last)
        selection = new api.Selection(startLine, 0, endLine, document.lineAt(endLine).range.end.character)
      } else {
        const at = document.validatePosition(new api.Position(startLine, Math.max(0, (message.column ?? 1) - 1)))
        selection = new api.Selection(at, at)
      }
      editor.selection = selection
      editor.revealRange(selection, api.TextEditorRevealType.InCenterIfOutsideViewport)
      // A beat of highlight on the lines, so the eye lands where the link pointed.
      editor.setDecorations(highlight, [new api.Range(selection.start.line, 0, selection.end.line, 0)])
      setTimeout(() => editor.setDecorations(highlight, []), FLASH_MS)
    }
    await focusWindow()
    return { ok: true }
  }

  // ── the window's own changes ─────────────────────────────────────────────────────────────────────
  context.subscriptions.push(
    api.window.onDidChangeWindowState((state) => {
      focus.observe(state.focused)
      connection.sendState()
    }),
    api.workspace.onDidChangeWorkspaceFolders(() => {
      connection.sendState()
      renderStatus()
      sidebar.refresh()
    }),
    api.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("frizz.serverUrl")) connection.reconnect()
      else if (event.affectsConfiguration("frizz.openFileLinks")) connection.sendState()
    }),
  )

  // ── helpers the commands share ───────────────────────────────────────────────────────────────────

  /** Say why the connection is down — its own reason, not a guess — with a way to try again. */
  function showNotConnected(): void {
    void api.window.showErrorMessage(notConnectedMessage(status), "Try again", "Show log").then((choice) => {
      if (choice === "Try again") connection.reconnect()
      else if (choice === "Show log") log.show()
    })
  }

  /** The connected origin, or undefined after telling the human why there is none. */
  function requireOrigin(): string | undefined {
    const origin = connection.origin
    if (origin) return origin
    showNotConnected()
    return undefined
  }

  function openUrl(url: string): void {
    // Which kind of address this page lands on: almost always the public one, but not when discovery
    // fell through to the server's lock file (discovery.ts, step 5).
    const source = found && url.startsWith(`${found.origin}/`) ? found.source : undefined
    if (source) {
      const { level, note } = pageAddressNote(source)
      log[level](`Opening ${url} on ${note}.`)
    }
    void api.env.openExternal(api.Uri.parse(url))
  }

  function projectUrl(origin: string, project: EditorProject | undefined): string {
    return project ? `${origin}/?project=${encodeURIComponent(project.slug)}` : `${origin}/`
  }

  /** Split a command's arguments: a resource (explorer, editor menu) and/or an options object. */
  function splitArgs(args: unknown[]): { uri?: vscode.Uri; options: CommandOptions } {
    let uri: vscode.Uri | undefined
    let options: CommandOptions = {}
    for (const arg of args) {
      if (arg instanceof api.Uri) uri ??= arg
      else if (arg && typeof arg === "object" && !Array.isArray(arg)) options = { ...options, ...(arg as CommandOptions) }
    }
    return { uri, options }
  }

  /**
   * Text selected where no command can place it: an editor that is not a file on disk — an untitled
   * buffer, the git side of a diff. A command that would otherwise carry the selection must refuse
   * rather than send without it.
   */
  function unplaceableSelection(uri: vscode.Uri | undefined): boolean {
    const editor = api.window.activeTextEditor
    if (!editor || (uri && editor.document.uri.toString() !== uri.toString())) return false
    return editor.document.uri.scheme !== "file" && !editor.selection.isEmpty
  }

  /** The file a command is about: the resource it was invoked on, else the active editor's. */
  function targetOf(uri: vscode.Uri | undefined): Target | undefined {
    const editor = api.window.activeTextEditor
    const fromEditor = editor && (!uri || editor.document.uri.toString() === uri.toString()) ? editor : undefined
    if (fromEditor) {
      const document = fromEditor.document
      if (document.uri.scheme !== "file") return undefined
      const selection = fromEditor.selection
      if (selection.isEmpty) return { path: document.uri.fsPath, uri: document.uri, cursorLine: selection.active.line + 1 }
      // A selection that ends at column 0 of a line (a whole-line drag, shift+down) does not include it —
      // the same count the sidebar's context bar shows for it (editor-context.ts).
      const { startLine, endLine } = lineSpan(selection.start, selection.end)
      return { path: document.uri.fsPath, uri: document.uri, selection: { text: normalizeNewlines(document.getText(selection)), startLine, endLine } }
    }
    if (uri && uri.scheme === "file") return { path: uri.fsPath, uri }
    return undefined
  }

  /**
   * The project a file belongs to and how to show its path. A file no project's folder holds offers
   * Home instead (labelled for the command at hand), or opening Frizz's add-folder dialog on it.
   */
  async function place(target: Target, origin: string, homeLabel: string): Promise<{ project: EditorProject; ref: FileRef } | undefined> {
    const match = projectForPath(target.path, projects)
    const ref = (path: string, display: string): FileRef => ({ path, display, selection: target.selection, cursorLine: target.cursorLine })
    if (match) return { project: match.project, ref: ref(match.path, match.relative || match.path) }
    const home = projects.find((project) => project.home)
    const add = "Add folder to Frizz"
    const choice = await api.window.showWarningMessage(`${basename(target.path)} isn't in a Frizz project.`, ...(home ? [homeLabel] : []), add)
    if (choice === homeLabel && home) return { project: home, ref: ref(target.path, target.path) }
    if (choice === add) {
      const folder = api.workspace.getWorkspaceFolder(target.uri)?.uri.fsPath ?? dirname(target.path)
      openUrl(`${origin}/?add=${encodeURIComponent(folder)}`)
    }
    return undefined
  }

  /** The project this window is about when no file says: the active file's, else the workspace's first. */
  function windowProject(): EditorProject | undefined {
    const active = api.window.activeTextEditor?.document.uri
    const fromFile = active?.scheme === "file" ? projectForPath(active.fsPath, projects)?.project : undefined
    return fromFile ?? workspaceProjects(folders(), projects)[0]
  }

  const threadUrl = (origin: string, project: EditorProject, slug: string) =>
    `${origin}/all/${encodeURIComponent(project.slug)}/thread/${encodeURIComponent(slug)}`

  /** Why the last compose into the sidebar did not land, for a command with nowhere else to send it. */
  let sidebarWhy = ""

  /** A selection into the sidebar's page (embed.ts composeInSidebar), as the server path's answer; undefined to fall back. */
  async function composeInSidebar(input: Omit<EmbedComposeMessage, "type" | "id">, preserveFocus: boolean): Promise<EditorComposed | undefined> {
    const result = await composeVia(sidebar, input, { preserveFocus, readyMs: SIDEBAR_READY_MS, composeMs: SIDEBAR_COMPOSE_MS })
    if (result.ok) return { t: "composed", id: result.id, ok: true }
    log.warn(result.why)
    sidebarWhy = result.why
    return undefined
  }

  // ── commands ─────────────────────────────────────────────────────────────────────────────────────

  async function ask(...args: unknown[]): Promise<{ slug: string } | { composed: EditorComposed } | undefined> {
    const origin = requireOrigin()
    if (!origin) return undefined
    const { uri, options } = splitArgs(args)
    const target = targetOf(uri)
    if (!target) {
      void api.window.showInformationMessage(OPEN_A_FILE)
      return undefined
    }
    const placed = await place(target, origin, "Ask in Home")
    if (!placed) return undefined
    const { project, ref } = placed
    if (promptRoute(useSidebar(), options.question) === "sidebar") {
      // The sidebar's new-thread box, with the chip and the caret: the question is written there.
      const item = { ...composeInput({ ...ref, projectId: project.id }), app: api.env.appName }
      const composed = await composeInSidebar({ item, target: "new", focus: true }, false)
      if (composed) return { composed }
      log.info("Asking in an input box instead.")
    }
    const question = typeof options.question === "string"
      ? options.question
      : await api.window.showInputBox({
          title: "Ask Frizz",
          prompt: `Ask Frizz about ${refLabel(ref)}`,
          placeHolder: "What do you want to know or change?",
          ignoreFocusOut: true,
          validateInput: (value) => (value.trim() ? undefined : "Type a question for Frizz."),
        })
    if (question === undefined || !question.trim()) return undefined
    const rpc = new FrizzRpc(origin)
    try {
      const result = await api.window.withProgress({ location: api.ProgressLocation.Notification, title: "Asking Frizz…" }, async () => {
        // The operator's saved backend, model and effort, as the page's prompt box sends them: a
        // dispatch with no backend means Claude whatever the preference says.
        const preferences = await rpc.query(project.id, "dispatchPreferencesGet")
        // No retry: a dispatch that timed out may still have started its thread.
        return rpc.mutation(project.id, "dispatch", { prompt: composeMessage(question, ref), ...dispatchProfile(preferences) }, 60_000)
      })
      log.info(`Asked Frizz in ${project.name}: thread ${result.slug}.`)
      void api.window.showInformationMessage("Asked Frizz.", "Open thread").then((choice) => {
        if (choice) openUrl(threadUrl(origin, project, result.slug))
      })
      return { slug: result.slug }
    } catch (error) {
      log.error(`Asking Frizz failed: ${(error as Error).message}`)
      void api.window.showErrorMessage(describeRpcError(error, "ask"))
      return undefined
    }
  }

  async function sendToThread(...args: unknown[]): Promise<{ slug: string; deliveryId?: string; composed?: EditorComposed } | undefined> {
    const origin = requireOrigin()
    if (!origin) return undefined
    const { uri, options } = splitArgs(args)
    const target = targetOf(uri)
    if (!target && unplaceableSelection(uri)) {
      void api.window.showInformationMessage(OPEN_A_FILE)
      return undefined
    }
    let project: EditorProject | undefined
    let ref: FileRef | undefined
    if (target) {
      const placed = await place(target, origin, "Use Home")
      if (!placed) return undefined
      ;({ project, ref } = placed)
    } else {
      project = windowProject()
    }
    if (!project) {
      void api.window.showInformationMessage("Open a file in a Frizz project to send it to a thread.")
      return undefined
    }
    const rpc = new FrizzRpc(origin)
    let threads: (PickerThread & { sessionId: string })[]
    try {
      threads = pickerThreads((await rpc.query(project.id, "board")).threads)
    } catch (error) {
      void api.window.showErrorMessage(describeRpcError(error))
      return undefined
    }
    let thread: (PickerThread & { sessionId: string }) | undefined
    if (typeof options.thread === "string") {
      thread = findThread(threads, options.thread)
      if (!thread) {
        void api.window.showErrorMessage(`No open thread named ${options.thread} in ${project.name}.`)
        return undefined
      }
    } else {
      if (!threads.length) {
        void api.window.showInformationMessage(`${project.name} has no open threads. Ask Frizz to start one.`)
        return undefined
      }
      const picked = await api.window.showQuickPick(
        threads.map((candidate) => ({ ...threadItem(candidate), thread: candidate })),
        {
          title: ref ? `Send ${refLabel(ref)} to a thread` : "Send to a thread",
          placeHolder: `Pick a thread in ${project.name}`,
          matchOnDescription: true,
          matchOnDetail: true,
          ignoreFocusOut: true,
        },
      )
      thread = picked?.thread
    }
    if (!thread) return undefined
    if (promptRoute(useSidebar(), options.message) === "sidebar") {
      // The thread in the sidebar, the chip in its reply box and the caret after it. With no file to
      // carry, the thread alone, to write in.
      const to = { thread: thread.id, project: project.slug }
      if (ref) {
        const item = { ...composeInput({ ...ref, projectId: project.id }), app: api.env.appName }
        const composed = await composeInSidebar({ item, target: to, focus: true }, false)
        if (composed) return { slug: thread.id, composed }
      } else {
        await sidebar.reveal(false)
        if ((await sidebar.waitReady(SIDEBAR_READY_MS)) && (await sidebar.navigate(to))) return { slug: thread.id }
      }
      log.info("Sending from an input box instead.")
    }
    const name = threadHandleOf(thread) ? `@${threadHandleOf(thread)}` : displayTitle(thread)
    const message = typeof options.message === "string"
      ? options.message
      : await api.window.showInputBox({
          title: `Message ${name}`,
          prompt: ref ? `About ${refLabel(ref)}` : undefined,
          placeHolder: "Your message",
          ignoreFocusOut: true,
          validateInput: (value) => (value.trim() ? undefined : "Type a message."),
        })
    if (message === undefined || !message.trim()) return undefined
    const text = ref ? composeMessage(message, ref) : normalizeNewlines(message).trim()
    // One id for every attempt: the server drops a resend of a delivery it already took.
    const deliveryId = randomUUID()
    const chosen = thread
    try {
      await api.window.withProgress({ location: api.ProgressLocation.Notification, title: `Sending to ${name}…` }, () =>
        withRetry(() => rpc.mutation(project.id, "followUp", { slug: chosen.id, sessionId: chosen.sessionId, message: text, deliveryId }, 120_000)))
      log.info(`Sent a message to ${chosen.id} in ${project.name}.`)
      void api.window.showInformationMessage(`Sent to ${name}.`, "Open thread").then((choice) => {
        if (choice) openUrl(threadUrl(origin, project, chosen.id))
      })
      return { slug: chosen.id, deliveryId }
    } catch (error) {
      log.error(`Sending to ${chosen.id} failed: ${(error as Error).message}`)
      void api.window.showErrorMessage(describeRpcError(error, "send"))
      return undefined
    }
  }

  /**
   * Put items into the prompt box the human looks at — the one way in for Add to Frizz prompt, a file, a
   * problem's quick fix and a terminal selection. With the sidebar (embed.ts addRoute): its FRONT composer
   * (the reply box of the thread it shows, else its new-thread box), the view revealed — opened, the first
   * time in a window — and the caret after the last chip, with `note` written after it. Otherwise, and for
   * whatever the sidebar did not take (it never loaded, or refused), Frizz holds each item for a browser
   * page to claim, the path from before the sidebar, so a selection is never simply lost — unless the item
   * means nothing outside the sidebar (`sidebarOnly`: a terminal selection). The note rides the sidebar
   * only; a held item has no place for one.
   */
  async function deliver(items: readonly EditorComposeInput[], options: { note?: string; sidebarOnly?: boolean } = {}): Promise<EditorComposed | undefined> {
    let left = items
    const frizz = (connection.origin ?? found?.origin) !== undefined
    if (addRoute({ enabled: useSidebar(), frizz }) === "sidebar") {
      let composed: EditorComposed | undefined
      while (left.length) {
        const [item, ...rest] = left
        const note = rest.length === 0 && options.note ? { note: options.note } : {}
        const next = await composeInSidebar({ item: { ...item!, app: api.env.appName }, target: "front", focus: true, ...note }, false)
        if (!next) break
        composed = next
        left = rest
      }
      if (!left.length && composed) {
        api.window.setStatusBarMessage("Added to Frizz's prompt box", 4_000)
        return composed
      }
      if (!options.sidebarOnly) log.info("Handing it to Frizz for its page instead.")
    }
    if (options.sidebarOnly) {
      if (!useSidebar()) void api.window.showInformationMessage("Turn on the Frizz sidebar (frizz.useSidebar) to add this to Frizz's prompt box.")
      else if (!frizz) showNotConnected()
      else void api.window.showErrorMessage(sidebarWhy || "The Frizz sidebar couldn't take it.")
      return undefined
    }
    const origin = requireOrigin()
    if (!origin) return undefined
    let composed: EditorComposed | undefined
    for (const item of left) {
      composed = await connection.compose(item)
      if (!composed.ok) {
        log.warn(`Adding to the prompt box failed: ${composed.error ?? "no reason given"}`)
        void api.window.showErrorMessage(`Couldn't add to Frizz's prompt box: ${composed.error ?? "Frizz refused it."}`)
        return composed
      }
    }
    api.window.setStatusBarMessage("Added to Frizz's prompt box", 4_000)
    const project = left[0]?.projectId ? projects.find((candidate) => candidate.id === left[0]!.projectId) : undefined
    void api.window.showInformationMessage("Added to Frizz's prompt box.", "Open Frizz").then((choice) => {
      if (choice) openUrl(projectUrl(origin, project ?? windowProject()))
    })
    return composed
  }

  /** A compose item for a place in a file, with the project it belongs to and that project's spelling of its path. */
  function itemFor(target: { path: string; selection?: Selected; cursorLine?: number }): EditorComposeInput {
    const match = projectForPath(target.path, projects)
    return composeInput({ ...target, path: match?.path ?? target.path, projectId: match?.project.id })
  }

  /**
   * Add to Frizz prompt — Ctrl+L / ⌘L (Cursor's chord) or Ctrl+I / ⌘I with a selection, the editor's Frizz
   * menu, the palette: the selection, else the caret's line.
   */
  async function addToPrompt(...args: unknown[]): Promise<EditorComposed | undefined> {
    const { uri } = splitArgs(args)
    const target = targetOf(uri)
    if (!target) {
      void api.window.showInformationMessage("Open a file to add it to Frizz's prompt box.")
      return undefined
    }
    return deliver([itemFor(target)])
  }

  /**
   * Add file to Frizz prompt — an editor tab's menu, the explorer (every file selected there), the palette
   * (the file in front): a reference to each whole file. Folders are left out; a prompt names files.
   */
  async function addFileToPrompt(...args: unknown[]): Promise<EditorComposed | undefined> {
    const many = args.find((arg): arg is vscode.Uri[] => Array.isArray(arg) && arg.length > 0 && arg.every((each) => each instanceof api.Uri))
    const one = args.find((arg): arg is vscode.Uri => arg instanceof api.Uri) ?? api.window.activeTextEditor?.document.uri
    const items: EditorComposeInput[] = []
    for (const uri of many ?? (one ? [one] : [])) {
      if (uri.scheme !== "file") continue
      try {
        if (!(await stat(uri.fsPath)).isFile()) continue
      } catch {
        continue
      }
      items.push(itemFor({ path: uri.fsPath }))
    }
    if (!items.length) {
      void api.window.showInformationMessage("Pick a file on disk to add it to Frizz's prompt box.")
      return undefined
    }
    return deliver(items)
  }

  /**
   * Alt+K (Option+K on a Mac) — Claude Code's chord for an @-mention of the code in front: the selection
   * when there is one, as Add to Frizz prompt adds it; with only a caret, the whole file, as Add file to
   * Frizz prompt adds it. Not the caret's line, which is what the palette's Add to Frizz prompt falls back
   * to: a mention with nothing selected names the file, which is what the human is looking at.
   */
  async function addSelectionOrFile(...args: unknown[]): Promise<EditorComposed | undefined> {
    const editor = api.window.activeTextEditor
    return editor && !editor.selection.isEmpty ? addToPrompt(...args) : addFileToPrompt(...args)
  }

  /**
   * Ask Frizz to fix — the quick fix on a problem: the problem's lines with their text, and the problem
   * itself written after the chip (`Fix: Cannot find name 'foo'. ts(2304)`), so the box reads as a request
   * the human can send as it is.
   */
  async function askToFix(uri: unknown, range: unknown, problem: unknown): Promise<EditorComposed | undefined> {
    if (!(uri instanceof api.Uri) || !(range instanceof api.Range) || !problem || typeof problem !== "object") return undefined
    const document = await api.workspace.openTextDocument(uri)
    const { startLine, endLine } = lineSpan(range.start, range.end)
    const last = Math.min(endLine, document.lineCount) - 1
    const text = normalizeNewlines(document.getText(new api.Range(startLine - 1, 0, last, document.lineAt(last).text.length)))
    return deliver([itemFor({ path: uri.fsPath, selection: { text, startLine, endLine: last + 1 } })], { note: fixNote(problem as Problem) })
  }

  /**
   * The terminal's selection, read without keeping the human's clipboard: VS Code has no stable API for
   * it (`Terminal.selection` is a proposal only Copilot may use), so the terminal's own Copy runs between
   * a unique marker and the clipboard's previous text, which is put back whatever happens. The marker
   * still there afterwards means nothing was copied. Lost on the way: a clipboard holding something other
   * than text (an image) comes back empty, and a clipboard history records the selection.
   */
  async function readTerminalSelection(): Promise<string | undefined> {
    const before = await api.env.clipboard.readText()
    const marker = `frizz-terminal-${randomUUID()}`
    await api.env.clipboard.writeText(marker)
    try {
      await api.commands.executeCommand("workbench.action.terminal.copySelection")
      const copied = await api.env.clipboard.readText()
      return copied === marker ? undefined : copied
    } finally {
      await api.env.clipboard.writeText(before)
    }
  }

  /** Add to Frizz prompt from the terminal's menu: its selection as an `@terminal` chip. Sidebar only; see deliver. */
  async function addTerminalSelection(): Promise<EditorComposed | undefined> {
    const checked = terminalText((await readTerminalSelection()) ?? "")
    if (!checked.ok) {
      void api.window.showInformationMessage(checked.why)
      return undefined
    }
    const project = windowProject()
    return deliver([{ path: EMBED_TERMINAL_PATH, text: checked.text, ...(project ? { projectId: project.id } : {}) }], { sidebarOnly: true })
  }

  /**
   * The page's context bar asked for the editor's context (`frizz:add-context`): the selection of the file
   * in front, or a whole file, into the composer it shows. It came from the sidebar, so it goes back there
   * or nowhere; and it carries the text as the editor has it NOW — nothing when the selection or the file
   * is gone by the time the click arrives.
   */
  async function addContextFromPage(message: EmbedAddContextMessage): Promise<string> {
    let item: EditorComposeInput
    if (message.what === "selection") {
      const editor = activeFileEditor(api)
      if (!editor || editor.selection.isEmpty) return "nothing selected"
      const target = targetOf(editor.document.uri)
      if (!target?.selection) return "nothing selected"
      item = itemFor(target)
    } else {
      try {
        if (!(await stat(message.path!)).isFile()) return "missing"
      } catch {
        return "missing"
      }
      item = itemFor({ path: message.path! })
    }
    // `preserveFocus`: the human clicked the bar, so the view is in sight and focused already; revealing it
    // again re-focused the view after the page had put the caret in its box, and the caret was lost
    // (scripts/e2e-sidebar.ts, 1 run in 3).
    const composed = await composeInSidebar({ item: { ...item, app: api.env.appName }, target: "front", focus: true }, true)
    return composed ? "composed" : "not taken"
  }

  /**
   * A title-row button (or its ⋯ menu), or the same command from the palette: the view brought into sight
   * (opened, the first time) and focused, then the door posted to its page — New thread puts the caret in
   * the box, Jump opens the page's own ⌘K palette, Keyboard shortcuts the page's `?` sheet.
   */
  async function sidebarCommand(command: EmbedCommandMessage["command"]): Promise<boolean> {
    await sidebar.reveal(false)
    if ((await sidebar.waitReady(SIDEBAR_READY_MS)) && (await sidebar.post({ type: "frizz:command", command }))) return true
    log.warn(`The sidebar's page isn't ready, so ${command} did nothing.`)
    return false
  }

  function openFrizz(): void {
    // The page needs no editor connection: a Frizz that answered discovery but refused the socket (an
    // older Frizz, a version mismatch) still serves its page.
    const origin = connection.origin ?? found?.origin
    if (!origin) return showNotConnected()
    // What the sidebar shows, when it is in sight — a thread up in it opens as that thread — on this
    // window's own address for Frizz (under a remote window the frame's is the forwarded one); else this
    // window's project.
    const shown = sidebar.href()
    const page = shown ? new URL(shown) : undefined
    openUrl(page ? new URL(`${page.pathname}${page.search}`, origin).toString() : projectUrl(origin, windowProject()))
  }

  context.subscriptions.push(
    api.commands.registerCommand("frizz.ask", ask),
    api.commands.registerCommand("frizz.sendToThread", sendToThread),
    api.commands.registerCommand("frizz.addToPrompt", addToPrompt),
    api.commands.registerCommand("frizz.addFileToPrompt", addFileToPrompt),
    api.commands.registerCommand("frizz.addSelectionOrFile", addSelectionOrFile),
    api.commands.registerCommand("frizz.addTerminalSelection", addTerminalSelection),
    api.commands.registerCommand(FIX_COMMAND, askToFix),
    api.commands.registerCommand("frizz.sidebar.newThread", () => sidebarCommand("new-thread")),
    api.commands.registerCommand("frizz.sidebar.queue", () => sidebarCommand("queue")),
    api.commands.registerCommand("frizz.sidebar.jump", () => sidebarCommand("jump")),
    api.commands.registerCommand("frizz.sidebar.settings", () => sidebarCommand("settings")),
    api.commands.registerCommand("frizz.sidebar.shortcuts", () => sidebarCommand("shortcuts")),
    // "Ask Frizz to fix" on any problem in a file on disk, in every language. Offered only with the sidebar
    // on: without it the problem's message has nowhere to go, and a bare chip is Add to Frizz prompt.
    api.languages.registerCodeActionsProvider({ scheme: "file" }, {
      provideCodeActions(document, _range, codeContext) {
        if (!codeContext.diagnostics.length || !useSidebar()) return []
        if (codeContext.only && !codeContext.only.intersects(api.CodeActionKind.QuickFix)) return []
        const problems = codeContext.diagnostics.slice(0, MAX_FIXES)
        return problems.map((diagnostic) => {
          const code = typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code
          const problem: Problem = { message: diagnostic.message, ...(diagnostic.source ? { source: diagnostic.source } : {}), ...(code === undefined ? {} : { code }) }
          const action = new api.CodeAction(fixTitle(problem, problems.length > 1), api.CodeActionKind.QuickFix)
          action.diagnostics = [diagnostic]
          action.command = { command: FIX_COMMAND, title: action.title, arguments: [document.uri, diagnostic.range, problem] }
          return action
        })
      },
    }, { providedCodeActionKinds: [api.CodeActionKind.QuickFix] }),
    api.commands.registerCommand("frizz.open", openFrizz),
    api.commands.registerCommand("frizz.showLog", () => log.show()),
    api.commands.registerCommand("frizz.sidebar.reload", () => sidebar.reload()),
    api.commands.registerCommand("frizz.reconnect", () => {
      log.info("Reconnecting.")
      connection.reconnect()
    }),
  )

  log.info(`Frizz extension ${extensionVersion} in ${api.env.appName}, window ${windowId}.`)
  connection.start()

  return {
    windowId,
    status: () => status,
    statusBar: () => ({ ...shown }),
    origin: () => connection.origin,
    discovered: () => found,
    projects: () => projects,
    sidebar: () => sidebar.snapshot(),
    editorContext: () => feed.last(),
  }
}
