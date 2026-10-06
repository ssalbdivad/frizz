# Live schedule reading in the prompt box — the build spec

Final design, written 2026-10-05 against local `main` at 8459cf6f. This is the version to build. It takes design 1
("Lit phrase: inline when-token with a hanging reading ledge", `live-preview-design-inline-token.md`) as the
spine, which all three judges picked, and grafts or drops the parts the judges named. Where the judges disagreed,
§1.3 says which way this spec goes and why. An implementer should not need the inputs, but they are beside this
file: `live-preview-prior-art.md`, `live-preview-code-map.md`, `live-preview-latency.md` and the four
`live-preview-design-*.md` files. Nothing here has been built or driven in a browser. Every number marked
*measured* comes from those reports or from §3.6 of this file, with the strength of the evidence given beside it.

---

## 0. The feature in one screen

You type `every Monday at 9am triage new issues`. When `9am` becomes a finished word, a dotted grey underline
draws itself under `every Monday at 9am`, and a one-line ledge slides out from under the box:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ every Monday at 9am triage new issues                                        │
│ ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈                                                          │
│ Opus · high                                              ⎘   ↻   🐌   [↑]    │
└─┬──────────────────────────────────────────────────────────────────────────┬─┘
  │ ↻ Every Monday at 9am · next Mon Oct 12, in 6d   ⇥ Schedule  ↵ Start now  × │
  └──────────────────────────────────────────────────────────────────────────┘
```

Nothing about Enter has changed. The send button still shows `↑`, and the ledge prints `↵ Start now`. Press
**Tab** and the dotted underline floods into the accent mark. The ledge grows into the schedule panel with
**Create schedule already enabled**, because no model call is needed. The send button's arrow becomes the repeat
glyph. Enter now creates the schedule. The toast says `Triage issues scheduled` and offers **Undo**.

If the box guessed wrong (the prompt is *about* a schedule), Esc or the ledge's `×` puts it away. It stays away
for that end of the prompt, in that draft, across remounts and reloads.

The model (Sonnet, unchanged) reads only what the local grammar declines: conditions, vague counts, event
offsets and zones. It runs only **after** the human has asked for a schedule, never while an offer is merely
showing.

### 0.1 Storyboard (what each keystroke does)

Clock for every example in this spec: **Mon Oct 5 2026, 2:32pm, America/New_York**.

| Typed so far | What shows |
|---|---|
| `every` | Nothing. A gate word with no complete reading. |
| `every Mon` | Nothing. Mid-word text is never read. |
| `every Monday␣` | The underline draws under `every Monday` (180ms). The ledge slides in: `↻ Every Monday at 9am · next Mon Oct 12, in 6d`, with `at 9am` dimmed (assumed). |
| `every Monday at 9` | Unchanged. The last reading is held while a word is half-typed. |
| `every Monday at 9am␣` | Only the new tail of the underline draws. `at 9am` goes from dim to solid (120ms): the box has caught up with what you said. |
| `…triage new issues` | If the ledge is wide enough, an `Each run: triage new issues` segment fills in at each word boundary. Nothing else moves. |
| **Tab** | The underline floods into `bg-accent/15`, left to right. The ledge grows into the panel, and the send glyph becomes `↻`. Create is enabled. |
| **Enter** | The mark washes bright and back. The box clears and the panel folds away. Toast: `Triage issues scheduled` with Undo and Open. The project row's schedule count flashes once. |

Why this should feel satisfying: it is **instant** (the reading appears with the space that completes the
phrase, ~1ms of grammar and ≤2ms of echo). It is **mapped**: the words get the mark and the ledge says what they
mean, linked by position and by motion. It is **concrete**: a date and `in 6d`, not just a rule. It is **honest
about guesses**: assumed parts are dim and turn solid as you type them. It is **continuous**: what was offered is
the same object you accept, in the same pixels. It is also **quiet**: one 28px line, no accent colour and no
motion until a phrase completes, and on this human's own 1,296 past prompts it would almost never appear
uninvited (§2.6).

---

## 1. Where every decision came from

### 1.1 The spine: design 1
These come from design 1 and are kept:
- the local grammar in `packages/shared`;
- the dotted underline in the existing backdrop layer;
- the hanging ledge, which grows into the panel on accept;
- Tab accepts and Esc/× dismisses;
- `↵ Start now` printed on the ledge;
- **the send button's glyph swaps to the repeat glyph in the mode**, which the judges called the strongest
  single safety cue;
- `describeScheduleParts`, for dimming assumed parts;
- the close-edge guards (recurrences only, no deadline word within two words);
- quotes, backticks and fences as the escape hatch;
- the 400ms disappear hysteresis;
- `Each run:` in the panel;
- the store-first landing order.

### 1.2 Grafts (each was named by at least one judge)
| Graft | From | Judges |
|---|---|---|
| T3 commit authority. A synchronous re-read at Enter means a mismatch creates nothing and shows the new reading. The server re-derives a local reading with the same grammar. | design 3 | 1, 2, 3 |
| One pure `keyAction(state, key)` reducer, tested against the full key matrix, with the properties "mode off never creates" and "mode on never dispatches or saves lazily". | designs 3, 4 | 1, 2, 3 |
| The mode is stored in the draft store under a sibling key and cleared with the draft. It lands in its own commit before any live UI. | designs 3, 4 | 1, 2, 3 |
| ⌘⇧↵ and the snail do nothing in the mode. | designs 2, 3, 4 | 1, 2, 3 |
| Local `event` and `presence` vetoes run inside the mode before any model call. | design 4 | 1, 2, 3 |
| Tab, ⌘⌥↵, the glyph and Enter in the mode re-read synchronously before acting. | designs 3, 4 | 1, 2, 3 |
| A consistency check on a model reading over a local core: the model's span contains the core, and its runs are a subset of the core's. Failure disables Create for the key **and** the button. | designs 2, 4 | 1, 2, 3 |
| An `ambiguous` kind (biweekly, bimonthly, weeknights, quarterly with no day): "Say which", with no accept and no model call. | design 2 | 1, 2, 3 |
| The no-silent-prefix property test. History-check thresholds that fail the step. | design 4 | 1, 2 |
| A model reading is keyed to its phrase, so edits to the task alone keep it and re-cut the prompt. | designs 2, 3 | 1, 2 |
| Model reads only in the mode, single flight per box, a 10m cache, no `interpretSchedule` contract change in v1. | design 4 | 2, 3 |
| A provisional title from the cut prompt, then a namer rename with compare-and-set. | designs 2, 4 | 1, 2 |
| Undo **and** Open on the toast, which needs a second toast action (budgeted in §14). | design 3 | 1, 2 |
| `⇥ Schedule`, `↵ Start now` and `×` never truncate. At narrow widths `in 6d` goes first. | design 3 | 3 |
| A close-edge offer publishes after 800ms idle. An open-edge offer publishes at the word boundary. | design 2 | 3 |
| One-shots are dark as offers and still read inside the mode and in Change when. | designs 2, 4 | 1, 2, 3 |
| The windows skip code fences, @mentions, /commands and staged context tokens, and a leading /command. | designs 2, 3 | 1 |
| An `Each run: …` segment on the offer itself, the first thing to drop when narrow. | design 2 | 1 |
| The project row's schedule count plays `queue-flash` once on create. | design 4 | 1 |
| Change when gets an old-vs-new diff calendar (phase 2). | design 2 | 2, 3 |

### 1.3 Disagreements, resolved
1. **What Undo restores.** Judge 1 wanted the draft back *with the mode on*. Judges 2 and 3 wanted it *with the
   mode off and the edge dismissed*. **This spec does neither: Undo restores exactly the state before the accept.**
   That is the text (merged with anything typed since, via the house's `mergeIntoDraft`), the mode off, and the
   dismissals as they were. A visible offer therefore comes back. Why: both alternatives guess the human's intent
   and each fails one real case.
   - With the mode on, the Tab-then-Enter accident (the main reason to press Undo) recreates the schedule on the
     next reflexive Enter.
   - With the mode off and the edge dismissed, the next Enter dispatches with **no** cue on screen. That is the
     irreversible act, made with nothing saying so.

   Restoring the pre-accept state gives each intent a single key, Enter (start now) or Tab (schedule again), and
   the ledge prints what both do. It is also what "undo" means in every editor.
   *As built (fix round 1, X1):* the pre-accept state is restored only if nothing has set the mode since. Inside
   the 8s window the human can type the next schedule and press Tab; Undo then deletes the first and merges its
   text back, but leaves that newer mode ON (`draftAfterUndo`, `scheduleIntent.ts`). Undo is not one of the acts
   I-3 lets end a mode, and ending it here left the merged text one Enter from a dispatch. In the mode the merged
   text reads as a compound cue, so nothing exact is offered from it.
   *As built (fix round 3, undo-into-mode-recreates-undone): X1 is reversed, and this item's decision holds in
   every case.* X1's premise was false whenever the box held no phrase of its own: the undone words go FIRST
   (`mergeIntoDraft`), so a mode kept on over an empty box (⌘⌥↵, M5) or over plain words the model had refused
   (M4) read the merged text `exact` as the undone rule, the panel came back ready, and the next Enter created it
   again — with the new words folded into its prompt (driven on the fixture: create 2, delete 1). Now
   `draftAfterUndo(preAccept)` writes `{on: false, dismissed: preAccept}` whatever record it finds, so Undo is one
   of the acts that END the mode (I-3). The cost, taken knowingly: Tab on the next schedule and then Undo of the
   last one ends the new mode too; the merged text's offer is on screen with `↵ Start now`, and Tab sets the mode
   again. Two more cases the same rule now covers: Undo waits until no create on that draft is in flight
   (`afterDraftCreates`, I-4), so the next schedule's words have left before the undone ones come back; and
   after a re-aim the words go back to the draft the schedule was created from, not the box on screen, whose own
   text and mode are left alone (e2e 33).
2. **Dismissal key.** Judge 1 wanted it keyed by rule shape. Judges 2 and 3 wanted it per edge. **Per edge**, and
   it re-arms only when that edge holds no gate word. Once the human has said "not a schedule", changing Monday to
   Tuesday is not new evidence. The glyph stays lit, so the way back is one key.
3. **Arming Enter on an open-edge offer** (judge 3's narrowed version of design 4). **Not in v1**, with judges 1
   and 2. Even narrowed, an arm makes Enter's first press do something other than what `↵ Start now` says, and it
   needs a 300ms/`!repeat` guard against its own double-press trap. The incident that motivated it is closed by the
   durable mode store, and Enter's meaning is printed on the ledge. **Reserved:** if a real mis-dispatch happens
   with an offer on screen, add the open-edge, exact-only arm from judge 3's graft (§16).
4. **Grammar version on create.** Judges 1 and 2 wanted it; judge 3 wanted no error taxonomy. **It is included as
   one field and two client copies.** Without it, a tab still running an old bundle after a server upgrade would
   re-read the same old answer, get refused, and loop on "Updated…". With it, the second failure tells the human
   to reload (§10.1).
   *As built (fix round 1):* only the version refusal says reload. A second `reading-moved` on the same words is
   the page's clock and the server's disagreeing, which a reload does not fix; it gets its own copy (§10.1).
5. **A settings off switch.** Judge 2 wanted it; judge 3 rejected it for v1. **Not in v1.** Per-edge dismissal
   plus the measured ~0.3% false-offer rate does not justify another setting. It is one row on the theme pattern
   if he asks (§16).
6. **Cue offers.** These come up at the **open edge only**, as in design 1 and judge 3. A close-edge cue stays
   dark: it is the weaker intent signal, and it would need a model call to say anything.
7. **A close-edge "about a schedule" veto** (my addition, taken from design 4's tiering with its Enter effect
   removed). If the sentence that holds a close-edge phrase has a word like `cron|job|workflow|action|pipeline|
   runs?|ran|running|fires?|triggers?|schedul\w*|recurring|periodic` before the phrase, nothing is offered. This
   removes the measured META false positive (`add a GitHub Action that runs the tests every Monday at 9am`). Its
   only cost is a missing offer, never a different Enter, so it is safe to be wrong in either direction.

### 1.4 Rejected (and why, in one line each)
- **Arming Enter on "strong" offers (design 4):** a hidden word-list heuristic would decide the safety-critical key.
- **Speculative or prefetch Sonnet reads outside the mode (designs 2 and 3):** they spend his quota unasked, and a
  refusal makes the offer flicker.
- **The ghost card with a mini calendar, dot choreography and an accent word-wash on the offer (design 2):** an
  84px shove of the project list per detection, which repeats `next`.
- **Any accent before accept.**
- **One-shot offers in the prompt box:** his `go until 10am tomorrow` time-box idiom, and the spec's own lazy-snooze
  preference.
- **Uninvited presence or spacing refusal lines (design 3).**
- **The hover × on the token (design 1):** new hit-testing for a third dismiss path.
- **`Schedule it too` / `Schedule instead` on the Starting-thread card.**
- **The M-disagree state where a click creates but Enter doesn't.**
- **The `Won't suggest it again for this draft` caption:** it narrates machinery.
- **Pin/conflict retries inside the interpreter, the warm idle CLI slot, server readId supersession and the server
  LRU:** each is phase 2 at best, and only behind a measurement.
- **Typo offers (`evry`).**
- **Design 1's `⌘⇧↵ saves lazy, leaving the mode` and its `This runs on a clock` caution under a model poll.**

---

## 2. Trigger: when reading starts, and what stays dark

### 2.1 The gate (every input event, microseconds)
One case-insensitive regex per window decides whether the grammar runs at all. **In the prompt box, outside the
mode, it matches recurrence words only.** One-shot and deadline words are excluded (`tomorrow`, `tonight`,
`today`, `next <day>`, `until`, `at \d`), so one-shots never even light the glyph:

```
\b(every|each|daily|nightly|hourly|weekly|bi-?weekly|fortnightly|monthly|bi-?monthly|quarterly|yearly|annually|
weekdays|weeknights?|weekends|business days|workdays|(mon|tues|wednes|thurs|fri|satur|sun)days|mon\s*[-–]\s*fri|
once a|twice a|\d+ times a|on the \d{1,2}(st|nd|rd|th)|(first|last|\d{1,2}(st|nd|rd|th)) \w+ of)\b
```

In the mode, and in the drawer's Change when field, there is no gate. The grammar always runs, and one-shots are
read.

