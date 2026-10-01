// THE EDITOR, AS THE SIDEBAR SEES IT — the pure half of what the extension tells the Frizz sidebar about
// the editor around it (`frizz:editor-context`: the file in front, its selection, the other open files) and
// of the ways a piece of the editor gets into the sidebar's prompt (a problem's quick fix, a terminal
// selection). No `vscode` here, so every rule is a unit test under plain node (editor-context.test.ts);
// context-feed.ts and app.ts are the glue. Design: plans/vscode-extension.md § The editor in the sidebar;
// the wire: packages/shared/src/embed-protocol.ts.

import { basename, isAbsolute } from "node:path"
import { EDITOR_MAX_PATH } from "@frizz/shared/editor-protocol"
import { EMBED_MAX_NOTE, EMBED_MAX_OPEN_FILES, type EmbedEditorContextMessage, type EmbedEditorFile, type EmbedEditorSelection } from "@frizz/shared/embed-protocol"
import { composable, normalizeNewlines } from "./message.ts"

/** A position as VS Code holds one: 0-based line and character. */
export interface Position {
  line: number
  character: number
}

/**
 * The 1-based, inclusive lines a range covers, as the chip it would make reads them. A range that ends at
 * column 1 of a line — a whole-line drag, shift+down — does not include that line: the caret sits at its
 * start and nothing of it is selected. The context bar, "Add to Frizz prompt" and the quick fix all count
 * lines with this, so the bar never promises a range the chip then disagrees with.
 */
export function lineSpan(start: Position, end: Position): { startLine: number; endLine: number } {
  const endLine = end.character === 0 && end.line > start.line ? end.line : end.line + 1
  return { startLine: start.line + 1, endLine }
}

/**
 * What the context bar says is selected: the PRIMARY selection's lines — the one a chip would carry — and
 * the characters selected across every selection (multi-cursor counts each). Undefined when the primary
 * selection is empty: a caret is not a selection, and the bar then names the file alone. `chars` is the
 * editor's own count (offset of the end less offset of the start), never the text: the text crosses only
 * when the human adds it.
 */
export function editorSelection(selections: readonly { start: Position; end: Position; chars: number }[]): EmbedEditorSelection | undefined {
  const primary = selections[0]
  if (!primary || primary.chars <= 0) return undefined
  const chars = selections.reduce((sum, selection) => sum + Math.max(0, selection.chars), 0)
  return { ...lineSpan(primary.start, primary.end), chars }
}

/**
 * The label the bar shows for a file: `workspace.asRelativePath`'s answer, or the basename when that is
 * not relative — asRelativePath hands its input back unchanged for a file no workspace folder holds. Never
 * empty (the page refuses an empty label, and with it the whole message).
 */
export function fileLabel(path: string, relative: string): string {
  if (!relative || relative === path || isAbsolute(relative) || /^[A-Za-z]:[\\/]/u.test(relative)) return basename(path) || path
  return relative
}

/**
 * Which files were in front most recently. VS Code's tab model has no activation order — `tabGroups`
 * lists tabs left to right — so the extension keeps its own: every time a file becomes the active editor
 * it moves to the front. A file never seen in front (open since before activation, in a group never
 * focused) sorts after every seen one, in tab order.
 */
export class Recency {
  readonly #order: string[] = []

  constructor(readonly limit = 500) {}

