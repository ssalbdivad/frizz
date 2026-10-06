import { useMemo } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { spinoffChildPrompt, spinoffRequestMessage, type BoardSnapshot, type SpinoffView, type ThreadHandoff, type ThreadView as ThreadViewModel, type TranscriptMessage } from "@frizz/shared"
import { AllQueuesCard } from "./components/AllQueuesCard.tsx"
import { ThreadView } from "./components/ChatView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import type { QueuesProject } from "./lib/allQueues.ts"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for SPINOFFS' own UI (2026-09-30): both ends of the edge as the real drawer draws them —
// ThreadView with the virtualized transcript, the shipped call site — on a stubbed board and a stubbed
// transcript RPC, plus the queue card of a spinoff child. Everything drawn is the real component; only the
// network is fake.
//
//   ?panel=parent   the PARENT at rest: three requests — started mid-work (its spawn_thread call is in the
//                   transcript and must draw NOTHING), started with a long handle, and one the worker came
//                   to rest without starting: its spawn_thread call FAILED, so that call keeps its line
//                   (the one record of why), with the worker's own words under it.
//   ?panel=busy     a parent AT WORK with a request still QUEUED in the delivery ledger: the ledger's raw
//                   `<spinoff-request>` envelope must draw as the starting card, never as a gray bubble —
//                   dimmed as a queued send is, and taken back by a click (the stubbed unqueue confirms),
//                   which reopens the Spinoff dialog on its instructions.
//   ?panel=states   the two states a request can be in without a child and without having failed: a parent
//                   paused on a permission prompt ("waiting on you"), and a send the ledger has no receipt
//                   for ("delivery unconfirmed").
//   ?panel=child    the CHILD: the header's "Spinoff of @parent", then its first turn as the origin card
//                   with a realistic long brief folded beneath (`&open=1` opens it on load).
//   ?panel=queue    the child's QUEUE CARD, whose meta line names its parent too.
//   (default)       all four, stacked.
//   &w=<px>         the panel width — 560 is the drawer's, 420 a phone / narrow card. Default 560.
//   &theme=light    the light theme (default dark).
//
// Sans only: the one font the product renders (CLAUDE.md), set before first paint.
const params = new URLSearchParams(location.search)
document.documentElement.dataset.font = "sans"
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark"
const PANEL = params.get("panel") ?? "all"
const WIDTH = Number(params.get("w") ?? 560)

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()

function thread(id: string, title: string, extra: Partial<ThreadViewModel> = {}): ThreadViewModel {
  return {
    id, title, status: "active", statusText: "", mechanism: null, humanBlocked: false, needsYou: false, ready: false,
    dependsOn: [], externalDeps: [], agents: [], errors: [], warnings: [], runtime: "turn-idle", unread: false,
    archived: false, hasPlan: false, pendingQuestion: false, kind: "session", foreign: false, backend: "claude",
    permissionMode: "default", state: "open", sessionId: `sess-${id}`, subAgents: [], bgShells: [], watches: [],
    questions: [], titleAuto: false, titleLocked: true, spawnedAt: at(240), lastActivityAt: at(3), lastAssistantAt: at(3),
    ...extra,
  } as unknown as ThreadViewModel
}

const edge = (id: string, parentSlug: string, childSlug: string | null, instructions: string): SpinoffView => ({ id, parentSlug, childSlug, instructions, createdAt: Date.now() })

// ── The edges ────────────────────────────────────────────────────────────────────────────────────
const A = edge("spn_a000000000000001", "sub-agent-liveness", "evaluate-addresses", "Evaluate whether the sub-agent addresses feature is worth keeping. Be blunt about what it costs us.")
const B = edge("spn_b000000000000002", "sub-agent-liveness", "audit-projection-paths", "Audit every place the transcript projection reads a tool call's input.")
const C = edge("spn_c000000000000003", "sub-agent-liveness", null, "Write a migration that backfills the child slugs.")
const D = edge("spn_d000000000000004", "cache-rework", null, "Profile the cold-start path while I keep going on the cache.")
const E = edge("spn_e000000000000005", "flaky-e2e", null, "Bisect which commit made the drawer e2e flaky.")
const F = edge("spn_f000000000000006", "docs-pass", null, "Draft the release notes for the spinoff feature.")

