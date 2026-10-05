# Scheduled threads

A **schedule** is a saved prompt plus a recurrence. On each occurrence Frizz starts a FRESH thread in the
schedule's project with that prompt, and the result lands in the queue like any other thread. Schedules
are written in plain words — "every Monday at 9am triage new issues", "first weekday of the month bump
deps" — and an AGENT turns the words into a rule. There is no date picker anywhere.

This is the third recurring pattern beside the two Frizz already has, and the one every product with
scheduled agents converged on (ChatGPT Tasks, Codex automations, Claude Code routines, Devin, Cursor): a
fresh context per run.

| | runs in | trigger | tool |
|---|---|---|---|
| goal | the SAME thread | rest / heartbeat / compaction | `goal` |
| timer | the SAME thread, once | an instant | `timer` |
| **schedule** | a NEW thread each time | a calendar rule (+ an optional condition) | `schedule` |

Design history: drafted 2026-10-05 from a prior-art survey (ChatGPT Tasks, Codex automations, Claude
Code routines/Desktop tasks, Cursor, Devin, GitHub Actions, Kubernetes CronJob, systemd timers, Slack
`/remind`, Todoist, Google Calendar, Linear), then revised after two adversarial reviews (runtime
correctness, product/UX). The decisions those changed are marked **(rev)**.

## 1. The rule: an RRULE subset, computed by Frizz, never by the model

The model INTERPRETS; the server COMPUTES. An agent turns the human's words into one RFC 5545 `RRULE`, a
local start (`DTSTART` as wall clock, `YYYY-MM-DDTHH:MM`) and an IANA zone. Frizz validates it, works out
every occurrence itself (`packages/shared/src/schedule-rule.ts`), and answers with an echo built from the
rule it will fire — so a mistranslated "9am" is visible before it runs, not after.

- **Why RRULE, not cron:** "every other Friday", "every 3 days", "the first weekday of the month" and
  "for three weeks" need INTERVAL anchored on a start, BYSETPOS and COUNT/UNTIL. Models write RRULE
  fluently; ChatGPT, Codex, Devin and Google Calendar all use it.
- **Subset:** `FREQ` HOURLY…YEARLY, `INTERVAL`, `COUNT`, `UNTIL`, `BYMONTH`, `BYMONTHDAY` (±),
  `BYDAY` (ordinals under MONTHLY/YEARLY), `BYHOUR`, `BYMINUTE`, `BYSETPOS`, `WKST`. Everything else is
  refused with a reason an agent can act on.
- **Own engine, zero dependencies.** `rrule-temporal` needs `temporal-polyfill` (~1.7 MB into the
  published server) and, being RFC-correct, SKIPS a daily 02:30 run on the spring-forward day. `rrule.js`
  is unmaintained. Cron libraries cannot express the cases above.
- **DST:** a local time that does not exist runs at the next valid time (02:30 → 03:30); an ambiguous one
  runs once, at its first instance. **(rev)** The existing `instantForZonedWallClock` in
  `usage-limit.ts` gets both wrong (shifts backward west of UTC, picks the second instance east of UTC)
  and builds a formatter per call; the engine has its own conversion with one cached formatter per zone.
- **DTSTART is an occurrence only if it matches the rule** (rrule.js / dateutil semantics). BYSETPOS
  applies per period before the DTSTART filter; COUNT counts from DTSTART.
- **Spacing floor:** occurrences closer than 15m are refused; sub-daily rules state runs per day.
- **Time zone (rev):** the browser reports its `Intl` zone on load (`reportClientZone`) and the server
  keeps the latest as a machine setting; that is the default for every new schedule, falling back to the
  server's zone. A WSL or container server is often UTC while the human is not. The zone is STORED on
  the schedule. The echo names the zone only when it differs from the viewer's.

## 2. Dynamic: a rule spine, a plain-words condition, and per-run moves (rev)

"Interpret dynamically" is more than create-time translation. Three layers, each bounded:

1. **The rule** is the deterministic spine: echoable, previewable ("next 3 runs").
2. **An optional condition in the human's own words**, never compiled: "every Monday unless it's a
   holiday" → rule = Mondays 9am, condition = "skip US public holidays"; "the day after each release" →
   rule = daily 10am, condition = "a release was published yesterday". At fire time the run's header
   opens with the condition: check it first; if it does not hold, finish quietly (below) with the reason.
   The run is the only evaluator with tools (`gh release list`), so it is the right one.
3. **Per-occurrence changes**: skip the next run, move it, edit just its prompt — without touching the
   rule. These fall out of how the next run is represented (§4).

