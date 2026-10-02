import type { EmbedEditorContextMessage } from "@frizz/shared"
import { proxy, useSnapshot } from "valtio"
import { contextChipLabel } from "./composerContext.ts"
import { postToHost } from "./embed.ts"
import { formatChord, type Platform } from "./keybindings.ts"
import { basename } from "./paths.ts"

// WHAT THE EDITOR AROUND THE SIDEBAR HAS OPEN — the latest `frizz:editor-context` (packages/shared/src/
// embed-protocol.ts), kept for the context bar over the sidebar's composers (components/
// EditorContextBar.tsx). Paths and line numbers only: the selected text crosses when the human adds it
// (`frizz:add-context`). Empty outside embed mode, where nothing ever writes it.

export interface EditorContextState {
  active: EmbedEditorContextMessage["active"]
  open: EmbedEditorContextMessage["open"]
}

export const editorContext = proxy<EditorContextState>({ active: null, open: [] })

/** A `frizz:editor-context` from the host replaces the last one whole. */
export function setEditorContext(message: EmbedEditorContextMessage): void {
  editorContext.active = message.active
  editorContext.open = message.open
}

export function useEditorContext(): EditorContextState {
  return useSnapshot(editorContext) as EditorContextState
}

// ── what the bar reads ────────────────────────────────────────────────────────────────────────────

export interface ContextBarReading {
  /** A selection is "highlighted code", drawn in the accent; a file alone is the dimmer suggestion. */
  kind: "selection" | "file"
  /** The basename, which truncates first at a narrow width. */
  name: string
  /** `:91-116` or `:91` — kept whole when the name truncates, since it is what makes the reading a range. */
  range: string
  /** `26 lines`, for a selection. */
  count?: string
  /** The workspace-relative path, for the hover. */
  where: string
}

/**
 * What the bar shows for the editor in front: its file, and the selection's range and size when there
 * is one. The label is the chip the click will make (`contextChipLabel`, the ⌘I token's label), split so
 * a long name can truncate without losing its range. Null when no text editor is in front.
 */
export function contextBarReading(active: EditorContextState["active"]): ContextBarReading | null {
  if (!active) return null
  const name = basename(active.label)
  const selection = active.selection
  if (!selection) return { kind: "file", name, range: "", where: active.label }
  const label = contextChipLabel({ display: active.label, startLine: selection.startLine, endLine: selection.endLine })
  const lines = selection.endLine - selection.startLine + 1
  return { kind: "selection", name, range: label.slice(name.length), count: `${lines} ${lines === 1 ? "line" : "lines"}`, where: active.label }
}

/**
 * The editor's own chord for "add the selection to the sidebar's prompt": ⌘I on a Mac, Ctrl+I
 * elsewhere — the app's ⌘I staging chord (FileViewerPanel), which the extension binds in the editor
 * while text is selected. Spelled by the app's keycap formatter so it reads like every other shortcut.
 */
export function editorAddChord(platform: Platform): string {
  return formatChord({ key: "i", mod: true, alt: false, shift: false }, platform)
}

// ── adding: a click on the bar, answered by the host's compose ────────────────────────────────────

/**
 * The prompt box a bar sits on — what its draft is keyed by (lib/drafts.ts), the directory its chips'
 * paths are shown relative to, and the textarea's `data-surface`, so the caret can be put back in it.
 */
export interface ContextBox {
  key: string
  projectDir: string | undefined
  surface: "chatComposer" | "newComposer"
}

/**
 * How long a click on a bar waits for the host's answer. The extension reads the selection and answers
 * at once; the window only has to outlast a busy extension host, and must not be so long that a ⌘I made
 * in the editor much later lands in a box the human clicked a while ago.
 */
export const ADD_CONTEXT_WINDOW_MS = 5_000

export interface PendingAdd {
  box: ContextBox
  at: number
}

let pending: PendingAdd | null = null

/**
 * Ask the host for the editor's selection, or a whole file, for THIS box. The host cannot say which box
 * — it answers every add with a compose aimed at "front" — so the page remembers which box asked, and
 * the answer goes there (`takePendingAdd`, lib/embedHost.ts). "Front" alone would usually agree, but not
 * always: the New thread sheet can be open over a thread's drawer, and a chip the human asked for in
 * one box must never land in another.
 */
export function requestEditorContext(box: ContextBox, what: { what: "selection" } | { what: "file"; path: string }): void {
  pending = { box, at: Date.now() }
  postToHost({ type: "frizz:add-context", ...what })
}

/** The box a "front" compose arriving now belongs to, if a bar asked within the window. Pure, for its test. */
export function pendingBox(record: PendingAdd | null, now: number): ContextBox | null {
  if (!record || now - record.at < 0 || now - record.at > ADD_CONTEXT_WINDOW_MS) return null
  return record.box
}

/** Claim the box a bar asked for — once: a later ⌘I in the editor goes to "front" as it always did. */
export function takePendingAdd(now = Date.now()): ContextBox | null {
  const box = pendingBox(pending, now)
  pending = null
  return box
}
