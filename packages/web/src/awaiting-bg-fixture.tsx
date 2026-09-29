import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView as ThreadViewModel, TranscriptMessage } from "@frizz/shared"
import type { GithubRefCard } from "@frizz/shared"
import { GithubHovercards } from "./components/GithubHovercards.tsx"
import { ThreadView } from "./components/ChatView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for the RESTING CARD (components/AwaitingBackgroundCard.tsx) in the thread drawer: a thread
// that came to rest while its OWN background work is still live and no human ask is outstanding renders
// the informational banner + the event "Snooze" button and its explainer. snoozeAwaitingBackground is
// mocked so nothing real is hit. This fixture mounted the board's queue card until that card was deleted
// with the single-project board (2026-09-28); the card is the same component on both, so it moved to the
// drawer, the virtualized path both production callers mount.
//
// DEFAULT = THE SHELL-ONLY REST, because since 2026-08-04 that is the only shape the server actually puts
// in the queue: a rest on a live SUB-AGENT is excused from it (board.deriveNeedsYou), so the sub-agent
// wording below is reachable only in the drawer / full-screen page. `?agents=1` renders it anyway — it is
// the same component and the same card, and the two voices are worth eyeballing side by side.
//
// On a real stack `nub scripts/seed-resting-thread.mjs --home=… --socket=…` against an adhoc stack seeds
// a thread at rest with live children; /thread/<slug> and /thread/<slug>/full then show the same card.

const SLUG = "awaiting-bg-demo"
const params = new URLSearchParams(location.search)
// ?watch=1 — the PR-WATCH PARK, which reaches this card as of 2026-08-13: its awaiting fence no longer
// offers a park action, so this card is where the wait is stated and its event-snooze is the one control.
// ?watch=both — a thread holding a shell AND a watcher, so the sentence has to name both kinds.
// ?watch=one — ONE green, mergeable PR and nothing else. The shape the maintainer actually meets on a
// real board, and the one they were looking at when they called the old three-line row busy (2026-08-14).
const watchMode = params.get("watch")
// THE APP RENDERS IN SANS, and the stylesheet still defaults to MONO without the attribute — a fixture
// that set neither silently took mono, which is how a glyph measured at a 0.00px residual once rode
// visibly high in the maintainer's sans window. index.html pins `data-font="sans"` since the mono
// option was dropped (2026-09-19), so this defaults the same way; `?font=mono` still shows the other.
document.documentElement.dataset.font = params.get("font") === "mono" ? "mono" : "sans"
// The card renders LIVE elapsed durations now, so a hardcoded instant reads as "550hr 27m" and the
// fixture stops being judgeable the day after it is written. Everything dates off NOW.
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
// ?all=1 — every kind at once (sub-agents AND shells AND PRs), which is the only way to see the three
// group headings together. Without it `agents=1` suppresses shells, as it always has.
const wantAll = params.get("all") === "1"
const wantAgents = wantAll || params.get("agents") === "1"
const wantWatch = wantAll || watchMode !== null
// Shells are the DEFAULT shape; ?agents=1 swaps them for sub-agents, and ?watch=1 for a lone watcher.
const wantShells = wantAll || (!wantAgents && watchMode !== "1" && watchMode !== "one")
const shellOnly = wantShells && !wantAgents
// ?title=<text> — the WORKER'S OWN HEADING (2026-08-26), which replaces the derived "Awaiting" /
// "Background shells running". Bare `?title` seeds a heading that WRAPS at this card's narrowest (368px
// content box, i.e. a 500px viewport here), which is the case worth looking at: the cap was 40 until
// 2026-09-19 so the heading always fit one line, and cut real titles mid-thought; now the heading
// wraps and only a paragraph is trimmed (AWAITING_TITLE_MAX). The fence also carries the prose the
// card opens with, so the heading and the handoff can be judged together.
const titleParam = params.get("title")
const declaredTitle = titleParam === "" ? "Spread ask and soundness issue on two TypeScript issues" : titleParam

const tail = shellOnly
  ? "Left the dev server and the CI poller running; I'll pick this back up when they report."
  : "Dispatched two audit sub-agents; I'll fold their findings in when they return."

