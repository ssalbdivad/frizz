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

## 10. Live reading

The prompt box reads a schedule phrase as it is typed, with no model, through the local grammar in
`packages/shared/src/schedule-phrase.ts`. The design is `plans/schedule-live-reading.md`; its corpus and tests
are `schedule-phrase.corpus.ts` and `schedule-phrase.test.ts`, and `scripts/schedule-phrase-history.ts` is the
standing gate against false offers (0 of the maintainer's 1,296 history prompts offered, 2026-10-05).

**The agreement experiment (2026-10-05, one time; the harness is deleted).** The grammar against the real
interpreter (`createScheduleInterpreter` over `createClaudeOneShot`, Sonnet, at the spec's clock Mon Oct 5 2026
14:32 New York) on every text the grammar reads `exact` in the mode: 196 texts, one model run each. The
interpreter refused 41 phrase-only texts for having no task (its own rule, `What should each run do?`); those ran
again with `, check CI` appended. Each disagreement was classified by hand.

| Outcome | Texts |
|---|---|
| Same RRULE and DTSTART | 151 |
| Same next 12 runs, different text (COUNT's position, an explicit `INTERVAL=1`, `MONTHLY;INTERVAL=3` for a quarter, a past DTSTART on a rule with no interval, `BYSETPOS=2,4` for the 2nd and 4th Wednesday, `YEARLY;COUNT=1` for a date) | 29 |
| What the text leaves open: a part the grammar marks assumed (`nightly` 9pm vs midnight, `afternoon` 2pm vs 3pm, `at 6` 6pm vs 6am, `every month` and `every other month` on the 1st vs the 5th, `every other week`'s phase) | 6 |
| What the text leaves open: an interval's anchor (`every 4 hours` at 15:00 vs 16:00; `every other day` from tomorrow vs from this morning's passed 9am, where the probe corpus's author agreed with Sonnet and the grammar's first-run anchor is the documented choice) | 2 |
| **Model slips** — `Friday at 3pm` read as every Friday (×2); today's remaining runs dropped (`weekdays at 9am and 5pm`, `every 2 hours on weekdays from 9 to 5`, both started tomorrow); `every two weeks on Monday at 10` anchored on this morning's passed 10am, first run Oct 19 (the corpus expected Oct 12) | 5 |
| **Grammar bugs, fixed and pinned** — `every day this week` dropped its bound (Sonnet: no schedule); `have it done by Friday every week` dropped `by Friday` and assumed Monday (Sonnet: Fridays); `stop at 5pm today` read a time box as a one-off (Sonnet: no schedule). Each is now a cue, so in the mode the model reads it; none of the three was offered in the box | 3 |

180 of 196 (92%) agree on every run; 186 agree once the parts the grammar flags as assumed are set aside. The
phrase spans agree on 193 of 194 readings (the one: Sonnet took `runs every hour` where the grammar took `every
hour`, in a question about a cron job). Strength: one run per text, one time of day, and a corpus written by the
grammar's author, so an upper bound on agreement; Sonnet's run-to-run variance was not measured. Both readers also
read mid-text dispatches as schedules in the mode (`list every Friday release from the changelog`); the box keeps
those dark, and the mode is entered only on purpose.

**The temporal residue (fix round 3, 2026-10-06; grammar v4).** A third break-it pass found nine classes of exact
readings that were silently wrong. Most were a word of time away from the phrase: a zone at the end of the text, a
bound a sentence later, a count before it. No list of the words beside a phrase reaches those, so an exact reading
now passes one more gate. If any word of a closed class of time words is left in the text it would save as the task,
the reading is a cue. It keeps its core only when those words can only narrow it (`plans/schedule-live-reading.md`
§3.1, fix round 3). *Measured*, v3 against v4, both scopes:

| Set | Exact in v3 | Now a cue | Offers in the box | Exact offers now cue offers |
|---|---|---|---|---|
| Probe corpus, 133 texts | 172 | 6, 4 of them with the core | 98 → 98 | 3 |
| Pinned cases, 297 texts | 339 | 6 | 205 → 205 | 3 |
| 26 realistic requests | 39 | 2 | 25 → 25 | 1 |
| History, 1,296 prompts | 4, all mid-text | 2 | 0 → 0 | 0 |

- No offer went dark.
- Every demotion in the corpora is unnecessary: a word of time that is the task's own (`… summarize overnight Sentry
  errors`, `… what shipped this week`, `… what the agents did today`). Each costs one model read in the mode.
- Round 3's majors: 0 of 124 reads (both scopes) are exact and wrong, against 114 in v3.
