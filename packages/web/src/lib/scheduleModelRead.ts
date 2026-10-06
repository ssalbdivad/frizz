import { useEffect, useReducer, useRef, useState } from "react"
import {
  SCHEDULE_NOT_FOUND_COPY,
  SCHEDULE_PRESENCE_COPY,
  SCHEDULE_SPACING_COPY,
  cutPhrase,
  locatePhrase,
  zonedWall,
  type InterpretScheduleResult,
  type Span,
} from "@frizz/shared"

// THE MODEL TIER OF THE LIVE SCHEDULE READING (plans/schedule-live-reading.md §4.2), shared by the drawer's
// Change when (§11) and the prompt box's schedule mode (§5.7). The local grammar reads most schedules in a
// millisecond; what it declines — a condition, a vague count, an event offset, a zone, a typo — goes to the
// server's interpreter (Sonnet, ~3s). That call costs the human's quota and holds the interpreter's
// per-project `concurrency: 1` queue, so it is spent carefully:
//
// - SINGLE FLIGHT PER BOX. At most one request is out. A text that changes while one is out waits as the one
//   queued follow-up — only the LATEST text, so a burst of edits during a read costs exactly one more read,
//   and a stale request can sit at most one deep in the server's queue. The stale answer is still cached.
// - A 10m CACHE across every box, keyed `context \0 tz \0 local date \0 text`. The date is in the key because
//   "tomorrow at 8" read yesterday is not today's reading; `context` names what else the read depended on (a
//   Change when reads against its schedule's stored rule and condition, so its answers are not the box's).
//   Only the model's VERDICTS are cached — a reading or a refusal it would give again. A transport failure
//   or a switched-off interpreter is shown for its text but never cached, so the next Enter really asks.
// - A BUDGET of 12 automatic reads per session (a mode session in the box, an edit session in the drawer).
//   After that only an explicit act (Enter) reads; explicit reads are single-flight but never budgeted.
// - A MODEL READING BELONGS TO ITS PHRASE, not the whole text (`relocateModelReading`): an edit to the task
//   around it keeps it, re-cut locally with the shared `cutPhrase`; an edit that touches the phrase drops it.
//
// Cancellation is client-side discard only; `interpretSchedule`'s contract is unchanged (§4.2, §16).

/** How long a cached model answer stays good (§4.2). */
export const MODEL_CACHE_TTL_MS = 10 * 60_000
/** The most model answers the cache holds; the oldest go first. */
export const MODEL_CACHE_MAX = 50
/** Automatic model reads per session; Enter still reads after this. */
export const MODEL_READ_BUDGET = 12

export type ModelReadOk = Extract<InterpretScheduleResult, { ok: true }>

/** What the human sees when the read itself failed — the request, not the reading (§5.9). */
export const MODEL_UNREACHABLE_COPY = "Couldn't read that just now. Press Enter to try again."
/** What the human sees once the automatic reads are spent (§5.9). */
export const MODEL_BUDGET_COPY = "Press Enter to read it again."

// ---- the cache ------------------------------------------------------------------------------------------

const cache = new Map<string, { at: number; result: InterpretScheduleResult }>()

/** The cache key for a read of `text` at `nowMs`: `context \0 tz \0 local date \0 text`. */
export function modelReadKey(input: { context?: string; tz: string; nowMs: number; text: string }): string {
  let date = ""
  try {
    const w = zonedWall(input.nowMs, input.tz)
    date = `${w.y}-${w.mo}-${w.d}`
  } catch {
    date = new Date(input.nowMs).toISOString().slice(0, 10)
  }
  return [input.context ?? "", input.tz, date, input.text].join("\0")
}

/** A cached answer still inside its TTL, or undefined. A hit is refreshed to the newest end of the LRU. */
export function cachedModelRead(key: string, nowMs: number): InterpretScheduleResult | undefined {
  const hit = cache.get(key)
  if (!hit) return undefined
  if (nowMs - hit.at > MODEL_CACHE_TTL_MS) {
    cache.delete(key)
    return undefined
  }
  cache.delete(key)
  cache.set(key, hit)
  return hit.result
}

