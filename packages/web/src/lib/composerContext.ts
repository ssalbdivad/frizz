// SELECTED CONTEXT for a thread's composer — the ⌘I flow. A selection made in the /full file viewer
// becomes a staged item (file, quoted text, best-effort line range, optional comment) ANCHORED BY A
// MENTION TOKEN — `@guide.md:3`, the chip's own label behind an `@` — spliced into the draft prose at
// the caret, and on send the items serialize as definitions under the prose, keyed by that same
// token. The token IS the chip: a <textarea> cannot host a pill, so the reference is text the human
// can read as-is, and the composer paints the pill behind it (Composer's backdrop). The first cut
// used footnote markers, `[^1]`, and the maintainer read them as plumbing (2026-09-03: "rendering as
// [^1] looks a little weird … worse than just rendering the chip inline. the footnote structure is an
// INTERNAL detail") — so nothing numbered reaches the human anywhere now, and the wire carries the
// same self-describing token the composer shows. Tokens-in-the-text is the load-bearing part
// (2026-09-02): the human interleaves chip, comment, chip, comment, and the agent can only know
// which comment refers to which selection if the reference sits at its original position. Text, not
// a side-channel: the worker reads the same transcript the human does, and `@file:line` beside a
// quoted block is the shape every coding agent already uses (see the prior-art report in the
// dispatching thread's scratch directory — Zed, Copilot and Claude Code all key an inline mention
// to a grouped tail this way).

import { EMBED_TERMINAL_PATH } from "@frizz/shared"
import { joinComposerValue, splitComposerValue } from "./imagePaths.ts"
import { basename, relativeTo } from "./paths.ts"

export interface ComposerContextItem {
  id: number
  /** The mention token anchoring this item in the draft prose: `@` + the chip label (+ `#n` when a duplicate). */
  token: string
  /** Absolute path of the file the selection came from (the panel's canonical path). */
  path: string
  /** The selected text, verbatim. */
  text: string
  /** 1-based line range in the file, when the selection could be located unambiguously. */
  startLine?: number
  endLine?: number
}

/** The chip label a context item wears everywhere: `basename:12` / `basename:3-9` / `basename`. */
export function contextChipLabel(item: { display?: string; path?: string; startLine?: number; endLine?: number }): string {
  const source = item.display ?? item.path ?? ""
  const base = basename(source)
  if (item.startLine === undefined || item.endLine === undefined) return base
  return item.startLine === item.endLine ? `${base}:${item.startLine}` : `${base}:${item.startLine}-${item.endLine}`
}

