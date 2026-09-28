// WHERE A REGISTERED QUESTION SITS IN THE TRANSCRIPT: at the BOTTOM of the exchange that asked it — after
// every word the worker wrote there, never inside a message — and that exchange runs until the HUMAN
// next speaks, however many times frizz woke the worker in between.
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
// above it. A wake is frizz moving the thread, not the human replying; nobody has said anything, so the
// ask is exactly as current after it as before. So only the HUMAN'S turn ends the exchange a question
// belongs to — a typed message, or the answers to other questions — and the 2026-09-24 case stands: the
// human replied past it, so the card stays up with the handoff that asked it. A worker whose newer
// handoff still owes that ask asks it again, which lands the new card at the bottom of that handoff.

import { BURIED_ANSWERS_HEADER } from "@frizz/shared"

export interface AnchorMessage {
  role: string
  kind?: string
  at?: string
  /** Frizz wrote this user record (a scheduler wake), not the human. */
  wake?: boolean
  /** A sub-agent's upward report, recorded as a user turn it did not type either. */
  peerFrom?: string
  text?: string
}

/** Did the HUMAN take this turn? A typed reply, or the answers to registered questions — which frizz
 *  delivers as a wake, in the buried-answers form, because the human may answer while the worker is down:
 *  frizz carried it, the human said it. Every other wake (a watcher, a timer, a sign-off nudge, a Goal)
 *  and a sub-agent's report are frizz and the worker's own children moving the thread, and the ask is as
 *  current after them as before. Punctuation with a nominal role (an event line, a reasoning summary) is
 *  not a turn at all. */
export function isHumanTurn(m: AnchorMessage): boolean {
  if (m.role !== "user" || m.kind === "event" || m.kind === "reasoning" || m.peerFrom) return false
  return !m.wake || (m.text ?? "").trimStart().startsWith(BURIED_ANSWERS_HEADER)
}

/** The index of the message this question renders AFTER — the last message before the human's next
 *  turn. `messages.length - 1` when the human has not spoken since (the common case — the worker asked
 *  and rested, and the card is the tail however many wakes it has worked through since), and `-1` when
 *  the exchange it belongs to is older than the loaded window, which puts it at the top of what is loaded
 *  rather than back at the bottom where it would lie about being current. */
export function questionAnchorIndex(messages: readonly AnchorMessage[], askedAt: string): number {
  const asked = Date.parse(askedAt)
  const tail = messages.length - 1
  if (!Number.isFinite(asked)) return tail
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (!isHumanTurn(m)) continue
    const at = m.at ? Date.parse(m.at) : Number.NaN
    if (!Number.isFinite(at) || at <= asked) continue
    return i - 1
  }
  return tail
}

/** Every question grouped by the message index it renders after, so a call site walks the transcript once
 *  and drops each group in place. Questions asked in ONE `ask` call share an instant and therefore a
 *  group, which is what keeps a batch rendering as one stack. */
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
