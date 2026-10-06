# The fork as a superset of upstream, plus a plugin system for the rest

Plan, 2026-10-06 (David). Fork `main` 3dee2230 vs `upstream/main` 0a3b9139.

**Goal.** Make this fork as close to a **pure superset** of colinhacks/frizz as possible, so its features can land in the
product instead of living on a branch forever. With every opt-in off, a user (or an agent) on the fork sees upstream exactly:
the same pages, URLs, names, defaults, queue rules, worker contract and tools. Everything the fork adds is either:

1. a **fix** upstream wants anyway, proposed on its own;
2. an **additive feature** that changes nothing until used;
3. **one opt-in** for the cross-project page, which cannot be a plugin because it is the page shell; or
4. a **plugin**, for anything that is taste rather than product (lazy threads, the fork's queue policy, …). Base gains only the
   seams.

The rule that keeps this from bloating: **a taste-level behavior becomes a plugin, not a setting.** Colin deletes settings,
even opt-in ones (7a04a275 demoted the sticky message to opt-in, then removed it). So base gains **one** settings value,
appended to a row that already exists.

The research behind every claim here, with file:line, sits in the planning thread's scratch directory: `principles.md`,
`ui-surface.md`, `server-surface.md`, `plugins.md`, `sidebar/sidebar-report.md` and `divergence/divergence-report.md`. Line
references below are to those trees as of the commits above.

---

## 1. Principles the default must keep

Each one is Colin's, cited from upstream. Today the fork breaks or re-defaults every one of them; the plan restores each as the
default.

| # | Principle | Upstream evidence | Fork today |
|---|---|---|---|
| P1 | One board is home. Cross-project means **awareness** (counts), not other projects' threads in view | ARCHITECTURE.md:3; 2498ad77 ("Frizz's home is one board — the grid is a page you go to, not furniture you sit beside"); a2c5e084 and a7cf4895 add counts without clicking in | All projects is `/` and the rail is deleted |
| P2 | Five **named** bands; Queue and Running can never be hidden | Sidebar.tsx:47-48 and :259 ("you can't hide your queue or your live work"); 45ce008e; mockup 25b30b5e merged Queue/Running and lost | Loud bands unnamed; a project fold hides in-flight work |
| P3 | His words are canonical: Queue, Running, board | ARCHITECTURE.md:133-137; AGENTS.md:158-169 | Ready/Working; "board" banned; ~146 of David's quotes read as "maintainer" |
| P4 | URLs are `/project/<slug>`, and `/` is the grid | ARCHITECTURE.md:172-194; singleton-frizz.md:131 rejected `/?project=` ("the pretty URL is the point") | `/?project=`, `/all/<slug>/…` |
| P5 | Frizz runs no model of its own | ARCHITECTURE.md:5 ("ZERO intelligence"); README.md:55 | Haiku one-shots for names, status lines, auto effort and schedule reading, on by default |
| P6 | The worker contract is mechanics only, and every token costs | cc-worker/DECISIONS.md 2026-08-03, 08-26 ("A capability nobody asked for, charged per turn, is an opinion"), 08-28; c4e6b767 cut the contract 19% | Claude contract +28% (53.1k → 68.1k chars), MCP tools 14 → 20, none gated |
| P7 | Few settings | 7a04a275, 8c9f7b3a, 743bfdb0, 6eb7b340 | Settings help entries double, 9 → 18 |
| P8 | Mouse-first; the keyboard is ⌘K, ⌘I and Esc | ARCHITECTURE.md:322-325 | Single-key `d`/`s`/… on by default |
| P9 | No pty | AGENTS.md:150-156; `src/package-contents.test.ts:86-87` pins node-pty absent | node-pty is a dependency; the pin is inverted |
| P10 | No git or worktree opinions | README.md:65 ("adds no worktrees"); c4e6b767; DECISIONS 2026-07-22 reverted a deny hook "as overkill" | Deny hook, worktree hooks, `removeWorktreesOnDone: true` |
| P11 | Docs state the present | 87165ed1; AGENTS.md:131-148 | ARCHITECTURE.md, README.md and the code disagree on the default view, band names, rail, worktrees |
| P12 | Full-snapshot SSE, lazy project activation | ARCHITECTURE.md:113; 6799f81a | A 3s `projectsQueues` poll and an idle prefetch of every board, always on |
| P13 | The phone board is his approved v2 | 6754e72a, 39db08a6 | MobileBoard deleted; PhonePage merges all projects |

**Where the fork has precedent on its side.** The project rail is Colin's own opt-in cross-project surface, and a2c5e084 shows
he wants every project's numbers without clicking in. The All-projects page is pitched as that rail's next setting, not as a
new philosophy. (`plans/singleton-frizz.md:113` calls a "cross-project queue" a benefit, but that line is an agent's prose, not
Colin's, so it carries no weight.)

---

## 2. Phase 0: hygiene before anything is proposed

No behavior changes. This phase is what makes the rest reviewable.

- **Re-attribute quotes.** Every `maintainer YYYY-MM-DD` quote the fork added is David's. Rewrite them as `David YYYY-MM-DD`
  so upstream's "maintainer" keeps meaning Colin. Mechanical: diff the fork's quote set against upstream's.
- **A docs pass** so ARCHITECTURE.md, README.md and AGENTS.md describe the fork as it is, then (after Phase 1) as the
  superset.
- **Delete finished experiments** (per the profile rule: record the conclusion, delete the harness):
  - `scripts/schedule-extract-eval.*` (4,463 + 435 lines): record its result in the schedules plan first.
  - Verify and seed scripts for retired surfaces: `verify-all-queues`, `verify-queue-stays-put`, `verify-one-view`,
    `verify-focus-mode`, `seed-everything-queue`, `verify-everything-queue`, `demo-standup`, `probe-hmr-*`. 43 fork-added
    scripts total 12,094 lines; keep only what a maintained test or release step runs.
  - `plans/` the fork added (~1,260 lines): keep the vscode plan if Colin will review the extension; fold the rest into
    commit messages.
- **Rename `command_thread` → `thread_terminal`** and drop its dead `queued_at`. It has never shipped upstream, so no
  migration is owed.
- **Drop duplicate fixes:**
  - `pending-call.ts` (164 + 83 test lines): restore upstream's `pendingCallDeadline` and pass awake time in.
  - The Monitor expiry duplicate.
  - 7c00c397, which equals upstream b89f6146.
- **Shrink the bash prefilter's evidence:** a corpus of ~100 lines instead of 1,000 (+462-line test), proposed on its own
  with its measured win (p50 85ms → 4.4ms per Bash call).
- **Small dedupes:** `isDirectory` ×4, `expandHome` ×3.

---

## 3. Phase 1: restore upstream's surface, verbatim, as the default

Restore upstream's files as they are wherever possible. Do not reimplement them. Besides removing the objection, this ends
the merge drag: 26 upstream commits edited files the fork deleted and had to be dropped or hand-ported, and conflict hunks
per daily merge grew 33 → 143 over the last five merges.

**Web: routes and launcher** (~12 files)
- Restore upstream's route table (U:routes.tsx:191-217): `/` is ProjectGrid; `/project/<slug>` with `/thread/<t>[/full]`
  and `/status/<s>`; unprefixed paths for the launching project.
- The launcher opens `/project/<own slug>` again (U:src/index.ts:778-786, plus `src/production.ts`).
- The server's `unknownProjectPage` accepts `/project/` again (U:index.ts:300-309).
- The fork's addresses redirect: `/?project=<slug>` and `?focus=` → `/project/<slug>`; `/?all` → `/all`.
  `retiredProjectHref` (pageView.ts:176) is inverted. The per-tab sessionStorage view goes away, because the path now names
  the view.

**Web: the board** (~9 restored files, ~11 shared modules edited, ~20 fixtures and e2e tests restored)
- Restore verbatim: TodosView, MobileBoard, StatusListView, ProjectGrid, StatusRow, upstream's `Sidebar()` and App's board
  body (U:App.tsx:235-360), plus `lib/{queueCollapse, queueLandingHold, sidebarScrollspy, sidebarPresence}`.
- The fork's ThreadRow additions (`scope`, `cardKey`, `band`, `held`, `open`, SubAgentCount, ScheduleMark) become
  **optional props**. When absent, upstream's rendering applies.
- Re-export the ~15 helpers the fork pruned from shared modules: `scrollToQueueCard`, `queueCardTargetY`,
  `useOptimisticallySteered`, `useOptimisticallyArchived`, `STATUS_CHIP`, `lastHumanTurnIndex`, `messageHasRenderableText`,
  `CopyTerminalCommandButton`, five `transcriptPagination` functions, `takeScrollAfterUnlock`, `projectIdentity`.
- App renders the fork's AllQueuesPage only under `/all` (Phase 2).

**Web: the rail** (~10 files)
- Restore `ProjectRail.tsx`, `lib/projectRail.ts`, the `projectRail` setting (default off, 4 places) and the
  `projectsRailCounts` RPC with its type, `railReorder.dropIndex` and upstream's 101-line test.
- Keep `projectsQueues` alongside it. It is additive.

**Names** (1 file plus text assertions)
- `BANDS.ready/working` labels go back to **Queue** / **Running**; keep the icons.
- "Board" comes back in docs and copy.
- The fork stops using Ready/Working anywhere, the opt-in page included: one vocabulary, Colin's.

**Drawer.** Restore RestartWorkerButton, ReloadPluginsButton and upstream's HeaderActions strip. The ⋯ menu keeps only the
fork's new verbs. Moving the strip into ⋯ goes to Colin as its own proposal.

**Web defaults** (~4 files)
- Snooze default back to `1d`, with the one-time migration dropped.
- `codeFiles` defaults to `editor`; the phone still uses the reader, as upstream does.
- The tab title is the repo label again; the favicon count stays (additive).
- Single-key shortcuts default **off**: only ⌘K, ⌘I and Esc are live until enabled. (Phase 4 moves the shortcut layer into a
  plugin.)

**Server defaults**
- `worktreeDir` unset by default, which makes the guard inert. Register WorktreeCreate/WorktreeRemove only when it is set.
  `removeWorktreesOnDone` defaults to false. Files: settings.ts, worktree.mjs, hooks.json, dispatch.ts, workerPrompt.ts.
- Home is listed only when `homeFolder` is set, and the slug `home` is reserved only then. Files: home-workspace.ts,
  project-registry.ts. `Project.workDir` stays an inert optional field.
- **node-pty becomes an `optionalDependency`.** It is already imported lazily, on a terminal's start only, and
  `thread-terminals.test.ts` enforces that. What still breaks Colin's rule is the hard dependency in the shipped manifest.
  As an optional dependency, upstream's `package-contents.test.ts:86-87` pin (no node-pty in the default install) passes
  unmodified, and a terminal on a box without it says why it can't start.
- The model calls (namer, status lines, live status, auto effort, schedule reading) sit behind one switch, **off**. With it
  off, `ctx.complete` is undefined (that path exists today), names come from the worker's own `title`, and the web falls back
  to its non-auto effort. Files: context.ts, settings, web dispatchPreferences.ts. The switch lives in the plugin that owns
  these features (Phase 4), so base gains no setting for it.
- The wake lock and the first-escalation deny note leave base and move into plugins (Phase 4).

**RPC and MCP compatibility**
- `forgetThread` stays as an alias of `deleteThread`.
- `spawn_thread` returns both the `@handle` and the `[title](/thread/slug)` link.
- The `title` tool's refusal of an already-named thread applies only when handles are on.
- `projectAdd` keeps the union return. It is a UX fix and the web already handles `added`; it goes to Colin as such.

---

## 4. Phase 2: the cross-project page, the one opt-in

**One value on Colin's existing settings row.** No new setting key: the row that switches the project rail becomes a
three-way choice, **Cross-project view: Off · Rail · All projects**, default **Off**. Only "All projects" turns on anything
below. Under the hood the existing `projectRail` key becomes a three-state value, accepting `true`/`false` as before. This is
the pitch: the rail's next step, opt-in, from the same row.

**Its own route.** `/all` and `/all/<slug>/thread/<t>[/full]`, a namespace upstream leaves free. With the opt-in on, `/` and
the launcher go to `/all`; with it off, `/all` still renders, unlinked.

**Its cost is paid only when on.** The 3s `projectsQueues` poll and the idle prefetch of every board run only while `/all` is
mounted. Later, feed it over SSE from the server's tenants instead of polling. With the opt-in off, no extra network or CPU.

### The active-thread guarantee, everywhere

**Focus mode is upstream's board, literally.** `/project/<slug>` renders upstream's `Sidebar()` (Phase 1), so focus mode has
exactly upstream's detail (U:Sidebar.tsx):
- the five groups: Pinned, Queue, Running, Snoozed, Done, plus External, which never reaches another band (96-104);
- labeled headers with counts;
- Pinned shown only when non-empty, oldest pin first, any state, Done greyed (244-258);
- Queue and Running each with its own header when non-empty, a rule between them, rest times on Queue rows (259-291);
- **never collapsible:** Pinned, Queue and Running render SectionHeader with no `onToggle`, a static div (381-404);
- Snoozed, Done (virtualized) and External collapsible and collapsed by default (U:store.ts:126);
- the reading marker (109-193).

The fork's ProjectSwitcher appears only as an optional `title` slot in StatusRow, and only when the opt-in is "All projects".
It navigates to `/project/<slug>` or `/all`, and ⌥↑/⌥↓ step through `/project/<next>`. The home crumb and owner/repo link
stay.

**All projects gets the same guarantee: a project fold hides only the quiet bands.** This is upstream's own rule, "you can't
hide your queue or your live work", applied per project.
- Pinned, Queue and Running rows always render; `collapsed` gates only Snoozed, Done, External and Schedules
  (ProjectList.tsx:580, 666-674).
- The fold control on the project row (ProjectList.tsx:810-823) toggles only those quiet bands, and the folded Working count
  goes away (922).
- **Restore band headers in All projects too:** each project group draws upstream's SectionHeader for Pinned, Queue and Running
  (static, with counts) instead of unlabeled rows. The fork's compact density comes from the project grouping, not from
  dropping names. This answers Colin's status-information objection directly: nothing upstream shows is missing from either
  view.
- **Fix the pinned-Done hole.** Today a pinned thread that is Done in another project is invisible in All projects:
  `projectsQueues` drops archived threads before the pin check (router.ts:5455-5458), and `loudBands` reads pins only from
  open lists (listBands.ts:56). Fix both, plus allQueues.ts:123-127.
- Rejected:
  - counts-only folds (a count says a thread exists, not which one, and today they omit Pinned);
  - a fold that keeps active rows as a separate state (the same rule with extra state).
- Cost: at Colin's load (17 projects, ~56 loud rows) the page scrolls instead of folding; narrowing to one project is focus
  mode, which is his own board.

**Scale, stated honestly.** At 1440x900, upstream's board fits 22 rows of one project, and so does focus mode. All projects
fits 11 rows + 6 project headers at Colin's load, and everything at David's (4 projects, ~10 threads). Neither design shows
70 threads at once. All projects is an extra lens, not a smaller one, and with the opt-in off nobody sees it.

### What attaches to which page

Re-point four helpers (`projectViewHref`, `homeHref`, `crossProjectHref`, `useOpenThreadInPlace`) at the restored URLs, and
most fork features need no call-site edits:

| Feature | Upstream-shaped base | `/all` |
|---|---|---|
| VS Code sidebar | upstream `Sidebar()` alone in embed mode; a Queue row opens its drawer | current SidebarPage at `/all?embed=vscode` |
| editor bridge (`lib/editorBridge.ts`) | re-pointed helpers; `projectsQueues` stays a machine-wide read | unchanged |
| Phone | upstream MobileBoard at `/project/<slug>` | PhonePage |
| Schedules UI | composer and drawer unchanged; Sidebar gets a collapsed Schedules header after External | count on the project row |
| Spinoff | a button in TodosView's header actions | unchanged |
| Mentions | re-pointed `projectViewHref` | unchanged |
| QuietTurnCard, AwaitingSubAgentsCard, process strip, cords, drag reorder, stable queue | not ported | `/all` only |
| Card keys | TodosView registers the cursor from the scrollspy `activeId` | unchanged |

VS Code embed URLs change to `/project/<slug>?embed=vscode` and `/all?embed=vscode` (packages/vscode/src/embed.ts:31-53,
app.ts:535).

---

## 5. Phase 3: the agent-facing surface, gated

The worker contract and the tool list are what every worker pays for on every turn, so Colin will look here first (P6).

- **Gate the worker prompt by section.** The prompt becomes a registry of sections, each tied to a feature. With every opt-in
  off, the rendered contract is byte-identical to upstream's, and a golden test proves it (§9).
  - **Feature-tied sections render only when their feature is on:** worktrees, 30-minute check-ins, shell budgets, goal limits,
    `@handle`/inter-thread messaging, editor, schedule, `external` with the 10-minute default, set-aside with `keep`.
  - **Generic guidance upstream likely wants goes to Colin as its own small PR,** each item with the failure that motivated it:
    answer the human's question in full prose, give a requested list in full, a human question outranks work in flight, run
    minutes-long gates in the background, stop shells no longer needed, stop critique loops when findings stop falling,
    exclude `.frizz/` from repo-wide lint.
  - **Style rules move to David's own `FRIZZ.md` or `~/.agents`,** not the contract: bolded-verb bullets, one-sentence done
    cards.
- **Gate MCP tools by capability.** `tools/list` shows a tool only when its feature is on: `editor` only while an extension is
  connected; `schedule`, `read_thread`/`message_thread`, `keep` and `extend_shell` only with their features. The server
  already advertises `__procedures`, so frizz-mcp can read capabilities from it. With everything off, the tool list equals
  upstream's 14.
- **The question placement marker** stays rendered as upstream restored it on 09-11. Retiring it is a decision for Colin
  (§8).

---

## 6. Phase 4: the plugin system

Some fork features will not make the cut for base, and shouldn't have to. A plugin system lets David layer them on base
without forking. It has to be small enough for Colin to accept: **~600 lines in base** enable lazy threads, quota alerts, the
wake lock and delete-old-threads. In base those four would cost ~1,150 lines plus tests, and schedules alone is ~6.4k.

**Not plugins:** All projects, the phone layout, Home and remote access. They are the page shell, the launcher or the project
model, and a slot able to replace the shell would make all of the web internals the plugin API. Those stay in base, settled
by §4.

### Shape

```
<data>/user-plugins/<id>/package.json
  { "type": "module",
    "frizzPlugin": { "id", "api": 1, "server": "./server.ts", "web": "./web.ts", "claude": "./claude" } }
```

- **Location:** `<data>` comes from `frizzPaths`. Not `<data>/plugins`: on a legacy install that is the cc-worker staging root
  (`stable-plugin-path.ts:26-28`).
- **Machine-wide only:** never loaded from a project checkout.
- **Enabled by being present:** `plugins.disabled[]` in machine config turns one off, and `FRIZZ_PLUGINS_OFF=1` is safe mode.
- **Manifest:** mirrors `frizzServer` in `packages/server-release/package.json`. The server reads it without running plugin
  code.

### Loading (no build step, so the stable-artifact model is untouched)

- **Server half:** `await import()` of `.ts` on Node's own type stripping. Below Node 22.18 the plugin reports what it needs
  and boot continues.
- **No runtime imports.** Plugins use only `import type { … } from "frizz-server/plugin"`, which is erased at load. Every
  value comes through a `host` argument, so module identity never matters across the bundled `dist/dev-child.js`.
- **Web half:** the server serves `/_frizz/plugins/<id>/*.ts` through `module.stripTypeScriptTypes`, with `?v=<content hash>`.
  The page does `import()` and calls `activate(host)`.
  - The host supplies React, `h`, the RPC caller, board hooks and a small UI kit. One React, no import map, and nothing inside
    the immutable `web-dist`.
  - Authors write `h(...)` or ship a prebuilt `web.js`, since stripping does no JSX.
- **Clients:** the desktop app and the VS Code embed load the same origin, so they get plugins for free.

### API v1 (all optional)

```ts
server: { machine?(host), project?(host) } → {
  procedures?: Record<string, Proc>            // mounted as plugin.<id>.<name>; human:true joins HUMAN_THREAD_ACTS
  threadView?(view, row): ThreadView            // sync, cheap; writes view.plugins[id]
  queuePolicy?: Partial<QueuePolicy>            // see below
  onSend?(row, message): Promise<void>          // only for rows this plugin holds
  on?: { threadDone, threadDeleted, humanAct, rest }
  tick?(nowMs)                                  // generalizes scheduledThreads {evalDue, drain}
  mcpTools?: ToolDef[]                          // listed as <id>_<tool>; frizz-mcp forwards unknown names
  systemPrompt?(kind): string | null            // a gated contract section
  beforeDispatch?(input): input
}
host: log, settings (machine-config record "plugin:<id>", plugin's zod schema), db() (<data>/plugin-data/<id>.db,
      own PRAGMA user_version migrations), every/after (rejection-safe timers),
      threads.{ create({ hold }), start(row, prompt), delete }, boards() read-only
web activate(host) → { slots: { "queue.head", "settings.section", "thread.menu", "newThread.submitAlt", "thread.composer" },
                       commands }
```

A plugin's `claude/` directory is appended to the SDK's `plugins` array (`claude-agent-sdk.ts:1027`).

**The QueuePolicy seam is how the fork's queue rules leave base.** These rules change, for everyone, which band a thread is in
and when it queues:
- queue order by arrival (`queuedAt`) plus the 12s settle;
- a turn quiet for 15 awake-minutes joins the queue;
- an honoured PR park goes under Snoozed;
- `parkExcuses`;
- a Done thread stays Done while its worker runs;
- the 60s sign-off nudge excusal and the reply-wait hold.

`deriveNeedsYou`'s excusals and enqueuers, the shared band predicates and a `queueOrderKey(thread)` become one object.
Upstream's object is the default, and David's `queue-policy` plugin registers the fork's rules. The same applies to the
scheduler: a WakeSource registry (`{evaluate, classify, interrupts?, merge?}`, precedent `deps.scheduledThreads.evalDue`) lets
these plug in as sources:
- SOURCE 13, shell budgets;
- SOURCE 14, the stray-shell nudge;
- goal limits;
- the 10-minute question default;
- set-aside;
- the 30-minute agent check-in.

**Error isolation.**
- **Server hooks:** each hook runs through `guard(id, hook, fn, fallback)`. Three throws mark the plugin failed for the
  process, shown in Settings → Plugins.
- **Setup:** bounded at 5s; a failure is reported and the server keeps serving, the `startProducers` rule.
- **Web slots:** each slot gets its own error boundary.
- **Residual risk:** a throw from a plugin's own `setTimeout` still exits the child (`dev-child.ts:21-25`), so host timers are
  the documented path.

**Security.** Plugins are the user's own code with the user's privileges. No sandbox, no signing, no capability model. The
guardrails worth having:
- the machine-only directory;
- plugin RPC and HTTP only under `/_frizz/…`, behind the existing loopback/CSRF and remote sign-in gates;
- a read-only Settings → Plugins list of each plugin's procedures, MCP tools (auto-approved in every worker) and Claude Code
  hooks;
- the kill switch.

### Worked example: lazy threads

**Base keeps one generic primitive, the held thread.** It is a session row with `held_by = <plugin id>`, replacing
`lazy_prompt` (`storage.ts:280,1720`). Base owns:
- the tailer skip (`tailer.ts:5698`) and the empty transcript (`transcript.ts:4971`);
- `dispatch(…, {onto: row})` (today's `opts.lazy`, `dispatch.ts:797,992-1013`);
- `threads.create({hold})` (today's `createLazyThread`, `dispatch.ts:1245-1291`);
- the single-flight start (`lazy-start.ts`);
- generic held rendering ("Not started yet.").

A follow-up on a held row calls the holder's `onSend`. With no holder it starts the thread on the message, so uninstalling a
plugin never strands a thread. **Base does not queue a held row**, which honours upstream's rule that "with no agent it makes
no sense for a thread to ever show up inside the queue" (`shared/index.ts:4597`). That rule is exactly why lazy threads are a
plugin.

The `lazy` plugin holds the rest:
- a `lazy_note` table;
- `create`/`update`/`start` procedures (from `router.ts:2784-2806`);
- a `threadView` that queues its rows;
- `onSend`, which starts the thread and drops the note;
- `LazyThreadBox`, moved whole into the `thread.composer` slot;
- the snail button and ⌘⇧⏎ in `newThread.submitAlt`, replacing `Composer.tsx:1625-1640`.

Schedules' pending run becomes a row held by `schedules`.

### Where each fork feature lands

| Feature | Lands as |
|---|---|
| Fixes (§7) | upstream PRs, first |
| VS Code extension package + server editor bridge | base PR (it is separate today: 70 files, talks through two shared protocol files) |
| Spinoff | base PR, after the legacy side-turn path (1,533 of its 2,821 server lines) is cut |
| Schedules | plugin (phase 5 of the seams), or base if Colin wants it; it needs `tick`, MCP, prompt fragment and drawer slot either way |
| Thread terminals | base if Colin accepts node-pty as optional, else plugin (WS route seam) |
| All projects | base, behind the one opt-in (§4) |
| Lazy threads | plugin |
| Fork queue policy and scheduler sources | `queue-policy` plugin |
| Model calls (namer, status lines, auto effort, schedule reading) | `ai-assist` plugin over an optional `ctx.completer` seam |
| Quota alert, wake lock, delete-old-threads, first-escalation note | plugins |
| Worktree guard and cleanup | plugin (Claude Code hooks dir + `systemPrompt` + `threadDone`) |
| Keyboard shortcut layer | plugin (`commands` + the existing `data-command` contract) |
| Fable fallback, auto effort | plugin (`beforeDispatch`) |

### Seam phasing (best features enabled per base line first)

| Step | Seams | Base lines | Enables |
|---|---|---|---|
| 1 | loader, guard, static serving, `queue.head`, machine setup | ~330 | quota alert, wake lock |
| 2 | RPC namespace, plugin settings record + section, events | ~110 | delete-old-threads, worktree cleanup |
| 3 | Claude Code dirs, `systemPrompt` | ~30 | worktree guard |
| 4 | held threads, `threadView`, two composer slots, db | ~150 | lazy threads |
| 5 | QueuePolicy, WakeSource registry | grows as rules move | fork queue policy, scheduler sources |
| 6 | `tick`, MCP proxy, palette/drawer slots | ~100 | schedules |
| 7 | `commands`, `beforeDispatch`, machine WS routes | ~105 | keyboard, Fable fallback, VS Code bridge, terminals |

---

## 7. Phase 5: the upstream sequence

The order PRs go to Colin. Each is small, names the bug or need it answers, and touches no structural code.

1. **Fixes with no fork dependencies, which apply cleanly to upstream/main:**
   - 109af220 + 32da3a5c: an approval card auto-denies after 5m instead of freezing the turn, and survives a restart.
   - 5dfc85ef: one slow project no longer blocks boot.
   - 1734e48d: the session cache is no longer dropped by unrelated writes.
   - 20c498c3: the PATH walk moves off the event loop.
   - 6f731c87: symlink removal on Node 25.0–25.3.
   - d89d3729: MCP connection drops during a restart.
   - 4ac1422a: another Claude session's message no longer shows as the operator's.
   - 5efbd4fd: bypass-mode permission rule.
   - 39541d53: duplicate wake when a shell finishes.
   - 11f327a0: a worktree thread's edited files are read from the worktree.
   - 8459cf6f: the relay never answers 304.
   - 64e78b5c: 10s false failure on `xdg-open`.
2. **The same, with 1–2 conflict hunks:**
   - 303d6273: a second interrupt no longer kills the follow-up turn.
   - 8e6a0ddb: the Node 25 symlink bug elsewhere.
   - add52ad1: a prose-only reply no longer cancels a done.
3. **Small ports:**
   - 0609f501 + 7a1e60df: a reused PID read as a live daemon can SIGTERM an unrelated process. Check overlap with upstream
     88f468d8 first.
   - 722a566d: a worker inherits the human's `$EDITOR`.
   - From the server audit: awake-time sub-agent staleness, the stray `~/.frizz` data-root guard, follow-up dedupe, the board
     falling back to its periodic rebuild when `.frizz` watching fails, and the sign-off nudge exclusions.
4. **The generic worker-contract guidance** (§5), one item per PR.
5. **The plugin loader** (seam step 1) with quota alert as its first plugin, proving the shape on something small.
6. **The VS Code extension + editor bridge** (`isHomeWorkspace` becomes an optional field), focus-mode embed only.
7. **The cross-project opt-in** (§4) as a design proposal first, then code.
8. **Remaining seams,** in the phasing order.

From here on, a soundness fix lands first on a branch off `upstream/main` and is then merged into the fork, never the other way
around.

---

## 8. Anticipated objections, and the answer in this plan

Ranked by how likely Colin is to raise each, from his own decision log and commit history.

| # | Objection | His evidence | Neutralized by |
|---|---|---|---|
| 1 | "All projects violates Frizz's principles" | 2498ad77; P1 | Off by default, from his own rail row (§4); focus mode is his board verbatim |
| 2 | "Status information is lost" | P2; 5 rails | Named, never-collapsible Pinned/Queue/Running in both views; folds hide only quiet bands; pinned-Done fixed (§4) |
| 3 | "Every worker pays for your tools and rules" | P6; DECISIONS 2026-08-26 | Gated prompt sections and tool list; byte-identical contract and 14 tools with everything off (§5, §9) |
| 4 | "Frizz now calls models" | P5 | No model calls in base; `ai-assist` plugin over an optional completer (§3, §6) |
| 5 | "The pty is back" | P9 | node-pty optional (it is already lazily imported); his guard test passes unmodified; no agent or sign-in path touches it (§3) |
| 6 | "You deleted my views and URLs" | P4, P13 | Restored verbatim; `/all` is additive; fork addresses redirect (§3) |
| 7 | "You renamed my words / my quotes aren't mine" | P3 | Queue/Running/board everywhere; quotes re-attributed to David (§2, §3) |
| 8 | "Settings proliferation" | P7 | Base gains one value on an existing row; taste lives in plugins with their own settings (§4, §6) |
| 9 | "Queue semantics changed under me" | ARCHITECTURE.md:121, 126; his 2026-07-22 PR-watcher rule | Upstream's QueuePolicy is the default; the fork's rules are a plugin; real fixes (e.g. arrival order, if he agrees) are argued one at a time (§6) |
| 10 | "Git/worktree opinions" | P10 | Guard inert unless `worktreeDir` is set; cleanup off; the whole thing is a plugin (§3, §6) |
| 11 | "Keyboard layer" | P8 | Off by default, then a plugin (§3, §6) |
| 12 | "Docs contradict the code" | P11 | Phase 0 docs pass, repeated after each phase |
| 13 | "Test and script weight" | ARCHITECTURE.md:294 ("minimal + contract-shaped") | Experiment harnesses deleted; tests ship with their feature's PR (§2) |
| 14 | "Performance at my load" | P12 | Poll and prefetch only while `/all` is mounted; SSE later (§4) |
| 15 | "A plugin system is bloat" | P7 spirit | ~600 lines replace ~1,150 in base for four features (and ~6.4k for schedules); no sandbox, no build step, no new dependency (§6) |
| 16 | "Home workspace breaks 'real root repo directories only'" | singleton-frizz.md:10 | Listed only when `homeFolder` is set (§3) |

### Decisions that are Colin's, to raise with him rather than gate

- **Arrival-order queue (`queuedAt`) as a fix, versus a policy plugin.** The fork's argument: rest-time order reshuffles the
  queue whenever a thread re-rests.
- **PR parks under Snoozed.** This reverses his 2026-07-22 rule that a PR watcher must never vanish into the dimmed band. It
  is flagged explicitly and lives in the policy plugin unless he changes his mind.
- **The question placement marker:** keep it (upstream) or retire it (fork).
- **Moving the drawer strip into ⋯.**
- **node-pty and terminals in base, or as a plugin.**
- **Whether a held thread is acceptable as a base primitive.** His `planned` doc threads are the same idea without a session.
- **The word "plugin".** It already means Claude Code plugins in the UI ("Reload plugins") and in `FRIZZ_WORKER_PLUGIN_DIR`.

---

## 9. How "superset" is verified, mechanically

A claim of "no change with opt-ins off" needs a test that would fail if it were false.

1. **Upstream's tests against the fork.** Check out `upstream/main`'s test files over the fork tree and run them with default
   settings. Every upstream test passes, or the failure is on a list of fixes argued in §7. This is the single strongest
   gate, and it should run daily, alongside the upstream merge.
2. **Contract golden.** With every feature off, the rendered Claude and Codex worker prompts are byte-identical to upstream's
   goldens, and `tools/list` returns upstream's 14 tools.
3. **Route table.** Every upstream URL resolves to the same view; `/all` exists; the fork's old addresses redirect.
4. **Restored files diff.** For each file Phase 1 restores, `git diff upstream/main -- <file>` is empty or limited to the
   optional-prop additions listed above.
5. **Settings.** The settings help table with nothing enabled equals upstream's 9 entries, plus Plugins once seam step 1 lands.

---

## 10. Order of work and what each phase touches

| Phase | Touches | Risk | Needs Colin |
|---|---|---|---|
| 0 hygiene | docs, scripts, quotes, one table rename, duplicate fixes | low | no |
| 1 restore upstream surface | ~45 web files, ~10 server files, ~20 restored tests and fixtures | medium: shared-module drift from the pruned helpers needs a real compile | no |
| 2 cross-project opt-in | routes, ProjectList, AllQueues, router `projectsQueues`, settings row | low | as a proposal |
| 3 contract and tools gated | workerPrompt, frizz-mcp, goldens | medium: goldens must match exactly | the generic-guidance PRs |
| 4 plugin seams, then plugins | ~600 base lines, then moving fork features out of base | medium: the QueuePolicy extraction touches `deriveNeedsYou` and the band predicates | the loader PR, the held-thread primitive, the name |
| 5 upstream PRs | per §7 | low per PR | yes |

Phases 0–3 change only the fork, so David's daily experience is unchanged once "All projects" is chosen and his plugins are
installed. Each phase lowers the daily merge cost, because the fork stops deleting and rewriting upstream files.
