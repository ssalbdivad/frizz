import { useMemo, useState } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router"
import type { BoardSnapshot, ThreadHandoff, ThreadView as ThreadViewModel } from "@frizz/shared"
import { useLeavingCards } from "./components/AllQueues.tsx"
import { AllQueuesCard } from "./components/AllQueuesCard.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { threadKey, type QueuesProject } from "./lib/allQueues.ts"
import { store } from "./store.ts"
import "./styles.css"

// The page's QUEUE CARD (components/AllQueuesCard.tsx) in the states its own tests used to cover on the
// board's card, before that card and its fixtures were deleted with the board (098de26d, 2026-09-28).
// The REAL AllQueuesCard renders, with the REAL optimistic-exit hook the page runs
// (AllQueues.tsx useLeavingCards: leave → fade → hidden → back after REAPPEAR_MS unless the queue drops
// the thread). Only the network is stubbed, and every RPC the cards make is recorded on window.__rpc.
//
//   ?case=exit (default)       two resting cards; `Mark as done` on the first. completeThread answers
//                              after ?delay= ms (default 1500), then the "poll" drops the thread.
//     &needsConfirmation=1     …the server declines instead (fast, as it really is — the liveness check
//                              runs before any teardown), carrying a hold naming live work.
//     &fail=1                  …the RPC fails.
//     &stalePoll=1             …it succeeds, but the poll does not drop the thread: 9s after the click a
//                              read that STARTED before the done lands (thread still queued), and only
//                              12s after it does a fresh read drop the thread — a loaded server's poll.
//     &stillQueued=1           …it succeeds, and a read started after it still lists the thread: the
//                              done evidently did not take, so the card must come back.
//                              A reply sent from the first card's box steers it: the "poll" drops the
//                              thread 400ms later, once the fade is over.
//     &replyDelay=<ms>         …the reply's followUp answers only after that long (a cold resume, a retry).
//   ?case=registered-done      the thread signed off with `mcp__frizz__done`: no fence in the handoff text,
//                              a registered `lastFence` on the thread (B1).
//   ?case=fenced-and-registered  both: the fence in the text AND the registration — one card, not two.
//   ?case=pending-ask          a session frozen at a native AskUserQuestion, nothing journaled (B2).
//   ?case=perm-prompt          a session parked on a permission prompt, nothing journaled (B2).
//   ?case=perm-prompt-journaled  the same, but an answerable interaction IS journaled: the net stands down.
//
// The card's project is NOT the page's: `store.board` names another project, so a control that read the
// page's client instead of the card's would call `/_frizz/rpc/…` (unprefixed) and show up in __rpc as
// such. The terminal net's copy must call `/_frizz/<card project>/rpc/threadTerminalCommand`.

const params = new URLSearchParams(location.search)
const CASE = params.get("case") ?? "exit"
const DELAY = Number(params.get("delay") ?? 1500)
const DECLINE = params.get("needsConfirmation") === "1"
const FAIL = params.get("fail") === "1"
const REPLY_DELAY = Number(params.get("replyDelay") ?? 0)
const STALE_POLL = params.get("stalePoll") === "1"
const STILL_QUEUED = params.get("stillQueued") === "1"

const now = new Date().toISOString()
function thread(id: string, title: string, extra: Partial<ThreadViewModel> = {}): ThreadViewModel {
  return {
    id,
    title,
    status: "needs-human",
    statusText: "",
    mechanism: null,
    humanBlocked: true,
    needsYou: true,
    ready: false,
    dependsOn: [],
    externalDeps: [],
    agents: [],
    errors: [],
    warnings: [],
    runtime: "turn-idle",
    unread: false,
    archived: false,
    hasPlan: false,
    pendingQuestion: false,
    kind: "session",
    foreign: false,
    backend: "claude",
    permissionMode: "default",
    state: "open",
    sessionId: `sess-${id}`,
    subAgents: [],
    bgShells: [],
    watches: [],
    questions: [],
    lastFence: undefined,
    lastActivityAt: now,
    lastAssistantAt: now,
    spawnedAt: now,
    ...extra,
  } as unknown as ThreadViewModel
}

