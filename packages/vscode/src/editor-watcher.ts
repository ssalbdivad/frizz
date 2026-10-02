// ONE OBSERVER OF THE WINDOW'S EDITORS — the glue that holds VS Code's editors to the rules in
// editor-front.ts, for both feeds that report them: the sidebar's page feed (context-feed.ts) and the
// agents' feed (editor-state-feed.ts). One recency order of the tabs, one "last file editor on screen" for
// when an output pane has focus, one privacy answer; each feed subscribes to the changes it cares about
// and builds its own message from the same reading, so the context bar, the block a send carries and the
// agent's tool cannot disagree about what is in front. Why there is one: editor-front.ts.
//
// Only `import type` from vscode, like app.ts.

import type * as vscode from "vscode"
import { Recency } from "./editor-context.ts"
import { documentPath, editorFront, pickFront, readableUri, type EditorFront } from "./editor-front.ts"

type Vscode = typeof vscode

/**
 * What changed, for a feed to decide whether to rebuild:
 *  - "front": a different editor is in front (or none);
 *  - "selection": a readable editor's selection or caret moved;
 *  - "text": a readable document's text changed (`front` says whether it is the one in front) — the
 *    selected text, the dirty flag;
 *  - "save": a readable document was saved (its dirty flag cleared);
 *  - "tabs": the tabs or tab groups changed;
 *  - "folders": the workspace folders changed (labels and project matches may differ now).
 */
export type EditorChange = { kind: "front" | "selection" | "save" | "tabs" | "folders" } | { kind: "text"; front: boolean }

export interface OpenTab {
  path: string
  untitled: boolean
  dirty: boolean
}

export interface EditorWatcher {
  /** The text editor in front (editor-front.ts pickFront), for a command that acts on it. */
  frontEditor(): vscode.TextEditor | undefined
  /** It, read now; undefined when nothing readable is in front. */
  front(): { editor: vscode.TextEditor; front: EditorFront } | undefined
  /** Every file and untitled buffer open in a tab, each once, most recently in front first, then tab order. */
  tabs(): OpenTab[]
  onChange(listener: (change: EditorChange) => void): void
}

export function registerEditorWatcher(api: Vscode, context: vscode.ExtensionContext): EditorWatcher {
  const recency = new Recency()
  let last: vscode.TextEditor | undefined
  const listeners: ((change: EditorChange) => void)[] = []
  const emit = (change: EditorChange) => {
    for (const listener of listeners) listener(change)
  }

  function frontEditor(): vscode.TextEditor | undefined {
    return pickFront(api.window.activeTextEditor, last, api.window.visibleTextEditors)
  }

  /**
   * `files.exclude` for this document, by VS Code's own glob engine: each pattern set to `true` (one with a
   * `when` clause hides a file only beside a sibling, which is not a statement about this file), relative to
   * each workspace folder, as the explorer applies it. A handful of patterns against one document, on a
   * change of the editor in front — cheap.
   */
  function excluded(document: vscode.TextDocument): boolean {
    if (document.uri.scheme !== "file") return false
    const patterns = Object.entries(api.workspace.getConfiguration("files", document.uri).get<Record<string, unknown>>("exclude") ?? {})
      .filter(([, on]) => on === true)
      .map(([glob]) => glob)
    if (!patterns.length) return false
    const folders = api.workspace.workspaceFolders ?? []
    for (const glob of patterns) {
      const selectors = folders.length ? folders.map((folder) => ({ pattern: new api.RelativePattern(folder, glob) })) : [{ pattern: glob }]
      try {
        if (api.languages.match(selectors, document) > 0) return true
      } catch {
        // A pattern VS Code's own matcher will not take is not one it applies to the explorer either.
      }
    }
    return false
  }

  function noteActive(editor: vscode.TextEditor | undefined): void {
    if (!editor || !readableUri(editor.document.uri)) return
    last = editor
    recency.touch(documentPath(editor.document.uri))
  }

  // The order a window already had when the extension woke: each group's tab in front, then the active editor.
  for (const group of api.window.tabGroups.all) {
    const input = group.activeTab?.input
    if (input instanceof api.TabInputText && readableUri(input.uri)) recency.touch(documentPath(input.uri))
  }
  noteActive(api.window.activeTextEditor)

  const readable = (document: vscode.TextDocument) => readableUri(document.uri)
  context.subscriptions.push(
    api.window.onDidChangeActiveTextEditor((editor) => {
      noteActive(editor)
      emit({ kind: "front" })
    }),
    api.window.onDidChangeTextEditorSelection((event) => {
      if (readable(event.textEditor.document)) emit({ kind: "selection" })
    }),
    api.workspace.onDidChangeTextDocument((event) => {
      if (readable(event.document)) emit({ kind: "text", front: event.document === frontEditor()?.document })
    }),
    api.workspace.onDidSaveTextDocument((document) => {
      if (readable(document)) emit({ kind: "save" })
    }),
    api.window.tabGroups.onDidChangeTabs(() => emit({ kind: "tabs" })),
    api.window.tabGroups.onDidChangeTabGroups(() => emit({ kind: "tabs" })),
    api.workspace.onDidChangeWorkspaceFolders(() => emit({ kind: "folders" })),
  )

  return {
    frontEditor,
    front() {
      const editor = frontEditor()
      return editor ? { editor, front: editorFront(editor, excluded(editor.document)) } : undefined
    },
    tabs() {
      const tabs: OpenTab[] = []
      const seen = new Set<string>()
      for (const group of api.window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (!(tab.input instanceof api.TabInputText) || !readableUri(tab.input.uri)) continue
          const path = documentPath(tab.input.uri)
          if (seen.has(path)) continue
          seen.add(path)
          tabs.push({ path, untitled: tab.input.uri.scheme === "untitled", dirty: tab.isDirty })
        }
      }
      const byPath = new Map(tabs.map((tab) => [tab.path, tab]))
      return recency.sort(tabs.map((tab) => tab.path)).map((path) => byPath.get(path)!)
    },
    onChange(listener) {
      listeners.push(listener)
    },
  }
}
