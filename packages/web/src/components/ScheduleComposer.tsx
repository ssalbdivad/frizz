import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { ArrowRightToLine, CornerDownLeft, Repeat, X } from "lucide-react"
import {
  SCHEDULE_GRAMMAR_VERSION,
  SCHEDULE_PRESENCE_COPY,
  SCHEDULE_READING_MOVED,
  SCHEDULE_SPACING_COPY,
  compileSchedule,
  cutPhrase,
  describeSchedule,
  isScheduleOffer,
  provisionalScheduleTitle,
  readingsConsistent,
  scheduleRefusalOf,
  type CreateScheduleInput,
  type PhraseReading,
  type ScheduleView,
  type Span,
} from "@frizz/shared"
import { projectRpc, rpc } from "../api/rpc.ts"
import { flashScheduleCount, pushScheduleDrawer, showToast } from "../store.ts"
import { invalidateSchedules } from "../lib/schedules.ts"
import { useScheduleDraftState, writeScheduleDraftState } from "../lib/scheduleDraftState.ts"
import { MODEL_IDLE_MS, dismissalEdge, useScheduleOffer, type BoxInputEvent, type Dismissed, type Published } from "../lib/scheduleOffer.ts"
import { draftAfter, keyAction, sendGlyphOf, type ScheduleKey, type ScheduleUiState } from "../lib/scheduleIntent.ts"
import {
  MODEL_BUDGET_COPY,
  MODEL_UNREACHABLE_COPY,
  isModelVerdict,
  modelReadKey,
  modelRefusalCopy,
  relocateModelReading,
  useModelReader,
  type ModelReadOk,
  type ModelReader,
} from "../lib/scheduleModelRead.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { useIsMobile } from "../lib/mobile.ts"
import { spanUntil } from "../lib/activityTime.ts"
import { PreviewDescribe, SOON_MS, browserZone, schedulePreviewModel, type PreviewSegment } from "./SchedulePreview.tsx"
import type { ComposerMark } from "./Composer.tsx"

// THE PROMPT BOX'S LIVE SCHEDULE READING (plans/schedule-live-reading.md — the spec; §0 is the feature on one
// screen). The new-thread box reads its own words for WHEN, as they are typed, with the local grammar
// (`readSchedulePhrase`) and the box's publish policy (lib/scheduleOffer.ts):
//
//   every Monday at 9am triage new issues          ← a dotted underline under the phrase (an OFFER)
//   └ ↻ Every Monday at 9am · next Mon Oct 12, in 6d    ⇥ Schedule  ↵ Start now  ×   ← the LEDGE
//
// Nothing about Enter changes while an offer shows: it starts the thread, and the ledge says so. Tab (or the
// glyph, ⌘⌥↵, the ledge's Schedule) ACCEPTS: the underline floods into the accent, the ledge grows into the
// PANEL in the same pixels, the send button's arrow becomes the repeat glyph, and Enter creates the schedule.
// Esc or × puts an offer away for that edge of the draft (§8), and it stays away through refinements.
//
// What the grammar declines — a condition, a vague count, an event offset, a zone, a typo — the model reads
// (lib/scheduleModelRead.ts), and ONLY in the mode: never while an offer is merely showing (§4.2).
//
// THE SAFETY STORY is in three places, each with its tests:
//   - lib/scheduleIntent.ts `keyAction` — every key in every state; this file and PromptForm only execute
//     what it returns (I-1 nothing creates outside the mode, I-2 nothing dispatches or saves lazily in it,
//     I-3 only an explicit act sets the mode);
//   - lib/scheduleDraftState.ts — the mode is part of the draft (I-4);
//   - T3 here (`commit`): Enter re-reads the text NOW and creates only what is on screen (I-6, I-7), and the
//     server re-derives a local reading with the same grammar before it writes anything (§10.1).

/** What the box hands in. */
export interface LiveScheduleInput {
  /** The mode's key (`draftKey.dispatchSchedule`, lib/scheduleDraftState.ts): a sibling of the prompt's own,
   *  so the mode lives and dies with the draft and every box on it reads one value. */
  draftKey: string
  /** The prose the box SHOWS (no attachment lines) — what every span indexes. */
  prose: string
  /** Runs never read: code, staged context tokens, mentions, commands (Composer `composerExcludeRuns`). */
  exclude: readonly Span[]
  /** The prompt a schedule would save for a CUT prose — chips serialized, user commands expanded,
   *  attachments rejoined — exactly as a lazy save writes it. "" when nothing is left. */
  promptOf: (cutProse: string) => string
  /** The model/effort the box would dispatch on. Undefined while the profile is loading. */
  profile: { model: string; backend: CreateScheduleInput["backend"]; effort: CreateScheduleInput["effort"] } | undefined
  /** Whether the box may act at all (a settings write in flight, an account alias typed). */
  blocked: boolean
  /** The draft became a schedule: take it out of the box (`submittedProse` is what was read; anything typed
   *  after it stays). Returns how to put it back, for Undo. */
  onCreated: (submittedProse: string) => () => void
  /** Focus the box (this one, or the page's when this one is gone), caret at the end. */
  focus: () => void
}

/** What the caller still has to do for a key, after this hook did the schedule's half. */
export type ScheduleKeyOutcome = "dispatch" | "lazy" | "native" | "blur" | "handled"

export interface LiveSchedule {
  on: boolean
  state: ScheduleUiState
  /** How the rail glyph reads (§5.2). */
  glyph: "off" | "hint" | "on"
  /** The glyph's tooltip while an offer shows ("Schedule every Monday at 9am (Tab)"); else the Composer's. */
  glyphTitle: string | undefined
  marks: ComposerMark[]
  /** The ledge under the box (S1–S3), or null. */
  ledge: ReactNode | null
  /** The panel (the mode), or null. The ledge and the panel are ONE element in one slot, so the ledge grows
   *  into the panel; `slot` is whichever is showing, kept a moment while it folds away. */
  panel: ReactNode | null
  slot: ReactNode | null
  slotOpen: boolean
  /** A polite live-region line, once per offer appearance (§5.3). */
  announcement: string
  sendGlyph: "send" | "schedule"
  lazyBlocked: boolean
  /** Ask the §7 matrix what a key does here, and do the schedule's half of it. */
  key: (k: ScheduleKey) => ScheduleKeyOutcome
  onTab: () => boolean
  onEscape: () => boolean
  toggle: () => void
  onInputEvent: (e: BoxInputEvent) => void
}

// ---- copy (§5) --------------------------------------------------------------------------------------------------

const NOTHING_TO_DO = "Say what it should do as well, like “every Monday at 9am triage new issues”."
const NO_TASK_LINE = "Say what each run should do."
const EMPTY_COPY = "Type what to do and when it runs, like “every weekday at 9am triage new issues”."
const EVENT_COPY = "Schedules run on the clock. Try “every hour, check whether the build failed”."
const STALE_COPY = "Frizz has updated since this page loaded. Reload the page to create this schedule."
const UPDATED_FOR_TIME = "Updated for the current time. Press Enter to create."
const UPDATED_TO_TYPED = "Updated to what you typed. Press Enter to create."

// ---- timing (§6) --------------------------------------------------------------------------------------------------

/** A model wait shows its shimmer only after this long, so a cached or fast answer never flashes it. */
const SHIMMER_DELAY_MS = 250
/** Create reads "Creating…" only once the request has taken this long. */
const CREATING_LABEL_MS = 150
/** The accent mark's wash, bright and back, before the box clears. */
const WASH_MS = 220
/** How long a ledge or panel that went away stays mounted while its slot folds. */
const SLOT_LINGER_MS = 160
/** The created toast's life: the Undo window. */
const UNDO_WINDOW_MS = 8_000

/** The dismissals as they were before the mode was entered, per draft — what Undo restores (§1.3.1). Kept for
 *  the tab only: a reload in the mode loses it, and Undo then re-arms every edge, which is the safe side. */
const beforeAccept = new Map<string, Dismissed>()

type Exact = Extract<PhraseReading, { kind: "exact" }>
type Cue = Extract<PhraseReading, { kind: "cue" }>
type CueCore = NonNullable<Cue["core"]>

