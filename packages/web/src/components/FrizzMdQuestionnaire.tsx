import { useId, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  composeFrizzMd,
  FRIZZ_MD_AUTONOMY_CHOICES,
  FRIZZ_MD_DEFAULT_ANSWERS,
  FRIZZ_MD_LANDING_CHOICES,
  FRIZZ_MD_NOTES_MAX,
  type FrizzMdAnswers,
  type FrizzMdStatus,
} from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { showToast } from "../store.ts"
import { projectSlug } from "../lib/base-path.ts"
import { StatusRow } from "./StatusRow.tsx"

// THE FIRST-RUN QUESTIONNAIRE — what a brand-new project shows before its first prompt box: how this
// project's agents should land finished work, how independently they should act, and anything else
// they should know. The answers become FRIZZ.md (the questions and the file's text are one module,
// shared/frizz-md.ts), which reaches only the workers Frizz starts — the screen says so, because "my
// other coding agents will start opening pull requests" is the first thing anyone would worry about.
//
// It is asked ONCE per project: a FRIZZ.md already on disk (written here, committed by a teammate, or
// written by hand) means the project has its rules, and Skip is remembered server-side for this project.
// The query key is project-scoped by the client's hash function (lib/queryKeyScope.ts), so one
// project's answer never decides another's.

export const FRIZZ_MD_STATUS_KEY = ["frizzMdStatus"] as const

/** Whether the first-run screen should ask. `undefined` while the answer is loading. */
export function useFrizzMdQuestionnaire(): { ask: boolean | undefined; status: FrizzMdStatus | undefined } {
  const status = useQuery({ queryKey: FRIZZ_MD_STATUS_KEY, queryFn: () => rpc.frizzMdStatus(), staleTime: Infinity })
  // A server that cannot answer (an older one without the procedure, a read error) must never strand a
  // new project behind a questionnaire it cannot save: fall through to the prompt box.
  if (status.isPending) return { ask: undefined, status: undefined }
  if (status.isError || !status.data) return { ask: false, status: undefined }
  return { ask: !status.data.exists && !status.data.skipped, status: status.data }
}

// The half-answered form, per project, for the life of the page. Crossing the phone breakpoint swaps
// the desktop board for the phone one and unmounts this screen — a window dragged narrower and back, or
// puppeteer's full-page screenshot, which shrinks the window to 1×1 for a frame — and component state
// alone would hand the operator back the defaults.
const drafts = new Map<string, FrizzMdAnswers>()

