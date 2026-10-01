// WHAT THE EDITOR SENDS AS A MESSAGE — a question about a selection, written exactly as the page's ⌘I
// flow writes one (packages/web/src/lib/composerContext.ts `buildMessageWithContext`), so the transcript
// renders the reference as a chip with the quote behind it instead of a wall of `>` lines:
//
//   @a.ts:12-20 why does this loop twice?
//
//   Selected context:
//
//   @a.ts:12-20 (src/a.ts, lines 12-20):
//   > for (const x of xs) {
//   > …
//
// The token is the chip's label behind an `@` (`basename:line` or `basename:start-end`); it opens the
// prose, where the human's question then reads as being about it, and it heads the definition. The
// path in the parenthesis is relative to the project folder when the file is inside it, absolute
// otherwise — the agent runs in that folder. message.test.ts runs the page's own `parseSentContext`
// over this output, so the two cannot drift apart silently.
//
// With no selection there is nothing to quote, and a reference is the honest form: `` `src/a.ts:42` ``
// (the cursor's line, when the ask came from an editor) ahead of the question. The same applies to a
// selection too large to quote — past QUOTE_MAX_LINES lines or QUOTE_MAX_BYTES — which becomes a
// reference to its range: the agent can read the file, and a 2 MB prompt helps nobody.

import { basename } from "node:path"
import { formatFileReference } from "@frizz/shared/file-position"

export const QUOTE_MAX_LINES = 400
export const QUOTE_MAX_BYTES = 32 * 1024

export interface Selected {
  /** The selected text, verbatim. */
  text: string
  /** 1-based, inclusive. */
  startLine: number
  endLine: number
}

export interface FileRef {
  /** Absolute path (the spelling that matched the project). */
  path: string
  /** Project-relative when inside the project's folder, else the absolute path. */
  display: string
  selection?: Selected
  /** 1-based cursor line, for an ask from an editor with nothing selected. */
  cursorLine?: number
}

/** Line endings as the page writes them: the transcript splits on `\n`, and a stray `\r` is noise. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/gu, "\n")
}

/** A selection worth quoting: not blank, and within the caps. */
export function quotable(selection: Selected | undefined): selection is Selected {
  if (!selection || !selection.text.trim()) return false
  const lines = selection.endLine - selection.startLine + 1
  return lines <= QUOTE_MAX_LINES && Buffer.byteLength(selection.text, "utf8") <= QUOTE_MAX_BYTES
}

/** `a.ts:12` / `a.ts:12-20` — the chip label, `contextChipLabel` in the page. */
export function chipLabel(path: string, startLine: number, endLine: number): string {
  const base = basename(path) || path
  return startLine === endLine ? `${base}:${startLine}` : `${base}:${startLine}-${endLine}`
}

/** What the reference reads as in a prompt: `a.ts:12-20`, `a.ts:42`, `a.ts`. */
export function refLabel(ref: FileRef): string {
  const base = basename(ref.path) || ref.path
  if (ref.selection) return chipLabel(ref.path, ref.selection.startLine, ref.selection.endLine)
  return ref.cursorLine ? `${base}:${ref.cursorLine}` : base
}

/** The plain reference: `src/a.ts:12-20`, `src/a.ts:42`, `src/a.ts`. */
export function plainReference(ref: FileRef): string {
  if (ref.selection) return formatFileReference(ref.display, { line: ref.selection.startLine, endLine: ref.selection.endLine })
  return ref.cursorLine ? formatFileReference(ref.display, { line: ref.cursorLine }) : ref.display
}

function lineLabel(selection: Selected): string {
  return selection.startLine === selection.endLine ? `, line ${selection.startLine}` : `, lines ${selection.startLine}-${selection.endLine}`
}

/** The message for a question (possibly empty) about a file reference. */
export function composeMessage(question: string, ref: FileRef): string {
  const prose = normalizeNewlines(question).trim()
  if (quotable(ref.selection)) {
    const selection = ref.selection
    const token = `@${chipLabel(ref.path, selection.startLine, selection.endLine)}`
    const quoted = normalizeNewlines(selection.text).replace(/\s+$/u, "").split("\n").map((line) => `> ${line}`).join("\n")
    const body = prose ? `${token} ${prose}` : token
    return `${body}\n\nSelected context:\n\n${token} (${ref.display}${lineLabel(selection)}):\n${quoted}`
  }
  const reference = `\`${plainReference(ref)}\``
  return prose ? `${reference} ${prose}` : reference
}
