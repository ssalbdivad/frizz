import { useEffect, useRef } from "react"
import { useQuery } from "@tanstack/react-query"
import { queuedThread, type ProjectQueue, type ThreadView } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { notify } from "../api/board-stream.ts"
import { store } from "../store.ts"

// DESKTOP NOTIFICATIONS FOR EVERY PROJECT, not only the one the page is bound to.
//
// A `notify` event is published on its PROJECT's bus (server board.ts notifyNeedsYou) and reaches a page
// only over that project's socket. Until 2026-09-28 every project had its own tab, so an operator with
// one tab per project heard from all of them. The one page binds ONE feed (routes.tsx useProjectBinding)
// and reads every other project through the `projectsQueues` poll — which raised nothing, so a thread
// that queued in any project but the focused one queued silently.
//
// This watches that same poll and raises the notification the other project's own tab would have: a
// session thread that newly ENTERS a queue (the server's edge, needsYou false → true, read as queued
// false → true), for every project except the bound one, whose socket already carries its own. Titled and
// bodied as the server titles it, and TAGGED by the thread's own address (`/all/<project>/<slug>`) exactly
// as the socket path tags it — the tag is the browser's replace key, so a second tab, or the socket of a
// tab bound to that project, raising the same thread replaces this notification instead of adding one.
//
// The first read is a baseline, and so is a project's first appearance in a read: a page that opens onto
// a full queue, or a project that has just been opened, is not news.

/** Each project's queued SESSION threads by id, as of the last read. */
export type QueueSightings = ReadonlyMap<string, ReadonlySet<string>>

export interface QueueArrival {
  project: Pick<ProjectQueue, "projectId" | "projectSlug">
  thread: ThreadView
}

/**
 * The threads that entered a queue since `prev`, and the sightings to compare the next read against.
 * `prev` null is the first read: everything is baseline. A thread that leaves and comes back arrives
 * again, as the server forgets a vanished thread so its reappearance re-notifies.
 */
export function queueArrivals(prev: QueueSightings | null, queues: readonly ProjectQueue[]): { next: Map<string, Set<string>>; arrivals: QueueArrival[] } {
  const next = new Map<string, Set<string>>()
  const arrivals: QueueArrival[] = []
  for (const project of queues) {
    // Sessions only: the server notifies for a session entering the queue, never a finished command.
    const queued = project.threads.filter((thread) => thread.kind === "session" && queuedThread(thread))
    next.set(project.projectId, new Set(queued.map((thread) => thread.id)))
    const seen = prev?.get(project.projectId)
    if (!seen) continue
    for (const thread of queued) if (!seen.has(thread.id)) arrivals.push({ project, thread })
  }
  return { next, arrivals }
}

/** The server's cap on a notification's line (board.ts LINE_CAP). */
const LINE_CAP = 240
const capLine = (text: string | undefined): string | undefined =>
  text ? (text.length > LINE_CAP ? `${text.slice(0, LINE_CAP - 1)}…` : text) : undefined

/** The page's poll cadence (AllQueues.tsx POLL_MS). This observer shares its query and cache. */
const POLL_MS = 3_000

/**
 * Mounted once, for the whole app. Shares the `projectsQueues` query the page draws from, and keeps it
 * polling while the tab is HIDDEN when notifications are on — react-query pauses an interval in a hidden
 * tab by default, and a hidden tab is the only one a notification is ever raised in.
 */
export function useCrossProjectNotifications(enabled: boolean): void {
  const queues = useQuery({
    queryKey: ["projectsQueues"],
    queryFn: () => rpc.projectsQueues(),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: enabled,
    enabled,
  })
  const sightings = useRef<QueueSightings | null>(null)
  useEffect(() => {
    if (!queues.data) return
    const { next, arrivals } = queueArrivals(sightings.current, queues.data)
    sightings.current = next
    // The bound project's arrivals come over its socket (api/board-stream.ts), already tagged the same.
    const bound = store.board?.projectSlug
    for (const { project, thread } of arrivals) {
      if (project.projectSlug === bound) continue
      notify(
        { type: "notify", slug: thread.id, kind: "needs-decision", title: thread.aiTitle || thread.title || thread.id, body: capLine(thread.lastAssistant) },
        project.projectSlug,
      )
    }
  }, [queues.data])
}
