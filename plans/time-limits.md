# Time limits on a prompt — at every level

Status: design, not built (2026-10-06). Asked for by the maintainer: *"is there some concept of
associating a time limit with a prompt at every level — user at the top-level, and threads could do the
same for the sub agents. the agent would be aware of the limit and be prompted regularly and plan around
having the best deliverable possible given the prompt at the limit rather than running indefinitely."*

## What it is

A thread may carry a **deadline**: an absolute instant, set by the human when they dispatch it ("2h",
"until 15:30") or later from the drawer. Three things follow from it:

1. **The worker knows.** The worker prompt states the deadline and what it means: the job is the best
   deliverable possible *by then*, not the complete one eventually. Plan for something you can hand over
   at any point (commit checkpoints, a write-up that is true at every stage) rather than a big reveal at
   the end.
2. **Frizz reminds it, and gets pushier as time runs out.** Check-ins are delivered mid-turn at fixed
   points in the budget. Each one says how much time is left and what to do at that stage.
3. **Sub-agents get a share of it.** A child the worker dispatches gets a deadline of its own, never later
   than the parent's minus a reserve the parent needs to fold the result in. The child gets check-ins
   the same way.

This is the maintainer's existing habit ("go until 3:30") turned into something Frizz keeps track of.
Today it lives in the prompt text, where nothing reminds the agent and nothing shows it on the board.

## Non-goals

- **No hard kill.** Running out of time never interrupts a turn and never stops a sub-agent: the agent
  completion invariant (CLAUDE.md) forbids it, because a turn cut mid-edit leaves the tree unsound. The
  limit is enforced by what the agent is told, and by the board showing the thread as over time. The
  operator's existing interrupt is still there for anyone who wants a real stop.
- **Not a token or quota budget.** Wall clock only. A cost budget is a different meter with a different
  failure mode. It could reuse this machinery later, but it is out of scope here.
- **Not a Goal.** A Goal keeps an effort *going*; a deadline *bounds* it. They are separate rows, and a
  thread can have both (see Interactions).

## Precedent: the background-shell budget

`packages/server/src/shell-budget.ts` (scheduler SOURCE 13) already has the pattern this copies: it is
opt-in, the party that knows sizes it, there is one warning wake that reaches the worker mid-turn, and
there is a grace period measured from when that warning is *delivered*, not from when it was queued. A
deadline is the same idea one level up: the subject is the thread instead of a shell, and the
consequence is a handoff instead of a `TaskStop`.

## Storage

The thread row gets four columns (built 2026-10-06; two were planned):

| column | meaning |
| --- | --- |
| `deadline_at` | ISO instant. Null means no limit. |
| `deadline_set_at` | When the current deadline was set. Together with `deadline_at` this gives the budget, so check-in points are fractions of it. Moving the deadline resets this; it is the generation, the same way `recurring_armed_at` is for a Goal. |
| `deadline_set_by` | `human` or `worker`. What the "only the human may extend the human's" rule reads. |
| `deadline_stage` | The last stage queued for this generation, so a stage is never queued twice (the `shell_budget.warned_deadline` pattern). The delivery id alone does not survive a superseded row. |

A re-dispatch onto a NEW session drops the deadline; a resume of the same session keeps it.

Check-in delivery ids are keyed `deadline:<deadline_set_at>:<stage>`, the way `heartbeatFenceId` keys a
Goal's beats. So extending a deadline starts a fresh set of check-ins, and a restart never sends a stage
twice.

## Setting it

- **At dispatch.** The prompt box gets a time-limit control. It parses the duration grammar used for
  `for:` (`30m`, `2h`) plus a wall-clock form (`15:30`). The dispatch RPC (`router.ts` → `dispatcher.dispatch`)
  takes an optional `deadline`. A typed "go until 3:30" in the prompt text is *not* parsed: the control
  is the only input, so the board never disagrees with the prose. As built: an unmarked `3:30` means
  whichever of 03:30 and 15:30 comes next, a leading zero (`09:00`) means 24-hour, and a bare number
  is refused. The field is honoured only from the browser (`dispatchCaller`, the `Origin`/`Mozilla`
  rule), so a worker's own dispatch can never mint a deadline that reads as the human's.
