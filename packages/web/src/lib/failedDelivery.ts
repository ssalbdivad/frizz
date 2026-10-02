import { useCallback, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { rpc } from "../api/rpc.ts"
import { showToast, store, threadBySlug } from "../store.ts"
import { useProjectDir } from "./drafts.ts"
import { sendEagerFollowUp, type SendFailure } from "./eagerComposerSubmission.ts"
import { focusComposerNear, restoreDraft } from "./unqueueFollowUp.ts"

// A FAILED SEND — the operator's words, kept by the server after their delivery threw or never
// answered (server/src/delivery-ledger.ts, "WRITE-AHEAD"). It renders as a bubble at the thread's tail
// with the error under it and three ways out, all of them the operator's call and none of them
// automatic — a failure is usually ambiguous (the words may have reached the worker before the throw),
// so re-sending it is a decision only the human can make:
//
//   · Retry   — the ordinary send path (optimistic bubble, per-slug FIFO, deadline) under a NEW
//               deliveryId that `supersedes` the failed one, so the retry replaces the failed bubble.
//   · Edit    — the words go back into the prompt box (merged above anything already there, as an
//               unqueue does) and the failed entry is dismissed.
//   · Dismiss — the entry goes. Deliberate and final: nothing else ever removes it.
export function useFailedDeliveryActions(slug: string | null): {
  retry: (input: { deliveryId: string; text: string }) => void
  edit: (input: { deliveryId: string; text: string; from: HTMLElement | null }) => void
  dismiss: (input: { deliveryId: string }) => void
  pending: boolean
} {
  const queryClient = useQueryClient()
  const projectDir = useProjectDir()
  const [pending, setPending] = useState(false)

  const retry = useCallback((input: { deliveryId: string; text: string }) => {
    if (!slug || pending) return
    sendEagerFollowUp(queryClient, slug, input.text, { supersedes: input.deliveryId, failureToast: (message) => `Retry failed — ${message.slice(0, 160)}` })
  }, [pending, queryClient, slug])

  const dismissEntry = useCallback(async (deliveryId: string): Promise<boolean> => {
    if (!slug) return false
    setPending(true)
    try {
      await rpc.dismissFailedFollowUp({ slug, deliveryId })
      return true
    } catch (error) {
      showToast(`Couldn't dismiss — ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`)
      return false
    } finally {
      setPending(false)
    }
  }, [slug])

  const edit = useCallback((input: { deliveryId: string; text: string; from: HTMLElement | null }) => {
    if (!slug || pending) return
    // The words reach the prompt box BEFORE the server lets go of them, so no failure between the two
    // steps can leave them nowhere. A failed dismiss leaves them in both places, which is the safe
    // direction.
    restoreDraft(projectDir, slug, threadBySlug(store.board, slug)?.sessionId, input.text)
    focusComposerNear(input.from)
    void dismissEntry(input.deliveryId)
  }, [dismissEntry, pending, projectDir, slug])

  const dismiss = useCallback((input: { deliveryId: string }) => {
    if (!slug || pending) return
    void dismissEntry(input.deliveryId)
  }, [dismissEntry, pending, slug])

  return { retry, edit, dismiss, pending }
}

// ── a composer re-send replaces the failed bubble ───────────────────────────────────────────────────
// A failed composer send ALSO goes back into its prompt box (mergeIntoDraft), because that is where the
// operator was typing and the surface they are looking at — a queue card shows no transcript tail, so
// the failed bubble alone would leave the words seeming to vanish. Two copies are the safe direction,
// but the operator's natural next move — edit the draft and send again — would then leave the failed
// bubble standing beside the message that replaced it. So each draft key remembers the failures it was
// handed back, and the next send from it that still CONTAINS one of those texts supersedes that
// failure. A send that no longer contains it (the operator deleted the words) supersedes nothing: the
// failed bubble stays, and the operator dismisses it or not.
//
// Module scope, keyed by draft key, because the drawer and the queue card are one draft. In memory
// only: after a reload there is no draft-origin to remember, and the failed bubble is the server's.
const failedDraftOrigins = new Map<string, SendFailure[]>()
const MAX_ORIGINS_PER_DRAFT = 8

export function noteFailedDraftOrigin(draftKey: string, failure: SendFailure): void {
  const list = (failedDraftOrigins.get(draftKey) ?? []).filter((entry) => entry.deliveryId !== failure.deliveryId)
  list.push(failure)
  failedDraftOrigins.set(draftKey, list.slice(-MAX_ORIGINS_PER_DRAFT))
}

// Whitespace-insensitive, for the same reason the server's ledger is: the operator may re-flow the
// words they got back without meaning a different message.
const canon = (s: string): string => s.replace(/\s+/g, " ").trim()

/** The failed send the outgoing message re-sends, if any — consumed, so it is superseded once. The
 *  NEWEST match wins; one send supersedes one failure (FollowUpInput.supersedes is a single id). */
export function takeSupersededFailure(draftKey: string, outgoing: string): string | undefined {
  const list = failedDraftOrigins.get(draftKey)
  if (!list?.length) return undefined
  const haystack = canon(outgoing)
  for (let i = list.length - 1; i >= 0; i--) {
    const needle = canon(list[i].text)
    if (!needle || !haystack.includes(needle)) continue
    const [taken] = list.splice(i, 1)
    if (!list.length) failedDraftOrigins.delete(draftKey)
    return taken.deliveryId
  }
  return undefined
}
