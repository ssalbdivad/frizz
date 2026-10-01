import { futureSnoozedUntil, type ThreadView } from "@frizz/shared"
import type { SessionIndicatorKind } from "../groups.ts"
import { hintGloss } from "./awaitingPresentation.ts"

// THE PHONE BOARD ROW'S SECOND LINE — what the thread wants, in one line.
//
// The approved phone design (2026-09-30) gives every row one line under its title, and the line answers
// a different question per state: the QUESTION for an ask, the live ACTIVITY for a running thread, the
// start of the HANDOFF for a rested one. Pure functions over a ThreadView, so the rules are testable
// without a browser and the component stays a layout.
//
// WHAT THE ROW HAS TO WORK WITH. The ThreadView carries the registered questions whole (`questions`),
// the native ask's questions (`pendingAsk`), the worker's gerund (`activity`, legacy thread files only),
// and `lastAssistant` — a preview of the newest assistant text, whitespace-collapsed and capped at ~200
// chars by the tailer (tailer.ts previewText). The collapse means the handoff's real FIRST LINE is not recoverable: its
// newlines are already spaces. What survives is its opening, which is where the house style puts the
// verdict ("Fixed —", "Needs you —"), and `handoffLine` approximates the line by stopping where the
// next block (a bullet, a fence, a heading) would have begun. An exact first line would need the server
// to keep the newline, or ship a first-line field — noted, not added here.

/** One line of text, with an optional leading verdict the row draws in the foreground weight. */
export type RowLine = { lead?: string; text: string }

/** Inline markdown removed, so a preview reads as prose: `**x**` → x, `` `x` `` → x, `[x](url)` → x. */
function plain(text: string): string {
  return text
    .replace(/```[\w-]*/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .replace(/(^|\s)[*_](\S[^*_]*?\S|\S)[*_](?=\s|$|[.,;:!?])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim()
}

/** Block markers at the head of a message: a fence opener, a heading's `#`, a quote's `>`, a bullet. */
const HEAD_MARKERS = /^(?:```[\w-]*\s*|#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/

/** Where the first line ended, in a preview whose newlines are gone: the next block that could only
 *  have started a new line — a fence, a bullet, a numbered item, a heading, a quote. A real newline, if
 *  the text still has one, wins. */
const NEXT_BLOCK = /\n|\s(?:```|[-*+]\s|\d+[.)]\s|#{1,6}\s|>\s)/

/** The opening of a message, approximating its first line: block markers at its head go, the text stops
 *  where the next block would have begun, and a bold phrase that leads it becomes the line's verdict. */
export function handoffLine(text: string | undefined): RowLine | null {
  let s = (text ?? "").trim().replace(HEAD_MARKERS, "")
  const cut = NEXT_BLOCK.exec(s)
  if (cut) s = s.slice(0, cut.index)
  if (!s.trim()) return null
  const bold = /^(\*\*|__)(.{1,60}?)\1\s*/.exec(s)
  if (bold) {
    const lead = plain(bold[2]!)
    const rest = plain(s.slice(bold[0].length))
    if (lead) return rest ? { lead, text: rest } : { text: lead }
  }
  const flat = plain(s)
  return flat ? { text: flat } : null
}

/** The first non-empty line of a question, as prose. */
function questionText(question: string): string | null {
  const first = question.split("\n").map((l) => l.trim()).find(Boolean)
  return first ? plain(first) || null : null
}

/** "2 questions", or the one question's own text when there is exactly one. */
function questionsLine(texts: readonly string[]): string | null {
  if (texts.length > 1) return `${texts.length} questions`
  return texts.length === 1 ? questionText(texts[0]!) : null
}

/** A thread parked on an armed timer: its earliest future fire instant. */
function armedTimerFireAt(t: Pick<ThreadView, "watches">, nowMs: number): string | undefined {
  let best: { at: string; ms: number } | undefined
  for (const w of t.watches ?? []) {
    if (w.kind !== "timer" || w.state !== "armed" || !w.timer) continue
    const ms = Date.parse(w.timer.fireAt)
    if (!Number.isFinite(ms) || ms <= nowMs) continue
    if (!best || ms < best.ms) best = { at: w.timer.fireAt, ms }
  }
  return best?.at
}

/**
 * When a parked thread comes back, if anything says so: the human's own snooze instant, else the
 * earliest armed timer. Undefined for a park with no clock behind it (a PR watch, the resting card's
 * event-snooze) — those wake on an event, and inventing a time for them would be a promise nobody made.
 */
export function wakeAt(t: Pick<ThreadView, "snoozedUntil" | "watches">, nowMs = Date.now()): string | undefined {
  return futureSnoozedUntil(t, nowMs) ?? armedTimerFireAt(t, nowMs)
}

/** How many sub-agents are running under the thread right now, at any depth — the count that replaced
 *  the ⤷ lines the row used to draw beneath itself. Rested and stale children do not count. */
export function liveAgentCount(t: Pick<ThreadView, "subAgents">): number {
  return (t.subAgents ?? []).filter((s) => s.state === "running").length
}

/** " · 1 agent" / " · 3 agents", appended to the second line; empty when nothing is running. */
export function agentSuffix(count: number): string {
  return count > 0 ? `${count} ${count === 1 ? "agent" : "agents"}` : ""
}

/**
 * The row's second line.
 *
 * `inMotion` is the row's own reading of "still going" (the same one that suppresses its rest age), so
 * a row that shows no age shows its activity and a row that shows an age shows its handoff.
 */
export function rowSecondLine(t: ThreadView, kind: SessionIndicatorKind, inMotion: boolean, nowMs = Date.now()): RowLine | null {
  const handoff = () => handoffLine(t.lastAssistant)
  if (kind === "needs-input") {
    const registered = questionsLine((t.questions ?? []).map((q) => q.spec.question))
    if (registered) return { text: registered }
    const native = questionsLine((t.pendingAsk?.questions ?? []).map((q) => q.question))
    if (native) return { text: native }
    if (t.runtime === "perm-prompt") return { text: "Waiting on a permission prompt" }
    const gloss = t.lastFence?.kind === "awaiting" ? hintGloss(t.lastFence.hints) : null
    return gloss ? { text: gloss } : handoff()
  }
  // `activity` is the worker's gerund, but only a legacy `.frizz` thread file carries one (frizz.ts):
  // a session thread's view never has it. What a running session thread DOES carry is the newest thing
  // its agent said, so that is the live line when there is no gerund.
  if (inMotion) return t.activity ? { text: t.activity } : handoff()
  if (kind === "snoozed" && futureSnoozedUntil(t, nowMs) !== undefined) return { text: "Snoozed by you" }
  const gloss = t.lastFence?.kind === "awaiting" ? hintGloss(t.lastFence.hints) : null
  if (gloss) return { text: gloss }
  if ((kind === "snoozed" || kind === "timer") && armedTimerFireAt(t, nowMs)) return { text: "Waiting on a timer" }
  return handoff() ?? (t.activity ? { text: t.activity } : null)
}