const messages: TranscriptMessage[] = [
  { role: "user", text: "Refactor the pricing parser and verify it end-to-end.", tools: [], parts: [{ kind: "text", text: "Refactor the pricing parser and verify it end-to-end." }] },
  { role: "assistant", text: tail, tools: [], parts: [{ kind: "text", text: tail }] },
]

const thread = {
  id: SLUG,
  title: "Refactor the pricing parser",
  status: "active",
  mechanism: null,
  humanBlocked: false,
  needsYou: true,
  awaitingBackground: true,
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  // `turn-idle` — the state showsRestingCard actually gates on. A plain "idle" renders the thread with
  // NO resting card at all, which is what this fixture exists to show.
  runtime: "turn-idle",
  sessionId: "aaaaaaaa-bbbb-cccc-dddd-000000000001",
  unread: false,
  archived: false,
  hasPlan: false,
  pendingQuestion: false,
  kind: "session",
  foreign: false,
  backend: "claude",
  permissionMode: "default",
  subAgents: !wantAgents ? [] : [
    { id: "agent-a", label: "Audit the parser for edge cases", subagentType: "frizz:opus-high", startedAt: ago(2), state: "running" },
    { id: "agent-b", label: "Write property tests for the tiers", subagentType: "frizz:sonnet-high", startedAt: ago(6), state: "running" },
  ],
  // BOTH shells are always present; only ONE is declared (the fence's `shells:` below). That pairing is the
  // point — the card must list the declared one and say nothing about the dev server nobody tore down.
  bgShells: !wantShells ? [] : [
        { id: "toolu_vite", taskId: "b7k2m1xq0", label: "vite dev --host", startedAt: ago(18), state: "running", stoppable: true },
        { id: "toolu_ci", taskId: "bzvtnt3ig", label: "gh run watch 1842", startedAt: ago(4), state: "running", stoppable: true },
      ],
  // ?watch=1|both seeds FOUR PRs, one per check state, so the row's whole vocabulary is on screen at
  // once: running with counts, all-green-and-mergeable, red (whose failing jobs are now a `view failures`
  // link rather than a listed second line), and one frizz has not polled yet ("Checking…", which must not
  // read as "no checks").
  //
  // THE DECLARED SHELL WAIT rides the same array — a `watch: bzvtnt3ig` fence hint becomes a
  // `kind: "shell"` row server-side (board.fenceWatchViews). Seeded whenever shells are, because the
  // card's whole rule is that a shell is listed when the worker NAMED it: the CI poller is declared and
  // gets a row, the dev server beside it never does.
  watches: [
    ...(wantShells
      ? [
          { id: "shell:demo:bzvtnt3ig", kind: "shell", target: "bzvtnt3ig", state: "armed", createdAt: ago(4) },
          // ?declare=both — the dev server declared too, so the footer's Stop counts two ("Stop 2 shells").
          ...(params.get("declare") === "both" ? [{ id: "shell:demo:b7k2m1xq0", kind: "shell", target: "b7k2m1xq0", state: "armed", createdAt: ago(18) }] : []),
        ]
      : []),
    ...(watchMode === "one"
    ? [
        {
          id: "github:demo:colinhacks/zod#5928", kind: "github", target: "colinhacks/zod#5928", state: "armed", createdAt: ago(12),
          github: { checks: "passing", running: 0, passed: 7, failed: 0, failing: [], merge: "mergeable", state: "open", polledAt: ago(1) },
        },
      ]
    : wantWatch
    ? [
        {
          id: "github:demo:acme/app#391", kind: "github", target: "acme/app#391", state: "armed", createdAt: ago(12),
          github: { checks: "running", running: 3, passed: 12, failed: 0, failing: [], merge: "blocked", state: "open", polledAt: ago(1) },
        },
        {
          id: "github:demo:acme/app#392", kind: "github", target: "acme/app#392", state: "armed", createdAt: ago(21),
          github: { checks: "passing", running: 0, passed: 15, failed: 0, failing: [], merge: "mergeable", state: "open", polledAt: ago(1) },
        },
        {
          id: "github:demo:acme/app#393", kind: "github", target: "acme/app#393", state: "armed", createdAt: ago(33),
          github: { checks: "failing", running: 1, passed: 9, failed: 2, failing: ["lint", "e2e (chromium)"], merge: "blocked", state: "open", polledAt: ago(1) },
        },
        { id: "github:demo:acme/app#394", kind: "github", target: "acme/app#394", state: "armed", createdAt: ago(1) },
      ]
    : []),
  ],
  // The standing fence. Only seeded with ?title, because a fence body renders as the card's opening
  // prose and the default fixture is deliberately the no-prose shape.
  ...(declaredTitle === null ? {} : {
    lastFence: {
      kind: "awaiting",
      body: tail,
      hints: [{ kind: "title", value: declaredTitle }, { kind: "for", value: "2h" }],
    },
  }),
  lastActivityAt: ago(1),
} as unknown as ThreadViewModel

