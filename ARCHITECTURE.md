# frizz architecture (read this before touching any package)

frizz is a machine-wide orchestration surface: a localhost server + web client (a browser tab by
default) showing ONE page in two views — one project's board at `/project/<slug>`, the default, or All
projects at `/all`, with every project on the machine down the left with its threads and every card
waiting on a human beside them — and the thread you open in a drawer beside either. A bare `/` goes back
to whichever of the two this browser showed last.
The UI has ZERO intelligence: all orchestration wisdom lives in the user-editable dispatch preamble
(settings), in the repo's own `FRIZZ.md`, and in the worker plugin (`cc-worker/`). The few model calls
Frizz makes on its own run on the operator's Claude sign-in behind one switch (see **Background
summaries** under Invariants). The original plan: `plans/standalone-ui.md`.

## Repo layout

**The repo root IS the published `frizz` package** — root `package.json` is the manifest, `src/` is
the launcher, the publish runs from the root, and the root `README.md` is the npmjs.com page.
**Releases publish from the `release` branch, not from main** (since 2026-09-08): main says a change
landed, `release` says it was verified and chosen to ship, and only the second one is ever released by
[`release.yml`](.github/workflows/release.yml). The branch is a fast-forward pointer into main with no
commits of its own — you move it to the tested sha. Moving it selects the commit but starts nothing:
since 2026-09-23 the workflow runs on `workflow_dispatch` alone, so a version bump on main stays inert
until a maintainer runs `gh workflow run release.yml --ref release`.
Full procedure in [plans/runtime-pin-bumps.md](plans/runtime-pin-bumps.md).

| Path | What it is |
| --- | --- |
| [`src/`](src/) | The `frizz` launcher itself — artifact build/promote/verify, port + lock, browser launch. |
| [`packages/`](packages/) | The app workspace — `shared`, `rpc`, `server`, `web`, `desktop`, `vscode` (see **Packages** below). |
| [`board/`](board/) | The zero-dep `.frizz/` board parser + thread writer. The server SHELLS OUT to it; never re-implement it. |
| [`cc-worker/`](cc-worker/) | The Claude Code plugin every dispatched agent loads: worker contract seed, sub-agent profiles, hooks. |
| [`plugins/`](plugins/) | Frizz plugins shipped from this repo (`lazy`, the first), and `install.ts`, which links one into the data directory. |
| [`monitors/`](monitors/) | Portable CI/PR/review watchers, synced into `cc-worker/skills/gh/scripts/`. |
| [`scripts/`](scripts/) | Packaging (`prepare-package.mjs`, `build-*.mjs`) + dev tooling (`seed-*`, `verify-*`, `shot.mjs`). |

`board/` used to be `cc/scripts/frizz/` — `cc/` was the Claude Code **plugin** port back when frizz
itself shipped as an agent plugin rather than an app. The plugin is retired; the parser is not.

## Developing frizz

```sh
nub install
nub run frizz-dev:install     # one-time: ~/.local/bin/frizz-dev -> this checkout's launcher source
```

