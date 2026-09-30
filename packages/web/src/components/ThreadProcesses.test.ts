import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BgShellView, ThreadTerminal, ThreadView } from "@frizz/shared"
import { ROOT_CHECKOUT_WORD, ProcessRow, QUIET_TITLE, TerminalPromptPane, ThreadProcessStrip, ThreadTerminalMark, cardProcesses, folderHintTitle, processFolderHint, processTitle } from "./ThreadTerminals.tsx"
import { threadProcesses, type ThreadProcess } from "../lib/threadProcesses.ts"
import { AGENT_GLYPH_STROKE, CHILD_MARK_SLOT_CLASS } from "../lib/childOps.ts"
import { BgShellRow, TermWaitRow } from "./AwaitingBackgroundCard.tsx"
import { FolderHintToken } from "./ThreadTerminals.tsx"

// ONE STRIP, TWO OWNERS. The row box is the ops strip's, so the checks that matter are the ones that keep
// every label on one x — one mark slot, one kind tag, no extra element before the label — and the ones that
// keep the two owners apart: the glyph in that slot, and the tooltip's first words.

const at = (mm: string) => `2026-09-29T10:${mm}:00.000Z`
const NOW = Date.parse(at("30"))
// As the board sends them: a folder the server read is placed — `checkout` off the root, `atRoot` in it.
const placedAt = (over: { checkout?: unknown; atRoot?: unknown }) => ("checkout" in over || "atRoot" in over ? {} : { atRoot: true as const })
const term = (over: Partial<ThreadTerminal> = {}): ThreadTerminal => ({ id: "term-1", command: "npm run dev", cwd: "/repo", state: "running", runId: 1, startedAt: at("00"), ...placedAt(over), ...over })
const shell = (over: Partial<BgShellView> = {}): BgShellView => ({ id: "toolu_1", label: "vite dev server", startedAt: at("00"), state: "running", cwd: "/repo", ...placedAt(over), ...over })
const processes = (thread: Pick<ThreadView, "terminals" | "bgShells">) => threadProcesses(thread, [], { now: NOW })

const row = (p: ThreadProcess, extra: { onOpen?: () => void; lines?: number; watched?: boolean; here?: ThreadView["checkout"] } = {}) =>
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
    // ONE box for both owners (1em, lifted by the measured MARK_LIFT); the bot's missing weight is its pen
    // (AGENT_GLYPH_STROKE), not its size — at 1.1em it was the widest, loudest mark on the strip.
    assert.match(identity, /items-center"><svg[^>]*class="lucide lucide-[a-z-]+ h-\[1em\] w-\[1em\] shrink-0 -translate-y-\[0\.03em\] /, `${p.key}: the glyph is centred in the slot, like the dot it replaces`)
    assert.match(identity, new RegExp(`stroke-width="${p.owner === "agent" ? AGENT_GLYPH_STROKE : 2}"`), `${p.key}: the owner's pen`)
  }
})

