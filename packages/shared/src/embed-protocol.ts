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
//    what it knows (an unknown type is ignored, a URL that is not http(s) is refused, a key chord runs a
//    command only if the extension's own allowlist names it).
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
  item: EditorComposeInput & { app: string }
  target: "front" | "new" | { thread: string; project: string }
  focus: boolean
}

/** Show a thread (its drawer, full height), a project's queue, or this page's own queue view. */
export interface EmbedNavigateMessage {
  type: "frizz:navigate"
  to: { thread: string; project: string } | { project: string } | "queue"
}

export type EmbedHostMessage = EmbedThemeMessage | EmbedComposeMessage | EmbedNavigateMessage

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

/** A link to a web page (http or https only) — a VS Code webview cannot open a window, so the extension does (`env.openExternal`). */
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

export type EmbedPageMessage = EmbedReadyMessage | EmbedComposedMessage | EmbedOpenFileMessage | EmbedOpenExternalMessage | EmbedKeyMessage