  touch(path: string): void {
    const at = this.#order.indexOf(path)
    if (at === 0) return
    if (at > 0) this.#order.splice(at, 1)
    this.#order.unshift(path)
    if (this.#order.length > this.limit) this.#order.length = this.limit
  }

  /** `paths` most recently in front first; stable among the never-seen. */
  sort(paths: readonly string[]): string[] {
    const rank = (path: string) => {
      const at = this.#order.indexOf(path)
      return at === -1 ? Number.MAX_SAFE_INTEGER : at
    }
    return paths.map((path, index) => ({ path, index, rank: rank(path) })).sort((a, b) => a.rank - b.rank || a.index - b.index).map(({ path }) => path)
  }
}

/** A path the page can take: present, and within the editor wire's ceiling (the page refuses the whole message over one that is not). */
const sendable = (path: string) => path.length > 0 && path.length <= EDITOR_MAX_PATH

/**
 * The OTHER files open in tabs, as the bar lists them: each file once however many groups show it, never
 * the file in front, most recently in front first, at most EMBED_MAX_OPEN_FILES — chosen BEFORE each is
 * described (matched to a project, labelled), which is the expensive part with fifty tabs open.
 */
export function openFiles(tabs: readonly string[], active: string | undefined, recency: Recency): string[] {
  const seen = new Set<string>(active === undefined ? [] : [active])
  const unique: string[] = []
  for (const path of tabs) {
    if (seen.has(path) || !sendable(path)) continue
    seen.add(path)
    unique.push(path)
  }
  return recency.sort(unique).slice(0, EMBED_MAX_OPEN_FILES)
}

/** The message, with every file in the contract's shape: a label clipped to the ceiling, a projectId only when one matched. */
export function editorContextMessage(active: (EmbedEditorFile & { selection?: EmbedEditorSelection }) | null, open: readonly EmbedEditorFile[]): EmbedEditorContextMessage {
  const file = ({ path, label, projectId }: EmbedEditorFile): EmbedEditorFile => ({ path, label: label.slice(0, EDITOR_MAX_PATH), ...(projectId ? { projectId } : {}) })
  return {
    type: "frizz:editor-context",
    active: active && sendable(active.path) ? { ...file(active), ...(active.selection ? { selection: active.selection } : {}) } : null,
    open: open.filter((entry) => sendable(entry.path)).slice(0, EMBED_MAX_OPEN_FILES).map(file),
  }
}

// ── "Ask Frizz to fix" ─────────────────────────────────────────────────────────────────────────────

/** What a quick fix knows of a problem (vscode.Diagnostic, with `code` as the API spells it). */
export interface Problem {
  message: string
  source?: string
  code?: string | number | { value: string | number }
}

const oneLine = (text: string) => text.replace(/\s+/gu, " ").trim()

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}

/**
 * The prose after the chip: `Fix: Cannot find name 'foo'. ts(2304)` — the problem as the Problems panel
 * spells it (message, then `source(code)`), so the box reads as a request the human can send as is or
 * edit. A missing source or code is left out rather than written empty; one line, at most EMBED_MAX_NOTE.
 */
export function fixNote(problem: Problem): string {
  const code = typeof problem.code === "object" ? problem.code.value : problem.code
  const source = problem.source ? oneLine(problem.source) : ""
  const tag = code === undefined || code === "" ? source : `${source}(${oneLine(String(code))})`
  return clip(oneLine(["Fix:", oneLine(problem.message), tag].filter(Boolean).join(" ")), EMBED_MAX_NOTE)
}

/**
 * The quick fix's title. One problem under the caret is "Ask Frizz to fix"; several each get their own
 * entry, told apart by the start of their message — a list of identical titles would make the human
 * guess which problem each one sends.
 */
export function fixTitle(problem: Problem, several: boolean): string {
  return several ? `Ask Frizz to fix: ${clip(oneLine(problem.message), 60)}` : "Ask Frizz to fix"
}

// ── the terminal ───────────────────────────────────────────────────────────────────────────────────

/**
 * A terminal selection as a compose item's text, or why it cannot be one. A file selection too large to
 * carry still has a place to point at (a range reference); a terminal's has nowhere, so past the same
 * ceilings as a file's quote — QUOTE_MAX_LINES, QUOTE_MAX_BYTES, the frame — it is refused, with copy
 * that says what to do.
 */
export function terminalText(raw: string): { ok: true; text: string } | { ok: false; why: string } {
  const text = normalizeNewlines(raw).replace(/\s+$/u, "")
  if (!text.trim()) return { ok: false, why: "Select text in the terminal to add it to Frizz's prompt box." }
  const lines = text.split("\n").length
  if (!composable({ text, startLine: 1, endLine: lines })) return { ok: false, why: "That terminal selection is too long to add. Select less of it." }
  return { ok: true, text }
}
