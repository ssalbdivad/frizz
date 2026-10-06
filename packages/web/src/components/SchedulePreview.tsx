import { useMemo } from "react"
import {
  SCHEDULE_PRESENCE_COPY,
  SCHEDULE_SPACING_COPY,
  cityOfZone,
  compileSchedule,
  describeSchedule,
  describeScheduleParts,
  readingsConsistent,
  scheduleEcho,
  type Assumed,
  type PhraseReading,
  type ScheduleDescribePart,
  type ScheduleEcho,
} from "@frizz/shared"
import { spanUntil } from "../lib/activityTime.ts"
import { MODEL_BUDGET_COPY, MODEL_UNREACHABLE_COPY, modelRefusalCopy, type ModelReadOk, type ModelReader } from "../lib/scheduleModelRead.ts"

// THE LIVE READING OF A SCHEDULE (plans/schedule-live-reading.md §5.6, §11): what a rule will do, rebuilt in
// the browser from the rule itself while the human types — the drawer's Change when today, the prompt box's
// schedule panel next. Built from the COMPILED rule with the same `scheduleEcho` the server saves, never from
// a model's summary, so it says what will fire.
//
//   Triage issues · every Monday at 9am          ← the echo; parts the grammar ASSUMED render dim
//   Next: Mon Oct 12, in 6d · Mon Oct 19 · …     ← the shared next line, with ", in {span}" after the first
//   Read “3” as 3pm. Type “3am” if you meant …   ← only for a guessed am/pm
//
// Dim, not hidden: a 9am nobody typed, the Monday of "weekly", the pm of "at 3" are guesses, and the human
// should see which words were theirs (§3.4). Each dim part says why in its tooltip; typing the value turns
// it solid. ", in 6d" is a web-only decoration on the shared echo's next line, so the saved echo is unchanged.

/** Below this the first run is close enough to be worth the warning tone (§5.3). The spec names
 *  `text-warning`; the theme has no such token, and `attention` is its amber warning hue. */
export const SOON_MS = 15 * 60_000

export interface SchedulePreviewSpec {
  title: string
  rrule: string
  dtstart: string
  tz: string
  condition?: string | null
  /** What the grammar assumed (`exact.assumed`, a cue's `core.assumed`); none for a model reading. */
  assumed?: readonly Assumed[]
}

export interface PreviewSegment {
  text: string
  assumed?: true
  /** Why it is dim, and how to change it. */
  tip?: string
}

export type SchedulePreviewModel =
  | {
      ok: true
      describe: PreviewSegment[]
      /** " New York time" when the schedule's zone is not the viewer's (the shared echo's suffix). */
      zone: string
      /** After the rule: the condition, "N runs a day". */
      tail: string[]
      /** The next runs as the shared echo's next line spells them. */
      next: string[]
      /** The first run, ISO. */
      firstAt?: string
      /** The guessed-meridiem line (§5.6 line 3). */
      meridiem?: string
    }
  | { ok: false; error: string }

// The engine walks 60 runs to check a rule; memoized per rule, zone and minute so a keystroke in the task
// costs one string compare (§4.1: a 16-entry LRU).
const MEMO_MAX = 16
const memo = new Map<string, { echo: ScheduleEcho; parts: ScheduleDescribePart[] } | { error: string }>()

function checked(spec: SchedulePreviewSpec, nowMs: number, viewerTz: string) {
  const key = [spec.rrule, spec.dtstart, spec.tz, viewerTz, Math.floor(nowMs / 60_000)].join("\0")
  const hit = memo.get(key)
  if (hit) {
    memo.delete(key)
    memo.set(key, hit)
    return hit
  }
  const result = scheduleEcho({ title: "", rrule: spec.rrule, dtstart: spec.dtstart, tz: spec.tz }, nowMs, viewerTz)
  const value = result.ok
    ? { echo: (({ compiled: _c, ...echo }) => echo)(result.value), parts: describeScheduleParts(result.value.compiled, nowMs) }
    : { error: result.error }
  memo.set(key, value)
  while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value!)
  return value
}

const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s)

function timeTip(a: Extract<Assumed, { part: "time" }>): string {
  return a.word ? `“${capitalize(a.word)}” reads as ${a.shown}. Add a time to change it.` : `No time given, so ${a.shown}. Add a time to change it.`
}

function dayTip(a: Extract<Assumed, { part: "day" }>): string {
  // A day the words name two ways ("next Tuesday", "Friday at midnight") says which it took (fix round 3).
  return a.tip ?? `No day given, so ${a.shown}. Add a day to change it.`
}

function meridiemTip(a: Extract<Assumed, { part: "meridiem" }>): string {
  const typed = a.shown.replace(/(am|pm)$/, "")
  return `Read “${typed}” as ${a.shown}. Type “${a.other}” if you meant ${a.other.endsWith("am") ? "morning" : "evening"}.`
}

