# Scheduled threads

A **schedule** is a saved prompt plus a recurrence. On each occurrence Frizz dispatches a FRESH thread
in the schedule's project with that prompt, and the result lands in the queue like any other thread.
Schedules are written in plain words — "every Monday at 9am triage new issues", "first weekday of the
month bump deps" — and an AGENT turns the words into a rule. There is no date picker anywhere.

This is the third recurring pattern, beside the two Frizz already has, and it is the one every product
with scheduled agents converged on (ChatGPT Tasks, Codex automations, Claude Code routines, Devin,
Cursor): a fresh context per run.

| | runs in | trigger | tool |
|---|---|---|---|
| goal | the SAME thread | rest / heartbeat / compaction | `goal` |
| timer | the SAME thread, once | an instant | `timer` |
| **schedule** | a NEW thread each time | a calendar rule | `schedule` |

Prior art and its sources: `.frizz/threads/<id>/prior-art.md` during the build; the conclusions are
folded in below.

## The rule: an RRULE subset, computed by Frizz, never by the model

The model INTERPRETS; the server COMPUTES. The agent turns the human's words into one RFC 5545 `RRULE`
plus an optional local start (`DTSTART`, wall-clock, no zone) and an IANA time zone. Frizz validates
it, works out every occurrence itself, and answers with an echo built from the rule it will actually
fire — so a "9am" that the model mistranslated is visible before it runs, not after.

Why RRULE over cron: the plain-words schedules people actually say need it. "Every other Friday"
(`FREQ=WEEKLY;INTERVAL=2;BYDAY=FR`), "every 3 days" (`FREQ=DAILY;INTERVAL=3`, anchored on the start),
"first weekday of the month" (`FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1`) and "for three weeks"
(`COUNT`/`UNTIL`) are all inexpressible or awkward in 5-field cron. Models write RRULE fluently, and it is
what ChatGPT, Codex, Devin and Google Calendar use.

**Supported subset** (anything else is refused with a reason the agent can act on):
`FREQ` = `HOURLY|DAILY|WEEKLY|MONTHLY|YEARLY`, `INTERVAL`, `BYMONTH`, `BYMONTHDAY` (±1–31), `BYDAY`
(with ±ordinals under MONTHLY/YEARLY: `1MO`, `-1FR`), `BYHOUR`, `BYMINUTE`, `BYSETPOS`, `COUNT`,
`UNTIL`, `WKST`. No `SECONDLY`/`MINUTELY`, `BYSECOND`, `BYYEARDAY`, `BYWEEKNO`, `RDATE`/`EXDATE`, or
multiple rules. A one-off ("tomorrow at 8") is `COUNT=1`.

**Our own engine, zero dependencies** (`packages/shared/src/schedule-rule.ts`). It enumerates candidate
local days (and hours, for `HOURLY`) forward from the start, filters by the `BY*` parts, groups by period
for `BYSETPOS` and `INTERVAL`, and converts each local wall time to an instant with the DST-safe
`Intl` helpers already in `backend/usage-limit.ts` (moved to shared). Rejected: `rrule-temporal` +
`temporal-polyfill` (~1.7 MB into the published server, and its RFC-correct DST behaviour SKIPS a daily
02:30 run on the spring-forward day, which is wrong for a job), `rrule.js` (unmaintained since 2023,
"fake-UTC" dates), cron libraries (can't express the cases above).

**DST:** a local time that does not exist (spring forward) runs at the next valid time; an ambiguous one
(fall back) runs once, at the first instance.

**Time zone:** stored on the schedule at creation. The default is the OPERATOR's zone — the browser
reports `Intl…timeZone` and the server records the latest as a machine setting — falling back to the
server's own zone. A WSL or container server is often UTC while the human is not; defaulting to the
server zone is the "9am that ran at 9am UTC" bug every product warns about. The echo always names the
zone.

**Spacing floor:** occurrences closer than 15 minutes apart are refused. Sub-daily rules show their
runs per day in the echo.

## The echo

Every create/update returns the same server-built text, which the agent relays verbatim and the UI
renders:

> **Triage issues** · every Monday at 9:00 (America/New_York)
> Next: Mon Oct 12 9:00 · Mon Oct 19 9:00 · Mon Oct 26 9:00

The describer is ours, over the subset, in house style (sentence case, house duration grammar).

## Creating and changing a schedule — two doors, both agents

1. **Any worker, through the `schedule` MCP tool.** "Every Monday at 9 triage new issues" typed into the
   prompt box dispatches a thread like any other; its worker calls `schedule` (`action: create`) with
   the rule it interpreted, the prompt it distilled, a short title, and the human's own words in
   `when`. The tool answers with the echo. `update`, `pause`, `resume`, `delete`, `run_now`, `list` take
   a schedule id. A scheduled run itself may adjust its own schedule the same way ("skip next week",
   "move to 10am") — that is the dynamic part, and it is visible because it re-echoes.
2. **The Schedules panel's one text box.** The human types plain words — a new schedule, or a change to
   an existing one ("make it Tuesdays") — and the server asks a one-shot model (`claude-oneshot.ts`,
   the same completer the namer uses) to produce `{title, prompt, rrule, dtstart?}` given the current
   time, the zone and (for an edit) the current schedule. The panel shows the echo as a preview; Create
   (or Save) commits. Nothing to pick, nothing to fill in.

Both doors end in the same server validation and the same echo.

## A run

Each occurrence dispatches through `ctx.dispatcher.dispatch` on the schedule's project — exactly the
path the prompt box takes — with the schedule's model/effort/backend (or the operator's saved profile
when unset) and the schedule title as the thread title. The prompt is the saved prompt under a short
header:

