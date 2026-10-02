// THE SIDEBAR EMBED — the wire between the VS Code extension's Frizz sidebar (packages/vscode/src/sidebar.ts)
// and the real Frizz page it frames (packages/web/src/lib/embed.ts). Design and rationale:
// plans/vscode-extension.md § The sidebar.
//
// Three documents take part: the extension host (Node), the webview document VS Code serves from a
// `vscode-webview://` origin (a relay script and nothing else), and the Frizz page in an iframe of it,
// at the origin the extension discovered (`http://127.0.0.1:<port>`). The relay passes these messages
// through unchanged, in both directions, and checks where each one came from:
//
//  - page → host: the relay forwards only what arrives from ITS iframe (`event.source ===
//    frame.contentWindow`) at Frizz's origin; the extension validates the shape again and acts only on
//    what it knows (an unknown type is ignored, a URL that is not http(s) or mailto is refused, a key
//    chord runs a command only if the extension's own allowlist names it).
//  - host → page: the relay posts with `targetOrigin` = Frizz's origin, so selected code is never handed
//    to a document from anywhere else; the page accepts host messages only from `window.parent`.
//
// Nothing here goes through the Frizz server: a selection reaches the sidebar's composer directly, so the
// server's held-item path (`compose` → `composeTake`, claimed by whichever page has focus) stays what it is
// for browser tabs, and the sidebar never races a tab — or the human's own typing — for an item.
//
// Pure types and constants, no zod: the extension bundles this module, and so does the page.

import type { EditorComposeInput } from "./editor-protocol.ts"

/**
 * The query the extension puts on the frame's URL — `?embed=vscode&theme=dark&project=<slug>` — read ONCE
 * by the page at boot and kept for that page's session (in-app navigation drops the query).
 */
export const EMBED_PARAM = "embed"
export const EMBED_VSCODE = "vscode"
export const EMBED_THEME_PARAM = "theme"
export const EMBED_PROTOCOL_VERSION = 1

/** VS Code's theme kind, folded to the two the page has (high contrast dark → dark, high contrast light → light). */
export type EmbedTheme = "light" | "dark"

// ── host → page ────────────────────────────────────────────────────────────────────────────────────

/** VS Code's theme changed. The page applies it for this session only and never persists it. */
export interface EmbedThemeMessage {
  type: "frizz:theme"
  theme: EmbedTheme
}

/**
 * Put a selection in a composer, as the ⌘I context chip the browser's "Add to Frizz prompt" path inserts
 * (lib/editorCompose.ts), and answer with `frizz:composed`.
 *
 * `target`:
 *  - "front": the reply box of the thread the sidebar shows, else the new-thread box ("Add to Frizz prompt").
 *  - "new": the new-thread box, opened if it is not ("Ask Frizz…"). The chip's project is
 *    `item.projectId`'s when the extension matched one.
 *  - `{ thread, project }`: that thread's reply box, navigating to the thread first ("Send to Frizz thread…").
 *    `project` is the project's SLUG, as the page's routes spell it.
 *
 * `focus`: put the caret in that composer after the insert, because the human writes next (Ask, Send).
 * False leaves focus where it is — in the editor, where "Add to Frizz prompt" was run, so another selection
 * can follow. An insert never lands inside text being typed: it goes at a chip boundary of the box's value.
 */
export interface EmbedComposeMessage {
  type: "frizz:compose"
  /** The extension's own nonce, echoed in `frizz:composed`. */
  id: string
  /**
   * `path` is the file's absolute path — or `EMBED_TERMINAL_PATH` for text selected in VS Code's
   * terminal, which has no file: its chip reads `@terminal` and its definition `(terminal)`.
   */
  item: EditorComposeInput & { app: string }
  target: "front" | "new" | { thread: string; project: string }
  focus: boolean
  /**
   * Prose to put right after the chip, as if typed there — "Ask Frizz to fix" sends the problem's own
   * message (`Fix: Cannot find name 'foo'. ts(2304)`), so the box reads as a request rather than a bare
   * reference. Plain text, one line, at most `EMBED_MAX_NOTE` characters; the human can edit it before
   * sending like anything else in the box.
   */
  note?: string
}

/** The `path` of a terminal selection's compose item (see `EmbedComposeMessage.item`). */
export const EMBED_TERMINAL_PATH = "terminal"
export const EMBED_MAX_NOTE = 2000

/** Show a thread (its drawer, full height), a project's queue, or this page's own queue view. */
export interface EmbedNavigateMessage {
  type: "frizz:navigate"
  to: { thread: string; project: string } | { project: string } | "queue"
}

/** One file open in the editor, as the sidebar's context bar shows it. */
export interface EmbedEditorFile {
  /** Absolute path, in the server's filesystem terms. */
  path: string
  /** Workspace-relative path for display (`workspace.asRelativePath`), else the basename. */
  label: string
  /** The project it belongs to, when the extension matched one — the add's target, like a compose item's. */
  projectId?: string
}

/** A non-empty selection in the editor in front. Lines are 1-based and inclusive, as a chip's are. */
export interface EmbedEditorSelection {
  startLine: number
  /** A selection that ends at column 1 of a line ends on the line BEFORE it, as the chip it would make does. */
  endLine: number
  /** Characters selected, across every selection the editor holds (multi-cursor counts each). */
  chars: number
}

