import { useState } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useSnapshot } from "valtio"
import {
  InterpretScheduleInput,
  cutPhrase,
  scheduleEcho,
  type BoardSnapshot,
  type CodexModel,
  type CreateScheduleInput,
  type DispatchPreferences,
  type InterpretScheduleResult,
  type ScheduleView,
} from "@frizz/shared"
import { DispatchForm, NewThreadDialog, type DispatchDirs } from "./components/NewThreadModal.tsx"
import { carryDispatchDraft } from "./lib/scheduleDraftState.ts"
import { Toaster } from "./components/Toaster.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// THE LIVE SCHEDULE READING, on the real prompt box (plans/schedule-live-reading.md §15.2). It mounts the real
// <DispatchForm> — Composer, useLiveSchedule, the ledge and the panel, the draft store — over a stubbed RPC
// seam that COUNTS every call the box can make that matters (dispatch, createLazyThread, createSchedule,
// deleteSchedule, interpretSchedule) and records their bodies, so composerScheduleLive.e2e.test.ts can say
// "Enter dispatched once and created nothing" as a fact about the wire.
//
// Nothing here reaches a server: there is none. The model is a stub the test arms per case
// (`__sched.answer`), the server's two refusals are a queue the test fills (`__sched.createFail`), and the
// clock is the fixed one the HTML installs (Mon Oct 5 2026 2:32pm New York, the spec's clock).
//
// Fixture verbs, on `window.__sched`: `remount()` unmounts and remounts the box (the incident: a viewport
// override across the phone breakpoint did that in the real app), `openDialog()` opens the `c` dialog over
// the page box, `reaim(dir)` moves the box to another project as the All-projects picker and ⌥↑/⌥↓ do,
// `reset()` zeroes the counts. Counts live on the page, so a reload starts them at zero; the
// draft store (sessionStorage) is what survives it, which is the point.

type Counted = "dispatch" | "createLazyThread" | "createSchedule" | "deleteSchedule" | "interpretSchedule"
type ModelAnswer = { phrase: string; rrule: string; dtstart: string; condition?: string; title: string; delayMs?: number }

interface SchedFixture {
  counts: Record<Counted, number>
  bodies: Record<Counted, Record<string, unknown>[]>
  /** The model's next answers, by the text it is asked about; unmatched text reads as not-a-schedule. */
  answer: ModelAnswer | null
  /** Error messages the next createSchedule calls fail with, in order (`schedule-reading-moved: …`). */
  createFail: string[]
  /** RPC names the fixture does not answer — so a test can see what the box asked for. */
  unknown: string[]
  remount: () => void
  openDialog: () => void
  /** Re-aim the box at another project the way the All-projects page does (AllQueues: carryDispatchDraft,
   *  then the box keyed by the new project's dirs). */
  reaim: (projectDir: string) => void
  reset: () => void
}

declare global {
  interface Window { __sched: SchedFixture }
}

const PROJECT_ID = "fixture-schedule-live"
const PROJECT_DIR = "/fixture/schedule-live"

const zero = (): Record<Counted, number> => ({ dispatch: 0, createLazyThread: 0, createSchedule: 0, deleteSchedule: 0, interpretSchedule: 0 })
const empty = (): Record<Counted, Record<string, unknown>[]> => ({ dispatch: [], createLazyThread: [], createSchedule: [], deleteSchedule: [], interpretSchedule: [] })

const sched: SchedFixture = {
  counts: zero(),
  bodies: empty(),
  answer: null,
  createFail: [],
  unknown: [],
  remount: () => {},
  openDialog: () => {},
  reaim: () => {},
  reset: () => {
    sched.counts = zero()
    sched.bodies = empty()
  },
}
window.__sched = sched

