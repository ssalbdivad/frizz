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

---

## 3. The grammar: `packages/shared/src/schedule-phrase.ts`

Zero dependencies beyond `schedule-rule.ts`. It runs byte-identically in node tests, in the browser and on the
server. It is a rewrite (not a copy) of the probe sketch `live-preview-latency/grammar.ts` (gitignored, beside this
file), which read 84 of 86 simple and mid phrasings correctly with none silently wrong (*measured*; same author for
corpus and grammar, so an upper bound). The sketch has no edge scope, no presence kind, no quote escape and no
ambiguous kind.

### 3.1 Contract
```ts
export const SCHEDULE_GRAMMAR_VERSION = 1

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
- **I-4. The mode is part of the draft.**
  - **Where:** `{v:1, on, dismissed}` lives in the existing `DraftStore` under
    `draftKey.dispatchSchedule(projectDir)`, the `dispatchProfile` precedent at `drafts.ts:106`.
  - **How it is read:** through `useDraft`, so every box on the key (the All-projects page box and the `c` dialog
    over it) reads one value.
  - **Lifetime:** it survives remounts and same-tab reloads, and it is cleared in the same synchronous call that
    clears the prompt (`clearDispatchDraft`).
  - **Model readings** are not stored. They are re-derivable, and a reload in the mode re-reads.
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

### Step 5: the phone
- **Edit** the ledge and panel for `useIsMobile()` (§12), then verify at 360px.

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
