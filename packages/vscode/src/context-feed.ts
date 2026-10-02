// THE EDITOR'S LIVE CONTEXT, FED TO THE SIDEBAR — `frizz:editor-context` (packages/shared/src/
// embed-protocol.ts): the text editor in front, its selection with the primary selection's text (or the
// caret's line, with nothing selected), and the other files open in tabs, posted to the sidebar's page
// whenever it is ready and they change. The page's context bar shows it, and a message sent from the
// sidebar carries the selection, or the file and line, unless the human turned that off (the bar's eye;
// packages/web/src/lib/editorContext.ts outgoingMessage). The text is in the feed rather than fetched at
// send so Enter sends at once. The rules — lines, labels, order, the caps — are pure, in
// editor-context.ts; this is the glue.
//
// When it sends: once the moment the page says it is ready (a reloaded page knows nothing), and again on
// a change of the active editor, its selection or caret line, the selected text itself (an edit under a
// held selection: the agent working on that file) or the tab set, after DEBOUNCE_MS of quiet — a drag
// across forty lines is one message, not forty. A payload identical to the last one sent is not sent
// again — typing on one line changes nothing the feed says — and nothing is sent while no page is ready.
//
// Only `import type` from vscode, like app.ts.

import type * as vscode from "vscode"
import type { EditorProject } from "@frizz/shared/editor-protocol"
import type { EmbedEditorContextMessage, EmbedEditorFile } from "@frizz/shared/embed-protocol"
import { editorContextMessage, editorSelection, fileLabel, openFiles, Recency } from "./editor-context.ts"
import { projectForPath } from "./projects.ts"

type Vscode = typeof vscode

const DEBOUNCE_MS = 100

export interface ContextFeedHost {
  ready(): boolean
  /** Fires when the sidebar's page becomes ready (true) or stops being (false). */
  onReady(listener: (ready: boolean) => void): void
  post(message: EmbedEditorContextMessage): Promise<boolean>
  projects(): readonly EditorProject[]
}

export interface ContextFeed {
  /** The projects changed: files may belong elsewhere now. */
  refresh(): void
  /** The last message the page was sent, for the end-to-end suite. */
  last(): EmbedEditorContextMessage | undefined
}

/**
 * The file editor in front, or undefined: none at all, an untitled buffer, something that is not a file on
 * disk (output, a git revision), or a side of a DIFF — that is a comparison being read, not a file the
 * human has open, and the modified side of a working-tree diff is otherwise a `file:` editor. The context
 * bar shows this one, and a click on its selection adds this one's (app.ts), so the two cannot disagree.
 */
export function activeFileEditor(api: Vscode): vscode.TextEditor | undefined {
  const editor = api.window.activeTextEditor
  if (!editor || editor.document.uri.scheme !== "file") return undefined
  // Its group, by column. A diff's sides are EMBEDDED editors, which VS Code 1.90 gives no column at all
  // (1.140 gives them their group's): with none, the group in front is the one it is in.
  const group = editor.viewColumn === undefined ? api.window.tabGroups.activeTabGroup : api.window.tabGroups.all.find((candidate) => candidate.viewColumn === editor.viewColumn)
  if (group?.activeTab?.input instanceof api.TabInputTextDiff) return undefined
  return editor
}

export function registerContextFeed(api: Vscode, context: vscode.ExtensionContext, host: ContextFeedHost): ContextFeed {
  const recency = new Recency()
  /** fsPath → how it is shown: matching a file to a project reads its real path, so once per file per project list. */
  const described = new Map<string, EmbedEditorFile>()
  let timer: NodeJS.Timeout | undefined
  let lastKey: string | undefined
  let last: EmbedEditorContextMessage | undefined

  function describe(fsPath: string): EmbedEditorFile {
    let file = described.get(fsPath)
    if (!file) {
      const match = projectForPath(fsPath, host.projects())
      // The spelling that matched the project, as a compose item's path is: the server's own.
      file = { path: match?.path ?? fsPath, label: fileLabel(fsPath, api.workspace.asRelativePath(api.Uri.file(fsPath))), ...(match ? { projectId: match.project.id } : {}) }
      described.set(fsPath, file)
    }
    return file
  }

  function tabPaths(): string[] {
    const paths: string[] = []
    for (const group of api.window.tabGroups.all) {
      for (const tab of group.tabs) if (tab.input instanceof api.TabInputText && tab.input.uri.scheme === "file") paths.push(tab.input.uri.fsPath)
    }
    return paths
  }

  function build(): EmbedEditorContextMessage {
    const editor = activeFileEditor(api)
    const activePath = editor?.document.uri.fsPath
    let active: Parameters<typeof editorContextMessage>[0] = null
    if (editor) {
      const document = editor.document
      const primary = editor.selection
      const selection = editorSelection(
        editor.selections.map((each) => ({ start: each.start, end: each.end, chars: document.offsetAt(each.end) - document.offsetAt(each.start) })),
        () => document.getText(primary),
      )
      active = { ...describe(activePath!), ...(selection ? { selection } : { cursorLine: primary.active.line + 1 }) }
    }
    return editorContextMessage(active, openFiles(tabPaths(), activePath, recency).map(describe))
  }

  async function send(): Promise<void> {
    clearTimeout(timer)
    timer = undefined
    if (!host.ready()) return
    const message = build()
    const key = JSON.stringify(message)
    if (key === lastKey) return
    lastKey = key
    if (await host.post(message)) last = message
    else lastKey = undefined
  }

  function schedule(): void {
    if (!host.ready()) return
    clearTimeout(timer)
    timer = setTimeout(() => void send(), DEBOUNCE_MS)
  }

  // The order a window already had when the extension woke: the tab in front of each group, then the
  // active editor, most recent of all.
  for (const group of api.window.tabGroups.all) {
    const input = group.activeTab?.input
    if (input instanceof api.TabInputText && input.uri.scheme === "file") recency.touch(input.uri.fsPath)
  }
  const initial = activeFileEditor(api)
  if (initial) recency.touch(initial.document.uri.fsPath)

  host.onReady((ready) => {
    lastKey = undefined
    if (ready) void send()
    else clearTimeout(timer)
  })

  context.subscriptions.push(
    api.window.onDidChangeActiveTextEditor((editor) => {
      if (editor?.document.uri.scheme === "file") recency.touch(editor.document.uri.fsPath)
      schedule()
    }),
    api.window.onDidChangeTextEditorSelection((event) => {
      if (event.textEditor === api.window.activeTextEditor) schedule()
    }),
    // The selected text changed under a selection the human is holding — an agent editing that very file,
    // a format on save — with no selection event to say so. Without a selection there is no text in the
    // feed to go stale, and typing would only rebuild the same message.
    api.workspace.onDidChangeTextDocument((event) => {
      const editor = api.window.activeTextEditor
      if (editor && event.document === editor.document && !editor.selection.isEmpty) schedule()
    }),
    api.window.tabGroups.onDidChangeTabs(() => schedule()),
    api.window.tabGroups.onDidChangeTabGroups(() => schedule()),
    api.workspace.onDidChangeWorkspaceFolders(() => {
      described.clear()
      schedule()
    }),
    { dispose: () => clearTimeout(timer) },
  )

  return {
    refresh() {
      described.clear()
      schedule()
    },
    last: () => last,
  }
}