Then from any Git repo: `frizz-dev` (foreground; Ctrl-C stops only that workspace's server).
`frizz-dev /path/to/repo` selects a repository, `--no-app` prints the URL instead of opening a browser,
`--app` opts into the legacy dedicated window, `--status` reports workspace/port/supervisor PID, and
`--stop` stops the UI server while agent processes survive. `frizz-dev:check` verifies the shim
without changing it; `frizz-dev:uninstall` removes only that owned shim. Use
`FRIZZ_BIN_DIR=/another/bin` to install elsewhere.

### Readout and logs

A TTY launch repaints a step list while booting and settles into a static block naming the address,
the project, and this run's log. It repaints only during the boot — once that block prints, nothing
touches the cursor again, so a stray write can never land on a live region.

Under that block the launcher APPENDS one timestamped line per lifecycle beat — Restart Frizz, Update Frizz, a control-plane crash, and the recovery that follows each. Appending keeps the no-repaint rule above intact. The supervisor raises these through `onActivity` (`SupervisorActivity` in `dev-supervisor.ts`), which every transition reaches through `writeStatus`, so a path added later announces itself without being wired up again; `renderSupervisorActivity` in `src/readout.ts` turns one into a row. Beats are suppressed until the first boot settles, because until then the readout owns the terminal. A launcher that re-execs itself for an update — `frizz-dev` keeps its pid and its tty across the handoff — builds a `noticeOnlyReadout` instead, or the generation that took over would be mute for the rest of the session. The registry launcher does the same on a Node that has `process.execve` (22.15+ / 23.11+, which is why that is the floor). Where there is none — Windows — it starts the successor detached with its stdio closed, holds on until that successor answers the status route with the new version (a successor that exits first or never answers is a failed update, and the old board is restored), and only then prints a farewell naming the new version and `frizz --stop` and exits; `frizz --stop` and `frizz --status` are real flags on that launcher since 2026-09-11.

Every process writes the complete feed to `<stateDir>/logs/frizz-<timestamp>-<pid>.log`, one file per
run, with `logs/latest.log` pointing at the newest. The launcher passes that path down in
`FRIZZ_LOG_FILE`, so the supervisor and the forked control-plane child append to the SAME file — they
share the file, not a writer, and O_APPEND makes each short write atomic. That is what lets the child
stay silent on a terminal the launcher is repainting without losing anything it had to say.
Retention keeps 20 runs and nothing older than 14 days; a single file stops at 32 MB.
`FRIZZ_LOG_PATH` overrides the location (a directory or an exact `.log` file).

`--debug` streams that same feed to the terminal instead of the compact readout, in every process at
once — the launcher sets `FRIZZ_DEBUG` in the child environment, since the child never sees the
command line. Ctrl-C and a failed boot both print the log path.

Gates: `pnpm run typecheck` and `pnpm test`. CI (`.github/workflows/ci.yml`) runs only the checks that
need no install or provider CLI; the full suite is local-only by design.

The suite runs through `scripts/run-tests.mjs` rather than calling node's runner directly, because a
green run has to prove the whole run happened. `--test-force-exit` is load-bearing here — without it
`claude-agent-broker.test.ts` leaks a handle and hangs forever — but it also makes each per-file child
`process.exit()` while verdicts are still queued on the pipe carrying them to the parent, which drops
them with no failure and no non-zero exit ([nodejs/node#64833](https://github.com/nodejs/node/issues/64833),
still open; measured here 2026-08-16 as a run that silently lost 31 of one file's 70 tests). So the
runner is wrapped: every child puts its report pipe in blocking mode and tallies the verdicts it
emits, and the wrapper refuses to report success unless that tally matches what reached the parent.
Invoking `nub --test` by hand is fine for one file, but it bypasses that check.

The browser files (`*.e2e.test.ts`) each gate on their own env var and skip in that suite; `nub run test:e2e`
(`scripts/e2e-web.mjs`) runs the ones a Vite over the fixtures can serve, one browser at a time, and names
the rest (`NEEDS_REAL_STACK`), whose headers give their stack. One of those gates a product claim rather than
a component: `packages/web/src/capacityParity.e2e.test.ts` boots, seeds and tears down its own three stacks
and fails if All projects (`/all`) at Colin's load (17 projects, 70 open threads), or a project's board,
shows less without scrolling than upstream's board does, with the project rail off or on —
`FRIZZ_CAPACITY_E2E=1 nub run test packages/web/src/capacityParity.e2e.test.ts`.

## Invariants

- **THERE IS NO TMUX. Agents run as detached broker daemons.** A Claude thread is
  `claude_runtime="broker"`, forked by `claude-broker-host.ts` with `detached: true` into its own
  process group, which is exactly why Ctrl-C on the server does not reach it and why a turn survives
  a restart. `packages/server/src/tmux.ts` has not existed since 2026-08-02, and nothing execs,
  spawns or imports tmux. The old vocabulary outlived the transport for weeks and had every reader
  re-deriving the wrong answer from it, so it was swept out on 2026-08-19: the session column is
  `thread_name` (the thread identity string `frizz-<slug>`, never a pane name), the launch variable
  is gone, and no seed or verify script opens a pane. One reference survives on purpose —
  `isTmuxServer` in `orphan-reaper.ts` refuses to reap a tmux server left behind by a pre-cutover
  Frizz. Anything else still saying tmux outside `plans/` is a miss; prefer `git log -S` over
  believing it.
- **One server, every project.** A SINGLETON: one server on one origin serves every project on the
  machine, each named by a URL prefix. It was one server per repo until 2026-08; if you find a
  statement to that effect anywhere, it is stale. See "URL shape (one server, every project)" below —
  that section is load-bearing, and most bugs in this area come from carrying the old model forward.
- **Frizz files are the source of truth for thread status.** The server imports the board logic
  from `../../board/*.mjs` (zero-dep, plain node) — NEVER duplicate the parser. Writes
  to thread files go through the same code paths as `frizz-update` (import `thread-update.mjs`
  helpers), never hand-rolled markdown edits.
- **Session JSONL (`~/.claude/projects/<slug>/<session-id>.jsonl`) is telemetry only** —
  liveness, previews. Parse defensively; on schema surprise degrade to "unknown", never crash,
  never let correctness depend on it.
- **Agents are headless processes frizz owns over a pipe**, spawned with a pinned
  `--session-id <uuid>`: a Claude thread runs in the session BROKER (a detached daemon holding one
  Agent SDK session, reached over a unix socket or, on Windows, a named pipe), and a Codex thread in
  the app-server. There is no multiplexer, no pane and no terminal transport: provider sign-in is a
  command the human runs in their own terminal (the sign-in modal shows it), not a CLI Frizz hosts.
- **An idle thread's daemon is HIBERNATED, and that is not a stop.** A resting worker costs ~504 MB (measured 2026-08-19: the `claude` CLI 289 MB, a chrome-devtools MCP pair 159 MB, the broker daemon 39 MB, the frizz MCP server 17 MB), and 38 idle threads held 19 GB. That browser was Frizz's own always-on mount, dropped 2026-08-26 — Frizz injects only the `frizz` MCP server now, so a thread in a project that brings no browser of its own rests nearer ~345 MB, and one whose `.mcp.json` mounts chrome-devtools is back at the measured figure only once it has called one of its tools: since 2026-10-05 the broker daemon starts a project's stdio MCP servers on first use, not at boot (`lazy-mcp-host.ts`; `FRIZZ_LAZY_MCP_OFF=1` restores the eager start). So `thread-hibernation.ts` sweeps every 5 minutes and retires the daemon of any broker thread that has rested past the 60-minute prompt-cache TTL with nothing outstanding; the next input cold-resumes it from the on-disk transcript, and above the TTL that resume costs no extra tokens because the cache is already gone. **A hibernated thread is still an ordinary Rested queue row** — same `turn-idle` runtime, same rest time, same card — because the predicate refuses any thread whose dead daemon would change what the board draws. It fails CLOSED on every unknown, and the list of refusals is the point: no telemetry, no transcript, a turn in flight, a pending approval or ask, ANY direct sub-agent (including `stale` and `rested`, unlike the Mark-as-done gate), any background shell, any undelivered send, a daemon under 5 minutes old. `FRIZZ_HIBERNATE_OFF=1` disables it; `FRIZZ_HIBERNATE_IDLE_MINUTES` moves the threshold. Codex is deliberately excluded — one app-server daemon serves every codex thread, so there is no per-thread process to reclaim.
- **A thread can run an OLDER edition of its own model family.** Frizz dispatches on the family alias (`opus`) and the pinned runtime resolves it, so a pin bump that moves the alias (Claude Code 2.1.280 took `opus` from Opus 5 to Opus 5.5) reaches only daemons forked after it — a live daemon keeps the `claude` binary it was forked with, and the row says `opus` either way. The board reads the edition a worker RUNS off its transcript's model id (`runningModelLabel`, "Opus 5") and compares it with the pin's catalogue (`claude-models.ts`, `modelUpgrade`: "Opus 5.5", `staged` when no live daemon holds the old one). The composer's model picker names the running edition and offers a one-click upgrade (`upgradeThreadModel`), which retires the idle daemon so the next turn forks from the current pin; and the first input delivered to an idle thread after a compaction newer than both its daemon and this server takes a fresh process on its own. Both refuse on the hibernation predicate minus its two memory gates — a turn, sub-agent, shell, approval or undelivered send holds them off (`claude-model-upgrade.ts`).
- **A teardown frizz CHOSE is never reported as a crash.** `attach` reports a death whenever a resume has to cold-start, because that is normally the only way frizz learns a daemon died unobserved — but a permission-mode change, a model upgrade, a usage-limit resume and hibernation all end in exactly that cold start. `killBroker(stateDir, sessionId, reason)` leaves a one-shot `<key>.retired` mark beside the broker record, stamped with the dying daemon's `generation`; the next cold fork consumes it and suppresses the report only when the exit record's generation matches. Genuine crash detection is untouched — an unmarked teardown still reports, which is what the negative control in `claude-agent-broker-bridge.test.ts` pins.
- **One daemon per session, and a follow-up succeeds only for a message the daemon took.** Cold resume is SINGLE-FLIGHT per session in the bridge (`attachOnce`): every caller that needs a daemon while an attach is running awaits that attach. Without it, a hibernated thread whose operator answered its questions took two inputs in one instant (the waker's answers and the operator's send), and each forked a daemon on the same socket path (2026-09-30, `we-ve-got-to-start-working`). The input frame is ACKNOWLEDGED (`input-ack-v1`): `followUp` resolves on the daemon's `input-result`, or — for a daemon forked by an older build — once the frame is written to a connected socket, and throws otherwise, so the router never records `delivered` for a frame buffered into a socket that never came back. A daemon closes its listener only while the socket path still leads to it (closing a unix-socket server unlinks its PATH, whoever owns that file now), and an unattached daemon whose socket file is gone self-collects (`self-collected-socket-lost`). `scripts/verify-broker-resume-race.mjs` reproduces all three against a real daemon.
- **Frizz's own model calls sit behind ONE switch, Background summaries.** Four jobs ask a model
  without an agent: naming a thread (and "Rename with Claude"), the one-line status of what a thread is
  doing, choosing an effort when the operator picks Auto, and reading a schedule out of a prompt ("every
  Monday at 9am"). Each is a `claude-oneshot` call on the operator's own Claude sign-in, and each has a
  mechanical fallback that runs whenever its completer is absent. The machine setting
  `backgroundSummaries` (Settings → Background summaries, default on) is what that completer IS:
  `server/background-summaries.ts` hands each caller a completer while it is on and `undefined` while it
  is off, read at the moment of the call (memoized 2s), so a change applies without a restart. Off,
  Frizz asks no model anything itself: titles come from the prompt or the agent, no status line, Auto
  is not offered (a saved `auto` launches on a fixed level, high for Claude), and a prompt is not read
  for a schedule. Every call that does go out is logged at debug with its purpose. `FRIZZ_THREAD_NAMER=0`, `FRIZZ_LIVE_STATUS=0` and
  `FRIZZ_AUTO_EFFORT=0` still work, as overrides that can only turn a call OFF.
- **A worker's git worktrees go in ONE folder, and a thread marked done takes its own with it.** Frizz
  creates no worktree or branch itself, but where an agent makes one is enforced, not suggested — a
  prompt line alone kept producing `~/<repo>-<slug>` folders beside the checkout. The machine setting
  `worktreeDir` (Settings → Worktree folder, default `.frizz/worktrees` against the repository's main
  checkout, which `.frizz/.gitignore` keeps out of git; absolute or `~/…` for one folder across
  repositories) reaches a worker as `FRIZZ_WORKTREE_DIR` (Claude) or `--worktree-dir=` (Codex), and
  `cc-worker/hooks/worktree.mjs` holds it three ways: the PreToolUse(Bash) guard denies a
  `git worktree add` outside the folder and names the path to use, Claude Code's WorktreeCreate /
  WorktreeRemove hooks put `EnterWorktree` and `isolation: "worktree"` sub-agents there, and its parser
  is what `server/worktree-cleanup.ts` reads back out of the transcript when the thread is marked done
  (`removeWorktreesOnDone`, Settings → Remove worktrees when done, default on). Cleanup removes only a
  worktree nothing would be lost from — no unsaved editor buffer, no other live thread in it, its HEAD on
  another ref, only regenerable ignored files, and git agreeing it is clean — and its branch only through
  `git branch -d`; any check it cannot answer keeps the worktree. The rule is the fork's and bends
  upstream's "no git or worktree opinions" (P10), so it is offered to Colin as a decision
  (`plans/upstream-superset.md` §1, §8).
- **Full-snapshot SSE.** The single `/events` SSE channel pushes `{type:"board", board}` full
  snapshots (see `@frizz/shared` `ServerEvent`). No diff protocol.
- **Permission prompts come from a MARKER, not from JSONL.** Even under `--permission-mode auto` a
  worker can pause on a permission request with NO transcript signal (the last record stays assistant
  + `stop_reason:"tool_use"`), so the cc-worker hook writes a marker into `FRIZZ_PERM_DIR` naming what
  is waiting and the tailer reads that. A broker thread's approvals arrive as typed permission
  requests over the control channel. The `perm-prompt` runtime rides the board snapshot
  with no notify and no unread — the sidebar's attention sort surfaces it.
- **A Claude agent's FIRST escalation goes back to it, not to the operator (2026-10-06).** In an `auto` or
  `bypassPermissions` thread the bridge denies it once with a note — approval stalls the thread, here is
  Claude Code's own reason (`decision_reason`/`decision_reason_type`, e.g. "Dangerous rm operation on
  possibly-empty variable path … rewrite it as "${W:?}"…"), find another route or make the identical call
  again — and the retry, like every later escalation, becomes the card (`claudeFirstApprovalHint`). Once per
  agent (sub-agents each get their own), remembered in `claude-broker/<key>.perm-hint` so a restart does not
  repeat it. Never for an ask rule, a hook's ask, or a restrictive mode the operator chose. Codex never asks
  (`approvalPolicy: "never"`); an ACP permission reply cannot carry text, so it has no note.
- **Human questions are REGISTERED rows (`mcp__frizz__ask`, a `thread_question` row, since 2026-08-27). The free-form ```question fence — a question written into a fence body — is RETIRED for every thread dispatched at or after `QUESTION_FENCE_RETIRED_AT` (2026-09-11, `packages/shared`): there it is prose, never `pendingQuestion`, never a card, never a sign-off; a thread dispatched before it keeps the fence as an ask, because a running worker keeps the contract it was dispatched under (`questionFencesLive`). A registered card renders at the BOTTOM of the rest it belongs to, under every word of the handoff (a placement marker, below, is the one exception), and only the HUMAN'S turn ends that rest — a frizz wake does not, so an ask rides down under the worker's newer handoff until the human replies past it (web/src/lib/questionAnchor.ts `isHumanTurn`, web/src/lib/questionShadow.ts `questionStacks`). The empty PLACEMENT MARKER `` ```question qst_… `` still draws its card where it sits — upstream's rendering, kept (`plans/upstream-superset.md` §3; web/src/lib/questionShadow.ts PLACEMENT) — so the worker contract tells a worker to write none (2026-09-28: "questions should always appear at the bottom of the thread not in the middle any explanation should occur beforehand"). A marker picks which rest its card belongs to: the drawer draws the card in the marker's slot, and a queue card at that rest's end, since its handoff is clamped behind "Show more" (web/src/lib/queueCardQuestions.ts).** The fence was the only medium until 2026-08-27 (two earlier designs — a BLOCKING MCP tool and a frizz-ask CLI + .questions/ sidecars — were built and rejected: fragile timeouts / redundant state); `ask` is non-blocking, and the row outlives the message, a compaction and a restart, which is what the fence could not do (`plans/rest-by-registration.md`). Both reach the same card. A fence that RESTATES a question registered at the same rest draws nothing — the registered card wins, because answering it is what settles the row (web/src/lib/questionShadow.ts; 2026-08-28, one question drawn twice back to back). The fence body is plain
  markdown; a TRAILING `- A. …` option list + optional `Recommendation:` line are convention-parsed
  into choice chips (web/src/lib/questionBlocks.ts). A go/no-go is just a two-option question — the
  old ` ```question approval ` gate (one Approve button that sent on click) was dropped 2026-07-26;
  its token now degrades to a plain question so legacy transcripts still render.
  Answers compose into one follow-up numbered by ORIGINAL block position ("Answers:\n2. …"), a ONE-block ask included — the numbering is what the renderer keys on to card the reply up instead of dropping it into a flat bubble. The
  contract lives in packages/server/src/workerPrompt.ts + cc-worker's SKILL/deny-ask hook — keep all three aligned.
- **The worker decides where a rest sits — `status:` in the ```awaiting fence, since 2026-10-05 (`needs_input: true|false` from 2026-10-01, still read as an alias).** For a thread dispatched at or after `NEEDS_INPUT_REQUIRED_AT` (`packages/shared`), every rest on running work ends with the fence answering `status: working|watching|needs_input`: `working` and `watching` keep the thread out of the queue while the park is one frizz can honour (every named item live, `for:` not run out — `awaiting.needsInputParkHolds`), `needs_input` queues it while the work keeps running, and no answer queues it and draws a SOURCE 12 correction naming the missing line. That replaced frizz's per-wait guesses — a live sub-agent, a registered `watch`, CI still running on a watched PR each used to excuse the thread on inference — which still apply to threads dispatched before the cut (`board.needsInputQueues` vs the legacy tail of `deriveNeedsYou`). An explicit answer is honoured from ANY thread, because a cold resume re-applies the current worker prompt. A `watch` registration is no longer a sign-off on its own under the new contract: it keeps the wake, the fence carries the answer. A `working` or `watching` rest owes no write-up (worker contract § A QUIET PARK NEEDS NO WRITE-UP).
- **Out of the queue, the band is a second verdict — `ThreadView.waitStatus` (`board.deriveWaitStatus`, 2026-10-05).** "Not needed" used to mean Active: the client read `awaitingBackground` as motion, so a thread parked for a day on a watcher spun among the running rows and counted on the project rail. Now `working` puts a resting row in Active with a spinner, but only while something it names is MOVING — a live direct sub-agent, a shell the fence names or a `watch` registers, CI running and not held at the approval gate (`ciInMotion`) — and otherwise it reads as `watching`; `watching` parks the row in Snoozed, still, EVEN beside a live sub-agent (the contract hands a long wait to a sub-agent, and the child keeps its own spinner on its own row; this reverses the 2026-07-10 rule for that one case). A fence answering `needs_input: false`, and a legacy fence with neither line, read as `working` while a live sub-agent or moving CI is out and `watching` otherwise — shells included, which is what moved the pre-cut shell watchers out of Active. The field is absent on every other rest, so a queued row never spins (`groups.restIsWorking` is the list's one spin test for an at-rest mark), and a message on its way to the worker keeps its row where it was. `activeBandThread` follows it, and so does every Running count (the switcher's, the phone header's).
- **Steps only the human can perform ride the ```awaiting fence — `steps:`, since 2026-10-03.** Each `- ` item under the key is read VERBATIM, as `title:` is (YAML cannot hold a step: a backtick cannot open a plain scalar, `: ` starts a mapping, ` #` a comment), and becomes a `{kind: "step"}` hint after every other hint, capped on its own (`AWAITING_STEPS_MAX`, `AWAITING_STEP_VALUE_MAX` in `packages/shared`). Steps NAME THE HUMAN as the wait, so a fence carrying them is a park with no other item and no `for:` (`awaiting.parkIsHonoured`; a `for:` beside steps alone runs to `PR_WATCH_FOR_MAX_MS` and wakes the worker to re-check), and it always queues — `awaitingStatus` reads `needs_input` beside any step, whatever the fence's own `status:` says. The board keeps the resting card on it (`board.hasHumanSteps`, inside `hasDeclaredWait` and the `deriveAwaitingBackground` exceptions). The card (`AwaitingSteps.tsx`, a stratum of `AwaitingBackgroundCard`) is headed by a "To do" kind chip with the worker's `title:`, if any, under it and a rule before the body (`TranscriptCard`'s chip head, 2026-10-05), and draws the steps over one Done button — drawn only while the board's `lastFence` still carries exactly those steps at `turn-idle` (`restingOnSteps`). Done sends an ORDINARY follow-up, the word `Done` (`STEPS_DONE`), through the composer's eager send, and the tailer clears `lastFence` on that user record as on any reply. There is no second verb and no note box: anything else the human has to say goes through the prompt box like any steer (maintainer 2026-10-03: "The user can just send a new steer message in the prompt box if they want."). Nothing is registered, so nothing needs a dispatch cutover: the fence is parsed by whichever server is live. A first cut stored each set as a `thread_question` row behind an `instruct` MCP verb; the maintainer had it moved into the fence (2026-10-03: "I don't think this requires persistently registering it").
- **A registered question is a sign-off only at the rest that asked it; a later ```awaiting fence names each one still needed under `questions:` (since 2026-10-05).** The ids are lookups (`awaitingQuestions` in `packages/shared`, capped by `AWAITING_QUESTIONS_MAX`), and like `steps:` they name the human: a fence on questions alone is a park with no other item and no `for:`, and `awaitingNeedsInput` is true beside them. The scheduler refuses a fence that leaves an open question unnamed, or names one that is not open (`evalParkIntegrity`, `park:question:` fence ids), and a bare rest carrying a question from an EARLIER rest — one asked before the last user record, which a wake is too — draws `carriedQuestionsNudgeMessage` instead of the generic sign-off nudge (`evalSignoffNudges`). The web never pulls an open card to the newest rest: it stays at the bottom of the rest that asked it until a later fence names it, and then renders at the end of that rest (`questionClaims` / `questionsByAnchor` in `web/src/lib/questionAnchor.ts`). From 2026-08-31 every open card was redrawn at the current rest and any open question refused every park, so an old card superseded whatever the worker had signed off with (maintainer 2026-10-05: "the pending questions that may or may not be relevant kind of supersede how the agent actually signed off"). A question no later rest names is simply left behind where it was asked; nothing forces a re-ask. A question the human TYPED PAST is set aside (`questionRepliedPast`): it holds nothing, needs no naming, and is withdrawn at the next rest unless the worker `keep`s it — and a keep counts as asking it again at the rest that follows (`board.carriedQuestionRows`).

## Board nomenclature (the maintainer's words — write code, comments and copy in them)

Saved links and files are thread references, not activity or waits. Workers register them with `mcp__frizz__link` (`label`, `target`) and remove them with `mcp__frizz__unlink` (`id`); `activity` lists their ids separately from running work. The `thread_link` table scopes them to project + thread, with one slot per label. They survive rests, archive/reopen and restarts, disappear when the thread is deleted, and never block completion. The prompt's activity area renders them below an unlabeled divider; files use the existing reader/opener and trust boundary.

These are the names for a project's row groups, top to bottom. They are the MAINTAINER's vocabulary (2026-08-05), so they win over whatever a symbol happens to be called; when a comment and this list disagree, the comment is wrong.

**Where the bands live.** In the page's left column, at one of two densities — the page's view decides which (see **URL shape** below).

- **A project's board** (`/project/<slug>`, `components/ProjectBoard.tsx`, the default view) NAMES every band, as Colin McDonnell's sidebar did: a static header over Pinned, Queue and Running, which never fold — nothing on the board can hide the pins, the queue or the live work — and a fold header each over Snoozed, Done and External, then Schedules, collapsed to start and remembered per browser and project (`lib/crossProject.ts` `setBoardBandOpen`). A band shows only when it has rows, which was Colin's rule too. A rule parts Queue from Running when both show, and the project's cord is cut there: Queue is the human's, Running the agents'. A thread's sub-agents list as rows under it (Sidebar.tsx `SubAgentRows`). A working row's status is a HOVER here — on its title after a short rest, and under the state in its glyph's tip — with only its task clock on the line (Colin, standup 2026-10-01: always-visible status lines are too dense for a sidebar); All projects keeps it inline after the name. No project row heads the board; the switcher over the prompt box names the project.
- **All projects** (`/all`, `components/ProjectList.tsx`) names NO band: every project's work in flight — Pinned, Queue and Running — lists under its row, and each row says its band by its own mark, the pin, the rest time or the spinner. Snoozed, Done and External (and Schedules) are a muted count each on the project's row, in the band's own glyph, and EACH count is its own toggle, all closed to start, that lists its band in place under the work in flight (Done ten at a time, then "Show N more"); "N more" beside an unfolded project's name says the same in words and lists the rest. The row itself is the project's primary fold: clicking it puts EVERY thread under it away, in flight or not (maintainer 2026-09-28: "a primary collapse button that would easily allow you to visually filter which projects you're looking at"), and a folded row then counts its Pinned and Running beside the quiet counts and keeps its Queue badge, so a fold never hides which band a thread is in (Colin's S1, `plans/upstream-superset.md` §1). A sub-agent is a count on its parent's row. The folds and the open bands are per browser (`setProjectCollapsed`, `setBandOpen`).

Both are DENSE by measurement, not by eye, and held to upstream's capacity: at Colin's load (17 projects, 70 open threads) All projects must show at least the 22 / 28 lines upstream's board shows at 1440x900 / 1920x1080, and a project's board at least as many rows. `packages/web/src/capacityParity.e2e.test.ts` gates both (see **Developing frizz**); on 2026-10-06 the merged tree measured All projects 23 / 30 and a board 22 / 29, the same with the project rail on as off (the rail takes 57px of width and no height), so a board has no line to spare and a new header must replace one rather than add one. A band's header is a 15px line, a project's row 23px, the gap between projects 6px; `Sidebar.tsx` (`SectionHeader`) and `ProjectList.tsx` keep the readings beside each constant.

**The visible labels are one table**, `BANDS` in `components/BandLabel.tsx` — **Pinned · Queue · Running · Snoozed · Done · External** — shared by a project board's band headers (`components/ProjectBoard.tsx`, Sidebar.tsx `SectionHeader`), the glyphs of All projects' quiet counts, the QUEUE header over the queue and the band stamp in a drawer's header, so they are a legend for the whole screen. On a board a header's glyph stands in the rows' indicator column, where the project's cord strings it like a row (`ThreadConnector`), so a name reads as the head of the rows under it rather than a divider; the rows still wear their own marks — the pin, the rest time, the spinner — which are all All projects draws. The maintainer's spoken words for two of them are older than those labels: **Rested** is the band labelled **Queue**, and **Active** is the band labelled **Running** (unlabelled until 2026-09-19, then "Queue" and "Running", then on 2026-09-23 "Ready" with an inbox and "Working" with a bot — "Working" alone left it open who was working — and Colin's "Queue" and "Running" again since 2026-10-06, keeping the inbox and the bot; `plans/upstream-superset.md`). Most comments still say Rested/Active; say either pair, never mix them within one sentence.

- **Pinned** — the human's shelf, ABOVE everything including the cue (maintainer 2026-09-02: a pin "takes a thread entirely out of the whole rail system"). Named on a board; on All projects each row says it with a small solid pin where the cue's rest time would sit. Membership is one fact — `pinnedAt` on the thread, written only by the row's hover pin/unpin verb — and it outranks every derived state: a pinned thread that spins, rests, snoozes or finishes stays here, in PIN order (oldest pin first), until unpinned. Not a `SectionKey`: `sectionThreads` diverts these rows before `sectionOf` runs (`isPinned`, groups.ts), which is what keeps the pin from having to be excluded band by band. One deliberate consequence: a pinned thread that needs you keeps its QUEUE CARD (the pin is a rail arrangement, not a queue excusal), so its card's row lives up here rather than in the cue — the card↔cue pairing below holds for every UNPINNED thread.
- **Rested** (labelled **Queue**) — the top band of the RAIL SYSTEM proper, directly under the project's pinned rows (under the prompt box on the board, maintainer 2026-08-08), and the same set as **"the queue"** / **"the cue"** / **"items in the queue"**: one rested row per queue card, in the identical order, so a project's first Queue row faces the first card in that project's lane of the queue (`ThreadConnector` draws the tie across the gutter). A Queue row's click brings its card into view — the queue always shows the cards of exactly the projects the list shows — and a row with no card on the page opens the thread's drawer; a thread open in a drawer keeps its row, marked open, and only a card being finished takes its row with it. Say "rested" or "in the queue"; do NOT say "active" about these rows just because they share a `<section>` with the Active band. Each carries a right-justified time — when that thread ENTERED the queue (`queuedAt`, stamped server-side by `queue-clock.ts`), which is its rest time for a plain rest and the moment the wait let go for one that rested behind a hold. The queue orders by that same instant, oldest first, so a new arrival always joins the bottom and nothing moves a thread while it waits (maintainer 2026-09-24: the queue had behaved like a stack, because a thread entering off a wait carried its old rest time to the top). A thread let go by a hold that usually ends in a wake — its sub-agent returning, CI settling, a park or timer firing — is withheld for 12s first, so a worker woken inside that window never flashes into the queue or notifies; permission prompts, questions, crashes and limit pauses enter at once. The queue card prints the same instant as "Queued 5m ago" ("Ready 5m ago" until 2026-10-06); the conversation header keeps the agent's own "Last active".
- **Active** (labelled **Running**) — the rows after the Queue rows, in practice the ones currently SPINNING. The rule between the two bands is drawn on the CARD, both ways: nothing below it has a queue card, and every card has a row above it. So the band also takes the occasional row that is neither spinning nor asking — a thread the server excused from the queue while it rests (a worker's own `status: working` park; for a thread that predates the line, a live sub-agent or CI running on a watched PR; a follow-up still in flight). That is the honest place for it. A `working` rest spins with the mark of what it waits on inside the spinner; a row here that is not `working` — a follow-up in flight past a minute — wears its static at-rest mark. The alternative, tried until 2026-08-14, was a cue row with no card behind it, which looks queued and opens a drawer on click. No rest time: nothing below the rule has handed anything back.
- **Snoozed** — the dimmed, labeled band under Active, and the first of a project's QUIET bands (a folded header on a board, a count on the project's row in All projects): a valid future `timer:`, a user wall-clock snooze, or the resting card's event-snooze (parked until the thread next comes to rest — since 2026-08-28; before that it sat in Active with the dot), a rest its worker called `watching` (`waitStatus`, 2026-10-05 — for a thread that predates the line, a park with nothing moving behind it, such as a shell watcher), or a queued parent's "snooze until all sub-agents return" (since 2026-09-29: armed at an instant rather than a rest, so each child's return still wakes the parent without re-queueing it, and it lets go when no direct sub-agent is running — board.subAgentsSnoozeHolds; the one park a live sub-agent does not pull back into Active, since the live sub-agents are what it parks on). Parked, not asking, and still — no mark in this band spins — except that a park whose rest ANSWERS the human's newest typed turn stays in the Queue until they open the thread or act on it, then drops here (board.replyUnseen, 2026-10-01: an answered question sat unread in Snoozed because the same message parked on a PR). A limit pause frizz will auto-resume was a member until 2026-08-31; it now QUEUES as a failed thread (yellow hourglass in the cue, hover Retry) — a whole fleet a quota limit killed once sat here as calm muted hourglasses, which is the opposite of what a mass kill should look like (maintainer: "they should have shown up in the queue … as threads that had failed in some way"). Renamed from **Held** on 2026-08-26, key and label together.
- **Done** — the archived section, last of the thread groups, most recent first: a folded header on a board (virtualized once open, the one band that grows without bound), a count on the project's row in All projects that lists ten at a time. An archived thread whose worker is still running — a turn draining, a sub-agent it dispatched still out — is not filed here until it rests: it lifts into Active (Running) with its spinner, keeping its Done dim and uncheck box (`sectionOf`, `doneButRunning`; Colin 2026-07-10, "hit 3×"). Its state never moves; only the human reopens a thread. The fork filed it in Done whatever the worker did from 2026-09-24 (da8ebaf1) until 2026-10-06, which hid running workers in a collapsed band.
- **External** — agent sessions in the project that Frizz did not start (one you ran in your own terminal, `foreign` on the wire — `externalThreads`, groups.ts), rested ones only; the first message steers one into an ordinary thread. Quiet, like Snoozed and Done.
- **A thread's terminals have no band — and no row.** A TERMINAL is a pty the human opens ON a thread (the drawer's ⋯ menu → Open terminal, `t` in its drawer, or a `$ npm test` line typed into its prompt box), and it starts in the folder that thread's agent is working in: the newest `cwd` its Claude transcript records, or the newest tool `workdir` in a Codex rollout, lifted to the checkout it lies in, so an agent that moved into `.frizz/worktrees/x` gets a terminal there rather than in the project root (`server/src/thread-cwd.ts`; the dialog shows the folder and the human can change it first). The control plane owns the pty (`server/src/thread-terminals.ts`, one row per terminal in `thread_terminal` with `parent_slug`) and `/term/<id>` (`server/src/terminal.ts`) streams it to xterm.js. It rides its thread's `ThreadView.terminals`: a line in the thread's drawer strip and card strip (no mark on its list row: dropped 2026-09-30 as repeating the status dot and the queue), and its own drawer stacked over the thread's. A terminal waiting at a prompt (`awaitingInput` — an OTP, a `[y/N]`: text left on an unterminated line for 3s) queues its THREAD (`board.withThreadTerminals`), whose card then draws the terminal's live screen so the answer is typed right there. Marking the thread done stops its running terminals — the "End this session?" dialog lists them beside background shells — before Done is recorded, then files them away with it. A finished terminal's drawer ends in a `$` line (`TerminalFollowUp`): the next command runs as the SAME terminal's next run (`terminalRun`), on the previous screen plus a `$ <command>` line; Restart alone starts blank. The PROCESS is a child of the control plane, so a Frizz restart hangs it up and boot marks any run with no recorded exit as interrupted. Terminals replaced the prompt box's Terminal tab on 2026-09-29, where each command was a top-level `kind: "command"` thread with a row and a card of its own; the rows that shape left (no parent) are archived at boot. node-pty is loaded LAZILY, on a terminal's start and nowhere else, so a box where the addon will not load serves every project and the terminal pane says why.

Where the CODE disagrees, and it does in places worth knowing before reading `web/src/groups.ts`:

- `sectionOf` (`@frizz/shared`, re-exported by `groups.ts`) returns `"active"` for Active AND Rested rows alike. That key names the `<section>` that holds both bands, not the maintainer's "Active". `partitionActive` splits it: `.running` is Active, `.rested` is Rested.
- The archived section's `SectionKey` is `"inactive"`, but its rendered label is **Done**. And the band KEYS are `ready` and `working` (`BANDS`, `Band`), from the fork's Ready/Working labels, under the labels Queue and Running.

None of these is worth a rename sweep — but every new comment says Active / Rested / Snoozed / Done in the sense above, and `inActiveBand` (the predicate for "this row has no queue card") is the one function that means "Active" exactly.

## Packages

- `shared` — zod schemas + types + constants. THE contract; read `src/index.ts` first.
- `rpc` — typed query/mutation/stream over Hono (lifted from gent, unchanged). Server defines a
  `Router` in `server/src/router.ts`; web imports `type AppRouter` from it for the typed client.
- `server` — Hono app on 127.0.0.1 (default port in shared). Every route of its own lives under the
  RESERVED `/_frizz` namespace (`FRIZZ_ROUTE_PREFIX`), which is what leaves the top level free for a
  project slug: rpc mounts at `/_frizz/rpc` (and `/_frizz/<project>/rpc` — see § URL shape), SSE at
  `/_frizz/events`, the multiplex socket at `/_frizz/ws`, static web assets in prod, Vite
  middleware in dev (`src/dev.ts`). Subsystems: `bus.ts` (EventEmitter → SSE), `board.ts`
  (.frizz watcher + read model), `sessions.ts` (SQLite registry via better-sqlite3),
  `tailer.ts` (JSONL), `dispatch.ts` (thread file create + prompt compose + spawn),
  `settings.ts`.
- `web` — React 19 + Vite 8 + Tailwind v4 + valtio + TanStack Query + xterm.js.
- `desktop` — the Electron app: a window onto the one server, never a server of its own (see
  **Desktop app** below). Private; nothing it adds reaches the published packages.
- `vscode` — the VS Code (and Cursor, Windsurf) extension: a client of the one server over the
  machine-wide editor bridge (see **VS Code extension** below). Private; nothing it adds reaches the
  published packages.

Plus root `src/` — the `frizz` launcher (NOT a workspace package): canonicalize cwd's Git root,
health-check/reuse its detached supervisor, atomically allocate/persist an isolated port, then open the
URL. Locks and logs live under `~/.frizz/projects/<id>/`; `src/browser.ts` is vendored from Gluon via
gent. See **CLI launcher** below.

## URL shape (one server, every project — the singleton)

Frizz used to run ONE SERVER PER PROJECT, each on its own port, so every URL was unambiguous and unprefixed. It is now a SINGLETON: one server on one origin serves EVERY project on the machine, and the project is named by a URL PREFIX. Two rules follow, and most of the bugs in this area come from missing one of them.

**Frizz's own routes are under `/_frizz`, so the top level is free.** Anything outside `/_frizz` is the SPA's: `/`, `/all/<slug>/…`, `/project/<slug>…` and the launching project's unprefixed `/thread/<t>/full`. `APP_ROUTE_SEGMENTS` (`thread`) is a different set — the unprefixed in-app links an AGENT writes (`[x](/thread/<t>)`), which the markdown sanitizer re-points at the page's project (`prefixedAppRoute`) rather than letting them address whichever project launched the server.

**A project in an address lives under a segment — `/project/<slug>` for its board, `/all/<slug>` for a drawer on All projects — not at `/<slug>`.** One segment buys back the whole root namespace, so a future page can never be shadowed by a directory somebody happens to have. `/project/<slug>` was a project's own page until 2026-09-28, gone while focus mode lived in the query, and the board's address again since 2026-10-06 (David: the fork is the base with Colin's URL scheme, `plans/upstream-superset.md` §2). Only its exact shapes are pages (`base-path.ts PROJECT_BOARD`): `/project/acme/src/main.rs` is somebody's file.

**ONE page, in two views** (`lib/pageView.ts`). Every address in the table below renders the same component (`components/AllQueues.tsx`, through `routes.tsx PageRoute`), mounted once, so nothing remounts under the operator when a drawer opens or the view changes. **A project's board** is the default (2026-10-06: David asked for Colin's per-project default, which reversed All projects as the home): a bare `/` opens the view this browser showed last, which for a browser that never chose is a board. **All projects** is one click away at `/all` — the switcher's first entry, the board's ⌂ crumb, the rail's top door — and is every project's list, one queue across them, and the prompt box's own project picker. Its projects never interleave — every row sits under its project's row, and every card names its project — which is Colin's rule that projects stay separate (S2, `plans/upstream-superset.md` §1). **A project's board** is the page showing ONE project, Colin's one project per page: its banded list (**Board nomenclature** above), the queue showing its cards, and a prompt box that dispatches into it with no picker; at `/status/<s>`, upstream's status list (`components/StatusListView.tsx`) stands in a bordered panel in the queue's place. History, because it explains the shape: Colin's board was a page of its own (`TodosView.tsx`) until 2026-09-28, when the fork folded every project onto one page and his board became a filter, then a view in the query (`/?project=<slug>`, 2026-09-29); on 2026-10-06 it took his URL and his named bands back as a view of the same page (David: the fork is the base, and everything Colin built is in it). `TodosView.tsx`, `MobileBoard.tsx` and the board's `Sidebar` component stay deleted; `Sidebar.tsx` keeps the row pieces both views share (`RailRow`, `SectionHeader`, `SubAgentRows`). Below 800px the same page stacks — prompt box, queue, then the list. Below the phone breakpoint (700px, `lib/mobile.ts`) it has its own layout of the same view, upstream's redesigned phone board brought onto this page (`components/PhonePage.tsx`, its tabs in `lib/phonePage.ts`): a header naming the view with "N need you · M queued · K working", Queue / Snoozed / Done tabs of one-line rows across the view's projects (each row naming its project in All projects), a New thread button that opens the page's prompt box aimed where the view dispatches (All projects' picker included), and a ← to a plain list of the views — All projects, then each project with its asks — which is a history entry, so Back puts it away. A row opens its thread's drawer in place, full-screen on a phone, and a long press opens its actions sheet. A phone's bare `/` is that list of views itself, upstream's phone home: nothing is checked there, and a choice pushes, so Back returns to it. The desktop's columns from 700px up are unchanged.

**Say "All projects" and "a project's board"** — the switcher's own labels — for the two views, and "cross-project" in code and comments about the page; the code also calls the board view "focus mode" (`PageView` `kind: "project"`, `ProjectBoard.tsx`). Never "project view", "Everything" or "All queues", the names of surfaces that are gone; `board` is also the internal name of a project's snapshot and store.

| URL | renders |
| --- | --- |
| `/project/<slug>` | the page (`components/AllQueues.tsx`) focused on `<slug>` — the project's BOARD, the default view, and where the launcher lands when run in a project. A slug no project has says so in a toast and lands on `/` |
| `/project/<slug>/thread/<t>` | the board with `<t>` open in place: a COLD link (a bookmark, a pasted address) to a queued thread lands on its card on a desktop and the address returns to `/project/<slug>` (`lib/queueLandingHold.ts` holds it there); anything else opens its drawer |
| `/project/<slug>/thread/<t>/full` | the thread's fullscreen page, outside the layout |
| `/project/<slug>/status/<s>` | the board with every thread in frizz status `<s>` listed in a panel in the queue's place (`components/StatusListView.tsx`, desktop) |
| `/` | NO VIEW OF ITS OWN (`routes.tsx LastViewRedirect`): it replaces itself with the view this browser showed last — `/all` or `/project/<slug>`, remembered in localStorage (`frizz.lastView`, `lib/crossProject.ts lastViewHref`; navigation memory, not a setting, and never written by an editor's frame) — and a browser that never chose gets a BOARD: the project last focused here, else the one `frizz` last ran in, else the last opened, else the first. It answers a launcher's `?add=` and the server's `?unknown=` on the way through. On a phone it is the projects list instead. With no project at all it is the welcome page (add a project, or start in Home). What the desktop app opens |
| `/all` | the page showing All projects, bound to the prompt box's pick (the operator's last pick in this browser, else the most recently opened open project — `lib/crossProject.ts`; never the Home workspace, which is picked only when chosen); where an `everything` launch (from $HOME) lands, and what an editor's sidebar frames when no folder maps to a project. It was the bare `/` from 2026-09-30 to 2026-10-06 |
| `/all/<slug>/thread/<t>` | All projects with `<t>`'s drawer open IN PLACE; the page is bound to `<slug>` while the drawer is open |
| `/all/<slug>/thread/<t>/full`, `/thread/<t>/full` | the thread's fullscreen page, outside the layout; the unprefixed one is the launching project's |
| `/?project=<slug>`, `/?focus=<slug>`, `/?all`, `/?embed=vscode` | the view's addresses from 2026-09-29 to 2026-10-06 — redirected to `/project/<slug>` and `/all` (an older editor sidebar's bare `/?embed=…` asked for All projects), the rest of the query riding along (`lib/pageView.ts legacyViewRedirect`); a drawer's old `/all/<s>/thread/<t>?project=…` lands on `/project/<s>/thread/<t>` |
| `/projects`, `/queues`, `/all/<slug>` | All projects' old names, and a drawer's address cut short: redirected to `/all`, keeping the query |
| anything else — `/status/…`, a bare `/thread/<t>` | redirects to `/`, keeping its query (`?add`, `?unknown`). These are deliberately NOT translated (maintainer 2026-09-28: "backward compat not important at this point") |

**THE VIEW IS THE PATH, per tab, and nowhere shared.** `/project/<slug>…` is a board and anything else All projects, a drawer's address included, so a drawer's close goes back to the view it sat on with nothing to remember (a tab kept its view in `sessionStorage` from 2026-09-29 to 2026-10-06, while a drawer's address could not say). Nothing is shared between tabs but the address a bare `/` goes to: the view the BROWSER showed last, whichever tab showed it (`lib/crossProject.ts rememberLastView`, 2026-10-06; `/` meant All projects from 2026-09-30, and before that reopened the tab's or the browser's last-focused project). Two tabs on two projects therefore stay on them across reloads whatever the other does — which is why the view is NOT the prompt box's pick, a per-browser setting that one tab's choice would change under the other.

**The page is BOUND to one project, the page project**: on a board, the board's; in All projects, the prompt box's PICK (its project pill, beside the model); under a drawer, the drawer's. The route (`routes.tsx CrossProjectPage`) resolves it and hands it to `base-path.ts` with `setHomeFocus`, which then answers `/all` (and a phone's `/`) as it answers `/all/<slug>` — same API base, same live feed, same cache scope — so the whole drawer stack, prompt box, router sync and notifications work for it. Opening ANOTHER project's thread navigates to `/all/<other>/thread/<t>` in All projects, where other projects' rows show, and to that project's board, `/project/<other>/thread/<t>`, from a board (`base-path.ts crossProjectHref`, as upstream's links did): the route resets the store and rebinds the feed, and `<App/>` is keyed by a constant so the page itself survives. Closing the last drawer goes home to THIS TAB'S view (`lib/pageView.ts homeHref`, through `lib/router.ts`), never to a bare `/` that would have to guess it again.

**The switcher changes the view, by navigating** (2026-09-29; it replaced the QUEUE FILTER, which from 2026-09-28 scoped the right column per tab while the list kept every project). It is the page's TITLE, at the left end of the status row over the prompt box (`components/ProjectSwitcher.tsx`, placed by `AllQueues.tsx Switcher` into `StatusRow`'s `title`) — it sat at the right end of the READY header until later on 2026-09-29, where it read as a filter on the queue rather than the scope of the whole page — and names the view — the project's square and name, or "All projects" — with a menu of every project, the Home workspace included, each with its asks, its Running and its Queue count, with All projects above them all and Add a project under them. A choice is a navigation (`/project/<slug>`, `/all`), so Back undoes it; leaving a project for All projects carries it over as the pick, so the prompt box keeps aiming where the operator just was. The other doors: "Focus on this project" / "Show all projects" in a project row's ⋯ menu (`components/ProjectActions.tsx ProjectMenu`, which also holds "Open on GitHub", the icon, rename and delete); a card's project chip, drawn in All projects only; a board's ⌂ crumb, to `/all`; the opt-in project rail (below); and ⌥↑/⌥↓ in the prompt box, which step a board through the projects as they step the picker in All projects. On a board it is the only place the project's name is drawn: a project's board draws no project row at all (the line pays for the band headers), so the thread cord starts at the first band's header glyph; the status row carries the board's door home before the switcher and its owner/repo and ⋯ menu after it (`StatusRow.tsx`, `ProjectBoard.tsx BoardIdentity`). The queue filter's one idea that survives is the maintainer's: the UI says what it did — on a board, the list shows the one project, so nothing on the page implies more than is there.

**No door leads anywhere else, because there is nowhere else** (maintainer 2026-09-28: "too many places in the ui where it is easy to navigate to a ui which is not the primary home ui"). The status row (`components/StatusRow.tsx`) is the switcher, then settings, keyboard shortcuts and restart, then the quota readouts — on a board led by ⌂, the door back to All projects at `/all`, and followed by the project's repo; the ∞ door to Everything is gone from it (maintainer: "there should no longer be an everything or an infinity button").

**THE PROJECT RAIL is upstream's, and opt-in** (`components/ProjectRail.tsx`; Settings → Project sidebar, the machine setting `projectRail`, off by default — upstream maintainer 2026-08-06: a standing list of every project is "just too tempting" a way out of the thread you are in). A Discord-style column fixed to the left edge, on a board and on All projects alike, hidden below 800px and never in an editor's frame: the layers glyph at the top goes to All projects (`/all`; upstream's house, which here is the Home workspace's square, pinned under the list), then every project's square with a pill on the board the page shows and a badge counting its queue plus its running threads, with a spinner lapping it while any run (the tooltip splits the two). The badges are the light `projectsRailCounts` poll (5s, machine-wide), and the page project's from its live board; a square drags, or moves with ⌥↑/⌥↓ when focused, to reorder the machine's one project order (`lib/railReorder.ts`, the same order All projects' list drags). The fork removed its own copy on 2026-09-30, when All projects was home and the rail a third door onto it, and restored upstream's on 2026-10-06 with the board as home. `lib/projectRail.ts` mirrors the setting into localStorage so a reload draws the rail on its first frame (App.firstPaint.e2e.test.ts), and `lib/projectRail.e2e.test.ts` flips it after a client-side switch. FULLSCREEN is one item, "Open fullscreen" in the drawer header's ⋯ menu (`components/ThreadMenu.tsx`), plus the `f` key on a drawer (maintainer: "the single thread view is only marginally useful at best and should probably be a dropdown option"); the ⤢ on every queue card, list row and drawer header went the same day. Leaving `/full` — its collapse control, or `f` again — returns to that thread's drawer on the page, including after a cold load of a `/full` link; the launching project's unprefixed `/full` names no project to open a drawer in, so it goes to `/`.

`scripts/verify-focus-mode.mjs` drives a project's board on a seeded four-project stack — `/project/<slug>` and the query-era addresses that land there, two tabs on two boards across reloads, a bare `/` going back to the last view (a board, All projects once chosen) and in a fresh browser to a board, a phone's `/` as the projects list, the switcher and Back, a drawer closing back to the tab's view, an unknown board, the named bands (Pinned, Queue and Running never fold; the quiet bands fold one at a time) and their cord, a phone's width (its header has the invocation; `--only=<words>` runs one step). All projects is driven by `scripts/verify-all-queues.mjs` (see below).

This page absorbed the project grid (`/projects`) on 2026-09-24: adding a project is the list's last row (and Add a project in the switcher's menu), both through the one dialog `store.addProject` opens, and a machine with no usable project gets the welcome page at `/`.

`packages/web/src/lib/base-path.ts` is the single definition, and every URL a client builds or parses goes through it:

| helper | answers |
| --- | --- |
| `projectSlug(path)` | the project this page is bound to — the `<slug>` of `/project/<slug>…` or `/all/<slug>…` in the address, or at `/all` (and a phone's `/`) the focus `setHomeFocus` was handed — or `undefined` where there is none |
| `isCrossProjectPath(path)` | whether this is the page (`/all` or `/` with a focus, `/all/<slug>…` or a board's `/project/<slug>…`), rather than the welcome or the unprefixed `/full` |
| `isProjectBoardPath(path)` | whether this is a project's board — only its exact shapes (`PROJECT_BOARD`): `/project/<slug>`, `…/thread/<t>[/full]`, `…/status/<s>` |
| `basePath(path)` | `/project/<slug>` on a board, `/all/<slug>` on All projects (`/all` answers `/all/<focus>`), or `""` |
| `innerPath(path)` | the path with the prefix removed — what the ROUTER reasons about |
| `outerPath(inner)` | an inner path put back in ADDRESS-BAR terms; the inner `/` is the board on a board, `/all` on All projects whichever project a drawer had bound, and `/` at a phone's `/` |
| `apiBase(path)` | `/_frizz/<slug>`, or `/_frizz` unprefixed |
| `crossProjectHref(slug)` | `/project/<slug>` on a board, `/all/<slug>` elsewhere, only ever with a thread's path after it — the one place that knows the shape, so a thread opened in place keeps the page's view |
| `prefixedAppRoute(href)` | an agent-written `/thread/<slug>` re-pointed at this page's project |

The VIEW's addresses are `lib/pageView.ts`'s: `viewHref` / `projectViewHref` (`/all`, `/project/<slug>`), `viewAt` (what a page at an address shows), `homeHref` (the page under the drawers, with none open — the board or `/all`, never `/`), and `legacyViewRedirect` (where a query-era address lands). Where a bare `/` goes is `lib/crossProject.ts lastViewHref`.

**AN EMPTY BASE IS A SUPPORTED STATE**, and a narrow one now: the launching project's unprefixed `/thread/<t>/full`, and a page with no project at all (the welcome). Until 2026-09-28 the launching project was also served unprefixed at `/thread/<slug>` and `/status/<name>`, so every pre-singleton bookmark still resolved; those now land on `/` like any other unknown address. An unprefixed link is still not a shape to MINT: built without the prefix, it silently addresses whichever project started the server, which is how the drawer's ↗ button came to open a stranger's board (2026-08-07). Build outward-facing URLs with `outerPath`/`crossProjectHref`; parse with `innerPath`.

## The Home workspace (a board for work that belongs to no project)

Some work has no project yet — cloning a repository, a question about the machine, a scratch script — and until 2026-09-28 it was filed under whichever project the prompt box happened to point at. **Home** is the prompt box's other target: a built-in workspace whose agents run in the operator's home folder, or in Settings → Home folder. It behaves like any project everywhere a project is drawn — an entry in the switcher and in All projects' list with its threads under it, cards in the queue and a board of its own at `/project/home`, drawers at `/all/home/thread/<t>` — and it is synthesized by `packages/server/src/home-workspace.ts`, never written into `registry.json`.

**It cannot be a registered project, because its board cannot live at `<folder>/.frizz/`.** For the home folder that is `~/.frizz`, which is not a free name: it IS the data root on every install that predates the XDG layout, and on every other install its mere existence switches Frizz back to it at the next boot (`frizz-paths.ts`), taking every project's threads with it. So Home's `Project` splits the two directories a registered project keeps as one — `dir` is its STATE DIRECTORY (`<data>/projects/686f6d65-0000-4000-8000-000000000000/`, the id is "home" in hex), which holds its board; `workDir` is the folder its agents run in. `workDirOf(project)` (`project.ts`) is the agent side — spawn and resume cwd, transcript sharding, tailer cwds, edited files, file roots, the terminal — and every site that means "the board" keeps reading `dir`. A site that should read `workDirOf` and does not puts an agent in Frizz's state directory: visibly wrong, never `~/.frizz`. As a second guard, `frizzPaths` ignores a `~/.frizz` that holds only board entries (`threads/`, `.id`, …) and nothing of a data root.

**A worker's scratch directory is therefore not under its cwd.** Dispatch hands it the ABSOLUTE path (`workerScratchPath`, `dispatch.ts`) whenever the board root is not the cwd, and the cc-worker hooks that create and announce it read the board root from `FRIZZ_BOARD_ROOT` (the Claude broker's worker env) or `--board-root=` (the Codex hook command) before falling back to `CLAUDE_PROJECT_DIR`/cwd. For a registered project nothing changes: both are the project folder and every prompt stays byte-identical.

**It stays out of the registry's own lookups on purpose.** The launcher picks a project to host the server from `listProjects` (`src/launcher.ts` `mostRecentProject`) and resolves it as a workspace, which would mint `.frizz/.id` in the home folder. Only the SERVER's surfaces ask for workspaces — `listWorkspaces`, `findWorkspaceBySegment`, `projectForEntry` — for the project list, routing and tenant priming. `home` is a reserved slug; a project registered as `home` before that keeps its address, and Home then answers on its id.

**Settings → Home folder** (`homeFolder`) is a MACHINE setting. It is validated on save only when it changes (`home-folder.ts` — it must exist, be a folder, and not be a registered project's own folder, whose Claude transcript bucket Home would share), stored trimmed, and stored as `""` when cleared, so no project's older blob can resurrect it. The field checks as the operator types (`homeFolderCheck`) and saves only a value that passes: every settings write carries the whole object, so a draft holding a refused folder would fail every later write with it. A save that moves the folder reopens Home's tenant there at once (`AppContext.reopenHomeWorkspace`); `routeToTenant` and `tenants.activate` also compare `workDirOf`, as they compare a moved checkout's path.

What Home does NOT have: a repository (no GitHub identity, even when the home folder is a dotfiles repo), an icon, a rename, a delete. On the page it is drawn as a house (`ProjectCard.home`): in All projects' list like any project (it holds no place in the drag order), last in the switcher's menu and the prompt box's picker under a rule with its folder beside it, and offered on the welcome page. It is the prompt box's pick only when CHOSEN — `defaultCrossProjectFocus` never falls back to it, so an empty machine still gets the welcome page that adds its first project.

## Frizz plugins (code the operator adds to the control plane)

A **Frizz plugin** is a folder in `<data>/user-plugins/<id>/` whose `package.json` carries a `frizzPlugin` manifest `{ id, api, server, web, claude }` (plans/upstream-superset.md §7). Machine-wide, never per project — a cloned repository must not be able to run code in the control plane by carrying a directory — and enabled by being there: `plugins.disabled` in the machine config turns one off, `FRIZZ_PLUGINS_OFF=1` turns them all off without reading the directory. Not `<data>/plugins`: on a legacy install that is the cc-worker plugin's stage root. In code the word is "plugin"; in copy it is always "Frizz plugins", because "plugins" already means Claude Code plugins on the same pages (the thread menu's Reload plugins).

- **Loading** (`packages/server/src/plugins/loader.ts`). The manifest is read without running anything. `api` must equal `PLUGIN_API` (shared `plugins.ts`); the server half is `await import()`ed on Node's own type stripping (22.18+) and its `setup(host)` is bounded at 5s. Every failure — a bad manifest, another API, a throw, the timeout, an old Node — leaves THAT plugin failed or incompatible with a reason; no plugin can refuse a boot. Plugins import only TYPES from Frizz (`plugins/api.ts`, `web/src/plugins/api.ts`); every value, zod and React included, arrives through `host`.
- **Isolation** (`guard.ts`). Every hook runs inside the guard with a fallback chosen at the call site; three throws fail the plugin for the process, logged under `plugin:<id>`. A refusal (`host.refuse`) is an answer, not a strike, and so is an error BASE throws while doing what the plugin asked (a double click on Start). Not caught: a throw from the plugin's own `setTimeout` reaches `uncaughtException` and ends the control plane — `host.every` / `host.after` are the guarded timers, and `FRIZZ_PLUGINS_OFF=1` is the way back in. A plugin is the operator's own code with no sandbox; the guardrail is visibility — **Settings → Frizz plugins** lists each one's procedures, MCP tools, Claude Code directory, state and failure.
- **Per project** (`plugins/project.ts`, built in `context.ts`). Procedures mount as `plugin.<id>.<name>` in every project's router, under `/_frizz/rpc` and its gates, validated by the plugin's own schema, runtime-only (never in `AppRouter`'s type or the contract gate); one marked `human` joins `HUMAN_THREAD_ACTS`. `threadView` runs over every thread on every board build and writes `ThreadView.plugins[id]`. Events are fire-and-forget: `threadDone` and `rest` are read off what each build drew (a first sighting only primes), `threadDeleted` fires from `deleteOwnedThread`, `humanAct` from the human-verb wrapper. `systemPrompt(kind)` is appended at every dispatch and Claude cold-resume site; a plugin's `claude` directory joins the SDK's `plugins` beside cc-worker at every fork. Each plugin has its own SQLite file, `<data>/plugin-data/<id>.db`, migrated by `PRAGMA user_version`, and a settings record `plugin:<id>` in the machine config.
- **The page** (`packages/web/src/plugins/loader.tsx`) imports each running plugin's web half from `/_frizz/plugins/<id>/…` (types stripped, content-hashed URL, served only from inside the plugin's folder) and calls `activate(host)`. What comes back are SLOTS — `queue.head`, `settings.section`, `newThread.submitAlt`, `thread.composer` — each rendered inside its own error boundary.
- **Held threads** — base's one primitive for a thread with no agent (`session.held_by`, `held-start.ts`). A held row names its holder: base's `schedules` (a schedule's next run) or a plugin's id. Base never tails, never queues and never resumes one; it starts it in place (`dispatch(…, { onto })`) on the same slug and session. A message to a held thread goes to its holder's `onSend`; with no holder (removed, off, failed) or an `onSend` that throws, base starts it on the message — removing a plugin never strands a thread. `session.lazy_prompt` stays every held row's opening prompt, so an older server generation rolled back to still reads the row as unstarted; it is never dropped or emptied.

**Lazy threads are the first plugin** (`plugins/lazy/`, since 2026-10-06; they were base from 2026-10-01). Its note lives in its own database and is mirrored into base's column on every edit; its `threadView` queues its rows unless done or snoozed; its web half is the snail beside Send and ⌘/Ctrl-Shift-Enter in the new-thread box, and the note box (base's `HeldThreadBox`, bound to its note). Nothing installs it: `nub plugins/install.ts lazy` links it into `<data>/user-plugins/lazy` and a restart loads it; `--uninstall` removes the link and keeps its database, and its held threads then start on their next message.

## Switching projects without a document load (the invariants that keep one project's data off another's page)

The singleton's characteristic bug is not a crash: it is **another project's board, transcript or settings rendered under this project's URL, silently**. It shipped once (2026-08-11, `/project/frizz` showing the zod board on every board on the machine), and auditing it turned up two more live instances, so treat this section as load-bearing rather than descriptive. The reason the class keeps recurring is that "which project" used to be AMBIENT — re-derived from `location` by a dozen modules — and never travelled WITH the data, while thread slugs are unique only WITHIN a project. Nothing downstream can tell one project's payload from another's unless the payload says.

**Nothing keeps a second copy of "which project we are on".** The module that HOLDS the live connection answers `feedIsBoundTo(slug)` (`api/socket.ts`); `routes.tsx` asks it rather than remembering. The shipped bug was a `useRef` guard in a component: react-router unmounts one element and mounts another whenever the matched ROUTE changes (the old project grid to a board, a board to a thread page), so the ref was reborn equal to the new slug and reported "already bound" while the socket sat on the previous project. A bystander with nothing to remember cannot get it wrong, and being asked redundantly is free.

**A board must say which project it is, and is refused at the door if it is not ours.** The server stamps `BoardSnapshot.projectSlug`; `setBoard`/`seedBoard` check it through `ownedByThisPage` (`lib/projectOwnership.ts`). This rests on the payload's own evidence rather than on client bookkeeping — which is the thing that failed — and it is what catches the seed race: `seedBoard` takes a board only when the store is EMPTY, which is precisely the state a switch leaves behind, so the previous project's in-flight `rpc.board()` walks straight in. The check is deliberately permissive when the PAGE names no project (the unprefixed launching project) or the PAYLOAD names none (a pre-restart server, a test fixture): refusing on a guess would blank a working board.

**A live connection is stamped with the project it was opened for, and drops what arrives after the page moves.** Both transports do it (`api/socket.ts`, `api/sse.ts`). This is what covers TRANSCRIPT frames, which name a thread and nothing else — no downstream check can tell alpha's `fix-auth` from beta's, so only the socket, which knows what it was opened for, can. A switch is `rebindProject()`, the single entry point, which re-opens whichever transport is live: a session that fell back to SSE switches projects too, and did not for a long time because `rebindSSEProject` sat exported with no caller.

**The query cache is scoped per project at the HASH, not by prefixing keys.** `queryKeyHashFn` (`lib/queryKeyScope.ts`) folds the page's project into every cache-entry identity, so a query written tomorrow is scoped without its author knowing this problem exists. `MACHINE_WIDE` lists the exceptions — the machine-wide reads (`projectsList`, `projectsQueues`, …), and `["ofProject", <id>, …]`, a key that carries its project itself. There is no per-switch cache wipe any more, and that is a gain: one project's entries are invisible to another rather than deleted in front of it, so switching back finds a warm cache and a late response has nowhere wrong to land.

**Anything that outlives the moment it was started captures its project BEFORE it — an `await`, and a callback that fires later.** `apiBase()`/`projectSlug()` answer for whatever the address bar says at the instant they are called, which is correct at send time and wrong in a continuation. Reading a large file is long enough to switch projects, which is how an attachment came to be filed in a project the message was never going to (`Composer.uploadAttachment`). A desktop notification is worse, because it is raised only while the window is HIDDEN and clicked whenever the operator comes back: its click handler now carries the project it was raised for (`notify` in `api/board-stream.ts`), instead of opening that slug in whatever project is on screen — which did not fail, it opened a different thread that happened to share the name.

**A surface showing ANOTHER project's thread must name that project on every call.** On the cross-project page every "which project" helper above answers the FOCUS, and every other project's card is somebody else's, so each card carries its own: reads and writes go through `projectRpc(projectId)` (`api/rpc.ts`, addressed by id), cache keys start `["ofProject", projectId, …]`, prose renders under `MarkdownScopeContext` (the project's repo, directory and app path — never the module-global repo), the shared Snooze and Mark-as-done buttons take their client from `ThreadProjectScope` (`api/threadApi.tsx`) and skip the page-level overlays keyed by bare slug — a steer sent from a card or a row is filed under the thread's key instead (`lib/steering.ts markSteeredIn`), which the project list reads back for that project's row (`lib/listBands.ts`), a thread terminal's Stop and its `/term/<id>` socket on a card go through the same scope (`useThreadApiBase`), and the reply box uploads to `projectApiBase(projectId)`. A same-slug thread in two projects is the case that proves it; `scripts/verify-all-queues.mjs` drives it in a real browser, along with the page itself (opening in place, returning to the pick, a follow-up from a tenant's drawer, a tenant thread's terminal at a prompt). And anything WAITING to be sent captures its project when it is committed, not when it goes out — a follow-up queued behind another (`SendTarget`, `lib/eagerComposerSubmission.ts`) or a toast's "Open thread" (`ToastLink.project`) — because on this page the focus moves whenever a drawer of another project opens.

**A URL naming a project that does not exist is answered by the SERVER.** `/project/<slug>…` and `/all/<slug>/…` are SPA routes, so the client used to be handed the app for a slug nobody has (renamed, removed), whereupon every call 404s, the board never lands, and the page retries forever on its boot spinner. `unknownProjectPage` (`packages/server/src/index.ts`) redirects to `/?unknown=<slug>`, and the page says what happened in a toast ("No project named …") as `/` sends it on to the last view. It matches `/project/<slug>` and `/all/<slug>` (`/project/` was off the list from 2026-09-28 to 2026-10-06, while it named nothing).

Two browser-level checks live in `packages/web/src/lib/projectSwitch.e2e.test.ts` (opt-in — see its header for the `adhoc-stack.mjs` invocation and the `FRIZZ_PROJECT_SWITCH_E2E_URL` env). The unit-level pins are `api/projectFeed.test.ts`, `lib/projectOwnership.test.ts` and `lib/queryKeyScope.test.ts`; each has a negative control, which is the bar to keep when adding to them.

## CLI launcher

Two entry points, deliberately distinct:

- **`npx frizz`** installs a stable, small `frizz` shell that resolves a compatible `frizz-server`
  generation into an immutable managed directory. The shell package contains only `dist/frizz.js`;
  its `frizzServer` manifest field names the default server package/version and compatibility epoch.
  `prepare-package.mjs --server` stages the public server's runtime closure at
  `packages/server-release/`: `web-dist/` (built client), `runtime/board/` (the board parser the
  server shells out to), and `runtime/cc-worker/` (the worker plugin dispatch loads), while
  `build-package.mjs --server` emits `dist/dev-child.js` plus every detached daemon sibling. The
  runtime tree MUST keep board and cc-worker as siblings because the worker shims reach back
  relatively (`../../board`); it is a COPY rather than a `files` entry naming source directories, so
  every public server path remains build output. Root prepack intentionally leaves this staging in
  place: `npm pack --ignore-scripts packages/server-release` is the reproducible standalone server
  pack after a root build. Both build paths assert the same closure (`src/worker-plugin-closure.ts`);
  widening it is one edit.
- **`frizz-dev`** (`nub run frizz-dev:install`) is source-backed at launch only: the shim holds an
  absolute pointer to this checkout's CLI entrypoint. On each fresh launch it selects a
  verified immutable artifact matching the current source fingerprint, reuses an identical global one,
  or builds and promotes one. **The running server never watches the checkout and never runs HMR** —
  edits do nothing until you stop frizz and relaunch.

State is keyed by a stable checkout UUID: an ordinary worktree keeps it in `git config --local frizz.id`,
each linked worktree in its private Git admin dir, so siblings stay isolated. Canonical real paths make
a checkout opened through a symlink reuse the same instance. The project id and its state dir are the
whole identity — there is no multiplexer and nothing else to key.

### Stable server updates

The registry launcher owns the public proxy and recovery listener for its entire lifetime. It installs an exact `frizz-server` version with npm's JavaScript entry under the current Node executable, with lifecycle scripts disabled and a private prefix. No shell startup hooks, global provider upgrades or project permission changes are part of this operation. The server needs no lifecycle script on any platform: its only native addon, `@parcel/watcher`, ships each platform's binary as an optional package. Sign-in ran on node-pty until 2026-09-24, which publishes no Linux prebuild, so every Linux and WSL generation died at boot ([#42](https://github.com/colinhacks/frizz/pull/42)); it runs the provider CLI over pipes now.

An update stages and validates the candidate while the old server continues serving, drains the old child, then starts the candidate. After authenticated readiness and a short stability interval, it atomically commits the active generation. Candidate failures restore the previous same-epoch selection. Frontend assets, provider daemons and worker plugin files come from that same immutable server generation; retained generations protect detached workers still using their files.

A global generation-checked lease in the Frizz state root keeps stable launchers from starting separate schedulers across repositories or custom ports. Each server child registers as a delegate before opening application state. After a launcher crash, a replacement cannot acquire that lease until its live delegates have exited. A second launch joins the recorded public listener even while the application child is unavailable.

Protocol and data epoch are explicit compatibility contracts. Ordinary updates reject a mismatched epoch before draining. An explicitly newer compatible shell may stage its exact next-epoch bootstrap server, but advances a global compatibility marker before that server can write data; lower-epoch shells then fail closed, including after a pre-readiness crash. Protocol changes require a separately designed migration. Pre-split binaries cannot honor a marker they predate, so manually downgrading to those releases is unsupported.

### Browser launch modes

The default launch makes one standard OS request to open the localhost URL in the default browser; the
browser decides which window receives it. frizz does not scan, reuse, focus, or privately address tabs.

`--app` preserves the legacy dedicated/chromeless window as an explicit opt-in. On macOS that window
gets its own Dock name and icon: on first opt-in launch the launcher silently installs the frizz PWA
into the project's browser profile over CDP (`--remote-debugging-pipe` → `PWA.install` +
`PWA.changeAppUserSettings(displayMode: standalone)`; windowless, ~3-4s, once per machine). Chrome then
generates a real app-shim bundle at `~/Applications/Chrome Apps.localized/frizz.app` and every launch
goes through it. Why it works this way (all verified empirically on Chrome 150 / macOS):

- A plain `--app=` window is owned by the Chrome browser process — the Dock shows "Google Chrome", no
  launch flag changes it, and a hand-rolled `.app` that `exec`s Chrome loses its identity the moment
  Chrome's Cocoa startup re-registers the process. Chrome's generated app-shim is the only mechanism
  that yields an own Dock identity.
- The CDP `PWA.*` domain is only exposed on `--remote-debugging-pipe` connections (port-based
  websocket clients lack `AllowUnsafeOperations`), and a CDP install defaults the app to open-in-a-tab
  — `changeAppUserSettings(displayMode: "standalone")` is the required second half.
- Shim detection is stateless: scan shim `Info.plist`s for `CrAppModeShortcutURL` == the launch URL and
  `CrAppModeUserDataDir` under the project profile. (Chrome's generated app id is NOT a reproducible
  hash of the URL — don't try.)

Failure at any opt-in app step falls back silently to a plain `--app` window.
`packages/web/public/favicon.svg` is the canonical artwork; `nub scripts/generate-icons.mjs`
regenerates its six tracked PNG derivatives (`--check` detects drift, `--refresh-app-icons` refreshes
ICNS in idle shims). *Windows/Linux Dock branding is an unwired TODO:* Windows would set an
`AppUserModelID` on a generated `.lnk`; Linux (X11) would pass `--class=frizz` + a `.desktop` file whose
`StartupWMClass` matches.

### Desktop app

[`packages/desktop`](packages/desktop/README.md) is Electron, used as a thin client — the one thing it
must never be is a second place the server runs. The server loads native addons (`node-pty` for thread terminals) built for the SYSTEM Node,
which Electron's embedded Node cannot load, and the launcher already owns starting it (lease, port,
self-update, recovery). So the app joins the server the owner record names, or a well-known port's
server that proves this user's launch token (`ownedFrizz` — loopback answers for every account and
for `--sandbox`), and otherwise runs `node <launcher> --no-app` exactly as a terminal would:
**detached, output to a file**, because the launcher supervises the server and would die with the app
on its pipes. It resolves the launcher with `npx -y frizz --_frizz-print-launcher`, under a login
shell's environment, since a Dock-launched app gets launchd's bare PATH and the server hands its
environment to every agent. Quitting leaves the server running.

What it adds over a tab is only what a browser gives a tab free — external links to the OS browser, an
Edit menu, back/forward, a context menu, window state — plus one preload bridge (`frizzDesktop`), whose
only web-side caller is the notification click in `board-stream.ts`, since `window.focus()` cannot
raise an Electron window. `electron` is its one dependency; electron-builder is fetched per
`desktop:dist` run, never installed. [`desktop.yml`](.github/workflows/desktop.yml) publishes unsigned
installers to the GitHub release `desktop-v<version>` from `release`, each installed and launched on its
own OS first.

### VS Code extension

[`packages/vscode`](packages/vscode/README.md) connects each editor window to the one server, in both
directions: a selection becomes a new thread (Ask Frizz), a follow-up (Send to Frizz thread) or a chip
in the page's prompt box (Add to Frizz prompt), and a file link clicked on the page opens in the window
that has its folder open, at the line it names. Design and protocol: [`plans/vscode-extension.md`](plans/vscode-extension.md).

- **The extension dials the server, never the reverse.** Each window holds one WebSocket to the
  MACHINE-WIDE `/_frizz/editor` (`server/src/editor-bridge.ts`), answered in `index.ts`'s upgrade
  handler before tenant routing. It says which folders the window has open and whether it has focus;
  the server sends it files to open, folders to raise, and every project with its Queue and Running counts (`ready`/`working` on the wire).
  Frames are pinned in `shared/src/editor-protocol.ts` (plain types the extension bundles) and validated
  by their zod twins in the shared index. Ask and Send use the ordinary RPCs, addressed by project id.
- **`openLocalFile` tries a connected window first** when the External app names its editor family
  (`vscode`, `cursor`, or `$EDITOR`'s), choosing the window whose folder contains the file, then the
  most recently focused one on the same machine; otherwise it spawns the CLI as before, now with
  `-g path:line:col`. Positions travel as `line`/`column`/`endLine` beside the path, parsed by the one
  grammar in `shared/src/file-position.ts` (`a.ts:12:3`, `a.ts#L12-L20`).
- **Prompt-box inserts are claimed, not broadcast.** The server holds what an editor sends and
  publishes a payload-free `compose-pending` on every open project's bus; the page that has focus takes
  it with `composeTake`, so exactly one tab inserts it (`web/src/lib/editorBridge.ts`).
- It finds the server the way the desktop app does (the address record, trusted only with a live owner
  generation behind it, as `readStableServerOwner` checks; then the well-known ports with the
  launch-token proof), plus frizz-dev's `dev-supervisor.lock`, and declares `extensionKind: ["workspace"]`
  so a Remote-WSL or SSH window runs it where the files and the server are. It ships as a `.vsix`
  (`nub run vscode:package`, `vscode:install`); `@vscode/vsce` is fetched per run, never installed.
  `packages/vscode/scripts/e2e.ts` drives a real VS Code under Xvfb against a fake Frizz (on stable and
  on the manifest's oldest VS Code), or with `--stack` against a disposable two-project Frizz it boots
  itself, with a headless page that must receive the prompt-box insert.

### Running against a repo outside this monorepo

Set `FRIZZ_SCRIPTS_DIR` to the board parser directory and `FRIZZ_WORKER_PLUGIN_DIR` to the `cc-worker`
plugin directory. The published package does this for you.

## Conventions

- TypeScript run directly by Node in a source checkout (type stripping) — no build step for
  server/cli; Vite builds web. The published package ships compiled JS instead (a dependency under
  `node_modules` cannot be type stripped), so a consumer's Node floor is `engines`, not this one.
- ESM everywhere, `type: "module"`.
- Comments sparse and dense: design/invariant/provenance only.
- Tests: `node --test`, colocated `*.test.ts`, minimal + contract-shaped.
- UI state (unread, lastReadAt, session registry, settings) lives in ONE SQLite file for the whole
  machine, `~/.frizz/ui.db`, every row tagged with its project id (`packages/server/src/frizz-db.ts`;
  one file per project under `~/.frizz/projects/<projectId>/ui.db` until 2026-08-27 — a leftover is
  imported once on the next boot, recorded in `imported_project`, and left in place so an older build
  still finds it). An ordinary/main worktree's UUID remains the repo's
  `.git/config` key `frizz.id`; a linked worktree stores its own UUID at
  `<worktree-gitdir>/frizz.config`, preserving ordinary state while isolating sibling DB and lock
  namespaces. NEVER store UI state in the checkout's `.frizz/`.
- **Sidebar design philosophy (2026-07-09, maintainer-directed — don't regress it).** It was written
  for one project's board rail; since 2026-09-28 it governs the one page's left column instead — the
  status row, the prompt box and the project list under them (`AllQueues.tsx`'s `aside`, on
  `SIDEBAR_COLUMN_CLASS` from `Sidebar.tsx`) — and the bands below are each project's, under its row
  (see **Board nomenclature**). A FLOATING
  left column: NO background, NO border, NO clipping on the column itself (the New-thread pill's
  hover-scale must never clip; only the section LIST is a scroll container). A sticky full-height
  wrapper, but TOP-anchored (48px down) rather than vertically centered as the board's was: a click in
  the list changes its height, and a centred column moved the prompt box and the row just clicked out
  from under the pointer. The inner column grows to `max-h-[calc(100vh-68px)]` and scrolls internally
  only past that cap; horizontal overflow impossible by width discipline: min-w-0 everywhere +
  break-words titles. Width scales `clamp(272px, 34vw, 680px)`; it and the 720px queue sit as a
  centered pair across one `clamp(28px, 3.4vw, 52px)` gutter, stacking below 800px. Row groups keyed
  on the session-first model (`sectionOf`), in the vocabulary above, per project: on a board, Pinned,
  Queue and Running under their names, then the folded Snoozed, Done and External bands; on All
  projects, the Pinned, Queue and Running rows under the project's row, and the quiet bands as counts.
  Rows order by most-recent USER interaction (`orderByInteraction` — agent churn never
  reorders), except the Rested band, which uses the EXACT queue comparator (`orderQueue`, keyed on when
  each thread entered the queue) so the rail and the cards read in one order.
  Titles WRAP, never truncate. ONE derived indicator per row (spinner running, blue ● a live background
  shell — in Active AND in its snoozed twin, since 2026-08-31; GitHub's octocat for a PR wait and the
  hourglass for a timer wait, each in WHICHEVER band the row sits — a timer park queues, and its queued
  row wore the shell's dot until 2026-09-07; the hourglass for a user snooze, "?"
  needs-action, "!" stalled, faint · idle); a petite-caps PLAN tag marks a doc with a
  `## Plan` section (derived `hasPlan`). Rows are clicked, not walked — no arrow-walk, no
  chevron, no focus machine (all deleted): a row click opens the thread's drawer in place (chat; the
  frizz DOC composite for a never-spawned thread — `store.openThread`) — a Queue row whose card the
  queue is showing scrolls to that card instead. The keyboard is a set of REBINDABLE shortcuts
  (`lib/keybindings.ts` defines them, `lib/keyboardRuntime.ts` runs them, the `?` sheet lists and
  rebinds them): `j`/`k` step through the queue's cards; `r` reply, `d` done, `s` snooze and `f`
  fullscreen press the real control on whatever is in front of you — the top drawer, the /full page,
  or the card being read; `t` opens a terminal on that thread; `c` starts a thread and `n` adds a project. A plain key is inert
  while you type in a field and under any overlay (a thread drawer is not one, at any width); ⌘K
  (palette) and ⌘I (details) work anywhere, and Esc unwinds overlays then drawers. A machine with
  NO usable project gets the welcome page at `/` instead of the column (the zero-thread board, which
  hid its sidebar and centered the dispatch prompt as the whole screen, went with the board on
  2026-09-28).

## Provisioned runtimes (Frizz owns the Claude Code and Codex it runs)

A worker is NOT whatever `claude` or `codex` is first on the operator's PATH — it was until 2026-09-04, and that left half of each pair unpinned: the bundled Claude Agent SDK is built against ONE Claude Code build (`claudeCodeVersion` in its package.json, shipped as a matched platform package the SDK resolves by itself when handed no path), yet Frizz handed it PATH's binary, fifty-odd releases ahead on the maintainer's own machine, over a private wire nothing audited. Codex had the audited pin (`CODEX_APP_SERVER_SUPPORTED_VERSION`) but no binary behind it, so the gate merely WARNED on a newer build and the conformance test skipped on any machine that had moved on.

`packages/server/src/runtimes.ts` is the single source: one pin per backend, resolved in the `runtimes` boot phase (right after launch ownership, before the context, because every consumer — the broker bridge, the app-server daemon, `claude auth status`, the logout action, the quota readers — takes the executable as a plain string from the context). First boot on a machine fetches each exact platform binary from the vendor's own npm package (`@anthropic-ai/claude-agent-sdk-<os>-<arch>@<sdk>`, `@openai/codex@<version>-<os>-<arch>`) into `<cache>/runtimes/<backend>/<version>/`, verified against the registry's sha512 and renamed into place only complete; the launcher readout follows the download through boot progress. Every later boot is a marker read.

- **Resolution order:** an explicit executable (`StartOptions.claudeBin`/`codexBin`, or `FRIZZ_CLAUDE_BIN`/`FRIZZ_CODEX_BIN`) wins and is never provisioned around; then the pin; then the bare name on PATH as a WARNED fallback, so an offline machine still dispatches and the log says the version seam is open. `FRIZZ_RUNTIMES=path` skips provisioning (the test runner sets it — a suite must never pull half a gigabyte); `FRIZZ_RUNTIMES_DIR` relocates the root (the ad-hoc stack points a sandbox HOME at the machine's real copies).
- **Bumping a pin is a release.** The SDK version moves in `packages/claude-agent-sdk-runtime` and `CLAUDE_CODE_VERSION` follows it — `runtimes.test.ts` pins the pair to the SDK's own manifest. The Codex coordinate is the audited one and moves with the re-audit.
- **A provisioned Claude Code runs with `DISABLE_AUTOUPDATER=1`**, set on the server's own environment so every worker and every auth probe inherits it; otherwise the pin updates itself out from under Frizz.
- **The sweep keeps only the current pin**, plus any `.partial-*` younger than a day (another process may be mid-download). Nothing under `runtimes/` is precious — it is the cache root, regenerable by definition.
- **Not reused on purpose:** the vendors' own versioned installs (`~/.local/share/claude/versions/`, `~/.codex/packages/standalone/releases/`). Both prune on their own schedule, and a pin that can vanish under a running server is worse than one download.

## Codex app-server bridge (the only Codex transport)

**Codex is a first-class backend, not an experiment.** A `backend: "codex"` dispatch runs through `backend/codex-app-server.ts` and nothing else, since 2026-08-02 (`f926288f`: "both backends have exactly one transport now — codex → app-server, claude → broker"). The old opt-in flag is gone: `codexAppServerBridgeEnabled()` returns true unconditionally and the context wires the bridge at boot. This section read "Disabled by default … do not enable this flag" until 2026-09-14, and a worker that trusted it over `dispatch.ts` reported Codex as unfinished work to the maintainer — prefer the code.

- The bridge is deliberately not an `AgentBackend`: it starts new sessions and resumes only native thread ids in its own SQLite ownership table, so no existing/default/TUI Codex session can cross the boundary. The default transport is the native listener (`codex app-server --listen unix://`, `FRIZZ_CODEX_NATIVE_LISTEN`), which owns its own socket and outlives every Frizz process; the hand-written daemon is the fallback.
- **The audited coordinate is `CODEX_APP_SERVER_SUPPORTED_VERSION`** (`0.154.0` at the time of writing, source tag `rust-v0.154.0`), and the acceptance rule is a FLOOR that refuses and a CEILING that only warns (`codexVersionVerdict`): an older binary is refused because it may lack params Frizz sends; a newer one runs with one loud warning, because the protocol is additive and `codex-protocol-conformance.test.ts` asks the installed binary for its own schema and fails when a param Frizz sends is gone. Moving the pin is a re-audit at the matching immutable Rust tag, then new fixtures. Frizz provisions that exact binary itself (see Provisioned runtimes).
- The wire is JSON-RPC after `initialize` / `initialized`. It rejects versioned `jsonrpc` envelopes, bounds and serializes inbound records, and never retains stderr text. No PTY or terminal scraping. `turn/steer` delivers a mid-turn follow-up and `turn/interrupt` stops a turn; both are wired.
- The child receives an explicit minimal environment, not `process.env`: executable/runtime/home,
  locale/temp, OS credential-store plumbing, proxy/custom-CA settings, and only the audited built-in
  Codex/OpenAI auth/provider variables. Frizz, GitHub, Anthropic, AWS, Node injection, and arbitrary
  `CODEX_*`/`OPENAI_*` values are excluded. Arbitrary custom-provider `env_key` support remains out of
  scope until it can be derived and approved without forwarding unrelated secrets.
- Provider responses are durably claimed once, but the interaction journal remains pending until
  Codex emits `serverRequest/resolved`. A disconnect never blindly replays an unknown send; a newly
  witnessed matching server request is required. Session/turn ownership, provider RPC ids, and
  response acknowledgements remain connection-epoch and project-session scoped. Secret user-input
  delivery fails closed until a secure transient escrow exists.
- Exact response semantics are intentionally narrow: additional permissions expose turn/session
  grants plus deny (the server treats an empty granted profile as no grant), while
  `request_user_input` exposes only answer. That protocol has no decline/cancel response; cancelling
  work is the separate `turn/interrupt` client request, never a fabricated interaction choice.
- Registry replacement/deletion atomically cancels old delivery rows and detaches the exact native
  binding before a lifecycle hook removes it and terminates the child. Bridge disconnect/close
  detaches active bindings, and action authority requires a live connection plus the exact active
  binding/epoch. Ordinary TUI sessions have no matching binding and are untouched.
- Scoped interaction reads expose only a provider-neutral delivery effect. `awaiting-user` is the
  sole provider-backed state that enables controls; durable `queued`/`sent` projects as noninteractive
  “Sending to runtime…” across remounts and restarts, and a missing bridge projects as
  `reconnect-required`. Transport ids, provider context/responses, and secret values never cross this
  RPC boundary. The board retains pending thread visibility but removes queued/sent work from Needs
  You until a genuinely actionable request exists.
- Still out of scope on purpose: arbitrary custom-provider `env_key` forwarding (above) and secret user-input delivery, which fails closed until a transient escrow exists.

## ACP backend (any Agent Client Protocol agent, as a third backend)

**`backend: "acp"` is the generic fallback beside the two rich integrations, added 2026-09-15 (design: [`plans/acp-backend.md`](plans/acp-backend.md)).** Claude keeps the SDK broker and Codex keeps the app-server bridge — quota chips, account actions, sub-agent telemetry, per-thread model/effort/permission controls all stay theirs. An ACP thread gets what the protocol carries and nothing invented on top: streamed text and reasoning, tool calls with status, permission requests as cards, a queued follow-up, cancel, and resume after a restart. Verified end to end on a disposable stack against `opencode acp` 1.18.29: the frizz MCP tools were called through the real server, a `write` and a `bash` permission card each round-tripped, a follow-up sent mid-turn queued and delivered the instant the turn ended, `killAgent` cancelled a running `sleep` through `session/cancel`, and a follow-up after a server restart answered from the `session/load`-replayed history.

- **The agent is a model, and the agent's model rides the same slug.** The composer's profile grid lists every ACP agent found on the server's PATH under "ACP agents" with one `Default` cell (an agent runs on its own CLI's effort — Frizz has no effort axis to offer), and a MODEL DROPDOWN beside the pill (`AcpModelSelect`, 2026-09-16, maintainer: "a dropdown picker, not the grid") lists the models the agent itself advertises — ACP exposes them only as a session's `model` config option, so `rpc.acpAgentModels` opens a throwaway session per agent, reads the option and caches it ten minutes (`AcpBridge.agentModels`). The thread carries `model: "acp:<agent>"` or `"acp:<agent>@<model>"` (`@`, because model ids contain `/` and `:`; helpers in `@frizz/shared`), `backendForModel` reads the prefix as `acp`, the bridge asks for the model with `session/set_config_option` when it opens a session (a refusal becomes an `acp-note` and the session runs on the agent's own model), and `setThreadProfile` on a live ACP thread switches it in place through the same request — the AGENT half of the slug is refused, since the session belongs to the process that opened it. The catalogue is `backend/acp-agents.ts` (opencode, cursor-agent, gemini, copilot, kilo, qwen, goose, kimi — each the executable plus the argument that puts it into ACP mode) merged with `settings.acpAgents`; agents are PATH-resolved and NEVER provisioned, and their credentials are their own CLI's (`AccountBackend` narrows sign-in, quota and logout to Claude and Codex; `/login` on an ACP thread says so).
- **Transport:** `backend/acp-rpc.ts` is a hand-rolled newline-delimited JSON-RPC 2.0 client over the child's stdio (`initialize` v1 → `session/new` or `session/load` → `session/prompt`, the prompt's response being the end of the turn). No `@agentclientprotocol/sdk`, no PTY, no scraping. One agent per live thread, held in a DETACHED DAEMON (`backend/acp-daemon.ts`, attached through `backend/acp-host.ts`, 2026-09-24) the same way the Claude broker and the Codex app-server are: a Frizz restart or crash only drops the socket, the agent and its running turn (and every sub-agent inside it) keep going, and the bridge (`backend/acp-bridge.ts`) reattaches at the next boot (`warmUp`), adopting the in-flight `session/prompt` as the live turn and raising afresh any permission card the dead runtime was holding — the daemon rewrites request ids, caches `initialize`, queues everything the agent says while nobody is attached, and re-sends an agent request nobody answered. Opening a session is SINGLE-FLIGHT per session id (`openOnce`): the waker and an operator's send reaching a session with no live agent in one instant used to fork two daemons on one socket path and fail both sends (`scripts/verify-daemon-socket-takeover.mjs`, which also covers the Codex daemon). Like the broker, the ACP and Codex daemons judge their socket by inode (`backend/socket-ownership.ts`): a dying one removes the socket file only while the path still leads to it, and an unattached one whose socket file is gone self-collects (`self-collected-socket-lost`). Only a session whose daemon actually died is re-opened on the next follow-up with `session/load` when the agent advertised `loadSession`, else a fresh session with an `acp-note` saying the earlier conversation is gone. Mark as done, dismiss and replace end the daemon (`releaseSession`). The child's environment goes through `inheritWorkerEnvironment`, never raw `process.env`.
- **The transcript is Frizz-written.** ACP has no on-disk session format Frizz could tail, so the bridge writes `<stateDir>/acp/<frizz session id>.jsonl` — an `acp-session` header (agent, ACP session id, cwd, model) then NormalizedEvents as the tailer already folds them (`backend/acp-transcript.ts`). The stem is ALWAYS the frizz `session_id`; `agent_session_id` holds the agent's own session id for `session/load` only, and every reader that switches on backend (tailer prime, `sourceForThread`, `projectSnapshot`, the cursor, `readThreadTranscript`) has an acp arm keyed that way — the first live dispatch spun `running` forever because the tailer built the stem from `agent_session_id`. ACP rows skip the Claude discovery sweep and the perm-marker read exactly as Codex rows do.
- **Permissions are cards with canonical ids.** `session/request_permission` becomes a `command-approval` (bash-like) or `file-approval` (edit-like, with the agent's diff preview) interaction whose decisions are `accept` / `acceptForSession` / `decline`; the agent's own `optionId`s stay beside the pending entry and the chosen one goes back on the wire. A turn ending or the session being released cancels its open cards. Whether an agent asks at all is the agent's configuration (opencode: `permission.edit`/`permission.bash` in `opencode.json`; its default in ACP mode allows edits silently).
- **Follow-ups queue; there is no steer.** A follow-up during a turn is held by the bridge and sent as the next `session/prompt` when the turn ends (the delivery ledger draws it as the gray queued bubble meanwhile); `killAgent` is `session/cancel`, after which the queue drains. A cancelled turn records `turn-end` with `successful: false` plus an `acp-note`, and a zero-token `usage_update` (opencode sends one on cancel) is dropped rather than emptying the context dial.
- **Deliberately not integrated:** quota/usage chips, sub-agent and background-shell telemetry, per-thread effort and permission changes (the RPCs refuse an ACP thread; the model is the one profile axis it has), the `fs/*` and `terminal/*` client methods, and hibernation. Each is a separate effort on top of the seam, not a gap in it. (The detached host that lets a turn outlive the server was one of these until 2026-09-24; it exists now, above.)
- **Verifying it needs a real agent:** `scripts/adhoc-stack.mjs --creds` links `~/.local/share/opencode` into the sandbox HOME for opencode's own credentials; `backend/_live_acp_opencode.mts` is the manual wire probe; the fake agent under `backend/acp.fixtures/` drives the protocol, bridge and transcript tests without a vendor CLI.
