// WHERE A REGISTERED QUESTION SITS IN THE TRANSCRIPT: at the BOTTOM of the newest handoff the worker has
// rested on since asking it — after every word the worker wrote there, never inside a message — however
// many times the thread moved in between (see the 2026-09-29 note below for how it got here).
//
// A ```question fence needs none of this — it IS a message, so it renders where it was written. A
// REGISTERED question is a row in `thread_question` with no message to live in, so its position is a
// decision, and it was the wrong one until 2026-08-27: the card was pinned above the composer with the
// pending-interaction stack, on the reasoning that neither may scroll out of reach. That holds only
// while the question is the newest thing on the thread. The moment the human replies past it without
// answering — which they may, the composer is right there — the card sits UNDER their own newest
// message and under everything the worker has done since, claiming to be the current ask (maintainer
// 2026-08-27: "Questions are still showing up for me between my most recent message and the agent
// outputs that have happened since that message. That doesn't make any sense. The questions should show
// up in the chat wherever the session came to rest").
//
// The 2026-08-27 fix froze the card at the rest that ended the turn it was asked in — and that reading
// broke on the OTHER half of the same scenario. The human replies past the card, the worker answers the
// follow-up and rests AGAIN with the question still open: the new rest is now the handoff the human
// reads, and it shows no ask at all. The card sits stranded above their own reply, the tail reads as a
// bare stop, and the sign-off nudge rightly stands down because the open row IS the thread's sign-off
// (maintainer 2026-08-31, on exactly that transcript: "Why was this able to come to rest without a
// proper handoff?"). "Wherever the session came to rest" means the CURRENT rest, not the historical one.
//
// And that reading was reversed in turn on 2026-09-24. Dragging every open question to the newest rest
// assumes the ask is still CURRENT, and the case that actually produces a later rest with a question
// still open is the one where it is not: the human sent more messages that obviated it, or the worker
// did something that made it moot, and the newest handoff is about something else. The card then sat
// under that handoff claiming to be its ask — a placeholder-package question from the first round of
// names, drawn beneath the write-up of the second round (maintainer 2026-09-24: "it should move up in
// the chat appropriately").
//
// 2026-09-28 closed the two ways a card still landed mid-thread with the worker's explanation BELOW it
// (maintainer: "questions should always appear at the bottom of the thread not in the middle any
// explanation should occur beforehand"). One was the placement marker, which drew the card inside a
// handoff with paragraphs under it — retired, see lib/questionShadow. The other was frizz's OWN
// deliveries ending the exchange: a PR watcher expired, frizz woke the worker, it re-armed and wrote "the
// merge question from my last message is still the open decision" — under a card the wake had frozen
// above it.
//
// AND ON 2026-09-29 THE HUMAN'S TURN STOPPED ENDING IT TOO — the 2026-08-31 reading, back, for a reason
// the 2026-09-24 reversal did not have. Two things changed that day. Answers arrive one question at a
// time, so an answer delivery is now the ordinary thing that follows a batch of cards: counted as the
// human's turn, it froze the unanswered rest above the answer, and once the worker acted on it and
// rested, its newest handoff showed no ask at all while the cards it still owed sat higher up. And a
// typed message stopped releasing the questions it passed (shared questionRepliedPast): a timestamp
// released seven the human still meant to answer when they typed a side question, so the WORKER decides
// now, `unask`ing the ones the message made moot. What is still open after that is still current by the
// worker's own judgment — which is the premise the 2026-09-24 reversal found missing.
//
// So an open question renders at the bottom of the NEWEST REST — the last "Agent rested" boundary the
// server emits (transcript.ts restMessage) — at or after it was asked. While a turn is running past that
// rest (the human typed, an answer or a wake was delivered), the card stays where it was, at the bottom
// of the handoff the human was reading, instead of riding under the worker's streaming output; the
// moment the worker rests again it moves to the bottom of that new handoff. A question asked in the turn
// still running, or on a thread at rest, is the tail.

