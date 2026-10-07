# The schedule in the words — the prompt box, as built

Built 2026-10-06 on the maintainer's direction, which retired the local grammar and the schedule mode this file
specified the day before:

> there should not be a dedicated schedule this button. it should determine intent from the standard prompt
> submission. the ui I mentioned should look for certain common scheduling words (every, morning etc.) and if they
> appear, run a lightweight agent to extract a schedule from the text. that extracted schedule should be
> immediately reflected in the ui as the user keeps typing and eventually submits

The spec it replaced (Tab to accept an offer, a mode, a grammar reading with no model) is
`git show 7e0b68b5:plans/schedule-live-reading.md`. Code comments that cite its §3.4, §3.5 or §13 (the echo fixes in
`schedule-rule.ts`, the one-shot completer) mean that version. The grammar's measured conclusion is in
`plans/scheduled-threads.md` § 10.

## In one screen

You type `every Monday at 9am triage new issues`. `every` is a schedule word, so the words go to the model as you
finish each word. When it answers that they ask for the work to REPEAT, the box shows what Enter will do:

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ▒every Monday at 9am▒ triage new issues                                  │
│                                                                          │
│ GPT-5.6 Sol › medium ⌄                                      ⎘   🐌   [↻] │
└─┬──────────────────────────────────────────────────────────────────────┬─┘
  │ ↻ Every Monday at 9am · next Mon Oct 12, in 6d                      × │
  │   Each run: triage new issues                                         │
  └──────────────────────────────────────────────────────────────────────┘
