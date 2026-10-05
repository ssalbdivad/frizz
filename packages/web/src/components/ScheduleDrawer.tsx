import { useEffect, useState, type ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import type { InterpretScheduleResult, ScheduleRunView, ScheduleView, UpdateScheduleInput } from "@frizz/shared"
import { projectRpc, rpc } from "../api/rpc.ts"
import { closeDrawersById, pushDrawer, showToast, store } from "../store.ts"
import { projectSlug } from "../lib/base-path.ts"
import { formatSnoozeWake } from "../lib/snooze.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { invalidateSchedules, proposedByLine, scheduleKeys, scheduleNextLabel } from "../lib/schedules.ts"
import { dispatchProfileGroups } from "../lib/dispatchPreferences.ts"
import { profileGridDisplayParts } from "../lib/profileGrid.ts"
import { effortWord } from "../lib/mobileThread.ts"
import { useOpenThreadInPlace } from "./AllQueuesCard.tsx"
import { Dialog } from "./ui/Dialog.tsx"
import { Sheet } from "./ui/Sheet.tsx"
import { SheetHeader } from "./ui/SheetHeader.tsx"
import { FOOTER_STYLE } from "./FileReaderDrawer.tsx"

// A SCHEDULE'S DRAWER (plans/scheduled-threads.md §8): everything about one schedule, in the drawer stack
// rather than a modal, so a run's thread opened from its history stacks over it and Esc comes back here.
//
// It reads and writes through the SCHEDULE's project (`projectId` on the stack entry), never the page's:
// the palette opens any project's schedule from any page. What it shows, top to bottom — why it is not
// running when it is not (a proposal to turn on, a pause and its reason), the echo the human confirmed and
// the next runs, WHEN in their own words (re-read on "Change when"), the condition, the prompt edited
// verbatim, the profile it runs on, and every past run linked to its thread.

const LABEL = "text-[11px] uppercase tracking-wide text-muted-70"
const BUTTON = "button-outline rounded-md px-2.5 py-1 text-[12px] text-fg/85 outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:opacity-45"
const PRIMARY = "rounded-md bg-fg px-2.5 py-1 text-[12px] font-medium text-bg outline-none transition-opacity hover:opacity-90 focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:opacity-40"

/** One schedule and its history, read through its own project's client while something shows it. */
export function useScheduleQuery(scheduleId: string, projectId: string | undefined) {
  // No project named: opened from a run's own transcript, which is always the page project's thread, so
  // the page's client is the schedule's. Once read, everything else goes through `schedule.projectId`.
  const api = projectId ? projectRpc(projectId) : rpc
  return useQuery({
    queryKey: scheduleKeys.get(projectId || "page", scheduleId),
    queryFn: () => api.getSchedule({ id: scheduleId }),
    // The next run moves, a run starts, Frizz pauses it: nothing pushes a schedule to the page, so the
    // drawer re-reads while it is open.
    refetchInterval: 5_000,
  })
}

export function ScheduleDrawer({ id, scheduleId, projectId, depth, widthDepth }: { id: number; scheduleId: string; projectId: string | undefined; depth: number; widthDepth: number }) {
  const query = useScheduleQuery(scheduleId, projectId)
  const schedule = query.data?.schedule
  return (
    <Sheet id={id} depth={depth} widthDepth={widthDepth}>
      {(close) => (
        <>
          <SheetHeader title={schedule?.title ?? "Schedule"} subtitle={schedule ? `${schedule.projectName} · ${schedule.describe}` : undefined} onClose={close} />
          {schedule ? (
            <ScheduleBody schedule={schedule} history={query.data!.history} drawerId={id} />
          ) : (
            <div className="flex-1 px-5 py-4 text-[13px] text-muted">
              {query.isError ? "This schedule is gone." : "Loading…"}
            </div>
          )}
        </>
      )}
    </Sheet>
  )
}

function ScheduleBody({ schedule, history, drawerId }: { schedule: ScheduleView; history: ScheduleRunView[]; drawerId: number }) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const { setState, runNow, remove, busy } = useScheduleActions(schedule, () => closeDrawersById([drawerId]))
  const proposed = schedule.state === "proposed"
  const paused = schedule.state === "paused"

  return (
    <>
      <div data-schedule-drawer={schedule.id} className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
        {/* WHY IT IS NOT RUNNING, first, when it is not: the one thing the human may need to act on. */}
        {proposed && (
          <Banner tone="attention" text={proposedByLine(schedule.createdBy) ?? "Proposed"}>
            <button type="button" className={PRIMARY} disabled={busy} onClick={() => setState.mutate("active")}>
              Turn on
            </button>
            <button type="button" className={BUTTON} disabled={busy} onClick={() => remove.mutate()}>
              Discard
            </button>
          </Banner>
        )}
        {paused && (
          <Banner tone={schedule.attention ? "attention" : "quiet"} text={schedule.pausedText ?? "Paused"}>
            <button type="button" className={BUTTON} disabled={busy} onClick={() => setState.mutate("active")}>
              Resume
            </button>
          </Banner>
        )}
        {schedule.state === "ended" && <Banner tone="quiet" text="Ended" />}

        <Echo schedule={schedule} />
        <ChangeWhen schedule={schedule} />
        {schedule.condition && (
          <section className="flex flex-col gap-1">
            <h3 className={LABEL}>Condition</h3>
            <p className="text-[13px] leading-5 text-fg/90">{schedule.condition}</p>
          </section>
        )}
        <PromptEditor schedule={schedule} />
        <section className="flex flex-col gap-1">
          <h3 className={LABEL}>Runs on</h3>
          <p data-schedule-profile className="text-[13px] leading-5 text-fg/90">{useScheduleProfileLabel(schedule)}</p>
        </section>
        <History schedule={schedule} history={history} />
      </div>
      <div className="flex shrink-0 items-center gap-1.5 border-t border-border/60 bg-panel px-5 pt-3" style={FOOTER_STYLE}>
        <button type="button" data-schedule-run-now className={BUTTON} disabled={busy} onClick={() => runNow.mutate()}>
          {runNow.isPending ? "Starting…" : "Run now"}
        </button>
        {schedule.state === "active" && (
          <button type="button" data-schedule-pause className={BUTTON} disabled={busy} onClick={() => setState.mutate("paused")}>
            Pause
          </button>
        )}
        <span className="flex-1" />
        <button type="button" data-schedule-delete className={`${BUTTON} text-danger-90 hover:text-danger`} disabled={busy} onClick={() => setConfirmDelete(true)}>
          Delete
        </button>
      </div>
      {confirmDelete && (
        <Dialog
          open
          onOpenChange={(open) => { if (!open && !remove.isPending) setConfirmDelete(false) }}
          title={`Delete ${schedule.title}? Its past runs stay.`}
          className="w-[420px] max-w-[92vw]"
          footer={
            <>
              <button type="button" onClick={() => setConfirmDelete(false)} disabled={remove.isPending} className="button-outline rounded-md px-3 py-1.5 text-[12px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-45">
                Cancel
              </button>
              <button
                type="button"
                data-schedule-delete-confirm
                onClick={() => remove.mutate(undefined, { onSettled: () => setConfirmDelete(false) })}
                disabled={remove.isPending}
                className="button-outline flex items-center gap-1.5 rounded-md bg-danger-button/90 px-3 py-1.5 text-[12.5px] font-medium text-white outline-none transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {remove.isPending && <Loader2 size={12} className="animate-spin" />}
                Delete
              </button>
            </>
          }
        >
          <p className="p-4 text-[12.5px] leading-relaxed text-muted">Its next run is removed with it. The threads it already started are not.</p>
        </Dialog>
      )}
    </>
  )
}