test("a Codex exec whose label IS its command is set as a command, in mono, like yours", () => {
  const [codex] = processes({ bgShells: [shell({ id: "p1", label: "cargo watch -x test", command: "cargo watch -x test", outputUnavailable: true })] })
  assert.match(row(codex!), /<span data-process-label="true" class="min-w-0 truncate text-muted-70"><span class="font-mono-keep text-\[11px\] leading-none">cargo watch -x test<\/span><\/span>/)
  // A described one stays prose, even with its command beside it.
  const [described] = processes({ bgShells: [shell({ id: "p2", label: "Run the tests on change", command: "cargo watch -x test" })] })
  assert.doesNotMatch(row(described!), /font-mono-keep/)
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

test("the folder hint names a row's checkout only when it is NOT where the header says the agent is", () => {
  const probe = { dir: "/repo/.frizz/worktrees/probe", kind: "worktree" as const }
  const other = { dir: "/repo/.frizz/worktrees/other", kind: "worktree" as const }
  const inProbe = processes({ bgShells: [shell({ cwd: "/repo/.frizz/worktrees/probe/packages/web", checkout: probe })] })[0]!
  const atRoot = processes({ bgShells: [shell()] })[0]!
  const humanAtRoot = processes({ terminals: [term({ cwd: "/repo/packages/web" })] })[0]!
  const inOther = processes({ terminals: [term({ checkout: other })] })[0]!
  // The agent at the project root (no header token): only a row off the root says where it is.
  assert.match(row(inProbe), /data-process-checkout="worktree"[^>]*>(?:<[^>]*>)*probe</)
  assert.equal(processFolderHint(atRoot, undefined), undefined, "the root, while the header says the root, names nothing")
  assert.equal(processFolderHint(humanAtRoot, undefined), undefined, "a terminal in packages/web is in the root checkout")
  // The agent in `probe` (the header's token says so): a row there says nothing more…
  assert.equal(processFolderHint(inProbe, probe), undefined, "the header already said probe")
  // …a row in the project's own checkout says `root`, one word, for both owners…
  assert.deepEqual(processFolderHint(atRoot, probe), { text: ROOT_CHECKOUT_WORD, kind: "root" })
  assert.deepEqual(processFolderHint(humanAtRoot, probe), { text: "root", kind: "root" })
  assert.match(row(atRoot, { here: probe }), /data-process-checkout="root" title="Runs in the project root[^"]*"[^>]*><span[^>]*><svg[^>]*lucide-folder /)
  assert.match(row(atRoot, { here: probe }), /data-process-checkout-word="true"[^>]*>root</)
  // …and a row in a third checkout names it.
  assert.deepEqual(processFolderHint(inOther, probe), { text: "other", kind: "worktree", dir: other.dir })
  // A row the server did not place (transcript-only) claims nothing, wherever the agent is.
  const transcriptOnly = threadProcesses({ bgShells: [] }, [{ label: "codex exec", startedAt: at("01"), state: "running", cwd: "packages/web" }], { now: NOW })[0]!
  assert.equal(processFolderHint(transcriptOnly, undefined), undefined)
  assert.equal(processFolderHint(transcriptOnly, probe), undefined)
})

// NO READING IS NOT THE ROOT. The server says `atRoot` only for a folder it read and found in the project's
// own checkout; with neither that nor a `checkout`, a row claims no place. Reading such a row as the root
// said `root` beside a terminal left in a worktree removed since, and beside a Codex exec whose item named
// no folder while the agent's own workdir was a worktree.
test("a row the server could not place claims no folder, even while the agent is elsewhere", () => {
  const probe = { dir: "/repo/.frizz/worktrees/probe", kind: "worktree" as const }
  const removed = processes({ terminals: [term({ cwd: "/repo/.frizz/worktrees/gone", atRoot: undefined })] })[0]!
  const bareCodex = processes({ bgShells: [shell({ id: "p-bare", cwd: undefined, atRoot: undefined, outputUnavailable: true })] })[0]!
  // A transcript copy can fill in the board row's folder (mergeBackgroundShells) — for the tooltip only.
  const backfilled = threadProcesses({ bgShells: [shell({ id: "p-bf", command: "cargo watch", cwd: undefined, atRoot: undefined })] }, [{ label: "cargo watch", command: "cargo watch", startedAt: at("00"), state: "running", cwd: "/repo/.frizz/worktrees/probe" }], { now: NOW })[0]!
  assert.equal(backfilled.cwd, "/repo/.frizz/worktrees/probe", "the tooltip still says where the transcript ran it")
  for (const p of [removed, bareCodex, backfilled]) {
    assert.equal(p.placed, false, p.key)
    assert.equal(processFolderHint(p, probe), undefined, p.key)
    assert.doesNotMatch(row(p, { here: probe }), /data-process-checkout/, p.key)
  }
})

test("the hint's tooltip names the place in words, then in full", () => {
  assert.equal(folderHintTitle({ text: "root", kind: "root" }, "/home/u/frizz", "/home/u"), "Runs in the project root\n~/frizz")
  assert.equal(folderHintTitle({ text: "probe", kind: "worktree", dir: "/home/u/frizz/.frizz/worktrees/probe" }, "/home/u/frizz", "/home/u"), "Runs in the probe worktree\n~/frizz/.frizz/worktrees/probe")
  assert.equal(folderHintTitle({ text: "other", kind: "folder", dir: "/srv/other" }, "/home/u/frizz", "/home/u"), "Runs in another folder\n/srv/other")
})

test("a strip whose rows all run where the agent is shows no hints — the header said it once", () => {
  const probe = { dir: "/repo/.frizz/worktrees/probe", kind: "worktree" as const }
  const strip = (thread: Partial<ThreadView>) =>
    withQuery(createElement(ThreadProcessStrip, { thread: { id: "t", watches: [], terminals: [], bgShells: [], ...thread } as ThreadView, surface: "drawer" }))
  // The verifier's drawer: the agent in probe and five rows there. Every one of them used to end in `probe`.
  const allInProbe = strip({ checkout: probe, bgShells: [shell({ checkout: probe }), shell({ id: "b", checkout: probe })], terminals: [term({ checkout: probe }), term({ id: "t2", checkout: probe, state: "exited", exitCode: 0 })] })
  assert.doesNotMatch(allInProbe, /data-process-checkout/)
  const allAtRoot = strip({ bgShells: [shell()], terminals: [term()] })
  assert.doesNotMatch(allAtRoot, /data-process-checkout/)
  // One row left behind in the project's own checkout is the one that speaks.
  const mixed = strip({ checkout: probe, bgShells: [shell({ checkout: probe }), shell({ id: "b", label: "left at root" })] })
  assert.equal(mixed.split("data-process-checkout=").length - 1, 1)
  assert.match(mixed, /data-process-checkout="root"/)
})

// WHO GIVES WAY (ThreadTerminals.tsx): the counter, then the hint WHOLE, then the label. The hint's glyph
// once stayed when its word went, and outranked the label at 390px while naming nothing.
test("at a narrow width the counter and then the whole hint give way before the label", () => {
  const probe = { dir: "/repo/.frizz/worktrees/probe", kind: "worktree" as const }
  const html = row(processes({ bgShells: [shell({ label: "Test watch in the probe worktree", budgetEndsAt: at("45") })] })[0]!, { here: probe, lines: 54 })
  const classOf = (marker: string) => new RegExp(`<span ${marker}[^>]*class="([^"]*)"`).exec(html)?.[1]?.split(" ") ?? []
  // The label's box has no width cap: it truncates only when the row cannot hold it.
  const identity = /<button[^>]*class="([^"]*)"/.exec(html)?.[1]?.split(" ") ?? []
  assert.ok(!identity.some((cls) => cls.startsWith("max-w-")), `identity: ${identity.join(" ")}`)
  // GIVE is sized from zero and grows only into what is left, one line tall and clipped, wrapping its items off
  // — and it reserves NOTHING: no minimum for a glyph that would outrank the label.
  const give = classOf("data-process-give")
  for (const cls of ["flex-1", "basis-0", "w-0", "min-w-0", "flex-wrap", "overflow-hidden", "h-[1lh]", "justify-end"]) assert.ok(give.includes(cls), `give: ${cls}`)
  assert.ok(!give.some((cls) => cls.startsWith("min-w-[")), `give reserves no width: ${give.join(" ")}`)
  // Its FIRST item is a zero-width strut (a flex line always keeps its first item), so the hint can wrap away.
  const inGive = html.slice(html.indexOf("data-process-give"))
  assert.match(inGive, /^data-process-give="true" class="[^"]*"><span aria-hidden="true" class="h-\[1lh\] w-0"><\/span><span data-process-checkout="root"/)
  // The hint is ONE unbreakable item — glyph, word, and the `·` to what follows — so it shows whole or not at all.
  const hintItem = /<span data-process-checkout="root" title="[^"]*" class="([^"]*)">([\s\S]*?)<\/span><span class="[^"]*text-muted-40"><span data-child-op-counter/.exec(inGive)
  assert.ok(hintItem, "the hint item, then the counter item")
  for (const cls of ["shrink-0", "whitespace-nowrap"]) assert.ok(hintItem![1]!.split(" ").includes(cls), `hint item: ${cls}`)
  assert.match(hintItem![2]!, /lucide-folder[\s\S]*>root<\/span><\/span><span aria-hidden="true" class="text-muted-25">·<\/span>$/)
  // The counter carries its own `·`; the budget and the age after it never give way, budget first.
  assert.match(inGive, /data-child-op-counter[^>]*>54 lines<\/span><span aria-hidden="true" class="text-muted-25">·<\/span><\/span><\/span>/)
  const fixed = html.slice(html.lastIndexOf('<span class="flex shrink-0 items-center gap-1 whitespace-nowrap text-muted-40">'))
  assert.ok(fixed.indexOf("data-child-op-budget") > 0 && fixed.indexOf("data-child-op-budget") < fixed.indexOf("Running for"), "budget, then age")
  assert.match(fixed, /^<span class="[^"]*"><span data-child-op-budget/, "no separator of its own to strand")
  // A row with no hint: the strut, then the counter.
  const plain = row(processes({ bgShells: [shell({ label: "Test watch", budgetEndsAt: at("45") })] })[0]!, { lines: 54 })
  assert.doesNotMatch(plain, /data-process-checkout/)
  assert.match(plain, /data-process-give[^>]*class="[^"]*"><span aria-hidden="true" class="h-\[1lh\] w-0"><\/span><span class="[^"]*text-muted-40"><span data-child-op-counter/)
  // Nothing after the hint (no counter, no reading): no `·` to strand.
  const bare = row({ ...processes({ bgShells: [shell({ startedAt: undefined as unknown as string })] })[0]!, startedAt: undefined }, { here: probe })
  assert.match(bare, />root<\/span><\/span><\/span><\/span><\/div>$/)
})