const BRIEF = `## Where this came from

The parent thread was chasing why **live sub-agents read as not running** in the rail. Along the way it added *sub-agent addresses*: every child a worker dispatches gets a \`thread.child\` handle (\`@sub-agent-liveness.cache-keys\`), so the human can point a message at one directly.

## What exists today

- \`packages/shared/src/thread-handle.ts\` — \`subAgentHandle(label)\` kebab-cases a dispatch name (≤ 5 words) the same way a thread's title becomes its handle.
- \`packages/web/src/groups.ts\` — \`subAgentName\`, \`subAgentAddressOf\` and \`subAgentTitle\` render the address in the rail, the queue card and the drawer header.
- \`packages/server/src/router.ts\` — \`subAgentDirectory\` serves every child a thread ever dispatched, live or returned, so a mention of a finished child still resolves.
- The composer's \`@\` typeahead completes \`@thread.\` into that thread's children (\`lib/threadMentions.ts\` \`splitMentionQuery\`).

## The open question

Nobody has typed a dotted address in anger yet. The feature added ~900 lines across four packages and one more RPC per drawer open. Decide whether it earns its keep:

1. Count how often a worker's prose names a child by address (the transcripts under \`~/.claude/projects/-home-ssalb-frizz/\` are fair game — read-only).
2. Weigh that against what it costs: the typeahead's second mode, the directory RPC, the naming prompt every worker now carries.
3. Recommend keep, trim, or remove — and if trim, which half.

Do not change code yet; this is an evaluation.`

const PARENT = thread("sub-agent-liveness", "Sub-agent liveness", { spinoffs: [A, B, C], lastUserAt: at(20) })
const BUSY = thread("cache-rework", "Cache rework", { runtime: "running", statusLine: "Rewriting the eviction pass", spinoffs: [D] })
const CHILD = thread("evaluate-addresses", "Evaluate sub-agent addresses", {
  spinoffs: [A], statusLine: "Counting dotted mentions", needsYou: true, humanBlocked: true, status: "needs-human", spawnedAt: at(18),
})
// Paused on a permission prompt while gathering the brief, and a send the ledger never got a receipt for.
const WAITING = thread("flaky-e2e", "Flaky e2e", { runtime: "perm-prompt", statusLine: "Waiting for approval", spinoffs: [E] })
const LOST = thread("docs-pass", "Docs pass", { spinoffs: [F] })
const LONG_CHILD = thread("audit-projection-paths", "Audit every transcript projection path", { spinoffs: [B], needsYou: true, humanBlocked: true, status: "needs-human" })
store.board = { projectDir: "/fixture/frizz", projectSlug: "frizz", threads: [PARENT, BUSY, CHILD, LONG_CHILD, WAITING, LOST] } as unknown as BoardSnapshot
// The e2e reads which drawer a plain click on a thread link opened (Spinoff.e2e.test.ts).
;(window as unknown as { __store: typeof store }).__store = store

// ── The transcripts ─────────────────────────────────────────────────────────────────────────────
const user = (sourceId: string, text: string, minutesAgo: number, extra: Partial<TranscriptMessage> = {}): TranscriptMessage =>
  ({ sourceId, role: "user", text, tools: [], parts: [], at: at(minutesAgo), ...extra }) as TranscriptMessage
const said = (sourceId: string, text: string, minutesAgo: number, tools: TranscriptMessage["tools"] = []): TranscriptMessage =>
  ({ sourceId, role: "assistant", text, tools, parts: [...(text ? [{ kind: "text" as const, text }] : []), ...(tools.length ? [{ kind: "tools" as const, tools }] : [])], at: at(minutesAgo) }) as TranscriptMessage
const request = (sourceId: string, e: SpinoffView, minutesAgo: number): TranscriptMessage =>
  user(sourceId, spinoffRequestMessage({ id: e.id, instructions: e.instructions }), minutesAgo, { displayText: e.instructions, spinoff: { id: e.id, instructions: e.instructions } })