const codexModels: CodexModel[] = [{ slug: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", defaultEffort: "medium", efforts: ["low", "medium", "high"] }]
const preferences: DispatchPreferences = {
  backend: "codex",
  claude: { permissionMode: "auto" },
  codex: { model: "gpt-5.6-sol", effort: "medium", permissionMode: "default" },
}

let nextId = 1

function viewOf(input: CreateScheduleInput): ScheduleView {
  const now = Date.now()
  const tz = input.tz ?? "America/New_York"
  const echo = scheduleEcho({ title: input.title, rrule: input.rrule, dtstart: input.dtstart, tz, condition: input.condition ?? null }, now, tz)
  if (!echo.ok) throw new Error(echo.error)
  const { compiled: _compiled, ...preview } = echo.value
  const at = new Date(now).toISOString()
  return {
    id: `sch_fixture_${nextId++}`,
    projectId: PROJECT_ID,
    projectSlug: "schedule-live",
    projectName: "schedule-live",
    title: input.title,
    whenText: input.whenText,
    prompt: input.prompt,
    ...(input.condition ? { condition: input.condition } : {}),
    rrule: input.rrule,
    dtstart: input.dtstart,
    tz,
    ...preview,
    backend: input.backend ?? "claude",
    ...(input.model ? { model: input.model } : {}),
    state: "active",
    attention: false,
    ...(preview.upcoming[0] ? { nextRun: { slug: "fixture-next-run", sessionId: "fixture-next-session", at: preview.upcoming[0], occurrenceAt: preview.upcoming[0], moved: false } } : {}),
    counts: { started: 0, skipped: 0, failed: 0, unreviewed: 0 },
    createdBy: "human",
    createdAt: at,
    updatedAt: at,
    revision: 1,
  } as ScheduleView
}

function interpret(text: string, tz: string): InterpretScheduleResult {
  const a = sched.answer
  const start = a ? text.indexOf(a.phrase) : -1
  if (!a || start < 0) return { ok: false, error: "That doesn't say when it should run. Try “every weekday at 9am”." }
  const span = { start, end: start + a.phrase.length }
  const echo = scheduleEcho({ title: a.title, rrule: a.rrule, dtstart: a.dtstart, tz, condition: a.condition ?? null }, Date.now(), tz)
  if (!echo.ok) return { ok: false, error: echo.error }
  const { compiled: _compiled, ...preview } = echo.value
  return {
    ok: true,
    phrase: a.phrase,
    phraseStart: span.start,
    phraseEnd: span.end,
    prompt: cutPhrase(text, span),
    whenText: a.phrase,
    rrule: a.rrule,
    dtstart: a.dtstart,
    tz,
    ...(a.condition ? { condition: a.condition } : {}),
    title: a.title,
    preview,
  }
}

const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const url = new URL(requestUrl, window.location.origin)
  // Both the page's client (`/_frizz/rpc/x`) and a project-pinned one (`/_frizz/<id>/rpc/x`, Undo's delete).
  const name = /\/rpc\/([A-Za-z]+)$/.exec(url.pathname)?.[1]
  if (!name) return nativeFetch(input, init)
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : JSON.parse(url.searchParams.get("input") ?? "{}") as Record<string, unknown>
  if (name in sched.counts) {
    const counted = name as Counted
    sched.counts[counted]++
    sched.bodies[counted].push(body)
  }
  switch (name) {
    case "dispatchPreferencesGet": return json(preferences)
    case "codexModels": return json(codexModels)
    case "acpAgents": return json([])
    case "settingsGet": return json({ permissionMode: "bypassPermissions", notifications: true })
    case "authStatus": return json({ claude: "authed", codex: "authed", emails: {} })
    case "userCommands": return json({ commands: [{ name: "review", description: "Review the diff", body: "Review the diff.", source: "project", path: "/fixture/.frizz/commands/review.md" }], frizzDir: "/fixture/.frizz/commands" })
    case "listSchedules": return json([])
    case "dispatch":
      // Acknowledged, never acted on: there is no server behind this page.
      return json({ slug: "fixture-started-thread", sessionId: "fixture-session" })
    case "createLazyThread": return json({ slug: "fixture-lazy-thread" })
    case "interpretSchedule": {
      const delay = sched.answer?.delayMs ?? 300
      await new Promise((r) => setTimeout(r, delay))
      // Parsed as the server parses it: `text` is TRIMMED, and the answer's offsets index the trimmed text.
      const input = InterpretScheduleInput.parse(body)
      return json(interpret(input.text, input.tz ?? "America/New_York"))
    }
    case "createSchedule": {
      const fail = sched.createFail.shift()
      if (fail) return new Response(JSON.stringify({ error: fail }), { status: 400, headers: { "content-type": "application/json" } })
      return json(viewOf(body as unknown as CreateScheduleInput))
    }
    case "deleteSchedule": return json({ ok: true })
  }
  sched.unknown.push(name)
  return new Response("404 Not Found", { status: 404 })
}

function json(result: unknown): Response {
  return new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json", "x-frizz-boot": "fixture" } })
}

store.board = { projectDir: PROJECT_DIR, projectId: PROJECT_ID } as unknown as BoardSnapshot

/** Stands in for the project row's schedules count (ProjectList): marked while `store.scheduleFlash` names it. */
function FlashProbe() {
  const flash = useSnapshot(store).scheduleFlash
  return flash ? <span data-sched-flash={flash.projectId} className="text-[11px] text-muted">flash</span> : null
}

function Fixture() {
  const [mount, setMount] = useState(0)
  const [hidden, setHidden] = useState(false)
  const [dialog, setDialog] = useState(false)
  sched.remount = () => {
    setHidden(true)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      setHidden(false)
      setMount((n) => n + 1)
    }))
  }
  sched.openDialog = () => setDialog(true)
  const [dirs, setDirs] = useState<DispatchDirs | undefined>(undefined)
  sched.reaim = (projectDir) => {
    carryDispatchDraft(dirs?.projectDir ?? PROJECT_DIR, projectDir)
    setDirs({ projectDir, homeDir: undefined })
  }
  return (
    <main className="min-h-screen bg-bg p-6">
      <section className="mx-auto max-w-xl rounded-xl border border-border bg-panel p-5">
        <h1 className="mb-3 text-sm font-medium">New thread</h1>
        {!hidden && <DispatchForm key={mount} dirs={dirs} />}
        <FlashProbe />
      </section>
      {dialog && <NewThreadDialog onClose={() => setDialog(false)} />}
      <Toaster />
    </main>
  )
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Fixture />
    </TooltipProvider>
  </QueryClientProvider>,
)