import type { TranscriptMessage } from "@frizz/shared"

export interface AnchorMessage {
  role: string
  kind?: string
  /** Which divider an `event` row is — `rest` is the agent coming to rest (transcript.ts). */
  boundary?: TranscriptMessage["boundary"]
  at?: string
  /** Frizz wrote this user record (a scheduler wake), not the human. */
  wake?: boolean
  /** A sub-agent's upward report, recorded as a user turn it did not type either. */
  peerFrom?: string
  text?: string
}

/** Did the HUMAN TYPE this turn? Frizz's wakes are not the human (a watcher, a timer, a sign-off nudge, a
 *  Goal), and neither is a sub-agent's report — and since 2026-09-29 neither is the delivery of their
 *  answers: an answer is one card of a batch, not the human moving the conversation on, and counting it
 *  froze the rest of the batch above it. The same reading as the tailer's `lastHumanAt`. (The router's
 *  `handoffOf` still counts an answer, on purpose: it asks what the newest handoff is a reply TO.)
 *  Punctuation with a nominal role (an event line, a reasoning summary) is not a turn at all. */
export function isHumanTurn(m: AnchorMessage): boolean {
  if (m.role !== "user" || m.kind === "event" || m.kind === "reasoning" || m.peerFrom) return false
  return !m.wake
}

/** The agent came to rest here — the server's own divider, off the provider's end-of-turn signal. */
export function isRestBoundary(m: AnchorMessage): boolean {
  return m.kind === "event" && m.boundary === "rest"
}

/** Anything that is a TURN happening, as opposed to the transcript's punctuation. */
function isActivity(m: AnchorMessage): boolean {
  return m.kind !== "event" && m.kind !== "reasoning"
}

/** The index of the message this question renders AFTER: the newest rest at or after it was asked — its
 *  "Agent rested" row, which the caller lifts the card above (questionShadow aboveTrailingEvents) — or
 *  `messages.length - 1`, the tail, when that rest IS the tail (the thread is at rest) or the question was
 *  asked after it (the worker asked in the turn still running). `-1` when the rest it belongs to is older
 *  than the loaded window, which puts it at the top of what is loaded rather than at the bottom where it
 *  would lie about being current. */
export function questionAnchorIndex(messages: readonly AnchorMessage[], askedAt: string): number {
  const asked = Date.parse(askedAt)
  const tail = messages.length - 1
  if (!Number.isFinite(asked)) return tail
  for (let i = tail; i >= 0; i--) {
    const m = messages[i]
    if (!isRestBoundary(m)) continue
    const at = m.at ? Date.parse(m.at) : Number.NaN
    // The newest rest came before the ask, or cannot be dated: the worker asked in the turn still going.
    if (!Number.isFinite(at) || at < asked) return tail
    for (let j = i + 1; j <= tail; j++) if (isActivity(messages[j])) return i
    return tail
  }
  // No rest in the window at all: a question asked inside it is from the turn still running; one asked
  // before its first dated message belongs to a rest above it.
  const first = messages.find((m) => m.at && Number.isFinite(Date.parse(m.at)))
  return first && Date.parse(first.at!) > asked ? -1 : tail
}

/** Every question grouped by the message index it renders after, so a call site walks the transcript once
 *  and drops each group in place. Every open question shares the newest rest, so questions asked at
 *  different rests — and a batch — render as one stack at the bottom of the newest handoff. */
export function questionsByAnchor<Q extends { askedAt: string }>(
  messages: readonly AnchorMessage[],
  questions: readonly Q[],
): Map<number, Q[]> {
  const byAnchor = new Map<number, Q[]>()
  for (const q of questions) {
    const anchor = questionAnchorIndex(messages, q.askedAt)
    const group = byAnchor.get(anchor)
    if (group) group.push(q)
    else byAnchor.set(anchor, [q])
  }
  return byAnchor
}