export function FrizzMdQuestionnaire({ status }: { status: FrizzMdStatus }) {
  const queryClient = useQueryClient()
  const draftKey = projectSlug() ?? ""
  const [answers, setAnswersState] = useState<FrizzMdAnswers>(() => drafts.get(draftKey) ?? FRIZZ_MD_DEFAULT_ANSWERS)
  const setAnswers = (update: (prev: FrizzMdAnswers) => FrizzMdAnswers) =>
    setAnswersState((prev) => {
      const next = update(prev)
      drafts.set(draftKey, next)
      return next
    })
  const [error, setError] = useState<string | null>(null)
  const notesId = useId()
  const preview = useMemo(() => composeFrizzMd(answers, status.defaultBranch), [answers, status.defaultBranch])

  const settle = (next: Partial<FrizzMdStatus>) =>
    queryClient.setQueryData<FrizzMdStatus>(FRIZZ_MD_STATUS_KEY, (prev) => ({ ...(prev ?? status), ...next }))
  const save = useMutation({
    mutationFn: (next: FrizzMdAnswers) => rpc.frizzMdCreate(next),
    onSuccess: () => {
      drafts.delete(draftKey)
      settle({ exists: true })
      showToast("Saved FRIZZ.md — agents Frizz starts here will follow it")
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  })
  const skip = useMutation({
    mutationFn: () => rpc.frizzMdSkip({}),
    onSuccess: () => settle({ skipped: true }),
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  })
  const busy = save.isPending || skip.isPending

  return (
    <div data-frizz-md-questionnaire className="w-full flex flex-col gap-3">
      <div className="flex flex-col gap-1 text-center">
        <h2 className="text-[15px] font-medium">How should agents work in this project?</h2>
        <p className="mx-auto max-w-[520px] text-[12.5px] leading-relaxed text-muted">
          The answers are saved as <code className="text-fg/90">FRIZZ.md</code> in the project root. Only agents that Frizz starts read
          that file. Other Claude Code, Codex or coding-agent sessions are not affected.
        </p>
      </div>
      {/* The same status row the first-task prompt box carries: on this screen the sidebar is hidden,
          so it is the only way to the project's identity, settings and quota. */}
      <StatusRow />
      <div className="flex flex-col gap-5 rounded-lg border border-border bg-panel-2 p-4">
        <ChoiceGroup
          legend="How should agents land finished work?"
          name="landing"
          value={answers.landing}
          choices={FRIZZ_MD_LANDING_CHOICES.map((c) => ({ value: c.value, label: c.label(status.defaultBranch), detail: c.detail }))}
          onChange={(landing) => setAnswers((a) => ({ ...a, landing }))}
          disabled={busy}
        />
        <ChoiceGroup
          legend="How independently should agents work?"
          name="autonomy"
          value={answers.autonomy}
          choices={FRIZZ_MD_AUTONOMY_CHOICES}
          onChange={(autonomy) => setAnswers((a) => ({ ...a, autonomy }))}
          disabled={busy}
        />
        <div className="flex flex-col gap-2">
          <label htmlFor={notesId} className="text-[13px] font-medium">
            Anything else agents should know? <span className="font-normal text-muted">Optional</span>
          </label>
          <textarea
            id={notesId}
            data-frizz-md-notes
            data-1p-ignore
            value={answers.notes}
            maxLength={FRIZZ_MD_NOTES_MAX}
            disabled={busy}
            onChange={(e) => setAnswers((a) => ({ ...a, notes: e.target.value }))}
            placeholder="For example: run the tests before every commit. Never edit the generated files under api/."
            rows={3}
            className="min-h-[72px] resize-y rounded-md border border-border bg-bg px-3 py-2 text-[12.5px] leading-relaxed text-fg outline-none placeholder:text-muted-80 focus-visible:border-border-strong focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:opacity-60"
          />
        </div>
        <details data-frizz-md-preview className="group text-[12px]">
          <summary className="cursor-pointer select-none text-muted outline-none hover:text-fg focus-visible:text-fg">Preview FRIZZ.md</summary>
          <pre className="mt-2 max-h-[280px] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-bg px-3 py-2 font-mono text-[11.5px] leading-relaxed text-fg/90">
            {preview}
          </pre>
        </details>
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-80">{error ?? "The file can be edited or deleted at any time."}</span>
          <button
            type="button"
            data-frizz-md-skip
            disabled={busy}
            onClick={() => {
              setError(null)
              skip.mutate()
            }}
            className="button-outline rounded-md px-3 py-1.5 text-[12px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-45"
          >
            Skip
          </button>
          <button
            type="button"
            data-frizz-md-save
            disabled={busy}
            onClick={() => {
              setError(null)
              save.mutate(answers)
            }}
            className="rounded-md border border-accent-fill bg-accent-fill px-3 py-1.5 text-[12.5px] font-medium text-on-accent outline-none hover:brightness-110 focus-visible:ring-1 focus-visible:ring-focus-accent-60 disabled:opacity-50"
          >
            Save FRIZZ.md
          </button>
        </div>
      </div>
    </div>
  )
}

function ChoiceGroup<V extends string>({
  legend,
  name,
  value,
  choices,
  onChange,
  disabled,
}: {
  legend: string
  name: string
  value: V
  choices: readonly { value: V; label: string; detail: string }[]
  onChange: (value: V) => void
  disabled: boolean
}) {
  const legendId = useId()
  return (
    <div role="radiogroup" aria-labelledby={legendId} data-frizz-md-group={name} className="flex flex-col gap-2">
      <div id={legendId} className="text-[13px] font-medium">
        {legend}
      </div>
      <div className="flex flex-col gap-1.5">
        {choices.map((c) => {
          const on = c.value === value
          return (
            <button
              key={c.value}
              type="button"
              role="radio"
              aria-checked={on}
              data-frizz-md-choice={c.value}
              disabled={disabled}
              onClick={() => onChange(c.value)}
              className={`flex items-start gap-2.5 rounded-md border px-3 py-2 text-left text-[12px] leading-snug outline-none transition-colors focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:opacity-60 ${
                on ? "border-selection-border bg-selection text-fg" : "border-border text-fg/90 hover:border-border-strong hover:bg-elevated"
              }`}
            >
              <span
                aria-hidden
                className={`mt-[2px] flex size-3.5 shrink-0 items-center justify-center rounded-full border ${on ? "border-accent" : "border-control-strong"}`}
              >
                {on && <span className="size-1.5 rounded-full bg-accent" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[12.5px] font-medium">{c.label}</span>
                <span className="mt-0.5 block text-muted">{c.detail}</span>
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
