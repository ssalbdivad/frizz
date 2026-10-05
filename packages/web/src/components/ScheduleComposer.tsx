import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Loader2, Repeat } from "lucide-react"
import type { CreateScheduleInput, InterpretScheduleResult, ScheduleView } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { pushScheduleDrawer, showToast } from "../store.ts"
import { startsWithRecurrence } from "../lib/scheduleHint.ts"
import { invalidateSchedules } from "../lib/schedules.ts"

// THE PROMPT BOX'S SCHEDULE MODE (plans/scheduled-threads.md §3). The new-thread box has three ways out:
// Enter starts the thread now, the snail writes it down for later, and this — the repeat glyph left of the
// snail, or ⌘/Ctrl-Option-Enter — reads the text for WHEN it should run and shows it back as a schedule to
// confirm. The server's interpreter finds the schedule phrase in the text ("every Monday at 9am") and
// returns the rule it will fire, the echo built from that rule, and the prompt with the phrase cut out,
// verbatim — never a model's rewrite of it. The box marks the phrase behind its own words so the human
// sees which words became WHEN and that the rest is what will be sent.
//
// A READING BELONGS TO THE TEXT IT READ. Edit the text and the echo below it no longer describes it, so it
// goes, and Enter reads the text again; Create schedule only ever saves the reading on screen.

/** What the box passes in: the text to read (the prompt as it would be sent), the profile to snapshot,
 *  and what to do once the schedule exists (clear the draft, close a phone sheet). */
export interface ScheduleModeInput {
  /** The prompt as it would be sent — chips serialized, user commands expanded — or "" when empty. */
  text: string
  /** The prose the box shows, for marking the phrase. */
  prose: string
  /** The model/effort the box would dispatch on. Undefined while the profile is loading. */
  profile: { model: string; backend: CreateScheduleInput["backend"]; effort: CreateScheduleInput["effort"] } | undefined
  /** Whether the box may act at all (a settings write in flight, an account alias typed). */
  blocked: boolean
  onCreated: () => void
}

export interface ScheduleMode {
  on: boolean
  /** How the box's schedule glyph reads. */
  glyph: "off" | "hint" | "on"
  /** The phrase's span in the prose, while the reading on screen is the text's. */
  highlight: { start: number; end: number } | undefined
  /** The glyph and ⌘⌥⏎: into the mode (reading the text at once if there is any), or out of it. */
  toggle: () => void
  /** Enter in the mode: read the text, or — when the reading on screen is the text's — create it. */
  submit: () => void
  /** Escape: leave the mode. True when it was on. */
  escape: () => boolean
  panel: React.ReactNode
}

export function useScheduleMode({ text, prose, profile, blocked, onCreated }: ScheduleModeInput): ScheduleMode {
  const queryClient = useQueryClient()
  const [on, setOn] = useState(false)
  const [reading, setReading] = useState<{ text: string; result: InterpretScheduleResult } | null>(null)
  const interpret = useMutation({
    mutationFn: (read: string) => rpc.interpretSchedule({ text: read, tz: browserZone() }),
    onSuccess: (result, read) => setReading({ text: read, result }),
    onError: (error, read) => setReading({ text: read, result: { ok: false, error: `Couldn't read that: ${(error as Error).message.slice(0, 120)}` } }),
  })
  const create = useMutation({
    mutationFn: (input: CreateScheduleInput) => rpc.createSchedule(input),
    onSuccess: (view: ScheduleView) => {
      setOn(false)
      setReading(null)
      onCreated()
      invalidateSchedules(queryClient)
      showToast(`${view.title} scheduled`, {
        ...(view.nextLine ? { detail: view.nextLine } : {}),
        action: { label: "Open", run: () => pushScheduleDrawer(view.id, view.projectId) },
      })
    },
    onError: (error) => showToast(`Could not create the schedule: ${(error as Error).message.slice(0, 100)}`),
  })

  const current = reading && reading.text === text ? reading : null
  const read = () => {
    if (!text || blocked || interpret.isPending) return
    interpret.mutate(text)
  }
  const confirm = () => {
    if (!current?.result.ok || !profile || blocked || create.isPending) return
    const r = current.result
    if (!r.prompt.trim()) return
    create.mutate({
      title: r.title,
      prompt: r.prompt,
      whenText: r.whenText,
      rrule: r.rrule,
      dtstart: r.dtstart,
      tz: r.tz,
      ...(r.condition ? { condition: r.condition } : {}),
      // The box's own pick, snapshotted: changing the default later never moves an existing schedule.
      model: profile.model,
      ...(profile.backend ? { backend: profile.backend } : {}),
      ...(profile.effort ? { effort: profile.effort } : {}),
    })
  }
  const leave = () => {
    setOn(false)
    setReading(null)
  }

  const highlight = (() => {
    if (!on || !current?.result.ok) return undefined
    const at = prose.indexOf(current.result.phrase)
    return at >= 0 && current.result.phrase ? { start: at, end: at + current.result.phrase.length } : undefined
  })()

  const panel = on ? (
    <ScheduleEchoPanel
      pending={interpret.isPending}
      creating={create.isPending}
      reading={current?.result}
      stale={reading !== null && current === null}
      empty={!text}
      onCreate={confirm}
      onLeave={leave}
    />
  ) : null

  return {
    on,
    glyph: on ? "on" : startsWithRecurrence(prose) ? "hint" : "off",
    highlight,
    toggle: () => {
      if (on) {
        leave()
        return
      }
      setOn(true)
      read()
    },
    submit: () => (current?.result.ok && current.result.prompt.trim() ? confirm() : read()),
    escape: () => {
      if (!on) return false
      leave()
      return true
    },
    panel,
  }
}

function browserZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}

const NOTHING_TO_DO = "Say what it should do as well, like “every Monday at 9am triage new issues”."

/**
 * The echo under the box: what the server will fire, in its own words — "Triage issues · every Monday at
 * 9am", then "Next: Mon Oct 12 · Mon Oct 19 · Mon Oct 26" — with Create schedule beside Esc. A refusal is
 * the server's copy, verbatim; it already says what to type instead.
 */
function ScheduleEchoPanel({
  pending,
  creating,
  reading,
  stale,
  empty,
  onCreate,
  onLeave,
}: {
  pending: boolean
  creating: boolean
  reading: InterpretScheduleResult | undefined
  stale: boolean
  empty: boolean
  onCreate: () => void
  onLeave: () => void
}) {
  const esc = <kbd className="font-sans text-[11px] text-muted-70">Esc</kbd>
  const ok = reading?.ok && reading.prompt.trim() ? reading : undefined
  let body: React.ReactNode
  if (pending) {
    body = (
      <p className="flex items-center gap-1.5 text-[12px] leading-5 text-muted">
        <Loader2 size={12} className="animate-spin" aria-hidden />
        Reading when it runs…
      </p>
    )
  } else if (ok) {
    body = (
      <>
        <p data-schedule-echo className="text-[13px] leading-5 text-fg">{ok.preview.echo}</p>
        {ok.preview.nextLine && <p data-schedule-next className="text-[12px] leading-5 text-muted">{ok.preview.nextLine}</p>}
      </>
    )
  } else if (reading && !stale) {
    body = <p data-schedule-refusal className="text-[12px] leading-5 text-fg/85">{reading.ok ? NOTHING_TO_DO : reading.error}</p>
  } else {
    // The mode is on and nothing on screen describes the text yet: say what Enter does here.
    body = (
      <p className="text-[12px] leading-5 text-muted">
        {empty ? "Type what to do and when it runs, like “every weekday at 9am triage new issues”." : stale ? "Edited. Press Enter to read it again." : "Press Enter to read when it runs."}
      </p>
    )
  }
  return (
    <div data-schedule-panel role="status" className="rounded-lg border border-border bg-panel-2 px-3 py-2.5">
      <div className="flex items-start gap-2">
        {/* The mode's own glyph, on the first line's cap band — the same lift every glyph beside a line of
            text gets here (see QuietToggles in ProjectList.tsx): baseline-aligned, then raised by half the
            difference between its box and the cap height. */}
        <span aria-hidden className="flex h-5 shrink-0 items-center text-muted">
          <Repeat size={13} />
        </span>
        <div className="min-w-0 flex-1">{body}</div>
      </div>
      <div className="mt-2 flex items-center justify-end gap-3">
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onLeave}
          className="flex items-center gap-1.5 rounded-md px-1 text-[12px] text-muted outline-none transition-colors hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60"
        >
          {esc}
          <span>Cancel</span>
        </button>
        <button
          type="button"
          data-schedule-create
          onMouseDown={(e) => e.preventDefault()}
          onClick={onCreate}
          disabled={!ok || creating || pending}
          title={`Create schedule (Enter)`}
          className="rounded-md bg-fg px-2.5 py-1 text-[12px] font-medium text-bg outline-none transition-opacity hover:opacity-90 focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:opacity-40"
        >
          {creating ? "Creating…" : "Create schedule"}
        </button>
      </div>
    </div>
  )
}
