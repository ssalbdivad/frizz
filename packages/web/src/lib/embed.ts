import {
  EDITOR_COMPOSE_MAX_TEXT,
  EDITOR_MAX_PATH,
  EMBED_PARAM,
  EMBED_PROTOCOL_VERSION,
  EMBED_MAX_NOTE,
  EMBED_MAX_OPEN_FILES,
  EMBED_THEME_PARAM,
  EMBED_VSCODE,
  type EmbedCommandMessage,
  type EmbedEditorFile,
  type EmbedHostMessage,
  type EmbedKeyMessage,
  type EmbedPageMessage,
  type EmbedTheme,
} from "@frizz/shared"

// THE PAGE INSIDE AN EDITOR'S SIDEBAR — embed mode's state and its wire (packages/shared/src/
// embed-protocol.ts is the contract; plans/vscode-extension.md § The sidebar the design). The VS Code
// extension frames this very page at `?embed=vscode&theme=<light|dark>&project=<slug>`, and the page
// then behaves as a resident of that editor rather than of a browser: the desktop's left column at any
// width (components/SidebarPage.tsx; never the phone's page, lib/mobile.ts), VS Code's theme (lib/theme.ts), code files and web links handed out to the editor
// (lib/local-file-links.ts, lib/external-links.ts), and selections handed in (lib/embedHost.ts).
//
// READ ONCE, KEPT FOR THE SESSION. The query is on the frame's FIRST address only: the first in-app
// navigation (a drawer, a project) replaces it, and a reload of the frame then lands on an address with
// no `embed` in it. So the boot read writes what it found to sessionStorage — the frame's own, which is
// partitioned from every browser tab's — and every later boot of this frame reads it back from there.
// index.html's pre-paint guard reads the same record, under the same key, so the first frame is already
// in the right theme; keep the two readers in step.
//
// This module is the state and the pure halves, with no app imports, so the theme module, the layout
// hook and the link interceptors can all ask `embedded()` without an import cycle through the store.

const SESSION_KEY = "frizz.embed"

export interface EmbedState {
  /** The host framing this page; the only one there is. */
  host: typeof EMBED_VSCODE
  /** The host's theme kind, overriding the stored preference for this session only. */
  theme?: EmbedTheme
}

function parseTheme(value: unknown): EmbedTheme | undefined {
  return value === "light" || value === "dark" ? value : undefined
}

/**
 * Embed mode from the frame's first address, else from this frame's session record, else none. An
 * address that names the mode WINS over the record, theme included: it is the extension's latest word
 * (a re-created webview frames the page afresh with VS Code's theme of that moment). Pure, for its test.
 */
export function readEmbedState(search: string, stored: string | null): EmbedState | null {
  const params = new URLSearchParams(search)
  if (params.get(EMBED_PARAM) === EMBED_VSCODE) {
    const theme = parseTheme(params.get(EMBED_THEME_PARAM))
    return theme ? { host: EMBED_VSCODE, theme } : { host: EMBED_VSCODE }
  }
  if (!stored) return null
  try {
    const parsed: unknown = JSON.parse(stored)
    if (!parsed || typeof parsed !== "object" || (parsed as { host?: unknown }).host !== EMBED_VSCODE) return null
    const theme = parseTheme((parsed as { theme?: unknown }).theme)
    return theme ? { host: EMBED_VSCODE, theme } : { host: EMBED_VSCODE }
  } catch {
    return null
  }
}

let state: EmbedState | null | undefined

function load(): EmbedState | null {
  if (state !== undefined) return state
  if (typeof window === "undefined") return (state = null)
  let stored: string | null = null
  try { stored = sessionStorage.getItem(SESSION_KEY) } catch {}
  state = readEmbedState(typeof location === "undefined" ? "" : location.search, stored)
  if (state) save(state)
  return state
}

function save(next: EmbedState): void {
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(next)) } catch {}
}

/** Is this page framed by an editor's sidebar? Fixed for the page's life. */
export function embedded(): boolean {
  return load() !== null
}

