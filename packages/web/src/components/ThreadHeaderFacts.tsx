import type { ReactNode } from "react"
import type { ThreadView } from "@frizz/shared"
import { lastActiveLabelAt } from "../groups.ts"
import { goalLoopParts } from "../lib/goalLoop.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { LastActive } from "./LastActive.tsx"
import { ContextMeter, hasContextReading } from "./ContextMeter.tsx"
import { GoalMark } from "./RecurringPromptControl.tsx"

// A THREAD HEADER'S SECOND LINE: the facts about the thread as a whole, in words — "Last active 2m ago ·
// ◔ 74% context · ◎ run 7 of 20". The thread header (drawer and /full) renders it; the context reading
// joined "Last active" here on 2026-10-05 when the lifecycle footer that carried it went (see
// ThreadLifecycle.tsx for the top/bottom split).
//
// The fork's drawer line says more than that, and says it through this component rather than beside it:
// `lead` is what opens the line (the band stamp, BandLabel.tsx), and `children` is what follows the facts
// (where the agent works, a spinoff's parent, the live status line) — each child takes `<FactSep />` as its
// own `lead`, so a reading that renders nothing leaves no separator behind.
//
// The Goal's LOOP READING came with the context. It rode beside the goal mark in that footer (2026-09-29);
// the mark itself moved to the prompt box's rail, a row of fixed 28px squares whose text reserve cannot
// grow with a reading of varying width, so the reading — a fact about how far the thread has got, not a
// control — reads here, led by the same mark so it still names whose count it is.
//
// `empty:hidden`: a thread with no timestamp and no reading draws nothing, and must not leave the line's
// 2px top margin behind.
export function ThreadHeaderFacts({ thread, lead, children }: { thread: ThreadView; lead?: ReactNode; children?: ReactNode }) {
  const lazy = thread.lazyPrompt !== undefined
  return (
    <div data-thread-header-facts className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] leading-tight text-muted-75 empty:hidden">
      {lead}
      <LastActive
        // A lazy thread has never been active: its time is when it was written down (the queue card's word too).
        at={lazy ? thread.spawnedAt : lastActiveLabelAt(thread)}
        {...(lazy ? { label: "Added" } : {})}
        fallbackAt={thread.spawnedAt}
        lead={lead ? <FactSep /> : undefined}
        className="min-w-0 truncate"
      />
      <ContextFact thread={thread} lead={<FactSep />} />
      <GoalLoopFact thread={thread} lead={<FactSep />} />
      {children}
    </div>
  )
}

/** The line's separator. It shows only where it SEPARATES — after a fact that rendered, never first in the
 *  line and never after another separator — so every reading can carry one as its `lead` without
 *  knowing what precedes it (LastActive draws nothing for a thread with no timestamp at all, and a band
 *  stamp nothing for a thread with no band). */
export function FactSep() {
  return <span aria-hidden data-fact-sep className="hidden shrink-0 opacity-60 [:not([data-fact-sep])+&]:inline">·</span>
}

/** The context dial and its percent (ContextMeter), only when the thread has a reading. */
export function ContextFact({ thread, lead }: { thread: ThreadView; lead?: ReactNode }) {
  if (!hasContextReading(thread)) return null
  return (
    <>
      {lead}
      <ContextMeter thread={thread} />
    </>
  )
}

// THE GOAL'S LOOP COUNTER: `run 7 of 20 · 1h 12m left`, or why it stopped (lib/goalLoop.ts). Nothing for a
// Goal with nothing to count toward. Its own component so only it subscribes to the ticking clock.
//
// The mark sits on the digits' cap band the way the context ring does (ContextMeter): `self-baseline`
// stands the 1em svg on the baseline, the translate lifts its centre half a cap, and `-mt-[1em]` keeps the
// svg out of the line's height. Amber while the loop is live, the line's own grey once it has stopped —
// the rail's mark carries the same "something is armed" tone, and this repeats it rather than inventing
// another.
export function GoalLoopFact({ thread, lead }: { thread: ThreadView; lead?: ReactNode }) {
  const nowMs = useNowMs()
  const armed = thread.recurringPrompt
  const reading = goalLoopParts(armed, nowMs)
  if (!reading) return null
  const live = !armed?.stopped && (armed?.stopHook === true || armed?.heartbeat === true || armed?.postCompaction === true)
  const text = reading.tail ? `${reading.lead} · ${reading.tail}` : reading.lead
  return (
    <>
      {lead}
      <span data-goal-loop title={`Goal: ${text}`} className="flex min-w-0 shrink items-baseline gap-1 whitespace-nowrap tabular-nums">
        <GoalMark size={11} className={`-mt-[1em] h-[1em] w-[1em] shrink-0 self-baseline translate-y-[calc(0.5em_-_0.5cap)] ${live ? "text-attention-90" : ""}`} />
        <span className="min-w-0 truncate">{text}</span>
      </span>
    </>
  )
}
