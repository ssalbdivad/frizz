// ---- A SCHEDULE PHRASE IN THE TEXT AROUND IT ---------------------------------------------------------------
// What the browser and the server both do with the phrase the schedule interpreter finds in a prompt
// (packages/server/src/schedule-interpreter.ts). They must agree to the byte: the prompt box shows
// "Each run: …" from the same cut the server saves, so these live here rather than on either side.
//
// The three survivors of the local schedule grammar (schedule-phrase.ts, replaced on the maintainer's
// direction 2026-10-06 by a model read of the whole text; the grammar's last commit is 7e0b68b5).

import { THREAD_HANDLE_MAX_CHARS, threadHandle } from "./thread-handle.ts"

/** A half-open run of a text, [start, end), in UTF-16 offsets. */
export type Span = { start: number; end: number }

/** Lowercase without changing any index (a few characters lowercase to two code units). */
function sameLengthLower(text: string): string {
  const lower = text.toLowerCase()
  if (lower.length === text.length) return lower
  let out = ""
  for (const ch of text) {
    const l = ch.toLowerCase()
    out += l.length === ch.length ? l : ch
  }
  return out
}

/** Where `phrase` sits in `text`: exactly, else ignoring case; with `near`, the occurrence closest to it. */
export function locatePhrase(text: string, phrase: string, near?: number): Span | undefined {
  const p = phrase.trim()
  if (!p) return undefined
  const all = (hay: string, needle: string) => {
    const out: number[] = []
    for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) out.push(i)
    return out
  }
  let hits = all(text, p)
  if (!hits.length) hits = all(sameLengthLower(text), sameLengthLower(p))
  if (!hits.length) return undefined
  const at = near === undefined ? hits[0]! : hits.reduce((best, h) => (Math.abs(h - near) < Math.abs(best - near) ? h : best))
  return { start: at, end: at + p.length }
}

/** `text` with `span` cut out and the seam tidied — the dangling comma or dash the phrase leaves — and
 *  NOTHING else changed. The browser's "Each run:" and the server's saved prompt are both this. */
export function cutPhrase(text: string, span: Span): string {
  const before = text.slice(0, span.start).replace(/[\s,;:–—-]+$/u, "")
  const after = text.slice(span.end).replace(/^[\s,;:–—-]+/u, "")
  // A phrase that opened the text took its sentence with it: the stop that ended it ("Every day at 9am. Post
  // the digest.") has nothing left to end, so it goes too.
  if (!before.trim()) return after.replace(/^[.!?]+(?=\s|$)/u, "").trim()
  if (!after.trim()) return before.trim()
  return `${before}${/^[.!?)]/.test(after) ? "" : " "}${after}`.trim()
}

const TITLE_DROP = new Set(["please", "pls", "kindly", "the", "a", "an", "this", "that", "these", "those", "our", "my", "your", "its", "their", "all", "any", "some"])
const TITLE_TAIL_STOP = new Set(["it", "them", "this", "that", "these", "those", "up", "out", "in", "on", "at", "for", "to", "of", "the", "a", "an", "all", "now", "please", "again", "too", "there", "here", "me", "us", "with", "from", "by", "and", "or", "if", "is", "are"])

/** A schedule's title when the interpreter gave none, until the thread namer names it (`titleAuto`): the verb
 *  and head noun of the cut prompt's first clause — "triage new issues" → "Triage issues" — in sentence case,
 *  within a thread name's two words and twenty-character handle. */
export function provisionalScheduleTitle(prompt: string): string {
  const fallback = "Scheduled run"
  const line = prompt.trim().split("\n")[0] ?? ""
  const clause = line.split(/[,;:—–]|\.(?=\s|$)|\s+-\s+|\s+(?:and|&)\s+/i)[0] ?? ""
  const words = clause.split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")).filter(Boolean)
  while (words.length && TITLE_DROP.has(words[0]!.toLowerCase())) words.shift()
  if (!words.length) return fallback
  let lastAt = words.length - 1
  while (lastAt > 0 && TITLE_TAIL_STOP.has(words[lastAt]!.toLowerCase())) lastAt--
  const first = words[0]!
  const head = first[0]!.toUpperCase() + first.slice(1)
  const fits = (name: string) => name.split(/\s+/).length <= 2 && (threadHandle(name)?.length ?? Infinity) <= THREAD_HANDLE_MAX_CHARS
  if (lastAt > 0) {
    let tail = words[lastAt]!
    // Typed in Title Case ("Triage New Issues")? Sentence case wins; an acronym or a brand keeps its caps.
    const titleCased = words.slice(1).every((w) => /^\p{Lu}\p{Ll}+$/u.test(w))
    if (titleCased && /^\p{Lu}\p{Ll}+$/u.test(tail)) tail = tail.toLowerCase()
    const two = `${head} ${tail}`
    if (fits(two)) return two
  }
  return fits(head) ? head : fallback
}