/** The label a token shows: the token without its `@`. */
export function tokenLabel(token: string): string {
  return token.startsWith("@") ? token.slice(1) : token
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// A token ends where its label does: the next character may not extend it. `@a.md:3` must not
// match inside `@a.md:30`, `@a.md:3-4` or `@a.md:3#2`; ordinary punctuation after it (`@a.md:3.`,
// `@a.md:3,`) is the sentence's, not the token's.
//
// A WHOLE-FILE token has no line suffix (`@a.ts`), and it must not match inside the longer labels a
// file's other references wear either: `@a.ts:12`, `@a.tsx`, `@a.ts.map`, `@terminal-2`. Until
// 2026-10-01 only digits, `#` and `-<digit>` were excluded, which was enough while nearly every chip
// carried lines — but the sidebar's open-files menu adds whole files, so `@a.ts` beside `@a.ts:12` is
// ordinary now, and the prefix match read the whole-file chip as still present after its own text was
// deleted (never swept, serialized at the other chip's position) and gave a second whole-file chip a
// needless `#2`. So: no word character, and no `-`, `.` or `:` that a word character follows. A
// sentence's own `.` or `:` after a token (`see @a.ts.`, `@a.ts: why?`) is still the sentence's.
const TOKEN_BOUNDARY = "(?![\\w#]|[-.:]\\w)"

/** Whether the prose carries this token as a whole reference (not as the prefix of a longer one). */
export function hasToken(prose: string, token: string): boolean {
  return new RegExp(escapeRe(token) + TOKEN_BOUNDARY).test(prose)
}

/** The first position of the token in the prose as a whole reference, or -1. */
export function tokenIndex(prose: string, token: string): number {
  const match = new RegExp(escapeRe(token) + TOKEN_BOUNDARY).exec(prose)
  return match ? match.index : -1
}

/**
 * The token for a fresh selection: `@` + its chip label, made unique against the tokens already
 * staged or already in the prose (`@guide.md:3#2` for a second selection on the same line — two
 * references must never fuse, and a hand-typed twin must not be mistaken for the staged one).
 */
export function uniqueToken(label: string, staged: readonly { token: string }[], prose: string): string {
  const base = `@${label}`
  const taken = (candidate: string) => staged.some((item) => item.token === candidate) || hasToken(prose, candidate)
  if (!taken(base)) return base
  for (let n = 2; ; n++) if (!taken(`${base}#${n}`)) return `${base}#${n}`
}

/**
 * Splice a token into the prose at the caret, padding with a space on either side it would otherwise
 * glue to a word. Returns the new prose and the caret to restore — after the token but before any
 * trailing pad, so typing straight on reads `@guide.md:3 comment` without a double space.
 */
export function insertTokenIntoProse(prose: string, caret: number, token: string): { prose: string; caret: number } {
  const at = Math.max(0, Math.min(caret, prose.length))
  const before = prose.slice(0, at)
  const after = prose.slice(at)
  const lead = before && !/\s$/.test(before) ? " " : ""
  const trail = after && !/^\s/.test(after) ? " " : ""
  return { prose: `${before}${lead}${token}${trail}${after}`, caret: at + lead.length + token.length }
}

/**
 * Cut prose into runs of plain text and whole staged tokens, in order — the ONE splitter the
 * composer's backdrop and the transcript's chips both use, so a reference is a pill in exactly the
 * same places on both surfaces. Longer tokens match first so `@a.md:3#2` is never read as
 * `@a.md:3` + `#2`. An empty token set yields the prose as one plain run.
 */
export function splitProseByTokens(prose: string, tokens: readonly string[]): { text: string; token?: string }[] {
  if (!tokens.length || !prose) return prose ? [{ text: prose }] : []
  const alternation = [...new Set(tokens)].sort((a, b) => b.length - a.length).map(escapeRe).join("|")
  const re = new RegExp(`(${alternation})${TOKEN_BOUNDARY}`, "g")
  const runs: { text: string; token?: string }[] = []
  let last = 0
  for (const match of prose.matchAll(re)) {
    if (match.index > last) runs.push({ text: prose.slice(last, match.index) })
    runs.push({ text: match[0], token: match[0] })
    last = match.index + match[0].length
  }
  if (last < prose.length) runs.push({ text: prose.slice(last) })
  return runs
}

/**
 * Best-effort line range for a selection: find the selection's whitespace-normalized text in the
 * file's source. The rendered view hands us text the markdown pipeline has re-wrapped (soft breaks
 * joined, emphasis markers stripped), so an exact match is hopeless — but a whitespace-insensitive
 * match lands for the common case of selecting plain prose or code. Ambiguous (2+ occurrences) and
 * absent selections return null: a wrong line number is worse than none.
 */
export function locateInSource(source: string, selected: string): { startLine: number; endLine: number } | null {
  // Normalize both sides to single-space word runs, keeping a map from each normalized character back
  // to the source line it came from.
  const lineOf: number[] = []
  let normalized = ""
  let line = 1
  let pendingSpace = false
  for (const ch of source) {
    if (ch === "\n") {
      line++
      pendingSpace = true
      continue
    }
    if (/\s/.test(ch)) {
      pendingSpace = true
      continue
    }
    if (pendingSpace && normalized.length > 0) {
      normalized += " "
      lineOf.push(line)
    }
    pendingSpace = false
    normalized += ch
    lineOf.push(line)
  }
  const needle = selected.replace(/\s+/g, " ").trim()
  if (!needle) return null
  const first = normalized.indexOf(needle)
  if (first === -1) return null
  if (normalized.indexOf(needle, first + 1) !== -1) return null
  // A space between words carries the FOLLOWING word's line (see the push above), which is exactly
  // right for a match that starts mid-map; the ends index real characters either way.
  return { startLine: lineOf[first], endLine: lineOf[first + needle.length - 1] }
}

/**
 * `packages/web/src/App.tsx` for a file under the project; the absolute path for anything else. The
 * remainder keeps the path's own separators (`packages\web\src\App.tsx` under a `C:\…` project), as
 * the panel's canonical path is the server's spelling and the worker reads the same one.
 */
export function contextDisplayPath(path: string, projectDir?: string | null): string {
  if (isTerminalPath(path)) return path
  return (projectDir && relativeTo(projectDir, path)) || path
}

/**
 * A selection made in the editor's TERMINAL, which has no file (embed-protocol.ts
 * `EMBED_TERMINAL_PATH`). Its chip reads `@terminal` (`@terminal#2` for a second), its definition
 * `@terminal (terminal):` — no line numbers, which would be the terminal buffer's and mean nothing to
 * the agent, and never resolved against the project, since `terminal` is a name, not a relative path.
 */
export function isTerminalPath(path: string): boolean {
  return path === EMBED_TERMINAL_PATH
}

function lineLabel(item: { path?: string; startLine?: number; endLine?: number }): string {
  if (item.startLine === undefined || item.endLine === undefined || (item.path !== undefined && isTerminalPath(item.path))) return ""
  return item.startLine === item.endLine ? `, line ${item.startLine}` : `, lines ${item.startLine}-${item.endLine}`
}

/**
 * Where a staged chip came from, for its hover: `src/a.ts, lines 12-20` — the definition's own
 * parenthesis, so the hover and what the agent reads agree — or `Terminal` for a terminal selection.
 */
export function contextSourceLabel(item: { path: string; startLine?: number; endLine?: number }, projectDir?: string | null): string {
  if (isTerminalPath(item.path)) return "Terminal"
  return `${contextDisplayPath(item.path, projectDir)}${lineLabel(item)}`
}

/**
 * The agent-facing serialization: one DEFINITION per item — `@guide.md:3 (docs/guide.md, line 3):`
 * then the selection as a blockquote. The `@` tokens stay in the prose where the human put them, so
 * each definition opens with the very token the sentence used; the parenthesis spells the path and
 * line range out in full for a reader that does not want to decode the label. The human's remarks
 * on a selection are the prose around its token — there is no per-item note. Blockquotes rather
 * than a fence because the quoted text may itself contain any fence, and because the transcript
 * renders the sent message as markdown — quoted context reads as quotation.
 */
export function serializeContextItems(items: ComposerContextItem[], projectDir?: string | null): string {
  if (!items.length) return ""
  const blocks = items.map((item) => {
    const quoted = item.text.replace(/\s+$/, "").split("\n").map((line) => `> ${line}`).join("\n")
    return `${item.token} (${contextDisplayPath(item.path, projectDir)}${lineLabel(item)}):\n${quoted}`
  })
  return `Selected context:\n\n${blocks.join("\n\n")}`
}

/**
 * Splice the serialized context into an outgoing composer value. Only items whose token still
 * appears in the prose serialize — deleting the token text IS the removal gesture. The value's
 * TRAILING lines may be attachment paths (see imagePaths.ts) which several surfaces detect by their
 * trailing position — context goes after the prose but BEFORE those lines so they stay trailing.
 * Definitions follow the order the references appear in the prose, not staging order.
 */
export function buildMessageWithContext(value: string, items: ComposerContextItem[], projectDir?: string | null): string {
  const { prose, attachments } = splitComposerValue(value)
  const present = items
    .filter((item) => hasToken(prose, item.token))
    .sort((a, b) => tokenIndex(prose, a.token) - tokenIndex(prose, b.token))
  const context = serializeContextItems(present, projectDir)
  if (!context) return value
  const body = prose.trimEnd() ? `${prose.trimEnd()}\n\n${context}` : context
  return joinComposerValue(body, attachments.map((attachment) => attachment.path))
}

// ── the receiving side: a SENT message parsed back into prose + items ────────────────────────────

/** One context item recovered from a sent message's serialized definitions. */
export interface SentContextItem {
  /** The mention token, exactly as it appears in the body. */
  token: string
  /** The path exactly as serialized (project-relative or absolute). */
  display: string
  startLine?: number
  endLine?: number
  /** The quoted selection, blockquote prefixes stripped. */
  text: string
}

const HEADER = "Selected context:\n\n"

/**
 * Recognize the serialization `buildMessageWithContext` produced inside a SENT message, so the
 * transcript can render the `@` references as chips instead of showing the raw definitions dump.
 * Strict by design: anything that does not parse back exactly — including every message from the
 * two earlier formats (`[1] path` and `[^1]: path`) — returns null and renders as the plain text it is.
 */
export function parseSentContext(prose: string): { body: string; items: SentContextItem[] } | null {
  const at = prose.lastIndexOf(HEADER)
  if (at === -1) return null
  if (at !== 0 && prose.slice(at - 2, at) !== "\n\n") return null
  const body = prose.slice(0, Math.max(0, at - 2))
  // Definition blocks are separated by a blank line followed by the next `@token (` head; split on
  // the lookahead rather than on `\n\n` so a blank line inside a quote never opens a bogus block.
  const blocks = prose.slice(at + HEADER.length).split(/\n\n(?=@\S+ \()/)
  const items: SentContextItem[] = []
  for (const block of blocks) {
    const lines = block.split("\n")
    const head = lines[0]?.match(/^(@\S+) \((.+?)(?:, line (\d+)|, lines (\d+)-(\d+))?\):$/)
    if (!head) return null
    const display = head[2]
    const startLine = head[3] !== undefined ? Number(head[3]) : head[4] !== undefined ? Number(head[4]) : undefined
    const endLine = head[3] !== undefined ? Number(head[3]) : head[5] !== undefined ? Number(head[5]) : undefined
    let i = 1
    const quote: string[] = []
    for (; i < lines.length && lines[i].startsWith(">"); i++) quote.push(lines[i].replace(/^> ?/, ""))
    if (!quote.length || i < lines.length) return null
    items.push({ token: head[1], display, startLine, endLine, text: quote.join("\n") })
  }
  if (!items.length) return null
  // The references must actually be in the body — a message that merely QUOTES a serialization (an
  // agent echoing one back, a human pasting one) keeps its honest plain-text rendering.
  if (!items.every((item) => hasToken(body, item.token))) return null
  return { body, items }
}