Rejected: an agent choosing each next time after every run — no echo, no preview, and one failed run
ends the chain. "While I'm at the keyboard" is refused honestly: Frizz has no presence signal yet.

## 3. Creating and changing a schedule (rev)

**The prompt box gets a schedule mode**, beside the lazy-thread button (a button and a chord). In
schedule mode, submitting sends the text to ONE server interpreter — a one-shot model call
(`claude-oneshot.ts`, the completer the namer uses) given the current local time and zone. It returns
the exact schedule phrase it found in the text (a substring), the rule, the start, an optional
condition and a two-word title. **It does not rewrite the prompt:** the saved prompt is the typed text
with that phrase removed, verbatim. The box shows the echo ("Triage issues · every Monday at 9am · Next:
Mon Oct 12 · Mon Oct 19 · Mon Oct 26") with Create schedule / Esc. The project and the model/effort are
the box's own picks, snapshotted onto the schedule. When the typed text STARTS with a recurrence phrase
("every …", "each …", "weekdays …", "daily …"), the schedule button lights as a hint; Enter still
dispatches normally — "every time the build fails, fix it" is a dispatch, not a schedule.

**Any worker can PROPOSE a schedule** with the `schedule` MCP tool — the mid-thread "great, do this every
Monday" case. It submits the rule it interpreted, the human's words in `when`, the prompt, a title,
model and effort; `dry_run` echoes without saving. **A worker-made schedule starts `proposed`:** it does
not fire until a human clicks Turn on. A worker reading untrusted text must not be able to create
something that runs unattended forever, and `ask` cannot gate it (an unanswered question takes its
recommended option after 10m). A worker may refine its own proposal (`update`), and on an ACTIVE
schedule it may only `skip_next`, `move_next` and `pause` — the per-occurrence moves a scheduled run
legitimately needs ("nothing to do until the release; move the next run to Thursday").

**Editing** lives on the schedule (its drawer): "Change when" re-interprets plain words against the
stored words, rule and condition, re-echoes, and Save commits; the prompt is a plain text area edited
verbatim; Pause/Resume, Run now, Delete.

Both creation paths end in the same server validation and the same echo, built by
`describeSchedule` + `formatOccurrence`.

## 4. The next run IS a lazy thread (rev)

Each active schedule keeps exactly ONE materialized next run: a **lazy thread** (plans/lazy-threads.md —
a thread row with `lazy_prompt` and no agent yet) carrying `schedule_id`, with `snoozed_until` = the
occurrence. The board shows a lazy row with a `schedule_id` in **Snoozed** with its wake time, whether or
not the time has passed, until the scheduler starts it or the human acts on it. So the upcoming run sits
where the human already looks, and every per-occurrence act is one they already know:

| human act on the next run | means |
|---|---|
| send it / Run now | run now (this occurrence) |
| Mark as done / delete | skip this occurrence |
| snooze it to another time | move this occurrence |
| edit its note | change just this run's prompt |
| unsnooze it | run now |

It also settles three runtime problems: the slug is reserved when the lazy row is created, so two runs
can never pick the same slug and have the broker kill the first; the session row exists BEFORE the
spawn, so a crash cannot leave a paid worker with no row; and one materialized instance per schedule
makes catch-up-once structural.

Launch goes through `startLazyThreadRow` (router.ts) — the same path a human's send takes — with the
run's header prepended to the lazy note.

## 5. A run

The prompt is the run's lazy note under a short header:

- that this is a scheduled run, the schedule's title, echo and id;
- the condition, first, when there is one: check it; if it does not hold, finish quietly with the reason;
- the occurrence it is for, and when late, by how much and why ("Frizz was off" / "the computer was
  asleep", from `awake-clock.ts`);
- the previous run's `@thread` and when it ran, so "since the last run" works (`read_thread` it);
- how to finish quietly when there is nothing for the human, and that it may `skip_next`/`move_next`.

**Quiet finish (rev):** `done` takes `quiet: true` on a scheduled run only. The thread goes straight to
Done instead of the queue and the schedule's history shows the body's first line ("Nothing new — no
issues since Oct 5"). This is Codex's "nothing to report" auto-archive; without it an hourly check fills
the queue with nothing.

Runs take the schedule's title; a collision takes a numeric suffix (`Triage issues 2`), never the
namer's significant-word fallback. Naming uses the saved prompt, never the header.

## 6. Firing — at most once, off the tick

`evalScheduledThreads(now)` in each project's scheduler, beside `evalTimers`. For each active schedule
whose materialized run is due:

- **Reconcile first.** If the human already acted on the next run — started it, marked it done,
  deleted it — record that occurrence (`started` / `skipped: by you`) and materialize the next one.
- **Claim** synchronously in the tick: one transaction inserts the `thread_schedule_run` row
  (`UNIQUE(project_id, schedule_id, occurrence_at)`, `state='starting'`, `owner` = this scheduler) and
  bumps the schedule's `revision` guarded on the revision it read; zero rows changed = someone edited
  it meanwhile, try again next tick. The run row, not the outbox, is the permanent never-twice record.
- **Launch off the tick**: the start runs in a tracked in-flight promise that `stop()` awaits, so an
  auth preflight or a cold daemon never stalls the project's other wakes. On success the run row is
  `started`; on failure (signed out, project folder gone) it is `failed`, nothing is retried, and the
  next occurrence is materialized.
- **A `starting` row whose owner is not this process** was cut off by a stop; the global lease means
  that owner is dead. If its thread is no longer lazy it started (`started`); otherwise `failed`.
- **Missed occurrences:** one materialized instance means a week asleep wakes ONE overdue run. It runs
  late only within `min(half the gap to the following occurrence, 12h)` (12h when there is none);
  beyond that it is skipped ("Skipped: Frizz was off", with how many were missed) and the next is
  materialized. Never on first sight: overdue runs wait out a short post-boot grace, so the tailer has
  vouched for the previous run's state first.
- **Overlap:** if the previous run is still WORKING — the board's `isActivelyRunning` on a vouched view,
  not raw telemetry, which reads a dead daemon as in-flight forever — the occurrence is skipped ("the
  last run was still working"). An unvouched reading defers. Three such skips in a row pause the schedule.
- **Machine-wide start cap:** at most 2 scheduled starts in flight at once; the rest go a few seconds
  late, not skipped.
- **Back-pressure (rev):** "unreviewed" = a started run whose thread row exists and is not archived. At 3,
  the schedule pauses itself ("Paused until you review 3 runs") and RESUMES ITSELF when the human clears
  them — their act is the resume. Three failed starts in a row pause it too ("Couldn't start 3 times"),
  and those need a human resume.
- **Resume** never catches up: it materializes the first occurrence after now.
- **Edits** (rule, prompt, profile) bump `revision` and re-materialize the next run, keeping a per-run
  prompt edit the human made to that lazy note.

## 7. Storage

`thread_schedule` — `id` (`sch_<12hex>`), `project_id`, `title`, `when_text` (the human's words),
`prompt`, `condition`, `rrule`, `dtstart`, `tz`, `model`, `effort`, `backend`, `state`
(`proposed|active|paused|ended`), `paused_reason` (`human|review|failures|stuck`), `revision`,
`next_slug` (the materialized lazy run), `next_occurrence_at`, `last_occurrence_at` (monotonic),
`consecutive_failures`, `consecutive_overlaps`, `created_by` (thread slug or `human`), `created_at`,
`updated_at`.

`thread_schedule_run` — `id`, `project_id`, `schedule_id`, `occurrence_at`, `started_at`, `state`
(`starting|started|skipped|failed`), `reason`, `summary` (a quiet finish's first line), `thread_slug`,
`session_id`, `owner`; `UNIQUE(project_id, schedule_id, occurrence_at)`.

`session.schedule_id` — on the lazy row from creation; dispatch's upsert never clears it.

Both tables join `STORAGE_TABLES` (import + purge) and the isolation test. Caps: 25 schedules per project
(proposed + active + paused); run history kept to the last 200 rows per schedule.

## 8. UI

- **Prompt box schedule mode** (§3).
- **A fourth count on the project row** — schedules, with a repeat glyph — toggling the project's
  schedules IN PLACE like Snoozed/Done/External. Row: title · short rule · right column next run
  ("in 3h") or "Paused" / "Proposed". The count takes the warning tone when a schedule was paused by
  Frizz or is waiting for Turn on.
- **A schedule drawer** (the drawer stack, not a modal): the echo and next runs, the condition, the
  prompt (editable verbatim), "Change when", the model/effort, Pause/Resume, Run now, Turn on/Discard
  for a proposal, Delete ("Delete Triage issues? Its past runs stay."), and history — each run linking
  to its thread drawer; skipped and failed rows with reasons.
- **Command palette:** "Schedules" lists every schedule across projects and opens its drawer.
- **A run's row** carries a repeat glyph (tooltip "From Triage issues · every Monday at 9am"); the next
  run sits in Snoozed as a lazy row with the same glyph.

## 9. Out of scope (v1)

Waking a sleeping machine; a presence gate; a per-run wall-clock budget; worktree isolation by default
(the prompt can ask for one); a worker creating schedules in another project; one-off schedules
(`COUNT=1` is allowed, but "tomorrow at 8, do X" is better as a lazy thread snoozed until 8).
