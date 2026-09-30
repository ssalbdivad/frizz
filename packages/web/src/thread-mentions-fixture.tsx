import { useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import { ThreadRow, type RowScope } from "./components/Sidebar.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { Composer } from "./components/Composer.tsx"
import { LinkifiedText } from "./components/LinkifiedText.tsx"
import { MentionIndexProvider } from "./components/MentionLinks.tsx"
import { useMentionCandidates } from "./hooks/useMentionCandidates.ts"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for THREAD HANDLES (2026-09-29): a thread's name shows as its camelCase handle in the rail,
// the prompt box offers those handles after `@`, and a sent `@handle` links to its thread. Everything
// here is the real component on a stubbed board.
//
//   /thread-mentions-fixture.html?draft=ask%20%40b   — types the draft into the box, caret at its end
//
// Sans only: `data-font="sans"` is on <html>, the one font the product renders.
document.documentElement.dataset.font = "sans"

const ROW_SCOPE: RowScope = { open: () => {}, page: true }
const base = {
  kind: "session", backend: "claude", titleAuto: false, titleLocked: true, humanBlocked: false, pendingQuestion: false,
  archived: false, foreign: false, state: "open", status: "active", needsYou: false, subAgents: [], bgShells: [],
  watches: [], questions: [], spawnedAt: "2026-09-29T09:00:00.000Z",
} as const
const t = (over: Record<string, unknown>) => ({ ...base, ...over }) as unknown as ThreadView

const threads = [
  t({ id: "shell-budgets", title: "Shell budgets", runtime: "running", statusLine: "Tuning the per-thread cap", lastAssistantAt: "2026-09-29T12:00:00Z" }),
  t({ id: "focus-mode", title: "Focus mode", runtime: "turn-idle", needsYou: true, statusLine: "Waiting on your call about the drawer", lastAssistantAt: "2026-09-29T11:00:00Z" }),
  t({ id: "budget-report", title: "Budget report", runtime: "turn-idle", statusLine: "Drafting the weekly numbers", lastAssistantAt: "2026-09-29T10:00:00Z" }),
  t({ id: "arktype-perf", title: "ArkType perf", runtime: "running", lastAssistantAt: "2026-09-29T09:30:00Z" }),
  t({ id: "resolver", title: "Ship the resolver cache fix", runtime: "turn-idle", lastAssistantAt: "2026-09-29T09:10:00Z" }),
  t({ id: "legacy", title: "Rework the session-limit banner so the countdown reads in the house grammar", runtime: "turn-idle" }),
  t({ id: "billing", title: "Billing webhooks", state: "archived", archived: true, runtime: "exited", statusLine: "Merged", lastAssistantAt: "2026-09-28T10:00:00Z" }),
]
store.board = { threads, projectSlug: "frizz" } as unknown as BoardSnapshot

const hooks = { submitted: [] as string[], value: "" }
;(window as unknown as { __mentions: typeof hooks }).__mentions = hooks
// The drawer stack a mention click pushes, for the e2e to read.
;(window as unknown as { __drawers: () => string[] }).__drawers = () => store.drawers.map((d) => `${d.kind}:${d.slug}`)

function Box() {
  const [value, setValue] = useState("")
  hooks.value = value
  const mentions = useMentionCandidates("focus-mode")
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const draft = new URLSearchParams(location.search).get("draft")
    const ta = root.current?.querySelector("textarea")
    if (!draft || !ta) return
    ta.focus()
    document.execCommand("insertText", false, draft)
  }, [])
  return (
    <div ref={root} className="w-full max-w-[520px]">
      <Composer
        surface="chatComposer"
        value={value}
        onChange={setValue}
        onSubmit={() => {
          hooks.submitted.push(hooks.value)
          setValue("")
        }}
        placeholder="Reply…"
        mentionCandidates={mentions}
      />
    </div>
  )
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <TooltipProvider>
      <main className="flex min-h-screen gap-10 bg-bg p-10 text-fg">
        <div data-sidebar-rail className="w-[240px] shrink-0">
          {threads.map((thread) => (
            <ThreadRow key={thread.id} scope={ROW_SCOPE} t={thread} />
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col justify-between gap-10">
          <MentionIndexProvider>
            <div data-mention-bubble className="ml-auto max-w-[420px] rounded-2xl rounded-br-sm bg-user-bubble px-3.5 py-3 text-[14px] whitespace-pre-wrap text-user-bubble-fg">
              <LinkifiedText text={"Ask @shellBudgets about this, and reconcile with @focusMode. @nobody stays text."} />
            </div>
          </MentionIndexProvider>
          <Box />
        </div>
      </main>
    </TooltipProvider>
  </QueryClientProvider>,
)
