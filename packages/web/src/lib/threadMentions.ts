import { addressSegments, SUB_AGENT_SEPARATOR, sectionOf, type SubAgentDirectory, type SubAgentDirectoryEntry, type ThreadView } from "@frizz/shared"
import { orderByInteraction, threadHandleOf } from "../groups.ts"
import { compactAge } from "./activityTime.ts"
import { formatCompactElapsed } from "./durationLabels.ts"

// `@handle` MENTIONS IN THE PROMPT BOX — pointing one thread at another ("ask @shellBudgets about this").
// A thread's name shows as its camelCase handle (groups.ts displayTitle), so the typeahead offers those
// same handles and inserts one as plain text; the worker reading the message resolves it itself. The
// candidate list is the board the client already holds — no server round trip per keystroke.

export interface MentionCandidate {
  /** The thread's slug — for a sub-agent, the slug of the thread it belongs to. */
  slug: string
  /** What lands after `@`: a thread's handle, or a sub-agent's whole `thread.child` address. */
  handle: string
  /** The thread's live status phrase, shown dimmed beside the handle when there is one. */
  status?: string
  /** Filed as done — offered after every open thread, and tagged so. A sub-agent that has returned is
   *  done the same way, after every one still out. */
  done: boolean
  /** Set on a SUB-AGENT candidate: its drill-in id (unique where `slug` is shared by its siblings). */
  subAgentId?: string
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
// The query may run on through `.` (`@portTheParser.ca`, a sub-agent under its thread) but never START
// with one: `@.` is not a mention of anything.
const HANDLE_CHAR = /[\p{L}\p{N}_-]/u
const MENTION_BEFORE_CARET = /(?:^|[^\p{L}\p{N}_@./])@((?:[\p{L}\p{N}_-][\p{L}\p{N}_.-]*)?)$/u

/** The mention being typed at the caret: where its `@` sits and what follows it so far. Undefined when
 *  the caret is not inside an `@` token that starts at a word boundary (an email address is not one). */
export function mentionQueryAt(prose: string, caret: number | null): { start: number; query: string } | undefined {
  if (caret === null || caret > prose.length) return undefined
  const m = MENTION_BEFORE_CARET.exec(prose.slice(0, caret))
  if (!m) return undefined
  return { start: caret - m[1]!.length - 1, query: m[1]! }
}

/** A dotted query split at its FIRST dot: the thread it names (`head`) and what was typed of the
 *  sub-agent's address below it (`rest`, possibly empty — `@portTheParser.` offers every child).
 *  Undefined for a plain thread query, which the typeahead treats exactly as it always did. */
export function splitMentionQuery(query: string): { head: string; rest: string } | undefined {
  const dot = query.indexOf(SUB_AGENT_SEPARATOR)
  if (dot < 0) return undefined
  return { head: query.slice(0, dot), rest: query.slice(dot + 1) }
}

/** Case, punctuation and a trailing plural folded away — the server's `foldThreadName` key, applied to
 *  a single token, so `@ShellBudget`, `@shell-budgets` and `@shellBudgets` all name one thread. */
export function foldHandle(text: string): string {
  const key = text.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")
  return key.length > 3 && key.endsWith("s") && !key.endsWith("ss") ? key.slice(0, -1) : key
}

/** Where each hump of a camelCase handle starts (`shellBudgets` → 0, 5): its words, for matching "bud"
 *  and for where a handle too long for its line may wrap (Sidebar.tsx TitleWithTrailers). The segment
 *  after a `.` starts a word too, whatever its case — `cacheKeys` in `portTheParser.cacheKeys` begins
 *  lowercase, and "cache" has to find it. */
export function humpStarts(handle: string): number[] {
  const starts = [0]
  for (let i = 1; i < handle.length; i++) {
    const c = handle[i]!
    const prev = handle[i - 1]!
    if (prev === SUB_AGENT_SEPARATOR) {
      if (c !== SUB_AGENT_SEPARATOR) starts.push(i)
    } else if (c !== c.toLowerCase() && prev === prev.toLowerCase()) starts.push(i)
  }
  return starts
}

function isSubsequence(query: string, text: string): boolean {
  let i = 0
  for (const c of text) if (c === query[i]) i++
  return i === query.length
}

/** What a candidate is RANKED on: a thread's handle, or a sub-agent's address below its thread
 *  (`wave2.implW3` of `portTheParser.wave2.implW3`) — the head was already typed and resolved, so
 *  matching it again would rank every sibling the same. */
function matchKey(c: MentionCandidate): string {
  if (!c.subAgentId) return c.handle
  const dot = c.handle.indexOf(SUB_AGENT_SEPARATOR)
  return dot < 0 ? c.handle : c.handle.slice(dot + 1)
}

/** Rank the candidates for what was typed after `@`: a prefix of the handle, then a prefix of any of its
 *  words (`bud` → `shellBudgets`), then anywhere inside it, then its letters in order (`shb`). Within a
 *  rank the candidate order holds, so open threads lead done ones. An empty query offers everything.
 *  Sub-agent candidates rank on their address below the thread, against what was typed after its dot
 *  (splitMentionQuery `rest`); a dot typed inside that (`wave2.im`) is kept, since it separates the same
 *  segments in the key. */
export function matchMentions(candidates: readonly MentionCandidate[], query: string, limit = 50): MentionCandidate[] {
  const q = query.toLowerCase().replace(/[^\p{L}\p{N}.]+/gu, "")
  if (!q) return candidates.slice(0, limit)
  const ranked: MentionCandidate[][] = [[], [], [], []]
  for (const c of candidates) {
    const key = matchKey(c)
    const lower = key.toLowerCase()
    if (lower.startsWith(q)) ranked[0]!.push(c)
    else if (humpStarts(key).some((i) => lower.startsWith(q, i))) ranked[1]!.push(c)
    else if (lower.includes(q)) ranked[2]!.push(c)
    else if (isSubsequence(q, lower)) ranked[3]!.push(c)
  }
  return ranked.flat().slice(0, limit)
}

// SUB-AGENTS AFTER THE DOT (maintainer 2026-09-30: "autocomplete should still work for subagents after
// ."). `@portTheParser.` resolves its head to a thread by the same fold a plain mention uses, and the
// menu turns into that thread's sub-agents, read from the server's directory of every child it ever
// dispatched — "some subagents are transient so probably we want to maintain some history of completed
// subagents so we can reference the thread if needed". Only a child with an ADDRESS is offered: one
// whose name is a sentence, or whose parent's is, has nothing to complete to.

/** The sub-agents a `@thread.` query offers, from that thread's directory: every one still out, then the
 *  ones that have returned (newest first, as the server orders them), each dimmed with how it stands. */
export function subAgentMentionCandidates(slug: string, directory: SubAgentDirectory, nowMs = Date.now()): MentionCandidate[] {
  const live: MentionCandidate[] = []
  const done: MentionCandidate[] = []
  for (const entry of directory.agents) {
    if (!entry.address) continue
    const candidate = { slug, handle: entry.address, status: subAgentMentionStatus(entry, nowMs), done: entry.state === "done", subAgentId: entry.id }
    if (candidate.done) done.push(candidate)
    else live.push(candidate)
  }
  return [...live, ...done]
}

/** The dimmed reading beside a sub-agent in the menu — how it stands, in the child-op row's own words
 *  and the house duration grammar: `running 12m`, `stale 40m`, `rested`, `returned 3h ago`,
 *  `failed 2d ago`. The address already carries its name, so the dispatch's own words would only
 *  repeat it. */
export function subAgentMentionStatus(entry: Pick<SubAgentDirectoryEntry, "state" | "outcome" | "startedAt" | "finishedAt">, nowMs = Date.now()): string {
  if (entry.state === "done") {
    const word = entry.outcome === "failed" ? "failed" : entry.outcome === "killed" ? "stopped" : "returned"
    const age = compactAge(entry.finishedAt, nowMs)
    return age ? `${word} ${age}` : word
  }
  if (entry.state === "rested") return "rested"
  const started = entry.startedAt ? Date.parse(entry.startedAt) : NaN
  const elapsed = Number.isFinite(started) ? formatCompactElapsed(nowMs - started) : ""
  return elapsed ? `${entry.state} ${elapsed}` : entry.state
}

/** An address folded segment by segment, the way a handle is (`foldHandle`), so `@PortTheParser.CacheKey`
 *  finds `portTheParser.cacheKeys`. */
export function foldAddress(address: string): string {
  return addressSegments(address).map(foldHandle).join(SUB_AGENT_SEPARATOR)
}

/** The directory entry a `thread.child` mention names, by the folded address, or undefined. */
export function resolveSubAgentMention(directory: SubAgentDirectory, mention: string): SubAgentDirectoryEntry | undefined {
  const key = foldAddress(mention)
  return directory.agents.find((entry) => entry.address !== undefined && foldAddress(entry.address) === key)
}

/** Complete the mention at `start` to `@handle`, replacing what was typed of it (including any part of
 *  the token after the caret) and leaving the caret after one separating space. A `.` after the caret
 *  is part of the token only when another handle character follows it (`@port|TheParser.cacheKeys`):
 *  a sentence's full stop right after the caret stays where it was. */
export function insertMention(prose: string, start: number, caret: number, handle: string): { prose: string; caret: number } {
  let end = caret
  while (end < prose.length && (HANDLE_CHAR.test(prose[end]!) || (prose[end] === SUB_AGENT_SEPARATOR && HANDLE_CHAR.test(prose[end + 1] ?? "")))) end++
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

/** A mention segment names a thread by `slug`; a `@thread.child` one also carries the child's
 *  `address` (without the `@`), which is resolved against the thread's directory only when clicked. */
export type MentionSegment = { kind: "text"; text: string } | { kind: "mention"; text: string; slug: string; status?: string; address?: string }

// Same boundary rule and the same dotted continuation as @frizz/shared threadMentions: a mention starts
// after a non-word character, and runs on through a `.` only when another segment follows it.
const MENTION = /(^|[^\p{L}\p{N}_@./])(@([\p{L}\p{N}][\p{L}\p{N}_-]*(?:\.[\p{L}\p{N}][\p{L}\p{N}_-]*)*))/gu

/** Split verbatim text into plain runs and the `@handle` mentions that name a thread in `candidates`.
 *  A mention that resolves to nothing stays text. A dotted `@thread.child` links when its THREAD
 *  resolves — whether the child exists is the directory's to say, and only when it is clicked.
 *  Concatenating every segment's `text` yields the input byte-for-byte. */
export function mentionSegments(text: string, candidates: readonly MentionCandidate[]): MentionSegment[] {
  if (candidates.length === 0 || !text.includes("@")) return [{ kind: "text", text }]
  const out: MentionSegment[] = []
  let consumed = 0
  for (const m of text.matchAll(MENTION)) {
    const segments = addressSegments(m[3]!)
    const hit = resolveMention(candidates, segments[0]!)
    if (!hit) continue
    const start = m.index! + m[1]!.length
    if (start > consumed) out.push({ kind: "text", text: text.slice(consumed, start) })
    out.push(segments.length > 1
      ? { kind: "mention", text: m[2]!, slug: hit.slug, address: m[3]! }
      : { kind: "mention", text: m[2]!, slug: hit.slug, status: hit.status })
    consumed = start + m[2]!.length
  }
  if (consumed < text.length) out.push({ kind: "text", text: text.slice(consumed) })
  return out
}
