import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, RegisteredQuestionView, ThreadView as ThreadViewModel, TranscriptMessage } from "@frizz/shared"
import { TodosView } from "./components/TodosView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for a REGISTERED question on the queue card — a question a worker created with the `ask`
// tool, which is a row rather than a fence in a message. It renders through the shared QuestionBlockCard
// (RegisteredQuestionCards.tsx), so what is worth looking at here is what a registration adds: the ×,
// the rich option BODY (full markdown inside the chip, visible before anything is picked — one option
// below writes the new multi-line `description`, the other the retired `preview`, and they must render
// the same), and the FOLLOW-UP tree that appears as the root is answered.
//
//   ?tree=1     — a root whose "Yes" carries two follow-ups. Pick A and watch them appear indented.
//   ?danger=1   — the destructive gate: `risk` tone, and NO × (declining is an option INSIDE it).
//   ?many=1     — three open questions at once, which is what the ONE shared "Send answers" is for.
//   ?busy=1     — a question AND live background work, which is the case the memo calls out: the
//                 question expands and the waits must not compete with it for the one glance.
//   ?past=1     — the question was asked at an OLDER rest, the human replied past it without answering,
//                 and the worker's newest handoff carries a LEGACY empty ```question qst_… marker naming
//                 it — how a worker dispatched before 2026-09-28 says a newer handoff still owes the ask.
//                 The card's window opens at the newest rest (hasEarlier), so the asking rest is above the
//                 window. The marker must draw NOTHING, the card must render ONCE, at the BOTTOM under the
//                 whole handoff, and the card-level "Send answers" must stand down (the registered card
//                 carries its own).
//   ?table=1    — an option whose body carries a TABLE, a blockquote and a code fence: the blocks whose
//                 opaque panel fills clashed with a selected chip's accent tint (screenshot 2026-09-02).
//   ?wide=1     — a `multi` over THIRTY options: no count cap (2026-09-03), and lettering past `Z.`.
//   ?placed=1   — RETIRED PLACEMENT (2026-09-28): two questions open at one rest, and the handoff carries
//                 a legacy marker for ONE of them mid-prose, with a paragraph under it. The marker must
//                 draw NOTHING: both cards render together UNDER the whole handoff, one stack, one Send.
//   ?woken=1    — the worker asked and rested, then frizz WOKE it (a PR watcher expired) and it wrote a
//                 newer handoff with the question still open. Only frizz has spoken since, so the card
//                 must render at the BOTTOM, under the newer handoff — not frozen above the wake.
//   ?font=sans  — the other of the two fonts this app renders in; mono is the default and the wider.
const params = new URLSearchParams(location.search)
document.documentElement.dataset.font = params.get("font") === "sans" ? "sans" : "mono"
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()

const SETTINGS: RegisteredQuestionView = {
  id: "qst_0001aaaa",
  askedAt: ago(6),
  spec: {
    question: "Where should the settings store live?",
    kind: "question",
    options: [
      {
        label: "SQLite",
        // The NEW shape: a multi-line description IS the option's body — full markdown, inside the
        // chip, visible before anything is picked.
        description: "Transactional, and it is where sessions already live.\n\n```sql\nCREATE TABLE setting (\n  key   TEXT PRIMARY KEY,\n  value TEXT NOT NULL\n);\n```\n\nMigrates with the rest of the schema; one more table in `ui.db`.",
        recommended: true,
      },
      {
        label: "A JSON file",
        description: "zero dependencies and hand-editable, but racy under concurrent writes",
        // The RETIRED shape, still carried by stored rows: folds into the same always-visible body
        // under the one-line trade-off, never behind a pick.
        preview: "```json\n{ \"theme\": \"dark\", \"font\": \"mono\" }\n```\nOne file at `~/.frizz/settings.json`. Two servers writing it at once is the failure mode.",
      },
    ],
  },
}

const TREE: RegisteredQuestionView = {
  id: "qst_0002bbbb",
  askedAt: ago(3),
  spec: {
    question: "The parser refactor is green on every gate. Land it on `main`?",
    kind: "question",
    options: [
      {
        label: "Land it",
        description: "the three CI legs are green and the diff is reviewed",
        recommended: true,
        followUps: [
          { question: "Tag a release at the same time?", kind: "question", options: [{ label: "Tag 0.9.0" }, { label: "Leave it unreleased" }] },
          { question: "Anything the release notes must say?", kind: "question" },
        ],
      },
      { label: "Hold it", description: "something about it still reads wrong", followUps: [{ question: "What is blocking it?", kind: "question" }] },
    ],
  },
}

const GATE: RegisteredQuestionView = {
  id: "qst_0003cccc",
  askedAt: ago(1),
  spec: {
    question: "`main` has three commits the remote does not. Force-push over them?",
    kind: "question",
    danger: true,
    options: [
      { label: "Force-push", description: "the three commits are the rebase of the same work — they are not lost" },
      { label: "Stop and leave the remote alone", recommended: true, description: "somebody else may have pulled them" },
    ],
  },
}