const spawnCall = (e: SpinoffView) => ({ name: "mcp__frizz__spawn_thread", detail: "spawn thread", status: "completed" as const, spinoff: e.id, input: JSON.stringify({ spinoff: e.id, prompt: "…" }) })
// A spawn the server REFUSED: stamped with the request all the same (the tell comes from the input), and
// kept on screen because its error is the only record of why the request did not start.
const refusedSpawn = (e: SpinoffView) => ({ ...spawnCall(e), status: "failed" as const, output: `Error: model "opus-9" is not available here — pick one of opus, sonnet, haiku.` })
const read = (detail: string) => ({ name: "Read", detail, status: "completed" as const })

const TRANSCRIPTS: Record<string, TranscriptMessage[]> = {
  [PARENT.id]: [
    user("p-u1", "Why do live sub-agents read as not running in the rail?", 60),
    said("p-a1", "The rail's liveness reads `bgState`, and a sub-agent inside the broker never sets it — so every child reads idle until it reports.", 55, [read("packages/web/src/components/Sidebar.tsx"), read("packages/server/src/board.ts")]),
    request("p-u2", A, 40),
    // The fulfilling call: drawn by the card above, so it draws nothing here — no `Ran 1 tool call`.
    said("p-a2", "", 39, [spawnCall(A)]),
    said("p-a3", "Back to the rail. The fix is to read liveness off the broker's own child registry rather than the shell telemetry.", 38, [read("packages/server/src/claude-broker-host.ts"), { name: "Edit", detail: "packages/server/src/board.ts", status: "completed" }]),
    request("p-u3", B, 30),
    said("p-a4", "", 29, [spawnCall(B)]),
    request("p-u4", C, 20),
    said("p-a5", "", 19, [refusedSpawn(C)]),
    said("p-a6", "I could not start that one: the model I asked for does not exist here. Say the word and I will try again on the default.", 19),
  ],
  [BUSY.id]: [
    user("b-u1", "Rewrite the cache's eviction pass so it stops thrashing on large repos.", 12),
    said("b-a1", "Starting with the eviction pass — it scans the whole map on every insert.", 11, [read("packages/server/src/cache.ts")]),
    // The ledger's echo of a send the transcript has not picked up yet: the RAW envelope, no `spinoff`
    // field — exactly what delivery-ledger.ts projectDeliveryLedger appends.
    user("delivery:spinoff-spn_d", spinoffRequestMessage({ id: D.id, instructions: D.instructions }), 0, { queued: true, deliveryId: `spinoff-${D.id}`, deliveryState: "enqueued" } as Partial<TranscriptMessage>),
  ],
  [WAITING.id]: [
    user("w-u1", "Why does the drawer e2e fail one run in five?", 9),
    said("w-a1", "It races the transcript's first paint. Narrowing it down.", 8, [read("packages/web/src/components/ChatView.e2e.test.ts")]),
    request("w-u2", E, 2),
  ],
  [LOST.id]: [
    user("l-u1", "Tidy the README's install section.", 90),
    said("l-a1", "Done — the install section now leads with `npx frizz`.", 88),
    user("delivery:spinoff-spn_f", spinoffRequestMessage({ id: F.id, instructions: F.instructions }), 3, { queued: true, deliveryId: `spinoff-${F.id}`, deliveryState: "unconfirmed" } as Partial<TranscriptMessage>),
  ],
  [CHILD.id]: [
    user("c-u0", spinoffChildPrompt({ parentSlug: PARENT.id, parentTitle: PARENT.title, parentHandle: "sub-agent-liveness", instructions: A.instructions, brief: BRIEF }), 18, {
      displayText: A.instructions,
      spinoffOrigin: { instructions: A.instructions, brief: BRIEF },
    }),
    said("c-a0", "Starting with the count. I'll grep the worker transcripts for dotted mentions first, then weigh the cost side.", 17, [read("packages/shared/src/thread-handle.ts")]),
  ],
}

