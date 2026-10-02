// THE EDITOR'S HALF OF THE REAL-PAGE SIDEBAR RUN — runs INSIDE the VS Code that scripts/e2e-sidebar.ts
// launches (as `--extensionTestsPath`), and does only what needs the editor's API: open a file and select
// in it, read what the extension's sidebar did and what the editor shows, change a setting, run a
// command. Everything a human does — keys, clicks, typing — the harness does from outside, over the
// workbench's debugging port, and everything it asserts about the page it reads from the page itself.
//
// It asks the harness for the next operation over HTTP (FRIZZ_E2E_AGENT, a loopback address the harness
// serves), runs it, and posts the answer back, until the harness says `done`.

import { realpathSync } from "node:fs"
import * as vscode from "vscode"
import type { FrizzExtensionApi } from "../src/app.ts"

const control = process.env.FRIZZ_E2E_AGENT ?? ""

/** `[startLine, startCharacter, endLine, endCharacter]`, 0-based as the API counts; an end character of -1 is the line's end. */
export type Range4 = [number, number, number, number]

export type AgentOp =
  | { op: "status" }
  | { op: "command"; id: string; args?: unknown[] }
  | { op: "open"; path: string; selection?: Range4; preview?: boolean; column?: number; preserveFocus?: boolean }
  | { op: "select"; selection: Range4 }
  | { op: "editor" }
  | { op: "tabs" }
  | { op: "config"; section: string; key: string; value: unknown }
  | { op: "diagnostics"; path: string }
  | { op: "done" }

export interface AgentStatus {
  version: string
  appName: string
  status: ReturnType<FrizzExtensionApi["status"]>
  sidebar: ReturnType<FrizzExtensionApi["sidebar"]>
  editorContext: ReturnType<FrizzExtensionApi["editorContext"]>
  theme: number
}

export interface EditorState {
  path: string | null
  selection: { start: [number, number]; end: [number, number] } | null
}

function range(document: vscode.TextDocument, [a, b, c, d]: Range4): vscode.Selection {
  return new vscode.Selection(a, b, c, d < 0 ? document.lineAt(c).text.length : d)
}

/** JSON can't carry a Uri or a class; what a command returned, as plain data. */
function plain(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value ?? null))
  } catch {
    return String(value)
  }
}

async function perform(api: FrizzExtensionApi, op: AgentOp): Promise<unknown> {
  switch (op.op) {
    case "status":
      return {
        version: vscode.version,
        appName: vscode.env.appName,
        status: api.status(),
        sidebar: api.sidebar(),
        editorContext: api.editorContext(),
        theme: vscode.window.activeColorTheme.kind,
      } satisfies AgentStatus
    case "command":
      return plain(await vscode.commands.executeCommand(op.id, ...(op.args ?? [])))
    case "open": {
      const document = await vscode.workspace.openTextDocument(op.path)
      const editor = await vscode.window.showTextDocument(document, { preview: op.preview ?? false, viewColumn: op.column, preserveFocus: op.preserveFocus ?? false })
      if (op.selection) editor.selection = range(document, op.selection)
      return null
    }
    case "select": {
      const editor = vscode.window.activeTextEditor
      if (!editor) throw new Error("no editor in front")
      editor.selection = range(editor.document, op.selection)
      editor.revealRange(editor.selection)
      return null
    }
    case "editor": {
      const editor = vscode.window.activeTextEditor
      const s = editor?.selection
      return {
        path: editor ? realpathSync(editor.document.uri.fsPath) : null,
        selection: s ? { start: [s.start.line, s.start.character], end: [s.end.line, s.end.character] } : null,
      } satisfies EditorState
    }
    case "tabs":
      return vscode.window.tabGroups.all.flatMap((group) => group.tabs.map((tab) => ({
        label: tab.label,
        path: tab.input instanceof vscode.TabInputText ? tab.input.uri.fsPath : null,
        active: tab.isActive && group.isActive,
      })))
    case "config":
      await vscode.workspace.getConfiguration(op.section).update(op.key, op.value, vscode.ConfigurationTarget.Global)
      return null
    case "diagnostics":
      return vscode.languages.getDiagnostics(vscode.Uri.file(op.path)).map((d) => ({
        message: d.message,
        source: d.source ?? null,
        code: typeof d.code === "object" ? String(d.code.value) : d.code ?? null,
        severity: d.severity,
        range: [d.range.start.line, d.range.start.character, d.range.end.line, d.range.end.character],
      }))
    case "done":
      return null
  }
}

export async function run(): Promise<void> {
  if (!control) throw new Error("FRIZZ_E2E_AGENT is not set: this runs under scripts/e2e-sidebar.ts")
  const extension = vscode.extensions.getExtension<FrizzExtensionApi>("ssalbdivad.frizz-vscode")
  if (!extension) throw new Error("the extension under test is not installed")
  const api = await extension.activate()
  console.log(`frizz e2e agent: ${vscode.env.appName} ${vscode.version}, asking ${control}`)
  let seq = 0
  for (;;) {
    let next: { seq: number; op: AgentOp } | undefined
    try {
      const response = await fetch(`${control}/next?after=${seq}`)
      if (response.status === 204) continue
      next = (await response.json()) as { seq: number; op: AgentOp }
    } catch (error) {
      // The harness went away: nothing more will be asked.
      console.log(`frizz e2e agent: the harness is gone (${(error as Error).message})`)
      return
    }
    seq = next.seq
    let answer: { ok: true; value: unknown } | { ok: false; error: string }
    try {
      answer = { ok: true, value: await perform(api, next.op) }
    } catch (error) {
      answer = { ok: false, error: (error as Error).stack ?? String(error) }
    }
    await fetch(`${control}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ seq, ...answer }) }).catch(() => undefined)
    if (next.op.op === "done") return
  }
}
