import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BgShellView, ThreadTerminal, ThreadView } from "@frizz/shared"
import { ProcessRow, QUIET_TITLE, ThreadProcessStrip, ThreadTerminalMark, processFolderHint, processTitle } from "./ThreadTerminals.tsx"
import { threadProcesses, type ThreadProcess } from "../lib/threadProcesses.ts"
import { CHILD_MARK_SLOT_CLASS } from "../lib/childOps.ts"

// ONE STRIP, TWO OWNERS. The row box is the ops strip's, so the checks that matter are the ones that keep
// every label on one x — one mark slot, one kind tag, no extra element before the label — and the ones that
// keep the two owners apart: the glyph in that slot, and the tooltip's first words.

const at = (mm: string) => `2026-09-29T10:${mm}:00.000Z`
const NOW = Date.parse(at("30"))
const term = (over: Partial<ThreadTerminal> = {}): ThreadTerminal => ({ id: "term-1", command: "npm run dev", cwd: "/repo", state: "running", runId: 1, startedAt: at("00"), ...over })
const shell = (over: Partial<BgShellView> = {}): BgShellView => ({ id: "toolu_1", label: "vite dev server", startedAt: at("00"), state: "running", cwd: "/repo", ...over })
const processes = (thread: Pick<ThreadView, "terminals" | "bgShells">) => threadProcesses(thread, [], { now: NOW })

const row = (p: ThreadProcess, extra: { onOpen?: () => void; lines?: number; watched?: boolean; threadCheckout?: ThreadView["checkout"] } = {}) =>
  renderToStaticMarkup(createElement(ProcessRow, { process: p, slug: "t", ...extra }))

const withQuery = (node: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, node))

test("the owner glyph sits IN the mark slot: a bot for the agent's, the terminal square for yours", () => {
  const [agent] = processes({ bgShells: [shell()] })
  const [human] = processes({ terminals: [term()] })
  const slot = (html: string) => html.slice(html.indexOf(`class="${CHILD_MARK_SLOT_CLASS} items-center"`), html.indexOf("frizz-kind-tag"))
  assert.match(slot(row(agent!)), /lucide-bot/)
  assert.match(slot(row(human!)), /lucide-square-terminal/)
  assert.doesNotMatch(slot(row(agent!)), /lucide-square-terminal/)
})

test("every row has exactly one TERM tag and nothing extra before its label — one label column", () => {
  const all = processes({ terminals: [term(), term({ id: "t2", state: "exited", exitCode: 1 })], bgShells: [shell(), shell({ id: "m", monitor: true })] })
  for (const p of all) {
    const html = row(p, { onOpen: () => {} })
    assert.equal(html.split("frizz-kind-tag").length - 1, 1, `${p.key}: one kind tag`)
    assert.match(html, />TERM<\/span>/)
    // Between the button's start and the label: the arrow, the one slot holding the glyph, the tag —
    // nothing else, so every label on the strip starts at one x.
    const identity = html.slice(html.indexOf("<button"), html.indexOf("data-process-label"))
    assert.equal(identity.split("<span").length - 1, 4, `${p.key}: arrow, slot, tag, and the label's own span`)
    assert.match(identity, /items-center"><svg[^>]*class="lucide lucide-[a-z-]+ h-\[1em\] w-\[1em\] shrink-0 /, `${p.key}: the glyph is centred in the slot, like the dot it replaces`)
  }
})

test("the agent's label is its description in the row's sans; yours is the command, a mono run on the sans line", () => {
  const [agent] = processes({ bgShells: [shell({ label: "Test watch in the probe worktree" })] })
  const [human] = processes({ terminals: [term()] })
  // Prose in the strip's sans, exactly as every ops-strip label (ChildOpRow) is set.
  assert.match(row(agent!), /<span data-process-label="true" class="min-w-0 truncate text-muted-70">Test watch in the probe worktree<\/span>/)
  // A command keeps its mono, as a leading-none run INSIDE the sans line, so it sits on the sans baseline
  // with every mark on the row — the fix for the mono label riding 2.34px above its ×.
  assert.match(row(human!), /<span data-process-label="true" class="min-w-0 truncate text-muted-70"><span class="font-mono-keep text-\[11px\] leading-none">npm run dev<\/span><\/span>/)
  assert.doesNotMatch(row(agent!), /font-mono-keep/)
})

