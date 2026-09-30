import { sectionOf, type ThreadView } from "@frizz/shared"
import { orderByInteraction, threadHandleOf } from "../groups.ts"

// `@handle` MENTIONS IN THE PROMPT BOX — pointing one thread at another ("ask @shellBudgets about this").
// A thread's name shows as its camelCase handle (groups.ts displayTitle), so the typeahead offers those
// same handles and inserts one as plain text; the worker reading the message resolves it itself. The
// candidate list is the board the client already holds — no server round trip per keystroke.

export interface MentionCandidate {
  slug: string
  handle: string
  /** The thread's live status phrase, shown dimmed beside the handle when there is one. */
  status?: string
  /** Filed as done — offered after every open thread, and tagged so. */
  done: boolean
}

/** How many done threads the typeahead offers: the recent ones a message plausibly means, the same
 *  bound the server's namer shows a worker (thread-names.ts PROMPT_DONE_NAMES). */
const DONE_CANDIDATES = 20

/** The threads a prompt box can mention: every open thread with a handle, most recently active first,
 *  then the most recent done ones. `excludeSlug` drops the thread being written INTO — a thread has no
 *  use for a mention of itself. External rows are never offered: Frizz holds no name for them. */
export function mentionCandidates(threads: readonly ThreadView[], excludeSlug?: string): MentionCandidate[] {
  const open: MentionCandidate[] = []
  const done: MentionCandidate[] = []
  for (const t of orderByInteraction(threads)) {
    if (t.id === excludeSlug || t.foreign === true) continue
    const section = sectionOf(t)
    if (section === null) continue
    const handle = threadHandleOf(t)
    if (!handle) continue
    const candidate = { slug: t.id, handle, status: t.statusLine?.trim() || undefined, done: section === "inactive" }
    if (candidate.done) done.push(candidate)
    else open.push(candidate)
  }
  return [...open, ...done.slice(0, DONE_CANDIDATES)]
}

// The characters a handle runs over, and what may sit right before its `@` — mirrors @frizz/shared
// threadMentions, so what the typeahead completes is exactly what the server reads back as a mention.
const HANDLE_CHAR = /[\p{L}\p{N}_-]/u
const MENTION_BEFORE_CARET = /(?:^|[^\p{L}\p{N}_@./])@([\p{L}\p{N}_-]*)$/u

/** The mention being typed at the caret: where its `@` sits and what follows it so far. Undefined when
 *  the caret is not inside an `@` token that starts at a word boundary (an email address is not one). */
export function mentionQueryAt(prose: string, caret: number | null): { start: number; query: string } | undefined {
  if (caret === null || caret > prose.length) return undefined
  const m = MENTION_BEFORE_CARET.exec(prose.slice(0, caret))
  if (!m) return undefined
  return { start: caret - m[1]!.length - 1, query: m[1]! }
}

/** Case, punctuation and a trailing plural folded away — the server's `foldThreadName` key, applied to
 *  a single token, so `@ShellBudget`, `@shell-budgets` and `@shellBudgets` all name one thread. */
export function foldHandle(text: string): string {
  const key = text.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")
  return key.length > 3 && key.endsWith("s") && !key.endsWith("ss") ? key.slice(0, -1) : key
}

/** Where each hump of a camelCase handle starts (`shellBudgets` → 0, 5): its words, for matching "bud"
 *  and for where a handle too long for its line may wrap (Sidebar.tsx TitleWithTrailers). */
export function humpStarts(handle: string): number[] {
  const starts = [0]
  for (let i = 1; i < handle.length; i++) {
    const c = handle[i]!
    if (c !== c.toLowerCase() && handle[i - 1] === handle[i - 1]!.toLowerCase()) starts.push(i)
  }
  return starts
}

function isSubsequence(query: string, text: string): boolean {
  let i = 0
  for (const c of text) if (c === query[i]) i++
  return i === query.length
}

/** Rank the candidates for what was typed after `@`: a prefix of the handle, then a prefix of any of its
 *  words (`bud` → `shellBudgets`), then anywhere inside it, then its letters in order (`shb`). Within a
 *  rank the candidate order holds, so open threads lead done ones. An empty query offers everything. */
export function matchMentions(candidates: readonly MentionCandidate[], query: string, limit = 50): MentionCandidate[] {
  const q = query.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")
  if (!q) return candidates.slice(0, limit)
  const ranked: MentionCandidate[][] = [[], [], [], []]
  for (const c of candidates) {
    const lower = c.handle.toLowerCase()
    if (lower.startsWith(q)) ranked[0]!.push(c)
    else if (humpStarts(c.handle).some((i) => lower.startsWith(q, i))) ranked[1]!.push(c)
    else if (lower.includes(q)) ranked[2]!.push(c)
    else if (isSubsequence(q, lower)) ranked[3]!.push(c)
  }
  return ranked.flat().slice(0, limit)
}

/** Complete the mention at `start` to `@handle`, replacing what was typed of it (including any part of
 *  the token after the caret) and leaving the caret after one separating space. */
export function insertMention(prose: string, start: number, caret: number, handle: string): { prose: string; caret: number } {
  let end = caret
  while (end < prose.length && HANDLE_CHAR.test(prose[end]!)) end++
  const after = prose.slice(end)
  const sep = /^\s/.test(after) ? "" : " "
  const next = `${prose.slice(0, start)}@${handle}${sep}${after}`
  return { prose: next, caret: start + 1 + handle.length + 1 }
}

/** The thread a mention names, by the same fold the server resolves it with, or undefined. */
export function resolveMention(candidates: readonly MentionCandidate[], mention: string): MentionCandidate | undefined {
  const key = foldHandle(mention)
  if (!key) return undefined
  return candidates.find((c) => foldHandle(c.handle) === key)
}

export type MentionSegment = { kind: "text"; text: string } | { kind: "mention"; text: string; slug: string; status?: string }

// Same boundary rule as @frizz/shared threadMentions: a mention starts after a non-word character.
const MENTION = /(^|[^\p{L}\p{N}_@./])(@([\p{L}\p{N}][\p{L}\p{N}_-]*))/gu

/** Split verbatim text into plain runs and the `@handle` mentions that name a thread in `candidates`.
 *  A mention that resolves to nothing stays text. Concatenating every segment's `text` yields the input
 *  byte-for-byte. */
export function mentionSegments(text: string, candidates: readonly MentionCandidate[]): MentionSegment[] {
  if (candidates.length === 0 || !text.includes("@")) return [{ kind: "text", text }]
  const out: MentionSegment[] = []
  let consumed = 0
  for (const m of text.matchAll(MENTION)) {
    const hit = resolveMention(candidates, m[3]!)
    if (!hit) continue
    const start = m.index! + m[1]!.length
    if (start > consumed) out.push({ kind: "text", text: text.slice(consumed, start) })
    out.push({ kind: "mention", text: m[2]!, slug: hit.slug, status: hit.status })
    consumed = start + m[2]!.length
  }
  if (consumed < text.length) out.push({ kind: "text", text: text.slice(consumed) })
  return out
}
