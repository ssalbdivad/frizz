# Todos — threads that have not started yet

Evaluation written 2026-10-01, revised the same day. Not shipped; nothing here is implemented.

## The ask

Create an item from the prompt box that does NOT dispatch. It sits on the board as a note to follow up on, can be marked done whenever, and can later be launched as a prompt. The direction: Frizz as the place the operator organizes all their open loops, agent or not.

## Verdict: worth building, as an unstarted THREAD

A todo is a session row that has a minted session id and a title but no agent behind it yet. It shows up in the queue as a bare rest does. Sending it a message is what starts the agent.

The first draft of this plan proposed a separate `todo` table, out of fear that a sessionless row would break every reader keyed on a live session. That framing was wrong. The row is not sessionless: dispatch already mints the session id itself (`randomUUID()` in `dispatch.ts`) before spawning anything, and an exited row whose agent is gone is already an ordinary board state. An unstarted row is the same shape, with no transcript yet. The separate table would have had to rebuild everything a thread row gets for free: the queue position, snooze, mark as done, rename, the drawer, keyboard navigation, the project scoping, and the Done archive.

It is also not a new thread KIND (Colin's objection to terminal command threads), because it is not a different thing. It is a thread in its earliest state, and it leaves that state the first time it gets a prompt.

## Shape

**Storage:** one nullable column on `session`, `started_at`. NULL means unstarted. Every existing row is backfilled to `spawned_at`. Dispatch writes it; the new `createTodo` mutation does not.

**Create:** `createTodo({ title, body })` mints a slug and session id and writes the row with `exited=0`, no runtime, `started_at` NULL, and the body stored as a pending first message. In the web, it is a secondary action on the prompt box's send (`⌘⇧⏎`, "Add as todo"). The note body renders in the drawer where a transcript would be.

**Launch:** sending into an unstarted thread's composer, prefilled with the stored note so it can be edited first, runs the dispatch first-turn path with the row's EXISTING slug and session id. It does not take the resume path. The backend, model and effort are chosen at that moment, from the composer's own picker.

**What has to learn about "unstarted":** this is the whole cost, and it is a list one can check:

- `resumeThread` / follow-up delivery: route to first-turn dispatch instead of `--resume` on a session that does not exist.
- The board's row derivation: no transcript means rested, with no fence and no runtime. It must draw the note and queue the row, and never card it as a crash.
- The scheduler: no sign-off nudge, Goal, timer or wake may target an unstarted row. They have nothing to deliver to.
- Boot recovery and the liveness reaper: never treat "no transcript, no process" as a dead worker to recover.
- The thread controls that act on a live runtime (restart worker, profile, permission, open terminal): hidden or inert until it starts.
- Mark as done / delete: should skip the "End this session?" hold, since nothing is live.

The cleanest guard is one predicate, `isUnstarted(row)`, checked at each of those entry points, with a test per entry point that drives a real unstarted row through it.

## Open product questions

1. **Queue or its own band?** Default: the queue. A todo is waiting on the operator by definition, and Colin's sidebar-density concern argues against another band. The cost is that a pile of notes could crowd out agent cards.
2. **Mark:** a todo's row needs to read differently from a rested agent at a glance, for example a hollow circle in place of the status dot.
3. **Non-repo todos** go in the Home workspace. No project-less todos.

## Deliberately not in v1

Due dates (Snooze already is "show me this at…"), checklists, recurring todos (the Goal covers recurring agent work), and a todo created from a GitHub issue (a natural v2, since the issue picker exists).