// THE CAPTION'S OWN RULE: the prompting terminal's row over its screen (TerminalPromptPane) is there to say WHICH
// terminal asks, and the attention-bordered screen right under it already says that it is asking — so its
// `waiting for input` gives way with the hint, before the command. It keeps its age, as every live row does.
test("a caption row's `waiting for input` gives way before its command; its age never does", () => {
  const started = new Date(Date.now() - 6 * 60_000 - 30_000).toISOString()
  const asking = processes({ terminals: [term({ awaitingInput: true, startedAt: started })] })[0]!
  const caption = renderToStaticMarkup(createElement(ProcessRow, { process: asking, slug: "t", caption: true }))
  const give = caption.slice(caption.indexOf("data-process-give"), caption.indexOf('<span class="flex shrink-0 items-center gap-1 whitespace-nowrap text-muted-40">'))
  assert.match(give, /<span data-process-state-text="true" class="text-attention">waiting for input<\/span><span aria-hidden="true" class="text-muted-25">·<\/span>/, "in GIVE, with its own `·`")
  assert.match(caption.slice(caption.lastIndexOf("whitespace-nowrap text-muted-40")), />6m</)
  // In a strip, the same terminal's state is a fixed reading, beside its age.
  const inStrip = row(asking)
  assert.doesNotMatch(inStrip.slice(inStrip.indexOf("data-process-give"), inStrip.lastIndexOf("whitespace-nowrap text-muted-40")), /waiting for input/)
  assert.match(inStrip, /text-attention">waiting for input<\/span><span aria-hidden="true" class="text-muted-25">·<\/span><span title="Running for 6m">6m</)
})

test("the tooltip says whose it is, what it runs, and where it runs", () => {
  const home = "/home/u"
  assert.equal(processTitle(processes({ terminals: [term({ cwd: "/home/u/repo" })] })[0]!, home), "Your terminal — npm run dev\n~/repo")
  // "Runs in": a running shell's folder is the OS's answer for where its process is now, not where it began.
  assert.equal(processTitle(processes({ bgShells: [shell({ cwd: "/home/u/repo" })] })[0]!, home), "Agent terminal — vite dev server\nRuns in ~/repo")
  assert.equal(processTitle(processes({ bgShells: [shell({ cwd: "/home/u/repo" })] })[0]!, home, true), "Agent terminal — vite dev server\nRuns in ~/repo\nWatched — this thread wakes when it finishes")
  assert.equal(processTitle(processes({ bgShells: [shell({ monitor: true, cwd: "/home/u/repo" })] })[0]!, home), "Agent monitor — vite dev server\nRuns in ~/repo")
  // The breathing mark says what it means, as the old SHELL row's quiet dot did in its title.
  assert.equal(processTitle(processes({ bgShells: [shell({ state: "stale", cwd: "/home/u/repo" })] })[0]!, home), `Agent terminal — vite dev server\n${QUIET_TITLE}\nRan in ~/repo`)
})

test("a card lists only live terminals; the drawer keeps your finished ones", () => {
  const thread = { id: "t", watches: [], bgShells: [shell()], terminals: [term({ id: "live" }), term({ id: "done", state: "exited", exitCode: 0, command: "git status" }), term({ id: "failed", state: "exited", exitCode: 2, command: "nub run typecheck" })] } as Pick<ThreadView, "id" | "terminals" | "bgShells" | "watches">
  const card = withQuery(createElement(ThreadProcessStrip, { thread, surface: "card" }))
  const drawer = withQuery(createElement(ThreadProcessStrip, { thread, surface: "drawer" }))
  assert.equal(card.split("data-process-row=").length - 1, 2, "the running terminal and the agent's shell")
  assert.doesNotMatch(card, /git status|typecheck/)
  assert.equal(drawer.split("data-process-row=").length - 1, 4)
  assert.match(drawer, /exit 2/)
  // …and the card gates its wrapper on the same rows, so a card with only finished runs draws nothing.
  assert.equal(cardProcesses({ terminals: [term({ state: "exited", exitCode: 0 })], bgShells: [] }, NOW).length, 0)
  assert.deepEqual(cardProcesses({ terminals: [term({ awaitingInput: true })], bgShells: [shell({ state: "stale" })] }, NOW).map((p) => p.state), ["quiet"], "a quiet shell is live; the prompt is its pane's caption, not a strip row")
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
  assert.match(prompt, />12m</, "a terminal at a prompt is live, and shows its age as its drawer does")
  assert.match(row(processes({ terminals: [term({ startedAt: started })] })[0]!), />12m</, "yours reads its age while it runs")
  assert.match(row(processes({ terminals: [term({ state: "exited", exitCode: 2 })] })[0]!), /text-\[color:var\(--gh-fg-danger\)\]">exit 2</)
})

test("a row that has just started reads its age at once, and never in seconds", () => {
  // Started AFTER the page clock's last 30s tick: the elapsed is negative against that reading. It used to
  // show no age at all until the next tick, then a seconds value frozen for 30s.
  const justNow = new Date(Date.now() + 5_000).toISOString()
  assert.match(row(processes({ bgShells: [shell({ startedAt: justNow, budgetEndsAt: new Date(Date.now() + 15 * 60_000).toISOString() })] })[0]!), /title="Running for &lt;1m">&lt;1m</)
  assert.match(row(processes({ terminals: [term({ startedAt: new Date(Date.now() - 24_000).toISOString() })] })[0]!), />&lt;1m</)
})

test("the sidebar mark counts both owners, and its tone says whose is running", () => {
  const mark = (thread: Pick<ThreadView, "terminals" | "bgShells">) => renderToStaticMarkup(createElement(ThreadTerminalMark, { thread }))
  assert.equal(mark({ bgShells: [] }), "", "nothing running, nothing drawn")
  const agentOnly = mark({ bgShells: [shell(), shell({ id: "b", label: "CI watch" })] })
  assert.match(agentOnly, /data-thread-terminal-mark="agent"/)
  // Running reads azure on every surface; dimmed, it is not yours. Grey was a finished terminal's tone.
  assert.match(agentOnly, /text-shell\/55/)
  assert.doesNotMatch(agentOnly, /text-muted/)
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
  // In QueueChildOps' column, after its AGENT / FLOW rows (it draws no shell rows of its own: one row per shell).
  assert.match(card, /<QueueChildOps[\s\S]{0,300}after=\{[\s\S]{0,120}data-queue-processes=\{thread\.id\}[\s\S]{0,120}<ThreadProcessStrip thread=\{thread\} surface="card"/)
  assert.match(card, /<TerminalPromptPane thread=\{thread\} onOpen=\{openProcess\} \/>/)
  assert.doesNotMatch(card, /QueueShellStrip|ThreadTerminalsStrip/, "no second strip for either owner")
  // A row opens the drawer only where the drawer stack is the card's own project's.
  assert.match(card, /const openProcess = \(process: ThreadProcess\) => \{\s+const here = focusedProject\(project\.slug\)\s+openInPlace\(project, thread\.id\)\s+if \(here\) openProcessDrawer\(thread\.id, process\)/)
  assert.match(card, /<ThreadProcessStrip[^>]*onOpen=\{openProcess\}/)
  // The meta line carries the checkout token between the time and the status, as the drawer header does.
  const meta = card.slice(card.indexOf("<LastActive"), card.indexOf("<ThreadStatusLine"))
  assert.match(meta, /<ThreadCheckoutToken checkout=\{thread\.checkout\} homeDir=\{project\.homeDir\}/)
})

// THE PROMPT'S CAPTION. The card shows the screen of the terminal that is asking; its row — the strip's own
// row anatomy — sits directly above that screen and says which terminal it is and where it runs, and the
// strip under the reply box does not list it a second time.
test("the card's prompt pane wears its terminal's row as its caption, and the strip skips that terminal", () => {
  const asking = term({ id: "ask", command: 'read -p "name? " x; echo $x', awaitingInput: true })
  const thread = { id: "t", watches: [], bgShells: [shell()], terminals: [asking, term({ id: "dev", command: "npm run dev" })] } as Pick<ThreadView, "id" | "terminals" | "bgShells" | "watches" | "checkout">
  const pane = withQuery(createElement(TerminalPromptPane, { thread, base: "/x" }))
  const caption = pane.indexOf('data-process-row="t:ask"')
  assert.ok(caption > -1, "the asking terminal's row is there")
  assert.ok(caption < pane.indexOf("data-terminal-prompt-pane"), "directly above its screen")
  assert.match(pane, /<button[^>]*aria-label="Open your terminal: read -p/)
  assert.match(pane, /text-attention">waiting for input</)
  const strip = withQuery(createElement(ThreadProcessStrip, { thread, surface: "card" }))
  assert.doesNotMatch(strip, /t:ask/, "not listed twice")
  assert.equal(strip.split("data-process-row=").length - 1, 2, "the other terminal and the agent's")
  // The drawer has no screen of its own, so there the asking terminal keeps its row in the strip.
  assert.match(withQuery(createElement(ThreadProcessStrip, { thread, surface: "drawer" })), /t:ask/)
  // A card whose only live terminal is the one asking draws no empty strip under its reply box.
  assert.equal(cardProcesses({ terminals: [asking], bgShells: [] }, NOW).length, 0)
  // No prompt, no pane and no caption.
  assert.equal(withQuery(createElement(TerminalPromptPane, { thread: { ...thread, terminals: [term()] }, base: "/x" })), "")
})

// THE FULLSCREEN RAIL'S TERMINAL ROWS read the strip's order (budget, then age) and carry its folder hint on
// its rule; they read `1m · 13m left` with no hint beside a strip reading `root · 13m left · 1m`.
test("the rail's terminal rows read the strip's order, and its folder hint", () => {
  const started = new Date(Date.now() - 12 * 60_000 - 30_000).toISOString()
  const probe = { dir: "/repo/.frizz/worktrees/probe", kind: "worktree" as const }
  const agent = processes({ bgShells: [shell({ startedAt: started, budgetEndsAt: new Date(Date.now() + 15 * 60_000 + 20_000).toISOString() })] })[0]!
  const where = processFolderHint(agent, probe)!
  const hint = createElement(FolderHintToken, { hint: where, title: folderHintTitle(where, "/repo", undefined) })
  const status = (html: string) => /data-wait-status[^>]*>([\s\S]*?)<\/span><svg/.exec(html)?.[1]?.replace(/<[^>]+>/g, "") ?? html
  const rail = renderToStaticMarkup(createElement(BgShellRow, { shell: agent.shell!, slug: "t", now: Date.now(), hint }))
  assert.match(rail, /data-process-checkout="root"/)
  assert.equal(status(rail), "15m left · 12m")
  const yours = renderToStaticMarkup(createElement(TermWaitRow, { terminal: term({ startedAt: started }), slug: "t", now: Date.now(), hint }))
  assert.match(yours, /data-process-checkout="root"/)
  assert.equal(status(yours), "12m")
  // No hint where the row runs where the header says.
  assert.doesNotMatch(renderToStaticMarkup(createElement(BgShellRow, { shell: agent.shell!, slug: "t", now: Date.now() })), /data-process-checkout/)
})

// THE RAIL'S HINT LEADS THE STATUS, as the strip's leads its readings. It was set in the shared status track
// (it narrowed every label in the group), then at the end of the name's track — which ends where the grid's
// widest status begins, so it floated ~120px left of its row's `49m` and still clipped the name beside a bare
// folder. The row now takes both tracks as one cell: name, the hint's zero-based box, status; the status keeps
// the grid's right edge, and the hint shows whole — glyph, word, `·` — or wraps away whole.
test("the rail's folder hint sits between the name and the status, and goes whole before the name gives way", () => {
  const where = processFolderHint(processes({ bgShells: [shell()] })[0]!, { dir: "/repo/.frizz/worktrees/probe", kind: "worktree" })!
  const hint = createElement(FolderHintToken, { hint: where, title: "t" })
  const html = renderToStaticMarkup(createElement(TermWaitRow, { terminal: term({ awaitingInput: true }), slug: "t", now: Date.now(), hint }))
  // One cell over the name and status tracks: the name, the hint's box, the status.
  assert.match(html, /<span class="col-span-2 flex min-w-0 items-baseline"><button[\s\S]*?<\/button><span data-process-give="true" class="[^"]*">[\s\S]*?<\/span><span data-wait-status="true" class="[^"]*"><span class="text-attention">waiting for input<\/span><\/span><\/span>/)
  const box = /<span data-process-give="true" class="([^"]*)"/.exec(html)?.[1]?.split(" ") ?? []
  for (const cls of ["w-0", "min-w-0", "flex-1", "basis-0", "flex-wrap", "h-[1lh]", "overflow-hidden", "justify-end", "items-baseline"]) assert.ok(box.includes(cls), `hint box: ${cls}`)
  assert.ok(!box.some((cls) => cls.startsWith("min-w-[")), "it reserves nothing for a glyph")
  // A zero-width text strut first (the line's keeper and its baseline), then the hint as ONE nowrap item.
  assert.match(html, /data-process-give="true" class="[^"]*"><span aria-hidden="true" class="w-0">\u200b<\/span><span data-process-checkout="root" title="t" class="([^"]*)"><span class="text-muted-60"><svg[^>]*class="[^"]*inline[^"]*align-baseline[^"]*"[\s\S]*?<\/svg><span data-process-checkout-word="true" class="[^"]*">root<\/span><\/span><span aria-hidden="true" class="text-muted-25">·<\/span><\/span><\/span>/)
  const item = /<span data-process-checkout="root" title="t" class="([^"]*)"/.exec(html)?.[1]?.split(" ") ?? []
  for (const cls of ["shrink-0", "whitespace-nowrap"]) assert.ok(item.includes(cls), `hint item: ${cls}`)
  // The status stays whole beside it; a row without a hint keeps the grid's own status track.
  const status = /<span data-wait-status="true" class="([^"]*)"/.exec(html)?.[1]?.split(" ") ?? []
  assert.ok(status.includes("shrink-0"))
  const plain = renderToStaticMarkup(createElement(TermWaitRow, { terminal: term(), slug: "t", now: Date.now() }))
  assert.doesNotMatch(plain, /col-span-2|data-process-give/)
})
