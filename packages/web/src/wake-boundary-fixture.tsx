import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ChatMessage } from "./hooks.ts"
import { Message } from "./components/ChatView.tsx"
import "./styles.css"

// Turn-BOUNDARY rendering (the `boundary` flag on a `kind:"event"` message). A background-task/shell
// completion `<task-notification>` re-invokes the agent, opening a fresh turn with no visual separation
// from the prior one — two turns (each ending in its own final message) otherwise paint as one bubble.
// The boundary event renders a centered divider rule carrying the cause label ON it, so the wake — and
// the seam between the two turns — is unmistakable. A plain (non-boundary) event line is shown too for
// contrast: it stays a quiet, divider-less annotation.
//
// The `rest` boundary is here beside the `wake` one, but NO LONGER STACKED ON IT. The two used to be
// adjacent in every real transcript — an agent rests, a background completion wakes it — and this
// fixture existed to judge that pair. It read as two stacked accidents, and the pair is now filtered out
// of the transcript entirely (lib/restDividers.ts): nothing can wake an agent that had not come to rest,
// so the wake rule already carries the fact. What is left to judge is the ONE position the rest rule
// survives in — directly above the human's next message, where it is what tells a reply to a finished
// agent apart from a steer typed into a turn still in flight.
//
// Message renders what it is handed, so this list is written the way the filter leaves it. A rest event
// stacked on the wake below, or trailing the last message, would render here and nowhere in the app.
const messages: ChatMessage[] = [
  { sourceId: "u1", role: "user", text: "The popover for the restart button needs to indicate the operation is safe.", tools: [], parts: [] },
  {
    sourceId: "a1",
    role: "assistant",
    text: "Done — simplified the restart popover to a single calm sentence and drove it in a real browser at both viewports. Tests pass, typecheck clean.",
    tools: [],
    parts: [],
  },
  { sourceId: "e1", role: "assistant", kind: "event", text: "Agent «restart-popover-copy» finished — 4m", tools: [], parts: [] },
  {
    sourceId: "b1",
    role: "assistant",
    kind: "event",
    boundary: "wake",
    text: "Agent terminal «Start vite from web package dir» exited 143",
    tools: [],
    parts: [],
  },
  {
    sourceId: "a2",
    role: "assistant",
    text: "That's the vite dev server I just killed (exit 143 = SIGTERM), confirming clean shutdown. Nothing further needed — the work is complete and verified.",
    tools: [],
    parts: [],
  },
  { sourceId: "r2", role: "assistant", kind: "event", boundary: "rest", text: "Agent rested", tools: [], parts: [] },
  { sourceId: "u2", role: "user", text: "Good — now check the same popover at 420px.", tools: [], parts: [] },
]

function Fixture() {
  return (
    <main className="min-h-screen bg-bg p-4 sm:p-8">
      <section className="mx-auto flex min-h-[360px] max-w-[760px] flex-col border border-border bg-panel px-5 py-4 shadow-xl shadow-black/30 sm:px-7">
        <header className="border-b border-border pb-3">
          <h1 className="text-[16px] font-semibold text-fg">Turn boundaries — rest and background-task wake</h1>
          <p className="mt-0.5 text-[12px] text-muted">The wake rule opens the turn a background completion caused; the rest rule closes the one the human replied to.</p>
        </header>
        <div className="flex flex-1 flex-col gap-3.5 py-5">
          {messages.map((message) => <Message key={message.sourceId} m={message} />)}
        </div>
      </section>
    </main>
  )
}

// `Message` reaches for react-query (the tool cards' lazy detail fetches), so the fixture has to supply
// a client the way every other transcript fixture does — without it the whole page threw
// "No QueryClient set" and rendered nothing at all.
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <Fixture />
  </QueryClientProvider>,
)
