// THE EDITOR, REPORTED TO FRIZZ FOR ITS AGENTS — reads what this window shows out of VS Code (the file in
// front, its selection and text, the tabs, the errors and warnings) and has the connection send it as the
// `editor` frame whenever it changes, so a worker's `mcp__frizz__editor` always reads the current picture.
// The rules — what is carried, the caps, the order, the fitting — are pure, in editor-state.ts; this is
// the glue. Only `import type` from vscode, like app.ts.
//
// When it sends: after DEBOUNCE_MS of quiet following any change of the active editor, its selection,
// what is on screen, the tabs, a document's text or dirty state, or the diagnostics — a drag across forty
// lines or a language server re-publishing problems on every keystroke is one frame, not forty — and at
// once on a change of `frizz.shareEditorState`. The connection sends it once more on every connect and
// drops a frame identical to the last it sent (connection.ts sendEditor).
//
// Which editor is "in front": the active text editor when it is a file or an untitled buffer. Focus in
// an output pane or the debug console makes THAT the active text editor in VS Code, which would blank the
// selection the human was just pointing at, so then the last file editor still on screen stands in.

import type * as vscode from "vscode"
import type { EditorSnapshot } from "@frizz/shared/editor-protocol"
import { Recency } from "./editor-context.ts"
import { buildEditorSnapshot, unsharedSnapshot, type ActiveInput, type DiagnosticInput } from "./editor-state.ts"

type Vscode = typeof vscode

const DEBOUNCE_MS = 250

export const SHARE_SETTING = "shareEditorState"

export interface EditorStateFeedHost {
  /** Send the current snapshot now (the connection pulls it through `snapshot()`). */
  send(): void
}

export interface EditorStateFeed {
  /** What this window shows right now, as the `editor` frame (unfitted; the connection fits it). */
  snapshot(): EditorSnapshot
}

/** Documents an agent may read: files on disk and untitled buffers — never output panes, git revisions or settings UIs. */
const readable = (uri: vscode.Uri) => uri.scheme === "file" || uri.scheme === "untitled"
/** How a document is named in the frame: its path on disk, or an untitled buffer's label (`Untitled-1`). */
const pathOf = (uri: vscode.Uri) => (uri.scheme === "untitled" ? uri.path : uri.fsPath)

export function registerEditorStateFeed(api: Vscode, context: vscode.ExtensionContext, host: EditorStateFeedHost): EditorStateFeed {
  const recency = new Recency()
  let lastReadable: vscode.TextEditor | undefined
  let timer: NodeJS.Timeout | undefined

  const shared = () => api.workspace.getConfiguration("frizz").get<boolean>(SHARE_SETTING, true)

  function frontEditor(): vscode.TextEditor | undefined {
    const active = api.window.activeTextEditor
    if (active && readable(active.document.uri)) return active
    return lastReadable && api.window.visibleTextEditors.includes(lastReadable) && !lastReadable.document.isClosed ? lastReadable : undefined
  }

  function activeInput(editor: vscode.TextEditor): ActiveInput {
    const { document, selection } = editor
    const visible = editor.visibleRanges
    return {
      path: pathOf(document.uri),
      untitled: document.uri.scheme === "untitled",
      languageId: document.languageId,
      dirty: document.isDirty,
      lineCount: document.lineCount,
      cursor: selection.active,
      ...(selection.isEmpty ? {} : { selection: { start: selection.start, end: selection.end, text: document.getText(selection) } }),
      ...(visible.length ? { visible: { start: visible[0]!.start.line, end: visible[visible.length - 1]!.end.line } } : {}),
    }
  }

  function openTabs(): { path: string; untitled: boolean; dirty: boolean }[] {
    const tabs: { path: string; untitled: boolean; dirty: boolean }[] = []
    for (const group of api.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof api.TabInputText && readable(tab.input.uri)) {
          tabs.push({ path: pathOf(tab.input.uri), untitled: tab.input.uri.scheme === "untitled", dirty: tab.isDirty })
        }
      }
    }
    const order = recency.sort(tabs.map((tab) => tab.path))
    const byPath = new Map(tabs.map((tab) => [tab.path, tab]))
    return order.map((path) => byPath.get(path)!)
  }

  function diagnostics(): DiagnosticInput[] {
    const out: DiagnosticInput[] = []
    for (const [uri, list] of api.languages.getDiagnostics()) {
      if (!readable(uri)) continue
      const path = pathOf(uri)
      for (const each of list) {
        const severity = each.severity === api.DiagnosticSeverity.Error ? "error" : each.severity === api.DiagnosticSeverity.Warning ? "warning" : undefined
        if (!severity) continue
        const code = typeof each.code === "object" ? each.code.value : each.code
        out.push({ path, line: each.range.start.line, severity, message: each.message, ...(each.source ? { source: each.source } : {}), ...(code === undefined ? {} : { code }) })
      }
    }
    return out
  }

  function snapshot(): EditorSnapshot {
    if (!shared()) return unsharedSnapshot()
    const editor = frontEditor()
    return buildEditorSnapshot({ shared: true, active: editor ? activeInput(editor) : undefined, open: openTabs(), diagnostics: diagnostics() })
  }

  function schedule(): void {
    clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      host.send()
    }, DEBOUNCE_MS)
  }

  function noteActive(editor: vscode.TextEditor | undefined): void {
    if (!editor || !readable(editor.document.uri)) return
    lastReadable = editor
    recency.touch(pathOf(editor.document.uri))
  }

  // The order a window already had when the extension woke: each group's tab in front, then the active editor.
  for (const group of api.window.tabGroups.all) {
    const input = group.activeTab?.input
    if (input instanceof api.TabInputText && readable(input.uri)) recency.touch(pathOf(input.uri))
  }
  noteActive(api.window.activeTextEditor)

  const ours = (document: vscode.TextDocument) => readable(document.uri)
  context.subscriptions.push(
    api.window.onDidChangeActiveTextEditor((editor) => {
      noteActive(editor)
      schedule()
    }),
    api.window.onDidChangeTextEditorSelection((event) => {
      if (ours(event.textEditor.document)) schedule()
    }),
    api.window.onDidChangeTextEditorVisibleRanges((event) => {
      if (event.textEditor === frontEditor()) schedule()
    }),
    api.window.tabGroups.onDidChangeTabs(() => schedule()),
    api.window.tabGroups.onDidChangeTabGroups(() => schedule()),
    // A keystroke changes the selected text and the dirty flag; a save clears the flag.
    api.workspace.onDidChangeTextDocument((event) => {
      if (ours(event.document)) schedule()
    }),
    api.workspace.onDidSaveTextDocument((document) => {
      if (ours(document)) schedule()
    }),
    api.languages.onDidChangeDiagnostics(() => schedule()),
    api.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(`frizz.${SHARE_SETTING}`)) return
      clearTimeout(timer)
      timer = undefined
      host.send()
    }),
    { dispose: () => clearTimeout(timer) },
  )

  return { snapshot }
}
