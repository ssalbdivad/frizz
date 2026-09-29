import type { TranscriptMessage } from "@frizz/shared"
import { isBrokerClaudeRow, type SessionRow, type Storage } from "./storage.ts"

// Every Nth operator message on a thread, write its live STATUS from the RECENT conversation.
//
// This began (a7be3046, 2026-09-24) as a periodic RETITLE: a long thread drifts, and by its twentieth
// exchange the operator is steering something the opening prompt never mentioned (maintainer: "every x
// messages on a single thread (maybe 5?), update the summary title … to focus on the recent
// conversation"). That was the right signal in the wrong field. A name that moves every five messages is
// not a name — the reader loses which card is which — so on 2026-09-29 the maintainer split the two: the
// NAME is one or two stable words for the subject (thread-names.ts), and what is happening NOW is a
// separate `status` this pass writes. It NEVER writes the name, whoever set it.
//
// The window is the last few EXCHANGES — the operator's own words plus the agent's replies — not the
// newest line alone (issue #22: a summary fed only the newest reply describes the last agent action).
//
// What counts is the OPERATOR's messages, not every user-role record: frizz's wakes, a child's upward
// `SendMessage`, completion boundaries and still-queued bubbles are all user-side turns nobody typed,
// and counting them would rewrite a quiet thread's status every few watcher ticks.
export const STATUS_EVERY_MESSAGES = 5
// Enough to say what the conversation is doing, bounded well under anything a one-shot should carry.
const PER_MESSAGE_CHARS = 1_500
const CONVERSATION_CHARS = 12_000

export function operatorMessages(messages: readonly TranscriptMessage[]): TranscriptMessage[] {
  return messages.filter((m) =>
    m.role === "user" && !m.wake && !m.peerFrom && !m.agentInstruction && !m.boundary && !m.kind && !m.queued &&
    (m.displayText ?? m.text).trim() !== "")
}

/** The last `window` operator messages and every agent reply among them, as a transcript the status
 *  writer can read. Undefined when there is nothing to read. */
export function recentConversation(messages: readonly TranscriptMessage[], window = STATUS_EVERY_MESSAGES): string | undefined {
  const ops = operatorMessages(messages)
  if (ops.length === 0) return undefined
  const from = messages.indexOf(ops[Math.max(0, ops.length - window)]!)
  const opSet = new Set(ops)
  const lines: string[] = []
  for (const m of messages.slice(from)) {
    const isOp = opSet.has(m)
    if (!isOp && (m.role !== "assistant" || m.kind || m.boundary)) continue
    const text = (isOp ? m.displayText ?? m.text : m.text).trim()
    if (!text) continue
    const clipped = text.length > PER_MESSAGE_CHARS ? `${text.slice(0, PER_MESSAGE_CHARS)}…` : text
    lines.push(`${isOp ? "User" : "Assistant"}: ${clipped}`)
  }
  // Keep the NEWEST end when the window overflows — the recent turns are the point.
  const body = lines.join("\n\n")
  return body.length > CONVERSATION_CHARS ? `…${body.slice(body.length - CONVERSATION_CHARS)}` : body
}

export interface PeriodicStatusDeps {
  storage: Pick<Storage, "getSession" | "setStatus">
  /** The status writer (thread-names.ts `ThreadNamer.status`). Absent ⇒ no status is ever written. */
  writeStatus?: (input: { name?: string; conversation: string }) => Promise<string | undefined>
  /** The thread's current NAME, handed to the writer only so the status does not repeat it. */
  nameOf?: (row: SessionRow) => string | undefined
  readMessages: (sessionId: string) => TranscriptMessage[]
  onStatus: () => void
  onError?: (slug: string, error: unknown) => void
  every?: number
}

export interface PeriodicStatus {
  /** Call at every live rest. Fire-and-forget: a status never delays anything. */
  onTurnDone(row: SessionRow): void
}

export function createPeriodicStatus(deps: PeriodicStatusDeps): PeriodicStatus {
  const every = Math.max(1, deps.every ?? STATUS_EVERY_MESSAGES)
  // The last multiple-of-`every` each session was summarized at. In memory on purpose: the first rest a
  // session shows this process only RECORDS its count, because this process cannot know whether the
  // previous one already covered that window — so a restart costs at most one missed window and never
  // a burst of status requests across every live thread.
  const doneAt = new Map<string, number>()
  const inFlight = new Set<string>()
  return {
    onTurnDone(row) {
      // Broker Claude rows only: `readMessages` reads a Claude transcript.
      if (!deps.writeStatus || !isBrokerClaudeRow(row)) return
      const key = `${row.slug}\0${row.session_id}`
      if (inFlight.has(key)) return
      const messages = deps.readMessages(row.session_id)
      const bucket = Math.floor(operatorMessages(messages).length / every)
      const prev = doneAt.get(key)
      doneAt.set(key, Math.max(bucket, prev ?? 0))
      if (prev === undefined || bucket <= prev || bucket === 0) return
      const conversation = recentConversation(messages, every)
      if (!conversation) return
      inFlight.add(key)
      void deps.writeStatus({ name: deps.nameOf?.(row), conversation })
        .then((status) => {
          if (!status) return
          // Keyed on the session it was read from: a re-dispatch over the slug while the writer ran
          // must not inherit the old session's status.
          if (deps.storage.setStatus(row.slug, row.session_id, status)) deps.onStatus()
        })
        .catch((error: unknown) => deps.onError?.(row.slug, error))
        .finally(() => inFlight.delete(key))
    },
  }
}
