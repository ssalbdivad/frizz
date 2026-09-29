// The one rule QueueCardHistory.tsx needs that is not rendering, apart so it can be tested without React.
import type { ThreadHandoff, TranscriptMessage } from "@frizz/shared"

/**
 * Where the card's own exchange starts in `messages`: the human's last message (the card's bubble), else
 * the handoff itself, located by the timestamps the server's handoffOf read them at. Everything before it
 * is history. A cut the page does not hold (a long last turn pushed the human's message off the latest
 * page) falls back to the handoff, and then to the whole page.
 */
export function historyCut(messages: readonly (Pick<TranscriptMessage, "role" | "at" | "kind"> & { queued?: boolean })[], handoff: Pick<ThreadHandoff, "askedAt" | "at"> | undefined): number {
  const find = (match: (m: (typeof messages)[number]) => boolean) => {
    for (let i = messages.length - 1; i >= 0; i--) if (match(messages[i]!)) return i
    return -1
  }
  if (handoff?.askedAt) {
    const asked = find((m) => m.role === "user" && !m.queued && m.at === handoff.askedAt)
    if (asked >= 0) return asked
  }
  if (handoff?.at) {
    const reply = find((m) => m.role === "assistant" && !m.kind && m.at === handoff.at)
    if (reply >= 0) return reply
  }
  return messages.length
}