- the schedule title, its echo line and id, and that this is a scheduled run;
- the occurrence it is for and, when late, by how much and why (Frizz was off / asleep);
- the previous run's `@thread` and when it started, so "since the last run" prompts work — the run can
  `read_thread` it for the handoff;
- that it may change its own schedule with `schedule`, and that it should sign off as usual.

The thread row records `schedule_id`, so the UI shows a "Scheduled" chip linking to the schedule.

## Firing — at most once, crash-safe

A new scheduler pass, `evalScheduledThreads(now)`, beside `evalTimers`. Due = `next_run_at <= now` on
an active schedule. For each:

1. **Claim** the occurrence: insert a `thread_schedule_run` row `(schedule_id, occurrence_at)` with
   `state='starting'` — unique — in the same transaction that advances `next_run_at`. A second scheduler,
   a re-entrant tick or a restart finds the row and does nothing. This row, not the outbox, is the
   permanent never-twice record (the timer's lesson).
2. **Dispatch.** On success the run row gets the thread slug, `state='started'`. On failure (provider
   signed out, project gone, dispatch error) `state='failed'` with the error; no retry, no tokens spent.
3. A run row left `starting` by a crash is settled `failed` ("Frizz stopped while starting this run") on
   the next pass after a grace — never re-dispatched. At-most-once beats a double run that costs money.

**Missed occurrences** (Frizz off, laptop asleep): catch up ONCE, for the most recent missed occurrence,
and only if it is nearer than the next one (missed Monday 9:00, back Tuesday 10:00 → run late; an hourly
run missed at 10:00, back at 10:40 → wait for 11:00). Older misses are recorded as `skipped` with the
reason. Nobody replays them all; that matches systemd `Persistent=`, Claude Desktop and n8n.

**Overlap:** if the previous run's thread is still WORKING (spinning), the occurrence is skipped and
recorded "previous run still working". No queueing, no killing paid work.

**Back-pressure:** if the last 3 runs are all still in the queue unreviewed (not marked done), the
schedule pauses itself — "Paused: 3 runs waiting for review" — rather than piling up. 3 consecutive
failed starts pause it too. A paused schedule stays visible with its reason; resuming clears it.

## Storage

`thread_schedule` — `id` (`sch_<12hex>`), `project_id`, `title`, `when_text` (the human's words),
`prompt`, `rrule`, `dtstart` (local wall, `YYYY-MM-DDTHH:MM`), `tz`, `model`, `effort`, `backend`,
`state` (`active|paused|ended`), `paused_reason`, `next_run_at`, `created_at`, `updated_at`,
`created_by` (thread slug or `human`), `deleted_at`.

`thread_schedule_run` — `id`, `project_id`, `schedule_id`, `occurrence_at`, `started_at`, `state`
(`starting|started|skipped|failed`), `reason`, `thread_slug`; `UNIQUE(project_id, schedule_id,
occurrence_at)`.

`sessions.schedule_id` — the schedule that started the thread.

Both tables join `STORAGE_TABLES` (import + purge) and the isolation test.

## UI

- **Schedules panel** (a dialog) opened from the project menu, the command palette, and a schedules
  count on the project row when it has any. Lists the project's schedules: title, the echo line, next
  run ("in 3h"), last run (link to its thread), and per-row Pause/Resume, Run now, Delete. Expanding a
  row shows its prompt and run history, skipped and failed runs with their reasons. One text box at the
  top describes a new schedule or, with a row selected, a change to it.
- **"Scheduled" chip** on a thread a schedule started, linking to its schedule.

## Out of scope (v1)

Waking a sleeping machine; "only while I'm at the keyboard" gates; a per-run wall-clock budget; worktree
isolation by default (the saved prompt can ask for one); cross-project schedules from one thread
(`project` stays the caller's).