/** What the panel shows for the text in the mode. */
export type ModeView =
  | { kind: "empty" }
  /** M1, read locally. */
  | { kind: "local"; reading: Exact; prompt: string; title: string }
  /** M1, the model's reading, relocated onto the prose as it is now. `text` is the text the model READ, which
   *  its offsets index (a reading carried over a task-only edit read an older text). */
  | { kind: "model"; result: ModelReadOk; text: string; span: Span; prompt: string; core?: Span }
  /** M2: the model is reading (or about to, after the idle). */
  | { kind: "reading"; core?: CueCore; quoted?: string; span?: Span; unread?: Span; edited: boolean; prompt?: string }
  /** M3: the model's reading is not a faithful reading of the grammar's core. */
  | { kind: "disagree"; result: ModelReadOk; span: Span; core: Span; ours: string; theirs: string; corePhrase: string; prompt: string }
  /** M4: refused or blocked. `rereads`: Enter reads the text again (it changed, or the read itself failed). A
   *  local reading with no task left keeps its `reading` on screen above the copy. */
  | { kind: "copy"; copy: string; rereads: boolean; mark?: Span; reading?: Exact }

/** Words the model reads: a cue with a task left once its phrase is cut, or text the grammar reads as no
 *  schedule at all. Never an exact reading, an event, a presence, an ambiguous word or a spacing violation
 *  (I-8). */
export function needsModel(p: Published, promptOf: (cut: string) => string): boolean {
  const r = p.reading
  if (!p.prose.trim()) return false
  if (r.kind === "none") return true
  return r.kind === "cue" && promptOf(cutPhrase(p.prose, r.span)) !== ""
}

function describeRule(rrule: string, dtstart: string, tz: string): string {
  const c = compileSchedule({ rrule, dtstart, tz })
  return c.ok ? describeSchedule(c.value) : rrule
}

const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s)
const firstLine = (s: string) => s.split("\n")[0] ?? ""

/** The panel's view of the text (pure, given the reader's state). */
export function modeViewOf(a: {
  prose: string
  shown: Published | null
  reader: Pick<ModelReader, "view" | "lastAnswer">
  tz: string
  nowMs: number
  promptOf: (cut: string) => string
  stale: string | null
  near: number | undefined
  hadModel: boolean
}): ModeView {
  const { prose, shown } = a
  if (!prose.trim()) return { kind: "empty" }
  if (a.stale !== null && a.stale === prose) return { kind: "copy", copy: STALE_COPY, rereads: false }
  if (!shown) return { kind: "reading", edited: false }
  const r = shown.reading
  // The words on screen were read before a half-typed word: Enter reads them again (§7, M4).
  const changed = shown.read !== prose
  if (r.kind === "exact") {
    if (r.spacing) return { kind: "copy", copy: SCHEDULE_SPACING_COPY, rereads: changed, mark: r.span }
    const preview = schedulePreviewModel({ title: "", rrule: r.rrule, dtstart: r.dtstart, tz: a.tz, assumed: r.assumed }, a.nowMs, a.tz)
    if (!preview.ok) return { kind: "copy", copy: preview.error, rereads: changed, mark: r.span }
    const prompt = a.promptOf(cutPhrase(prose, r.span))
    if (!prompt) return { kind: "copy", copy: NO_TASK_LINE, rereads: changed, reading: r }
    return { kind: "local", reading: r, prompt, title: provisionalScheduleTitle(prompt) }
  }
  if (r.kind === "ambiguous") return { kind: "copy", copy: r.copy, rereads: changed, mark: r.span }
  if (r.kind === "presence") return { kind: "copy", copy: SCHEDULE_PRESENCE_COPY, rereads: changed }
  if (r.kind === "event") return { kind: "copy", copy: EVENT_COPY, rereads: changed }
  if (r.kind === "cue" && !a.promptOf(cutPhrase(prose, r.span))) return { kind: "copy", copy: NOTHING_TO_DO, rereads: changed }

  // A cue, or no schedule the grammar can see: the model's. Its answer for these exact words, or the last
  // answer still standing over an edit to the task alone (§4.2: a model reading belongs to its phrase).
  const mv = a.reader.view(prose)
  let answer: { result: ModelReadOk; text: string; span: Span; prompt: string } | undefined
  if (mv.status === "answered" && mv.result.ok) {
    // The answer for exactly these words: its own offsets, clamped to them.
    const span = { start: Math.min(mv.result.phraseStart, prose.length), end: Math.min(mv.result.phraseEnd, prose.length) }
    answer = { result: mv.result, text: prose, span, prompt: a.promptOf(cutPhrase(prose, span)) }
  } else if (mv.status === "none") {
    const last = a.reader.lastAnswer()
    if (last?.result.ok) {
      const at = relocateModelReading(prose, { text: last.text, result: last.result }, a.near)
      if (at) answer = { result: last.result, text: last.text, span: at.span, prompt: a.promptOf(at.prompt) }
    }
  }
  const core = r.kind === "cue" ? r.core : undefined
  if (answer) {
    if (!answer.prompt) return { kind: "copy", copy: NOTHING_TO_DO, rereads: changed }
    // A model reading over a local core must be a faithful reading of it (§4.3, I-10).
    if (core && !readingsConsistent({ ...core, tz: a.tz }, { rrule: answer.result.rrule, dtstart: answer.result.dtstart, tz: answer.result.tz, span: answer.span }, a.nowMs)) {
      return {
        kind: "disagree",
        result: answer.result,
        span: answer.span,
        core: core.span,
        ours: describeRule(core.rrule, core.dtstart, a.tz),
        theirs: describeRule(answer.result.rrule, answer.result.dtstart, answer.result.tz),
        corePhrase: prose.slice(core.span.start, core.span.end),
        prompt: answer.prompt,
      }
    }
    return { kind: "model", result: answer.result, text: answer.text, span: answer.span, prompt: answer.prompt, ...(core ? { core: core.span } : {}) }
  }
  if (mv.status === "failed") return { kind: "copy", copy: MODEL_UNREACHABLE_COPY, rereads: true }
  if (mv.status === "budget") return { kind: "copy", copy: MODEL_BUDGET_COPY, rereads: true }
  if (mv.status === "answered" && !mv.result.ok) return { kind: "copy", copy: modelRefusalCopy(mv.result), rereads: changed || !isModelVerdict(mv.result) }
  return {
    kind: "reading",
    edited: a.hadModel,
    ...(core ? { core } : {}),
    ...(r.kind === "cue" ? { quoted: prose.slice(r.unread.start, r.unread.end), span: r.span, unread: r.unread, prompt: a.promptOf(cutPhrase(prose, r.span)) } : {}),
  }
}

/** The §5 state the keys read. */
export function uiStateOf(on: boolean, creating: boolean, offer: Published | null, view: ModeView | null): ScheduleUiState {
  if (!on) {
    const r = offer?.reading
    if (!r) return { name: "S0" }
    return { name: r.kind === "exact" ? "S1" : r.kind === "cue" ? "S2" : r.kind === "ambiguous" ? "S3" : "S0" }
  }
  if (creating) return { name: "creating" }
  switch (view?.kind) {
    case undefined:
    case "empty":
      return { name: "M5" }
    case "local":
    case "model":
      return { name: "M1" }
    case "reading":
      return { name: "M2" }
    case "disagree":
      return { name: "M3" }
    case "copy":
      return { name: "M4", changed: view.rereads }
  }
}

/** What Enter in M1 does with the text as it reads NOW (T3, §10.1): create the reading on screen when the fresh
 *  read is that same reading (span, rule, start — I-7), show the fresh one instead when it differs, or read
 *  again. A model reading is created only while it still stands over the text (its phrase untouched). */
export type T3Decision =
  | { act: "create-local"; reading: Exact; prompt: string }
  | { act: "create-model"; result: ModelReadOk; prompt: string }
  | { act: "show"; notice: string }
  | { act: "reread" }