store.board = { projectDir: "/fixture/frizz", threads: [thread] } as BoardSnapshot

const transcriptPage = { messages, transcriptKey: "fixture-key", hasEarlier: false, historyLoaded: false }

// THE HOVERCARD BATCH, answered locally. Since 2026-08-25 every PR row carries `data-gh-ref`, so the
// app-wide hovercard layer opens the PR's card on it exactly as on a `#123` in prose. Only the answer is
// stubbed: the request is still harvested, batched and parsed by lib/githubHovercards.ts, so a row that
// stops stamping the attribute shows up here as a hover that opens nothing.
const HOVER_CARDS: GithubRefCard[] = [
  {
    ref: "acme/app#391", kind: "pr", repo: "acme/app", url: "https://github.com/acme/app/pull/391",
    title: "resolver: key the cache on the normalized id", body: "The lookup collided on two ids that normalize to one.",
    state: "OPEN", at: ago(240), authorLogin: "colinhacks", labels: [{ name: "bug", color: "d73a4a" }], comments: 2,
    additions: 41, deletions: 9, fetchedAt: Date.now(),
  },
  {
    ref: "colinhacks/zod#5928", kind: "pr", repo: "colinhacks/zod", url: "https://github.com/colinhacks/zod/pull/5928",
    title: "Add z.templateLiteral() recursion guard", body: "", state: "OPEN", at: ago(600), authorLogin: "colinhacks",
    labels: [], comments: 0, additions: 12, deletions: 3, fetchedAt: Date.now(),
  },
]

const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.origin)
  if (url.pathname === "/_frizz/rpc/githubRefPreview") {
    const refs: string[] = JSON.parse(url.searchParams.get("input") ?? "{}").refs ?? []
    const cards = HOVER_CARDS.filter((card) => refs.includes(card.ref)).map((card) => ({ ...card, fetchedAt: Date.now() }))
    const missing = refs.filter((ref) => !cards.some((card) => card.ref === ref))
    return new Response(JSON.stringify({ result: { cards, missing } }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname === "/_frizz/rpc/threadTranscript" || url.pathname === "/_frizz/rpc/threadTranscriptEarlier") {
    return new Response(JSON.stringify({ result: transcriptPage }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname === "/_frizz/rpc/snoozeAwaitingBackground") {
    window.dispatchEvent(new CustomEvent("fixture-rpc", { detail: { rpc: "snoozeAwaitingBackground", body: JSON.parse(String(init?.body ?? "{}")) } }))
    // A void mutation serializes as {result:null} (rpc/server.ts) — mirror that so the web client parses success.
    return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  }
  // The footer's Stop (2026-09-29): answered as a real stop, and announced for a harness to count.
  if (url.pathname === "/_frizz/rpc/stopBackgroundOp") {
    window.dispatchEvent(new CustomEvent("fixture-rpc", { detail: { rpc: "stopBackgroundOp", body: JSON.parse(String(init?.body ?? "{}")) } }))
    return new Response(JSON.stringify({ result: { stopped: true, dismissed: true, note: null, descendantsStopped: 0 } }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname.startsWith("/_frizz/rpc/")) {
    return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  }
  return originalFetch(input, init)
}

function Fixture() {
  return (
    <div className="mx-auto flex h-screen w-[min(760px,100%)] flex-col">
      <ThreadView slug={SLUG} virtualized />
    </div>
  )
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <TooltipProvider>
      <Fixture />
      <GithubHovercards />
    </TooltipProvider>
  </QueryClientProvider>,
)