/** The rule's words as segments, the assumed ones marked: a `time` assumption dims the time, a `day` one
 *  the days, and a `meridiem` one only the am/pm of the time it guessed (§3.4). */
export function previewSegments(parts: readonly ScheduleDescribePart[], assumed: readonly Assumed[] = []): PreviewSegment[] {
  const time = assumed.find((a): a is Extract<Assumed, { part: "time" }> => a.part === "time")
  const day = assumed.find((a): a is Extract<Assumed, { part: "day" }> => a.part === "day")
  const meridiems = assumed.filter((a): a is Extract<Assumed, { part: "meridiem" }> => a.part === "meridiem")
  const out: PreviewSegment[] = []
  for (const p of parts) {
    if (p.kind === "time" && time) {
      out.push({ text: p.text, assumed: true, tip: timeTip(time) })
      continue
    }
    if (p.kind === "days" && day) {
      out.push({ text: p.text, assumed: true, tip: dayTip(day) })
      continue
    }
    const guessed = p.kind === "time" ? meridiems.find((a) => a.shown === p.text) : undefined
    if (guessed && /(am|pm)$/.test(p.text)) {
      out.push({ text: p.text.slice(0, -2) }, { text: p.text.slice(-2), assumed: true, tip: meridiemTip(guessed) })
      continue
    }
    out.push({ text: p.text })
  }
  // Adjacent plain runs merge, so the DOM holds one text node per run of the same tone.
  return out.reduce<PreviewSegment[]>((acc, seg) => {
    const prev = acc[acc.length - 1]
    if (prev && !prev.assumed && !seg.assumed) prev.text += seg.text
    else acc.push({ ...seg })
    return acc
  }, [])
}

/** The guessed-meridiem line: the spec's copy for one guess, one line for several. */
export function meridiemLine(assumed: readonly Assumed[] = []): string | undefined {
  const guesses = assumed.filter((a): a is Extract<Assumed, { part: "meridiem" }> => a.part === "meridiem")
  if (guesses.length === 0) return undefined
  if (guesses.length === 1) return meridiemTip(guesses[0]!)
  const read = guesses.map((a) => `“${a.shown.replace(/(am|pm)$/, "")}” as ${a.shown}`).join(", ")
  return `Read ${read}. Add am or pm to change one.`
}

/** Everything the preview shows, or why the rule cannot be saved (checkSchedule's own words). Pure. */
export function schedulePreviewModel(spec: SchedulePreviewSpec, nowMs: number, viewerTz: string): SchedulePreviewModel {
  const c = checked(spec, nowMs, viewerTz)
  if ("error" in c) return { ok: false, error: c.error }
  const assumed = spec.assumed ?? []
  const condition = spec.condition?.trim()
  const next = c.echo.nextLine ? c.echo.nextLine.replace(/^Next: /, "").split(" · ") : []
  const meridiem = meridiemLine(assumed)
  return {
    ok: true,
    describe: previewSegments(c.parts, assumed),
    zone: viewerTz !== spec.tz ? ` ${cityOfZone(spec.tz)} time` : "",
    tail: [...(condition ? [condition] : []), ...(c.echo.perDay ? [`${c.echo.perDay} runs a day`] : [])],
    next,
    ...(c.echo.upcoming[0] ? { firstAt: c.echo.upcoming[0] } : {}),
    ...(meridiem ? { meridiem } : {}),
  }
}

/** The rule's words, the ASSUMED ones dim with their reason in the tooltip (§3.4) — the preview's echo, and the
 *  prompt box's ledge and panel (ScheduleComposer.tsx). `capital` upper-cases the first letter, for a line
 *  that leads with the rule ("Every Monday at 9am · next …"). */
export function PreviewDescribe({ segments, capital = false }: { segments: readonly PreviewSegment[]; capital?: boolean }) {
  return (
    <>
      {segments.map((seg, i) => {
        const text = capital && i === 0 ? capitalize(seg.text) : seg.text
        return seg.assumed ? (
          <span key={i} data-assumed title={seg.tip} className="text-fg/45 transition-colors">
            {text}
          </span>
        ) : (
          <span key={i} className="transition-colors">{text}</span>
        )
      })}
    </>
  )
}

/** The browser's IANA zone — what the preview names a schedule's zone against. */
export function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