/**
 * A schedule's verbs — Turn on / Resume / Pause (`setState`), Run now, Delete or Discard (`remove`) — through
 * the schedule's own project, each settling every list and drawer that shows it. Shared by the desktop drawer
 * and the phone's sheet (PhoneSchedules.tsx), so the two never disagree on what a verb does or says.
 */
export function useScheduleActions(schedule: ScheduleView, onDeleted: () => void) {
  const queryClient = useQueryClient()
  const api = projectRpc(schedule.projectId)
  const settle = () => invalidateSchedules(queryClient)
  const failed = (what: string) => (error: unknown) => {
    showToast(`Could not ${what}: ${(error as Error).message.slice(0, 100)}`)
    settle()
  }
  const setState = useMutation({
    mutationFn: (state: "active" | "paused") => api.setScheduleState({ id: schedule.id, state }),
    onSuccess: settle,
    onError: failed("change the schedule"),
  })
  const runNow = useMutation({
    mutationFn: () => api.runScheduleNow({ id: schedule.id }),
    onSuccess: () => {
      settle()
      void queryClient.invalidateQueries({ queryKey: ["projectsQueues"] })
      showToast(`${schedule.title} started`)
    },
    onError: failed("start it"),
  })
  const remove = useMutation({
    mutationFn: () => api.deleteSchedule({ id: schedule.id }),
    onSuccess: () => {
      settle()
      onDeleted()
    },
    onError: failed("delete it"),
  })
  return { setState, runNow, remove, busy: setState.isPending || runNow.isPending || remove.isPending }
}

