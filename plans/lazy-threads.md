# Lazy threads — threads that do nothing until their first message

Evaluated and built 2026-10-01 as "todos", renamed to lazy threads the same day (maintainer's pick: the name generalizes to any thread that waits to be forced, like lazy evaluation). Shipped on `main`.

## What it is

A lazy thread is a thread written down without starting an agent: a note to come back to, mark as done, snooze, or launch later. It is the board's first item the human owns before any agent exists, which moves Frizz toward organizing every open loop, agent or not. Lazy threads that aren't about a repo go in the Home workspace.

## Why it is a thread, not a separate record

The first draft of this plan proposed a separate table, worried that a thread row with no session would break every reader keyed on a live session. That was overstated. Dispatch already mints the session id itself (`randomUUID()` in `dispatch.ts`) before spawning anything, and a row whose agent is gone is an ordinary board state. A lazy thread is the same shape with no transcript yet, so it gets the queue position, snooze, mark as done, rename, the drawer, keyboard navigation and the Done archive for free. A separate table would have had to rebuild all of them.

It is not a new thread kind, which was Colin's objection to terminal command threads. It is a thread in its earliest state, and its first message ends that state.

## How it works

**Storage.** One nullable column on `session`, `lazy_prompt`. Non-NULL means unstarted, and the value is the prompt it will start with (`SessionRow.lazy_prompt`, `isLazyRow`). Every dispatch upsert writes `lazy_prompt = excluded.lazy_prompt`, which is NULL for a dispatch, so the write that records the live session is the same write that ends the lazy state. A database that ran the first hours' build, when the column was named `todo`, has it moved over at boot.

**Create.** `createLazyThread` (`dispatch.ts`) mints a slug, a session id and a title (a typed title is locked; otherwise the note is named like a prompt). It records the profile the prompt box had at the time and spawns nothing. In the web, it is ⌘/Ctrl-Shift-Enter in the new-thread box, or the "add as lazy thread" hint in its footer.

**Launch.** `startLazyThread` (with an edited prompt and an optional profile) and `followUp` both run `startLazyThreadRow` in `router.ts`, which calls `dispatch` with `opts.lazy`. That dispatch keeps the row's own slug, session id and title, so its pin, links and queue position carry over. Any sender starts a lazy thread: the prompt box, a snooze carrying a prompt, or another thread's message. A side request is refused, since there is no worker to run it. A second launch while the first is still spawning is refused, because it would start a second agent on the same session id. A failed launch leaves the lazy thread untouched.

**What learned about "unstarted":**

- The tailer's tick skips lazy thread rows. Every scheduler source (sign-off nudge, Goal, timers, shell and park checks, limit resume) keys on tailer telemetry, so none of them can act on a lazy thread. Hibernation only walks live daemons, and a lazy thread has none.
- The board's per-row reading (`lazyThreadView`) is a bare rest: queued unless done or snoozed, never "spinning up" and never a stall card.
- The transcript read returns nothing for a lazy thread instead of scanning the log directory for a file.
- Boot reconciliation needs nothing new: a lazy thread has no runtime, so it is stamped `exited` like any row without one, and it is never offered to the broker's warm-up.
- Mark as done needs nothing new either: with nothing live, it never asks for confirmation.

**Web.** The queue card and the drawer render one box, `LazyThreadBox`. The note is its text, edits save back as they are typed, and sending it starts the agent. It deliberately is not `ThreadComposerBox`, whose controls all assume a running agent. The rail draws an open lazy thread as an empty status box (Done fills the same box with its check). The card and drawer date it "Added", the drawer says "Not started yet.", and Spinoff is hidden.

## Verified

- `packages/server/src/lazy-threads.test.ts`: create spawns nothing; the first message dispatches on the same slug and session id and clears the note; the next message is an ordinary follow-up; a double launch is refused; a failed launch keeps the lazy thread; the board reading queues it unless it is done or snoozed.
- Real stack (`scripts/adhoc-stack.mjs --creds`), driven in a headless browser: added a lazy thread from the prompt box; edited a note in its card and read the edit back over RPC; sent it, which started a real Haiku worker on the lazy thread's own session id that answered and signed off; marked one done and snoozed another; restarted the server and confirmed a lazy thread stayed a queued lazy thread past the 60s transcript-discovery window.

## Not in v1

Due dates (Snooze already covers "show me this at…"), checklists inside a lazy thread, recurring lazy threads (the Goal covers recurring agent work), changing a lazy thread's profile before launch, and creating a lazy thread from a GitHub issue.
