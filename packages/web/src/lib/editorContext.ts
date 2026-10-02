import type { EmbedEditorContextMessage } from "@frizz/shared"
import { proxy, useSnapshot } from "valtio"
import { contextChipLabel } from "./composerContext.ts"
import { postToHost } from "./embed.ts"
import { formatChord, type Chord, type Platform } from "./keybindings.ts"
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
 * The editor's chord for "add the selection to the sidebar's prompt", as the page advertises it: ⌘L on a
 * Mac, Ctrl+L elsewhere — Cursor's "add selection to chat", the chord a human coming from Cursor already
 * has in their fingers (maintainer 2026-10-02: "there is a standard shortcut for adding a pill for
 * highlighted snippet to a message"). The extension binds it in the editor while text is selected, beside
 * the app's own ⌘I (FileViewerPanel's staging chord, still bound) and Claude Code's ⌥K (the selection, or
 * the whole file with none). One chord is named, the one most people know; the `?` sheet lists all three
 * (lib/embedKeys.ts EDITOR_CHORDS). Spelled by the app's keycap formatter so it reads like every other
 * shortcut.
 */
export const EDITOR_ADD_CHORD: Chord = { key: "l", mod: true, alt: false, shift: false }

export function editorAddChord(platform: Platform): string {
  return formatChord(EDITOR_ADD_CHORD, platform)
}

/**
 * The keydown is ⌘L / Ctrl+L — on a Mac ⌘ and not Ctrl, elsewhere Ctrl and not ⌘, so ⌃L on a Mac (the
 * terminal's clear-screen) is left alone. ⌘L is a browser chord (keybindings.ts BROWSER_CHORDS), so no
 * rebind can claim it from under this.
 */
export function isEditorAddKey(event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "repeat" | "isComposing">, platform: Platform): boolean {
  if (event.altKey || event.shiftKey || event.repeat || event.isComposing) return false
  const primary = platform === "mac" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  return primary && (event.key.toLowerCase() === "l" || event.code === "KeyL")
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

/** What a press of the bar adds, from what the editor has in front: its selection, else the whole file. */
export function barAdd(active: EditorContextState["active"]): { what: "selection" } | { what: "file"; path: string } | null {
  if (!active) return null
  return active.selection ? { what: "selection" } : { what: "file", path: active.path }
}

// ── ⌘I in the sidebar: the bar's press, from the keyboard ─────────────────────────────────────────

// The bars on screen, each by its strip (EditorContextBar.tsx registers it), so a key can find the bar of
// the box it was typed in. The strip sits in its composer's own box (Composer `header`), so the composer
// is the strip's parent.
const bars = new Map<HTMLElement, ContextBox>()

export function registerContextBar(strip: HTMLElement, box: ContextBox): () => void {
  bars.set(strip, box)
  return () => {
    if (bars.get(strip) === box) bars.delete(strip)
  }
}

/**
 * ⌘I / Ctrl+I IN THE SIDEBAR does what the editor's ⌘I does — puts the code in front into the prompt — so
 * one chord means one thing on both sides of the frame, as in Cursor (plans/vscode-extension.md § The
 * editor in the sidebar). Typed in a prompt box that shows a context bar it is a press of that bar: the
 * selection, else the file in front, as a chip in THAT box. With no drawer up, and the caret in no such
 * box, it goes into the page's new-thread box (the New thread dialog's, while that is up). Anywhere else —
 * a thread open and the caret outside its reply box — it is not this key's, and Thread details keeps it
 * (App.tsx), as in the browser.
 *
 * "added" when a request went to the editor; "nothing" when the key was this one's but the editor has no
 * file in front to add; null when it is not this key's.
 */
export function addEditorContextByKey(focused: Element | null, drawerOpen: boolean, dialogOpen: boolean): "added" | "nothing" | null {
  const typedIn = focused instanceof HTMLTextAreaElement ? [...bars].find(([strip]) => strip.parentElement?.contains(focused)) : undefined
  let box = typedIn?.[1]
  if (!box) {
    if (drawerOpen && !dialogOpen) return null
    const inDialog = (strip: HTMLElement) => strip.closest('[role="dialog"]:not([data-drawer-layer])') !== null
    box = [...bars].find(([strip, candidate]) => candidate.surface === "newComposer" && inDialog(strip) === dialogOpen)?.[1]
    // No bar on the box: the editor has nothing open to offer it (the bar draws nothing then).
    if (!box) return "nothing"
  }
  const what = barAdd(editorContext.active)
  if (!what) return "nothing"
  requestEditorContext(box, what)
  return "added"
}

/**
 * ⌘L / Ctrl+L IN THE SIDEBAR — the chord the page advertises for the editor (`editorAddChord`), pressed with
 * the keyboard in the page instead: what ⌘I does here, so the chord the hint names works on both sides of
 * the frame. Except where ⌘I gives way to Thread details (a thread open, the caret outside its reply box):
 * ⌘L has no other meaning to give way to, so it does what the editor's chord does there — the request goes
 * out with no box remembered, the host answers "front", and the chip lands in the open thread's reply box.
 */
export function addEditorContextByChord(focused: Element | null, drawerOpen: boolean, dialogOpen: boolean): "added" | "nothing" {
  const byKey = addEditorContextByKey(focused, drawerOpen, dialogOpen)
  if (byKey) return byKey
  const what = barAdd(editorContext.active)
  if (!what) return "nothing"
  pending = null
  postToHost({ type: "frizz:add-context", ...what })
  return "added"
}
