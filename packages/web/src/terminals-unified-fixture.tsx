import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BgShellView, ThreadTerminal, ThreadView } from "@frizz/shared"
import { ThreadProcessStrip, ThreadTerminalMark } from "./components/ThreadTerminals.tsx"
import { ThreadCheckoutToken } from "./components/ThreadCheckoutToken.tsx"
import { TerminalSheet } from "./components/TerminalSheet.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { Toaster } from "./components/Toaster.tsx"
import { initFont } from "./lib/font.ts"
import { setThemePreference } from "./lib/theme.ts"
import "./styles.css"

// ONE STRIP, TWO OWNERS — every state a terminal row can be in, side by side, for the states a live stack
// cannot reach on demand: a finished and a failed run of yours, an agent shell over its budget or quiet,
// a Codex exec whose output Frizz cannot read, a monitor. `?mode=codex` / `?mode=gone` show the agent
// drawer's two empty states. `data-font="sans"` is on the page, as in the product. No server: every RPC
// is answered here, and nothing is started or stopped.
const params = new URLSearchParams(location.search)
const mode = params.get("mode") ?? "strip"
setThemePreference(params.get("theme") === "dark" ? "dark" : "light")
initFont()
const json = (result: unknown) => new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json" } })
const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const url = new URL(href, location.href)
  if (!url.pathname.startsWith("/_frizz/rpc/")) return nativeFetch(input, init)
  const method = url.pathname.split("/").at(-1)
  if (method === "backgroundShellOutput") {
    return mode === "codex"
      ? json({ state: "running", command: "cargo watch -x test", output: "", truncated: false, stoppable: true, stopNote: null, end: 0, outputUnavailable: true, cwd: "/home/u/repo/.frizz/worktrees/probe", checkout: { dir: "/home/u/repo/.frizz/worktrees/probe", kind: "worktree" } })
      : json({ state: "done", command: "nub run test", output: "", truncated: false, stoppable: false, stopNote: null, end: 0, missing: true, cwd: "/home/u/repo" })
  }
  return json({})
}

const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
const ahead = (m: number) => new Date(Date.now() + m * 60_000).toISOString()
const WT = { dir: "/home/u/repo/.frizz/worktrees/probe", kind: "worktree" as const }
const terminals: ThreadTerminal[] = [
  { id: "t-prompt", command: "npm login", cwd: "/home/u/repo", state: "running", awaitingInput: true, awaitingSince: ago(1), runId: 1, startedAt: ago(2) },
  { id: "t-run", command: "npm run dev", cwd: WT.dir, checkout: WT, state: "running", runId: 1, startedAt: ago(40) },
  { id: "t-ok", command: "git status", cwd: "/home/u/repo", state: "exited", exitCode: 0, runId: 1, startedAt: ago(9) },
  { id: "t-fail", command: "nub run typecheck", cwd: "/home/u/repo", state: "exited", exitCode: 2, runId: 1, startedAt: ago(5) },
]
const bgShells: BgShellView[] = [
  { id: "s-root", label: "vite dev server", startedAt: ago(72), state: "running", stoppable: true, taskId: "b1", cwd: "/home/u/repo" },
  { id: "s-wt", label: "nub test --watch", startedAt: ago(12), state: "running", stoppable: true, taskId: "b2", budgetEndsAt: ahead(33), cwd: WT.dir, checkout: WT },
  { id: "s-over", label: "CI watch", startedAt: ago(61), state: "running", stoppable: true, taskId: "b3", budgetEndsAt: ago(1) },
  { id: "s-quiet", label: "tail the deploy log", startedAt: ago(20), state: "stale", taskId: "b4", monitor: true },
  { id: "s-codex", label: "cargo watch -x test", startedAt: ago(3), state: "running", stoppable: true, outputUnavailable: true, cwd: WT.dir, checkout: WT },
]
const thread = { id: "fixture", terminals, bgShells, watches: [] } as Pick<ThreadView, "id" | "terminals" | "bgShells" | "watches">

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <TooltipProvider>
      <main data-terminals-fixture={mode} className="mx-auto min-h-screen max-w-[720px] bg-bg p-5 text-fg">
        {mode === "strip" && (
          <div className="flex flex-col gap-6">
            {/* The drawer header's second line and the card's meta line, each with the token. */}
            <div data-fixture-meta="header" className="flex min-w-0 items-center gap-1.5 text-[11px] leading-tight text-muted-75">
              <span>READY</span>
              <span aria-hidden className="shrink-0 opacity-60">·</span>
              <time className="min-w-0 truncate">Last active 9m ago</time>
              <ThreadCheckoutToken checkout={WT} homeDir="/home/u" lead={<span aria-hidden className="shrink-0 opacity-60">·</span>} />
            </div>
            <div data-fixture-meta="card" className="flex min-w-0 items-baseline gap-1.5 text-[11px] leading-tight text-muted-75">
              <span className="min-w-0 truncate">Ready 9m ago</span>
              <ThreadCheckoutToken checkout={{ dir: "/srv/other-checkout", kind: "folder" }} homeDir="/home/u" lead={<span aria-hidden>·</span>} />
            </div>
            <div data-fixture-strip className="rounded-md border border-border bg-panel px-4 py-3">
              <ThreadProcessStrip thread={thread} surface="card" onOpen={() => {}} />
            </div>
            {/* The rail mark's three tones: yours at a prompt, yours running, only the agent's running. */}
            <div data-fixture-marks className="flex flex-col gap-2 text-[13px]">
              <span className="flex items-center">Fix the login flow<ThreadTerminalMark thread={{ terminals: [terminals[0]!], bgShells: [] }} /></span>
              <span className="flex items-center">Rail bands<ThreadTerminalMark thread={{ terminals: [terminals[1]!], bgShells: [bgShells[0]!] }} /></span>
              <span className="flex items-center">Dev server<ThreadTerminalMark thread={{ terminals: [], bgShells: [bgShells[0]!] }} /></span>
            </div>
          </div>
        )}
        {(mode === "codex" || mode === "gone") && (
          <TerminalSheet id={1} slug="fixture" source={{ owner: "agent", shellId: mode === "codex" ? "s-codex" : "s-gone" }} label={mode === "codex" ? "cargo watch -x test" : "nub run test"} startedAt={ago(3)} depth={0} widthDepth={0} />
        )}
      </main>
      <Toaster />
    </TooltipProvider>
  </QueryClientProvider>,
)
