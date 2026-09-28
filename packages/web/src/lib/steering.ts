import { proxy, useSnapshot } from "valtio"
import type { ThreadView } from "@frizz/shared"

// OPTIMISTIC STEER STATE — "your message is in, this thread is working again", rendered the instant
// the operator commits rather than when the server can prove it.
//
// Why this needs to exist at all: delivering a follow-up is a synchronous injection that takes
// ~250–800ms of subprocess work, and the thread only reads as RUNNING once the tailer subsequently
// observes the worker's turn start in the JSONL — seconds later, on a poll frizz does not control. In
// between, every board-driven surface still renders the thread exactly as it was: at rest, or worse,
// still wearing its "needs your input" mark for an ask the human just answered. The steer looks lost.
//
// The optimistic record closes that window. It is NOT a second source of truth: it is a short-lived
// hint that only ever fires while server truth has said nothing new, and it yields the moment the
// server has anything at all to say.
const steering = proxy({ at: {} as Record<string, number> })

// How long the hint may outlive its evidence. Past this the operator is better served by the truth —
// a steer that produced no observable activity in twelve seconds is one they should see stalled,
// not one we keep pretending is fine.
export const STEER_OPTIMISM_MS = 12_000

const expiries = new Map<string, ReturnType<typeof setTimeout>>()

export function markSteered(slug: string, nowMs = Date.now()): void {
  steering.at[slug] = nowMs
  const prior = expiries.get(slug)
  if (prior !== undefined) clearTimeout(prior)
  // The hint's own expiry must REPAINT, not just elapse: nothing else is guaranteed to re-render a
  // quiet thread at the cap, so without this the spinner could outlive its window on screen.
  expiries.set(slug, setTimeout(() => {
    expiries.delete(slug)
    delete steering.at[slug]
  }, STEER_OPTIMISM_MS))
}

// The send failed and its bubble was rolled back — the thread is not working after all.
export function clearSteered(slug: string): void {
  const prior = expiries.get(slug)
  if (prior !== undefined) { clearTimeout(prior); expiries.delete(slug) }
  delete steering.at[slug]
}

// Whether `t` should render as working purely on the strength of a just-sent steer. Server truth wins
// the instant it exists: any board activity stamped after the steer means the tailer has looked at
// this thread since, so whatever it now reports — running, or already finished and back at rest — is
// better than our guess.
export function isOptimisticallySteering(t: ThreadView, at: number | undefined, nowMs = Date.now()): boolean {
  if (at === undefined || nowMs - at > STEER_OPTIMISM_MS) return false
  const activity = t.lastActivityAt ? Date.parse(t.lastActivityAt) : NaN
  return !(Number.isFinite(activity) && activity > at)
}

// React binding. Returns the raw stamp map so a row can ask about its own slug without subscribing
// every row to every other row's steers.
export function useSteeredAt(): Record<string, number> {
  return useSnapshot(steering).at as Record<string, number>
}

// THE overlay: the board fields a just-sent steer asserts on the operator's behalf. Deliberately a
// whole ThreadView rather than a "show a spinner" flag, because the rail's PLACEMENT is derived — the
// section, the running/rested band, the order within it — and a hint only the indicator consults
// produces exactly the split the operator sees today: the row spins instantly while sitting among the
// queue cards for seconds, then hops. Overlaying the fields instead lets every existing pure predicate
// (isActivelyRunning, isSnoozed, sectionOf, orderActive, sessionIndicatorKind) reach the same conclusion
// from ONE rule.
//
// Every field here is what the SERVER itself will report once the tailer sees the turn start, so the
// optimistic position is the position truth lands on — the row settles once and never hops again.
export function optimisticallySteered(t: ThreadView, at: number | undefined, nowMs = Date.now()): ThreadView {
  if (at === undefined || !isOptimisticallySteering(t, at, nowMs)) return t
  return {
    ...t,
    runtime: "running",
    // A running thread is not awaiting you — deriveNeedsYou says so itself (`if (!atRest) return
    // false`). The queue reasons a steer resolves (an unanswered question, a native ask, a permission
    // prompt, a bare-rest handoff) are precisely the ones the operator just cleared by typing; the
    // queue card already leaves on that assumption, and the rail row must agree with it.
    needsYou: false,
    pendingAsk: undefined,
    pendingQuestion: false,
    actionableInteraction: false,
    // The steer IS a user interaction, and the running band orders by user recency (groups.ts
    // orderByInteraction). Without this the row would enter the band at its STALE position and then
    // jump again when the server reported this same instant a beat later.
    lastUserAt: new Date(at).toISOString(),
    // lastActivityAt is deliberately untouched: it is the evidence isOptimisticallySteering watches
    // for to hand the row back to server truth, so writing it here would make the hint self-sealing.
  }
}
