import type { TranscriptMessage } from "@frizz/shared"

// Rendering-only text choice. The server keeps a generated prompt's full `text` for transcript logic
// and supplies `displayText` only when an exact presentation boundary was validated.
export function messagePresentationText(message: Pick<TranscriptMessage, "text" | "displayText">): string {
  return message.displayText ?? message.text
}

// The CURRENT ASK: the most recent user turn the HUMAN is actually waiting on an answer to. It
// supplies the retry text after a provider fault, so "who wrote it" decides it — not the `user` role,
// which the transcript also uses for machine-written turns.
//
// Excluded: a QUEUED/optimistic follow-up (it has not landed yet), a SUB-AGENT's upward report
// (`peerFrom`), and a coordinator/peer instruction delivered into a CHILD (`agentInstruction`). None is
// an ask or anything to retry; a fault retry would resend another agent's words as the human's.
// -1 when the transcript holds no human turn yet.
export function lastAskIndex(messages: readonly Pick<TranscriptMessage, "role" | "queued" | "peerFrom" | "agentInstruction">[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === "user" && !m.queued && !m.peerFrom && !m.agentInstruction) return i
  }
  return -1
}