const GATES: RegisteredQuestionView = {
  id: "qst_0004dddd",
  askedAt: ago(9),
  spec: {
    question: "Which gates should run before every commit?",
    kind: "multi",
    options: [{ label: "Typecheck" }, { label: "Unit tests" }, { label: "The browser e2e pass", description: "slow — about 90s" }],
  },
}

// A `multi` over a LONG list — thirty options, past the `.max(8)` the schema carried until 2026-09-03
// and past the 26 the card letters `A.`–`Z.`, so the tail reads `AA.`…`AD.`. What is worth looking at is
// that the run stays one even column and the free-text row still follows the last option.
const WIDE: RegisteredQuestionView = {
  id: "qst_0006ffff",
  askedAt: ago(4),
  spec: {
    question: "The audit turned up thirty findings. Which of them should be fixed on this thread?",
    kind: "multi",
    options: Array.from({ length: 30 }, (_, i) => ({
      label: `Finding ${i + 1}`,
      ...(i % 7 === 3 ? { description: "a one-line trade-off, so the row wraps the way a real one does" } : {}),
    })),
  },
}

// An option body carrying every BLOCK the prose surface renders — a table above all, which is the case
// that broke inside a SELECTED chip (the accent tint behind opaque panel fills; screenshot 2026-09-02).
const TABLE: RegisteredQuestionView = {
  id: "qst_0005eeee",
  askedAt: ago(2),
  spec: {
    question: "The skip warning fires on packages that were already built. How should it resolve?",
    kind: "question",
    options: [
      {
        label: "Leave it — the warning is annoying but the gate stays strict",
        description: "Nothing changes; the warning keeps firing on every `nub add` until the lockfile is re-checked.",
      },
      {
        label: "Fix it — judge the wait per package",
        recommended: true,
        description: [
          "Kills the false warning, but a curated package would start building in a case where it is currently skipped — a real loosening of the supply-chain gate.",
          "",
          "Today a package qualifies for the curated build allowlist only if the graph as a whole came from an already-checked lockfile. Adding any new dependency makes that false for **every** package in the tree.",
          "",
          "Effect on `nub add esbuild`-style flows:",
          "",
          "| today | after |",
          "| --- | --- |",
          "| `WARN ignored build scripts for esbuild@0.24.0` | no warning; esbuild stays trusted |",
          "| already-built packages keep working | same |",
          "| a curated package is skipped after any add | a curated package may now build after an add |",
          "",
          "> The gate's criteria are unchanged; only the unit of judgment moves.",
          "",
          "```ts",
          "const trusted = lockfileChecked(pkg.version) // per package, not per graph",
          "```",
        ].join("\n"),
      },
    ],
  },
}

// The ask a frizz wake used to strand above the worker's newer handoff (2026-09-28, a real thread's
// shape: asked on one day, the PR watcher expired four days later, the worker re-armed and rested again).
const MERGE: RegisteredQuestionView = {
  id: "qst_0007abab",
  askedAt: ago(30),
  spec: {
    question: "PR #1403 is merge-ready (CI green, e2e approved on the preview repo, last review clean). Merge it to main?",
    kind: "question",
    options: [
      { label: "Merge it", description: "squash-merge now; the preview repo already approved it end to end", recommended: true },
      { label: "Hold it", description: "leave it open for another look" },
    ],
  },
}

const placed = params.get("placed") === "1"
const woken = params.get("woken") === "1"
const questions = params.get("danger") === "1" ? [GATE]
  : placed ? [SETTINGS, GATES]
  : woken ? [MERGE]
  : params.get("wide") === "1" ? [WIDE]
  : params.get("tree") === "1" ? [TREE]
  : params.get("many") === "1" ? [SETTINGS, TREE, GATES]
  : params.get("table") === "1" ? [TABLE]
  : [SETTINGS]