export function t3(a: { view: ModeView | null; shownRead: string | undefined; fresh: Published; promptOf: (cut: string) => string }): T3Decision {
  const { view, fresh } = a
  const r = fresh.reading
  if (r.kind === "exact" && !r.spacing) {
    const onScreen = view?.kind === "local" ? view.reading : undefined
    if (!onScreen || onScreen.span.start !== r.span.start || onScreen.span.end !== r.span.end || onScreen.rrule !== r.rrule || onScreen.dtstart !== r.dtstart) {
      // Unchanged words that read differently now are the clock's doing (a minute rolled over, a midnight
      // passed); otherwise an edit not yet published caused it.
      return { act: "show", notice: a.shownRead === fresh.prose ? UPDATED_FOR_TIME : UPDATED_TO_TYPED }
    }
    const prompt = a.promptOf(cutPhrase(fresh.prose, r.span))
    return prompt ? { act: "create-local", reading: r, prompt } : { act: "reread" }
  }
  if (view?.kind === "model" && (r.kind === "cue" || r.kind === "none")) {
    const at = relocateModelReading(fresh.prose, { text: view.text, result: view.result }, view.span.start)
    const prompt = at ? a.promptOf(at.prompt) : ""
    if (at && prompt) return { act: "create-model", result: view.result, prompt }
  }
  return { act: "reread" }
}

/** The glyph lights (`hint`, the text's own ink) with no offer on screen when the text still reads as a
 *  schedule the box will not offer (§5.2): a dismissed edge, a spacing violation, a close-edge cue, a vetoed
 *  close edge. */
function hintsWithoutOffer(last: Published | null, dismissed: Dismissed): boolean {
  const r = last?.reading
  if (!r) return false
  if (isScheduleOffer(r)) {
    const edge = dismissalEdge(r)
    return (edge === "open" && !!dismissed.open) || (edge === "close" && !!dismissed.close)
  }
  if (r.kind === "exact") return (r.edge === "open" || r.edge === "close") && !r.once && (!!r.spacing || !!r.veto)
  return r.kind === "cue" && r.edge === "close"
}

/** The offer's dotted underline, cut where it grew, so a phrase that extends draws only its new tail. */
type OfferCuts = { start: number; end: number; cuts: number[] }
function nextCuts(prev: OfferCuts | null, span: Span): OfferCuts {
  if (prev && prev.start === span.start) {
    if (span.end > prev.end) return { start: span.start, end: span.end, cuts: [...prev.cuts, prev.end] }
    return { start: span.start, end: span.end, cuts: prev.cuts.filter((c) => c < span.end) }
  }
  return { start: span.start, end: span.end, cuts: [] }
}