const DONE_BODY = "Rotated the signing key behind a dual-read window.\n\n- New key live on all three regions\n- Old key retired after 24h"
const FENCED = `Both regions verified.\n\n\`\`\`done\n${DONE_BODY}\n\`\`\``
const ASK = {
  questions: [{
    header: "Rollout",
    question: "Which rollout do you want?",
    multiSelect: false,
    options: [{ label: "Rotate in place", description: "one step, a short dual-read window" }, { label: "Stage a second key" }],
  }],
}

interface Scenario { threads: ThreadViewModel[]; text: (id: string) => string }
function scenario(): Scenario {
  switch (CASE) {
    case "registered-done":
      return {
        threads: [thread("rotate-key", "Rotate the signing key without downtime", { lastFence: { kind: "done", body: DONE_BODY, hints: [], registered: true } })],
        text: () => "Both regions verified; the old key is retired.",
      }
    case "fenced-and-registered":
      return {
        threads: [thread("rotate-key", "Rotate the signing key without downtime", { lastFence: { kind: "done", body: DONE_BODY, hints: [], registered: true } })],
        text: () => FENCED,
      }
    case "pending-ask":
      return {
        threads: [thread("rotate-key", "Rotate the signing key without downtime", { runtime: "running", pendingAsk: ASK })],
        text: () => "I need a call on the rollout before I touch production.",
      }
    case "perm-prompt":
    case "perm-prompt-journaled":
      return {
        threads: [thread("rotate-key", "Rotate the signing key without downtime", { runtime: "perm-prompt", pendingInteraction: CASE === "perm-prompt-journaled" })],
        text: () => "Running the migration against staging now.",
      }
    default:
      return {
        threads: [
          thread("rotate-key", "Rotate the signing key without downtime"),
          thread("flaky-ci", "Deflake the auth integration suite"),
        ],
        text: (id) => (id === "rotate-key" ? "The key is rotated. Mark it done when you have checked the dashboards." : "Found the race; the fix is in, 50 green runs."),
      }
  }
}
const { threads: THREADS, text: textOf } = scenario()

// The page's project, deliberately NOT the card's (see the header).
store.board = { projectDir: "/fixture/elsewhere", threads: [] } as unknown as BoardSnapshot

interface RpcLog { calls: { path: string; at: number }[]; completeCalledAt: number | null; completeResolvedAt: number | null }
const log: RpcLog = { calls: [], completeCalledAt: null, completeResolvedAt: null }
;(window as unknown as { __rpc: RpcLog }).__rpc = log
;(window as unknown as { __store: typeof store }).__store = store

// The poll dropping a completed thread, as the page's projectsQueues read would once the server archives it.
let dropThread: (id: string) => void = () => {}
// A read that LANDS now, still listing every thread, having started at `startedAt`.
let landRead: (startedAt: number) => void = () => {}