- **Later.** The drawer gets an extend/clear control, and the worker gets an MCP tool
  `mcp__frizz__deadline` (`action: set|extend|clear|read`). A worker may *read* its deadline and may
  set one on a thread that has none. Only the human may *extend* a deadline the human set: an agent
  moving its own goalposts defeats the point. This is the one rule that is not a reversible implementation
  detail.
- **Shown** on the card and in the drawer, using the house duration grammar (`1h 12m left`, `over by 8m`).
  Over time is a visible state on the card, not a separate board band.

## Check-ins (new scheduler source)

Delivered **mid-turn** at the next tool boundary, the same path a Goal heartbeat takes (`heartbeat_seconds`).
If the thread is resting, the check-in is delivered as an ordinary wake. Stages:

| stage | at | text, in substance |
| --- | --- | --- |
| `start` | dispatch | Rides in the worker prompt rather than as a wake: deadline, budget, and the "best deliverable by then" framing. |
| `half` | 50% | Time left. If still exploring, commit to an approach now. |
| `converge` | 80% | Time left. Start nothing new. Finish what is open, commit it, make the write-up true. |
| `final` | 95%, or 5m before the deadline if that is earlier, but never before 87.5% | Hand off at your next stop. Say what is done, what is not, and what you would do next. |
| `over` | deadline | Your time is up; your next stop is the handoff. The card goes to over-time. |

The 87.5% floor is a measured change. Taken literally, "5m before" puts a 4m budget's final check-in a
minute before the deadline was even set. Holding it between 87.5% and 95% keeps it after `converge` and
never on top of it. A 1h budget still gets the full five minutes (55m), and a 10h one gets 95% (9h 30m).
When several stages have passed (a server that was down, a busy reading), only the LATEST is sent.

**Check-ins are exempt from the wake quiet window** (`wake-store.ts`, like `shell-budget:`). This came
from the first real run (2026-10-06, 4m deadline). Half-time reached the worker, and its delivery opened
the thread's 5m quiet window. Converge, final and over were then each held and superseded by the next
stage, so none of them was ever sent. A thread resting on a handoff (`done`, an open question,
`needs_input`, `steps:`) is not woken by a check-in. A quiet park (`working` / `watching`) is.

Fixed stages beat a steady countdown: a reminder every N minutes is noise the model learns to ignore,
while a few stage changes each ask for a different behaviour. Each wake header (`you last spoke 3h ago`)
also gets `· 42m left` while a deadline is set, so the agent sees the clock on every turn it starts,
not only at check-ins.

**After `over`.** The rest that follows is checked like any other. If it is a handoff (`done`, a
question, `needs_input`), the deadline is settled. If the worker keeps going, it is not interrupted. It
gets no further Goal deliveries (below), and its card shows `over by …`. There is no second nag: the
board is the escalation from that point on.

## Sub-agents

**Plumbing, all existing:**

- `cc-worker/hooks/agent-dispatch.mjs` (PreToolUse on `Agent`) already rewrites every dispatch and
  appends an epilogue. It gets the child's deadline and adds one paragraph ABOVE the epilogue: the absolute
  deadline, the stage behaviour, and "your final message is due by then". The paragraph ends in a marker
  line, `⟦frizz-deadline⟧ <deadline> <start>`. It goes above the epilogue so that the epilogue's
  ends-with idempotence still holds. The thread's own deadline comes from a read-only `threadDeadline`
  query, which the hook reaches the way `agent-address.mjs` does.