export function useLiveSchedule(input: LiveScheduleInput): LiveSchedule {
  const { draftKey, prose, exclude, promptOf, profile, blocked } = input
  const queryClient = useQueryClient()
  const [mode, setMode] = useScheduleDraftState(draftKey)
  const on = mode.on
  const tz = browserZone()
  const nowMs = useNowMs()
  // THE PHONE (§12): no keys, so the ledge is a TAP ROW and the panel shows no `Esc`. Same rules, same
  // edges, same publish policy; only what is drawn differs.
  const phone = useIsMobile()
  const offer = useScheduleOffer({ prose, exclude, mode: on, dismissed: mode.dismissed, tz })
  const reader = useModelReader({
    interpret: (text) => rpc.interpretSchedule({ text, tz }),
    keyOf: (text, at) => modelReadKey({ tz, nowMs: at, text }),
  })
  const [notice, setNotice] = useState<{ prose: string; copy: string } | null>(null)
  const [stale, setStale] = useState<string | null>(null)
  const movedOnce = useRef<string | null>(null)
  const [shake, setShake] = useState(0)
  const [flash, setFlash] = useState(0)
  const [committing, setCommitting] = useState(false)
  const hadModel = useRef(false)
  const modelNear = useRef<number | undefined>(undefined)
  const latest = useRef(input)
  latest.current = input

  // A dismissed edge that re-armed (its phrase deleted) is written back to the draft — the dismissal, never
  // the mode (I-3).
  const effective = offer.dismissed
  useEffect(() => {
    if (!!effective.open === !!mode.dismissed.open && !!effective.close === !!mode.dismissed.close) return
    setMode((m) => ({ ...m, dismissed: { ...(m.dismissed.open && effective.open ? { open: true as const } : {}), ...(m.dismissed.close && effective.close ? { close: true as const } : {}) } }))
  }, [effective.open, effective.close, mode.dismissed.open, mode.dismissed.close])

  /** The last model answer, still standing over the text as it is now (a task-only edit keeps it). */
  const standingAnswer = (text: string) => {
    const last = reader.lastAnswer()
    return last?.result.ok ? relocateModelReading(text, { text: last.text, result: last.result }, modelNear.current) : undefined
  }

  // THE MODEL, in the mode only, after MODEL_IDLE_MS with no input, for words the grammar declines (§4.2 rule
  // 2). The words are read fresh when the timer fires; an answer that still stands over a task-only edit is
  // not asked again.
  useEffect(() => {
    if (!on || !prose.trim() || blocked) {
      reader.cancelQueued()
      return
    }
    const t = setTimeout(() => {
      const fresh = offer.readNow(true)
      if (needsModel(fresh, latest.current.promptOf) && !standingAnswer(fresh.prose)) reader.request(fresh.prose)
      else reader.cancelQueued()
    }, MODEL_IDLE_MS)
    return () => clearTimeout(t)
  }, [prose, on, blocked])

  const view = on
    ? modeViewOf({ prose, shown: offer.shown, reader, tz, nowMs, promptOf, stale, near: modelNear.current, hadModel: hadModel.current })
    : null
  useEffect(() => {
    if (!view) {
      hadModel.current = false
      return
    }
    if (view.kind === "model" || view.kind === "disagree") {
      hadModel.current = true
      modelNear.current = view.span.start
    } else if (view.kind !== "reading") hadModel.current = false
  })

  // ---- create (T3, §10.1) -------------------------------------------------------------------------------------

  type CreateJob = { input: CreateScheduleInput; prose: string; local: boolean; startedAt: number; dismissed: Dismissed }
  const create = useMutation({
    mutationFn: (job: CreateJob) => rpc.createSchedule(job.input),
    onSuccess: (created: ScheduleView, job) => {
      setCommitting(true)
      // The mark washes bright and back first (§5.11), then the box clears and the panel folds as the text
      // leaves — the words read as having become the schedule.
      setTimeout(() => {
        setCommitting(false)
        movedOnce.current = null
        setNotice(null)
        const restore = latest.current.onCreated(job.prose)
        invalidateSchedules(queryClient)
        flashScheduleCount(created.projectId)
        showToast(`${created.title} scheduled`, {
          detail: toastDetail(created, Date.now()),
          actions: [
            { label: "Undo", run: () => undo(created, restore, job.dismissed) },
            { label: "Open", run: () => pushScheduleDrawer(created.id, created.projectId) },
          ],
          duration: UNDO_WINDOW_MS,
        })
      }, Math.max(0, WASH_MS - (Date.now() - job.startedAt)))
    },
    onError: (error, job) => {
      const refusal = scheduleRefusalOf(error)
      // The server read the phrase differently at its clock (a minute rolled over, a midnight passed): read it
      // again here and show that. A second refusal of the same words means the two cannot agree from this
      // page, and so does a grammar version skew: the page has to reload (§10.1, §1.3.4).
      if (refusal === SCHEDULE_READING_MOVED && job.local && movedOnce.current !== job.prose) {
        movedOnce.current = job.prose
        offer.force()
        setNotice({ prose: job.prose, copy: UPDATED_FOR_TIME })
        return
      }
      if (refusal) {
        setNotice(null)
        setStale(job.prose)
        return
      }
      showToast(`Could not create the schedule: ${(error as Error).message.slice(0, 100)}`)
    },
  })
  const creating = create.isPending || committing
  const creatingLabel = useDelayedTrue(create.isPending, CREATING_LABEL_MS)

  /** Undo (§5.11, I-13): delete the schedule, then put back exactly what the accept took — the text merged
   *  with anything typed since, the chips, the pick, the mode off and the dismissals as they were. The offer
   *  re-derives from the text, so `⇥ Schedule  ↵ Start now` is back on screen. */
  const undo = (created: ScheduleView, restore: () => void, dismissed: Dismissed) => {
    void projectRpc(created.projectId).deleteSchedule({ id: created.id }).then(
      () => {
        invalidateSchedules(queryClient, created.id)
        restore()
        writeScheduleDraftState(draftKey, { v: 1, on: false, dismissed })
        latest.current.focus()
      },
      (error: unknown) => showToast(`Could not undo: ${(error as Error).message.slice(0, 100)}`),
    )
  }

  /** Enter in M1 (T3): read the text again NOW, and create only if that is what the panel shows. */
  const commit = () => {
    if (blocked || !profile || creating) return
    const fresh = offer.readNow(true)
    const decision = t3({ view, shownRead: offer.shown?.read, fresh, promptOf })
    const base = { prose: fresh.prose, startedAt: Date.now(), dismissed: beforeAccept.get(draftKey) ?? {} }
    const pick = {
      model: profile.model,
      ...(profile.backend ? { backend: profile.backend } : {}),
      ...(profile.effort ? { effort: profile.effort } : {}),
    }
    switch (decision.act) {
      case "show":
        // Something else is on screen than what the text reads now: show the fresh reading and create
        // nothing (I-7). The next Enter creates it.
        offer.force(fresh)
        setNotice({ prose: fresh.prose, copy: decision.notice })
        return
      case "create-local": {
        const r = decision.reading
        create.mutate({
          ...base,
          local: true,
          input: {
            title: provisionalScheduleTitle(decision.prompt),
            titleAuto: true,
            prompt: decision.prompt,
            whenText: r.phrase.trim(),
            rrule: r.rrule,
            dtstart: r.dtstart,
            tz,
            source: { kind: "local", grammar: SCHEDULE_GRAMMAR_VERSION },
            ...pick,
          },
        })
        return
      }
      case "create-model": {
        const m = decision.result
        create.mutate({
          ...base,
          local: false,
          input: {
            title: m.title,
            prompt: decision.prompt,
            whenText: m.whenText,
            rrule: m.rrule,
            dtstart: m.dtstart,
            tz: m.tz,
            ...(m.condition ? { condition: m.condition } : {}),
            ...pick,
          },
        })
        return
      }
      case "reread":
        reread(fresh)
    }
  }

  /** Read the text again now and put it on screen; the model reads what the grammar declines (an explicit
   *  read: never budgeted). */
  const reread = (fresh = offer.readNow(true)) => {
    offer.force(fresh)
    setStale(null)
    if (!blocked && needsModel(fresh, promptOf) && !standingAnswer(fresh.prose)) reader.request(fresh.prose, { explicit: true })
  }

  // ---- the explicit acts ------------------------------------------------------------------------------------

  const enterMode = () => {
    beforeAccept.set(draftKey, mode.dismissed)
    reader.reset()
    hadModel.current = false
    movedOnce.current = null
    setNotice(null)
    setStale(null)
    // Entering explicitly re-arms every edge (§8); Undo puts them back as they were.
    setMode((m) => draftAfter("enter-mode", m))
    // Read now, in the mode's scope: a cue or dark text goes to the model at once (§4.2 rule 1).
    const fresh = offer.readNow(true)
    if (!blocked && needsModel(fresh, promptOf)) reader.request(fresh.prose, { explicit: true })
  }

  /** The edge "not a schedule" applies to: the offer at an edge, else the mode's own reading at one. */
  const edgeToDismiss = () => {
    const edges = offer.readNow(false).reading
    return isScheduleOffer(edges) ? dismissalEdge(edges) : dismissalEdge(offer.shown?.reading)
  }
  const leave = (dismiss: boolean) => {
    const edge = dismiss ? edgeToDismiss() : undefined
    reader.cancelQueued()
    setNotice(null)
    setMode((m) => draftAfter(dismiss ? "leave-dismiss" : "leave", m, edge))
  }
  const shownOffer = !on ? offer.shown : null
  const dismiss = () => {
    const edge = dismissalEdge(shownOffer?.reading)
    if (edge) setMode((m) => draftAfter("dismiss", m, edge))
  }

  const state = uiStateOf(on, creating, shownOffer, view)
  const key = (k: ScheduleKey): ScheduleKeyOutcome => {
    const action = keyAction(state, k)
    switch (action) {
      case "dispatch":
      case "lazy":
      case "native":
      case "blur":
        return action
      case "accept":
      case "enter-mode":
        enterMode()
        return "handled"
      case "leave":
        leave(false)
        return "handled"
      case "leave-dismiss":
        leave(true)
        return "handled"
      case "dismiss":
        dismiss()
        return "handled"
      case "create":
        commit()
        return "handled"
      case "read":
        reread()
        return "handled"
      case "nudge":
        setShake((n) => n + 1)
        return "handled"
      case "noop-flash":
        setFlash((n) => n + 1)
        return "handled"
      case "noop":
        return "handled"
    }
  }

  // ---- what the box draws -------------------------------------------------------------------------------------

  const cutsRef = useRef<OfferCuts | null>(null)
  const marks: ComposerMark[] = []
  if (shownOffer) {
    const r = shownOffer.reading
    const dotted = r.kind === "exact" ? r.span : r.kind === "cue" ? r.core?.span : undefined
    if (dotted) {
      const cuts = nextCuts(cutsRef.current, dotted)
      cutsRef.current = cuts
      const edges = [cuts.start, ...cuts.cuts, cuts.end]
      for (let i = 0; i + 1 < edges.length; i++) marks.push({ start: edges[i]!, end: edges[i + 1]!, tone: "offer", key: `m:${edges[i]}` })
    } else cutsRef.current = null
    if (r.kind === "cue") marks.push(r.core ? { start: r.unread.start, end: r.unread.end, tone: "unread", key: `u:${r.unread.start}` } : { start: r.span.start, end: r.span.end, tone: "unread", key: `u:${r.span.start}` })
    if (r.kind === "ambiguous") marks.push({ start: r.span.start, end: r.span.end, tone: "unread", key: `u:${r.span.start}` })
  } else {
    cutsRef.current = null
  }
  if (view) {
    const fill = creating ? "wash" : "accepted"
    if (view.kind === "local") marks.push({ ...view.reading.span, tone: fill, key: `m:${view.reading.span.start}` })
    if (view.kind === "model") {
      const core = view.core
      if (core) {
        marks.push({ ...core, tone: fill, key: `m:${core.start}` })
        if (view.span.start < core.start) marks.push({ start: view.span.start, end: core.start, tone: creating ? "wash" : "grow", key: `g:${view.span.start}` })
        if (view.span.end > core.end) marks.push({ start: core.end, end: view.span.end, tone: creating ? "wash" : "grow", key: `g:${core.end}` })
      } else marks.push({ ...view.span, tone: creating ? "wash" : "grow", key: `g:${view.span.start}` })
    }
    if (view.kind === "reading") {
      if (view.core) marks.push({ ...view.core.span, tone: "accepted", key: `m:${view.core.span.start}` })
      if (view.unread) marks.push({ ...view.unread, tone: "reading", key: `u:${view.unread.start}` })
    }
    if (view.kind === "disagree") {
      marks.push({ ...view.core, tone: "accepted", key: `m:${view.core.start}` })
      if (view.span.end > view.core.end) marks.push({ start: view.core.end, end: view.span.end, tone: "unread", key: `u:${view.core.end}` })
    }
    if (view.kind === "copy" && view.mark) marks.push({ ...view.mark, tone: "unread", key: `u:${view.mark.start}` })
    if (view.kind === "copy" && view.reading) marks.push({ ...view.reading.span, tone: "accepted", key: `m:${view.reading.span.start}` })
  }

  const glyph: LiveSchedule["glyph"] = on ? "on" : shownOffer || hintsWithoutOffer(offer.last, effective) ? "hint" : "off"
  let glyphTitle: string | undefined
  const tabHint = phone ? "" : " (Tab)"
  if (shownOffer?.reading.kind === "exact") glyphTitle = `Schedule ${describeRule(shownOffer.reading.rrule, shownOffer.reading.dtstart, tz)}${tabHint}`
  else if (shownOffer?.reading.kind === "cue") glyphTitle = `Schedule this${tabHint}`

  // One polite line per offer APPEARANCE, never per refinement (§5.3).
  const [announcement, setAnnouncement] = useState("")
  const offerShowing = shownOffer !== null
  useEffect(() => {
    if (!offerShowing || !shownOffer) return
    const r = shownOffer.reading
    const words = r.kind === "exact" ? describeRule(r.rrule, r.dtstart, tz) : r.kind === "cue" ? `“${r.phrase}”` : ""
    setAnnouncement(r.kind === "ambiguous" ? r.copy : `Schedule suggestion: ${words}. ${phone ? "Tap Schedule" : "Press Tab"} to schedule it.`)
  }, [offerShowing])

  const each = useEachRun(shownOffer, prose, promptOf)
  const ledge = shownOffer ? (
    <ScheduleSlot
      form="ledge"
      phone={phone}
      line={phone
        ? <TapRowLine shown={shownOffer} prose={prose} nowMs={nowMs} tz={tz} onSchedule={() => key("schedule")} onClose={() => key("close")} />
        : <LedgeLine shown={shownOffer} prose={prose} each={each} nowMs={nowMs} tz={tz} onSchedule={() => key("schedule")} onClose={() => key("close")} />}
      title={each && !phone ? `Each run: ${each}` : undefined}
    />
  ) : null
  const panel = view ? (
    <ScheduleSlot
      form="panel"
      phone={phone}
      {...panelParts({
        view,
        state,
        phone,
        nowMs,
        tz,
        notice: notice && notice.prose === prose ? notice.copy : undefined,
        shake,
        flash,
        creatingLabel,
        onCancel: () => key("esc"),
        onCreate: () => key("enter"),
      })}
    />
  ) : null
  const current = ledge ?? panel
  const slot = useLinger(current, SLOT_LINGER_MS)

  return {
    on,
    state,
    glyph,
    glyphTitle,
    marks,
    ledge,
    panel,
    slot,
    slotOpen: current !== null,
    announcement,
    sendGlyph: sendGlyphOf(state),
    lazyBlocked: on,
    key,
    onTab: () => key("tab") === "handled",
    onEscape: () => key("esc") === "handled",
    toggle: () => void key("schedule"),
    onInputEvent: offer.onInput,
  }
}