function remember(key: string, result: InterpretScheduleResult, nowMs: number): void {
  cache.delete(key)
  cache.set(key, { at: nowMs, result })
  while (cache.size > MODEL_CACHE_MAX) cache.delete(cache.keys().next().value!)
}

/** Tests only: start from an empty cache. */
export function clearModelReadCache(): void {
  cache.clear()
}

/** An answer the model would give again for the same words — a reading, or a refusal of the words
 *  themselves. Not: a failed call, a timeout, an interpreter that is switched off. */
export function isModelVerdict(result: InterpretScheduleResult): boolean {
  if (result.ok) return true
  const e = result.error
  return e === SCHEDULE_NOT_FOUND_COPY || e === SCHEDULE_PRESENCE_COPY || e === SCHEDULE_SPACING_COPY
    || e.startsWith("Couldn't turn that into a schedule") || e.startsWith("What should each run do?")
}

/** The interpreter's own words for a failed call ("Couldn't read that just now: …") read as the house copy,
 *  with nothing about the transport; any other refusal is the model's copy, verbatim. */
export function modelRefusalCopy(result: Extract<InterpretScheduleResult, { ok: false }>): string {
  return /^Couldn't read that just now\b/.test(result.error) ? MODEL_UNREACHABLE_COPY : result.error
}

/**
 * The model's offsets, moved onto the text the box SENT. The server parses the request with
 * `InterpretScheduleInput`, whose `text` is trimmed, so the interpreter's `phraseStart`/`phraseEnd` index the
 * trimmed text: a prompt that starts with a newline (Shift-Enter first) or a pasted space drew every model mark
 * that many characters late, and cut the wrong words out of Each run ("y post the digest") — fix round 1, X8.
 * The trimmed lead is added back unless the offsets already slice the phrase out of the sent text (a server
 * that does not trim). `phrase` is always `text.slice(start, end)` of what the interpreter read.
 */
export function alignModelOffsets(sent: string, result: InterpretScheduleResult): InterpretScheduleResult {
  if (!result.ok) return result
  const lead = sent.length - sent.trimStart().length
  if (!lead) return result
  const slices = (by: number) => sent.slice(result.phraseStart + by, result.phraseEnd + by) === result.phrase
  if (slices(0) && !slices(lead)) return result
  return { ...result, phraseStart: result.phraseStart + lead, phraseEnd: result.phraseEnd + lead }
}

// ---- the reader: single flight, budget ------------------------------------------------------------------

export type ModelReadView =
  /** Nothing asked for this text yet. */
  | { status: "none" }
  /** Out now, or queued behind the read that is. */
  | { status: "reading" }
  /** The model's answer for exactly this text (cached, or this session's non-verdict answer). */
  | { status: "answered"; result: InterpretScheduleResult }
  /** The request failed; Enter asks again. */
  | { status: "failed"; message: string }
  /** The automatic reads are spent; only Enter reads. */
  | { status: "budget" }

export interface ModelReader {
  /** Ask for a model reading of `text`. A cached answer costs nothing; a text already out is not sent
   *  twice; with a read out, `text` becomes the one queued follow-up. An automatic request past the budget
   *  is refused (`view` says `budget`); an `explicit` one (Enter) is never budgeted. */
  request(text: string, opts?: { explicit?: boolean }): void
  /** Drop the queued follow-up: the text no longer needs the model (the grammar reads it now). */
  cancelQueued(): void
  view(text: string): ModelReadView
  /** The newest answer that landed, for whatever text — what `relocateModelReading` carries forward. */
  lastAnswer(): { text: string; result: InterpretScheduleResult } | undefined
  /** Automatic reads spent this session. */
  spent(): number
  /** A new session: the budget refills and this session's failures are forgotten. A read still out lands
   *  in the cache as usual. */
  reset(): void
  subscribe(listener: () => void): () => void
}

