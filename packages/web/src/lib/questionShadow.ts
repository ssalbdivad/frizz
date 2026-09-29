// ONE QUESTION, ONE CARD — folding a ```question fence into the registered question it restates, and
// placing every open card at the bottom of the newest rest (questionStacks; see MARKERS at the foot of
// this file for the empty ```question qst_… marker, which places nothing any more — a card is always
// drawn at the bottom of its rest, after everything the worker wrote there).
//
// A worker can ask the same question twice at one rest: register it with `ask` (a row, the durable
// form) and then, at sign-off, write it again as a ```question fence because the contract says the
// fence is the handback. Both producers reach QuestionBlockCard, so the transcript drew the question
// twice, back to back, on the thread page and the queue card (maintainer 2026-08-28: "Same question
// showing up twice in a row" — a release go/no-go registered at 10:11 and re-fenced at 10:11 with
// "(also on the board as a card)" appended, after two PR-watcher wakes had buried the first fence).
//
// The REGISTERED card is the one that survives, and it is not a coin toss: answering it settles the
// row, which is what un-gates `done` and dequeues the thread; answering the fence sends a plain
// follow-up and leaves the row open behind it, so the worker wakes to an answer it cannot `done` past.
// (lib/registeredDone.ts folds the other way — a fenced done beside a registered one keeps the message's
// card — because there the two are the same bytes and nothing is settled by which one is drawn.)
//
// A fence is folded only when it demonstrably RESTATES a registration standing at the SAME REST. A
// different question fenced beside a registered one still renders — the fold never hides a question
// the human has not seen elsewhere on the page. The text rule is deliberately loose about markup (the
// fence wraps `code` and [links](…) that the registration's plain string cannot carry) and about
// trailing prose (the worker appends a parenthetical), and strict about the question itself.
import type { RegisteredQuestionView } from "@frizz/shared"
import { type AnchorMessage, isHumanTurn, questionsByAnchor } from "./questionAnchor.ts"
import { type MessageSegment, parseQuestionBlock, splitQuestionBlocks } from "./questionBlocks.ts"

/** Where the exchange that ASKED a question begins: the message after the last turn the human typed
 *  before it was asked, or 0 when that is above the loaded window. Frizz's wakes and answer deliveries
 *  inside it are the same exchange (lib/questionAnchor isHumanTurn), so a fence the worker wrote before
 *  a watcher woke it and then registered the same question is still "this question". */
function askingExchangeStart(messages: readonly AnchorMessage[], askedAt: string): number {
  const asked = Date.parse(askedAt)
  let at = messages.length - 1
  if (Number.isFinite(asked)) {
    while (at >= 0) {
      const t = messages[at].at ? Date.parse(messages[at].at!) : Number.NaN
      if (Number.isFinite(t) && t <= asked) break
      at--
    }
  }
  for (let i = at; i >= 0; i--) {
    if (isHumanTurn(messages[i])) return i + 1
  }
  return 0
}

/** The registered questions STANDING at each message, keyed by message index: every message of the
 *  exchange a question was asked in AND of everything after it, so a fence anywhere from the ask onward
 *  can be checked against it. A question stands until it is answered, dismissed or withdrawn, whatever
 *  the human says meanwhile — the worker's NEXT handoff may name it again, and that fence must fold
 *  exactly as one at the asking rest does. Until 2026-08-28 only the asking rest saw it, so a marker in a
 *  later handoff drew its own slot while the card sat at its anchor (maintainer: "why is the question
 *  showing up above my last message?"). A question asked above the loaded window stands at every loaded
 *  message: its rest is off the page, and everything on the page is later. User records map to nothing
 *  — a human turn, a wake or a sub-agent's report carries no fence of the worker's. */
export function registeredStandingAt<Q extends { askedAt: string }>(
  messages: readonly AnchorMessage[],
  questions: readonly Q[],
): Map<number, Q[]> {
  const byMessage = new Map<number, Q[]>()
  for (const q of questions) {
    for (let i = askingExchangeStart(messages, q.askedAt); i < messages.length; i++) {
      if (messages[i].role === "user") continue
      const at = byMessage.get(i)
      if (at) at.push(q)
      else byMessage.set(i, [q])
    }
  }
  return byMessage
}

// Shorter than this and a match says nothing — "Proceed?" restates every go/no-go ever asked.
const MIN_MATCH = 12

/** Markup-blind, whitespace-blind, case-blind text: what the two producers have in common once the
 *  fence's markdown is gone. */
