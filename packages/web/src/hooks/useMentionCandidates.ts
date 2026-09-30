import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { useSnapshot } from "valtio"
import type { ProjectQueue, ThreadView } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { store } from "../store.ts"
import { viewAt } from "../lib/pageView.ts"
import { crossProjectMentionCandidates, mentionCandidates, type MentionCandidate } from "../lib/threadMentions.ts"

/** Every open project's threads while the page shows All projects — the machine-wide poll the page
 *  itself draws from (same key), read here rather than fetched again. Undefined on a project's own page:
 *  a mention there means that project's threads alone. Read off the address rather than the router, so a
 *  prompt box on a fixture page with no router still renders. */
function useCrossProjectQueues(): readonly ProjectQueue[] | undefined {
  const allProjects = typeof window !== "undefined" && viewAt(window.location.pathname, window.location.search).kind === "all"
  const queues = useQuery({ queryKey: ["projectsQueues"], queryFn: () => rpc.projectsQueues(), enabled: allProjects, staleTime: 5_000 })
  return allProjects ? queues.data : undefined
}

/** The `@` typeahead's candidates for a prompt box: the threads of the project it writes to (`project`,
 *  the page's by default) minus the thread being written into, then — showing All projects — every other
 *  open project's (lib/threadMentions.ts crossProjectMentionCandidates). The box's own project comes from
 *  the page's board when that is it, which carries its done threads too, else from the poll; a mention
 *  never offers the wrong project's thread under the right one's name. */
export function useMentionCandidates(excludeSlug?: string, project?: string): MentionCandidate[] {
  const snap = useSnapshot(store)
  const board = snap.board
  const queues = useCrossProjectQueues()
  const home = project ?? board?.projectSlug
  const onBoard = project === undefined || board?.projectSlug === project
  const threads = onBoard
    ? (board?.threads as readonly ThreadView[] | undefined)
    : (queues?.find((queue) => queue.projectSlug === project)?.threads as readonly ThreadView[] | undefined)
  return useMemo(() => {
    const own = threads ? mentionCandidates(threads, excludeSlug) : []
    return queues ? [...own, ...crossProjectMentionCandidates(queues, home, own)] : own
  }, [threads, excludeSlug, queues, home])
}

/** The thread `slug` itself as a mention candidate — the head a dotted `@this-thread.child` resolves
 *  against in its OWN prompt box (Composer `ownMention`). From the page's board only, when that is the
 *  box's project. */
export function useOwnMention(slug: string, project?: string): MentionCandidate | undefined {
  const snap = useSnapshot(store)
  const board = snap.board
  const threads = project === undefined || board?.projectSlug === project ? (board?.threads as readonly ThreadView[] | undefined) : undefined
  return useMemo(() => (threads ? mentionCandidates(threads.filter((t) => t.id === slug))[0] : undefined), [threads, slug])
}