const json = (result: unknown) => new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json" } })
const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.origin)
  if (!url.pathname.startsWith("/_frizz/")) return originalFetch(input, init)
  log.calls.push({ path: url.pathname, at: performance.now() })
  const rpc = /\/rpc\/([^/]+)$/.exec(url.pathname)?.[1]
  // A query carries its input in `?input=`, a mutation in the body.
  const raw = typeof init?.body === "string" ? init.body : url.searchParams.get("input")
  const body = raw ? (JSON.parse(raw) as { slug?: string }) : {}
  if (rpc === "threadHandoff") {
    const handoff: ThreadHandoff = { asked: "Rotate the signing key without downtime.", askedAt: now, text: textOf(body.slug ?? ""), at: now }
    return json(handoff)
  }
  // A reply steers the thread back to work, and the next poll drops it from the queue. After the fade, not
  // during it: the page holds a leaving card's slot (and its thread) until the fade ends (AllQueues.tsx
  // stableQueue `keep`), which this fixture does not reproduce — dropping it sooner here would unmount the
  // card mid-fade, which the page never does.
  if (rpc === "followUp") {
    if (REPLY_DELAY) await new Promise((resolve) => setTimeout(resolve, REPLY_DELAY))
    setTimeout(() => dropThread(body.slug ?? ""), 400)
    return json({})
  }
  // The reply box's @ typeahead reads every project's queue on an All projects page, which this path
  // reads as; its answer is a list, and `{}` crashed the box.
  if (rpc === "projectsQueues") return json([])
  if (rpc === "threadTerminalCommand") return json({ command: "claude --resume sess-rotate-key", mode: "attach" })
  if (rpc === "completeThread") {
    log.completeCalledAt = performance.now()
    if (DECLINE) {
      await new Promise((resolve) => setTimeout(resolve, 90))
      log.completeResolvedAt = performance.now()
      return json({
        needsConfirmation: true,
        hold: {
          turnInFlight: false,
          unobservable: false,
          subAgents: [{ label: "Audit the refresh-token rotation", state: "running" }],
          subAgentCount: 1,
          bgShells: [{ label: "Watch origin/main CI", state: "running" }, { label: "vite dev server", state: "stale" }],
          bgShellCount: 2,
        },
      })
    }
    await new Promise((resolve) => setTimeout(resolve, DELAY))
    log.completeResolvedAt = performance.now()
    if (FAIL) return new Response(JSON.stringify({ error: "the worker would not stop" }), { status: 500, headers: { "content-type": "application/json" } })
    if (STILL_QUEUED) {
      setTimeout(() => landRead(Date.now()), 1_000)
      return json({ needsConfirmation: false })
    }
    if (STALE_POLL) {
      const calledAt = Date.now() - DELAY
      setTimeout(() => landRead(calledAt - 500), 9_000 - DELAY)
      setTimeout(() => dropThread(body.slug ?? ""), 12_000 - DELAY)
      return json({ needsConfirmation: false })
    }
    setTimeout(() => dropThread(body.slug ?? ""), 50)
    return json({ needsConfirmation: false })
  }
  return json({})
}

function Queue() {
  const [queued, setQueued] = useState(THREADS)
  // When the newest "poll" STARTED (lib/projectsQueuesRead.ts). A drop is a fresh read.
  const [readAt, setReadAt] = useState(() => Date.now())
  dropThread = (id) => {
    setQueued((list) => list.filter((t) => t.id !== id))
    setReadAt(Date.now())
  }
  landRead = (startedAt) => {
    setQueued((list) => [...list])
    setReadAt(startedAt)
  }
  const project: QueuesProject = useMemo(() => ({
    id: "fixture-card",
    slug: "signing",
    name: "signing",
    card: undefined,
    open: true,
    stale: false,
    projectDir: "/fixture/signing",
    homeDir: "/fixture",
    githubRepo: undefined,
    queued,
    running: [],
    snoozed: [],
    doneCount: 0,
  }), [queued])
  const leaving = useLeavingCards([project], readAt)
  return (
    <div className="flex flex-col gap-5">
      {queued.filter((t) => !leaving.hidden(threadKey(project.id, t.id))).map((t) => {
        const key = threadKey(project.id, t.id)
        return (
          <AllQueuesCard key={key} project={project} thread={t} leaving={leaving.isLeaving(key)} onLeave={leaving.leave(key)} onReturn={leaving.restore(key)} onSent={leaving.sent(key)} onLanded={leaving.landed(key)} />
        )
      })}
    </div>
  )
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <MemoryRouter>
      <TooltipProvider>
        <div className="min-h-screen bg-bg px-4 py-6 text-sm text-fg">
          <div data-fixture-queue className="mx-auto w-[640px] max-w-full min-w-0">
            <Queue />
          </div>
        </div>
      </TooltipProvider>
    </MemoryRouter>
  </QueryClientProvider>,
)