export function SchedulePreview({
  spec,
  nowMs,
  viewerTz = browserZone(),
  pending,
}: {
  spec: SchedulePreviewSpec
  nowMs: number
  viewerTz?: string
  /** The model is reading the words the grammar would not (§5.7): the rule shown is the part it IS sure
   *  of, and the rest is quoted after it — muted, then shimmering once the wait is long enough to see. */
  pending?: { quoted: string; shimmer: boolean }
}) {
  const model = useMemo(
    () => schedulePreviewModel(spec, nowMs, viewerTz),
    // `assumed` is a fresh array per reading; its content is what matters.
    [spec.title, spec.rrule, spec.dtstart, spec.tz, spec.condition, JSON.stringify(spec.assumed ?? []), nowMs, viewerTz],
  )
  if (!model.ok) {
    return <p data-schedule-preview-error className="text-[12px] leading-5 text-fg/85">{model.error}</p>
  }
  const span = model.firstAt ? spanUntil(model.firstAt, nowMs) : null
  const soon = model.firstAt !== undefined && Date.parse(model.firstAt) - nowMs < SOON_MS
  return (
    <div data-schedule-preview className="flex min-w-0 flex-col">
      <p data-schedule-preview-echo className="text-pretty text-[13px] leading-5 text-fg">
        {spec.title.trim()}
        {" · "}
        <PreviewDescribe segments={model.describe} />
        {model.zone}
        {pending ? (
          <>
            {", reading “"}
            <span data-schedule-preview-unread className={pending.shimmer ? "shimmer-text" : "text-muted-70"}>{pending.quoted}</span>
            {"”…"}
          </>
        ) : (
          model.tail.map((t) => ` · ${t}`).join("")
        )}
      </p>
      {model.next.length > 0 && (
        <p data-schedule-preview-next className="text-pretty text-[12px] leading-5 text-muted">
          {"Next: "}
          {model.next[0]}
          {span && (
            <>
              {", "}
              <span data-soon={soon || undefined} className={soon ? "text-attention" : undefined}>in {span}</span>
            </>
          )}
          {model.next.slice(1).map((n) => ` · ${n}`).join("")}
        </p>
      )}
      {model.meridiem && !pending && (
        <p data-schedule-preview-meridiem className="text-[12px] leading-5 text-muted">{model.meridiem}</p>
      )}
    </div>
  )
}

// ---- the words a reading cannot be shown in ------------------------------------------------------------------

/** What a panel or a Change when shows for a model reading `describeSchedule` cannot put into words (I-11 for
 *  the model): the human is never asked to confirm RRULE text. */
export const UNPHRASABLE_COPY = "That schedule is too intricate to show here. Try saying it more simply, like “every Friday at 9am”."

/** A rule `describeSchedule` cannot phrase: it falls back to the RRULE itself (`on the rule FREQ=…`). */
export function unphrasableRule(rrule: string, dtstart: string, tz: string): boolean {
  const c = compileSchedule({ rrule, dtstart, tz })
  return c.ok && describeSchedule(c.value).startsWith("on the rule")
}

/** The house's words for a rule, or the rule itself when it does not compile. */
export function describeRule(rrule: string, dtstart: string, tz: string): string {
  const c = compileSchedule({ rrule, dtstart, tz })
  return c.ok ? describeSchedule(c.value) : rrule
}

// ---- the drawer's Change when, its pure half (§11) -----------------------------------------------------------
//
// What the preview under a schedule's When field shows for the words on screen. It lives here, beside the
// preview it decides, rather than in ScheduleDrawer.tsx, which a node test cannot load (it reaches a `.css`
// import) — so its refusals are pinned in SchedulePreview.test.ts.

const EVENT_COPY = "Schedules run on the clock. Try “every hour, check whether the build failed”."
const CHANGE_WHEN_STALE_COPY = "Frizz has updated since this page loaded. Reload the page to save this."

type CueCore = NonNullable<Extract<PhraseReading, { kind: "cue" }>["core"]>
export type ChangeWhenView =
  | { kind: "none" }
  | { kind: "local"; reading: Extract<PhraseReading, { kind: "exact" }> }
  | { kind: "model"; result: ModelReadOk }
  | { kind: "reading"; core?: CueCore; quoted?: string }
  | { kind: "disagree"; result: ModelReadOk; ours: string; theirs: string; corePhrase: string }
  | { kind: "copy"; copy: string }

/** What the preview shows for the words on screen: the local reading, a local refusal, or the model's. */
export function changeWhenView({ shown, reader, tz, nowMs, stale }: {
  /** The last published reading of the field and the words it read. */
  shown: { words: string; reading: PhraseReading } | null
  reader: Pick<ModelReader, "view">
  tz: string
  nowMs: number
  stale: boolean
}): ChangeWhenView {
  if (!shown) return { kind: "none" }
  if (stale) return { kind: "copy", copy: CHANGE_WHEN_STALE_COPY }
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
  // I-11 for the model, as the prompt box's panel has it (fix round 3, drawer-model-raw-rrule): a rule the
  // house cannot put into words would preview as `on the rule FREQ=…` with Save enabled, and once saved the
  // drawer's header and the project row read it too. The copy, and no Save (a `copy` view has none).
  if (unphrasableRule(result.rrule, result.dtstart, result.tz)) return { kind: "copy", copy: UNPHRASABLE_COPY }
  return { kind: "model", result }
}