*As built (Step 1):* four widenings, each a recurrence the families in §3.2 read but the regex above missed:
`everyday` (Todoist's spelling), an ordinal two words from its `of` (`first business day of`), a spelled-out day
range (`Monday to Friday`, `Monday through Friday`) and a plural time of day on a day (`Monday mornings`,
`weekday evenings`). The gate only decides whether the grammar runs, so a widening costs microseconds; the
cores still decide what is read.

### 2.2 Windows (the performance contract)
`scheduleWindows(prose, exclude)` returns at most two windows of at most **240 characters** each:
- The **opening window** runs from the first character the grammar may read to the end of the first sentence
  (`. ! ?` + space, or a newline).
- The **closing window** is the last sentence, ignoring trailing `.`, `!`, `)` and whitespace.

`exclude` is the set of runs the Composer's `backdrop` memo already computes (`Composer.tsx:546-609`): fenced code,
`@mentions`, `/commands` and staged ⌘I context tokens. Excluded runs never belong to a window. A leading
`/command` token is skipped, so `/review every Monday at 9am` still opens with a phrase. Text inside `"…"`, `“…”`
or backticks is excluded too: quotes are the human's escape hatch, as in Fantastical.

The cost of a read is flat at ~1ms whatever the prompt length (*measured*: the sketch took 29ms on a full 4k read
and ~1ms on windows). Every correct reading in the 133-text corpus touched a clause edge, so the windows lost
0 of 85 (*measured*, on a corpus written by the same hand as the grammar, so an upper bound).

*As built (Step 1), measured on a box at load average ~20:* the windows are not the whole cost. `checkSchedule`
walks 60 runs, and the first build ran it for EVERY candidate in the text — 2.5–4.4ms for a 37-character prompt and
~500ms for a 4k one in the mode. Now only the phrase a reading is about is checked, and a check is memoized by rule,
zone and day until the rule's first run (the only instant its answer can change), so a keystroke in the task
re-reads in ~0.1–0.5ms. A phrase's FIRST read still walks the engine: 2–6ms for most rules, 13ms for a quarterly
one. `schedule-rule.ts` got faster under it: `zonedWall` parses `Intl` `format` instead of `formatToParts` (2.2x,
4.4µs vs 9.7µs a call), offsets are cached per zone and UTC quarter hour (every offset in use since 1970 changes on
one), `wallToInstant` skips its verification when the offsets 14h either side agree, and `isValidTimeZone` caches.
The unit test pins the warm path at the numbers above (20k `edges` under 3ms, 4k `anywhere` under 10ms) and the cold
path under 50ms, so a walk per candidate cannot come back.

### 2.3 Edges (where an offer may sit)
- **Open edge:** the phrase starts at the window's first character. Recurrences, cues and ambiguous words are
  offered here.
- **Close edge:** the phrase ends the text. Only **exact recurrences** are offered here, and only when all of
  these hold:
  - no `until|by|before|after|since|than|from|for` within the two words before the phrase (his deadline idiom
    lives here);
  - no about-a-schedule word earlier in the phrase's sentence (§1.3.7);
  - the phrase is not a one-shot.
- A phrase that is both (the whole text is `every Monday at 9am`) counts as the open edge.
- **Mid-text** phrases are never offered. The glyph does not light for them either.

*As built (Step 1):*
- The about-a-schedule veto skips the sentence's FIRST word: that word is the imperative, never the subject, so
  `run the e2e suite against staging nightly`, `trigger the deploy every Friday at 5pm` and `schedule a sync every
  Monday at 9am` offer, while `a script I will run each morning` and `make sure the cron job fires …` do not.
- The deadline guard also fires when the phrase itself OPENS with one of its words: the grammar reads `from Friday`
  and `until Friday` as a start and a bound, so `ship the fix from Friday every week` would otherwise slip past it.
- A vetoed reading stays `exact` with `veto: "deadline" | "about"`, so the glyph can still hint (row 24).
- When the whole text is one adverb (`daily`), the end of the text is not a clause boundary at the open edge: it
  is a word being typed, and reads `none`.

### 2.4 Publishing: when the visible reading changes
The grammar may run on every input event (it is cheap). A pure **publish policy** decides when its answer
reaches the screen. Constants live in `lib/scheduleOffer.ts`.

| Transition | Publishes when |
|---|---|
| dark → offer, **open edge** | the character just typed is a boundary (whitespace, `, ; : . ! ? )`, newline); or a paste, drop, undo or redo changed the text; or the box blurs; or **`REST_MS = 250`** pass with the caret inside a word |
| dark → offer, **close edge** | **`CLOSE_IDLE_MS = 800`** with no input and the phrase still ending the text. Every sentence being typed briefly ends in whatever was just typed, so the close edge waits for the human to stop. |
| offer → a different offer | same as appearing, at the same edge. While a word is half-typed, the last reading stays. |
| offer → nothing | at a publish point, held **`HOLD_MS = 400`** if the caret is inside or touching the old span (you are retyping `9am`), then folded away in 120ms |
| during IME composition | never |
| `in 6d` | the minute tick of `useNowMs` (`lib/liveClock.ts:51`) |

*Measured* (typing simulation, 85 exact phrases): publishing on every keystroke changed the reading a median of 3
and a max of 10 times per phrase, with mid-word flicker (`Frid` → none). At word boundaries it was a median of 2
and a max of 4, mostly refinements (`every Monday` with 9am dim → `at 9am` solid).

*As built (Step 1), one rule more for `scheduleOffer.ts`:* **a qualifier still being typed holds the reading it
qualifies.** The grammar never eats a word it has not read, so `every Monday at 9am for` is a cue, and so is `… for
3`. While a cue's unread words run to the end of the text and its core is the offer on screen, the human is
mid-qualifier, and the offer stays until the qualifier is finished (`for 3 weeks` → exact again) or the typing stops.
A cue whose unread words grow as they are typed (`every 2nd Tuesday`, `… of`, `… of the`) is one reading. *Measured*
by the boundary-only publisher in `schedule-phrase.test.ts` over the 156 positives the corpus offers: median 2, max 4
changes with the hold; max 6 without it (`every weekday at 9am for 2 weeks starting Oct 12`), where each bound typed
after a clock flipped the ledge to a cue and back.

*As built (fix round 1, publish-flicker-colon-and-rest):* the numbers above came from a boundary-only stand-in.
Driven through the real `publish`, three paths flickered: `:` was a boundary, so `every weekday at 10:30am` showed
a cue at `10:` between 9am and 10:30am at a steady 120ms a key; the 250ms rest published any prefix (`every Monday
at 1` as 1pm, paused inside `10am`; `every Tuesday and Thursda` dropping Thursday); and a rest inside a qualifier
(`… at 9am for`) published its cue. Now:
- a colon after a digit is mid-word (`classifyEdit`);
- a pause publishes only a word the reading has finished with (`pausePublishes`): at a REST a clock fragment (`1`,
  `2:3`, `10a`, not `10am`) waits for the idle or the word's end; at a rest or an IDLE, a reading that stops short of
  the word the caret is in, or no offer at all inside a word the shown offer runs into (`every Mond` reads as an
  event), keeps what is on screen;
- a qualifier being typed holds through a rest as well as a word's end; the idle shows its cue.

*As built (final gate):* the "stops short of the caret's word" rule held at the IDLE too, and at the open edge
every TASK word is one the reading stops short of — so the ledge's `Each run`, cut from the text of the last
publish, kept `triage new` for good under `… triage new issues` (found in end-to-end round 2, still open in
round 3). The idle now publishes such a reading when it is the one already on screen (`sameReading`): the word is
then the task's, no reading changes, and only `Each run` catches up, 800ms after the last key. A REST still holds
(a 250ms pause may be inside a word that is joining the phrase), and a reading that DIFFERS still holds at the
idle (`every Tuesday and Thursda` keeps Tuesday and Thursday). Pinned in `scheduleOffer.test.ts` (red first) and
by e2e case 27.

*Measured* (`scheduleOffer.test.ts`, 11 phrases × 200 seeded trials, 15% of keys after a pause): with pauses of
300–900ms, up to 8 changes (means 2.3–4.8) became at most 5 in 1 trial of 2,200 (mean 2.39), every extra change from
a pause past the 800ms idle, where the screen rightly shows what the words say so far; pauses kept under the idle
give at most 3; steady 120ms typing at most 3.

### 2.5 Dark (pinned as negative tests, §15.1)
- **Pure events:** `every time …`, `each time …`, `whenever …`, `after every …`, `when the … (passes|fails|
  lands|merges)`, and `each|every <non-calendar noun>` (`each PR`, `every file`). The grammar returns `event`.
  There is no offer and no glyph hint, and in the mode there is a local refusal with **zero model calls** (Sonnet
  turned `every time the build fails fix it` into an hourly poll, *measured*).
- **Presence:** `while I'm …`, `when I'm at my desk / online / around / working`. Dark outside the mode
  (`while I'm at lunch, fix the tests` is a fine dispatch). In the mode it gets `SCHEDULE_PRESENCE_COPY` at once.
- **One-shots** (`tomorrow at 8 …`, `tonight at 11`, `in 2 hours`, `next Monday at 10am`) and his time-box idiom
  (`go until 10am tomorrow`, `don't stop until 10 am tomorrow`).
- **Adjectives:** `fix the daily build`, `the weekly digest email`, `fix the monthly report generator`. Each is
  mid-text, or not followed by a clause boundary.
- **Spacing violations** (`every 5 minutes …`). Not offered, but the glyph lights `hint`. In the mode:
  `SCHEDULE_SPACING_COPY`.
- **Typos** (`evry monday at 9`). Dark outside the mode. In the mode the model reads them.
- Mid-text phrases, quoted or backticked phrases, and anything in code, mentions, commands or context tokens.
- A close-edge cue, an ambiguous word or a presence phrase at the close edge.

### 2.6 Measured exposure
*Measured*, the latency report's sketch grammar over his 1,296 prompts in `~/.claude/history.jsonl`, all positions:
4 exact (0.31%), 9 cue (0.69%), 29 events silent. Under §2.3–2.5:
- the 3 mid-sentence readings go dark;
- `until 10 am tomorrow` and the other time boxes go dark (one-shot, no gate word);
- `evrey` goes dark (typo);
- `periodically` is mid-text.

The expected residue is ~1 offer in 1,296. Pre-feature prompts measure false-positive exposure only, not recall.
**Gate (§15.1): fail the step if more than 1% of history prompts get an offer, or more than 0.25% get an
open-edge exact offer.** Known residual false offers, pinned in the corpus so any change is visible:
`Each morning standup takes too long, write a bot that summarizes it` (open edge) and `the report should go out
weekly` (close edge). Each costs one Esc.

*As built (Step 1), measured* by `scripts/schedule-phrase-history.ts` over the same 1,296 prompts at the spec's
clock: **0 offers** (0 open-edge exact, 0 close-edge exact, 0 cues, 0 ambiguous). Dark: 1 close-edge cue (`… at the
beginning of each day`), 1 event (`each time you mention a pr …`). As a check that it reads them at all, the same
prompts under `anywhere` read 5 exact (all mid-text: `each morning` ×2, `in 4 minutes`, `in 10 minutes`, `tonight`),
16 cues, 54 events and 3 presences. Mean 0.18ms a prompt. The two pinned residuals are not in his history; they
stay pinned in the corpus.

---

## 3. The grammar: `packages/shared/src/schedule-phrase.ts`

Zero dependencies beyond `schedule-rule.ts`. It runs byte-identically in node tests, in the browser and on the
server. It is a rewrite (not a copy) of the probe sketch `live-preview-latency/grammar.ts` (gitignored, beside this
file), which read 84 of 86 simple and mid phrasings correctly with none silently wrong (*measured*; same author for
corpus and grammar, so an upper bound). The sketch has no edge scope, no presence kind, no quote escape and no
ambiguous kind.

### 3.1 Contract
```ts
export const SCHEDULE_GRAMMAR_VERSION = 3   // 1 until fix round 1, 2 until fix round 2 (both 2026-10-06)

export type Span = { start: number; end: number }                 // into the string given
export type Edge = "open" | "close" | "inside" | "field"
export type Assumed =
  | { part: "time"; shown: string }                                // "9am" — nothing typed, or "morning" → 9am
  | { part: "meridiem"; shown: string; other: string; span: Span } // "at 3" → shown "3pm", other "3am"
  | { part: "day"; shown: string }                                 // "weekly" → "Monday"

export type PhraseReading =
  | { kind: "exact"; edge: Edge; span: Span; phrase: string; rrule: string; dtstart: string
      once: boolean                       // COUNT=1
      assumed: Assumed[]
      spacing?: true }                    // compiles but runs < 15m apart (checkSchedule refuses it)
  | { kind: "cue"; edge: Edge; span: Span; phrase: string
      core?: { span: Span; rrule: string; dtstart: string; assumed: Assumed[] }  // the part it IS sure of
      unread: Span                        // the words it will not guess at
      why: "condition" | "event-offset" | "vague" | "zone" | "unsupported" | "compound" | "leftover" | "typo" }
  | { kind: "ambiguous"; edge: Edge; span: Span; word: string; copy: string }
  | { kind: "presence"; span: Span }
  | { kind: "event"; span: Span }
  | { kind: "none" }

export function readSchedulePhrase(text: string, at: {
  nowMs: number; tz: string
  scope: "edges"      // the prompt box outside the mode: §2.2–2.3 windows and edge rules
       | "anywhere"   // the prompt box in the mode: first phrase anywhere (≤4k chars; past that, the windows)
       | "field"      // Change when, and the server's re-derive: the WHOLE string must be consumed
  exclude?: Span[]
}): PhraseReading

export function scheduleWindows(text: string, exclude: Span[]): Span[]
export function locatePhrase(text: string, phrase: string, near?: number): Span | undefined  // moved from schedule-interpreter.ts
export function cutPhrase(text: string, span: Span): string                                   // moved from schedule-interpreter.ts
export function provisionalScheduleTitle(prompt: string): string
export function readingsConsistent(core: { rrule: string; dtstart: string; tz: string; assumed: Assumed[] },
                                   model: { rrule: string; dtstart: string; tz: string }, nowMs: number): boolean
```

Rules that bind every `exact`:
- It passes the **same** `checkSchedule` the server runs, or it carries `spacing: true`. It always writes `BYHOUR`
  and `BYMINUTE` (never inherited from now, which is rrule.js's 9:32:17 bug). With no time given it uses 9am,
  marked `assumed`.
- **It never eats a prefix.** Any qualifier-shaped word touching the span (`unless|except|only if|only when|if|
  for N|until|starting|from|after each|the day after|skip|but not`) either becomes part of the span, in a family
  the grammar reads fully (bounds and starts, §3.2 K), or turns the reading into a `cue` with that word in
  `unread`. Pinned by the no-silent-prefix property test (§15.1).
- `describeSchedule` of an exact rule never starts with `on the rule` (the raw-RRULE fallback). A rule it cannot
  phrase is a `cue` with `why: "unsupported"`.

*As built (Step 1), where the contract differs:*
- `Assumed` `time` carries an optional `word`, the time-of-day word it read as a clock (`morning`, `nightly`, `EOD`),
  for the tooltip.
- `exact` carries `veto?: "deadline" | "about"` (§2.3 as built). `isScheduleOffer(reading)` is exported: the one
  predicate for "the box offers this", shared by the box and the history gate. `SCHEDULE_AMBIGUOUS_COPY` is exported.
- `readingsConsistent` takes an optional `span` on both sides, which is check (a) of §4.3. An assumed meridiem
  compares the clock on 12 hours and an assumed day compares the time of day only, as an assumed time already
  compared dates only. Its comparison window runs through the whole day of the model's last run, so an assumed 9am
  does not lose the model's 8am on that day.
- **DTSTART is the rule's first run after now** (or after its start date), and an interval is anchored on it:
  `every other day at 8am` said tonight starts tomorrow, `every 3 days at 9am` too (the probe corpus anchored on
  today's passed 9am, a first run two and a half days out). §3.3 row 6 therefore reads `2026-10-05T15:00`, not
  `09:00`; an even interval inside one day keeps the same runs.
- What "touching" covers, as built: a qualifier right after the span, including a bound said as a time (`every day
  this week`, `next week`, `today`); the one word before it (`stop at 5pm today` is a time box, not a one-off), or a
  deadline and its object (`by Friday every week`, `after standup every day`) — the last three found by the
  agreement experiment, where Sonnet read them and the grammar had dropped them; a clause that OPENS
  with a qualifier and runs into the phrase, with or without a comma (`if the build is green every Monday at 9am`
  — but `check if the build is green every Monday at 9am` is the task's own `if`); a second rule joined by `and`,
  or by a comma alone when it has its own clock (`every Mon at 8pm, Tue at 9pm`). Anywhere in the text: a strong
  condition (`unless`, `except`, `only if`, `skip`, holidays, business hours), a bound or start (`for N weeks`,
  `until`, `starting`, `from Nov 2`, `as of Monday`), an event offset and an event. Leftover schedule words in the
  read region (a clock, `tomorrow`, `on Friday`) are `leftover`. A presence clause that runs into the phrase ends
  where the phrase starts, and the reading is `presence`.
- `in 2 hours` that lands on the repeated hour of a fall-back night is `unsupported`: a local wall clock names the
  first 1:30, an hour early.

*As built (fix round 1, 2026-10-06): `SCHEDULE_GRAMMAR_VERSION = 2`.* The break-it round found exact readings that
were silently wrong; each is pinned in `schedule-phrase.test.ts` § "the break-it battery":
- **Night and evening clocks** settle their meridiem from the day part: morning 1–11 am; afternoon 12–6 pm;
  evening 5–11 pm; night 7–11 pm, 12 midnight, 1–5 am; anything else stays a guess shown dim. `tonight at 2` is
  tomorrow's 02:00, and a night past midnight on a weekday rule (`Monday nights at 2`) is a vague cue, because
  "Monday night at 2" is Tuesday 2am to most and Monday to some.
- **Ordinal units** (`every 2nd week`) and **fractions and hedges** (`and a half`, `and a quarter`, `and change`,
  `or so`, `-ish`) are cues, never a BYMONTHDAY or a dropped tail.
- **Named zones** (`EST`, `PT`, `UTC+2`, `Europe/Berlin`, `London time`, `in London`, `my time`, `+0200`) touching
  the phrase or anywhere in the text are cues with why `zone`.
- **The silent-prefix rule** (I-9) holds against `BROAD_QUALIFIERS` (corpus): exclusions said other ways
  (`apart from`, `minus`, `w/o`, `save`), calendar residue (`in Q4`, `on even weeks`), counts and conditions
  (`x3`, `as needed`, `once the migration lands`), starts and stops (`stopping Oct 30`, `first run next week`) and
  zones — in five placements, both scopes and the field. A day stated off (`every Monday, Friday is off-limits`)
  never joins a weekday list, and a clock it cannot parse (`at 0900`, `at 9h30`, `at nine`) is never a silent 9am.
- **Abbreviation dots** (`Wed.`, `Thurs.`, `Jan.`, `excl.`, `a.m.`) no longer end the reading window.
- **A clock schedule is never an event** (`every midnight`, `every M/W/F at 9am`, `every lunchtime`).
- **Edge guards.** At the open edge a phrase followed by a statement (`Every night the backup job fails…`) is a
  bug report: an exact reading gets veto `about`, a cue is dropped. At the close edge a negation or a statement
  before it (`don't deploy on Fridays`, `the meeting is every Monday at 9am`) vetoes it, and a lone `on the 15th`
  is a date (veto `deadline`), as is a phrase that is a label's value (`the label should read: …`, `interval=…`).
  Text that looks like code (identifier glue like `FREQ=DAILY` or `src/daily`, camelCase, an indented line) is never
  offered.
- **Deviation, two pinned cases re-pinned:** `refactor the scheduler so every Monday at 9am isn't parsed as UTC` and
  `the job that runs every Monday at 9am is broken, fix it` read EXACT inside the text before; they are cues with no
  core (why `condition`) now, because the words after the phrase make a statement about a schedule rather than set
  one. In the mode those texts go to the model rather than reading locally.

*As built (fix round 2, 2026-10-06): `SCHEDULE_GRAMMAR_VERSION = 3`.* A second break-it pass found seven more ways an
exact reading was silently wrong, each a NEW member of a class round 1 had closed with a list (its `l-prefix`
measure: 1,358 silent prefixes in 3,000 reads, 404 offered in the box). Pinned in `schedule-phrase.test.ts` §
"the break-it battery, round 2":
- **WHEN is read by closed classes, not lists.** A task opens with an imperative, and English has a fixed stock
  of prepositions, subordinators and modals, none of which can open one. Right after a phrase (and opening a
  clause before one): words of time or condition whatever follows (`after`, `until`, `'til`, `following`,
  `given`, `providing`, `barring`, `upon`, a modal other than a request's `could you`, `right after`, `10 minutes
  before`, `<x> permitting`, `post-`/`pre-`, a count or a second frequency) are always unread WHEN
  (`WHEN_ALWAYS`); prepositions that place a task as often as they time it (`on main`, `to keep CI green`, `with
  the new client`, `by priority`) are WHEN only before a word of time (`WHEN_IF_TIME` + `TEMPORAL_NEXT`, a
  closed set: numbers, clock and calendar words, units, ordinals, span limits, the events a schedule hangs on).
  `via`, `per`, `using`, `because` and the verbs `post`, `back`, `round`, `save` are in neither. Round 1's lists
  still run first and keep their words. Measured: the reviewer's measure 1,358 → 0; a held-out set written
  BEFORE the change and never tuned against 529 → 9 of 3,060 (none offered in the box), a second written after
  it 14 of 2,520 (none offered); both residues fixed in class and pinned (`ROUND2_HELD_OUT`). Of 26 realistic
  requests none changed (the first cut, every preposition, had turned `every night at 2 on main, run the full
  suite` into a cue).
- **`at` after a phrase always names a time** (`every hour at half past`, `at xx:30`, `at lunch`, `at the
  all-hands`); a colon minute (`, :45`, `and :35`), number words past twelve (`9 thirty`, `oh nine hundred`) and
  `noon-thirty` are clock leftovers; `and again at 5`, `then at 5`, `and later at 5` are compounds; `to 5` is
  WHEN. A guess that lands on an hour the list STATES is the other one: `at 6 and 18` is `BYHOUR=6,18`.
- **A count glued to an adverb is one vague core** (`twice daily`, `3x weekly`, `semi-weekly`, `half-hourly`,
  `bi-hourly`), like `twice a week`; the adverb alone read once a period.
- **An adjective that limits which days** (`alternate`, `odd`, `even`, `most`, `some`, `select`, `the first
  two`, `the remaining`) before a phrase is unread, why `vague`, with the core kept (every reading is a subset).
- **Abbreviated calendar words**: month abbreviations join `CAL_WORD`; anywhere, a month before a day or a
  span (`Oct 12-30`, `(Oct–Dec)`), a weekday in a span or list or after a no (`Mon–Fri`, `Sat/Sun`, `not Sat`),
  `EOQ`/`EOY`, `in H2`, `for 2 wks`, `— 2 weeks`, `x14` (never `x86`), `14 runs max`, `through <date>`, `for
  the rest of`, `stop after`, and the conditions `only while`, `as long as`, `providing`, `barring`.
- **Zones**: NZT, AET, SAST, BRT, AST, WIB, IDT, PHT, ICT, PST8PDT and kin; CAT, EAT, ART, WAT only in capitals
  (`every morning cat the error log` is a command); a hand-picked city list (not `Intl.supportedValuesOf`, whose
  ICU differs between browser and server — this box's node has no `Kyiv`, and the server re-derives what the
  browser read); a bare ASCII offset (`-0500`, `-05:00`; `9am-5pm` stays a window).
- **A second frequency said as one** (`…, fortnightly is fine`) anywhere is a compound; as an adjective (`the
  weekly digest`) it is not.
- **Deviation — cores.** A cue whose unread words ADD runs (a count, a conjoined or second rule) or move a STATED
  clock (`at 9 thirty`, `every hour at half past`) carries no core; an assumed time is no constraint, so `every
  Friday at lunch` keeps `every Friday`. With the core kept, the model's faithful answer could never pass
  `readingsConsistent` (§4.3) and Create was disabled: that was already true of every compound pinned with a
  core (`every Monday at 9am and Friday at 5pm` would have been the disagree state), so those six pins lost it.
  A ZONE moves every run, and the interpreter writes `9am NZT` as this box's wall clock (Sunday 4pm in New
  York), so a zone cue carries no core either — round 1's touching zones (`Berlin time`) kept one and would have
  refused the right answer; the clock's own zone (`9 PT`) never had one.

### 3.2 Phrase families (exact)
| | Family | Examples | Reading |
|---|---|---|---|
| A | Weekday sets | every/each/on Monday · Mon, Wed and Fri · Mondays and Thursdays · every Monday and every Thursday · Mon–Fri · Monday through Friday · a bare plural (`Mondays 9am:`) only next to a clock | `WEEKLY;BYDAY=…` |
| B | Day classes | weekdays · business days · workdays · weekends · weekday mornings | `WEEKLY;BYDAY=MO..FR` / `SA,SU` |
| C | Daily | daily · every day · each morning/afternoon/evening/night · nightly · once a day · first thing | `DAILY`. Time-of-day words are assumed values: morning 9am, afternoon 2pm, evening 6pm, night and nightly 9pm, first thing 9am, EOD 5pm |
| D | Intervals | every N hours/days/weeks/months · every other X · hourly · weekly · monthly · fortnightly · once a week/month · every 15/20/30 minutes | `INTERVAL`, or `HOURLY;BYMINUTE=` sets. Under 15m → `spacing`. 45 and 90 minutes → cue (`unsupported`) |
| E | Clocks | 9am · 9:30pm · 17:00 · noon · midnight · at 9am and 5pm | `BYHOUR`/`BYMINUTE`. A bare 1–6 → pm and 7–11 → am, recorded as `assumed: meridiem` |
| F | Windows | every 2 hours from 9 to 5 · between 9am and 5pm | `HOURLY` with an explicit `BYHOUR` list |
| G | Month days | on the 1st and 15th · the 1st of every month · monthly on the 5th · the last day of the month | `MONTHLY;BYMONTHDAY`, days 1–28 or −1. 29–31 → cue |
| H | Nth weekday | first Monday of every month · every 2nd and 4th Wednesday · last Friday of the month · first/last weekday or business day of the month | `BYDAY` with ordinal, or `BYSETPOS` |
| I | Yearly | every year on January 2 · every March 15th | `YEARLY;BYMONTH;BYMONTHDAY` |
| J | Quarters, with a day | first day / first weekday / last Friday of every quarter | `YEARLY;BYMONTH=1,4,7,10` or `3,6,9,12` (needs the describe fix in §3.5) |
| K | Bounds and starts | for N times · for N weeks/months (counted from the first run) · until Oct 30 · starting tomorrow / next Monday / Oct 12 | `COUNT`, `UNTIL=YYYYMMDD`, `DTSTART` |
| L | One-shots | tomorrow (at 8) · tonight at 11 · today at 5pm · next Monday at 10am · Friday at 3pm (a singular weekday needs a clock) · in 2 hours · on Oct 20 | `COUNT=1`, `once: true`. **Read only in the mode and in Change when.** |

**Cue** (the model reads it after an explicit accept):
- conditions: unless, except, only if, only when, skip, holidays, business or working hours;
- event offsets: `the day after each release`;
- vague counts: twice a week, a few times a day, three times a day, regularly, periodically, every payday,
  every sprint;
- explicit zones: `9 PT`, `Pacific`;
- unsupported values: days 29–31, 45 or 90 minutes, `on the half hour`, any rule describe can't phrase;
- compound rules: two rules in one text (`Mon at 9 and Fri at 5`);
- leftover schedule words outside the span;
- near-miss typos, on completed words only.

**Ambiguous** (no accept, no model):

| Word | Copy |
|---|---|
| biweekly / bi-weekly | `“Biweekly” can mean every 2 weeks or twice a week. Say which.` |
| bimonthly / bi-monthly | `“Bimonthly” can mean every 2 months or twice a month. Say which.` |
| weeknight(s) | `“Weeknights” can start on Sunday or Monday. Say which days, like “Monday to Thursday at 10pm”.` |
| quarterly, with no day | `“Quarterly” needs a day, like “on the first weekday of every quarter”.` |

**Presence** and **event**: see §2.5.

*As built (Step 1), where the families differ:*
- **A** A bare plural is a schedule beside a clock **or before a clause boundary**: `Thursdays, run the flaky test
  sweep` offers, `Wednesdays check on the docs` stays dark (the old `scheduleHint` lit both).
- **H** `every 2nd Tuesday` with no `of the month` is a `vague` cue (every other Tuesday to some, the month's second
  to others); `every first Monday` and `every last Friday` can only be the month's and read exact.
- **I** `every year` with no date is a `vague` cue; Feb 29 is `unsupported` (a leap-day rule).
- **J** The day forms are `YEARLY;BYMONTH=1,4,7,10` (or `3,6,9,12` counting from the end), as written. The
  weekday-class form is `MONTHLY;BYMONTH=1,4,7,10;BYSETPOS=1`: under `YEARLY`, `BYSETPOS` picks ONE position in the
  whole year. `quarterly on the first weekday` reads exact, so the ambiguous copy's own example works.
- **E/F** A window's pair settles its bare numbers (`from 9 to 5` can only be 9am–5pm inside a day), so it is not
  `assumed`. EOD and close of business read 5pm, with the word kept.

### 3.3 Examples: input → reading → what the human sees
Computed with the real `scheduleEcho` at the §0.1 clock (`live-preview-design-probes/spec-echo-table.ts`, output beside it). The
`in …` spans are `spanUntil`'s ladder, the same reading as the schedule row. **Bold** marks what renders
dim (assumed).

| # | Input | Where | Kind | RRULE · DTSTART | Ledge (offer) / panel |
|---|---|---|---|---|---|
| 1 | `every Monday at 9am triage new issues` | open | exact | `FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0` · 2026-10-12T09:00 | `Every Monday at 9am · next Mon Oct 12, in 6d` · each run `triage new issues` |
| 2 | `weekdays at 8:30 summarize PRs` | open | exact | `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=8;BYMINUTE=30` · 2026-10-06T08:30 | `Every weekday at 8:30am · next Tue Oct 6, in 17h` |
| 3 | `every morning summarize overnight Sentry errors` | open | exact | `FREQ=DAILY;BYHOUR=9;BYMINUTE=0` · 2026-10-06T09:00 | `Every day at` **`9am`** `· next Tue Oct 6, in 18h` (tooltip: `“Morning” reads as 9am. Add a time to change it.`) |
| 4 | `Every Thursday at 3 prep the planning notes` | open | exact | `FREQ=WEEKLY;BYDAY=TH;BYHOUR=15;BYMINUTE=0` · 2026-10-08T15:00 | `Every Thursday at 3`**`pm`** `· next Thu Oct 8, in 3d` (tooltip: `Read “3” as 3pm. Type “3am” if you meant morning.`) |
| 5 | `every other Friday at 4pm write the changelog` | open | exact | `FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;BYHOUR=16;BYMINUTE=0` · 2026-10-09T16:00 | `Every other week on Friday at 4pm · next Fri Oct 9, in 4d` |
| 6 | `every 2 hours on weekdays from 9 to 5 check CI` | open | exact | `FREQ=HOURLY;INTERVAL=2;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9,11,13,15,17;BYMINUTE=0` · 2026-10-05T09:00 | `Every 2 hours from 9am to 5pm on weekdays · next Mon Oct 5, 3pm, in 28m` (more than one run a day, so `next` carries the time) |
| 7 | `on the 1st and 15th review billing` | open | exact | `FREQ=MONTHLY;BYMONTHDAY=1,15;BYHOUR=9;BYMINUTE=0` · 2026-10-15T09:00 | `On the 1st and 15th of every month at` **`9am`** `· next Thu Oct 15, in 1w` |
| 8 | `first weekday of the month at 10 bump deps` | open | exact | `FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1;BYHOUR=10;BYMINUTE=0` · 2026-11-02T10:00 | `On the first weekday of every month at 10`**`am`** `· next Mon Nov 2, in 3w`. The panel's `Next: Mon Nov 2 · Tue Dec 1 · Fri Jan 1` is where New Year's Day shows up. |
| 9 | `the last Friday of the month at 4pm, write the retro doc` | open | exact | `FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=16;BYMINUTE=0` · 2026-10-30T16:00 | `On the last Friday of every month at 4pm · next Fri Oct 30, in 3w` |
| 10 | `every 15 minutes check if the deploy finished` | open | exact | `FREQ=HOURLY;BYMINUTE=0,15,30,45` · 2026-10-05T14:45 | `Every 15 minutes · next Mon Oct 5, 2:45pm, in 13m` (`in 13m` in the warning tone, because it is under 15m). Needs the describe fix (§3.5); today it reads `every hour at :00, :15, :30, :45`. |
| 11 | `every Monday at 9am for the next 4 weeks, check the migration dashboards` | open | exact (bound) | `FREQ=WEEKLY;COUNT=4;BYDAY=MO;BYHOUR=9;BYMINUTE=0` · 2026-10-12T09:00 | `Every Monday at 9am, 4 times · next Mon Oct 12, in 6d` |
| 12 | `daily at 9am until Oct 30 check the beta signups` | open | exact (bound) | `FREQ=DAILY;UNTIL=20261030;BYHOUR=9;BYMINUTE=0` · 2026-10-06T09:00 | `Every day at 9am, until Oct 30, 2026 · next Tue Oct 6, in 18h` |
| 13 | `starting next Monday, every weekday at 9 triage the support queue` | open | exact (start) | `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0` · 2026-10-12T09:00 | `Every weekday at 9`**`am`** `· next Mon Oct 12, in 6d` |
| 14 | `triage new issues every Monday at 9am` | close (after 800ms idle) | exact | as #1 | as #1 |
| 15 | `check the SSL renewals every year on January 2` | close | exact | `FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=2;BYHOUR=9;BYMINUTE=0` · 2027-01-02T09:00 | `Every year on January 2 at` **`9am`** `· next Sat Jan 2, 2027, in 2mo` (needs the year fix, §3.5) |
| 16 | `weekends at noon check the uptime dashboard` | open | exact | `FREQ=WEEKLY;BYDAY=SA,SU;BYHOUR=12;BYMINUTE=0` · 2026-10-10T12:00 | `Every weekend day at 12pm · next Sat Oct 10, in 4d` |
| 17 | `every Monday unless it's a holiday post the digest` | open | cue (condition), with a core | core `FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0` | `Every Monday at` **`9am`**`, “unless it's a holiday”`. After Tab, Sonnet reads it (*measured*: the same rule, plus the condition `unless it's a holiday`) → `Post digest · every Monday at 9am · unless it's a holiday` |
| 18 | `twice a week check for dependency updates` | open | cue (vague), no core | — | `Looks like a schedule: “twice a week”`. After Tab, Sonnet reads it (*measured*: Mon and Thu at 9am); the panel shows those days as concrete dates. |
| 19 | `biweekly sync the roadmap doc` | open | ambiguous | — | `“Biweekly” can mean every 2 weeks or twice a week. Say which.` No `⇥`. |
| 20 | `every 5 minutes check the deploy` | open | exact, `spacing` | — | No offer, glyph `hint`. In the mode: `Runs can't be closer than 15m apart.` |
| 21 | `tomorrow at 8 run the migration` | — | dark (no gate word) | in the mode: `FREQ=DAILY;COUNT=1;BYHOUR=8;BYMINUTE=0` · 2026-10-06T08:00 | In the mode: `Once, Tue Oct 6, 8am` |
| 22 | `every time the build fails, fix it` | — | event, dark | — | In the mode: `Schedules run on the clock. Try “every hour, check whether the build failed”.` Zero model calls. |
| 23 | `while I'm working, keep an eye on CI` | — | presence, dark | — | In the mode: `Frizz can't tell when you're at the keyboard yet. Try hours instead, like “weekdays 9am–6pm”.` |
| 24 | `add a GitHub Action that runs the tests every Monday at 9am` | close | exact, vetoed (`Action`, `runs`) | — | No offer. The glyph lights `hint`. |
| 25 | `fix the monthly report generator` | — | none | — | Nothing. |

### 3.4 Implied parts → `describeScheduleParts`
`schedule-rule.ts` gains `describeScheduleParts(compiled): { kind: "lead" | "days" | "interval" | "time" | "bound";
text: string }[]`. `describeSchedule` becomes `parts.map(p => p.text).join("")`, and a test pins the two equal for
every corpus rule. The web marks a part dim when an `assumed` entry covers it: `time` dims the `time` part, `day`
dims `days`, and `meridiem` dims only the `am`/`pm` suffix inside `time`.

### 3.5 Echo fixes this feature depends on (shared, Step 1)
Found while computing §3.3; each one is pinned by a test.
1. **Dense rules undercount runs per day.** `checkSchedule` samples 60 occurrences, so `every 15 minutes` echoes
   `60 runs a day` (true: 96) and `every 20 minutes` echoes 60 (true: 72). Count `perDay` from the first day's
   occurrences with a bound of 97 (the 15m floor allows at most 96 a day).
2. **Next dates drop the year.** `every year on January 2` echoes `Next: Sat Jan 2 · Sun Jan 2 · Tue Jan 2`.
   `formatOccurrence` adds `, 2027` when the occurrence's year differs from now's year in that zone. The day-only
   form in `schedules.ts` strips only the last comma segment, so it reads `Sat Jan 2, 2027`.
3. **Quarter sets fall back to the raw rule.** `describeSchedule` learns `BYMONTH` quarter sets (`on the last
   Friday of every quarter`). Until it does, quarter phrasings stay `cue`.
4. **Even minute steps read as a list.** `HOURLY;BYMINUTE=0,15,30,45` (an even step from :00, no BYHOUR) reads
   `every 15 minutes`, and likewise 20 and 30.

---

## 4. The pipeline

```
 input event ─▶ gate (two 240-char windows) ── no recurrence word ─▶ dark
                  │
                  ▼  at a publish point (§2.4)
              readSchedulePhrase(prose, {scope:"edges"})  ~1ms
                  ├─ exact (open; close if guarded)  ─▶ OFFER: dotted underline + ledge, echo from scheduleEcho (≤2ms, memoized)
                  ├─ cue (open edge only)            ─▶ OFFER: core + “unread words”; no model call
                  ├─ ambiguous (open edge only)      ─▶ "Say which" ledge; nothing to accept
                  └─ event / presence / one-shot / spacing / none ─▶ dark (glyph hint for spacing, close-edge cue, vetoed close edge, dismissed)
 Tab · ⌘⌥↵ · glyph · ledge "Schedule" ─▶ synchronous re-read (scope "anywhere") ─▶ SCHEDULE MODE
                  ├─ exact            ─▶ READY at once (no model)
                  ├─ event/presence/ambiguous/spacing/no task ─▶ local refusal (no model)
                  └─ cue / none       ─▶ Sonnet, single flight; consistency check against the core
 Enter in the mode ─▶ T3: synchronous re-read; create only what is on screen; the server re-derives local readings
```

### 4.1 Browser, per publish point
1. `readSchedulePhrase(prose, { nowMs, tz: browserZone(), scope: on ? "anywhere" : "edges", exclude })`. This reads
   the **prose** (what the box shows), not the serialized text, so spans index what is on screen. That fixes
   today's `prose.indexOf(phrase)` first-occurrence lookup (`ScheduleComposer.tsx:122`).
2. For `exact` (and a cue's `core`): `scheduleEcho({ title, rrule, dtstart, tz }, nowMs, tz)`, memoized on
   `(rrule, dtstart, tz, minute)` in a 16-entry LRU, so keystrokes in the task cost one string compare. *Measured*
   1.2–2.0ms uncached on a quiet box, 2.6–8.7ms on a loaded one (design 2's bench). It runs behind
   `useDeferredValue`, so it never delays the textarea's own paint.
3. The saved prompt is **cut from the prose first, then serialized**:
   `outgoingMessage(expandedPrompt(cutPhrase(prose, span)), stagedItems(promptKey), projectDir, false).trim()`. The
   browser and server use one `cutPhrase` (moved to shared), so `Each run:` is byte-for-byte what will be saved.

### 4.2 The model tier
- **Model: Sonnet, unchanged** (`SCHEDULE_INTERPRETER_MODEL`). What reaches it is now only the judgement tail,
  which is where Haiku's errors ran in the dangerous direction (*measured*, n=15 each: Haiku 12/15, Sonnet 14/15;
  not a significant difference by itself, but Haiku read `tomorrow at 8` as daily forever). Haiku would save a
  median of 1.2s.
- **When it runs (never outside the mode):**
  1. at once, when the mode is entered (Tab on a cue offer, or ⌘⌥↵, the glyph or the ledge button) over text the
     grammar reads as `cue` or `none`;
  2. in the mode, after **`MODEL_IDLE_MS = 700`** of no input at a publish point, when the text changed and no
     longer reads `exact`;
  3. on Enter in the mode, bypassing the idle wait.
- **Never for:** `exact` text (local wins and the model is not consulted), `event`, `presence`, `ambiguous`,
  `spacing`, or an empty cut prompt. These are local refusals with zero calls.
- **Single flight per box.** At most one request is in flight. If the text changes while one is out, its answer
  is cached when it returns but not shown, and if the current text still needs a read, exactly one request goes
  out for it. That respects the interpreter's per-project `concurrency: 1` queue (`context.ts:1140`) with no server
  change: a stale request can queue at most one behind it.
- **Cache:** a module-level map keyed `tz \0 localDate \0 text`, at most 50 entries, 10m TTL. A hit rebuilds the
  echo locally from the cached `{rrule, dtstart}` against now. Leaving and re-entering the mode, or editing back to
  the same text, costs nothing.
- **A model reading belongs to its phrase, not the whole text.** It stays valid while
  `locatePhrase(prose, reading.phrase, nearLastStart)` still finds it, so edits to the task alone keep it. The
  prompt is re-cut locally with the shared `cutPhrase`, and the echo is rebuilt. An edit that touches the phrase
  drops it: if the grammar now reads the text `exact`, local takes over instantly; otherwise the panel shows
  `Edited. Reading it again…` and rule 2 applies.
- **Budget:** at most **12 automatic reads per mode session**. After that the panel says `Press Enter to read it
  again.` and only Enter reads. Explicit Enter reads are single-flight but not budgeted.
- **Cancellation:** client-side discard only. There is no `interpretSchedule` contract change in v1. Server-side
  abort and supersession are phase 2, and only if a measurement shows queueing (§16).
- *As built (Step 3, `lib/scheduleModelRead.ts`):*
  - The cache key is `context \0 tz \0 localDate \0 text`: `context` is empty for the box and `schedule:<id>` for a
    Change when, whose answers are read against that schedule's stored rule and condition and so are not the box's.
  - Only VERDICTS are cached — a reading, or a refusal of the words (not found, presence, spacing, "couldn't turn
    that into a schedule", no task). A failed call, a timeout or a switched-off interpreter is shown for its text
    (`Couldn't read that just now. Press Enter to try again.`) but never cached, and an automatic read never
    retries it; Enter does.
  - "Touches the phrase" is concrete: `relocateModelReading` keeps a reading only while its phrase sits on word
    boundaries AND the word right before and right after it are the ones it had when read. `locatePhrase` alone
    still finds `every Monday unless it's a holiday` inside `… unless it's a holiday or a weekend post …`, whose
    meaning changed; the neighbour check drops it. Step 4 must pass the text the MODEL read as `read.text`.
  - *Fix round 3 (relocate-blind-behind-punctuation):* the neighbour was looked for across WHITESPACE only, so
    behind a comma both sides read "" whatever was typed there: `every day unless it's a holiday, post the
    digest` → `…holiday, or a weekend, post the digest` kept the reading, sent no second read, and created the
    schedule with the old condition and `or a weekend,` in the task (driven on the fixture). "Touches" is now
    exact: **an edit touches the phrase when it changes any character of the phrase, the punctuation between
    the phrase and the nearest word on either side (whitespace aside; a run of line breaks counts as one), or
    that nearest word itself — on a side where a word stands now or stood when it was read.** Everything past
    that word is the task's. So a new sentence right after it (`. Skip weekends too.`), a qualifier before it
    (`Except weekends, …`) and words after a comma drop it; an edit inside the task (`post the weekly digest`,
    `… to #eng`, a sentence after the task's first word) keeps it; and punctuation with no word after it on
    either side (`…holiday.`, or `…holiday,` before its next word is typed) keeps it. It cannot tell a greeting
    from a qualifier (`Hey, every day …` drops it), and a key typed into the task's FIRST word drops it: each
    costs one more read, never a wrong schedule. Pinned both ways in `scheduleModelRead.test.ts`, and e2e 31.
  - The queued follow-up is only the latest text, and asking for the text already out drops it; `cancelQueued()`
    is how a box says the grammar reads its words now.
- **Latency:** *measured* on this box (n=15, sequential, one time of day), Sonnet's full `interpret()` took a
  median of 3.50s with a p90 of 4.27s. Resolve-on-result (§13) takes ~0.45s off every one-shot call, giving ~3.05s.
  The ~7–8s the maintainer saw did not reproduce (2.1–5.0s here). Candidates are a cold spawn, a retry, or a queue
  behind `concurrency: 1`. The real-stack step (§15.3) measures it on his machine.

### 4.3 When the tiers disagree
| Case | Who wins | What the human sees |
|---|---|---|
| Local `exact` | local; the model is never asked | instant reading |
| Local `cue` with a core, model ok and **consistent** | model | the mark grows from the core to the model's span, and the echo becomes the model's (with its condition and title) |
| Local `cue` with a core, model ok and **inconsistent** | neither | the disagree state; Create is disabled for Enter **and** for the button until the human rewords |
| Local `cue` with no core, or local `none`, model ok | model | the model's reading; its concrete dates are the check |
| Model refuses | model | its copy, verbatim |
| Local `event` / `presence` / `ambiguous` / `spacing` | local; the model is never asked | the local refusal |
| An edit makes a model-read text local-`exact` | local, instantly | the panel updates in place and Create stays enabled |
| Enter, and a synchronous re-read differs from the panel | the fresh read; nothing is created | the new reading plus an `Updated…` line (§10.1) |
| Server re-derive differs | server; nothing is created | the client re-reads; see §10.1 |

**Consistency check** (`readingsConsistent`, shared, pure):
- (a) The model's phrase, located in the prose near the core, must **contain** the core span. It may grow, but
  never shrink or move.
- (b) Every one of the model's next 12 occurrences must be an occurrence of the core rule (via
  `occurrencesBetween(core, now, last + 1m)`). If the core's time was assumed, compare local **dates** only: an
  assumed part is not a constraint.

A condition, COUNT or UNTIL can only remove runs, so a faithful reading always passes.
*As built (fix round 2):* that holds only for unread words that REMOVE runs. A cue whose unread words add runs (a
second rule, a count) or move a clock the human stated carries no `core`, so a faithful answer is never the
disagree state (§3.1 as built, "cores").

*As built (fix round 1):*
- **(b) holds an assumed day to the core's frequency** (X5). With both a day and a time assumed (`every week unless
  it's a holiday`), the check returned true for any rule: an hourly answer passed and created 24 runs a day. Now an
  assumed day still asserts the period — WEEKLY: one run per week, in weeks a whole INTERVAL apart; MONTHLY: per
  month — and an assumed time only frees the clock.
- **The model's offsets index the text the box sent** (X8). The server trims `text` (`InterpretScheduleInput`) and
  the interpreter's offsets index the trimmed text, so a prompt starting with a newline drew every mark one
  character late and cut `y post the digest` into Each run. `alignModelOffsets` adds the trimmed lead back.
- **One reader per draft, not per box** (X2, §4.2's single flight). The `c` dialog and the page box under it share
  the mode, and now share the reader (`sharedModelReader`): before, each sent the same text, two Sonnet calls per
  mode entry and per idle edit.
- **A rule no words cover is never confirmed as RRULE text** (model-raw-rrule-echo; I-11 for the model). A month
  filter over a daily or weekly rule now reads in words (`every Friday at 9am, except in December`, `from March to
  October`, `in January, April and July`); any other unphrasable model reading is refused in the panel (M4).

---

## 5. Every visible state

### 5.1 Anatomy
- **The mark** is painted in the existing highlight backdrop behind the textarea (`Composer.tsx:1357-1370`), so it
  is zero-layout. The `highlight` prop becomes `marks: { start, end, tone }[]`, with tones:
  - `offer`: a dotted underline. A `background-image` `radial-gradient` of 1.5px dots on a 4px pitch, `repeat-x`,
    colour `fg/40`, at a measured em offset below the baseline, clearing descenders. `background-size` animates
    for the draw, and `box-decoration-break: clone` underlines each line of a wrapped phrase.
  - `unread`: a dashed underline at `fg/25`.
  - `reading`: `unread` plus a backdrop shimmer.
  - `accepted`: today's `bg-accent/15` fill.
  - `grow`: a newly covered accepted run, entering with `overlay-in`.

  The text stays transparent in the backdrop, and the layer keeps the identical padding and typography string
  (`Composer.tsx:1351-1354`).
- **The ledge** sits in the existing panel slot (`NewThreadModal.tsx:409`). It is pulled up under the box with
  `-mt-3` (cancelling the column's `gap-3`), inset `mx-2.5`, with
  `rounded-b-lg border border-t-0 border-border bg-panel-2/60 h-7 px-2.5 text-[12px] leading-5 text-muted`. It is
  a single line that never wraps, and it reads as a tab hanging off the box, not a new card.
  - Content, left to right: the glyph (`ScheduleMark`, on the cap band with `self-baseline
    translate-y-[calc(0.5em_-_0.5cap)]`), the reading (`min-w-0 truncate`), the optional `Each run:` segment,
    then a right cluster (`ml-auto`):
    - `<kbd>⇥</kbd> Schedule`, a button;
    - `<kbd>↵</kbd> Start now`, a label;
    - `×`, a button with `aria-label="Not a schedule"`.
  - Keycaps are `font-sans text-[11px] text-muted-70`, baseline-aligned with 12px words, as in the panel's
    existing `Esc Cancel`.
- **The panel** (the mode) is the ledge grown: same hanging shape, same left edge, same glyph position, now
  `bg-panel-2` with its rows opened beneath. The first line does not move when the ledge becomes the panel.
  Its height animates with `grid-template-rows: 0fr → 1fr`, so the All-projects list below slides and never jumps.
- **The send button** takes `sendGlyph: "send" | "schedule"`: `ArrowUp` ↔ `Repeat`, same size and stroke. In the
  mode its title is `Create schedule (Enter)`.
- **The rail glyph** (`Composer.tsx:1503-1519`) gets its `hint` state from the reading. `startsWithRecurrence` is
  deleted. Titles: `Schedule every Monday at 9am (Tab)` while an offer shows; `Schedule this? ⌘⌥⏎` for any other
  hint; existing titles otherwise.

*As built (Step 4), the anatomy where it differs:*
- **The keycaps are drawn, not typed.** `⇥` and `↵` as 11px text were FALLBACK glyphs (no UI face carries
  U+21E5/U+21B5): measured on the real ledge they inked 5–6px against an 8.75px cap and sat 1.00px and 0.50px
  under the cap band, and a nudge fitted to the fallback face would be wrong on any other machine. They are
  lucide `ArrowRightToLine` and `CornerDownLeft` (`KeyCap`, `aria-label` Tab / Enter), symmetric in their viewBox
  and placed by the house `self-baseline` + `translate-y-[calc(half box − 0.5cap)]` lift, which the browser
  computes in any font: −0.12px each. The `×` takes the same lift (−1.00 → −0.13px); `↻` was already −0.13px.
- **The row's rhythm is set on ink**, in one place (`ScheduleComposer.tsx`, the comment above `SlotGlyph`, with
  the readings): every mark's box is collapsed onto its ink by its viewBox's dead space (geometry, not a fit),
  so the ledge reads border → `↻` 10.83 · `↻` → reading 7.67 · keycap → word 4.59 / 5.13 · between clusters
  12.45 / 11.89 · `×` → border 10.83 (it was 9.67 · 5.83 / 6.50 · 13.66 / 18.39 · 12.33, the `×` hanging 6.5px
  further out than the gap it shared). The panel's body inset follows: `pl-[28px]`.
- **The panel's `↻` carries the size of the line it sits on** (`lead` 12 | 13): the echo is 13px on the ledge's
  12px row, and a 12px `cap` put the glyph 0.63px under the echo's band (−0.26px now).
- **The offer marks tile `round` with no side pad**, so a phrase's two marks (the first draw and its tail) meet at
  one pitch: the fill's 1px side pad overlapped them by 2px and drew a doubled dot at `Monday|at`. Two FILLS that
  meet (the model's grow run beside its core, both washing) drop the pad and the radius at the seam — the overlap
  drew a 2× alpha sliver and a notch at `Monday|unless` on the real Sonnet answer.
- **The underline sits at `--sched-underline-pad: 0.15em`**, set for the unlucky subpixel placement: the dots are
  drawn in the mirror, the text the eye reads is the textarea's, and the two land up to ~0.6px apart by layout.
  Readings in the stylesheet comment (1.59px clear of the deepest descender in geometry, 1.17px in pixels at the
  unlucky placement, dot centre 0.399em under the baseline).
- The slot wrap carries `data-open` (the slot lingers 160ms while it folds; a harness tells the two apart).

### 5.2 S0 — dark
Today's box, unchanged: no mark, no ledge, glyph `off`. The glyph shows `hint` (fg ink, no ledge) when the edge
was dismissed but still reads, for a spacing violation, for a close-edge cue, and for a vetoed close edge.

### 5.3 S1 — offer, exact
```
┌──────────────────────────────────────────────────────────────────────────────┐
│ every Monday at 9am triage new issues and label the dupes                    │
│ ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈   dots fg/40                                             │
│ Opus · high                                              ⎘   ↻   🐌   [↑]    │   ↻ = hint (fg ink)
└─┬──────────────────────────────────────────────────────────────────────────┬─┘
  │ ↻ Every Monday at 9am · next Mon Oct 12, in 6d · Each run: triage new i…  ⇥ Schedule  ↵ Start now  × │
  └──────────────────────────────────────────────────────────────────────────┘
```
(Drawn wider than the box for legibility. It is one 28px row; the `Each run` segment truncates first.)
- Reading copy: `{Describe, first letter capitalized} · next {day}, in {span}`.
  - `{day}` is `Mon Oct 12`, with the year when it is not this year.
  - It becomes `{day}, {time}` when the rule runs more than once a day.
  - `{span}` is `spanUntil` (`in 6d`, `in 17h`, `in 28m`). Under 15m away it takes `text-warning`.
- Assumed parts render at `fg/45` with the tooltips from §3.3. Typing the value turns them solid.
- `Each run: {first line of the cut prompt}` appears only when the ledge's container is at least 560px wide and
  the cut prompt is not empty, and it truncates first. The ledge's `title` always carries
  `Each run: {first line}`.
- Narrowing order: `Each run` first, then `, in 6d`, then the reading ellipsizes. **`⇥ Schedule`, `↵ Start now`
  and `×` never truncate.**
- Screen readers: `role="status" aria-live="polite"`, announced once per phrase appearance and never on a
  refinement: `Schedule suggestion: every Monday at 9am. Press Tab to schedule it.`
- The send button is unchanged (`↑`). The offer never touches it.

*As built (Step 4):* **the narrowing order cannot be a container width**, because readings differ in length: at
1440px the All-projects column is a 466px ledge, and the 400px rule left `, in 6d` laid out behind an ellipsis
(`Every Monday at 9am · next Mon Oct…`). The reading is a one-line WRAPPING row clipped to its first line: a
segment that does not fit wraps below the clip and is gone whole, and everything after it with it. The order is
`Each run` (joins with 9rem to spare, then truncates first) → `, in 6d` → `· next Mon Oct 12` (a step the spec
did not have, so a narrow ledge shows a whole rule rather than half a date) → the rule ellipsizes. At 1440 it reads
`Every Monday at 9am · next Mon Oct 12`; in the 640px dialog the whole reading. **Below 9rem for the reading,
the actions take a second row**, right-aligned: the narrowest column (an 800px window, a 266px box, a 248px ledge)
otherwise read `Ev…` beside actions that never truncate. So the ledge is one line except there. `Each run`
follows the text **at publish points only** (`useEachRun`, held while the offer is carried inside a word), so it
fills in a word at a time as §0.1 says; it was cut from the live prose and changed with every letter. The glyph's
title for a CUE is `Schedule this (Tab)` (a cue has no rule to name).

### 5.4 S2 — offer, cue (open edge only)
```
│ every Monday unless it's a holiday post the digest                            │
│ ┈┈┈┈┈┈┈┈┈┈┈┈╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌   core dotted fg/40, unread dashed fg/25  │
└─┬──────────────────────────────────────────────────────────────────────────┬─┘
  │ ↻ Every Monday at 9am, “unless it's a holiday”           ⇥ Schedule  ↵ Start now  × │
```
- With a core: `{Core describe}, “{unread words}”`, the quoted words at `text-muted-70` and the assumed `9am` dim.
- With no core: `Looks like a schedule: “twice a week”`.
- No `next` date: a condition may skip runs, and a vague count has none yet.

### 5.5 S3 — offer, ambiguous (open edge only)
```
  │ ↻ “Biweekly” can mean every 2 weeks or twice a week. Say which.          ↵ Start now  × │
```
There is no `⇥`: Tab moves focus. The word gets the dashed `unread` underline. Typing `every other week` turns it
into an exact offer at the next boundary.

*As built (Step 4):* the copy is an instruction, so it **wraps** inside the ledge rather than ellipsize `Say
which.` away (at 466px it lost the last sentence).

### 5.6 M1 — mode, ready (local reading, or a consistent model reading)
```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ▓every Monday at 9am▓ triage new issues and label the dupes                  │   bg-accent/15
│ Opus · high                                              ⎘  [↻]  🐌   [↻]    │   glyph pressed · snail disabled · SEND = ↻
└─┬──────────────────────────────────────────────────────────────────────────┬─┘
  │ ↻ Triage issues · every Monday at 9am                                     │
  │   Next: Mon Oct 12, in 6d · Mon Oct 19 · Mon Oct 26                       │
  │   Each run: triage new issues and label the dupes                         │
  │                                          Esc Cancel   [ Create schedule ] │
  └──────────────────────────────────────────────────────────────────────────┘
```
- Line 1: `preview.echo`, with the title from `provisionalScheduleTitle` (§10.2) for a local reading or the model's
  title for a model reading. Assumed parts are still dim.
- Line 2: `preview.nextLine`, with `, in {span}` after the first date. That is a web-only decoration, so the shared
  echo is unchanged.
- Line 3 appears only for a guessed meridiem: `Read “6” as 6pm. Type “6am” if you meant morning.`
- `Each run: {first line of the cut prompt}`, muted, one line.
- Edits re-read locally at publish points and update in place; only the changed part cross-fades. Create stays
  enabled while the reading is `exact`. **This replaces today's "any edit drops the reading."**
- With no task yet: line 3 reads `Say what each run should do.`, and Create is disabled.
  *As built (Step 4):* that state is M4 in the key matrix (`modeViewOf` → `copy` with the reading kept on screen),
  so Enter shakes rather than creates; driven on the stack (K3).
- The snail is `disabled`, titled `Leave schedule mode to save it for later`. ⌘⇧↵ is consumed and flashes the
  panel's `Esc Cancel` (`kbd-row-flash`).

### 5.7 M2 — mode, reading (model in flight or waiting out the idle)
```
│ ▓every Monday▓░unless it's a holiday░ post the digest                        │   core accent · unread shimmer
  │ ↻ Every Monday at 9am, reading “unless it's a holiday”…                   │   quoted words: shimmer-text
  │   Next: Mon Oct 12, in 6d · Mon Oct 19 · Mon Oct 26                       │   the core's runs
  │   Each run: post the digest                                               │
  │                                          Esc Cancel   [ Create schedule ] │   disabled, title "Still reading"
```
- With no core: `Reading “twice a week”…`. For the whole text (the glyph pressed over dark text):
  `Reading when it runs…`. Neither has a Next line until the reading lands.
- The shimmer starts after **250ms**, so a cache hit or a fast answer never flashes it. Under reduced motion it
  falls back to muted, as `shimmer-text` already does.
- When a consistent answer lands, the unread run becomes accepted with `overlay-in` (120ms), so the mark grows. The
  quoted words cross-fade into the model's echo (`Post digest · every Monday at 9am · unless it's a holiday`), and
  Create enables. This is the long tail's moment of recognition.
- After an edit to the phrase of a model reading: `Edited. Reading it again…` (shimmer), then a read after 700ms.

### 5.8 M3 — mode, disagree
```
  │ ↻ Post digest · every Tuesday at 9am · unless it's a holiday              │
  │   Next: Tue Oct 6, in 18h · Tue Oct 13 · Tue Oct 20                       │
  │   Those words read two ways: every Monday at 9am, or every Tuesday at 9am.│   text-warning
  │   Reword the part after “every Monday”.                                   │
  │                                          Esc Cancel   [ Create schedule ] │   disabled, title "Reword it first"
```
Enter shakes Create (`kbd-shake`). Neither Enter nor a click creates.

### 5.9 M4 — mode, refused or blocked
Create is hidden and the footer keeps `Esc Cancel`. The body is one line:

| Cause | Copy | Model calls |
|---|---|---|
| event (local) | `Schedules run on the clock. Try “every hour, check whether the build failed”.` | 0 |
| presence (local) | `SCHEDULE_PRESENCE_COPY` | 0 |
| spacing (local) | `SCHEDULE_SPACING_COPY` (`Runs can't be closer than 15m apart.`) | 0 |
| ambiguous (local) | the word's copy (§3.2) | 0 |
| no task | `NOTHING_TO_DO` (`Say what it should do as well, like “every Monday at 9am triage new issues”.`) | 0 |
| not found (model) | `SCHEDULE_NOT_FOUND_COPY` | 1 |
| model unreachable | `Couldn't read that just now. Press Enter to try again.` | — |
| budget spent | `Press Enter to read it again.` | — |
| interpreter off | the server's existing `Reading a schedule needs Claude…` | — |
| stale bundle (§10.1) | `Frizz has updated since this page loaded. Reload the page to create this schedule.` | — |

*As built (fix round 1):* two rows more. **Clocks disagree** (a second `reading-moved` on the same words, §10.1):
`This computer's clock is off from Frizz's. Press Enter to read it again.` — Enter reads again. **A rule no words
cover** (a model reading, §4.3): `That schedule is too intricate to show here. Try saying it more simply, like “every
Friday at 9am”.` On the phone every line here that names a key names the tap instead (§12).

### 5.10 M5 — mode, empty
Today's copy: `Type what to do and when it runs, like “every weekday at 9am triage new issues”.` The placeholder
is `What to do, and when it runs…`.

### 5.11 The committed moment
Enter or Create runs T3 (§10.1). The button reads `Creating…` only if the RPC takes longer than 150ms. On success,
in order:
1. The accent mark washes to `bg-accent/30` and back (220ms, `kbd-row-flash`'s curve).
2. The box clears (draft, chips, pick and schedule state, as `onCreated` does today), and the panel folds away
   (160ms) as the text leaves, so the words read as having become the schedule.
3. Toast: `{Title} scheduled`, with detail `{Describe} · next {day}, in {span}` (or `{Describe} · first run in
   12m` when under 15m), and actions **Undo** and **Open**. It stays up for 8s, the Undo window.
4. The project row's schedules count plays `queue-flash` once, so the eye travels from where the schedule was made
   to where it lives.

**Undo** deletes the schedule (`deleteSchedule` already asks nothing) and restores the pre-accept state (§1.3.1):
- the prompt goes back through `mergeIntoDraft`, so nothing typed since is lost;
- the staged chips are re-staged and the pick is restored;
- the mode is off and the dismissals are as they were before the accept.

The offer re-derives from the text, so `⇥ Schedule  ↵ Start now` is back on screen. Focus returns to the box, with
the caret at the end.

*As built (fix round 1, X1):* a mode the human entered after the create, for new text, stays on through Undo
(§1.3.1); the dismissals are restored only when the mode is off. *Reversed in fix round 3* (§1.3.1 as built):
the mode is off after Undo in every case, with the pre-accept dismissals. And the panel folding away after any exit is
`inert` for its 160ms linger (X3): it was mounted with the handlers of the state it was drawn in, so a press that met
its Create just after Esc created the schedule.

---

## 6. Motion
Every keyframe gets a `prefers-reduced-motion: reduce` override in `styles.css`, as the file requires. Under
reduced motion every change below is instant, and the shimmer becomes muted. Transitions name their properties.
Never use `transition-all` or `transition-shadow` beside `icon-hover-outline` (`lib/theme.test.ts:104`).

| Moment | Motion | Duration / curve |
|---|---|---|
| Recognition | the dots reveal left to right (`background-size` 0% → 100% on the `offer` mark) | 180ms `cubic-bezier(0.16,1,0.3,1)` (pop-in's curve) |
| Ledge in | grid rows 0fr → 1fr, opacity, 2px rise; starts 60ms after the reveal | 140ms ease-out |
| Phrase extends | only the new tail reveals; the old part does not redraw | 140ms |
| Assumed → typed | colour `fg/45` → fg | 120ms (house default) |
| Reading changes in place | the changed part cross-fades | 120ms |
| Rail glyph off → hint | colour only | 120ms |
| Accept | the dots fade, the accent fill sweeps left to right, the ledge grows into the panel, Create `pop-in` | 160ms; 110ms |
| Send glyph swap | `ArrowUp` ↔ `Repeat`, opacity cross-fade | 120ms |
| Model reading | `shimmer-text` on the quoted words, delayed 250ms | 2.2s loop |
| Model lands (consistent) | the unread run becomes accepted (`overlay-in`); the quoted words cross-fade into the echo | 120ms / 160ms |
| Dismiss | the dots fade; the ledge collapses | 120ms |
| Phrase deleted | held 400ms, then the ledge collapses | 120ms |
| Commit | the mark washes; the panel collapses as the box clears; the project row's count does `queue-flash` | 220ms; 160ms; 280ms |

Nothing re-animates while a reading stays put, and nothing moves on keystrokes inside the task.

*As built (Step 4), where the motion differs:*
- **The dots reveal by `mask-size`, not `background-size`.** A `repeat-x` dot pattern cannot be revealed by
  sizing its own background (the tiles re-flow); the mark's mask grows 0 → 100% instead, so the dots never
  slide. A mark keeps its element while its phrase stays (keyed by start), so a phrase that extends draws only
  its new tail: measured on the page, the first mark ran no animation while the tail ran `sched-reveal`. Under
  `box-decoration-break: clone` both lines of a wrapped phrase reveal together, each from its own left edge
  (frozen at 90ms on the page).
- **The dots do not fade on dismiss or accept**: the mark is replaced (dismiss: gone with the ledge's 160ms fold;
  accept: the fill sweeps in over the same words).
- **The project row's flash is `queue-flash` at 0.9s**, the house ring's own timing, not 280ms; under reduced
  motion a static outline.
- **Reduced motion, driven:** under emulation Create still popped — the house `pop-in` / `overlay-in` carry no
  override (Radix layers share them). Inside the slot they stop now; the offer, the ledge and the accept ran no
  animation at all (harness M1).

---

## 7. Keys, in every state

`keyAction(state, key)` in `lib/scheduleIntent.ts` is the single source. `Composer` and `PromptForm` only execute
what it returns. An open slash or mention menu claims Enter, Tab and Esc first, unchanged (`Composer.tsx:852-873`).

| State | Enter / Send click | ⌘↵ | ⌘⇧↵ / snail | ⌘⌥↵ / glyph / ledge `Schedule` | Tab | Esc | ledge `×` |
|---|---|---|---|---|---|---|---|
| S0 dark | dispatch | dispatch | lazy | enter mode + sync read | native | blur | — |
| S1 offer, exact | **dispatch** | dispatch | lazy | **accept** (sync re-read) | **accept** | **dismiss** (claimed) | dismiss |
| S2 offer, cue | **dispatch** | dispatch | lazy | accept → model read | accept | dismiss | dismiss |
| S3 offer, ambiguous | **dispatch** | dispatch | lazy | enter mode (shows the copy) | native | dismiss | dismiss |
| M1 ready | **create** (T3) | create | **noop** + flash | leave | native | leave + dismiss | — |
| M2 reading | nudge (Create shakes) | nudge | noop + flash | leave (answer discarded) | native | leave + dismiss | — |
| M3 disagree | nudge | nudge | noop + flash | leave | native | leave + dismiss | — |
| M4 refused | text changed since the answer → read now; else nudge | = Enter | noop + flash | leave | native | leave + dismiss | — |
| M5 empty | noop | noop | noop | leave | native | leave | — |
| M creating | noop | noop | noop | noop | native | noop | — |

Rules behind the table:
- **Tab accepts** only when an acceptable offer (S1 or S2) is visible, no menu is open, there are no modifiers, the
  selection is collapsed, and the event is not composing (`isComposing`/229). Shift-Tab is always native. The new
  predicate `shouldAcceptScheduleTab` sits in `lib/composerKeyboard.ts`, pinned disjoint from the menu Tab and the
  five Enters. The Composer takes `onTab?: () => boolean`, shaped like `onEscape` and claimed after the menu block.
- **Accept, ⌘⌥↵, the glyph and in-mode Enter re-read synchronously** on the exact current prose with `Date.now()`
  before acting. A key never acts on a reading held over from a half-typed word. If the fresh read is `none`, the
  mode opens and the model reads.
- **⌘↵ in the mode equals Enter**, as today. Muscle memory reaching for "submit" must not leak out of the mode as
  a dispatch.
- **Esc in the mode leaves and dismisses that edge** in one press, so the stack is mode → Esc → plain box with no
  offer → Esc → blur. That is two presses, as today.
- **The dialog's Escape.** `handleDialogEscape` (`lib/selectOverlay.ts:42`) runs in Radix's capture phase and
  today closes the `c` dialog before the box sees Esc. Add `registerEscapeClaim(fn)` beside `registerOpenSelect`.
  The schedule hook registers a claim that returns true (and acts) only while an offer is visible or the mode is
  on, **and** `document.activeElement` is inside that box's root. `handleDialogEscape` asks the claims first; on
  true it calls `preventDefault()` (the dialog stays open) and `stopPropagation()`. The next Esc closes the dialog,
  as today.
  *As built (fix round 1, X4):* a claim can also PASS. Radix asks the claim before the box's own handler, so with
  the box's slash or mention menu open the claim left the mode and the menu stayed open, one Enter from accepting
  its row. While a menu is open, or an IME composes, the box's claim answers `"pass"`: `preventDefault()` keeps the
  dialog and the key travels on to the box, which closes its menu — the page box's order, in the dialog.
- **Phone:** there are no keys. See §12.

---

## 8. Dismissal: one gesture, and it stays dismissed
- **Gestures:** Esc on an offer, the ledge `×`, or Esc in the mode. There is no Backspace-to-dismiss (Backspace
  is editing) and no click on the token (the textarea owns the pointer).
- **Stored per draft, per edge:** `dismissed: { open?: true, close?: true }` in the schedule draft state (§9 I-4).
  While it is set, no offer appears at that edge **whatever the phrase becomes**. Refining `9am` to `10am`, or
  `Monday` to `Tuesday`, stays dark.
- **It re-arms** when:
  - that edge holds no gate word at a publish point (the human deleted the phrase);
  - the draft is cleared (dispatch, create, discard);
  - the human enters the mode explicitly (glyph, ⌘⌥↵). Leaving the mode with Esc sets it again.
- The rail glyph stays `hint` while a dismissed edge still reads, so the way back is one key.
- No caption and no toast. The underline and ledge simply leave.

*As built (Step 5, `e34fd2a9`):* a dismissal is applied at RENDER (`shownUnder` in `lib/scheduleOffer.ts`), not
at the next publish point. It changes no text, so the policy never re-ran on it, and Step 4's Esc and × worked
only while the 800ms close-edge idle was still armed; a tap on the phone's `×` seconds after the last key left
the row up.

*As built (fix round 3, dialog-hidden-box-rearms-dismissal):* "a publish point" is **the editing box's own**. Every
box on the draft steps the policy, and a box that did not make a change (the page box under the `c` dialog, a
box that sees an Undo or a clear) takes it as a wholesale change, which is a publish point for its screen. Under
the dialog, a typo fixed mid-word in the gate word (`every` → `ever` → `every`, which the dialog itself never
published) read to the hidden page box as the phrase deleted, and it wrote the re-arm back to the shared draft:
the dismissed offer came back in the dialog. The policy now tracks whether each change was the box's own
(`OfferState.own`/`lastOwn`, an `external` flag on watched edits and on a mode flip arriving through the draft),
and `dismissalsNow` re-arms only at a publish point of the box's own; a timer inherits the change that armed it.
A box that only watched writes nothing back. Pinned in `scheduleOffer.test.ts` and e2e 32 (its control: the
phrase deleted in the dialog itself still re-arms). Not changed: a REST (250ms) inside a word in the box being
typed in is still a publish point for the re-arm, as §2.4 defines it, so pausing on `ever` there re-arms.

---

## 9. Safety invariants (each one is a test, §15)
- **I-1. Outside the mode, nothing creates a schedule.** No key, button or reading path reaches `createSchedule`
  unless `mode.on`.
- **I-2. Inside the mode, nothing dispatches or saves lazily.**
  - `PromptForm.submit`'s `schedule.on` gate (`NewThreadModal.tsx:259`) stays the only gate for Enter, ⌘↵ and
    Send.
  - `submitLazy` gets the same gate, and the snail is disabled.
- **I-3. Only an explicit act sets the mode.**
  - **On:** Tab on an offer, ⌘⌥↵, the glyph, or the ledge `Schedule` button.
  - **Off:** Esc, ⌘⌥↵, the glyph, `Cancel`, a successful create, or a draft clear.
  - No reading change, timer, remount or model answer writes `mode.on`. A grep-level test asserts that
    `scheduleOffer.ts` imports no mode setter.
  - *As built (fix round 3):* **Undo** is an off act too: it restores the pre-accept state, mode off, whatever
    it finds (§1.3.1 as built).
- **I-4. The mode is part of the draft.**
  - **Where:** `{v:1, on, dismissed}` lives in the existing `DraftStore` under
    `draftKey.dispatchSchedule(projectDir)`, the `dispatchProfile` precedent at `drafts.ts:106`.
  - **How it is read:** through `useDraft`, so every box on the key (the All-projects page box and the `c` dialog
    over it) reads one value.
  - **Lifetime:** it survives remounts and same-tab reloads, and it is cleared in the same synchronous call that
    clears the prompt (`clearDispatchDraft`).
  - **Model readings** are not stored. They are re-derivable, and a reload in the mode re-reads.
  - *As built (fix round 2, carry-drops-mode):* **it moves with the text.** The All-projects box re-aimed at
    another project (its picker, ⌥↑/⌥↓) moved the text and left the mode filed under the old project; driven on
    a real stack, Tab → re-aim → Enter DISPATCHED the text, and the orphaned `{on:true}` put the next text typed
    back there straight into the mode. `carryDispatchDraft` (`scheduleDraftState.ts`) is now the one way the
    draft moves: the mode and its dismissals land in the commit the text lands in (`DraftStore.setMany`),
    replacing what the target held, and leave in the same commit. Still only into an empty box.
  - *As built (fix round 3, reaim-during-wash and undo-during-next-create):* **a create in flight holds its
    draft**, from the Enter that sends `createSchedule` until its words leave the box (the RPC, then the 220ms
    wash). Re-aimed inside that window, the box carried the words and their `{on:true}` to the other project,
    the create cleared the old project's key — already empty — and the same schedule sat one Enter away over
    there (driven: createSchedule 2); and Undo of the previous schedule merged its words ABOVE the ones being
    created, so `onCreated` no longer found them at the start and left them in the box (the next Enter
    dispatched both texts). `beginDraftCreate(key)` / `afterDraftCreates(key)` / `useDraftCreating(key)`
    (`scheduleDraftState.ts`, per mode key, so every box on the draft shares it and it outlives the box that
    pressed Enter): `carryDispatchDraft` declines while it is held (the re-aimed box opens on its own draft and
    the words leave with their create), Undo restores only after every create on the draft has landed or
    failed, and every box on the draft reads `creating` (a box remounted mid-create is not M1). The create job
    carries the draft key and the `onCreated` of the Enter that made it, so a box re-aimed or unmounted since
    still clears the right draft.
- **I-5. Enter's meaning is always on screen.**
  - With an offer, the ledge prints `↵ Start now`.
  - In the mode, the send button shows `Repeat` and the title `Create schedule (Enter)`.
  - Otherwise it shows `↑`.
  - The send glyph and Enter's action never disagree.
- **I-6. Keys act on the current text.** Accept, ⌘⌥↵, the glyph and in-mode Enter re-read synchronously.
- **I-7. Create only what is on screen.** At Enter, a fresh read that differs in `(span, rrule, dtstart)` creates
  nothing. The server re-derives local readings (§10.1).
- **I-8. The model runs only in the mode,** and never on a text the grammar reads as `exact`, `event`,
  `presence`, `ambiguous` or `spacing`.
- **I-9. The grammar never eats a prefix** (the no-silent-prefix property).
- **I-10. A model reading over a local core must pass `readingsConsistent`.** If it fails, Enter and the button
  both refuse.
- **I-11. The browser never offers what the server would refuse.**
  - An offer exists only for a reading `checkSchedule` accepts.
  - Spacing violations are never offered.
  - Exact describes never start with `on the rule`.
- **I-12. No accent before accept.** Offer marks, ledge text and the glyph hint use fg/muted tokens only.
- **I-13. Undo restores the pre-accept state** (§5.11), and never loses text typed since.
  *As built (fix round 3):* in every case — mode off, dismissals as before the accept — and only after any
  create on the same draft has landed (§1.3.1 as built, I-4 as built).

---

## 10. Commit, titles, toast

### 10.1 T3: the commit authority
1. **Client, at Enter in M1.** Re-read the prose synchronously with `Date.now()`. If `(span, rrule, dtstart)`
   differs from the panel's reading, create nothing. Swap in the new reading (cross-fading only the changed part)
   and show one line:
   - `Updated for the current time. Press Enter to create.` when the text is unchanged since the last publish
     (for example `every day at 2:40pm` read at 2:39 and committed at 2:41, or a midnight rollover);
   - `Updated to what you typed. Press Enter to create.` when an unpublished edit caused it.
2. **Server, for a local reading.**
   - The client sends `source: { kind: "local", grammar: SCHEDULE_GRAMMAR_VERSION }` and `whenText` = the
     phrase.
   - `createSchedule` checks the version: a mismatch throws `schedule-grammar-stale`.
   - Otherwise it runs `readSchedulePhrase(whenText, { nowMs, tz, scope: "field" })`. It requires `exact` with the
     identical rrule and dtstart, or it throws `schedule-reading-moved`. Then it runs `checkSchedule` as today.
   - The phrase alone determines the rule (the grammar consumes exactly its span), so no window or chip context
     is needed.
   - On the client:
     - `schedule-reading-moved` → re-read locally and show line 1's copy;
     - `schedule-grammar-stale`, or a second `reading-moved` on the same text → the stale-bundle copy (§5.9).
3. **A model reading** is sent as today: its `title`, `whenText`, `rrule`, `dtstart` and `condition`, with the
   prompt re-cut by the shared `cutPhrase` if the task was edited, and no `source`. The server validates it with
   `checkSchedule` as today.

*As built (Step 2, `31590219`):*
- The two codes ride as the error message's FIRST WORD (`schedule-reading-moved: …`), the `AUTH_REQUIRED:claude`
  precedent: the RPC envelope carries one readable string, so a separate code field would have meant changing
  `packages/rpc` and the web client for one feature. `SCHEDULE_READING_MOVED`, `SCHEDULE_GRAMMAR_STALE` and
  `scheduleRefusalOf(error)` live in `shared/schedules.ts`, so the two sides cannot spell them differently, and a
  server test reads the code off the envelope of a real mounted router.
- `rederiveLocalReading` (server `schedules.ts`) is checked in `insert` before `validate`, at the same clock. On
  `update` it is held to the MERGED spec — the words and rule that will be stored — so a rule sent without its
  words is refused rather than stored under words that read as another rule. An invalid zone is said plainly,
  not as a moved reading.
- "The phrase alone determines the rule" is a property test now (`schedule-phrase.rederive.test.ts`): 2,553
  exact readings the box can send, over the corpus at five clocks (both corpus clocks, both 2026 DST eves, a
  year boundary), each re-read identically from its phrase alone under `field`. 0 failures.

*As built (fix round 1, rederive-refuses-same-runs-across-boundary):* "identical rrule and dtstart" refused the two
clocks disagreeing about which run comes first: `every 15 minutes` read at 14:44:40 starts 14:45 and at 14:45:10
starts 15:00, the browser's re-read (still before 14:45 on its clock) sent the same start, and the second refusal
showed the reload copy. Measured over a day of Enter presses with the server 2s / 30s / 90s ahead: refused 0.23% /
3.34% / 10.01% (`every 15 minutes`), 0.06% / 0.83% / 2.50% (`every hour`). Now:
- the server takes the same rrule from another start when the next 20 runs from its now are the same instants, and
  stores ITS start (`rederiveLocalReading` returns it). A COUNT is anchored at its start and a once is its start, so
  those are never moved, and neither is an INTERVAL anchored elsewhere. After: 0.00% for both at every skew;
  `every 2 hours` still 0.06 / 0.83 / 2.50%, correctly — its runs really differ. `every day at 2:40pm` read at 2:39
  and saved at 2:41 is created from tomorrow (the toast's next run says so) rather than refused;
- on the client a second `reading-moved` on the same words is the clocks disagreeing, not a stale bundle: the
  clock copy (§5.9), and Enter reads again. Only `schedule-grammar-stale` says reload.

### 10.2 Titles
- **`provisionalScheduleTitle(prompt)`** (shared, pure):
  - Take the first clause of the cut prompt (up to `, ; . : —`, ` and `, or a newline).
  - Drop a leading `please` and leading determiners.
  - Take the **first word and the last word** (verb + head noun): `triage new issues` → `Triage issues`,
    `summarize overnight Sentry errors` → `Summarize errors`, `post the digest` → `Post digest`.
  - A one-word clause is that word.
  - Sentence-case it, keeping acronyms (`Check CI`).
  - It must satisfy the server's `threadNameProblem`: at most 2 words, and a handle of at most
    `THREAD_HANDLE_MAX_CHARS` = 20. If the result fails, take the first word alone; if that fails, `Scheduled run`.
- **Create** sends that title plus `titleAuto: true`. After create, the schedule service names the schedule through
  the **thread namer's** completer (Haiku, the `namingRequest` shape in `thread-names.ts`). It writes through
  `service.update({ id, revision, title })` **only if** the row's `revision` and `title` are unchanged since
  create, so a human rename always wins, and the pending run's title follows whatever a human rename does.
  `FRIZZ_THREAD_NAMER=0` keeps the provisional title.

### 10.3 Toast
`showToast` (`store.ts:202`) gains `actions?: ToastAction[]` (at most two; `action` stays as sugar), and
`Toaster.tsx` renders them in order with the existing `buttonClass`. Undo comes first, then Open (which calls
`pushScheduleDrawer`).

---

## 11. The drawer's "Change when" (ships first)
The field means nothing but "when", so Enter carries no dispatch risk (the Things and Linear case). It proves the
grammar, the publish policy and the preview rendering on real use first.

```
 When
 ┌─────────────────────────────────────────────────────┐
 │ every Monday and Thursday at 10am                    │
 └─────────────────────────────────────────────────────┘
 ┌─────────────────────────────────────────────────────┐
 │ Triage issues · every Monday and Thursday at 10am    │
 │ Next: Thu Oct 8, in 3d · Mon Oct 12 · Thu Oct 15     │
 │ Still checks: unless it's a holiday · Drop           │   only when the stored schedule has a condition
 │                                  Cancel   [ Save ]   │
 └─────────────────────────────────────────────────────┘
```
- **Reading:** `readSchedulePhrase(text, { scope: "field" })` at word boundaries and after 250ms of idle. One-shots
  are read here.
- **Preview:** live under the field, from `describeScheduleParts`, with assumed parts dim. It uses the same
  `SchedulePreview` component as the panel.
- **When it is exact and differs from the stored rule:**
  - Enter or Save saves through `updateSchedule` with `source: { kind: "local", grammar }`, which the server
    re-derives as in §10.1.
  - The stored condition is kept, and shown as `Still checks: {condition} · Drop`. `Drop` sends
    `condition: null`.
- **Cue or none:** a model read after 600ms of idle (`scheduleId` passed, as today), with the same single flight,
  cache and shimmer. Enter reads at once. The interpreter keeps or changes the condition by its own rule.
- **Ambiguous, spacing, presence or event:** the copy, and no Save.
- **Esc** works as today: the first restores the words, the second closes the drawer.
- The `Change when` / `Reading…` button goes away: the preview's Save is the action.
- **Phase 2:** an old-vs-new diff calendar in this preview, the one surface where a calendar earns its pixels.
  This week and next (or six month columns for monthly rules): kept runs solid, added runs accent with `pop-in`,
  removed runs hollow at 40%, and `was every Monday at 9am` beneath. It never enumerates a dense rule (*measured*:
  48ms for every 30 minutes over 14 days); for `perDay > 1` it takes membership from BYDAY.

*As built (Step 3), where it differs or says more:*
- **The publish policy is the box's §2.4 in small** (`lib/scheduleWhenField.ts`): a boundary character before
  the caret, or a wholesale change (paste, drop, undo, redo, autocorrect), publishes at once; mid-word typing
  waits for the 250ms rest. §2.4's qualifier hold applies too: a boundary inside a qualifier still being typed
  (`every Thursday at`, `every Monday unless`) holds the exact reading it qualifies until the rest. Without it
  the preview flipped to `reading “at”…` between two words of an ordinary rule (seen in the browser).
- **`none` says nothing until the model is asked.** A reading of no schedule at all (the first word, still
  being typed) hides the preview through the 600ms wait; `Reading when it runs…` appears only once the read
  is out. A cue shows its core and quotes the rest from the rest onward, as §5.7 draws it.
- **The 600ms is from the last keystroke**, not from the publish: the timer reads the words fresh when it fires.
- **Drop is a toggle inside the pending save**, not a write: `Won't check: ~~unless it's a holiday~~ · Keep`,
  and Save sends `condition: null`. Nothing is written until Save, as everywhere else in the drawer.
- **A model reading over a local core is held to `readingsConsistent`** here too (§4.3): the disagree lines
  and a disabled Save.
- **Copies:** `Updated for the current time. Press Enter to save.` / `Updated to what you typed. Press Enter to
  save.` (the panel's say "create"), and the stale copy `Frizz has updated since this page loaded. Reload the
  page to save this.`; an `Updated…` line appears only when a different reading was on screen.
- **In a Change when, Sonnet may keep the schedule's stored time where the grammar assumes 9am.** Driven: with
  the schedule at Thursday 3pm, `every Monday unless it's a holiday` read as Monday 3pm; with it at Monday 9am,
  as 9am. Both pass the consistency check (the core's 9am is assumed, so only dates count), and the dim 9am
  shows the grammar's guess, but the two tiers fill an unstated time differently. A design call: carrying the
  stored time into the grammar's `field` reading would make them agree.
- *Fix round 3 (drawer-model-raw-rrule):* **a model reading no words cover is refused here too** (I-11 for the
  model, as the panel has had since fix round 1). Driven on a real stack before the fix: `the second and fourth
  Monday`, answered `FREQ=MONTHLY;BYDAY=MO;BYSETPOS=2,4;…`, previewed as `Post digest · on the rule FREQ=…` with
  Save enabled, Enter saved it, and the drawer header and the project row then read `on the rule FREQ=…`. Now
  the preview shows the panel's copy (`That schedule is too intricate to show here. Try saying it more simply,
  like “every Friday at 9am”.`) and no Save, and Enter shakes. The view moved to `changeWhenView` in
  `SchedulePreview.tsx` beside `unphrasableRule` and `UNPHRASABLE_COPY`, which the panel now imports too:
  `ScheduleDrawer.tsx` reaches a `.css` import a node test cannot load, so the refusal is pinned in
  `SchedulePreview.test.ts`.

---

## 12. The phone
The phone's New thread sheet renders the desktop box, glyph included (code map §6.1, which contradicts the comment
at `PhonePage.tsx:32-35`). This spec keeps schedule mode on the phone, where `every weekday at 9` gets typed on the
go, and fixes the comment.
- The rules are the same: same edges, same publish policy.
- **The ledge** becomes a tap row under `useIsMobile()` (`MOBILE_MAX_PX = 700`):
  `↻ Every Monday at 9am · in 6d   [Schedule]   ×`. There are no keycaps, and `Start now` is dropped, because
  the send arrow beside it is the start-now act. `Schedule` and `×` have hit areas of at least 32px.
  - At 360px the order of loss is `next {day}`, then `in 6d`, then an ellipsis on the reading.
  - `Schedule` and `×` never truncate.
- **The panel** hides the `Esc` kbd, leaving `Cancel` and `Create schedule`.
- **The send glyph swap** carries Enter's meaning in the mode: the tap that creates is the repeat glyph.
- The thread reply bar (`ThreadComposerBox`, `layout: "bar"`) stays without schedules.

*As built (Step 5, `ecec8662`):*
- **The tap row** is `TapRowLine` in `ScheduleComposer.tsx`: `Schedule` is a bordered pill (a bare word does not
  read as tappable), `×` a 32px square; both hit areas measure ≥32px on every side, and the row never wraps (the
  desktop's actions-to-a-second-row rule is the desktop's). No `Each run` segment on the phone: no room, and no
  hover for the ledge's title.
- **The order of loss is measured, not wrapped.** It drops a MIDDLE segment first (`next {day}` before `in 6d`),
  which the desktop's wrapping clip (it drops the last) cannot do: invisible copies of the rule and its two tails
  sit beside the row, and `useTailFit` shows the longest that fits, re-fit by a ResizeObserver. With `next` gone
  the span joins with a dot: `Every Monday at 9am · in 6d`. Driven: 640px wears the whole reading, 420px `· in
  6d`, and 360px ellipsizes the rule (`Every Monday at 9…`) in DejaVu Sans, this box's `system-ui`, 6.8px short;
  in Liberation Sans (Arial's metrics, nearer SF and Roboto) the rule reads whole at 360. On a real phone face it
  is expected to fit; that is inferred, not measured.
- **The panel** names no Esc and gives Cancel and Create schedule 32px hit layers. Its Next line now drops
  dates whole, last first (the ledge's wrapping clip), on every width: on the phone it read `… · Mon Oct 1…`.
- The glyph's title drops `(Tab)`, and the screen-reader line ends `Tap Schedule to schedule it.`
- The send button's swap needed nothing new: the sheet holds the desktop box, whose send glyph already follows
  the mode; driven, the repeat glyph's tap created and never dispatched.

*As built (fix round 1, X7):* the panel's keyed lines name the tap on the phone (`phoneCopy`): `Updated for the
current time. Tap Create schedule.`, `Couldn't read that just now. Tap the repeat button to try again.`, `Tap the
repeat button to read it again.`, and the clock line. Create's title and the send button's (Composer `sendTitle`)
drop `(Enter)`. Unit-tested, not driven on the phone.

---

## 13. Server changes (all small)
1. **`backend/claude-oneshot.ts`:** resolve on the `result` message, and close the iterator in the background
   (log close errors, never throw them). *Measured* 420–520ms after the answer on every call. This helps the
   interpreter, the namer and the status line alike. *Built 2026-10-05 (`6ce93a8d`):* the concurrency slot is
   released only after the background shutdown, so `concurrency` still bounds live CLIs; only the answered
   caller stops waiting. Real CLI, n=5 per arm on a loaded box: result→resolve median 841ms → 0.4ms.
2. **`shared/schedules.ts`:**
   - `CreateScheduleInput` gains `titleAuto?: true` and `source?: { kind: "local"; grammar: number }`;
     `UpdateScheduleInput` gains `source?`.
   - `locatePhrase` and `cutPhrase` move to `schedule-phrase.ts` and are re-exported. `schedule-interpreter.ts`
     imports them back, and its tests keep passing.
3. **The schedule service** (`packages/server/src/schedules.ts`):
   - the `source` re-derive in `create` and `update` (§10.1), with the two error codes;
   - the `titleAuto` background rename with compare-and-set (§10.2).
4. **No change to `interpretSchedule`'s contract, model or concurrency.** No supersession, no server cache, no
   warm slot (§16).

---

## 14. Implementation plan, file by file, in landing order
Each step lands as its own commit and is safe on its own.

### Step 0: close the incident class (no live UI)
- **New** `packages/web/src/lib/scheduleDraftState.ts`:
  - `useScheduleDraftState(projectDir)` over `draftKey.dispatchSchedule`;
  - `clearDispatchDraft(projectDir)`, which clears the prompt, the schedule state and the profile pick in one
    synchronous pass and then notifies;
  - bounded by `DraftStore`'s existing limits.
- **Edit** `lib/drafts.ts`: add `draftKey.dispatchSchedule`, and a multi-key clear that notifies once.
- **Edit** `components/ScheduleComposer.tsx`: `kept` → the store.
- **Edit** `lib/selectOverlay.ts`: `registerEscapeClaim`; `handleDialogEscape` consults it.
- **Edit** `components/NewThreadModal.tsx`:
  - gate `submitLazy` on `schedule.on`;
  - use `clearDispatchDraft` at every `clearPrompt` site (`runDispatch`, `onCreated`, the alias path).
- **Edit** `components/Composer.tsx`:
  - `sendGlyph` prop (`ArrowUp` ↔ `Repeat`, title `Create schedule (Enter)`);
  - `lazyBlocked` prop (⌘⇧↵ consumed; the snail disabled with its mode title).
- **Edit** `components/PhonePage.tsx:32-35`: make the comment true.
- **Tests:** `scheduleDraftState.test.ts`, `selectOverlay.test.ts`, the ⌘⇧↵ gate.
- **As built (5249f97c), where it differs:**
  - `useScheduleDraftState(key)` takes the key (`draftKey.dispatchSchedule(projectDir)`), because
    `useScheduleMode` is handed a key, not a project.
  - The `/login` / `/logout` alias path calls `clearDispatchDraft(projectDir, { keepPick: true })`: the text was
    an account action, and the pick is the profile about to be signed in to and then dispatched on. Every
    other site clears all three keys.
  - The model's reading stays an in-memory, per-tab cache keyed by the mode's key (never in the draft store),
    so a remount does not re-read; a reload does. It is dropped whenever the mode reads off, including when
    another box on the key turned it off.
  - The ⌘⇧↵ `kbd-row-flash` on the panel's `Esc Cancel` (§5.6) lands with the panel in Step 4; Step 0 only
    consumes the chord (`lazyComposerEnter` in `lib/composerKeyboard.ts`).
  - Toasts take `actions` now; the create toast still offers Open alone until Undo arrives with Step 4.

### Step 1: the grammar and echo fixes (shared, no UI)
*As built:* see the *As built (Step 1)* notes in §2.1, §2.2, §2.3, §2.4, §2.6, §3.1, §3.2 and §15.1. Beyond them:
`schedule-phrase.corpus.ts` pins every case as one line per scope (`summarizeReading`) at the spec's clock, and
grades the 133-text probe corpus as written at its own clock, with eight documented overrides (`PROBE_OVERRIDES`).
`schedule-rule.ts` also got the engine speed-ups in §2.2. The agreement experiment's result is in
`plans/scheduled-threads.md` § Live reading.

- **New** `packages/shared/src/schedule-phrase.ts` (§3.1).
- **New** `packages/shared/src/schedule-phrase.corpus.ts`, holding:
  - the 133-text probe corpus `live-preview-latency/corpus.ts`, ported;
  - the interpreter's few-shot examples;
  - Todoist's in-subset recurring examples;
  - the `scheduleHint.test.ts` negatives;
  - prior-art §6 and §7.5 negatives;
  - the §3.3 table, the time-box idioms, quoted, fenced and mid-text cases, and the known residual offers.
- **New** `packages/shared/src/schedule-phrase.test.ts`.
- **Edit** `packages/shared/src/schedule-rule.ts`: `describeScheduleParts`, the quarter and minute-step describes,
  the `perDay` bound, and the year in `formatOccurrence`.
- **Edit** `packages/shared/src/schedules.ts`: the re-exports, plus the `titleAuto` and `source` fields.
- **Edit** `packages/shared/src/index.ts`: the exports.
- **New** `scripts/schedule-phrase-history.ts`: the history gate (§15.1), kept as a regression gate for grammar
  growth. It reads `~/.claude/history.jsonl` when it exists and skips otherwise.
- **One-time experiment:** grammar vs the real Sonnet interpreter over the positive corpus. Classify every
  disagreement as a grammar bug (fix it and pin it) or a model slip. Record the counts in
  `plans/scheduled-threads.md` (a new "Live reading" section) and in the commit message, then delete the harness.

### Step 2: the server
- **Edit** `packages/server/src/backend/claude-oneshot.ts`: resolve on the result.
- **Edit** `packages/server/src/schedule-interpreter.ts`: import the moved helpers.
- **Edit** `packages/server/src/schedules.ts`: the `source` re-derive, `titleAuto`, and the compare-and-set
  rename.
- **Edit** `packages/server/src/schedule-router.ts`: only what the service needs passed through.
- **Tests:** §15.1, server part.

### Step 3: Change when goes live
- **Edit** `components/ScheduleDrawer.tsx` `ChangeWhen` (§11).
- **New** `components/SchedulePreview.tsx`: the echo with dim assumed parts, plus the next line. The panel reuses it.
- **New** `lib/scheduleModelRead.ts`: single flight, cache, budget; shared by the drawer and the box.
- **As built:** see §4.2, §10.1 and §11 *As built*. Beyond them:
  - Step 2's rest landed in `31590219`: the `source` re-derive, the two codes, the property test. The router
    needed no change (it passes the input through). §13.1 and §10.2's rename landed before it.
  - `SchedulePreview` rebuilds the echo from the rule with `scheduleEcho` + `describeScheduleParts`, memoized per
    rule, zone and minute (16 entries), and splits the SHARED next line, so its dates are byte-for-byte the saved
    echo's. Dim tooltips: `“Morning” reads as 9am. Add a time to change it.`; with no word, `No time given, so
    9am. …` / `No day given, so Monday. Add a day to change it.`; several guessed meridiems share one line.
  - The under-15m tone is `text-attention`: the theme has no `warning` token, and attention is its amber.
  - The shimmer's 250ms delay is a timer in the component over the existing `shimmer-text` (which already falls
    back to muted under reduced motion), so `styles.css` is unchanged.
  - Shared echo fix found on the way: `perDay` counts the 24h from the FIRST run, so `every Monday at 8am and 5pm`
    asked on a Monday afternoon read `Next: Mon Oct 5 · Mon Oct 12 · Mon Oct 12`. A next line now carries times
    whenever two of its dates are the same day (`schedule-rule.test.ts` pins it).
  - Driven on a real stack (`--creds --wakers`) in headless puppeteer, 40/40 checks: typing `every Thursday at 3`
    one key at a time published ONE change (nothing mid-word, the qualifier held), then `3pm` with only `pm` dim
    after the rest; a tampered dtstart and a tampered grammar version on the wire came back as the two refusals and
    wrote nothing; the real save stored the server's re-derived rule with the condition kept; four local refusals
    made zero model calls; one real Sonnet cue read fired 558ms after the last key, landed in 3.9–6.4s (n=3 across
    runs), and the same words again were answered from the cache.

### Step 4: the prompt box
- **New** `lib/scheduleOffer.ts`:
  - the pure publish policy `publish(prev, reading, ev)`, with `REST_MS`, `CLOSE_IDLE_MS`, `HOLD_MS` and
    `MODEL_IDLE_MS`;
  - dismissal matching per edge;
  - `useScheduleOffer`, whose only effects are the timers. It is derived, not an effect on `prose`, per
    `Composer.tsx:679-690`.
- **New** `lib/scheduleIntent.ts`: `keyAction(state, key)` and the state type.
- **Rewrite** `components/ScheduleComposer.tsx` → `useLiveSchedule`:
  - It returns `{on, glyph, glyphTitle, marks, ledge, panel, sendGlyph, lazyBlocked, onTab, onEscape, toggle,
    submit}`.
  - It renders `ScheduleLedge` and `SchedulePanel` as one element that grows between the two forms.
  - Create, the Undo snapshot, the toast and the project-row flash signal live here.
- **Edit** `components/Composer.tsx`:
  - `highlight` → `marks` with tones, in the existing highlight layer;
  - the `onTab` branch after the menu block;
  - the glyph title prop.
- **Edit** `lib/composerKeyboard.ts` and its test: `shouldAcceptScheduleTab`.
- **Edit** `components/NewThreadModal.tsx` `PromptForm`:
  - pass `marks`, `onTab`, `sendGlyph`, `lazyBlocked` and the glyph title;
  - render `schedule.ledge ?? schedule.panel` in the one slot, inside the grid-rows container;
  - compute `exclude` runs from the same tokens the backdrop uses (a pure helper exported from `Composer.tsx` or
    `lib/composerContext.ts`).
- **Edit** `store.ts` and `components/Toaster.tsx`: `actions`.
- **Edit** `components/ProjectList.tsx`: `queue-flash` on the schedules count when `store.scheduleFlash` names
  that project.
- **Edit** `styles.css`: `sched-reveal`, `sched-ledge-in`, `sched-fill` and `sched-wash`, each with a
  reduced-motion override. The underline's em offset and dot geometry go in one place, with the measured readings
  in the comment.
- **Delete** `lib/scheduleHint.ts` and its test. Its cases now live in the grammar corpus. Its trailing-phrase
  negative flips to a close-edge offer, and a comment cites this spec.
- `AllQueues.tsx:467`: no change; nothing floats.
- **As built (`c347a4d8`, `d7996763`, `32c6e677`):** see the *As built (Step 4)* notes in §5.1, §5.3, §5.5,
  §5.6, §6, §15.2, §15.3 and §15.4. Beyond them, where it differs from the list above:
  - `useLiveSchedule` returns `{on, state, glyph, glyphTitle, marks, slot, slotOpen, announcement, sendGlyph,
    lazyBlocked, key, onTab, onEscape, toggle, onInputEvent}` (plus `ledge` and `panel`). `key(k)` executes the
    matrix and tells the caller only what is left for it — `dispatch`, `lazy`, `native`, `blur` or `handled` —
    so `PromptForm.submit` and `submitLazy` open with `schedule.key(…)` and the `schedule.on` gate behind it.
    ⌘↵ reaches the matrix through the Composer's `onSubmit` (it IS `submit`), so it is Enter in every state.
  - The publish policy runs during render from the prose and the input event that produced it (`onInputEvent`,
    a new Composer prop fed by the textarea's `onChange`, `compositionend` and `blur`); timers are absolute
    deadlines, so a rest firing never cancels the close-edge idle.
  - `exclude` is `composerExcludeRuns(prose, contextTokens)` in `Composer.tsx`: fences and staged tokens as the
    backdrop draws them, AND any `@…` / `/…` token (after the start, whitespace or `(`) — a superset, so a
    mention's or a command's name is never read as a schedule.
  - The model tier sends the whole prose (its own `phrase` span comes back); the saved prompt is cut locally by
    the shared `cutPhrase` + `promptOf` (`outgoingMessage` over the staged chips, as a dispatch would send it).
  - Re-arming a dismissed edge needs `scheduleEdgeGates(text, exclude)`, a small export added to
    `shared/schedule-phrase.ts` (whether each edge's window still holds a gate word).
  - M4 reads again on Enter when the text changed OR the read itself failed (unreachable, budget spent); for a
    local refusal of unchanged text it shakes.
  - The project-row flash is `store.scheduleFlash` (cleared after 2.5s), drawn by `ProjectList`'s QuietToggles
    on the schedules count.
  - `lib/scheduleHint.ts` and its test are deleted; their cases are in the grammar corpus and
    `scheduleOffer.test.ts`.
  - Tests: `scheduleOffer.test.ts` (16: the §0.1 storyboard, typing stability, REST / CLOSE_IDLE / HOLD, carry,
    IME, blur, mode, force, per-edge dismissal, I-3 by grep), `scheduleIntent.test.ts` (10: the §7 table copied
    by hand, row by row; I-1, I-2, I-3 over every state × key; §8; I-5), `ScheduleComposer.test.ts` (12: the
    mode views, I-8, I-10, T3 incl. the 2:40pm case, I-12 by grep with a negative control) and
    `shouldAcceptScheduleTab` in `composerKeyboard.test.ts`.
  - **Not done:** Step 5 (the phone); the §15.2 fixture e2e (driven on a real stack instead, §15.2 *As built*).

### Step 5: the phone
- **Edit** the ledge and panel for `useIsMobile()` (§12), then verify at 360px.
- **As built (`e34fd2a9`, `ecec8662`):** see §8 and §12 *As built*. `useLiveSchedule` reads `useIsMobile()` and
  hands `phone` to the slot, the ledge (`TapRowLine` instead of `LedgeLine`) and the panel's footer. The
  reading the two lines share is `offerReading`. `PhonePage.tsx`'s header comment says what the phone draws
  differently. Driven at 420 and 360 (§15.3 item 6 *As built*); measured (§15.4 *As built*).

---

## 15. Test plan

### 15.1 Unit (`nub --test`)
**`schedule-phrase.test.ts`**, at the pinned clock (Mon Oct 5 2026 14:32 America/New_York), plus the 2026 DST weeks
(Mar 8, Nov 1):
- **Positives.** Each pins `kind`, the exact `span` substring, `rrule`, `dtstart`, `assumed`, the `scheduleEcho`
  `describe`/`echo`, and **next 12 occurrences** equal to the expected ones.
- **Cues.** Each pins `why`, `unread` and `core`. **Ambiguous** pins the word and its copy. **Event** and
  **presence** pin their kind. **Negatives** pin `none` or a dark result under `scope: "edges"`.
- **The no-silent-prefix property.** For every positive × every qualifier (`unless it's a holiday`,
  `for 3 weeks`, `except Fridays`, `only if CI is red`, `starting next week`, `until Oct 30`, …), whether
  appended, inserted right after the span, or prepended: the result is either a reading whose span **includes** the
  qualifier (bounds and starts), or a `cue`. It is **never** `exact` with the qualifier outside the span.
- **Edge rules.**
  - The deadline words before a close-edge phrase.
  - The about-a-schedule veto, both ways: `add a GitHub Action that runs the tests every Monday at 9am` → no
    offer; `run the e2e suite against staging nightly` → offer.
  - Quotes, backticks and fences.
  - A leading `/command`.
  - The two known residual offers, pinned as offers.
- **Typing stability.** Every positive is read at every word-boundary prefix through `publish`:
  - at most 4 published changes per phrase;
  - no reading published from a mid-word prefix;
  - the final boundary shows the final reading;
  - no negative offers at any prefix.
- **Performance.** 20k characters under `edges` in under 3ms; 4k under `anywhere` in under 10ms (pinned the way
  `schedule-rule.test.ts:246` pins speed).
- **Helpers.**
  - `describeScheduleParts` joins equal `describeSchedule` for every corpus rule.
  - The four echo fixes (§3.5).
  - `provisionalScheduleTitle` cases, each passing the 2-word and 20-character handle limits.
  - `readingsConsistent`: grow ok, shrink fails, moved day fails, an assumed time compares dates only.
  - `cutPhrase` and `locatePhrase` (with `near`).

**Web:**
- **`scheduleOffer.test.ts`:**
  - boundary, the 250ms rest, the 800ms close edge, hold mid-word, the 400ms hold, IME;
  - dismissal per edge (it sticks through a refinement and a day change, re-arms on a gate-word-free edge, clears
    with the draft, and is overridden by the glyph).
- **`scheduleIntent.test.ts`:**
  - **the §7 matrix transcribed row by row**;
  - properties over every state × key: I-1 (mode off ⇒ no `create`), I-2 (mode on ⇒ no `dispatch`/`lazy`), I-3
    (`mode.on` changes only on the explicit acts);
  - Tab precedence (menu open, selection, IME, Shift).
- **`scheduleDraftState.test.ts`:** a reload round trip (a new `DraftStore` over the same storage); two subscribers
  see `on` flip together; `clearDispatchDraft` clears every key in one notify.
- **`selectOverlay.test.ts`:** a claim keeps the dialog open only while focus is inside the claiming root.
- **`composerKeyboard.test.ts`:** `shouldAcceptScheduleTab` is disjoint from the menu Tab, Shift-Tab and the five
  Enters.
- **`scheduleModelRead.test.ts`:**
  - single flight (a text change during flight produces exactly one follow-up);
  - cache TTL and the local-date key;
  - the budget of 12;
  - phrase relocation keeps a reading through a task-only edit, and drops it on a phrase edit.

**Server:**
- **`schedules.test.ts`:**
  - a local `source` that matches → created;
  - a different rrule or dtstart → `schedule-reading-moved`;
  - a version skew → `schedule-grammar-stale`;
  - the same for `update`.
- **Title compare-and-set:**
  - the namer's name lands when nothing has changed;
  - a human rename before the namer lands wins;
  - `FRIZZ_THREAD_NAMER=0` keeps the provisional title.
- **`schedule-interpreter.test.ts`:** passes unchanged through the moved helpers.

**`claude-oneshot`**, through the `real-subsystem-harness` skill with the real CLI:
- result-to-resolve drops by about 0.45s; store the before and after numbers with the harness until they are logged;
- a negative control proves the harness fails on the old code.

**History gate** (`scripts/schedule-phrase-history.ts`, local only, never a fixture): fail if more than 1% of
prompts get an offer, or more than 0.25% get an open-edge exact offer. Print the counts.

*As built (Step 1), `schedule-phrase.test.ts`:*
- The no-silent-prefix property runs ~20k readings: every positive the box offers × 17 strong qualifiers (any
  placement) and 5 weak ones (`if …`, `when …`, `while I'm …`, `before …`, `after …`), inserted after the span,
  prepended to the phrase, after the phrase in the field, and appended to the text. A weak qualifier prepended to
  the whole TEXT opens the task when the phrase sits at the other end (`if the build is green, triage new issues
  every Monday at 9am`), so that placement is tried only against a phrase that opens the text.
- Typing stability uses a boundary-only stand-in for `scheduleOffer.ts` with the §2.4 hold; "nothing from a
  mid-word prefix" holds by construction there, so the grammar's own share is pinned instead: a half-typed word is
  never a typo.
- Performance pins the warm path at the §15.1 numbers and the cold first read under 50ms (§2.2 as built).

*As built (fix round 2):* § "the break-it battery, round 2" adds seven tests, one per finding class, each red on the
round-1 grammar first; the no-silent-prefix property over `ROUND2_QUALIFIERS` (the reviewer's 56, by class),
`ROUND2_HELD_OUT` (the two held-out sets) and `SECOND_SENTENCES`, in the five placements, both scopes and the
field. `scheduleDraftState.test.ts` pins the carry. The history gate re-ran at v3: 0 offers in 1,296 prompts.

### 15.2 Real browser e2e
**`components/composerScheduleLive.e2e.test.ts`** follows the pattern of `composerMentionTypeahead.e2e.test.ts`:
- puppeteer against a Vite fixture that mounts a real `DispatchForm` (extending
  `dispatch-composer-profile-fixture.tsx`) with `data-font="sans"`, dark;
- RPC stubs that count `dispatch`, `createSchedule`, `saveLazy`, `interpretSchedule` and `deleteSchedule`;
- skipped unless `FRIZZ_SCHEDULE_E2E_URL` is set.

Cases:
1. **Recognition.** Type `every Monday at 9am triage new issues` one key at a time.
   - No ledge before the space after `Monday`, and none mid-word.
   - The ledge's copy is exact, and `[data-composer-highlight]` has the `offer` tone with rects under the phrase.
   - `interpretSchedule` = 0.
2. **Enter with the offer showing.** Dispatch = 1, create = 0.
3. **Accept, then create.** Retype, then Tab.
   - The panel appears with Create enabled, the send button shows `Repeat`, and `interpretSchedule` = 0.
   - Enter → create = 1, with `FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0`, the prompt `triage new issues`, a
     `source`, and `titleAuto`.
   - Dispatch = 0.
4. **The incident regression.** Mode on, then a viewport-override remount, then Enter → create, never dispatch.
   The same after `page.reload()`.
5. **The `c` dialog over the page box.**
   - Mode on in the dialog → the page box shows the mode too.
   - Esc → the mode leaves and the dialog stays open. A second Esc closes it.
6. **Lazy save in the mode.** ⌘⇧↵ → saveLazy = 0; the snail is disabled. ⌘↵ in the mode → create, never
   dispatch.
7. **Tab with a menu open.** A slash menu is open and Tab is pressed → the menu row is accepted, not the schedule.
8. **Dismissal.**
   - Esc on an offer → it goes.
   - `9am` → `10am`, then `Monday` → `Tuesday` → still dark.
   - Delete the phrase and retype it → offered again.
   - It survives a remount and a reload.
9. **Close edge.** `triage new issues every Monday at 9am` → no ledge at 700ms, a ledge at 800ms.
   `go until 10am tomorrow` → never.
10. **A cue.** `every Monday unless it's a holiday post the digest` → the cue ledge, interpret = 0.
    - Tab → the reading state, interpret = 1.
    - A consistent stubbed answer → the mark grows and Create enables.
    - An inconsistent stubbed answer → the disagree state; Enter and a click both create nothing.
    - A task-only edit afterwards → the reading is kept, interpret is still 1, and `Each run` updates.
11. **An event.** `every time the build fails, fix it` → no ledge, glyph `off`. ⌘⌥↵ → the local refusal,
    interpret = 0.
12. **T3.** Stub `Date.now` past a `today`-relative dtstart between publish and Enter → no create, the `Updated for
    the current time…` line; the next Enter creates. A stubbed `schedule-reading-moved` → the same. A stubbed
    `schedule-grammar-stale` → the reload copy.
13. **Undo.**
    - Toast Undo → delete = 1.
    - The text comes back with the offer visible and the mode off.
    - With new text typed before Undo, both texts are present (`mergeIntoDraft`).
14. **Reduced motion emulated.** Every state appears with no draw.

*As built (Step 4): this fixture e2e file was NOT written.* Its cases were driven instead on a real disposable
stack against the real server and the real interpreter (`scratch/verify-live-box.ts`, §15.3): 1, 2, 3, 7, 8, 9,
10 (a real consistent answer; the inconsistent one is unit-tested only), 11, 12 (on a REAL clock edge and a real
unpublished edit, not a stubbed `Date.now` — a stubbed browser clock would skew the client against the server's
re-derive), 13 and 14. Cases 4, 5 and 6 are Step 0's real-stack checks (`scratch/verify-schedule-step0.ts`). The
cost is that nothing runs them in `nub --test`; the harness is kept in the thread's scratch to re-run.

*As built (end-to-end round, `05357b19`): the file now exists*, over its own fixture (`schedule-live-fixture.html`
/ `.tsx`) rather than an extension of the profile one: the real `DispatchForm`, the `c` dialog over it and the
`Toaster`, every listed RPC counted with its body, the model a per-case stub (consistent or inconsistent), the
server's two refusals a queue, and the clock pinned before any module reads it to the §0.1 clock, so every string
asserted is this spec's. A stubbed clock is right here (no server re-derives behind the page); `__clock.skew`
drives case 12. 15/15 against a static vite (case 10 is two tests: consistent, inconsistent). Where the cases
differ: **4** remounts through `__sched.remount()` (the fixture has no breakpoint that unmounts); **7** opens the
SLASH menu at the draft's start — a user command is offered only as the first token, and a leading `/command` is
skipped by the window, so that is where a slash menu and an offer share the screen; **14** records motion on
every frame from before the first key (sampled after typing, as the Step 4 harness did, it saw nothing even
without the emulation — the reveal is over 180ms after its space), and does not count the house's 120ms colour
and opacity fades, which run under reduced motion app-wide. Without the emulation the same recorder catches
`sched-reveal`, `sched-ledge-in` and the slot's `grid-template-rows` at the offer alone. `nub run test:e2e` does
not reach it today: its `NEEDS_REAL_STACK` cross-check exits first on `projectPickerIcon.e2e.test.ts` (from the
upstream merge `7142546f`), so run it as `FRIZZ_SCHEDULE_E2E_URL=<vite> nub --test <file>`.

*As built (fix round 1):* cases **15–20**, each run red on the unfixed code first: 15 Undo with a newer mode
(X1), 16 a prompt starting with a newline (X8; the fixture's interpret now parses with the real
`InterpretScheduleInput`, so it trims like the server), 17 one model read under the `c` dialog (X2), 18 the
folding panel's Create after Esc (X3 — the test pins the slot still, its row open and its transitions off, so a real
key and a real press meet a Create that is still drawn; unpinned, a press one CDP round trip behind the key met it
in about half the runs), 19 a slash menu's Esc in the dialog (X4), 20 the clock copy after two `reading-moved`.
`projectPickerIcon.e2e.test.ts` is now in `NEEDS_REAL_STACK`, so `nub run test:e2e -- <this file>` runs it:
21/21 (case 10 is two tests).

*End-to-end round 2:* cases **21–24** carry the fixed findings no case reached into the real box, and each was run
red against the pre-fix code (`70279b8b`, served by its own vite) before it was kept: 21 the grammar's break-it
words through the box's windows, `composerExcludeRuns` and the edge gates (bug reports, negations, statements,
`see packages/web/src/daily`, `set FREQ=DAILY`, `on the 15th` settle dark; a qualifier, a zone, `0900`, `and a
half`, `every 2nd week` are offered only as cues with their leftover dashed; X6's `apart from Fridays` goes to the
model on Tab and creates nothing without it; `every night at 2` creates 2am; `Wed.` reads to its clock); 22 X5
(an HOURLY answer over `every week`'s assumed core is the disagree state) and the month filter in words, with an
unphrasable month set refused by copy; 23 the publish flicker, sampled every frame (a 400ms pause inside `10am`
never shows `1pm`; `10:` is never a cue); 24 the phone's failed read naming the tap (X7). An open-edge text is
offered while it is still only `Every night `, so 21 pins the settled screen for those and "never offered" for the
rest. `nub run test:e2e -- <this file>`: **25/25**.

*End-to-end round 3:* cases **25–27**. 25 carries fix round 2's grammar findings into the real box, one or more
texts per finding: 18 open-edge texts (a minute after `every hour`, a count before an adverb, a calendar
abbreviation, an unlisted qualifier, a named zone, a spelled or second clock) must settle as a CUE with the
leftover dashed; 7 close-edge texts (`twice daily`, `4x nightly`, `half-hourly`, `alternate Thursdays`, `the first
two Mondays`, `odd Fridays`, `… at 9am NZT`) must never open, not even for the close edge's wait; `alternate
Mondays at 9am` put in the mode by the glyph asks the model on Enter and creates nothing locally; Tab on `every
hour at half past` asks the model; and `every day at 6 and 18` is read whole and creates `BYHOUR=6,18`. 26 is
carry-drops-mode: the fixture's `__sched.reaim(dir)` re-aims the box as AllQueues does (`carryDispatchDraft`, then
the box keyed by the new project's `dirs`); the mode moves with the text, is filed under the new project alone,
Enter there creates and never dispatches, and new text back in the first project starts out of the mode. Both
were run red against the pre-fix code first (a copy of the tree with fix round 2's six source files at
`c1c55bfd`, on its own vite; the fixture's re-aim there is the old prompt-only carry): 25 failed on all 18
open-edge texts and 5 of the 7 close-edge ones, 26 on "the re-aimed box is still in the mode" (`hint`). 27 is the
`Each run` regression below, pinned as a node `todo` through round 3 (it read `· Each run: triage new`).
`nub run test:e2e -- <this file>`: **27 pass, 1 todo** (28 tests; case 10 is two). *Final gate:* 27 fixed (§2.4)
and no longer a todo; the same command, after `git merge main` at `efd27ce6`: **28 pass, 0 todo** (the todo had
failed on the line before the fix, so it is its own negative control).

*Fix round 3:* case **15 rewritten** (it pinned X1's kept mode; it now pins the reversal: after Undo the mode is
off, the ledge prints `↵ Start now`, and Enter dispatches) and cases **28–33** added, one per safety finding: 28
Undo into a mode on an empty box and over refused words (the undone schedule comes back as an offer, Enter
dispatches, create stays 1); 29 Undo clicked while the next create is in flight (the next one's words leave, only
the undone ones return, Enter dispatches them alone); 30 a create in flight across a re-aim+remount (the other
project's box opens empty, no draft is left anywhere, Enter there creates nothing) and across a plain remount
(Enter in the remounted box is not a second create); 31 a model reading through a task edit after a comma (kept,
1 read) and then a condition continued past the comma (dropped, a 2nd read, the stored condition whole, nothing
of it in the task); 32 the `c` dialog's dismissed offer through a typo fixed in `every` (still dismissed), with
its control (the phrase deleted in the dialog re-arms); 33 Undo after a re-aim (back into the schedule's own
project, mode off; the box on screen keeps its own text and mode). Each was run against the pre-fix source (HEAD
`a833aa02`'s seven source files copied over the fixed ones, on its own static vite): 15, 28, 29, 30, 31 and 32
failed at the asserted line; 33 passed there (the pre-fix code already restored a re-aimed Undo into its own
project in this flow), so it is a guard, not a repro. The fixture gained `__sched.createDelayMs`: 29 and 30 act
inside a create's flight, and against a 0ms create plus the 220ms wash they raced the machine (in a full run,
29 clicked the next schedule's toast and 30's Enter landed after the wash). With the knob, a probe of 30's
remount half on the pre-fix source created twice for one Enter, 3/3. Driving it also found a race the fix had
opened: `creating` read react-query's `isPending`, which clears a task after `onError`, while the hold's
`useSyncExternalStore` painted the refusal's line a microtask after it, so an Enter pressed as `Updated for the
current time` appeared was swallowed (case 20 failed 2 runs in 3); `creating` is now the hold itself.
`FRIZZ_SCHEDULE_E2E_URL=<vite> nub --test <this file>`: **34 pass, 0 fail**; web unit tests 1973/1973.

### 15.3 Real stack (`frizz-stack` + `headless-browser`, `scripts/shot.mjs`, never a visible window)
1. Create a schedule from the real box through the local path, then assert:
   - the schedule row and its next lazy run exist;
   - **the thread count did not change**;
   - the drawer shows it;
   - the project row's count flashed;
   - the namer renamed it, or the provisional title stayed under `FRIZZ_THREAD_NAMER=0`.
2. Dispatch with an offer on screen → a thread starts and no schedule exists.
3. Reload with the mode on and press Enter → a schedule, no thread. Undo → the schedule is gone and the draft is
   restored.
4. One **real Sonnet** cue read. Record keystroke → cue ledge (local) and Tab → model reading landed, with and
   without resolve-on-result, on this box **and on the maintainer's machine**. That settles the 7–8s question.
5. Change when saves a local reading, and a cue through the model.
6. The phone sheet at 360px.

*End-to-end round, driven* on a disposable stack (`--creds --wakers`, a throwaway git project, headless puppeteer,
dark, `America/New_York`, Tue Oct 6 2026 ~01:30–01:45) by `scratch/verify-live-stack.ts`, 23/23 (one phase per run), no page errors:
- **1.** Tab then Enter from the real box: one `createSchedule` with `source {local, grammar 1}` and `titleAuto`, no
  dispatch; the row exists with its next run (Mon Oct 12 9am); the board's only new row is that pending run
  (`turn-idle`), so no thread that runs was added; the project row's count flashed; the toast's Open showed it in
  the drawer; the namer renamed `Triage issues` → `Issue triage` within ~2s and the pending run's title followed.
- **2.** Enter with the offer on screen (`… · Start now` on the ledge) started a REAL thread (Haiku, `running`) with
  the whole text as its prompt and created no schedule; the thread was then killed and archived.
- **3.** The mode survived a reload; Enter created a schedule and no thread; Undo deleted it, its pending run went
  with it, and the draft came back with the mode off and the offer on screen.
- **4.** Real Sonnet, n=3, one each: the cue ledge is local (0 model calls before Tab). A no-core cue (`twice a
  week`) showed 13ms after the space; a qualifier cue (`… unless it's a holiday`, `… except in December`) 379 and
  461ms after the space that ended the qualifier, because §2.4's hold keeps it until the next word's boundary
  (typing at 60ms a key). Tab → model reading landed **3.18, 2.60, 2.82s** (the RPC alone 3.15, 2.58, 2.79s), on
  the code with resolve-on-result; not measured without it, nor on the maintainer's machine. The December answer
  came back as `FREQ=WEEKLY;BYMONTH=1,…,11;BYDAY=FR`, which `describeSchedule` cannot phrase: the panel read
  `Changelog · on the rule FREQ=WEEKLY;BYMONTH=…` with Create enabled (I-11 bans that for local readings only).
- **5.** Change when: `every Thursday at 3pm` read locally with no model and saved with the local source (the
  server stored Thursday 3pm); `every Monday unless it's a holiday` went to the model 541ms after the last key,
  landed 3.15s after it (RPC 2.59s) and saved with its condition and no source — at Monday **3pm**, the stored
  time, the known design call in §11.

*End-to-end round 2, driven* the same way (Tue Oct 6 2026 ~03:00–03:10, `scratch/verify-live-stack.ts` now
asserting `SCHEDULE_GRAMMAR_VERSION`), 28/28 in two runs, no page errors:
- **1–3** as before: `source {local, grammar 2}` accepted by the server's re-derive; the only new board row the
  pending run (`turn-idle`); the count flashed; Open showed the drawer; the namer had already renamed `Triage issues`
  → `Issue triage` by the first poll after the toast, and the pending run followed; a real Haiku thread for the
  offered text and no schedule; reload + Enter a schedule and no thread, Undo deleted it and its run and restored
  the draft with the offer.
- **4** real Sonnet, n=4, one each, typing at 60ms a key: keystroke → cue ledge **368, 443, 15, 517ms** (the
  qualifier held to the next boundary; `twice a week` has none); Tab → landed **4.50, 2.59, —, 2.36s** (RPC 4.48,
  2.57, 2.34, 2.34s; the third's landing was not caught by the frame recorder). The December answer now reads
  `every Friday at 9am, except in December`; X6's `apart from Fridays` came back Monday–Thursday. Still only with
  resolve-on-result and only on this box.
- **5** `every Thursday at 3pm` saved locally (grammar 2); the cue's request went 540ms after the last key, RPC
  2.61s, landed 3.16s after it, at the stored 3pm (§11's open call).
- The server's re-derive across a run boundary (`scratch/r2-skew.ts`, real RPC): `every 15 minutes` and `every
  hour` read just before a boundary the server had passed were created at the server's start; `every 2 hours`
  read before an odd hour was refused `schedule-reading-moved`, and before an even one created.
- **Open, found here:** the ledge's `Each run` (and its tooltip) stops one word short of the task for good once
  typing stops — `every Monday at 9am triage new issues` reads `Each run: triage new` 6s later — because
  `pausePublishes` (fix round 1, `1fec06db`) refuses a rest or idle whenever the reading ends before the caret's
  word, which at the open edge is every task word. The panel's `Each run` is right. Shown on the fixture with
  `1fec06db`'s `scheduleOffer.ts` alone over `70279b8b` (`triage new`) against `70279b8b` itself (`triage new
  issues`).

*End-to-end round 3, driven* the same way on a TWO-project stack (`--creds --wakers`, throwaway git repos `proj-a`
launcher and `proj-b` tenant, Tue Oct 6 2026 ~04:08–04:30), grammar 3, no page errors in any phase:
- **1** 7/7 as before: `source {local, grammar 3}`; the only new board row the pending run (`turn-idle`), no
  thread that runs; the count flashed; Open showed the drawer; the namer renamed `Triage issues` → `Issue
  triage` 3.05s after the toast and the pending run followed. **Still open:** the ledge's `Each run` read `·
  Each run: triage new` 1.5s after the last key (and phase 2's ledge `… the single word ok and nothing`, without
  `else`). *Fixed at the final gate (§2.4 as built); not re-driven on a real stack, only on the fixture (e2e 27).*
- **2–3** 9/9: a real Haiku thread for the offered text and no schedule (then killed and archived); reload +
  Enter a schedule and no thread; Undo deleted it and its run and restored the draft with the offer.
- **4** real Sonnet, n=4, one each, typing at 60ms a key: keystroke → cue ledge **566, 453, 10, 1191ms**; Tab →
  landed **4.50, 2.72, 6.81, 7.35s** (RPC 4.43, 2.69, 6.68, 7.25s). The 1191ms is `apart from Fridays`: the
  qualifier hold keeps the exact `Every weekday at 9am` (its key hints dropped) from `apart ` until the boundary
  after `triage`, about 2.5s of typing; Tab pressed inside that window re-reads first (T3) and was driven on
  the fixture: after `Fridays ` it showed the no-task state, after `tri` it asked the model — neither accepted
  the held exact reading. Still only with resolve-on-result and only on this box; this run's Sonnet was slower
  than round 2's (2.36–4.50s).
- **5** `every Thursday at 3pm` saved locally (grammar 3, stored `BYDAY=TH;BYHOUR=15`); the cue's request went
  548ms after the last key, RPC 6.66s, landed 7.26s after it, at the stored 3pm (§11's open call).
- **carry-drops-mode** (`scratch/fix2-carry-stack.ts`, 7/7): Tab, ⌥↓ re-aimed the box at `proj-b` with the mode
  on; the mode key is under `proj-b` alone; Enter created one schedule through `/_frizz/proj-b/rpc/createSchedule`
  with 0 dispatches; new text back in `proj-a` starts out of the mode. The picker path was used only for the way
  back, not with the mode on.

*Fix round 3, driven* on a disposable stack (no credentials, a throwaway git project, headless puppeteer, Tue Oct 6
2026 ~05:45), every write through the real server and read back with `listSchedules`. Crafted on the wire, and
only these: `authStatus` (with no credentials the client's sign-in gate would stop Enter before any dispatch RPC)
and `interpretSchedule`'s answer (no model without credentials). No page errors.
- **create → Undo → Enter** (round 3's major): Tab, Enter created `every Monday at 9am` / `triage new issues`;
  Undo deleted it (0 stored) and left the box with the text, the ledge, `↵ Start now` and the send arrow; Enter
  sent **1 dispatch** with the whole text (the server refused it `AUTH_REQUIRED:claude`, as a credential-less
  stack does) and **create stayed 1**, 0 stored at the end.
- **The condition continued past a comma:** `every day unless it's a holiday, post the digest`, Tab, the answer
  landed; ` to #eng` at the end asked nothing (1 read, `Each run: post the digest to #eng`); `or a weekend, `
  typed after the comma sent a 2nd read for the new text, and the stored schedule is `every day unless it's a
  holiday, or a weekend` / condition `unless it's a holiday or a weekend` / prompt `post the digest to #eng`.
- **Change when, an unphrasable model rule:** `the second and fourth Monday` answered
  `FREQ=MONTHLY;BYDAY=MO;BYSETPOS=2,4;…` showed the refusal copy with Cancel and no Save; Enter pressed on those
  words (checked at the keypress) sent 0 `updateSchedule`, and the stored rule is still `every Monday at 9am`.
  (A first run of this probe was void: an element screenshot taken before Enter remounted the drawer and put the
  stored words back, so its Enter pressed on unchanged words. Re-run with Enter first.)

*As built (Step 5), driven* on a disposable stack (`--creds`, a throwaway git project), headless puppeteer with
touch emulation (`isMobile`, `hasTouch`, every press a `page.tap`), dark, `America/New_York`, Tue Oct 6 2026
~01:00–01:20, `dispatch`/`createLazyThread` counted and refused on the wire: **41/41 at 420px and 360px**
(`scratch/verify-live-phone.ts`), no page errors. The row appears at the space after `Monday` and not mid-word,
with zero model calls; `×` puts it away (seconds after the last key — the case §8's fix is for) and keeps focus;
`Schedule` opens the panel with Create enabled, the repeat glyph on send and focus kept in the box; tapping the
repeat send created one schedule (`FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0`, prompt `triage new issues`, local
source) and dispatched nothing — the one new board row is the schedule's pending run; the sheet closed with the
Undo/Open toast; Cancel left the mode and dismissed the edge; the rail glyph re-entered it; Undo by tap deleted
the schedule and restored the draft as it was before the accept. The desktop phases (offer, close, event,
dismiss, reload, states) of `scratch/verify-live-box.ts` re-ran green on the same code.

*As built (Step 4), driven* on a disposable stack (`--creds`, a throwaway git project, headless puppeteer, dark,
`America/New_York`, Tue Oct 6 2026 ~00:15–01:00), `dispatch`/`createLazyThread` counted and refused on the
wire so no worker could start; **53/53 checks in one run** (at `d7996763`; the later underline pad is CSS,
measured in §15.4), then the menu and T3 phases (4/4) separately, no page errors:
- Typing `every Monday at 9am triage new issues` one key at a time: nothing until the space after `Monday`, then
  the ledge and the underline under `every Monday`; the underline extended at the space after `9am`; no key
  inside a word changed the ledge or the marks (A3); 2 screen changes in 37 keys.
- Enter with the offer on screen: dispatch 1, create 0. Tab: panel, Create enabled, Repeat on the send button,
  interpret 0. Enter: create 1, dispatch unchanged, body `FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0`, prompt
  `triage new issues`, `source {local, grammar 1}`, `titleAuto`, title `Triage issues`; toast `Triage issues
  scheduled · Every Monday at 9am · next Mon Oct 12, in 6d` with Undo, Open; the project row's count flashed; no
  thread running. Undo: delete 1, the text back with the offer and focus, mode off; with text typed since, both
  kept (`…issues\n\ncheck the flaky tests`).
- Close edge: the ledge appeared **810–844ms** after the last key (n=4 runs); `go until 10am tomorrow` never.
- Cue: offered with zero model calls; Tab → the reading state at once, one call; **real Sonnet, Tab → landed
  2.60–3.28s (n=4; the RPC alone 2.54s)**; the mark grew over the read words; a task-only edit kept the answer
  with no new call; the create carried the condition and no `source`. The keystroke → cue ledge leg is local and
  instant: the qualifier was held on screen while typed, and the cue published at the first boundary after it.
  Not measured: with and without resolve-on-result, and on the maintainer's machine.
- Event: dark, glyph off; ⌘⌥↵ → the local refusal, zero model calls. Dismissal: Esc and `×` both put it away;
  `9am → 10am`, `Monday → Tuesday` and a reload stayed dark; deleting the phrase re-armed it. Mode on, reload,
  Enter: created, never dispatched. Tab with an `@` menu open over an offered phrase took the menu row. T3: a
  time one minute ahead read as today (`in 53s`); after the minute passed for real, Enter created nothing and said
  `Updated for the current time…`, and the next Enter created tomorrow's, which the server accepted; an edit
  Enter beat to the screen said `Updated to what you typed…`.
- The namer renamed `Summarize errors` (provisional) to `Overnight errors` within 45s — the server's Haiku namer
  (Step 2) dropped the verb §10.2's provisional title keeps.

### 15.4 Optics (`visual-review` and `optical-spacing`, dark, `data-font="sans"`, crops at dsf 6–8)
- **The dotted underline.** Its em offset against the baseline and descenders (`g y p`) at 13px sans; check that
  it draws once, and on both lines of a wrapped phrase.
- **Glyphs on the cap band.** `↻` beside the 12px ledge and the 13px echo, `⇥` and `↵` beside 12px words, and `×`
  centred in its hit box. Use the ink routine; the residual should be about 0.
- **Ink gaps.** Run `scripts/ink-gaps.mjs` over the ledge row (glyph · reading · separators · `Each run` · keycap ·
  word · `×`) and over the phone tap row. Put the corrections in one place, with the readings in the comment.
- **The rail.** With the swapped send glyph, check it against `iconRhythm.ts`'s measured 14.25–14.75px.
- **The ledge's join** to the box's bottom corners: no seam, no doubled border, at 640px (the dialog), the
  All-projects column at its narrowest, and 360px.
- **States to shoot:**
  - S1, S2, S3;
  - M1–M5, including the guessed-meridiem line and the no-task line;
  - committed;
  - the drawer preview with `Still checks`;
  - the phone row.
- Read every shot back critically. Check console and page errors, and confirm the owned browser is closed.

*As built (Step 4):* measured with `scratch/optics-live-box.ts` (the real page, dsf 6) and corrected — the
readings are in §5.1 *As built* and in the code beside each value. The join: the ledge's side borders meet the
box's bottom border where its corner curve ends, no seam and no doubled border, in the page box at 1440 and at
the narrowest column (800px window) and in the 640px dialog. The rail in the offer state reads 14.83 · 14.67 ·
14.5 (paperclip · glyph · snail · send), inside iconRhythm's band; in the mode the pressed glyph's fill reaches
the scan's padded clip, so those two gaps were not measured (that treatment is Step 0's, unchanged). 360px is
Step 5's and was not shot.

*As built (Step 5), the phone row* (`scratch/verify-live-phone.ts`, the real sheet, dark, sans, 420 and 360,
identical at both): ink gaps border → `↻` 11.0 · `↻` → reading 8.0 · pill → `×` 12.0 · `×` → border 11.0 — the
SVG marks by their geometry plus half the stroke (Chrome's rect leaves the stroke out), the reading and the pill
by a pixel scan of their own boxes. The reading → pill gap is a right-aligned cluster's free space (24.66 at 420,
13.66 against the ellipsis at 360). Against the reading's cap band: `↻` −0.13, `×` −0.13, the pill's frame −0.13
(its word trimmed to the cap band with `text-box`, so `items-center` centres the ink in any face; centring the
line box left it −0.50 in DejaVu), the pill's word on the reading's baseline (0.00). Row: 36px inside, the pill
4px from either edge. The join at 360 and 420: the box's bottom border is the row's top, no seam. Shots:
`live-phone-{420,360}-{offer,row,mode,toast,after}.png`, `live-phone-640-offer.png`,
`live-phone-360-liberation.png`.

---

## 16. Out of scope, and what is reserved
**Out of scope for v1:**
- speculative or prefetch model reads;
- server supersession, a server cache, a warm CLI slot, and pin/conflict retries;
- one-shot offers (and a "snooze a lazy thread until then" line, which would be a different feature);
- mid-text offers;
- the hover × on the token;
- the Starting-thread card nets;
- a mini calendar on the offer;
- non-English phrasings;
- shorthand such as `M/W/F`, `9a`, `0900`, `wkdays` (these fall to cue or none; the model reads them in the mode);
- the thread reply bar.

**Reserved, each with its trigger:**
- **The open-edge Enter arm** (judge 3's narrowed graft): the first Enter on an open-edge **exact** offer would show
  `Run it now, or every Monday at 9am?  ↵ Start now  ⇥ Schedule`, and a fresh Enter at least 300ms later would
  dispatch. Ephemeral state, never redirected. Build it **if a real mis-dispatch happens with an offer on screen**.
- **"Suggest schedules while typing"** (a Settings row, theme pattern, default on): build it if he asks.
- **Server-side abort and supersession** (`interpretSchedule(input, opts?)`, a signal through `claude-oneshot`):
  build it if the real-stack measurement shows reads queueing behind `concurrency: 1`.
- **The Change when diff calendar:** phase 2 (§11).

---

## 17. Risks
- **Grammar coverage is an upper bound.** About 84% (range ~69–89%) of schedules read with no model call
  (*measured*, by the grammar's own author on his own corpus, English only, pre-feature). Real shorthand will hit
  cues more often. A cue costs a ~3s visible wait after Tab, never a wrong schedule.
- **A confidently wrong exact reading.** None was silently wrong on the corpus; one (`every weekday at 6 … overnight
  pipeline`, read as 6pm) was wrong but flagged. The guards are the concrete dates, the dim guesses, the
  guessed-meridiem line, the agreement experiment and Undo.
  *As built (Step 1):* the agreement experiment (`plans/scheduled-threads.md` § Live reading) found three grammar
  misreads Sonnet got right — `every day this week`, `by Friday every week`, `stop at 5pm today` — each now a cue.
  None of the three was offered in the box (mid-text, a vetoed close edge, a one-off).
- **Tab ownership.** While an offer shows, Tab accepts instead of moving focus. The Tab-then-Enter accident is
  the one fast path to an unwanted schedule. The guards are the visible panel, the swapped send glyph, and Undo.
  There is deliberately no time lock.
- **Layout shift.** The ledge pushes the All-projects list down by 28px, animated, once per phrase. The panel
  pushes it further, as it does today.
- **The `background-size` draw on a multi-line inline mark** may clip oddly. Verify it in the browser. The
  fallback is an opacity fade.
- **Mirror drift.** Any class added to the highlight layer must stay in the identical padding and typography
  string.

## 18. Calls made on the maintainer's behalf (each reversible)
- Tab accepts while an offer shows.
- Close-edge exact recurrences are offered after 800ms of idle.
- The phone keeps schedule mode, and the offer becomes a tap row.
- Undo restores the pre-accept state (§1.3.1).
- There is no off switch in v1.
- Enter never arms (the arm is reserved, §16).
- A local reading's title is provisional and is replaced by the namer.
