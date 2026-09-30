import type { TranscriptToolCall } from "@frizz/shared"
import type { ChatMessage } from "../hooks.ts"

// THE CALL THAT STARTED A SPINOFF IS NOT DRAWN (2026-09-30). The parent's chat shows the request as its
// own card, linked to the thread it became (Spinoff.tsx SpinoffCard), so the worker's `spawn_thread`
// call behind it is that same event a second time — and the one thing the reader needs from it, which
// thread it started, the card already says by name. Drawn, it was a `Ran 1 tool call` digest (or one
// more call in a digest) directly under the card, for nothing.
//
// Keyed on the SERVER's tell, `TranscriptToolCall.spinoff` (the request id the call fulfils,
// spinoffIdOfSpawnCall), never on the tool's name: an ordinary `spawn_thread` — a worker starting a
// thread of its own accord — is work the reader has not seen anywhere else, and keeps its line.
//
// Stripped from the message LIST, ahead of every reader of it — the tool-run coalescer, the row
// builders' spacing and "renders nothing" walks, the live shimmer's run — rather than skipped in the
// renderer alone. A message whose only content was the call is then empty everywhere at once, which is
// what those readers already know how to drop (transparentAssistantMessage, messageRendersNothing); a
// renderer-only skip would have left each of them charging a gap for a row that draws nothing.
//
// The array keeps its LENGTH and every untouched message keeps its IDENTITY: paired answers, the fence
// cut and the answering controller all index or compare into this list.

/** Whether a tool call is the one that fulfilled a spinoff request. */
export function isSpinoffCall(tool: Pick<TranscriptToolCall, "spinoff">): boolean {
  return tool.spinoff !== undefined
}

/** The transcript with every spinoff-fulfilling call removed from both `tools` and `parts` (a message
 *  off the wire carries each call twice, as separate objects, so both lists are filtered by the tell
 *  rather than by identity). */
export function withoutSpinoffCalls(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (!message.tools.some(isSpinoffCall) && !message.parts?.some((part) => part.kind === "tools" && part.tools.some(isSpinoffCall))) return message
    const parts = message.parts
      ?.map((part) => (part.kind === "tools" ? { ...part, tools: part.tools.filter((tool) => !isSpinoffCall(tool)) } : part))
      .filter((part) => part.kind !== "tools" || part.tools.length > 0)
    return { ...message, tools: message.tools.filter((tool) => !isSpinoffCall(tool)), parts }
  })
}
