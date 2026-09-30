import type { SpinoffView, ThreadView, TranscriptToolCall } from "@frizz/shared"
import type { ChatMessage } from "../hooks.ts"

// THE CALL THAT STARTED A SPINOFF IS NOT DRAWN (2026-09-30). The parent's chat shows the request as its
// own card, linked to the thread it became (Spinoff.tsx SpinoffCard), so the worker's `spawn_thread`
// call behind it is that same event a second time — and the one thing the reader needs from it, which
// thread it started, the card already says by name. Drawn, it was a `Ran 1 tool call` digest (or one
// more call in a digest) directly under the card, for nothing.
//
// Keyed on the SERVER's tell, `TranscriptToolCall.spinoff` (the request id the call names,
// spinoffIdOfSpawnCall), never on the tool's name: an ordinary `spawn_thread` — a worker starting a
// thread of its own accord — is work the reader has not seen anywhere else, and keeps its line.
//
// ONLY A CALL THE CARD DEMONSTRABLY STANDS FOR (2026-09-30, review). The tell is stamped from the call's
// INPUT, at tool_use time, before any result exists (transcript.ts, acp-transcript.ts) — so on its own it
// says "this call named the request", not "this call started the thread". The first cut hid on the tell
// alone, and that hid exactly the calls the reader most needed:
//   · a call the server REFUSED — a bad model, "already being dispatched", "requested from another
//     thread", a dispatch error (router.ts fulfilSpinoff). Its tool error is the one record of why the
//     spinoff did not start, the worker is told to say nothing more after the call, and the card above it
//     reads "didn't start" with no reason anywhere;
//   · a call that DID start a thread the edge never learned of — an old MCP server that ignored the
//     `spinoff` arg, where the edge recovery cannot read the call either (an ACP agent's own title for the
//     tool, a Codex exec-wrapper spawn). The card says "didn't start"; the call's result, naming the
//     thread that really exists, was the only line that said otherwise.
// So a call is hidden only when BOTH hold: the thread's edge for that request carries a child (the card
// links it), and the call did not fail. Either alone is not enough — a request that started on a retry
// has a child AND the earlier failed attempt, which must keep its line; and a call that succeeded but
// stamped no edge leaves the card nothing to link. A call still in flight whose edge is already stamped
// (fulfilSpinoff writes the child before the tool result returns) is hidden too, so the line never
// flashes up and vanishes when the result lands.
//
// Stripped from the message LIST, ahead of every reader of it — the tool-run coalescer, the row
// builders' spacing and "renders nothing" walks, the live shimmer's run — rather than skipped in the
// renderer alone. A message whose only content was the call is then empty everywhere at once, which is
// what those readers already know how to drop (transparentAssistantMessage, messageRendersNothing); a
// renderer-only skip would have left each of them charging a gap for a row that draws nothing.
//
// The array keeps its LENGTH and every untouched message keeps its IDENTITY: paired answers, the fence
// cut and the answering controller all index or compare into this list.

/** The spinoff requests of `thread` that started a thread — the ones its cards link. Returned as a
 *  sorted, comma-joined KEY rather than a set: the board replaces every thread object (and its
 *  `spinoffs` array) on each push, and the transcript's list must not be rebuilt on a tick that changed
 *  nothing about which requests started. */
export function startedSpinoffsKey(thread: Pick<ThreadView, "id" | "spinoffs"> | undefined): string {
  if (!thread?.spinoffs?.length) return ""
  return thread.spinoffs
    .filter((edge: SpinoffView) => edge.parentSlug === thread.id && edge.childSlug)
    .map((edge) => edge.id)
    .sort()
    .join(",")
}

/** Whether a tool call is the one that started a spinoff's thread: it names a request that has a child,
 *  and it did not fail. */
export function isSpinoffCall(tool: Pick<TranscriptToolCall, "spinoff" | "status">, started: ReadonlySet<string>): boolean {
  return tool.spinoff !== undefined && started.has(tool.spinoff) && tool.status !== "failed" && tool.status !== "cancelled"
}

/** The transcript with every call that started a spinoff (`startedKey`, startedSpinoffsKey) removed from
 *  both `tools` and `parts` (a message off the wire carries each call twice, as separate objects, so both
 *  lists are filtered by the tell rather than by identity). */
export function withoutSpinoffCalls(messages: readonly ChatMessage[], startedKey: string): ChatMessage[] {
  if (!startedKey) return [...messages]
  const started = new Set(startedKey.split(","))
  const hidden = (tool: TranscriptToolCall) => isSpinoffCall(tool, started)
  return messages.map((message) => {
    if (!message.tools.some(hidden) && !message.parts?.some((part) => part.kind === "tools" && part.tools.some(hidden))) return message
    const parts = message.parts
      ?.map((part) => (part.kind === "tools" ? { ...part, tools: part.tools.filter((tool) => !hidden(tool)) } : part))
      .filter((part) => part.kind !== "tools" || part.tools.length > 0)
    return { ...message, tools: message.tools.filter((tool) => !hidden(tool)), parts }
  })
}
