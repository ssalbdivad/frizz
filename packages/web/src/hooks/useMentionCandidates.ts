import { useMemo } from "react"
import { useSnapshot } from "valtio"
import type { ThreadView } from "@frizz/shared"
import { store } from "../store.ts"
import { mentionCandidates, type MentionCandidate } from "../lib/threadMentions.ts"

/** The `@` typeahead's candidates for a prompt box on the page's project: the board the client already
 *  holds, minus the thread being written into. `project` names the project the box writes to when that
 *  may not be the page's (a cross-project queue card): a mention only means something inside its own
 *  project, so another project's box gets no candidates rather than the wrong project's threads. */
export function useMentionCandidates(excludeSlug?: string, project?: string): MentionCandidate[] {
  const snap = useSnapshot(store)
  const board = snap.board
  const threads = project === undefined || board?.projectSlug === project ? (board?.threads as readonly ThreadView[] | undefined) : undefined
  return useMemo(() => (threads ? mentionCandidates(threads, excludeSlug) : []), [threads, excludeSlug])
}

/** The thread `slug` itself as a mention candidate — the head a dotted `@thisThread.child` resolves
 *  against in its OWN prompt box (Composer `ownMention`). Same project rule as above. */
export function useOwnMention(slug: string, project?: string): MentionCandidate | undefined {
  const snap = useSnapshot(store)
  const board = snap.board
  const threads = project === undefined || board?.projectSlug === project ? (board?.threads as readonly ThreadView[] | undefined) : undefined
  return useMemo(() => (threads ? mentionCandidates(threads.filter((t) => t.id === slug))[0] : undefined), [threads, slug])
}