test("the hue is the row's liveness", () => {
  const cases: [ThreadProcess, RegExp, string | undefined][] = [
    [processes({ bgShells: [shell()] })[0]!, /text-shell frizz-live-glyph"/, "operation"],
    [processes({ bgShells: [shell({ state: "stale" })] })[0]!, /text-shell frizz-live-glyph-quiet/, "operation-quiet"],
    [processes({ terminals: [term({ awaitingInput: true })] })[0]!, /text-attention/, "prompt"],
    [processes({ terminals: [term({ state: "exited", exitCode: 0 })] })[0]!, /text-muted-45/, undefined],
    // The ops strip's own red (PRIMER.fgDanger), the one "over budget" and a failed sub-agent wear too.
    [processes({ terminals: [term({ state: "exited", exitCode: 2 })] })[0]!, /text-\[color:var\(--gh-fg-danger\)\]/, undefined],
  ]
  for (const [p, hue, indicator] of cases) {
    const html = row(p)
    const mark = html.slice(html.indexOf("<svg"), html.indexOf("</svg>"))
    assert.match(mark, hue, p.state)
    if (indicator) assert.match(mark, new RegExp(`data-running-indicator="${indicator}"`), p.state)
    else assert.doesNotMatch(mark, /data-running-indicator/, `${p.state}: a finished row claims no liveness`)
  }
})

test("the folder hint appears only where a row runs somewhere other than the header says the agent is", () => {
  const probe = { dir: "/repo/.frizz/worktrees/probe", kind: "worktree" as const }
  const off = processes({ bgShells: [shell({ cwd: "/repo/.frizz/worktrees/probe", checkout: probe })] })[0]!
  // The agent at the root: a row off it names its checkout, and a root row names nothing.
  assert.match(row(off), /data-process-checkout="worktree"[^>]*>probe</)
  assert.doesNotMatch(row(processes({ bgShells: [shell()] })[0]!), /data-process-checkout/)
  // A terminal in `packages/web` is still in the root checkout: no hint, whatever its folder's name.
  assert.doesNotMatch(row(processes({ terminals: [term({ cwd: "/repo/packages/web" })] })[0]!), /data-process-checkout/)
  const theirs = processes({ terminals: [term({ checkout: { dir: "/elsewhere", kind: "folder" } })] })[0]!
  assert.match(row(theirs), /data-process-checkout="folder"[^>]*>elsewhere</)
  // The agent IN the worktree: the header already says `probe`, so the rows there say nothing, and the one
  // still at the root is the one that stands out.
  assert.doesNotMatch(row(off, { threadCheckout: probe }), /data-process-checkout/, "the header's word is not repeated on its rows")
  assert.match(row(processes({ bgShells: [shell()] })[0]!, { threadCheckout: probe }), /data-process-checkout="root"[^>]*>root</)
  assert.match(row(processes({ terminals: [term()] })[0]!, { threadCheckout: probe }), /data-process-checkout="root"/, "one rule for both owners")
  assert.match(row(theirs, { threadCheckout: probe }), />elsewhere</)
  // A transcript-only row was never lifted by the server: inside the agent's checkout is "where the agent
  // is", and anything else is not claimed to be the root.
  const transcriptOnly = (cwd: string) => threadProcesses({ bgShells: [] }, [{ label: "codex exec", startedAt: at("01"), state: "running", cwd }], { now: NOW })[0]!
  assert.equal(processFolderHint(transcriptOnly("/repo/.frizz/worktrees/probe/src"), probe), undefined)
  assert.equal(processFolderHint(transcriptOnly("/repo"), probe), undefined)
})

test("the tooltip says whose it is, what it runs, and where it started", () => {
  const home = "/home/u"
  assert.equal(processTitle(processes({ terminals: [term({ cwd: "/home/u/repo" })] })[0]!, home), "Your terminal — npm run dev\n~/repo")
  assert.equal(processTitle(processes({ bgShells: [shell({ cwd: "/home/u/repo" })] })[0]!, home), "Agent terminal — vite dev server\nStarted in ~/repo")
  assert.equal(processTitle(processes({ bgShells: [shell({ cwd: "/home/u/repo" })] })[0]!, home, true), "Agent terminal — vite dev server\nStarted in ~/repo\nWatched — this thread wakes when it finishes")
  assert.equal(processTitle(processes({ bgShells: [shell({ monitor: true, cwd: "/home/u/repo" })] })[0]!, home), "Agent monitor — vite dev server\nStarted in ~/repo")
  // The breathing mark says what it means, as the old SHELL row's quiet dot did in its title.
  assert.equal(processTitle(processes({ bgShells: [shell({ state: "stale", cwd: "/home/u/repo" })] })[0]!, home), `Agent terminal — vite dev server\n${QUIET_TITLE}\nStarted in ~/repo`)
})

test("a Codex exec's row opens like every other; a transcript-only row has nothing to open", async () => {
  const strip = (thread: Pick<ThreadView, "id" | "terminals" | "bgShells" | "watches">, transcript: Parameters<typeof threadProcesses>[1] = []) =>
    withQuery(createElement(ThreadProcessStrip, { thread, surface: "card", transcriptShells: transcript }))
  const codex = strip({ id: "t", bgShells: [shell({ id: "p1", outputUnavailable: true, stoppable: true })], watches: [] })
  assert.match(codex, /<button[^>]*aria-label="Open agent terminal: vite dev server"/)
  assert.doesNotMatch(codex, /lines/, "no line counter for output Frizz cannot read")
  const orphan = strip({ id: "t", bgShells: [], watches: [] }, [{ label: "child's watcher", startedAt: at("01"), state: "running" }])
  assert.doesNotMatch(orphan, /aria-label="Open agent terminal/)
  assert.match(orphan, /child&#x27;s watcher|child's watcher/)
})

test("the agent's row reads its line count and budget; yours reads its state once it has ended", () => {
  // The row's clock is the page's (lib/liveClock.ts), so its age is measured from real time: 12m30s ago
  // (half a minute of headroom — see ChildOpRow.test.ts for why exactly-12m is flaky).
  const started = new Date(Date.now() - 12 * 60_000 - 30_000).toISOString()
  const agent = processes({ bgShells: [shell({ budgetEndsAt: at("45"), startedAt: started })] })[0]!
  const html = row(agent, { lines: 142 })
  assert.match(html, /data-child-op-counter[^>]*>142 lines</)
  assert.match(html, /data-child-op-budget[^>]*>15m left</)
  assert.match(html, />12m</, "and its age, in the house grammar")
  const prompt = row(processes({ terminals: [term({ awaitingInput: true, startedAt: started })] })[0]!)
  assert.match(prompt, /text-attention">waiting for input</)
  assert.doesNotMatch(prompt, />12m</, "a terminal at a prompt shows its state, not a clock")
  assert.match(row(processes({ terminals: [term({ startedAt: started })] })[0]!), />12m</, "yours reads its age while it runs")
  assert.match(row(processes({ terminals: [term({ state: "exited", exitCode: 2 })] })[0]!), /text-\[color:var\(--gh-fg-danger\)\]">exit 2</)
})

test("the sidebar mark counts both owners, and its tone says whose is running", () => {
  const mark = (thread: Pick<ThreadView, "terminals" | "bgShells">) => renderToStaticMarkup(createElement(ThreadTerminalMark, { thread }))
  assert.equal(mark({ bgShells: [] }), "", "nothing running, nothing drawn")
  const agentOnly = mark({ bgShells: [shell(), shell({ id: "b", label: "CI watch" })] })
  assert.match(agentOnly, /data-thread-terminal-mark="agent"/)
  assert.match(agentOnly, /text-muted-50/)
  assert.match(agentOnly, /title="2 agent terminals running: vite dev server, CI watch"/)
  // One grammar per owner — "Your terminal" / "N of your terminals", "Agent terminal" / "N agent terminals".
  const mine = mark({ terminals: [term()], bgShells: [shell()] })
  assert.match(mine, /data-thread-terminal-mark="running"/)
  assert.match(mine, /text-shell/)
  assert.match(mine, /title="Your terminal running: npm run dev · Agent terminal running: vite dev server"/)
  const asking = mark({ terminals: [term({ awaitingInput: true, command: "npm login" })], bgShells: [] })
  assert.match(asking, /data-thread-terminal-mark="prompt"/)
  assert.match(asking, /text-attention/)
  assert.match(asking, /title="Your terminal waiting for input: npm login"/)
  // A prompt does not hide the rest of yours that are still running.
  const both = mark({ terminals: [term({ awaitingInput: true, command: "npm login" }), term({ id: "t2", command: "sleep 600" }), term({ id: "t3", command: "nub dev" })], bgShells: [] })
  assert.match(both, /title="Your terminal waiting for input: npm login · 2 of your terminals running: sleep 600, nub dev"/)
  // A shell the OS says nobody holds is not counted as running.
  assert.equal(mark({ bgShells: [shell({ state: "stale" })] }), "")
})

test("the queue card draws the same strip under its reply box, and only the prompting screen above it", async () => {
  const { readFileSync } = await import("node:fs")
  const card = readFileSync(new URL("./AllQueuesCard.tsx", import.meta.url), "utf8")
  assert.match(card, /data-queue-processes=\{thread\.id\}[\s\S]{0,200}<ThreadProcessStrip[\s\S]{0,80}surface="card"/)
  assert.match(card, /<TerminalPromptPane thread=\{thread\} \/>/)
  assert.doesNotMatch(card, /QueueShellStrip|ThreadTerminalsStrip/, "no second strip for either owner")
  // A row opens the drawer only where the drawer stack is the card's own project's.
  assert.match(card, /const here = focusedProject\(project\.slug\)\s+openInPlace\(project, thread\.id\)\s+if \(here\) openProcessDrawer\(thread\.id, process\)/)
  // The meta line carries the checkout token between the time and the status, as the drawer header does.
  const meta = card.slice(card.indexOf("<LastActive"), card.indexOf("<ThreadStatusLine"))
  assert.match(meta, /<ThreadCheckoutToken checkout=\{thread\.checkout\} homeDir=\{project\.homeDir\}/)
})
