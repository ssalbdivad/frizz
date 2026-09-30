import { parseAnswersCard, type PairedAnswer } from "./answersMessage.ts"
import { messagePresentationText } from "./messagePresentation.ts"

/**
 * WHAT THE HOVER READING HANGS BELOW — see components/MessageTimestamp.tsx, which turns this into the
 * one thing that differs between the two, an offset 7px apart.
 *
 * The names are the archetypes each constant was MEASURED on, and the distinction underneath them is
 * what the row's bottom edge actually is: `prose` for a row that ends on TEXT INK, which stops inside
 * its own line box and so brings its own slack; `bubble` for a row that ends on a HARD FILLED EDGE,
 * which has none and needs the clearance stated. Read the words that way and the odd members place
 * themselves — an answers card is a `bubble`, a wake divider is `prose`.
 */
export type StampHost = "prose" | "bubble"

/**
 * The shape this needs off a transcript message. Structural rather than `ChatMessage` so the module
 * stays out of the component graph and a test can build a message in one line.
 */
export interface BubbleMessageLike {
  role: string
  kind?: string
  text: string
  displayText?: string
  wake?: boolean
  peerFrom?: string
}

/**
 * Does this row end on the hard edge of something the HUMAN said?
 *
 * NOT `role === "user"`, which is what the transcript asked until 2026-08-31 and is a proxy that is
 * wrong three ways. The role records which side of the conversation a turn was recorded on — not who
 * wrote it, and not what it draws. Three shapes carry `role: "user"` and end on text ink instead:
 *
 *   · a FRIZZ WAKE — a scheduler delivery pasted into the worker's composer. Frizz wrote it, not the
 *     human, so it must not wear the human's bubble (Message says exactly that, one branch up);
 *   · a RECURRING PROMPT line — the same thing on a repeat, collapsed to one line because it restates
 *     itself every few minutes;
 *   · a SUB-AGENT REPORT — a background child pushing a message up through `SendMessage({to:"main"})`.
 *
 * All three render as hairline DIVIDERS, whose ink ends inside a line box exactly like agent prose —
 * so the role test handed the commonest rows on a driven thread the offset measured for a filled
 * rectangle and seated their reading 7px low: below its own divider and nearer the row underneath,
 * which is the "reads as the next message's" failure MessageTimestamp calls confidently wrong. A
 * `kind:"event"` or `kind:"reasoning"` row goes the same way, and for the same reason — Message tests
 * those before it looks at the role at all, and either draws a quiet line.
 *
 * Two shapes that are NOT the bubble still count as one, because the constant is about the EDGE and
 * theirs is just as hard: an ANSWERS card (bordered, filled, right-justified — the human's composed
 * reply to a question block) and an ATTACHMENT-ONLY send, which skips the bubble and ends on a framed
 * picture or a row of file pills. The SPINOFF cards are the same case (Spinoff.tsx): a request in the
 * parent and a child's first turn are outlined, right-justified cards, not bubbles — but an outline is as
 * hard an edge as a fill, so they fall through to `true` with the bubble and need no branch here.
 *
 * THIS MIRRORS `Message`'s BRANCH ORDER (components/ChatView.tsx) AND MUST MOVE WITH IT — a shape that
 * stops drawing a bubble, or a new one that starts, belongs in both. It is a separate function rather
 * than something Message returns because the host is needed by the row WRAPPER, which renders before
 * its child and so cannot ask it. `stampHost.test.ts` pins every shape above.
 */
export function messageEndsOnUserEdge(m: BubbleMessageLike, paired?: PairedAnswer[] | null): boolean {
  if (m.kind === "event" || m.kind === "reasoning") return false
  if (m.role !== "user") return false
  // The answers card keeps the hard edge, so it is settled before the dividers rather than with them.
  // `paired` is the caller's already-parsed pairing and `undefined` means "not computed" — the same
  // distinction Message draws before falling back to the parse.
  const text = messagePresentationText(m).replace(/\r\n?/g, "\n")
  if (paired !== undefined ? paired : parseAnswersCard(text)) return true
  // One test for two rows: a recurring prompt is a wake whose trailer parses, and Message draws both as
  // hairlines, so the wake flag alone settles them. Frizz's own trailer is the tell, never the words.
  if (m.wake) return false
  if (m.peerFrom) return false
  return true
}

/** The host the reading takes, for a transcript row that renders one message. */
export function stampHostFor(m: BubbleMessageLike, paired?: PairedAnswer[] | null): StampHost {
  return messageEndsOnUserEdge(m, paired) ? "bubble" : "prose"
}