export interface ModelReaderDeps {
  interpret: (text: string) => Promise<InterpretScheduleResult>
  /** The cache key for `text` read now (`modelReadKey` with the box's context and zone). */
  keyOf: (text: string, nowMs: number) => string
  now?: () => number
  budget?: number
}

export function createModelReader(deps: ModelReaderDeps): ModelReader {
  const now = deps.now ?? Date.now
  const budget = deps.budget ?? MODEL_READ_BUDGET
  const listeners = new Set<() => void>()
  let flight: string | undefined
  let queued: { text: string; explicit: boolean } | undefined
  let spent = 0
  let refusedForBudget: string | undefined
  /** This session's answers that are not cached (non-verdicts), by text; bounded. */
  const answers = new Map<string, InterpretScheduleResult>()
  const failures = new Map<string, string>()
  let last: { text: string; result: InterpretScheduleResult } | undefined

  const notify = () => { for (const l of [...listeners]) l() }
  const cached = (text: string) => cachedModelRead(deps.keyOf(text, now()), now())

  function launch(text: string, explicit: boolean): void {
    if (!explicit) spent++
    failures.delete(text)
    answers.delete(text)
    if (refusedForBudget === text) refusedForBudget = undefined
    flight = text
    const key = deps.keyOf(text, now())
    let call: Promise<InterpretScheduleResult>
    try {
      call = deps.interpret(text)
    } catch (error) {
      call = Promise.reject(error)
    }
    call.then(
      (answer) => {
        const result = alignModelOffsets(text, answer)
        if (isModelVerdict(result)) remember(key, result, now())
        else {
          answers.set(text, result)
          while (answers.size > 20) answers.delete(answers.keys().next().value!)
        }
        last = { text, result }
      },
      (error: unknown) => {
        failures.set(text, error instanceof Error ? error.message : String(error))
      },
    ).finally(() => {
      flight = undefined
      const next = queued
      queued = undefined
      if (next && !cached(next.text)) start(next.text, next.explicit)
      notify()
    })
  }

  function start(text: string, explicit: boolean): void {
    if (!explicit && spent >= budget) {
      refusedForBudget = text
      return
    }
    launch(text, explicit)
  }

  return {
    request(text, opts) {
      const explicit = opts?.explicit === true
      if (cached(text) !== undefined) return
      if (flight === text) {
        // Asked again for the text that is out: nothing to send, but a queued older text is moot now.
        queued = undefined
        return
      }
      // A non-verdict answer (a failed call) stays on screen until an explicit act asks again.
      if (!explicit && (answers.has(text) || failures.has(text))) return
      if (flight !== undefined) {
        queued = { text, explicit: explicit || (queued?.text === text && queued.explicit) }
        notify()
        return
      }
      start(text, explicit)
      notify()
    },
    cancelQueued() {
      if (!queued) return
      queued = undefined
      notify()
    },
    view(text) {
      const hit = cached(text)
      if (hit) return { status: "answered", result: hit }
      if (flight === text || queued?.text === text) return { status: "reading" }
      const answer = answers.get(text)
      if (answer) return { status: "answered", result: answer }
      const failure = failures.get(text)
      if (failure !== undefined) return { status: "failed", message: failure }
      if (refusedForBudget === text) return { status: "budget" }
      return { status: "none" }
    },
    lastAnswer: () => last,
    spent: () => spent,
    reset() {
      spent = 0
      refusedForBudget = undefined
      failures.clear()
      answers.clear()
      notify()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/** The readers boxes share, by draft (`useModelReader`'s `share`). One per draft key the tab has opened — a
 *  handful — each holding at most 20 answers; kept for the tab, like the cache. */
const sharedReaders = new Map<string, { deps: { current: ModelReaderDeps }; reader: ModelReader }>()

function readerOver(deps: { current: ModelReaderDeps }): ModelReader {
  const first = deps.current
  return createModelReader({
    interpret: (text) => deps.current.interpret(text),
    keyOf: (text, nowMs) => deps.current.keyOf(text, nowMs),
    ...(first.now ? { now: () => deps.current.now!() } : {}),
    ...(first.budget !== undefined ? { budget: first.budget } : {}),
  })
}

/**
 * The reader for every box on one draft. The `c` dialog and the page box under it edit ONE draft and show one
 * mode (lib/scheduleDraftState.ts), so they must share one flight and one budget: with a reader each, Tab in
 * the dialog sent its explicit read and the hidden page box's own idle sent the same text again 700ms later —
 * two Sonnet calls per mode entry and per idle edit (fix round 1, X2). With one, the second box's request finds
 * that text already out and sends nothing, and the answer lands in both. The latest box to render supplies
 * `interpret` and `keyOf`.
 */
export function sharedModelReader(key: string, deps: ModelReaderDeps): ModelReader {
  let entry = sharedReaders.get(key)
  if (!entry) {
    const holder = { current: deps }
    entry = { deps: holder, reader: readerOver(holder) }
    sharedReaders.set(key, entry)
  }
  entry.deps.current = deps
  return entry.reader
}

/** Tests only: forget the shared readers. */
export function clearSharedModelReaders(): void {
  sharedReaders.clear()
}

/** A reader for the component's lifetime — or, with `share`, the one every box on that draft uses — and a
 *  re-render whenever what it knows changes. The latest `interpret` and `keyOf` are always the ones called, so
 *  a reader never reads with a stale schedule. */
export function useModelReader(deps: ModelReaderDeps, opts: { share?: string } = {}): ModelReader {
  const latest = useRef(deps)
  latest.current = deps
  const [own] = useState(() => (opts.share === undefined ? readerOver(latest) : null))
  const reader = opts.share === undefined ? own! : sharedModelReader(opts.share, deps)
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => reader.subscribe(bump), [reader])
  return reader
}

// ---- a model reading belongs to its phrase ----------------------------------------------------------------

const WORD_CHAR = /[\p{L}\p{N}'’]/u

/** The word touching a span on one side ("" at the text's edge or across punctuation). */
function neighbour(text: string, span: Span, side: "before" | "after"): string {
  if (side === "before") {
    const m = /([\p{L}\p{N}'’]+)[^\S\n]*$/u.exec(text.slice(0, span.start))
    return m && m.index + m[0].length === span.start ? m[1]!.toLowerCase() : ""
  }
  const m = /^[^\S\n]*([\p{L}\p{N}'’]+)/u.exec(text.slice(span.end))
  return m ? m[1]!.toLowerCase() : ""
}

/**
 * Carry a model reading forward to the prose as it is now (§4.2): valid while its phrase is still there —
 * located near where it was (`near`, else where the model found it) — and NOTHING TOUCHES IT. The phrase must
 * sit on word boundaries, and the word right before it and right after it must be the ones it had when it
 * was read: typing after "every Monday unless it's a holiday" (", or a weekend") changes what it means
 * without changing the phrase's own characters, so it drops the reading, while an edit further into the
 * task keeps it. Returns the phrase's new span and the prompt re-cut from the prose with the shared
 * `cutPhrase` — byte-for-byte what the server would save — or undefined when the reading no longer holds.
 */
export function relocateModelReading(
  prose: string,
  read: { text: string; result: ModelReadOk },
  near?: number,
): { span: Span; prompt: string } | undefined {
  const { result } = read
  const span = locatePhrase(prose, result.phrase, near ?? result.phraseStart)
  if (!span) return undefined
  if ((span.start > 0 && WORD_CHAR.test(prose[span.start - 1]!)) || (span.end < prose.length && WORD_CHAR.test(prose[span.end]!))) return undefined
  const was = { start: result.phraseStart, end: result.phraseEnd }
  if (neighbour(prose, span, "before") !== neighbour(read.text, was, "before")) return undefined
  if (neighbour(prose, span, "after") !== neighbour(read.text, was, "after")) return undefined
  return { span, prompt: cutPhrase(prose, span) }
}