function normalize(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

/** The question proper: everything up to and including the first `?`, or nothing when there is none. */
function head(text: string): string | undefined {
  const at = text.indexOf("?")
  return at === -1 ? undefined : text.slice(0, at + 1)
}

/** Does this ```question fence body restate one of `registered`? The fence's context (its prose above
 *  the option run) either contains the registered question, is a prefix of it, or asks the same thing —
 *  carries its `?`-terminated head, or opens with one the registration carries — with different context
 *  around it. */
export function fenceRestatesRegistered(
  body: string,
  registered: readonly Pick<RegisteredQuestionView, "spec">[],
): boolean {
  if (registered.length === 0) return false
  const context = normalize(parseQuestionBlock(body, "question").contextMd)
  if (context.length < MIN_MATCH) return false
  const contextHead = head(context)
  return registered.some(({ spec }) => {
    const asked = normalize(spec.question)
    if (asked.length < MIN_MATCH) return false
    if (context.includes(asked) || asked.startsWith(context)) return true
    const askedHead = head(asked)
    if (askedHead !== undefined && askedHead.length >= MIN_MATCH && context.includes(askedHead)) return true
    return contextHead !== undefined && contextHead.length >= MIN_MATCH && asked.includes(contextHead)
  })
}

/** The registration a ```question fence STANDS FOR, if any: the one its info-string id names, else the
 *  one its prose restates. The id is exact and the prose is not, so a worker that writes
 *  ```question qst_ab12cd34 never depends on the text rule above. */
export function fenceStandsFor<Q extends Pick<RegisteredQuestionView, "id" | "spec">>(
  seg: Extract<MessageSegment, { kind: "question" }>,
  registered: readonly Q[],
): Q | undefined {
  if (seg.registeredId) return registered.find((q) => q.id.toLowerCase() === seg.registeredId)
  return registered.find((q) => fenceRestatesRegistered(seg.text, [q]))
}

// ---- MARKERS: a fence that folds, and places nothing ---------------------------------------------
//
// An empty ```question qst_… fence was a PLACEMENT MARKER from 2026-08-28 to 2026-08-30 and again from
// 2026-09-11 to 2026-09-28: the registered card it named rendered IN ITS SLOT, so a worker could couch a
// question inside its own handoff — the setup above it, the card, then what happens either way. Couched
// is exactly what the maintainer objected to, twice. Retired the first time on usage data (15 of 17
// real markers sat at the tail, where the card lands with no marker at all); back on 2026-09-11 when the
// free-form fence was retired, because the marker names a ROW rather than inviting a guess from prose;
// retired again when the prose under the card was the problem: a rebase handoff put its "move main
// now?" card above two thousand characters of judgment calls and verification (maintainer 2026-09-28:
// "questions should always appear at the bottom of the thread not in the middle any explanation should
// occur beforehand"). On this machine 7 of the 15 markers written since the restore had prose under them.
//
// So a card NEVER renders inside a message. It renders after the rest it belongs to — below the whole
// handoff — and a marker draws nothing in its own slot, whatever it names.
//
// A marker once also CARRIED its question to a later handoff: a worker dispatched before 2026-09-28 was
// taught to bring an open question forward by writing its marker into the newer handoff, because a
// question the human replied past stayed up at the rest that asked it. Since 2026-09-29 every open
// question rides to the newest rest on its own (lib/questionAnchor), so a marker can only ever point at a
// rest the card has already reached, and carries nothing. It is still read — as a fence that must fold.

/** The ids a message's markers name, lowercased, in order — the empty-bodied ```question qst_… fences
 *  only. A fence WITH a body is a legacy question (or, under the new contract, prose), never a marker. */
export function markerIdsIn(text: string): string[] {
  if (!text.includes("```question")) return []
  return splitQuestionBlocks(text).flatMap((seg) => seg.kind === "question" && seg.registeredId && seg.text.trim() === "" ? [seg.registeredId] : [])
}

/** The index moved up past the frizz event rows that close a rest ("Agent rested" above all). A card
 *  anchored ON that divider falls below it, outside the rest it was asked at, reading as the start of
 *  whatever the human said next; anchored here it sits under the handoff and above the divider. */
export function aboveTrailingEvents(messages: readonly AnchorMessage[], anchor: number): number {
  let at = anchor
  while (at > 0 && messages[at].kind === "event") at--
  return at
}

/** WHERE EACH QUESTION'S CARD RENDERS: every question grouped by the index of the message its stack
 *  renders AFTER — the bottom of the newest rest since it was asked (lib/questionAnchor), never inside
 *  one of its messages. -1 is a rest older than the loaded window. Every open question shares the newest
 *  rest, so a batch — and the questions of several asks still open — render as one stack.
 *
 *  A rest a turn has started after (the human typed, an answer or a wake was delivered, and the worker is
 *  working) ends at its "Agent rested" divider, and the card goes ABOVE that divider, exactly where its
 *  greyed twin lands once answered (lib/settledQuestions), so answering it does not make it jump. The
 *  TAIL keeps its anchor (`messages.length - 1`): the divider there draws nothing, and the surfaces read
 *  that index as the interactions row. */
export function questionStacks<Q extends Pick<RegisteredQuestionView, "id"> & { askedAt: string }>(
  messages: readonly (AnchorMessage & { text?: string })[],
  questions: readonly Q[],
): Map<number, Q[]> {
  const stacks = new Map<number, Q[]>()
  if (questions.length === 0) return stacks
  for (const [anchor, group] of questionsByAnchor(messages, questions)) {
    const at = anchor >= 0 && anchor < messages.length - 1 ? aboveTrailingEvents(messages, anchor) : anchor
    const stack = stacks.get(at)
    if (stack) stack.push(...group)
    else stacks.set(at, [...group])
  }
  return stacks
}
