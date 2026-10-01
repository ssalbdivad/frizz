import type { ProjectQueue } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"

// THE ONE READ of every project's queue, shared by every `["projectsQueues"]` query so the cache entry
// always says when the read it holds STARTED. react-query's `dataUpdatedAt` is when a read LANDED, and on
// a loaded server the two are far apart: one poll took 25s while workers were starting. A read that
// started before Mark as done reached the server and landed after it describes the queue BEFORE the done,
// however new its arrival stamp — and the page brought the card back on it, for as long as the next read
// took (maintainer 2026-09-30: "I mark a thread as done and it suddenly pops back up … it reopened for a
// long time"). Only a read that started after an action was acknowledged can speak to that action.
const startedAt = new WeakMap<readonly ProjectQueue[], number>()

export async function readProjectsQueues(): Promise<ProjectQueue[]> {
  const at = Date.now()
  const queues = await rpc.projectsQueues()
  startedAt.set(queues, at)
  return queues
}

/** When the read that produced `queues` started; undefined for data that did not come through it. */
export function readStartedAt(queues: readonly ProjectQueue[] | undefined): number | undefined {
  return queues && startedAt.get(queues)
}