/**
 * THE EDITOR'S LIVE CONTEXT — what the sidebar's context bar shows: the file in front and its selection,
 * and the other files open in tabs. Sent after `frizz:ready` and again on every change (active editor,
 * selection — debounced, so a drag is not a message per pixel — and the tab set). Paths and line numbers
 * only, never the selected text: the text crosses only when the human adds it (`frizz:add-context`).
 */
export interface EmbedEditorContextMessage {
  type: "frizz:editor-context"
  /** The text editor in front, or null when none is (a terminal has focus with no editor beside it, a diff, nothing open). */
  active: (EmbedEditorFile & { selection?: EmbedEditorSelection }) | null
  /** Every OTHER file open in a tab, most recently active first, at most `EMBED_MAX_OPEN_FILES`. */
  open: EmbedEditorFile[]
}

export const EMBED_MAX_OPEN_FILES = 50

/**
 * A button in VS Code's own title row above the frame — the sidebar has no Frizz header of its own, so
 * the header's doors live there: a new thread, back to the queue, jump to a thread (⌘K), settings.
 */
export interface EmbedCommandMessage {
  type: "frizz:command"
  command: "new-thread" | "queue" | "jump" | "settings"
}

export type EmbedHostMessage = EmbedThemeMessage | EmbedComposeMessage | EmbedNavigateMessage | EmbedEditorContextMessage | EmbedCommandMessage

// ── page → host ────────────────────────────────────────────────────────────────────────────────────

/** The page booted in embed mode and listens. Until this arrives the extension does not post compose items to it. */
export interface EmbedReadyMessage {
  type: "frizz:ready"
  v: typeof EMBED_PROTOCOL_VERSION
}

/** The answer to `frizz:compose`. `error` is copy the extension can show as is. */
export interface EmbedComposedMessage {
  type: "frizz:composed"
  id: string
  ok: boolean
  error?: string
}

/**
 * A code file the human clicked in the sidebar (anything Frizz's reader would show as source — not
 * Markdown, not a picture, which still open in Frizz). It opens in THIS editor window, at the position,
 * whatever the External app setting says: the sidebar is inside the editor the human wants it in. The
 * path is absolute in the server's filesystem terms, which are the extension's (it runs where the files
 * are). The extension says so itself when the file is not there; the page shows nothing.
 */
export interface EmbedOpenFileMessage {
  type: "frizz:open-file"
  path: string
  line?: number
  column?: number
  endLine?: number
}

/**
 * A link to a web page (http or https), or a `mailto:` address — a VS Code webview cannot open a window,
 * so the extension does (`env.openExternal`, which hands a mailto to the mail app).
 */
export interface EmbedOpenExternalMessage {
  type: "frizz:open-external"
  url: string
}

/**
 * A key chord the page's own handlers left alone (not `defaultPrevented`), with Ctrl or Cmd held. While the
 * frame has focus VS Code's keybindings cannot see a key at all, so the page forwards these and the extension
 * runs the VS Code command its ALLOWLIST maps the chord to (the command palette, quick open, the sidebar and
 * panel toggles, focusing the editor); anything else is ignored. The page never forwards the editing chords
 * a text box handles natively — copy, cut, paste, undo, redo, select all.
 */
export interface EmbedKeyMessage {
  type: "frizz:key"
  /** `KeyboardEvent.key` and `.code`, as the page saw them. */
  key: string
  code: string
  ctrl: boolean
  meta: boolean
  shift: boolean
  alt: boolean
}

/**
 * Put the editor's context in the composer in front — a click on the context bar (the selection, or the
 * file in front when nothing is selected) or a pick from its open files. The page cannot do it alone: it
 * holds paths and line numbers, never the text. The host answers with a `frizz:compose` (target "front",
 * focus true) carrying the text as the editor has it at that moment, or with nothing when the file or
 * selection is gone.
 */
export interface EmbedAddContextMessage {
  type: "frizz:add-context"
  /** "selection": the editor in front's selection. "file": `path`, as a whole-file reference. */
  what: "selection" | "file"
  path?: string
}

/**
 * Where the page is — VS Code's title row above the frame carries it, since the sidebar draws no header
 * of its own. Sent on every change of view, and when the readings in it change.
 */
export interface EmbedRouteMessage {
  type: "frizz:route"
  /** Which title-row buttons apply: "thread" shows Back to queue, the others New thread. */
  view: "queue" | "thread" | "settings" | "other"
  /** The view's name, short: the thread's title, the queue's scope ("All projects", a project's name), "Settings". */
  title: string
  /** The reading beside it, e.g. `7 ready · 2 working`; absent says nothing. */
  description?: string
  /**
   * The page's address for what it shows, as a browser tab would open it — the frame's own address less
   * the embed switch and the theme (`http://127.0.0.1:9393/all/acme-api/thread/x`). ⋯ Open in browser opens
   * it, so a thread up in the sidebar opens as that thread. The extension keeps it only when it is on the
   * frame's own origin. Optional, so a page and an extension from before it work together: without it the
   * extension opens the window's project.
   */
  href?: string
}

export type EmbedPageMessage =
  | EmbedReadyMessage
  | EmbedComposedMessage
  | EmbedOpenFileMessage
  | EmbedOpenExternalMessage
  | EmbedKeyMessage
  | EmbedAddContextMessage
  | EmbedRouteMessage