```

The phrase wears the highlight, the strip says the rule, the next run and what each run does, and the send glyph is
↻ ("Create schedule (Enter)"). Enter, the send button and the phone's send are the only submit: they create the
schedule, the box clears, and the toast offers Undo and Open. × or Esc says "not a schedule", and Enter then starts
the thread. Words with no schedule word look and behave exactly as they did before schedules existed.

## The decisions, as built

**D1 — no button, no mode, no chord.** The box has one submit. `composerKeyboard.ts` has no schedule chord.

**D2 — the trigger.** `SCHEDULE_TRIGGER_WORDS` in `packages/shared/src/schedule-trigger.ts`: a closed list matched
as whole words, case-insensitively, outside code, quotes, chips, @mentions and /commands. It is a gate, not a
reading: a trigger costs a model call and shows nothing until the model finds a schedule. Its header carries the
measured cost (it fires on 6.0% of the maintainer's past prompts) and the measured misses (5 of the benchmark's 214
schedule requests, dispatched as plain threads).

**D3 — when the box reads** (`scheduleReadScheduler.ts`, `scheduleModelRead.ts`).
- At once when a word ends (space, newline, punctuation) or the text changes wholesale (paste, undo, cut). Mid-word,
  after 500ms of rest. Never while an IME composes. A change another box made waits for the rest.
- One read out per draft. While it is out, only the LATEST text waits behind it.
- A 10m cache across every box, keyed by context, zone, local date and text, holding verdicts only. A failed
  transport is never cached, so a submit asks again. An answer past its 10m (or read on another day) is EXPIRED, not
  gone: it stays on screen as not current, and the box reads its words again.
- 40 automatic reads per draft. Past that, only a submit reads. A read that hangs is given up after 15s.

**D4 — what shows.**

| The words | The box |
|---|---|
| No schedule word | Nothing changes. |
| A read out | Nothing for 900ms, then a faint dash under the schedule words (`data-composer-mark="pending"`). A quick answer never shows it. |
| A schedule | Highlight on the phrase, the strip, ↻ on send. |
| No schedule (the model's usual answer) | Nothing, and the dash goes. |
| A schedule the box cannot make (sooner than 15m apart, "while I'm at the keyboard", nothing left to run, a rule with no words) | The strip says so, ending "Enter starts it now." |
| Newer words while a reading shows | The reading stays in place, marked updating, and shimmers after 250ms; ↻ stays. `Each run` and the highlight follow the words as typed. The new answer replaces it in the same element, and an answer of none takes it away. |
| Newer words, and no read coming for them (the budget spent, the read failed) | The reading stays, marked updating, faint and still, and the send is plain ↑: Enter checks the words first. |

The strip's next runs are computed in the browser from the rule and the clock (`schedulePreviewModel`), so they move
on with no new read. A narrow desktop row drops `, in 6d`, then `· next Mon Oct 12`, then ellipsizes the rule. A
phone drops `next Mon Oct 12` first and keeps `in 6d`. The reading kept while newer words are read is the answer to
the newest earlier text in TYPING order (`newestAnswer`), never the last to land, so an older answer arriving late
cannot replace a newer one. The typing history keeps every text that can still answer — out, queued, answered, failed
— from the newest answer on, however many texts are typed while a read is out; it held the last 24 texts until the
fix round, and a slow read's answer fell out of it.

**D5 — Enter.**

| At Enter | Enter does |
|---|---|
| No schedule word, or the reading's phrase dismissed | Starts the thread |
| A schedule reading of exactly these words | Creates it |
| The answer for these words is none, or a refusal already on screen | Starts the thread |
| No answer for these words yet (or a read that failed while typing) | Defers (below) |

**Enter never waits on the model (rev 2026-10-07; maintainer: "change checking for a schedule so that it doesnt delay
submitting the prompt").** A deferred Enter takes the whole draft out of the box at once — the words, chips, pick,
limit — and the toast says "Checking for a schedule…". The dispatch input and a schedule's prompt are both built from
that snapshot at the Enter (`NewThreadModal detach`), so the box is free for the next prompt and the `c` dialog closes.
The answer then settles it (`settleAct`, `awaitReading`):
- a schedule is created, and its toast names it ("Triage issues scheduled · Every Monday at 9am · next Mon Oct 12, in
  6d", Undo, Open); Undo merges the words back into the box, dismissed;
- none, or a reading dismissed before Enter, starts the thread;
- a refusal or a failed or 15s-unanswered read starts the thread, and its toast says why.

Nothing is ever dispatched silently in place of a schedule the human may have meant: the toast is the line. Until
2026-10-07 the Enter HELD in the box instead — the send spun, "Checking for a schedule…" showed under it, typing or
Esc cancelled it, and a failure stopped on its line for a second Enter. That machine (`submitStep`, the per-draft
`claimDraftHold`) is gone with it.

A create keeps the existing success path: the toast (8s Undo window) and the flash on the project row's schedule
count. While it is in flight it owns its draft (`beginDraftCreate`): a re-aim does not carry the words, and Undo waits
for it.

**D6 — a reading is used only for the exact text being submitted** (its trimmed words). Any edit is re-read before
anything is created. A cached reading costs nothing to reuse, so nothing relocates an old reading onto new words.

**Dismissal and Undo.**
- × or Esc stores the phrase as DISMISSED in the draft's sibling key (`draftKey.dispatchSchedule`, sessionStorage), so
  it survives a remount and a reload. It lifts when the words lose their last schedule word, when the model answers
  none, or when it reads a different phrase.
- Said over a strip that is still the reading of EARLIER words (updating), it is PENDING: it holds for the words on
  screen and takes their reading's phrase when it lands (`dismissedPhrase`), so a longer phrase landing does not
  lift it.
- A dispatch or lazy save that fails puts the dismissal back with the words.
- The toast's Undo deletes the schedule. The words come back with the phrase dismissed, and the strip says "Schedule
  undone. Enter starts it now." with "Schedule it" to lift the dismissal.

**Titles: compare-and-set.** A reading carries the model's title. When the model gave none, the box sends
`provisionalScheduleTitle` (the cut prompt's verb and head noun) with `titleAuto: true`. The server's thread namer
then renames it, only if nothing touched the row first (`autoTitle` in `packages/server/src/schedules.ts`).

**One draft, two boxes.** The `c` dialog edits the page box's draft and shares its reader (`sharedModelReader`), so
each text is read once. Its first Esc dismisses the strip, through the dialog's escape claim. The second Esc closes
the dialog.

**D7 — Change when** (the schedule drawer). The field reads live by the same rules, against the schedule's stored
rule and condition. It keeps the last reading while new words are read, and offers Save only on a fresh reading of
exactly the field's words (`changeWhenView`). Once its panel is up for an edit it stays, as the reading line, until
there is something else to say: it never opens and closes word by word.

**D8 — the grammar is gone.** `packages/shared/src/schedule-phrase*.ts`, `scripts/schedule-phrase-history.ts`,
`scheduleOffer.ts` and `scheduleWhenField.ts` are deleted. The server no longer re-derives a local reading, and its
strict input schema now refuses the retired `source` field. What the box still needs from text is in
`packages/shared/src/schedule-text.ts`: `locatePhrase`, `cutPhrase` and `provisionalScheduleTitle`.

**D9 — the phone.** The same behaviour. The strip is a tap row with a 32px ×, and its lines name Send, never a key
("Send starts it now."). The box lives in the New thread sheet, which closes when a schedule is made, so Undo opens
the sheet again on the words and their line.

## The model

`interpretSchedule` (`packages/server/src/schedule-interpreter.ts`) decides intent and the rule in one read. Two
answers it cannot use (not JSON, no time of day, a phrase not in the words) are a failed read, never "no schedule". It is
Sonnet, by measurement (71ae2ec7): 214 of 214 benchmark requests gave the same next 5 runs, against Haiku's 179 with
31 wrong (paired McNemar p < 0.001). One read at a time through `claude-oneshot` with a spare CLI answers in 1.69s
median (4b8a4de5). The kept benchmark is `scripts/schedule-extract-eval.ts`; run it when the interpreter's prompt or
model changes.

## Where it lives

| File | What |
|---|---|
| `packages/shared/src/schedule-trigger.ts` | The gate |
| `packages/shared/src/schedule-text.ts` | Finding and cutting the phrase; the provisional title |
| `packages/web/src/lib/scheduleReadScheduler.ts` | When to read |
| `packages/web/src/lib/scheduleModelRead.ts` | The reader: single flight, cache, budget, timeout, the kept answer |
| `packages/web/src/lib/scheduleIntent.ts` | Pure: the answer's meaning, dismissal, the submit machine, the strip's view |
| `packages/web/src/lib/scheduleDraftState.ts` | The draft's dismissal record; the create hold |
| `packages/web/src/components/ScheduleComposer.tsx` | `useLiveSchedule` and the strip, with its measured optics |
| `packages/web/src/components/Composer.tsx` | The marks and the ↑/↻ cross-fade, with its measured optics |
| `packages/web/src/components/SchedulePreview.tsx` | A rule's words and next runs; Change when's view |
| `packages/web/src/components/ScheduleDrawer.tsx` | Change when |

## Tests

- **Unit** (`nub --test`): `scheduleReadScheduler.test.ts`, `scheduleModelRead.test.ts`, `scheduleIntent.test.ts`
  (every D5 branch), `scheduleDraftState.test.ts`, `SchedulePreview.test.ts`, `ScheduleComposer.test.ts`,
  `schedule-text.test.ts`, `schedule-trigger.test.ts`, `composerKeyboard.test.ts` and the server's
  `schedules.test.ts`.
- **Browser**: `composerScheduleLive.e2e.test.ts`, 23 cases, run with `nub run test:e2e -- composerScheduleLive`.
  Cases 16–23 are the fix round's findings (F1, A, B, F, C, H, G, F3), each written failing first.
  - It drives `schedule-live-fixture.html`: the real `DispatchForm`, the `c` dialog and the Toaster, over a stubbed
    RPC seam that counts every call, at a fixed clock (Mon Oct 5 2026, 2:32pm New York).
  - A rAF instrument records every frame of the strip and the marks, so "never opened" holds for every frame.
  - `FRIZZ_SCHEDULE_SHOTS=<dir>` saves the evidence shots (`intent-*.png`).
- **Not yet driven**:
  - the box against a real server and the real model (the e2e stubs the RPC; the model is measured alone by the
    benchmark);
  - Change when in a browser (its view is unit-tested);
  - a remount and a re-aim mid-read in a browser (unit-tested at the draft-state level).
