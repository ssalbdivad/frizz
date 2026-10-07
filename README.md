<p align="center">
  <h1 align="center"><img src="assets/logo-concepts/final/fff-tile.png" alt="" width="104" height="104"><br/>Frizz</h1>
  <p align="center">An opinionated agent console for extreme productivity.
    <br/>
    by <a href="https://x.com/colinhacks">@colinhacks</a>
  </p>
</p>
<br/>

<p align="center">
<a href="https://opensource.org/licenses/MIT" rel="nofollow"><img src="https://img.shields.io/github/license/colinhacks/frizz" alt="License"></a>
<a href="https://www.npmjs.com/package/frizz" rel="nofollow"><img src="https://img.shields.io/npm/dw/frizz.svg" alt="npm"></a>
<a href="https://github.com/colinhacks/frizz" rel="nofollow"><img src="https://img.shields.io/github/stars/colinhacks/frizz" alt="stars"></a>
</p>

<br/>

Frizz is for you if you have any of these opinions:

- Terminal UIs are dated and have fundamental limitations that are incompatible with good user experience.
- Orchestrator-style apps like Conductor feel overly complex.
- It's annoying to constantly switch between sessions to check in on my agents' progress.

<br/>

<h2 align="center">Getting started</h2>

**Requirements.** Node 22.13+, and a [Claude Code](https://claude.com/claude-code) or [Codex](https://developers.openai.com/codex) subscription you are signed in to — Frizz drives the subscription you already pay for. Frizz brings its own pinned copy of each CLI (downloaded once, on first start), so the version on your PATH is yours to manage and never changes what a thread runs. Any other agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com) — OpenCode, Gemini CLI, GitHub Copilot CLI, Cursor's agent, goose, Qwen Code and more — runs too, from your PATH.

Then run it in any directory — a repo, a jj checkout, or a folder of scripts. Frizz has no opinion about version control and does not require Git.

```sh
$ cd path/to/acme
$ npx frizz

  FRIZZ v0.4.0  ready in 4.0s

  ➜  Local:    http://127.0.0.1:9393/
  ➜  Project:  acme — path/to/acme
  ➜  Logs:     ~/Library/Application Support/Frizz/projects/979dae3c-fe15-4038-817e-11d0e7491959/logs/frizz-2026-08-01T13-44-43-16931.log

  press ctrl-c to stop · run with --debug for the full event feed
```

A browser tab opens at `http://127.0.0.1:9393/`. Frizz always listens on port 9393 (19393 if something else holds it), and one server serves every project on the machine on one page. A directory you run it in becomes a **project** on that page — at once for a repository or anything with a `package.json`, `Cargo.toml` and the like, and after a confirmation for a plain folder — so running `npx frizz` in a second repo adds that project to the server already running rather than starting another. Runs on macOS, Linux, and Windows.

Prefer a window of its own to a browser tab? The desktop app is on [GitHub releases](https://github.com/colinhacks/frizz/releases?q=desktop) for all three — unsigned builds, so the first launch asks once. It needs the same Node, and starts or joins the same server.

Work in VS Code, Cursor or Windsurf? [The extension](packages/vscode/README.md) lets you select code and ask Frizz about it, and opens Frizz's file links in your editor at the line they name.

<p align="center">
  <img src="assets/board.png" alt="Frizz focused on one project: the prompt box and the project's threads on the left, and on the right the first queue card, where an agent asks whether the settings store should use SQLite or a JSON file, with lettered options and a countdown to the recommended pick." width="100%">
</p>

<br/>

<h2 align="center">Features</h2>

Frizz is a browser tab, a queue, and the agent CLIs you already pay for. It brings no model of its own, automates none of your workflow, and keeps every opinion it does have in a text file you can edit.

- 🗂️ **A task queue, not a sidebar.** Every agent that comes to rest needing you becomes a card. Work the queue top to bottom instead of polling ten terminals.
- 📁 **Projects.** Every directory you run it in becomes a project, all on one server and one page: every project down the left with its threads, and every card waiting on you beside them.
- 🔌 **Headless.** Every thread's agent runs in its own detached background process. Close the tab, quit the browser, ctrl-c the server, reboot — your threads are all still there when you come back, and Frizz reconnects to the ones still running rather than replaying them from disk.
- 🤖 **Claude Code, Codex, and any ACP agent.** Pick the agent per thread and run several against the same repo at once. Frizz supports Claude Code and Codex subscriptions — your sign-in, your settings, your skills, driven by a copy of each CLI that Frizz pins and provisions itself — and any agent that speaks the Agent Client Protocol.
- ⏰ **Schedules.** Type "every weekday at 9am triage new issues" into the prompt box and Frizz reads the schedule out of the words as you type. Each run starts a fresh thread that lands in the queue like any other.
- ⏱️ **Time limits.** Give a thread "2h" or "until 15:30". The agent plans for the best result it can deliver by then, gets reminders as time runs out, and passes a share of the time to its sub-agents. The card counts down.
- 😴 **Snooze.** Not everything needs an answer now. Park a card for an hour, until tomorrow morning, or until a date you pick — optionally with a follow-up prompt attached, so the thread wakes up already working on what you told it to do next.
- 🎯 **Goals.** Give a thread a standing goal that Frizz re-sends as a prompt — every time it comes to rest, on a clock you set in minutes, or both. Good for "keep going until CI is green" without you re-asking. A scheduled one reaches the agent even mid-turn, so it can nudge a thread that never stops. Cap it by runs or by time, switch it off whenever, or let the agent say it's finished.
- 🔗 **Threads that talk.** Every thread has an `@handle`. Mention one in a prompt, and agents read and message each other's threads by handle. `#project` names a project. Spin a new thread off any card, carrying its context with it.
- 🐙 **GitHub integration.** Browse your repo's issues and pull requests without leaving the composer, and turn a selection of them into threads. Workers can read issues, diffs, and CI on their own.
- 👀 **Built-in CI, PR and issue watchers.** A worker waiting on a build, a review or a reporter's reply doesn't hand the thread back to you to be told "keep going." It watches, and picks the work back up when the run goes green, a review lands, or someone comments.
- 📱 **On your phone.** The page has a phone layout: the queue, snoozed and done threads and schedules in tabs, questions answered with a tap.
- 🧑‍💻 **Your editor.** [The VS Code extension](packages/vscode/README.md) puts Frizz in a sidebar, sends your selection with a message, lets agents read what you have open, and shows a thread's changes as a multi-file diff.
- 📝 **No magic.** A thread behaves like a Claude Code session you started yourself. Frizz adds no branches, no dev server, no build integration, no workflow engine to fight with.
- 🔒 **Local only.** No cloud, no account, no telemetry. The server binds `127.0.0.1` by default and its state lives in your user directory, never in your checkout. To reach it from a phone, press R in its terminal — see [Remote access](docs/remote-access.md).

### Projects

Every directory you run `npx frizz` in becomes a project, all served by the one Frizz on your machine. Frizz is one page, at `http://127.0.0.1:9393/`: your projects down the left with the threads in flight under each, and every card waiting on you beside them. A project's snoozed and done threads show as small counts on its row; click the row to list them in place, and drag rows to reorder them. The page's title, top-left above the prompt box, switches between **All projects** and a single project. Focused on one, the list, the queue and new threads are all that project's. ⌥↑/⌥↓ step between projects. A thread opens in a drawer beside the page, and its ⋯ menu can take it fullscreen.

<p align="center">
  <img src="assets/projects.png" alt="The All projects page: billing-worker, marketing-site and acme-api each list their threads on the left, and the ready cards from every project are queued on the right." width="100%">
</p>

Work that belongs to no project yet — cloning a repository, a question about your machine — starts in **Home**, the last choice in the prompt box's project picker. Its agents run in your home folder, or in the folder you set under **Settings → Home folder**, and its threads are listed under Home in the project list like any project's.

### The queue

A sidebar of sessions makes every agent something you have to remember to go check. Frizz gives you one queue instead.

When an agent comes to rest needing you, a card is added to it. You can quickly evaluate what it has done since your last message and decide to answer its questions, steer it, snooze the card, or mark the session complete. You're continuously presented with a set of action items in one place, instead of constantly switching back and forth between sessions.

The queue is strict about what earns a card, which is what keeps it a real todo list. A thread resting only because *its own* helpers are still working isn't waiting on you, so it stays quiet until they're back. Nothing shows up just to be dismissed.

**Threads are built to run without you.** A worker keeps going until it reaches something only you can settle — a product call, a fork where guessing wrong is expensive to undo, an irreversible action — and then it hands back an answerable *question* rather than a wall of text for you to re-read and interpret.

<p align="center">
  <img src="assets/question.png" alt="A question card asking whether the settings store should use SQLite or a JSON file, with option A marked recommended, a row for typing something else, and below it a countdown to the recommended pick." width="100%">
</p>

Options are lettered and answered in one click, and a worker marks its own recommendation when it has one — so the common case is a single keystroke. There is always a row for writing something else instead.

A question you leave alone doesn't stall the thread: ten minutes after the agent comes to rest on it, Frizz answers with the recommended option. A countdown under the card shows when, and its × turns it off. An option that acts outside your machine — posting, merging, publishing — is never picked for you.

When the answer isn't one thing, the same card takes several: check any combination and add a note.

<p align="center">
  <img src="assets/question-multi.png" alt="A question card titled Select multiple: 'Which of these findings should I fix in this pass?' with three checkbox options, the first two ticked, and a field for adding a note." width="100%">
</p>

When the agent needs you to *do* something it can't — sign in, approve a prompt, press a button — the card lists the steps and a **Done** button that tells it you finished.

Not ready to start something? Press ⌘/Ctrl-Shift-Enter in the new-thread box, or the button beside Send, to save the prompt as a todo instead. It waits in the queue with no agent behind it until you send it.

### GitHub

Browse the repo's issues and pull requests from the composer, select any number of them, and each becomes its own thread.

<p align="center">
  <img src="assets/github.png" alt="The GitHub picker listing a repo's open issues with comment, reaction and linked-PR counts, three of them checked, and a Start 3 investigations button." width="100%">
</p>

Workers can also read issues, diffs, and CI on their own — but only read. A worker never comments, labels, closes, or merges unless you ask it to.

### Snooze

Park a card for an hour, until tomorrow morning, or until a date you pick. Attach a follow-up prompt and the thread wakes up already working on it.

<p align="center">
  <img src="assets/snooze.png" alt="The snooze menu opened from the alarm clock in a queue card's header, offering 1h, tomorrow, 1d, 3d, 1w and a custom time." width="100%">
</p>

### Goal

Give a thread a standing goal. Frizz sends it as a prompt every time the agent comes to rest, on a clock you set in minutes, or both — a scheduled send reaches the agent even mid-turn, without cutting off work in progress.

<p align="center">
  <img src="assets/goal.png" alt="The goal panel open above a queue card's prompt box: a goal saying to keep going until the test suite is green, sent at every rest and every 30 minutes." width="100%">
</p>

A goal can stop itself after a number of sends or a span of time, so "check back every 20 minutes for the next two hours" ends on its own.

### Schedules

Write a recurring prompt the way you'd say it — "every Monday at 9am triage new issues", "first weekday of the month bump deps". When the prompt box sees a schedule word, it reads the schedule as you type and shows the rule it understood and when it next runs, before you press Enter. Press × if you didn't mean a schedule. Each run starts a fresh thread in that project. The next one waits in Snoozed, where you can skip it, move it or run it now. Find every schedule from ⌘K.

<p align="center">
  <img src="assets/schedule.png" alt="The prompt box reading 'every weekday at 9am triage new issues' as a schedule: the phrase highlighted, the send button turned into a repeat button, and a strip reading 'Every weekday at 9am · next Thu Oct 8, in 22h'." width="100%">
</p>

### Time limits

The stopwatch beside the model in the prompt box gives a thread a limit: `2h`, or a clock time like `15:30`. The agent is told, plans for the best result it can hand over by then, and gets reminders as the limit approaches. A sub-agent it starts gets a share of the time that's left. The card counts down, turns amber near the end and red once over. Its chip extends or removes the limit. Running out never interrupts a turn; you still can.

<p align="center">
  <img src="assets/time-limit.png" alt="A queue card whose header shows a 43m left countdown, with the time-limit panel open: +15m, +30m and +1h, a field for a new limit, and Remove time limit." width="100%">
</p>

### Threads and handles

Every thread has a short `@handle`, and a sub-agent is addressed under its thread (`@port-the-parser.cache-keys`). Type `@` in a prompt to mention one, and agents link the threads they name. Agents can read another thread or message it by handle, and wait for its answer. `#slug` names a project the same way.

Spinoff (→ on a card) starts a new thread from the one you're reading. On a Claude thread it forks the parent's session, so the new thread starts out knowing everything the parent did.

### Terminals

Press `t` on a thread, or start a prompt with `$` (`$ npm test`), to open a terminal in the folder its agent works in. The terminal belongs to that thread: it shows on the thread's card and stops when you mark the thread done.

### And more

- **Keyboard first.** `j`/`k` walk the queue, `r` replies, `d` marks done, `s` snoozes, `c` starts a thread, ⌘K jumps anywhere. Press `?` to see every shortcut and rebind any of them.
- **Pictures, video and files open in Frizz.** An agent can show you screenshots and recordings in a gallery, and file links open in a reader — or in your editor, at the line they name.
- **Slash commands.** `/` offers Claude Code's own commands and skills, plus prompts of your own, saved under **Settings**, in `~/.agents/commands` or in a project's `.agents/commands`. Your own commands work on every agent.
- **Project instructions.** Edit a project's `FRIZZ.md` from the agent settings beside the model picker.
- **Thread info.** A thread's ⋯ menu shows its tokens, turns, requests and cost.
- **Pin** a thread to keep it at the top of the list. **Delete** threads you no longer need, or let Frizz delete done threads you haven't touched in a while.
- **Usage.** The quota chip shows how much of your plan is left, and warns when it's nearly out while threads on it are still running. Optionally, new Claude threads switch to Fable when the rest of your usage is nearly gone.
- **Effort on auto.** By default a quick model reads each prompt and picks the effort for it.
- **Stays awake.** While an agent is working, or while remote access is on and the machine is plugged in, Frizz keeps it from idle-sleeping. Closing the lid or pressing sleep still works.
- **Light and dark.** Follows your system, or pick one in **Settings**.

<br/>

<h2 align="center">CLI</h2>

```sh
$ npx frizz --help

Frizz production launcher

Usage: npx frizz [options]

Run it in the directory you want to work in. One server serves EVERY project on this machine,
all on one page, so a second run joins the one already going. Runs the
npm-resolved immutable Frizz package, then opens it in your default browser. Use frizz-dev only
for a source checkout.

Options:
  --no-app               print the URL without opening a browser
  --port <port>          request a fixed port for a new workspace server
  --sandbox              a disposable Frizz to try things in: throwaway home and project, its
                         own port, deleted when this terminal closes; credentials (gh,
                         cloudflared, Claude, Codex, the machine's frizz.sh key) are shared
  --link                 print a fresh single-use access link for the running board
  --sessions             list the devices signed in to the running board
  --sign-out <id|all>    sign one device out, or every one of them
  --status               report the board running for this project: address, pid, version
  --stop                 stop the board running for this project (running agents keep going)
  --debug                stream the full event feed to the terminal instead of the compact readout
  -h, --help             show this help


To reach the board from a phone or another machine, press R in the terminal running it: a short
walkthrough sets up a private frizz.sh name (no account needed), a custom one, a Cloudflare
Tunnel, Tailscale, or a proxy of your own, and
remembers the choice, so a plain launch serves it from then on. The board stays on loopback and
shows a single-use sign-in link as a QR; press L for a fresh one, or run --link from another shell.
```

<br/>

<h2 align="center">FAQ</h2>

<details>
<summary><b>Does Frizz run its own agent or model?</b></summary>

> No. It drives Claude Code or Codex under the account you are signed in to on your machine. Your subscription, your rate limits, your settings. Frizz runs its own pinned copy of each CLI — the exact build it was tested against — rather than whichever version happens to be on your PATH; set `FRIZZ_CLAUDE_BIN` or `FRIZZ_CODEX_BIN` to point it at another one.

</details>

<details>
<summary><b>Does anything leave my machine?</b></summary>

> Nothing from Frizz. There's no account, no telemetry, and the server binds to `127.0.0.1`; reaching it from another device is something you switch on yourself (press R in its terminal). The agents themselves talk to their providers, and `gh` talks to GitHub, but Frizz is a local process looking at local files.

</details>

<details>
<summary><b>What happens if I close the tab?</b></summary>

> Nothing. Each thread's agent runs in its own detached background process, independent of the browser *and* of Frizz itself — you can stop Frizz entirely and your agents keep working. Relaunch, and it reconnects to the sessions that are still running.

</details>

<details>
<summary><b>Does it put junk in my repo?</b></summary>

> Barely. Dispatching a thread writes no thread file into your repo — the agent session *is* the thread. All Frizz adds to your working tree is a `.frizz/` directory holding a scratch directory per thread (empty unless the agent writes something in it) plus a couple of tiny hook state files. Everything durable lives outside your checkout, under `~/.frizz/` if you already have one and otherwise in your platform's own data directory (`~/Library/Application Support/Frizz` on macOS, `$XDG_DATA_HOME/frizz` on Linux, LocalAppData on Windows), so you can delete `.frizz/` and keep every thread and setting. Frizz does not touch your `.gitignore`, so add `.frizz/` yourself if you don't want it in `git status`.

</details>

<details>
<summary><b>Do I have to use worktrees?</b></summary>

> No. Frizz doesn't own your git workflow and won't create branches or worktrees behind your back. Tell your agents what you want in `FRIZZ.md`. When an agent does make a worktree, Frizz keeps it in one folder (`.frizz/worktrees` by default, set under **Settings**) and refuses any other path. When you mark the thread done, Frizz removes the worktrees that thread made, unless one still holds uncommitted or unmerged work. If you run Frizz inside a linked worktree yourself, it keeps that worktree's state separate from its siblings automatically.

</details>

<details>
<summary><b>Can I run it on several repos at once?</b></summary>

> Yes. One Frizz server serves every project on your machine — you don't start one per repo. Run `npx frizz` in any of them and they all appear on the one page, each with its own threads under its name; each project's threads, settings and state stay separate.

</details>

<details>
<summary><b>Can I reach it from another machine?</b></summary>

> Yes. Press **R** in the terminal running Frizz. A short walkthrough sets up one of four ways to reach Frizz — a name on frizz.sh, a Cloudflare Tunnel you own, Tailscale, or any proxy you run — checks what each needs, prints the commands, and remembers your choice. From then on a plain `npx frizz` serves it; pick **Off** in the same place to go back to loopback only.
>
> To try any of this without touching the Frizz you run, launch a second one with `npx frizz --sandbox` — a throwaway home and project on its own port, deleted on ctrl-c.
>
> Frizz stays bound to `127.0.0.1` in every case. Something in front of it — the frizz.sh relay, the tunnel, Tailscale, your proxy — carries the traffic, and Frizz gates the first visit with a single-use sign-in link shown as a QR. Press **L** for a fresh link any time, or `npx frizz --link` from another shell (over SSH, for a headless box). See [Remote access](docs/remote-access.md) for what each option needs.

</details>

<details>
<summary><b>Can I reach it from anywhere, not just my LAN?</b></summary>

> Same answer: press **R** and pick a private frizz.sh name (unguessable, no account), a custom frizz.sh name, a Cloudflare Tunnel, or Tailscale. Each is reachable from anywhere the transport is — a frizz.sh name and a Cloudflare Tunnel from the open internet, Tailscale from your own devices.
>
> Frizz has no accounts, so the single-use sign-in link **is** the door: a phone that scans it gets a session; nobody else gets in. Sessions are per device and can be listed and revoked with `npx frizz --sessions` and `npx frizz --sign-out`.

</details>

<details>
<summary><b>What platforms does it run on?</b></summary>

> macOS, Linux, and Windows. Windows support landed once the last dependency that had no native Windows build was removed.

</details>

<details>
<summary><b>How is this different from the other orchestrator apps?</b></summary>

> Those apps wrap your agents in their own workflow. Frizz doesn't: it's a viewer and a queue over the CLIs you already run, with every piece of orchestration judgment sitting in editable text instead of inside the binary.

</details>

<br/>

<h2 align="center">Glossary</h2>

Frizz has its own small vocabulary. Most of it names a feature, so this doubles as an index of the opinionated parts.

| Term | What it means |
| --- | --- |
| **Project** | A directory you ran Frizz in. One server holds all of them, and one page shows them all; a thread's address names its project, `/all/<name>/thread/<thread>`. |
| **Thread** | One effort, start to finish. Not a chat tab and not a branch. The session *is* the thread — there's no sidecar document to keep in sync, and dispatching doesn't write a file into your repo. |
| **Worker** | The agent driving a thread: a real Claude Code, Codex or ACP agent process, running as *you*, with your credentials and your CLI config. |
| **Handle** | A thread's short name, `@port-the-parser`. You and the agents use it to mention, read and message a thread. |
| **Sub-agent** | A helper a worker dispatches for an independent prong of its own task. Frizz binds each one back to its parent, so the fan-out is visible under the parent's card, addressed as `@parent.child`. |
| **Rested** | An agent that has ended its turn and is waiting on a human. A rested thread isn't idle, it's *your move*. |
| **The queue** | The single list of threads that need you. A thread only earns a card when it genuinely wants a human. |
| **Snooze** | Hide a card until later — an hour, tomorrow morning, or a date you pick — optionally with a follow-up prompt attached. |
| **Goal** | A standing prompt a thread receives on its own — every time it rests, on a clock, or both — until you switch it off, it reaches its limit, or the agent says it's done. |
| **Schedule** | A prompt plus a recurrence, in plain words. Each run starts a fresh thread. |
| **Time limit** | A deadline on a thread that the agent plans around and the card counts down to. It never cuts a turn off. |
| **Todo** | A prompt saved as a thread with no agent behind it yet. Sending it starts one. |
| **Spinoff** | A new thread started from another, carrying its context. |
| **Scratch directory** | A thread's own folder, `.frizz/threads/<id>/`, where its agent can keep notes and files. Empty unless the agent writes something. |
| **`FRIZZ.md`** | An optional file at your repo root whose contents are injected into every thread, for when you want agents to follow your repo's own norms. |

<br/>

<h2 align="center">Docs</h2>

- [frizz.sh/docs](https://frizz.sh/docs) — the full docs: every feature, remote access, the CLI and the FAQ.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — the invariants, layout, and design decisions. Read it before changing anything.
- [`FRIZZ.md`](FRIZZ.md) — this repo's own worker norms, as a worked example of the optional per-repo prompt.
- [Remote access](docs/remote-access.md) — reaching Frizz from a phone or another machine.
- [The VS Code extension](packages/vscode/README.md) and [the desktop app](packages/desktop/README.md).

<br/>

<h2 align="center">Contributing</h2>

Issues and pull requests are welcome. Fork the repo, branch off `main`, and open the PR against `main` — CI runs on every pull request.

Three checks run in CI, and they need no install:

```sh
$ node --test board/*.test.mjs
$ node scripts/sync-portable-monitors.mjs --check
$ node --test monitors/*.test.mjs
```

Everything else runs locally. Install with `pnpm install`, typecheck with `pnpm typecheck`, and run the full suite with `pnpm test` — that suite drives real agent CLIs and a real browser, which is why CI does not gate on it. Say in the PR what you ran. The suite needs a newer Node than the runtime does: early 22.x point releases (22.15 measured) fail `receipt-bus.test.ts` on a since-fixed test-runner defect, so run it on current 22.x or ≥ 23.4.

<br/>

<h2 align="center">License</h2>

MIT