const json = (result: unknown) => new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json" } })
const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : ((input as Request).url ?? input.toString()), location.origin)
  if (!url.pathname.startsWith("/_frizz/")) return originalFetch(input, init)
  const rpc = /\/rpc\/([^/]+)$/.exec(url.pathname)?.[1]
  const raw = typeof init?.body === "string" ? init.body : url.searchParams.get("input")
  const body = raw ? (JSON.parse(raw) as { slug?: string }) : {}
  if (rpc === "threadTranscript" || rpc === "threadTranscriptEarlier") {
    return json({ messages: TRANSCRIPTS[body.slug ?? ""] ?? [], transcriptKey: `${body.slug}-key`, hasEarlier: false, historyLoaded: true })
  }
  // The brief's inline code paths ask whether each is a real file; none is, here.
  if (rpc === "resolveLocalPaths") {
    return json({ resolved: ((body as { paths?: string[] }).paths ?? []).map((input) => ({ input, path: null })) })
  }
  // The take-back: the provider confirms, and the ledger row (here, the transcript's echo of it) is gone.
  if (rpc === "unqueueFollowUp") {
    const { slug, deliveryId } = body as { slug: string; deliveryId: string }
    ;(window as unknown as { __unqueued: string[] }).__unqueued = [...((window as unknown as { __unqueued?: string[] }).__unqueued ?? []), deliveryId]
    TRANSCRIPTS[slug] = (TRANSCRIPTS[slug] ?? []).filter((m) => m.deliveryId !== deliveryId)
    return json({ unqueued: true })
  }
  if (rpc === "threadHandoff") {
    // The server's handoff for a spinoff child quotes the human's instructions, never the brief.
    const t = body.slug === LONG_CHILD.id ? B : A
    const handoff: ThreadHandoff = { asked: t.instructions, askedAt: at(18), text: "Counted 3 dotted mentions across 212 transcripts, all by the parent that introduced them. My recommendation is below.", at: at(2) }
    return json(handoff)
  }
  return json({})
}

function Drawer({ slug, label, height }: { slug: string; label: string; height: number }) {
  return (
    <section data-fixture-panel={slug} className="flex flex-col gap-1.5">
      <p className="text-[11px] text-muted">{label}</p>
      <div className="flex flex-col overflow-hidden border border-border bg-bg" style={{ width: WIDTH, maxWidth: "100%", height }}>
        <ThreadView slug={slug} virtualized />
      </div>
    </section>
  )
}

function Queue() {
  const project: QueuesProject = useMemo(() => ({
    id: "fixture-frizz", slug: "frizz", name: "frizz", card: undefined, open: true, stale: false,
    projectDir: "/fixture/frizz", homeDir: "/fixture", githubRepo: undefined,
    queued: [CHILD, LONG_CHILD], running: [BUSY], snoozed: [], pinnedDone: [], doneCount: 0,
  }), [])
  return (
    <section data-fixture-panel="queue" className="flex flex-col gap-1.5">
      <p className="text-[11px] text-muted">Queue cards of two spinoff children</p>
      <div className="flex flex-col gap-5" style={{ width: WIDTH, maxWidth: "100%" }}>
        {[CHILD, LONG_CHILD].map((t) => (
          <AllQueuesCard key={t.id} project={project} thread={t} leaving={false} onLeave={() => {}} onReturn={() => {}} />
        ))}
      </div>
    </section>
  )
}

function Fixture() {
  const show = (panel: string) => PANEL === "all" || PANEL === panel
  return (
    <div className="min-h-screen bg-bg p-4 text-sm text-fg">
      <div className="flex flex-col gap-8">
        {show("parent") && <Drawer slug={PARENT.id} label="Parent at rest: started mid-work, started (long handle), didn't start" height={900} />}
        {show("busy") && <Drawer slug={BUSY.id} label="Parent at work, request still in the delivery ledger" height={420} />}
        {show("states") && <Drawer slug={WAITING.id} label="Parent paused on a permission prompt" height={460} />}
        {show("states") && <Drawer slug={LOST.id} label="A request the ledger has no receipt for" height={460} />}
        {show("child") && <Drawer slug={CHILD.id} label="Child: the origin card" height={PARAMS_OPEN ? 1700 : 760} />}
        {show("queue") && <Queue />}
      </div>
    </div>
  )
}
const PARAMS_OPEN = params.get("open") === "1"
if (PARAMS_OPEN) {
  // Open the brief once the card is on screen (the virtualized list mounts it after the transcript lands).
  const timer = setInterval(() => {
    const toggle = document.querySelector<HTMLButtonElement>("[data-spinoff-context-toggle][aria-expanded='false']")
    if (!toggle) return
    toggle.click()
    clearInterval(timer)
  }, 50)
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter>
      <TooltipProvider>
        <Fixture />
      </TooltipProvider>
    </MemoryRouter>
  </QueryClientProvider>,
)