/** The host's theme for this session, when it named one. */
export function embedTheme(): EmbedTheme | undefined {
  return load()?.theme
}

/** A `frizz:theme` from the host: kept for a reload of this frame, never in localStorage. */
export function rememberEmbedTheme(theme: EmbedTheme): void {
  const current = load()
  if (!current) return
  state = { ...current, theme }
  save(state)
}

/**
 * Tell the host something. `"*"` as the target origin, because the parent is a `vscode-webview://`
 * document whose origin the page cannot know in advance — and nothing a page → host message carries is
 * private: a path the page already rendered, a web address, a key chord, an id the host minted.
 */
export function postToHost(message: EmbedPageMessage): void {
  if (!embedded() || typeof window === "undefined" || window.parent === window) return
  window.parent.postMessage(message, "*")
}

export const EMBED_READY: EmbedPageMessage = { type: "frizz:ready", v: EMBED_PROTOCOL_VERSION }

/**
 * Where to run a command the page asks the human to run "in a terminal" (sign-in, `gh auth login`): in
 * the sidebar, VS Code's own, one chord away — forwarded by the page (embedKeys.ts HOST_CHORDS). Ctrl on
 * a Mac too, as VS Code binds it.
 */
export function hostTerminalHint(mac: boolean): string {
  return `${mac ? "⌃`" : "Ctrl+`"} opens VS Code's terminal.`
}

// ── host → page: each shape checked against the contract, anything else dropped ─────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function optionalLine(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) >= 1)
}

function nonEmpty(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
}

/**
 * A host message, if `data` is exactly one the contract defines, else null. The relay already checks
 * where a message came from; this checks what it says, since a frame that trusted any `type` it was
 * handed would put whatever text arrived into a prompt box. Unknown types are ignored, not answered: a
 * newer extension may speak a message this page predates.
 */
export function parseHostMessage(data: unknown): EmbedHostMessage | null {
  if (!isRecord(data)) return null
  if (data.type === "frizz:theme") {
    const theme = parseTheme(data.theme)
    return theme ? { type: "frizz:theme", theme } : null
  }
  if (data.type === "frizz:navigate") {
    const to = data.to
    if (to === "queue") return { type: "frizz:navigate", to }
    if (!isRecord(to) || !nonEmpty(to.project, 200)) return null
    if (to.thread === undefined) return { type: "frizz:navigate", to: { project: to.project } }
    return nonEmpty(to.thread, 200) ? { type: "frizz:navigate", to: { thread: to.thread, project: to.project } } : null
  }
  if (data.type === "frizz:compose") {
    const { id, item, target, focus } = data
    if (!nonEmpty(id, 200) || typeof focus !== "boolean" || !isRecord(item)) return null
    if (!nonEmpty(item.path, EDITOR_MAX_PATH) || typeof item.app !== "string") return null
    if (item.text !== undefined && (typeof item.text !== "string" || item.text.length > EDITOR_COMPOSE_MAX_TEXT)) return null
    if (item.projectId !== undefined && !nonEmpty(item.projectId, 200)) return null
    if (!optionalLine(item.startLine) || !optionalLine(item.endLine)) return null
    const { note } = data
    if (note !== undefined && (typeof note !== "string" || note.length > EMBED_MAX_NOTE)) return null
    let to: Extract<EmbedHostMessage, { type: "frizz:compose" }>["target"]
    if (target === "front" || target === "new") to = target
    else if (isRecord(target) && nonEmpty(target.thread, 200) && nonEmpty(target.project, 200)) to = { thread: target.thread, project: target.project }
    else return null
    return {
      type: "frizz:compose",
      id,
      item: {
        path: item.path,
        app: item.app,
        ...(item.text !== undefined ? { text: item.text as string } : {}),
        ...(item.projectId !== undefined ? { projectId: item.projectId as string } : {}),
        ...(item.startLine !== undefined ? { startLine: item.startLine as number } : {}),
        ...(item.endLine !== undefined ? { endLine: item.endLine as number } : {}),
      },
      target: to,
      focus,
      ...(note ? { note: note.replace(/\s+/g, " ") } : {}),
    }
  }
  if (data.type === "frizz:editor-context") {
    const { active, open } = data
    if (!Array.isArray(open) || open.length > EMBED_MAX_OPEN_FILES) return null
    const files: EmbedEditorFile[] = []
    for (const entry of open) {
      const file = editorFile(entry)
      if (!file) return null
      files.push(file)
    }
    if (active === null) return { type: "frizz:editor-context", active: null, open: files }
    const file = editorFile(active)
    if (!file || !isRecord(active)) return null
    const { selection } = active
    if (selection === undefined) return { type: "frizz:editor-context", active: file, open: files }
    if (!isRecord(selection)) return null
    const { startLine, endLine, chars } = selection
    if (startLine === undefined || endLine === undefined || !optionalLine(startLine) || !optionalLine(endLine) || (endLine as number) < (startLine as number)) return null
    if (!Number.isSafeInteger(chars) || (chars as number) < 1) return null
    return {
      type: "frizz:editor-context",
      active: { ...file, selection: { startLine: startLine as number, endLine: endLine as number, chars: chars as number } },
      open: files,
    }
  }
  if (data.type === "frizz:command") {
    const { command } = data
    return HOST_COMMANDS.has(command as EmbedCommandMessage["command"]) ? { type: "frizz:command", command: command as EmbedCommandMessage["command"] } : null
  }
  return null
}

