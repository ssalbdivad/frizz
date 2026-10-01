# Todos — notes on the board that are not (yet) agents

Evaluation written 2026-10-01. Not shipped; nothing here is implemented.

## The ask

Create an item from the prompt box that does NOT dispatch. It sits on the board as a note to follow up on, can be marked done whenever, and can later be launched as a prompt. The direction: Frizz as the place the operator organizes all their open loops, agent or not.

## Verdict: worth building, as its own small entity — not as a thread with no session

The board already is a todo list: the queue is "things that need you", Snoozed is "not until then", Done is the archive. What is missing is the one item the human owns before any agent exists. The demand is real and the surfaces it needs (queue order, snooze, done, the Home workspace for non-repo work) already exist.

The trap is the obvious implementation: a `session` row with no session yet. Every thread verb and reader is keyed on a live session — `completeThread` takes `{ slug, sessionId }` and resolves through `currentOwnedSession`; the board derives a row's state by tailing its transcript; `session.session_id` is `NOT NULL`; the web reads `.sessionId` in ~67 places. A sessionless row would have to be guarded in each, and every one missed is a crash or a phantom ("neither queued nor carded: invisible" is already a recurring bug class in `board.ts`). It is also exactly the "extra thread kind" shape Colin objected to with terminal command threads, which were folded back into threads on 2026-09-29.

So: a todo is a separate record, rendered on the board, that BECOMES a thread when launched. Nothing thread-shaped has to learn about it.

## Shape

**Storage** — one table in `storage.ts`, tenant-prefixed like every other:

```
todo(project_id, id, title, body, created_at, updated_at, snoozed_until, done_at, launched_slug)
```

`title` is the first line of `body` unless edited. `launched_slug` records the thread it became, so the done archive can link it.

**RPC** — `createTodo`, `updateTodo`, `snoozeTodo`, `completeTodo` / `reopenTodo`, `deleteTodo`, `launchTodo`. `launchTodo` calls the existing `dispatcher.dispatch` with `body` as the prompt and `nameSource: title`, then stamps `done_at` + `launched_slug` in the same handler. Launching should be able to edit the prompt first (the note is rarely a finished prompt), so the web opens it in the composer prefilled rather than firing blind.

**Snapshot** — `todos: Todo[]` beside `threads` on the board snapshot, not inside it. The web merges them in the rail; the server's queue and notification logic stays untouched.

**Web**

- **Create**: a secondary action on the prompt box's send (split button / `⌘⇧⏎` "Add as todo"). The draft store already keys the box per project, so a todo is a draft that persisted.
- **Where it sits**: in Rested (the queue) by default — a todo is by definition waiting on the human — with a distinct mark (a checkbox circle in place of the status dot) and no rest time, or its creation age. Snoozed todos go to Snoozed; done ones to Done.
- **Open**: the drawer shows an editable note and three verbs: Launch, Snooze, Mark as done. No transcript, no composer, no profile control.
- **Keyboard**: the queue's existing done/snooze keys work on it; Enter opens it.

## What it costs

Roughly: table + migration + six mutations + snapshot field (server, ~1 day with tests); split send, rail row, note drawer, launch-into-composer (web, ~1–2 days including the optical pass every new row needs). Blast radius stays small because no existing thread code path changes — the one real seam is the rail and queue merge, where todos must sort and key-navigate with threads.

## Questions the build needs answered

1. **Queue or own band?** Default to the queue (they need you; one list to triage). Its own "Todo" band above Rested is the alternative if an inbox of notes would drown the agent cards. Colin's density concern for the sidebar argues for the queue, with no extra band.
2. **Does launching consume the todo?** Default yes: it is marked done and links to its thread. The alternative keeps it open until the thread is done, which turns todos into a parent of threads — a bigger feature (a project tracker), and the point where "organize todos" starts to grow subtasks, due dates, and lists. Out of scope for v1.
3. **Cross-project**: a todo belongs to a project; non-repo todos go in the Home workspace. No project-less todos.

## Deliberately not in v1

Due dates (Snooze already is "show me this at…"), checklists inside a todo, recurring todos (the Goal covers recurring agent work), import from GitHub issues (`watch_issue` and the issue picker already exist; a "todo from issue" is a natural v2).