- `cc-worker/hooks/agent-inbox.mjs` already delivers to a running sub-agent through PostToolUse
  `additionalContext` (any `agent_id`, Workflow agents included; measured on 2.1.287 in d6e6e048). Child
  check-ins ride that path. As built, the hook computes them itself; no inbox file is written. Each stage
  is claimed with an exclusive file create in `<sessionDir>/frizz-deadlines/`, so parallel tool calls in one
  child send it once. The logic is in `agent-deadline.mjs`, a plain-JS twin of `@frizz/shared`
  `deadline.ts`, because hooks run under bare node at the engines floor. `agent-deadline-hook.test.ts` pins
  the two together.

**Sizing the child's deadline.** Claude's `Agent` tool has no budget parameter, so the parent declares
one in the prompt with a single line the hook strips and parses: `Time limit: 20m`. Without that line
the child gets the parent's remaining time minus a reserve. The reserve is the larger of 20% of the
remaining time and 5m, but never more than half of it. As planned, a parent with 4m left would have
handed its child nothing, so the cap is a built change. A declared limit is clamped to the same ceiling,
so a child can never outlive its parent's deadline. The floor is 1m, even for a parent already over time.
The hook strips a `Time limit:` line it can read, because the paragraph states the clamped figure. A line
it cannot read stays in the prompt. A thread with no deadline imposes none: then a `Time limit:` line alone sets
the child's.