const HOST_COMMANDS = new Set<EmbedCommandMessage["command"]>(["new-thread", "queue", "jump", "settings"])

/** One open file of a `frizz:editor-context`, with only the contract's fields, or null. */
function editorFile(value: unknown): EmbedEditorFile | null {
  if (!isRecord(value) || !nonEmpty(value.path, EDITOR_MAX_PATH) || !nonEmpty(value.label, EDITOR_MAX_PATH)) return null
  if (value.projectId !== undefined && !nonEmpty(value.projectId, 200)) return null
  return { path: value.path, label: value.label, ...(value.projectId !== undefined ? { projectId: value.projectId as string } : {}) }
}

// ── page → host: the key chords ─────────────────────────────────────────────────────────────────────

/**
 * The chords a text box handles natively, as EXACT chords: copy, cut, paste, undo, redo, select all and
 * Ctrl+Insert (copy) without Shift; with it, only redo (⌘⇧Z) and paste as plain text (⌘⇧V). Exact,
 * because the key alone cannot tell them from VS Code's: Extensions is ⌘⇧X, whose `key` is "X", and a
 * filter that case-folded every key read it as cut and never forwarded it (sweep 2026-10-01).
 */
const EDITING_KEYS = new Set(["c", "x", "v", "z", "y", "a", "insert"])
const SHIFTED_EDITING_KEYS = new Set(["z", "v"])
const MODIFIER_KEYS = new Set(["Control", "Meta", "Shift", "Alt", "AltGraph", "CapsLock", "Fn", "OS"])

type KeyLike = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "defaultPrevented" | "repeat" | "isComposing">

function editingChord(event: KeyLike): boolean {
  const key = event.key.toLowerCase()
  return event.shiftKey ? SHIFTED_EDITING_KEYS.has(key) : EDITING_KEYS.has(key)
}

/**
 * The `frizz:key` for a keydown, or null when it is not the host's: no Ctrl or Cmd held, a page handler
 * already took it, a bare modifier, an auto-repeat (holding ⌘⇧P must not open the palette forty times),
 * mid-IME composition, or an editing chord (above). Nothing is prevented here: a chord the host ignores
 * (Ctrl+← in a text box, Ctrl+Shift+C) must still do what it does natively.
 */
export function hostKeyChord(event: KeyLike): EmbedKeyMessage | null {
  if (!(event.ctrlKey || event.metaKey) || event.defaultPrevented || event.repeat || event.isComposing) return null
  if (MODIFIER_KEYS.has(event.key) || editingChord(event)) return null
  return { type: "frizz:key", key: event.key, code: event.code, ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey, alt: event.altKey }
}
