import { useEffect, useRef, useState, type ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import {
  SCHEDULE_GRAMMAR_VERSION,
  SCHEDULE_PRESENCE_COPY,
  SCHEDULE_READING_MOVED,
  SCHEDULE_SPACING_COPY,
  compileSchedule,
  describeSchedule,
  readSchedulePhrase,
  readingsConsistent,
  scheduleRefusalOf,
  type PhraseReading,
  type ScheduleRunView,
  type ScheduleView,
  type UpdateScheduleInput,
} from "@frizz/shared"
import { projectRpc, rpc } from "../api/rpc.ts"
import { closeDrawersById, pushDrawer, showToast, store } from "../store.ts"
import { projectSlug } from "../lib/base-path.ts"
import { formatSnoozeWake } from "../lib/snooze.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { invalidateSchedules, proposedByLine, scheduleKeys, scheduleNextLabel } from "../lib/schedules.ts"
import { dispatchProfileGroups } from "../lib/dispatchPreferences.ts"
import { profileGridDisplayParts } from "../lib/profileGrid.ts"
import { effortWord } from "../lib/mobileThread.ts"
import { MODEL_BUDGET_COPY, MODEL_UNREACHABLE_COPY, modelReadKey, modelRefusalCopy, useModelReader, type ModelReadOk, type ModelReader } from "../lib/scheduleModelRead.ts"
import { holdsQualifier, publishesNow, readingKey } from "../lib/scheduleWhenField.ts"
import { SchedulePreview, browserZone, schedulePreviewModel } from "./SchedulePreview.tsx"
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
      invalidateSchedules(queryClient, schedule.id)
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

/**
 * "Change when", LIVE (plans/schedule-live-reading.md §11). The field means nothing but WHEN, so Enter carries
 * no dispatch risk: it is where the local grammar, its publish policy and the preview prove themselves first.
 *
 * - The words are read by the local grammar (`scope: "field"`, the whole field must be the phrase, one-offs
 *   included) at word boundaries and after 250ms of rest, in the schedule's own zone, and previewed at once
 *   with the parts it assumed dim. A half-typed word never changes what is shown: the last reading holds.
 * - An exact reading saves through `updateSchedule` with `source: local`, which the server re-derives before
 *   writing (§10.1). The stored condition is kept, and says so: `Still checks: … · Drop`.
 * - Words the grammar declines (a condition, a vague count, a typo) go to the model after 600ms of rest —
 *   single flight, the 10m cache and the budget in lib/scheduleModelRead.ts — with the part it IS sure of
 *   shown meanwhile and the rest quoted. A model reading over a local core must agree with it (§4.3).
 * - Ambiguous words, events, presence and spacing get their copy and no Save, and never reach the model.
 * - Enter and Save re-read the words synchronously first: they act only on the reading on screen. If the fresh
 *   read differs (a word typed faster than the rest, a minute rolled over), it is shown instead and nothing
 *   is saved until the next Enter.
 * - Nothing is written until Save; the first Esc puts the words back, the next closes the drawer.
 */
function ChangeWhen({ schedule }: { schedule: ScheduleView }) {
  const queryClient = useQueryClient()
  const api = projectRpc(schedule.projectId)
  const nowMs = useNowMs()
  const viewerTz = browserZone()
  const tz = schedule.tz
  const [text, setText] = useState(schedule.whenText)
  // Edited since the words were last put back: a save elsewhere (another tab, a worker's move) only replaces
  // words the human has not touched.
  const dirty = useRef(false)
  const [published, setPublishedState] = useState<Published | null>(null)
  const publishedRef = useRef<Published | null>(null)
  const setPublished = (next: Published | null) => {
    publishedRef.current = next
    setPublishedState(next)
  }
  const [notice, setNotice] = useState<{ words: string; copy: string } | null>(null)
  const [stale, setStale] = useState<string | null>(null)
  const movedOnce = useRef<string | null>(null)
  const [dropCondition, setDropCondition] = useState(false)
  const [shake, setShake] = useState(0)
  const restTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(restTimer.current), [])
  useEffect(() => {
    if (!dirty.current) setText(schedule.whenText)
  }, [schedule.whenText])

  const reader = useModelReader({
    interpret: (words) => api.interpretSchedule({ text: words, scheduleId: schedule.id, tz: viewerTz }),
    // A Change when reads against this schedule's stored rule and condition: its answers are its own.
    keyOf: (words, at) => modelReadKey({ context: `schedule:${schedule.id}`, tz, nowMs: at, text: words }),
  })

  const words = text.trim()
  const changed = words !== schedule.whenText.trim()

  /** Read the words now and put that reading on screen — unless this is a word boundary inside a qualifier
   *  still being typed, which waits for the rest (`holdsQualifier`). */
  const publish = (value: string, at: "boundary" | "rest" = "rest"): PhraseReading => {
    clearTimeout(restTimer.current)
    const w = value.trim()
    const reading = readSchedulePhrase(w, { nowMs: Date.now(), tz, scope: "field" })
    if (at === "boundary" && holdsQualifier(publishedRef.current?.reading, w, reading)) {
      restTimer.current = setTimeout(() => publish(value), CHANGE_WHEN_REST_MS)
      return reading
    }
    setPublished({ words: w, reading })
    return reading
  }

  // What the preview describes: the last published reading, held while a word is half-typed.
  const shown = changed && words && published?.words ? published : null
  const declined = shown !== null && (shown.reading.kind === "cue" || shown.reading.kind === "none")

  // THE MODEL, after 600ms with no input, for words the grammar declines. The words are read fresh when the
  // timer fires, so the wait is 600ms from the last keystroke whether or not it ended a word.
  useEffect(() => {
    if (!changed || !words) {
      reader.cancelQueued()
      return
    }
    const t = setTimeout(() => {
      const current = publishedRef.current?.words === words ? publishedRef.current.reading : publish(words)
      if (current.kind === "cue" || current.kind === "none") reader.request(words)
      else reader.cancelQueued()
    }, CHANGE_WHEN_MODEL_IDLE_MS)
    return () => clearTimeout(t)
  }, [words, changed])
  // Words the grammar reads now no longer need the read queued behind the one that is out.
  useEffect(() => {
    if (shown && !declined) reader.cancelQueued()
  }, [shown?.reading.kind, declined])

  const view = whenView({ shown, reader, tz, nowMs, stale: stale !== null && stale === words })
  const shimmer = useDelayedTrue(view.kind === "reading", SHIMMER_DELAY_MS)
  const localSpec = view.kind === "local" ? { title: schedule.title, rrule: view.reading.rrule, dtstart: view.reading.dtstart, tz, assumed: view.reading.assumed } : undefined
  const localOk = localSpec ? schedulePreviewModel(localSpec, nowMs, viewerTz).ok : false
  const savable = (view.kind === "local" && localOk) || view.kind === "model"

  const restore = () => {
    clearTimeout(restTimer.current)
    dirty.current = false
    setText(schedule.whenText)
    setPublished(null)
    setNotice(null)
    setStale(null)
    setDropCondition(false)
    movedOnce.current = null
    reader.cancelQueued()
    reader.reset()
  }

  const save = useMutation({
    mutationFn: (job: { words: string; local: boolean; input: UpdateScheduleInput }) => api.updateSchedule(job.input),
    onSuccess: (_view, job) => {
      clearTimeout(restTimer.current)
      dirty.current = false
      setText(job.input.whenText ?? schedule.whenText)
      setPublished(null)
      setNotice(null)
      setDropCondition(false)
      movedOnce.current = null
      reader.reset()
      invalidateSchedules(queryClient)
    },
    onError: (error, job) => {
      const refusal = scheduleRefusalOf(error)
      // The server read the words differently at its clock: read them again here and show that. A second
      // refusal of the same words means the two cannot agree from this page (§10.1).
      if (refusal === SCHEDULE_READING_MOVED && job.local && movedOnce.current !== job.words) {
        movedOnce.current = job.words
        publish(job.words)
        setNotice({ words: job.words, copy: UPDATED_FOR_TIME })
        return
      }
      if (refusal) {
        setNotice(null)
        setStale(job.words)
        return
      }
      showToast(`Could not save: ${(error as Error).message.slice(0, 100)}`)
    },
  })

  /** Enter and Save: act only on what is on screen, read again now. */
  const commit = () => {
    if (!changed || !words || save.isPending || (stale !== null && stale === words)) return
    const before = publishedRef.current
    const fresh = readSchedulePhrase(words, { nowMs: Date.now(), tz, scope: "field" })
    if (!before || readingKey(before.reading) !== readingKey(fresh)) {
      setPublished({ words, reading: fresh })
      if (fresh.kind === "cue" || fresh.kind === "none") reader.request(words, { explicit: true })
      // Something else was on screen: say why this Enter only showed the new reading. With nothing shown
      // yet, showing it is answer enough.
      else if (fresh.kind === "exact" && !fresh.spacing && before) setNotice({ words, copy: before.words === words ? UPDATED_FOR_TIME : UPDATED_TO_TYPED })
      return
    }
    if (before.words !== words) setPublished({ words, reading: fresh })
    if (fresh.kind === "exact") {
      if (fresh.spacing || !schedulePreviewModel({ title: schedule.title, rrule: fresh.rrule, dtstart: fresh.dtstart, tz }, Date.now(), viewerTz).ok) return
      save.mutate({
        words,
        local: true,
        input: {
          id: schedule.id,
          revision: schedule.revision,
          whenText: fresh.phrase.trim(),
          rrule: fresh.rrule,
          dtstart: fresh.dtstart,
          tz,
          ...(dropCondition && schedule.condition ? { condition: null } : {}),
          source: { kind: "local", grammar: SCHEDULE_GRAMMAR_VERSION },
        },
      })
      return
    }
    if (fresh.kind !== "cue" && fresh.kind !== "none") return
    const current = whenView({ shown: { words, reading: fresh }, reader, tz, nowMs: Date.now(), stale: false })
    if (current.kind === "model") {
      const r = current.result
      save.mutate({
        words,
        local: false,
        input: { id: schedule.id, revision: schedule.revision, whenText: r.whenText, rrule: r.rrule, dtstart: r.dtstart, tz: r.tz, condition: r.condition ?? null },
      })
      return
    }
    const status = reader.view(words).status
    // Still reading, or the model's answer for exactly these words is on screen: nothing new to ask.
    if (status === "reading" || current.kind === "disagree" || (status === "answered" && current.kind === "copy")) {
      setShake((n) => n + 1)
      return
    }
    reader.request(words, { explicit: true })
  }

  const condition = schedule.condition?.trim()
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className={LABEL}>When</h3>
      <input
        data-schedule-when
        value={text}
        onChange={(e) => {
          const value = e.target.value
          dirty.current = true
          setText(value)
          setNotice(null)
          const native = e.nativeEvent as InputEvent
          if (publishesNow(native.inputType, value, e.target.selectionStart ?? value.length)) publish(value, "boundary")
          else {
            clearTimeout(restTimer.current)
            restTimer.current = setTimeout(() => publish(value), CHANGE_WHEN_REST_MS)
          }
        }}
        onBlur={() => {
          if (changed && publishedRef.current?.words !== words) publish(text)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault()
            commit()
          }
          if (e.key === "Escape" && changed) {
            // Claimed: the first Escape puts the words back, the next closes the drawer.
            e.preventDefault()
            e.stopPropagation()
            restore()
          }
        }}
        aria-label="When it runs"
        spellCheck={false}
        className="min-w-0 rounded-md border border-border bg-bg px-2.5 py-1.5 text-[13px] text-fg outline-none placeholder:text-muted focus:border-border-strong"
      />
      {shown && view.kind !== "none" && (
        // One 20px line rhythm, no gaps: the preview's lines, Still checks and a notice are one paragraph's
        // worth of lines, and a flex gap between some of them and not others read as two paragraphs.
        <div data-schedule-when-preview={view.kind} role="status" className="flex flex-col rounded-lg border border-border bg-panel-2 px-3 py-2">
          {view.kind === "local" && localSpec && <SchedulePreview spec={localSpec} nowMs={nowMs} viewerTz={viewerTz} />}
          {view.kind === "local" && localOk && condition && (
            <p data-schedule-when-condition={dropCondition ? "dropped" : "kept"} className="text-[12px] leading-5 text-muted">
              {dropCondition ? "Won't check: " : "Still checks: "}
              <span className={dropCondition ? "text-muted-70 line-through decoration-muted-50" : "text-fg/85"}>{condition}</span>
              {" · "}
              <button
                type="button"
                data-schedule-when-drop
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setDropCondition((d) => !d)}
                className="rounded-sm text-fg/80 underline decoration-border-strong underline-offset-2 outline-none transition-colors hover:text-fg hover:decoration-fg/50 focus-visible:ring-1 focus-visible:ring-focus-ink-60"
              >
                {dropCondition ? "Keep" : "Drop"}
              </button>
            </p>
          )}
          {view.kind === "model" && (
            <SchedulePreview spec={{ title: schedule.title, rrule: view.result.rrule, dtstart: view.result.dtstart, tz: view.result.tz, condition: view.result.condition ?? null }} nowMs={nowMs} viewerTz={viewerTz} />
          )}
          {view.kind === "reading" && view.core && (
            <SchedulePreview
              spec={{ title: schedule.title, rrule: view.core.rrule, dtstart: view.core.dtstart, tz, assumed: view.core.assumed }}
              nowMs={nowMs}
              viewerTz={viewerTz}
              pending={{ quoted: view.quoted ?? "", shimmer }}
            />
          )}
          {view.kind === "reading" && !view.core && (
            <p data-schedule-when-reading className="text-[13px] leading-5">
              <span className={shimmer ? "shimmer-text" : "text-muted"}>{view.quoted ? `Reading “${view.quoted}”…` : "Reading when it runs…"}</span>
            </p>
          )}
          {view.kind === "disagree" && (
            <>
              <SchedulePreview spec={{ title: schedule.title, rrule: view.result.rrule, dtstart: view.result.dtstart, tz: view.result.tz, condition: view.result.condition ?? null }} nowMs={nowMs} viewerTz={viewerTz} />
              <p data-schedule-when-disagree className="text-pretty text-[12px] leading-5 text-attention">
                Those words read two ways: {view.ours}, or {view.theirs}.
              </p>
              <p className="text-pretty text-[12px] leading-5 text-muted">Reword the part after “{view.corePhrase}”.</p>
            </>
          )}
          {view.kind === "copy" && <p data-schedule-when-refusal className="text-pretty text-[12px] leading-5 text-fg/85">{view.copy}</p>}
          {notice && notice.words === words && <p data-schedule-when-notice className="text-[12px] leading-5 text-muted">{notice.copy}</p>}
          <div className="mt-2 flex items-center justify-end gap-1.5">
            <button type="button" className={BUTTON} onMouseDown={(e) => e.preventDefault()} onClick={restore}>
              Cancel
            </button>
            {view.kind !== "copy" && (
              <button
                key={shake}
                type="button"
                data-schedule-when-save
                className={`${PRIMARY} ${shake > 0 ? "kbd-shake" : ""}`}
                disabled={!savable || save.isPending}
                title={view.kind === "reading" ? "Still reading" : view.kind === "disagree" ? "Reword it first" : "Save (Enter)"}
                onMouseDown={(e) => e.preventDefault()}
                onClick={commit}
              >
                {save.isPending ? "Saving…" : "Save"}
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

/** A published local reading: the words it read and what it read them as. */
interface Published {
  words: string
  reading: PhraseReading
}

/** §11: a local reading publishes at a word boundary, or after this long with the caret inside a word. */
const CHANGE_WHEN_REST_MS = 250
/** §11: words the grammar declines go to the model after this long with no input. */
const CHANGE_WHEN_MODEL_IDLE_MS = 600
/** §5.7: the shimmer waits this long, so a cached or fast answer never flashes it. */
const SHIMMER_DELAY_MS = 250

const EVENT_COPY = "Schedules run on the clock. Try “every hour, check whether the build failed”."
const STALE_COPY = "Frizz has updated since this page loaded. Reload the page to save this."
const UPDATED_FOR_TIME = "Updated for the current time. Press Enter to save."
const UPDATED_TO_TYPED = "Updated to what you typed. Press Enter to save."

type CueCore = NonNullable<Extract<PhraseReading, { kind: "cue" }>["core"]>
type WhenView =
  | { kind: "none" }
  | { kind: "local"; reading: Extract<PhraseReading, { kind: "exact" }> }
  | { kind: "model"; result: ModelReadOk }
  | { kind: "reading"; core?: CueCore; quoted?: string }
  | { kind: "disagree"; result: ModelReadOk; ours: string; theirs: string; corePhrase: string }
  | { kind: "copy"; copy: string }

/** What the preview shows for the words on screen: the local reading, a local refusal, or the model's. */
function whenView({ shown, reader, tz, nowMs, stale }: { shown: Published | null; reader: ModelReader; tz: string; nowMs: number; stale: boolean }): WhenView {
  if (!shown) return { kind: "none" }
  if (stale) return { kind: "copy", copy: STALE_COPY }
  const r = shown.reading
  if (r.kind === "exact") return r.spacing ? { kind: "copy", copy: SCHEDULE_SPACING_COPY } : { kind: "local", reading: r }
  if (r.kind === "ambiguous") return { kind: "copy", copy: r.copy }
  if (r.kind === "presence") return { kind: "copy", copy: SCHEDULE_PRESENCE_COPY }
  if (r.kind === "event") return { kind: "copy", copy: EVENT_COPY }
  const core = r.kind === "cue" ? r.core : undefined
  const quoted = r.kind === "cue" ? shown.words.slice(r.unread.start, r.unread.end) : undefined
  const mv = reader.view(shown.words)
  if (mv.status === "failed") return { kind: "copy", copy: MODEL_UNREACHABLE_COPY }
  if (mv.status === "budget") return { kind: "copy", copy: MODEL_BUDGET_COPY }
  // Waiting out the idle with words that read as nothing at all (the first word, still being typed): say
  // nothing until the model is actually asked. A cue shows what it IS sure of while it waits (§5.7).
  if (mv.status === "none" && r.kind === "none") return { kind: "none" }
  if (mv.status !== "answered") return { kind: "reading", ...(core ? { core } : {}), ...(quoted ? { quoted } : {}) }
  if (!mv.result.ok) return { kind: "copy", copy: modelRefusalCopy(mv.result) }
  const result = mv.result
  // A model reading over a local core must be a faithful reading of it (§4.3, I-10): it may add a condition,
  // a bound or a time, never move a day.
  if (core && !readingsConsistent({ ...core, tz }, { rrule: result.rrule, dtstart: result.dtstart, tz: result.tz, span: { start: 0, end: shown.words.length } }, nowMs)) {
    return { kind: "disagree", result, ours: describeRule(core.rrule, core.dtstart, tz), theirs: describeRule(result.rrule, result.dtstart, result.tz), corePhrase: shown.words.slice(core.span.start, core.span.end) }
  }
  return { kind: "model", result }
}

function describeRule(rrule: string, dtstart: string, tz: string): string {
  const c = compileSchedule({ rrule, dtstart, tz })
  return c.ok ? describeSchedule(c.value) : rrule
}

/** True once `on` has held for `ms` — a wait long enough to be worth showing motion for. */
function useDelayedTrue(on: boolean, ms: number): boolean {
  const [late, setLate] = useState(false)
  useEffect(() => {
    if (!on) {
      setLate(false)
      return
    }
    const t = setTimeout(() => setLate(true), ms)
    return () => clearTimeout(t)
  }, [on, ms])
  return on && late
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