function toastDetail(view: ScheduleView, nowMs: number): string | undefined {
  const describe = capitalize(view.describe)
  const first = view.upcoming[0]
  if (!first) return describe
  const span = spanUntil(first, nowMs)
  if (Date.parse(first) - nowMs < SOON_MS) return span ? `${describe} · first run in ${span}` : describe
  const day = view.nextLine.replace(/^Next: /, "").split(" · ")[0]
  return `${describe} · next ${day}${span ? `, in ${span}` : ""}`
}

/** The ledge's `Each run` text: the first line of the cut prompt, as the text read at the last PUBLISH point.
 *  Inside a word the offer is carried (`shown.prose` moves on, `shown.read` does not), and the segment holds,
 *  so it fills in a word at a time (§0.1) rather than flickering with every letter. */
function useEachRun(shown: Published | null, prose: string, promptOf: (cut: string) => string): string {
  const held = useRef("")
  if (!shown) held.current = ""
  else if (shown.prose === shown.read) {
    const r = shown.reading
    held.current = r.kind === "exact" || r.kind === "cue" ? firstLine(promptOf(cutPhrase(prose, r.span))) : ""
  }
  return held.current
}

/** A value that went away, kept for `ms` so what showed it can fold rather than vanish. */
function useLinger<T>(value: T | null, ms: number): T | null {
  const kept = useRef<T | null>(value)
  const [, bump] = useState(0)
  if (value !== null) kept.current = value
  const gone = value === null
  useEffect(() => {
    if (!gone) return
    const t = setTimeout(() => {
      kept.current = null
      bump((n) => n + 1)
    }, ms)
    return () => clearTimeout(t)
  }, [gone, ms])
  return value ?? kept.current
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

// ---- the slot: one element, a ledge that grows into the panel ---------------------------------------------------

/**
 * THE LEDGE ROW'S RHYTHM, in one place. `gap` spaces boxes and the eye spaces ink, so every mark's box is
 * collapsed onto its own ink (iconRhythm.ts's method) and the gaps below are the distances the eye reads.
 * Dead space is GEOMETRY, not a fit: a lucide glyph's stroke (2 units) reaches 1 unit past its outermost
 * path, so `Repeat` and `ArrowRightToLine` (paths x 3–21) leave 2 of 24 units a side and `CornerDownLeft`
 * (x 4–20) and `X` (x 6–18) leave 3 and 5.
 *
 * Measured on the real ledge (scratch/optics-live-box.ts, 466px — the All-projects column at 1440 — 12px
 * sans, dsf 6, 2026-10-06), ink gaps before → after:
 *   border → ↻ 10.83 → 10.83 (the left inset)    ↻ → reading 9.67 → 7.67
 *   ⇥ → Schedule 5.83 → 4.9                      ↵ → Start now 6.50 → 4.9
 *   Schedule → ↵ 13.66 → 12.3                    Start now → × 18.39 → 12.1
 *   × → border 12.33 → 10.83 (the right inset, now the left's)
 * Before, the glyph floated halfway between the border and its words, the keycaps sat at two distances from
 * their own words, and the × hung 6.5px further out than the gap it shared: 4px of button padding plus
 * 2.5px of its viewBox.
 */
const GLYPH_TO_TEXT_TRIM = "-mr-0.5" // ↻: gap-2 (8) + 1px of viewBox − 2 = 7.67 to the reading's first letter
const PANEL_BODY_INSET = "pl-[28px]" // px-2.5 + the 12px glyph + gap-2 − 2: the body's rows start under the echo
const CLOSE_TRIM = "-ml-[6.5px] -mr-[5.5px]" // ×: 4px padding + 2.5px of viewBox in, and out to the left inset
// The keycaps at 11px: 2 units of 24 a side for ⇥ (0.92px), 3 for ↵ (1.375px).
const KEYCAP_TRIM = { tab: "-mx-[0.92px]", enter: "-mx-[1.375px]" } as const
// THE PHONE'S TAP ROW (TapRowLine), the same law: the pill's border is its ink; the × is a 32px hit square
// (10px a side around its 12px box, plus 2.5px of viewBox), collapsed onto its ink at both ends, and 4px of it
// taken off the LAYOUT top and bottom (`-my-1`), so the pill, not the invisible square, sets the row's height:
// 28 + py-1 = 36px, the pill 4px from either edge (the square set it at 37, the pill 6px down and 3px up).
const TAP_PILL_GAP = "ml-1" // reading → pill: gap-2 + 4 = 12, the desktop's between-clusters gap
const TAP_CLOSE_TRIM = "-ml-[8.5px] -mr-[11.5px]" // pill → ×: gap-2 + 12.5 − 8.5 = 12; × → border: 12.5 + 10 − 11.5 = 11

/** The mode's glyph, on its line's cap band (the house lift: the box's bottom on the baseline, then half the
 *  box less half the cap height). `cap` resolves against the glyph's own font, so it carries the size of
 *  the text it sits beside: the panel's echo is 13px on the ledge's 12px row (a 12px cap put it 0.63px
 *  under the echo's band; 13px measures −0.1). */
function SlotGlyph({ lead }: { lead: 12 | 13 }) {
  return (
    <span aria-hidden className={`flex shrink-0 self-baseline translate-y-[calc(6px_-_0.5cap)] text-muted ${GLYPH_TO_TEXT_TRIM} ${lead === 13 ? "text-[13px]" : ""}`}>
      <Repeat size={12} strokeWidth={2} />
    </span>
  )
}

const KBD = "font-sans text-[11px] text-muted-70"
/** A phone's tap target: the button's box stays as drawn, and an invisible layer takes its hit area to at
 *  least 32px tall (Cancel's 20px line, Create's 28px pill). */
const TAP_HIT = "relative after:absolute after:inset-x-0 after:top-1/2 after:h-8 after:min-h-full after:-translate-y-1/2 after:content-['']"

/**
 * The ledge's keycaps, ⇥ and ↵, as drawn glyphs rather than characters. As text (11px, the panel's `Esc`
 * treatment) they were FALLBACK glyphs — no UI face carries U+21E5/U+21B5 — so their size and height were
 * the fallback font's: measured on the real ledge (DejaVu, dsf 6, 2026-10-06) ⇥ inked 5px against an 8.75px
 * cap and sat 1.00px under the cap band's centre, ↵ 6px and 0.50px under, and a nudge fitted to that face
 * would be wrong on any other. Lucide's two are symmetric about their viewBox's middle, so the house
 * cap-band lift (`self-baseline` puts the box's bottom on the baseline; half the box less half the cap
 * puts its middle on the band, `cap` resolving against the line's own font) centres their INK, in any
 * font. The name rides in `aria-label`: a screen reader says "Tab Schedule", not an arrow.
 */
function KeyCap({ label, icon: Icon, trim }: { label: string; icon: typeof Repeat; trim: string }) {
  return (
    <kbd aria-label={label} className={`flex shrink-0 self-baseline translate-y-[calc(5.5px_-_0.5cap)] text-muted-70 ${trim}`}>
      <Icon aria-hidden size={11} strokeWidth={2} />
    </kbd>
  )
}

/**
 * The hanging slot under the box (§5.1): inset 10px a side and pulled up under the box's bottom edge, with no
 * top border of its own — the box's bottom border is its top — so it reads as a tab hanging off the box, not a
 * new card. As the LEDGE it is one 28px line that never wraps; as the PANEL the same first line stays put and
 * the rows open beneath it (grid rows 0fr → 1fr), so the list below slides rather than jumps.
 */
function ScheduleSlot({ form, phone, line, lead = 12, body, title, footer }: { form: "ledge" | "panel"; phone: boolean; line: ReactNode; lead?: 12 | 13; body?: ReactNode; title?: string; footer?: ReactNode }) {
  return (
    <div
      data-schedule-slot={form}
      title={title}
      className={`sched-ledge-in mx-2.5 rounded-b-lg border border-t-0 border-border transition-colors duration-[160ms] motion-reduce:transition-none ${form === "ledge" ? "bg-panel-2/60" : "bg-panel-2"}`}
    >
      {/* The phone's tap row never wraps: its reading gives way (TapRowLine) and its two buttons keep their
          size. The desktop's line wraps its actions under a reading with less than 9rem (LedgeLine). */}
      <div data-schedule-line className={`flex min-w-0 items-baseline gap-x-2 px-2.5 text-[12px] leading-5 text-muted ${phone ? "flex-nowrap py-1" : "flex-wrap py-1"}`}>
        <SlotGlyph lead={lead} />
        {line}
      </div>
      <div className={`grid transition-[grid-template-rows] duration-[160ms] ease-out motion-reduce:transition-none ${form === "panel" ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
        <div className="min-h-0 overflow-hidden">
          {form === "panel" && (
            <div data-schedule-panel className={`flex flex-col pb-2 ${PANEL_BODY_INSET} pr-2.5`}>
              {body}
              {footer}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** What an offer's ledge reads (S1–S3): the rule (or a cue's core and its quoted words, or the ambiguous
 *  word's copy), and for an exact reading its next day and how far off it is — the parts that give way
 *  first when the row is narrow. */
function offerReading(shown: Published, prose: string, nowMs: number, tz: string): { reading: ReactNode; next?: string; span: string | null; soon: boolean } {
  const r = shown.reading
  let reading: ReactNode = null
  let next: string | undefined
  let span: string | null = null
  let soon = false
  if (r.kind === "exact") {
    const model = schedulePreviewModel({ title: "", rrule: r.rrule, dtstart: r.dtstart, tz, assumed: r.assumed }, nowMs, tz)
    if (model.ok) {
      span = model.firstAt ? spanUntil(model.firstAt, nowMs) : null
      soon = model.firstAt !== undefined && Date.parse(model.firstAt) - nowMs < SOON_MS
      reading = (
        <>
          <PreviewDescribe segments={model.describe} capital />
          {model.zone}
        </>
      )
      next = model.next[0]
    }
  } else if (r.kind === "cue") {
    const quoted = prose.slice(r.unread.start, r.unread.end)
    if (r.core) {
      const model = schedulePreviewModel({ title: "", rrule: r.core.rrule, dtstart: r.core.dtstart, tz, assumed: r.core.assumed }, nowMs, tz)
      reading = model.ok ? (
        <>
          <PreviewDescribe segments={model.describe} capital />
          {model.zone}
          {", "}
          <span className="text-muted-70">{`“${quoted}”`}</span>
        </>
      ) : null
    }
    reading ??= (
      <>
        {"Looks like a schedule: "}
        <span className="text-muted-70">{`“${prose.slice(r.span.start, r.span.end)}”`}</span>
      </>
    )
  } else if (r.kind === "ambiguous") {
    reading = r.copy
  }
  return { reading, ...(next ? { next } : {}), span, soon }
}

/** The offer's line (S1–S3): the reading, then `⇥ Schedule  ↵ Start now  ×`, which never truncate. */
function LedgeLine({ shown, prose, each, nowMs, tz, onSchedule, onClose }: {
  shown: Published
  prose: string
  each: string
  nowMs: number
  tz: string
  onSchedule: () => void
  onClose: () => void
}) {
  const r = shown.reading
  const { reading, next, span, soon } = offerReading(shown, prose, nowMs, tz)
  const nextNode = next ? <span data-schedule-ledge-next className="shrink-0 whitespace-nowrap">{`\u00a0· next ${next}`}</span> : null
  const spanNode = span && next ? <span data-schedule-ledge-span className={`shrink-0 whitespace-nowrap ${soon ? "text-attention" : ""}`}>{`, in ${span}`}</span> : null
  return (
    <>
      {/* THE NARROWING ORDER (§5.3) — `Each run` goes first, then `, in 6d`, then `· next Mon Oct 12`, and only
          then does the rule itself ellipsize — as a one-line WRAPPING row clipped to its first line: a
          segment that no longer fits wraps onto the clipped second line and is gone whole, everything after
          it with it, and the rule, alone on the line, shrinks and truncates. `Each run` joins only with 9rem
          to spare (its label and a few words), and then truncates first. A fixed container width cannot do
          this — readings differ in length — and the All-projects column at 1440px (a 466px ledge) showed
          `Every Monday at 9am · next Mon Oct…` under the old 400px rule: a date cut in half. */}
      {/* …and when even the rule cannot keep 9rem beside the actions (which never truncate), the actions move
          to a second row, right-aligned, rather than leave the reading as "Ev…": that is what the narrowest
          All-projects column (an 800px window, a 248px ledge) showed with one row. */}
      {r.kind === "ambiguous" ? (
        // An ambiguous word's line is an INSTRUCTION ("…Say which."), not a reading that can lose its tail:
        // it wraps inside the ledge rather than ellipsize the part that says what to do.
        <span data-schedule-ledge-reading className="min-w-36 flex-1 basis-0 text-pretty">
          <span>{reading}</span>
        </span>
      ) : (
        <span data-schedule-ledge-reading className="flex h-5 min-w-36 flex-1 basis-0 flex-wrap overflow-hidden">
          <span className="min-w-0 truncate">{reading}</span>
          {nextNode}
          {spanNode}
          {each && (
            <span data-schedule-ledge-each className="min-w-36 flex-1 basis-0 truncate">
              {"\u00a0·\u00a0"}
              <span className="text-muted-70">Each run:</span>
              {"\u00a0"}
              {each}
            </span>
          )}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-baseline gap-3">
        {r.kind !== "ambiguous" && (
          <button
            type="button"
            data-schedule-accept
            onMouseDown={(e) => e.preventDefault()}
            onClick={onSchedule}
            className="flex items-baseline gap-1 rounded-sm text-muted outline-none transition-colors hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60"
          >
            <KeyCap label="Tab" icon={ArrowRightToLine} trim={KEYCAP_TRIM.tab} />
            <span>Schedule</span>
          </button>
        )}
        <span data-schedule-start-now className="flex items-baseline gap-1">
          <KeyCap label="Enter" icon={CornerDownLeft} trim={KEYCAP_TRIM.enter} />
          <span>Start now</span>
        </span>
        <button
          type="button"
          data-schedule-dismiss
          aria-label="Not a schedule"
          title="Not a schedule (Esc)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClose}
          className={`${CLOSE_TRIM} flex size-5 translate-y-[calc(6px_-_0.5cap)] items-center justify-center self-baseline rounded-sm text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60`}
        >
          <X size={12} strokeWidth={2} />
        </button>
      </span>
    </>
  )
}

/**
 * THE PHONE'S TAP ROW (§12): `↻ Every Monday at 9am · in 6d   [Schedule]   ×`. A phone has no keys, so there
 * are no keycaps, and no `Start now` — the send arrow beside the box IS starting it now, and in the mode the
 * same button wears the repeat glyph, so the tap that creates is the one that says so (I-5). `Schedule` is a
 * pill (a word alone does not read as tappable) and `×` a 32px square; both have hit areas of at least
 * 32px, and neither truncates. No `Each run` segment: there is no room for it, and no hover for its title.
 *
 * THE ORDER OF LOSS is `next {day}` first, then `in 6d`, then an ellipsis on the rule — the reverse of the
 * order they read in for the first step, so the desktop's trick (a wrapping row clipped to one line, which
 * always drops the LAST segment) cannot do it. The row measures instead: the rule and the two tails it could
 * wear are laid out invisibly beside it, and it shows the longest that fits. A ResizeObserver re-fits it as
 * the sheet turns, and every render re-measures (the reading's words change while the box is typed in).
 */
function TapRowLine({ shown, prose, nowMs, tz, onSchedule, onClose }: {
  shown: Published
  prose: string
  nowMs: number
  tz: string
  onSchedule: () => void
  onClose: () => void
}) {
  const r = shown.reading
  const { reading, next, span, soon } = offerReading(shown, prose, nowMs, tz)
  const spanTone = soon ? "text-attention" : ""
  // The tails, longest first: `· next Mon Oct 12, in 6d`, then `· in 6d`.
  const tails: ReactNode[] = []
  if (next) tails.push(<>{`\u00a0· next ${next}`}{span && <span className={spanTone}>{`, in ${span}`}</span>}</>)
  if (next && span) tails.push(<span className={spanTone}>{`\u00a0· in ${span}`}</span>)
  const fit = useTailFit(tails.length)
  const tail = fit.index < tails.length ? tails[fit.index] : null
  return (
    <>
      {r.kind === "ambiguous" ? (
        // An instruction ("…Say which.") wraps rather than lose the part that says what to do (§5.5).
        <span data-schedule-ledge-reading className="min-w-0 flex-1 text-pretty">{reading}</span>
      ) : (
        <span ref={fit.box} data-schedule-ledge-reading className="relative flex min-w-0 flex-1 overflow-hidden whitespace-nowrap">
          <span className="min-w-0 truncate">{reading}</span>
          {tail && <span data-schedule-ledge-tail className="shrink-0">{tail}</span>}
          <span aria-hidden className="invisible absolute left-0 top-0 whitespace-nowrap">
            <span ref={fit.rule}>{reading}</span>
            {tails.map((t, i) => <span key={i} ref={(el) => void (fit.tails.current[i] = el)}>{t}</span>)}
          </span>
        </span>
      )}
      {r.kind !== "ambiguous" && (
        <button
          type="button"
          data-schedule-accept
          onMouseDown={(e) => e.preventDefault()}
          onClick={onSchedule}
          className={`${TAP_PILL_GAP} relative inline-flex h-7 shrink-0 items-center rounded-full border border-border-strong px-2.5 font-medium text-fg outline-none after:absolute after:inset-x-0 after:-inset-y-[3px] after:content-[''] active:bg-hover focus-visible:ring-1 focus-visible:ring-focus-ink-60`}
        >
          {/* The hit layer is placed from the PADDING box, inside the 1px border: 26 + 3 + 3 = 32px tall.
              The word's box is trimmed to its CAP BAND (the house `.frizz-rail-glyph` rule), so `items-center`
              centres the ink in the pill in any font, and its baseline is still the word's, which the row
              aligns with the reading's. Centring the line box instead left the frame 0.50px low against the
              cap band in DejaVu (it depends on the face's ascent and descent, so no constant would carry). */}
          <span style={{ textBox: "trim-both cap alphabetic" } as CSSProperties}>Schedule</span>
        </button>
      )}
      <button
        type="button"
        data-schedule-dismiss
        aria-label="Not a schedule"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClose}
        className={`${TAP_CLOSE_TRIM} -my-1 flex size-8 shrink-0 translate-y-[calc(6px_-_0.5cap)] items-center justify-center self-baseline rounded-md text-muted outline-none active:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60`}
      >
        <X size={12} strokeWidth={2} />
      </button>
    </>
  )
}

/** Which of `count` tails (longest first) fits beside the rule: the index of the first that does, or
 *  `count` for none. Measured from invisible copies laid out beside the row (TapRowLine). */
function useTailFit(count: number) {
  const box = useRef<HTMLSpanElement>(null)
  const rule = useRef<HTMLSpanElement>(null)
  const tails = useRef<(HTMLSpanElement | null)[]>([])
  const [index, setIndex] = useState(0)
  const measure = () => {
    const el = box.current
    if (!el || !rule.current) return
    const room = el.getBoundingClientRect().width
    const ruleW = rule.current.getBoundingClientRect().width
    let i = 0
    // Half a pixel of slack: subpixel layout rounds the two sides differently.
    while (i < count && ruleW + (tails.current[i]?.getBoundingClientRect().width ?? Infinity) > room + 0.5) i++
    setIndex(i)
  }
  useLayoutEffect(measure)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => measure())
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return { box, rule, tails, index }
}

/** The rule's echo with dim guesses: `{title} · {rule}{zone}{ · condition · N runs a day}`. */
function EchoLine({ title, segments, zone, tail }: { title?: string; segments: readonly PreviewSegment[]; zone: string; tail: readonly string[] }) {
  return (
    <span data-schedule-echo className="min-w-0 flex-1 text-pretty text-[13px] text-fg">
      {title ? `${title} · ` : null}
      <PreviewDescribe segments={segments} capital={!title} />
      {zone}
      {tail.map((t) => ` · ${t}`).join("")}
    </span>
  )
}

/** The panel's next line: `Next: Mon Oct 12, in 6d · Mon Oct 19 · Mon Oct 26`, the span warning-toned under 15m. */
function NextLine({ next, firstAt, nowMs }: { next: readonly string[]; firstAt?: string; nowMs: number }) {
  if (next.length === 0) return null
  const span = firstAt ? spanUntil(firstAt, nowMs) : null
  const soon = firstAt !== undefined && Date.parse(firstAt) - nowMs < SOON_MS
  // A date drops WHOLE when the panel is narrow, the last first — the ledge's narrowing (§5.3 as built), for
  // the same reason: a wrapping row clipped to one line, so a date that does not fit wraps below the clip and
  // is gone. Ellipsized, the phone's panel read `Next: Mon Oct 12, in 6d · Mon Oct 1…` at 360px (and `Mon Oc…`
  // at 420): a date cut in half. Only the first, alone on the line, ever truncates.
  return (
    <p data-schedule-next className="flex h-5 flex-wrap overflow-hidden text-[12px] leading-5 text-muted">
      <span className="min-w-0 truncate">
        {"Next: "}
        {next[0]}
        {span && (
          <>
            {", "}
            <span data-soon={soon || undefined} className={soon ? "text-attention" : undefined}>in {span}</span>
          </>
        )}
      </span>
      {next.slice(1).map((n) => <span key={n} className="shrink-0 whitespace-nowrap">{`\u00a0· ${n}`}</span>)}
    </p>
  )
}

function EachRunLine({ prompt }: { prompt: string }) {
  const each = firstLine(prompt)
  if (!each) return null
  return (
    <p data-schedule-each className="truncate text-[12px] leading-5 text-muted">
      <span className="text-muted-70">Each run:</span> {each}
    </p>
  )
}

function panelParts(a: {
  view: ModeView
  state: ScheduleUiState
  phone: boolean
  nowMs: number
  tz: string
  notice: string | undefined
  shake: number
  flash: number
  creatingLabel: boolean
  onCancel: () => void
  onCreate: () => void
}): { line: ReactNode; lead: 12 | 13; body: ReactNode; footer: ReactNode } {
  const { view, nowMs, tz } = a
  let line: ReactNode = null
  // The first line's size, for the glyph's cap band: 13px when it is the rule's echo (or the core's rule
  // being read), the row's 12px when it is copy.
  let lead: 12 | 13 = 12
  let body: ReactNode = null
  let create: "enabled" | "disabled" | "hidden" = "hidden"
  let createTitle = "Create schedule (Enter)"
  switch (view.kind) {
    case "empty":
      line = <span data-schedule-copy className="min-w-0 flex-1 text-pretty">{EMPTY_COPY}</span>
      break
    case "local": {
      const r = view.reading
      const model = schedulePreviewModel({ title: view.title, rrule: r.rrule, dtstart: r.dtstart, tz, assumed: r.assumed }, nowMs, tz)
      if (model.ok) {
        line = <EchoLine title={view.title} segments={model.describe} zone={model.zone} tail={model.tail} />
        lead = 13
        body = (
          <>
            <NextLine next={model.next} firstAt={model.firstAt} nowMs={nowMs} />
            {model.meridiem && <p data-schedule-meridiem className="text-pretty text-[12px] leading-5 text-muted">{model.meridiem}</p>}
            <EachRunLine prompt={view.prompt} />
          </>
        )
        create = "enabled"
      }
      break
    }
    case "model": {
      const m = view.result
      const model = schedulePreviewModel({ title: m.title, rrule: m.rrule, dtstart: m.dtstart, tz: m.tz, condition: m.condition ?? null }, nowMs, tz)
      if (model.ok) {
        line = <span className="overlay-in min-w-0 flex-1"><EchoLine title={m.title} segments={model.describe} zone={model.zone} tail={model.tail} /></span>
        lead = 13
        body = (
          <>
            <NextLine next={model.next} firstAt={model.firstAt} nowMs={nowMs} />
            <EachRunLine prompt={view.prompt} />
          </>
        )
        create = "enabled"
      } else line = <span data-schedule-copy className="min-w-0 flex-1 text-pretty text-fg/85">{model.error}</span>
      break
    }
    case "reading": {
      create = "disabled"
      createTitle = "Still reading"
      const core = view.core
      const coreModel = core ? schedulePreviewModel({ title: "", rrule: core.rrule, dtstart: core.dtstart, tz, assumed: core.assumed }, nowMs, tz) : undefined
      line = <ReadingLine view={view} coreSegments={coreModel?.ok ? coreModel.describe : undefined} />
      if (coreModel?.ok && !view.edited && view.quoted !== undefined) lead = 13
      body = (
        <>
          {coreModel?.ok && !view.edited && <NextLine next={coreModel.next} firstAt={coreModel.firstAt} nowMs={nowMs} />}
          {view.prompt && <EachRunLine prompt={view.prompt} />}
        </>
      )
      break
    }
    case "disagree": {
      const m = view.result
      const model = schedulePreviewModel({ title: m.title, rrule: m.rrule, dtstart: m.dtstart, tz: m.tz, condition: m.condition ?? null }, nowMs, tz)
      line = model.ok ? <EchoLine title={m.title} segments={model.describe} zone={model.zone} tail={model.tail} /> : null
      if (model.ok) lead = 13
      body = (
        <>
          {model.ok && <NextLine next={model.next} firstAt={model.firstAt} nowMs={nowMs} />}
          <p data-schedule-disagree className="text-pretty text-[12px] leading-5 text-attention">
            Those words read two ways: {view.ours}, or {view.theirs}.
          </p>
          <p className="text-pretty text-[12px] leading-5 text-muted">Reword the part after “{view.corePhrase}”.</p>
        </>
      )
      create = "disabled"
      createTitle = "Reword it first"
      break
    }
    case "copy": {
      if (view.reading) {
        // A reading with nothing left to run: the reading stays on screen, the line says what is missing,
        // and Create waits (§5.6).
        const r = view.reading
        const model = schedulePreviewModel({ title: "", rrule: r.rrule, dtstart: r.dtstart, tz, assumed: r.assumed }, nowMs, tz)
        line = model.ok ? <EchoLine segments={model.describe} zone={model.zone} tail={model.tail} /> : null
        if (model.ok) lead = 13
        body = (
          <>
            {model.ok && <NextLine next={model.next} firstAt={model.firstAt} nowMs={nowMs} />}
            <p key={a.shake} data-schedule-refusal className={`text-pretty text-[12px] leading-5 text-fg/85 ${a.shake ? "kbd-shake" : ""}`}>{view.copy}</p>
          </>
        )
        create = "disabled"
        createTitle = "Say what each run should do first"
      } else {
        line = <span key={a.shake} data-schedule-refusal className={`min-w-0 flex-1 text-pretty text-fg/85 ${a.shake ? "kbd-shake" : ""}`}>{view.copy}</span>
      }
      break
    }
  }
  const footer = (
    <>
      {a.notice && <p data-schedule-notice className="text-pretty text-[12px] leading-5 text-muted">{a.notice}</p>}
      <div className="mt-2 flex items-center justify-end gap-3">
        <button
          key={`cancel:${a.flash}`}
          type="button"
          data-schedule-cancel
          onMouseDown={(e) => e.preventDefault()}
          onClick={a.onCancel}
          // Baseline, not centre: the 11px key and the 12px word box-centred sat 0.28px apart; now 0.
          // On a phone there is no Esc to name (§12), and the word is the whole button.
          className={`flex items-baseline gap-1.5 rounded-md px-1 text-[12px] text-muted outline-none transition-colors hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60 ${a.phone ? TAP_HIT : ""} ${a.flash ? "kbd-row-flash" : ""}`}
        >
          {!a.phone && <kbd className={KBD}>Esc</kbd>}
          <span>Cancel</span>
        </button>
        {create !== "hidden" && (
          <button
            key={`create:${a.shake}`}
            type="button"
            data-schedule-create
            onMouseDown={(e) => e.preventDefault()}
            onClick={a.onCreate}
            disabled={create === "disabled" || a.state.name === "creating"}
            title={createTitle}
            className={`pop-in rounded-md bg-fg px-2.5 py-1 text-[12px] font-medium text-bg outline-none transition-opacity hover:opacity-90 focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:opacity-40 ${a.phone ? TAP_HIT : ""} ${a.shake ? "kbd-shake" : ""}`}
          >
            {a.creatingLabel ? "Creating…" : "Create schedule"}
          </button>
        )}
      </div>
    </>
  )
  // The first line keeps the ledge's own 12px row; the echo inside it is 13px, on the same baseline.
  return { line: line ?? <span className="min-w-0 flex-1" />, lead, body, footer }
}

/** M2's line (§5.7): the part the grammar IS sure of, then the words the model is reading, quoted — muted,
 *  shimmering once the wait is long enough to see. */
function ReadingLine({ view, coreSegments }: { view: Extract<ModeView, { kind: "reading" }>; coreSegments?: readonly PreviewSegment[] }) {
  const shimmer = useDelayedTrue(true, SHIMMER_DELAY_MS)
  const tone = shimmer ? "shimmer-text" : "text-muted-70"
  if (view.edited) return <span data-schedule-reading className={`min-w-0 flex-1 truncate ${tone}`}>Edited. Reading it again…</span>
  if (coreSegments && view.quoted !== undefined) {
    return (
      <span data-schedule-reading className="min-w-0 flex-1 truncate text-[13px] text-fg">
        <PreviewDescribe segments={coreSegments} capital />
        {", reading “"}
        <span className={tone}>{view.quoted}</span>
        {"”…"}
      </span>
    )
  }
  if (view.quoted !== undefined) {
    return (
      <span data-schedule-reading className="min-w-0 flex-1 truncate">
        {"Reading “"}
        <span className={tone}>{view.quoted}</span>
        {"”…"}
      </span>
    )
  }
  return <span data-schedule-reading className={`min-w-0 flex-1 truncate ${tone}`}>Reading when it runs…</span>
}