**Binding the deadline to the agent id — measured, and neither planned route was used.** On Claude
Code 2.1.287 (2026-10-06):
- SubagentStart's input is `session_id, transcript_path, cwd, prompt_id, agent_id, agent_type,
  hook_event_name`, with no tool_use_id and no prompt.
- With two children dispatched in one message, the two SubagentStart hooks overlap the parent's
  PostToolUse(Agent) in no fixed order.
- The child's `meta.json`, which does hold `toolUseId`, is written only AFTER SubagentStart returns.

So a FIFO would have been a race, and SubagentStart cannot claim anything. What is reliable is the
child's own transcript. By its first PostToolUse, `<sessionDir>/subagents/agent-<id>.jsonl` exists, and
its first record is the prompt AS REWRITTEN by the dispatch hook. In that event `transcript_path` is the
PARENT's, and the session dir is that path minus `.jsonl`. So the deadline rides inside the prompt as the
marker, and the child's hook reads it back. Nothing is keyed, so no child can claim another's deadline.

**Workflow agents.** A Workflow script's `agent()` opts are not ours to extend, and no Agent call is
made, so no prompt gets rewritten. Its transcript lives under `subagents/workflows/<run>/agent-<id>.jsonl`,
wrapped in the harness's "computed task" preamble with every line indented. On the agent's first tool
call, its hook works out the share from three things: the agent's own `Time limit:` line (optional), the
thread's deadline, and the agent's start, taken from the record's timestamp. It then introduces the limit
in the first ⏰ message, since the prompt never stated one. The mailbox intro, which a Workflow agent gets
at SubagentStart before any tool runs, now says that time checks arrive the same way. That matters
because a model rightly distrusts instructions that show up unannounced in tool output.

**Not covered.** A child dispatched before its thread had a deadline gets none, even if one is set later.
The share is fixed at dispatch.

**Grandchildren.** Recursive by construction: a child's own `Agent` call goes through the same hook,
with the child's deadline as the ceiling. Nesting stays default-off per the epilogue, so in practice
this is one level.

## Worker contract (`workerPrompt.ts`)

A short section, present only when a deadline is set (injected, the way the FRIZZ.md block is):

- The deadline and budget in absolute and relative form.
- Plan to an anytime deliverable: commit at each coherent checkpoint, and keep the write-up true at
  every stage.
- Size sub-agent budgets explicitly, with `Time limit:`. Leave yourself time to integrate their results.
- What each check-in stage asks for.
- Waiting time counts. A park on CI or a reviewer that will outlive the deadline should be handed to
  the human, not waited out.

## Interactions

- **Goal.** Goal deliveries stop at the deadline. A `stop_hook` Goal driving "keep going" past the
  limit would undo the limit. A Goal's own `for:` is unaffected.
- **Parks.** An `awaiting` fence's `for:` is clamped so the park wakes no later than the deadline; the
  `over` check-in needs a live worker to read it.
- **Subscription-limit pause.** The clock keeps running, because a deadline means wall clock. The card
  shows both states, and the human extends if they want.
- **Codex / ACP threads.** The deadline and the worker-prompt section apply. Check-ins go through
  whatever mid-turn path that runtime's heartbeat uses today. Sub-agent shares are Claude-only (the
  hooks are cc-worker's).
- **Scheduled runs.** `mcp__frizz__schedule` could take a default limit for each run. That is a cheap
  follow-on, not part of v1.

## Build order

1. Storage columns, the dispatch RPC field, the MCP `deadline` tool, and the worker-prompt section.
2. The scheduler source for check-ins, the `left` in the wake header, the Goal cut-off and the park
   clamp, with unit tests beside `scheduler.shell-budget.test.ts`.
3. UI: the dispatch control, the countdown on the card and drawer, the over-time state, and extend/clear.
   Optical pass on the countdown chip.
4. Sub-agent shares: measure the SubagentStart binding, then the dispatch-hook budget and inbox
   check-ins.

## Verification

- Steps 1–2: a `real-subsystem-harness` run on an adhoc stack (`frizz-stack`). Dispatch a real Claude
  worker with a 4m deadline and a task that cannot finish in 4m. Assert that each stage reaches the
  transcript mid-turn, and that the worker's last message is a handoff that names unfinished work. As a
  negative control, run the same task with no deadline and confirm it gets no check-ins.
- Step 4: the same harness, with a worker told to dispatch a child under `Time limit: 2m`. Assert that
  the child's transcript contains its check-ins and that it returns before its deadline. Run it once
  with two children dispatched in one message, to exercise the binding race.
- Step 3: headless shots of the card in the under-time, last-5m and over-time states; `ink-gaps` on the
  chip.

### Results (2026-10-06, real Claude workers on adhoc stacks)

The evidence and harness live in the implementing thread's scratch directory (`verify-steps12.md`,
`verify-step4.md`).

- **Steps 1–2, first run (`1a8123d9`): failed.** Only half-time arrived; the quiet window held the other
  three (see Check-ins). This is the run that forced the quiet-window exemption.
- **Steps 1–2, rerun (`9b0223b5`, 4m deadline): passed.** The four stages were queued at +127s, +197s,
  +217s and +247s against due times of 120s, 192s, 210s and 240s; the lag is the scheduler's 10s tick.
  Each was absorbed mid-turn with a running Bash call's result, and its clock line read `2m`, `43s`,
  `23s` and `over by 8s`. The worker's `extend` was refused, as the human-only rule requires. Its
  handoff named the steps it had not run. The no-deadline control got no check-in and no queued wake.
- **Step 4: passed.** A child under `Time limit: 2m` had the line stripped and a marker 120.0s out. Its
  check-ins arrived after its tool calls, and it returned 18.6s before its deadline. Two children
  dispatched in one message (2m and 3m) each got their own marker, check-ins and state file, with none
  crossed. The parent had 10m, because with 6m left the reserve caps a child at about 2m 45s.
- **Changed by these runs:**
  - Worker-facing countdowns are now exact and rounded down under 10m. The rounded-up `2m left` reached
    a child that had 80s left.
  - The human's notice now carries a clock line.
  - Half-time now says it is not a signal to wrap up. Sonnet handed off early right after it twice; that
    is n=2 on one model, so this is a nudge, not a finding.

## The open question that matters

Whether "no hard kill" is the right posture is the maintainer's call. It is soft here because the
completion invariant forbids interrupting a writer. If a hard stop is ever wanted, the safe version is
to interrupt only at a rest, refusing further Goal and timer wakes after the deadline, never mid-turn.
That is close to what this design already does, minus the interrupt.
