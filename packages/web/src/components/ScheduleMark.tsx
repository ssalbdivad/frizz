import { Repeat } from "lucide-react"
import type { ThreadScheduleRef } from "@frizz/shared"

// THE REPEAT GLYPH on a thread that a SCHEDULE started, or will start (plans/scheduled-threads.md §8): its
// pending next run, a lazy row in Snoozed, and every run it has started. One small mark after the title —
// the rail's rows are their titles and nothing else (Sidebar.tsx ThreadRow), so the schedule is a glyph with
// a tooltip, never a chip — saying "this came from a schedule", with the schedule and its rule one hover
// away: "From Triage issues · every Monday at 9am".
//
// lucide's `Repeat`, CROPPED TO ITS INK like the ACP plug (ProviderMark.tsx AcpMark): its paths span x 3–21
// and y 2–22 of the 24-unit box, plus half the 2.5 stroke a side, so the viewBox below is the ink box and the
// caller's `ml-1` is 4px of ink gap, the same gap the provider mark keeps beside it. Stroke 2.5, not lucide's
// 2: at a 10px box the default pen draws 0.9px lines, which read as a fainter mark than the filled provider
// glyph next to it.
export const SCHEDULE_MARK_GEOMETRY = {
  /** Beside a 13px row title (Sidebar.tsx ThreadRow). */
  row: "h-[10px] w-[9.11px] translate-y-px",
  /** Beside a queue card's 15px semibold title (AllQueuesCard.tsx). */
  title: "h-[11.5px] w-[10.48px] translate-y-px",
} as const

export function scheduleMarkLabel(schedule: Pick<ThreadScheduleRef, "title" | "describe">): string {
  return `From ${schedule.title} · ${schedule.describe}`
}

export function ScheduleMark({ schedule, size = "row", className = "" }: { schedule: ThreadScheduleRef; size?: keyof typeof SCHEDULE_MARK_GEOMETRY; className?: string }) {
  const label = scheduleMarkLabel(schedule)
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-schedule-mark={schedule.pending ? "next" : "run"}
      className={`inline-flex shrink-0 text-muted-65 ${SCHEDULE_MARK_GEOMETRY[size]} ${className}`}
    >
      <Repeat aria-hidden="true" focusable="false" className="size-full" strokeWidth={2.5} viewBox="1.75 0.75 20.5 22.5" />
    </span>
  )
}
