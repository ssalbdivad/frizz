// THE STEPS on a resting card whose ```awaiting fence hands the human `steps:` (2026-10-03) — things
// only they can perform: a sign-in, an approval, a merge the worker may not make. They ride the fence
// itself rather than a registered row (maintainer 2026-10-03: "I don't think this requires persistently
// registering it. Is there a way to do this just inside of the awaiting card?"), so this is a stratum
// of AwaitingBackgroundCard, not a card of its own.
//
// ONE VERB, AND IT SENDS AN ORDINARY REPLY. "Done" sends the human's own message — the word itself —
// through the same eager follow-up the composer uses, so it lands as their bubble, wakes the worker
// exactly as anything they type would, and rolls back the same way if the send fails. There is no
// second verb and no note box: anything else the human has to say — a step that failed, what account
// they signed in with — goes through the prompt box under the card like any other steer (maintainer
// 2026-10-03: "The user can just send a new steer message in the prompt box if they want."). Nothing
// is stored and nothing settles: the fence lives as long as the message carrying it, and the reply is
// what ends it.
import { useState } from "react"
import { STEPS_DONE } from "../lib/awaitingPresentation.ts"
import { useEagerFollowUp } from "../lib/eagerComposerSubmission.ts"
import { useMarkdownHtml } from "../lib/useMarkdown.ts"
import { LinkedHtml } from "./LinkedHtml.tsx"
import { CARD_PRIMARY_ACTION, CardActions, QUEUE_WRAP } from "./TranscriptCard.tsx"

/** The numbered steps — what the human reads before doing anything. */
export function StepsList({ steps }: { steps: readonly string[] }) {
  return (
    // One markdown block PER STEP inside a real list, rather than the steps joined into one markdown
    // string: a step carries its own code span or link, and joined steps would each need re-indenting
    // to stay inside their item. `md-body` supplies the list rhythm and the muted markers the
    // transcript's own lists wear.
    //
    // THE SAME PROSE AS THE PARAGRAPH ABOVE IT, in strength and in rhythm. The list sat at full strength
    // under a paragraph at the card's 75% until 2026-10-05, and the maintainer read it as a defect
    // ("the paragraphs looks like they're a slightly lighter color than the text in the ol"): one body
    // is one colour, which is the card's (CardContent). And the gap above the list is the paragraph
    // break the prose itself uses (`--md-step`, which `.card-md .md-body` sets on this very element), not
    // a tighter 8px of its own — the two blocks are one handoff rendered in two pieces.
    <div data-awaiting-steps className={`md-body ${QUEUE_WRAP} mt-[var(--md-step)] first:mt-0`}>
      <ol>
        {steps.map((step, i) => <Step key={i} md={step} />)}
      </ol>
    </div>
  )
}

function Step({ md }: { md: string }) {
  const html = useMarkdownHtml(md)
  return (
    <li>
      <LinkedHtml className="md-body" html={html} />
    </li>
  )
}

/** The card's one verb — drawn only while the thread is resting on THESE steps, which is the caller's
 *  test (AwaitingBackgroundCard `stepsLive`). */
export function StepsDone({ slug, onReplied, onReplyFailed }: {
  slug: string
  /** The queue's optimistic card exit, as for its Snooze; absent off the queue. */
  onReplied?: () => void
  onReplyFailed?: () => void
}) {
  const followUp = useEagerFollowUp(slug)
  // Latched on the click and released only by a rollback: between the send and the worker's turn
  // starting the card is still on screen, and a second click would send "Done" twice.
  const [sent, setSent] = useState(false)
  const reply = () => {
    setSent(true)
    const started = followUp.submit(STEPS_DONE, {
      onOptimistic: () => onReplied?.(),
      onRollback: () => {
        setSent(false)
        onReplyFailed?.()
      },
    })
    if (!started) setSent(false)
  }
  return (
    <CardActions data-awaiting-steps-reply>
      <button
        type="button"
        data-steps-done
        disabled={sent}
        onClick={reply}
        onMouseDown={(e) => e.preventDefault()}
        className={`${CARD_PRIMARY_ACTION} disabled:opacity-60`}
      >
        {STEPS_DONE}
      </button>
    </CardActions>
  )
}