/** A past run opens its thread while that thread still exists; a skipped or failed one reads quiet. */
export function scheduleRunOpens(run: ScheduleRunView): boolean {
  return Boolean(run.threadSlug) && run.threadState !== "deleted"
}

function Banner({ tone, text, children }: { tone: "attention" | "quiet"; text: string; children?: ReactNode }) {
  return (
    <div
      data-schedule-banner={tone}
      className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2 ${tone === "attention" ? "border-attention/35 bg-attention/[0.06]" : "border-border bg-panel-2/60"}`}
    >
      <p className={`min-w-0 flex-1 text-[12.5px] leading-5 ${tone === "attention" ? "text-attention-soft" : "text-fg/85"}`}>{text}</p>
      {children && <div className="flex shrink-0 items-center gap-1.5">{children}</div>}
    </div>
  )
}

/** The echo the human confirmed, from the rule Frizz fires, and the next run — the lazy thread that
 *  stands for it, a click away (Mark as done on it skips it; snoozing it moves it). */
function Echo({ schedule }: { schedule: ScheduleView }) {
  const now = useNowMs()
  const openRun = useOpenRun(schedule)
  const next = schedule.nextRun
  return (
    <section className="flex flex-col gap-0.5">
      <p data-schedule-echo className="text-[14px] leading-5 text-fg">{schedule.echo}</p>
      {schedule.nextLine && <p className="text-[12px] leading-5 text-muted">{schedule.nextLine}</p>}
      {next && schedule.state === "active" && (
        <p className="text-[12px] leading-5 text-muted">
          <button type="button" data-schedule-next-run onClick={() => openRun(next.slug, schedule.title)} className="rounded-sm text-fg/80 underline decoration-border-strong underline-offset-2 outline-none transition-colors hover:text-fg hover:decoration-fg/50 focus-visible:ring-1 focus-visible:ring-focus-ink-60">
            Next run {scheduleNextLabel(schedule, now)}
          </button>
          {next.moved && ` · moved to ${formatSnoozeWake(next.at, now).replace(/^(Today|Tomorrow)/, (day) => day.toLowerCase())}`}
        </p>
      )}
    </section>
  )
}

/** "Change when": the human's words, re-read by the server against the rule and condition it stores, the
 *  new echo shown, and Save. Nothing is written until Save. */
function ChangeWhen({ schedule }: { schedule: ScheduleView }) {
  const queryClient = useQueryClient()
  const api = projectRpc(schedule.projectId)
  const [text, setText] = useState(schedule.whenText)
  const [reading, setReading] = useState<{ text: string; result: InterpretScheduleResult } | null>(null)
  // A save elsewhere (another tab, a worker's move) brings new words while this one is untouched.
  useEffect(() => {
    if (!reading) setText(schedule.whenText)
  }, [schedule.whenText])
  const interpret = useMutation({
    mutationFn: (words: string) => api.interpretSchedule({ text: words, scheduleId: schedule.id, tz: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    onSuccess: (result, words) => setReading({ text: words, result }),
    onError: (error, words) => setReading({ text: words, result: { ok: false, error: (error as Error).message.slice(0, 120) } }),
  })
  const save = useMutation({
    mutationFn: (input: UpdateScheduleInput) => api.updateSchedule(input),
    onSuccess: () => {
      setReading(null)
      invalidateSchedules(queryClient)
    },
    onError: (error) => showToast(`Could not save: ${(error as Error).message.slice(0, 100)}`),
  })
  const current = reading && reading.text === text.trim() ? reading.result : undefined
  const changed = text.trim() !== schedule.whenText
  const read = () => {
    const words = text.trim()
    if (!words || interpret.isPending) return
    interpret.mutate(words)
  }
  const commit = () => {
    if (!current?.ok) return
    save.mutate({
      id: schedule.id,
      revision: schedule.revision,
      whenText: current.whenText,
      rrule: current.rrule,
      dtstart: current.dtstart,
      tz: current.tz,
      condition: current.condition ?? null,
    })
  }
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className={LABEL}>When</h3>
      <div className="flex items-center gap-1.5">
        <input
          data-schedule-when
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault()
              if (current?.ok) commit()
              else read()
            }
            if (e.key === "Escape" && (changed || reading)) {
              // Claimed: the first Escape puts the words back, the next closes the drawer.
              e.preventDefault()
              e.stopPropagation()
              setText(schedule.whenText)
              setReading(null)
            }
          }}
          aria-label="When it runs"
          className="min-w-0 flex-1 rounded-md border border-border bg-bg px-2.5 py-1.5 text-[13px] text-fg outline-none placeholder:text-muted focus:border-border-strong"
        />
        {changed && !current?.ok && (
          <button type="button" data-schedule-when-read className={BUTTON} disabled={interpret.isPending || !text.trim()} onClick={read}>
            {interpret.isPending ? "Reading…" : "Change when"}
          </button>
        )}
      </div>
      {current && (
        <div data-schedule-when-preview className="flex flex-wrap items-start gap-x-3 gap-y-1.5 rounded-lg border border-border bg-panel-2 px-3 py-2">
          <div className="min-w-0 flex-1">
            {current.ok ? (
              <>
                <p className="text-[13px] leading-5 text-fg">{current.preview.echo}</p>
                {current.preview.nextLine && <p className="text-[12px] leading-5 text-muted">{current.preview.nextLine}</p>}
              </>
            ) : (
              <p className="text-[12px] leading-5 text-fg/85">{current.error}</p>
            )}
          </div>
          {current.ok && (
            <div className="flex shrink-0 items-center gap-1.5">
              <button type="button" className={BUTTON} onClick={() => { setText(schedule.whenText); setReading(null) }}>
                Cancel
              </button>
              <button type="button" data-schedule-when-save className={PRIMARY} disabled={save.isPending} onClick={commit}>
                {save.isPending ? "Saving…" : "Save"}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

/** The saved prompt, edited verbatim — no model ever rewrites it. A prompt change reaches the next run
 *  unless the human already edited that run's own note. */
function PromptEditor({ schedule }: { schedule: ScheduleView }) {
  const queryClient = useQueryClient()
  const api = projectRpc(schedule.projectId)
  const [text, setText] = useState(schedule.prompt)
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!editing) setText(schedule.prompt)
  }, [schedule.prompt])
  const save = useMutation({
    mutationFn: (prompt: string) => api.updateSchedule({ id: schedule.id, revision: schedule.revision, prompt }),
    onSuccess: () => {
      setEditing(false)
      invalidateSchedules(queryClient)
    },
    onError: (error) => showToast(`Could not save: ${(error as Error).message.slice(0, 100)}`),
  })
  const dirty = text !== schedule.prompt
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className={LABEL}>Prompt</h3>
      <textarea
        data-schedule-prompt
        data-1p-ignore
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          setEditing(true)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && dirty && text.trim()) {
            e.preventDefault()
            save.mutate(text)
          }
        }}
        rows={Math.min(12, Math.max(3, text.split("\n").length + 1))}
        spellCheck={false}
        aria-label="Prompt"
        className="w-full resize-y rounded-md border border-border bg-bg px-2.5 py-2 text-[13px] leading-relaxed text-fg outline-none focus:border-border-strong"
      />
      {dirty && (
        <div className="flex items-center justify-end gap-1.5">
          <button type="button" className={BUTTON} onClick={() => { setText(schedule.prompt); setEditing(false) }}>
            Revert
          </button>
          <button type="button" data-schedule-prompt-save className={PRIMARY} disabled={save.isPending || !text.trim()} onClick={() => save.mutate(text)}>
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      )}
    </section>
  )
}

/** `Opus 5 · high` — the composer chip's reading, from the same model lists the box reads. */
export function useScheduleProfileLabel(schedule: ScheduleView): string {
  const codex = useQuery({ queryKey: ["codexModels"], queryFn: () => rpc.codexModels() })
  const claude = useQuery({ queryKey: ["claudeModels"], queryFn: () => rpc.claudeModels(), retry: false })
  const acp = useQuery({ queryKey: ["acpAgents"], queryFn: () => rpc.acpAgents() })
  const groups = dispatchProfileGroups(codex.data ?? [], acp.data ?? [], claude.data ?? [])
  const parts = profileGridDisplayParts(groups, { model: schedule.model, effort: schedule.effort }, "The default profile")
  const name = [parts.name, parts.edition].filter(Boolean).join(" ")
  return [name, effortWord(parts.effort)].filter(Boolean).join(" · ")
}

/** Every past run, newest first: its occurrence, then the server's line for it — the run's `@thread`, a
 *  quiet finish's first line, or why it was skipped or did not start. A run whose thread still exists
 *  opens it. */
function History({ schedule, history }: { schedule: ScheduleView; history: ScheduleRunView[] }) {
  const openRun = useOpenRun(schedule)
  return (
    <section className="flex flex-col gap-1">
      <h3 className={LABEL}>Runs</h3>
      {history.length === 0 ? (
        <p className="text-[12.5px] leading-5 text-muted">No runs yet.</p>
      ) : (
        <ul data-schedule-history className="flex flex-col">
          {history.map((run) => {
            const linked = scheduleRunOpens(run)
            const quiet = run.state === "skipped" || run.state === "failed"
            return (
              <li key={run.id} data-schedule-run={run.state} className="flex min-w-0 items-baseline gap-2 py-0.5 text-[12.5px] leading-5">
                <span className="shrink-0 tabular-nums text-muted-80">{run.when}</span>
                <span aria-hidden className="shrink-0 text-muted-50">·</span>
                {linked ? (
                  <button
                    type="button"
                    onClick={() => openRun(run.threadSlug!, run.threadTitle)}
                    className={`min-w-0 truncate rounded-sm text-left outline-none transition-colors hover:underline focus-visible:ring-1 focus-visible:ring-focus-ink-60 ${run.threadState === "archived" ? "text-fg/70" : "text-fg/90"}`}
                    title={run.reason ?? run.label}
                  >
                    {run.label}
                  </button>
                ) : (
                  <span className={`min-w-0 truncate ${quiet ? "text-muted" : "text-fg/80"}`} title={run.reason ?? run.label}>
                    {run.label}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/** Open one of the schedule's runs. On the schedule's own project's page it stacks over this drawer, so
 *  Esc comes back; from another project's page it opens in place, which moves the page to its project. */
function useOpenRun(schedule: ScheduleView): (slug: string, title?: string) => void {
  const openInPlace = useOpenThreadInPlace()
  return (slug, title) => {
    const here = projectSlug() === schedule.projectSlug && store.board?.projectSlug === schedule.projectSlug
    if (here) {
      const thread = store.board?.threads.find((t) => t.id === slug)
      pushDrawer(thread && thread.runtime === "none" && thread.lazyPrompt === undefined ? "doc" : "thread", slug, { drillIn: true })
      return
    }
    openInPlace({ slug: schedule.projectSlug, id: schedule.projectId, name: schedule.projectName }, slug, title)
  }
}