const tail = "Both stores work. The choice is yours because it is the one thing here that is hard to reverse once there is data in it."
const past = params.get("past") === "1"
const marker = `**Fixed** — nothing further to do on the store: \`c6c292e8\` is on local \`main\`.\n\nThe one card still on the board is yours to decide, and it is the reason this thread does not file itself away as done:\n\n\`\`\`question ${SETTINGS.id}\n\`\`\`\n\nAnswer it either way and this thread is finished.`
const placedHandoff = `**Fixed** — the store is in and \`c6c292e8\` is on local \`main\`.\n\nOne call is yours, because it is the one thing here that is hard to reverse once there is data in it:\n\n\`\`\`question ${SETTINGS.id}\n\`\`\`\n\nEither store passes every gate today. The gates themselves are the other open card, below.`
const askedHandoff = "[#1403](https://github.com/pullfrog/app/pull/1403) is merge-ready and needs a go-ahead to merge. CI is green (7 checks passed, 6 skipped), and the latest review found no new issues and no open threads."
const wake = "⏰ Your watcher on pullfrog/app#1403 has expired and is no longer armed — nothing on that PR will wake you now."
const wokenHandoff = "[#1403](https://github.com/pullfrog/app/pull/1403) is still open and merge-ready. Nothing has happened on it since the clean review: CI is green on `df703a8` and it is still mergeable.\n\nThe PR watch is re-armed for 30 days, so a conflict or a new review wakes this thread."
const messages: TranscriptMessage[] = placed
  ? [
      { role: "user", at: ago(12), text: "Add a settings store.", tools: [], parts: [{ kind: "text", text: "Add a settings store." }] },
      { role: "assistant", at: ago(1), text: placedHandoff, tools: [], parts: [{ kind: "text", text: placedHandoff }] },
    ]
  : woken
  ? [
      { role: "user", at: ago(40), text: "Get #1403 merge-ready.", tools: [], parts: [{ kind: "text", text: "Get #1403 merge-ready." }] },
      { role: "assistant", at: ago(30), text: askedHandoff, tools: [], parts: [{ kind: "text", text: askedHandoff }] },
      { role: "assistant", kind: "event", boundary: "rest", at: ago(30), text: "Agent rested", tools: [], parts: [] },
      { role: "user", at: ago(5), text: wake, wake: true, tools: [], parts: [] },
      { role: "assistant", at: ago(4), text: wokenHandoff, tools: [], parts: [{ kind: "text", text: wokenHandoff }] },
      { role: "assistant", kind: "event", boundary: "rest", at: ago(4), text: "Agent rested", tools: [], parts: [] },
    ]
  : past
  ? [
      // The window opens at the human's reply; the rest the question was asked at is above it.
      { role: "user", at: ago(2), text: "Well done, you did it.", tools: [], parts: [{ kind: "text", text: "Well done, you did it." }] },
      { role: "assistant", at: ago(1), text: marker, tools: [], parts: [{ kind: "text", text: marker }] },
    ]
  : [
      { role: "user", text: "Add a settings store.", tools: [], parts: [{ kind: "text", text: "Add a settings store." }] },
      { role: "assistant", text: tail, tools: [], parts: [{ kind: "text", text: tail }] },
    ]

const thread = {
  id: "registered-question-demo",
  title: woken ? "Get #1403 merge-ready" : "Add a settings store",
  status: "active",
  mechanism: null,
  humanBlocked: false,
  // A registered question is a hard queue member — deriveNeedsYou returns true on any open row.
  needsYou: true,
  awaitingBackground: false,
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  runtime: "turn-idle",
  sessionId: "aaaaaaaa-bbbb-cccc-dddd-000000000009",
  unread: false,
  archived: false,
  hasPlan: false,
  pendingQuestion: false,
  questions,
  kind: "session",
  foreign: false,
  backend: "claude",
  permissionMode: "default",
  subAgents: params.get("busy") === "1"
    ? [{ id: "agent-a", label: "Audit the parser for edge cases", subagentType: "frizz:high", startedAt: ago(4), state: "running" }]
    : [],
  bgShells: params.get("busy") === "1"
    ? [{ id: "toolu_ci", taskId: "bzvtnt3ig", label: "gh run watch 1842", startedAt: ago(6), state: "running" }]
    : [],
  watches: params.get("busy") === "1"
    ? [{ id: "wch_aaa", kind: "shell", target: "bzvtnt3ig", state: "armed", createdAt: ago(6) }]
    : [],
  lastActivityAt: ago(1),
} as unknown as ThreadViewModel

store.board = { projectDir: "/fixture/frizz", threads: [thread] } as BoardSnapshot

const transcriptPage = { messages, transcriptKey: "fixture-key", hasEarlier: past, historyLoaded: false }
const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.origin)
  if (url.pathname === "/_frizz/rpc/threadTranscript" || url.pathname === "/_frizz/rpc/threadTranscriptEarlier") {
    return new Response(JSON.stringify({ result: transcriptPage }), { headers: { "content-type": "application/json" } })
  }
  // The two writes the card makes, echoed onto the window so a probe can assert the exact payload the
  // worker would receive — above all that an answer RESTATES the question and carries the option's own
  // label rather than the lettered chip text.
  if (url.pathname === "/_frizz/rpc/answerQuestions" || url.pathname === "/_frizz/rpc/dismissQuestions") {
    const body = JSON.parse(String(init?.body ?? "{}"))
    window.dispatchEvent(new CustomEvent("fixture-rpc", { detail: { rpc: url.pathname.split("/").pop(), body } }))
    const ids: string[] = body.ids ?? (body.answers ?? []).map((a: { questionId: string }) => a.questionId)
    return new Response(JSON.stringify({ result: { answered: ids, dismissed: ids, open: [] } }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname.startsWith("/_frizz/rpc/")) {
    return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  }
  return originalFetch(input, init)
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <TooltipProvider>
      <div className="mx-auto w-[min(680px,calc(100%-32px))] py-8">
        <TodosView />
      </div>
    </TooltipProvider>
  </QueryClientProvider>,
)
