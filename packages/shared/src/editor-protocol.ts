// THE EDITOR BRIDGE — the wire between Frizz and an editor extension (packages/vscode) running in a
// VS Code, Cursor or Windsurf window. Design and rationale: plans/vscode-extension.md.
//
// One WebSocket per editor WINDOW, opened BY the extension to the one machine-wide endpoint
// `/_frizz/editor` (never per project: a window's folders can span several projects, and the server
// is a singleton). Over it the extension says which folders it has open and whether it has focus;
// the server sends it files to open and folders to raise, and the projects its folders belong to with
// their queue counts. Everything else the extension does — dispatching a thread, a follow-up — goes
// through the ordinary RPC surface, like any other client.
//
// Pure types and constants, no zod: the extension bundles this module and must not drag the shared
// index in. The zod schemas the SERVER validates frames with live beside ServerEvent in index.ts, and
// are pinned assignable to these types there.

import type { FilePosition } from "./file-position.ts"

/** The machine-wide editor socket. Never project-prefixed; the server answers it before tenant routing. */
export const EDITOR_SOCKET_PATH = "/_frizz/editor"
export const EDITOR_PROTOCOL_VERSION = 1

/** Close codes the server uses beyond the standard ones, so the extension can say why it was dropped. */
export const EDITOR_CLOSE = {
  /** The hello's `v` is not one this server speaks. The extension should say "update Frizz or the extension". */
  unsupportedVersion: 4400,
  /** A frame failed validation. */
  invalidMessage: 4401,
  /** The first frame was not a hello. */
  helloRequired: 4402,
} as const

/** Which editor family a window is — what the "External app" setting's choices name. */
export type EditorKind = "vscode" | "cursor" | "windsurf" | "other"

/** `vscode.env.appName` → the family. "Visual Studio Code", "Visual Studio Code - Insiders", "Cursor", "Windsurf", "VSCodium"… */
export function editorKindOf(appName: string): EditorKind {
  if (/cursor/i.test(appName)) return "cursor"
  if (/windsurf/i.test(appName)) return "windsurf"
  if (/visual studio code/i.test(appName)) return "vscode"
  return "other"
}

/** A selection (or a whole file) the human sends to Frizz's prompt box from the editor. */
export interface EditorComposeInput {
  /** The project the file belongs to, as the extension matched it; the page's fallback target. */
  projectId?: string
  /** Absolute path, in the server's filesystem terms (the extension runs where the files are). */
  path: string
  /** The selected text. Absent: a reference to the whole file (or to `startLine` alone). */
  text?: string
  startLine?: number
  endLine?: number
}

/** A compose input the server is holding until a Frizz page claims it (`composeTake`). */
export interface EditorComposeItem extends EditorComposeInput {
  id: string
  /** The sending window's app name, for copy ("From VS Code"). */
  app: string
  /** ISO time the server accepted it. */
  at: string
}

// ── extension → server ─────────────────────────────────────────────────────────────────────────────

export interface EditorHello {
  t: "hello"
  v: typeof EDITOR_PROTOCOL_VERSION
  /** Stable for the life of the window (a uuid the extension mints at activation). */
  windowId: string
  /** `vscode.env.appName`. */
  app: string
  /** The extension's own version, for the log. */
  extensionVersion: string
  /** Absolute paths of the window's `file`-scheme workspace folders, as the extension host sees them. */
  folders: string[]
  /** Whether this window has OS focus right now (`vscode.window.state.focused`). */
  focused: boolean
  /** Whether this window takes file opens from Frizz (the extension's `frizz.openFileLinks` setting). */
  acceptsOpens: boolean
  /** `os.homedir()` and `process.platform` of the extension host — how the server tells a window that shares its filesystem. */
  home: string
  platform: string
}

/** Anything in the hello that can change later: sent whole, on every change. */
export interface EditorState {
  t: "state"
  folders: string[]
  focused: boolean
  acceptsOpens: boolean
}

/** The answer to an `open` or `focus` request. */
export interface EditorResult {
  t: "result"
  id: string
  ok: boolean
  /** Why it failed, in words the page can toast. */
  error?: string
}

export interface EditorCompose {
  t: "compose"
  /** The extension's own nonce; echoed in `composed`. */
  id: string
  item: EditorComposeInput
}

export type EditorClientMessage = EditorHello | EditorState | EditorResult | EditorCompose

// ── server → extension ─────────────────────────────────────────────────────────────────────────────

export interface EditorWelcome {
  t: "welcome"
  v: typeof EDITOR_PROTOCOL_VERSION
  bootId: string
}

/** Open a file and reveal the position; raise the window. Answer with `result`. */
export interface EditorOpen extends Partial<FilePosition> {
  t: "open"
  id: string
  path: string
}

/** Raise this window — it has `path` open as a workspace folder. Answer with `result`. */
export interface EditorFocus {
  t: "focus"
  id: string
  path: string
}

export interface EditorComposed {
  t: "composed"
  id: string
  ok: boolean
  error?: string
}

/** One Frizz project, for the extension to map files to and to show counts for. */
export interface EditorProject {
  id: string
  slug: string
  name: string
  /** The folder its agents run in (`workDirOf`): the project folder, or Home's folder. */
  dir: string
  home?: true
  /** Present only while the project is open on the server: its queue (Ready) and spinning (Working) counts. */
  ready?: number
  working?: number
}

/** Every registered project (and Home), pushed on connect and whenever any of it changes. */
export interface EditorProjects {
  t: "projects"
  projects: EditorProject[]
}

export interface EditorHeartbeat {
  t: "hb"
}

export type EditorServerMessage = EditorWelcome | EditorOpen | EditorFocus | EditorComposed | EditorProjects | EditorHeartbeat

/** What a Frizz page knows about connected editor windows (`editorWindows`, and the `editors` event). */
export interface EditorWindowSummary {
  app: string
  kind: EditorKind
  /** False when the window turned file opens off. */
  acceptsOpens: boolean
}
