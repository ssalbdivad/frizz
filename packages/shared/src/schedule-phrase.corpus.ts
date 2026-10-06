// ---- THE SCHEDULE GRAMMAR'S CORPUS ------------------------------------------------------------------------------
// plans/schedule-live-reading.md §14 Step 1 and §15.1. Every phrase the local grammar (`schedule-phrase.ts`) is
// held to, in one place, so a change to the grammar shows up as a diff here rather than as a surprise in the
// prompt box:
// - the 133-text probe corpus (live-preview-latency/corpus.ts), ported verbatim with the expectations written
//   BEFORE any grammar existed, graded at its own clock (Mon Oct 5 2026 21:10 New York). Where the grammar
//   reads an item differently ON PURPOSE, `PROBE_OVERRIDES` says what it reads and why;
// - the interpreter's few-shot examples, Todoist's recurring examples that fall in Frizz's RRULE subset, the
//   old `scheduleHint.test.ts` cases (its hint was looser than an offer: the differences are noted), the
//   prior-art §6 and §7.5 negatives and the rrule.js prefix-eaters, the spec's §3.3 table, the time-box idioms,
//   quoted, fenced and mid-text cases, the edge guards, and the two known residual offers.
//
// `CASES` pins each text as ONE LINE per scope (`summarizeReading`), at the spec's clock (Mon Oct 5 2026 14:32
// New York). The lines were reviewed by hand when written; regenerate them only to review a deliberate change.

import type { PhraseReading, Span } from "./schedule-phrase.ts"

export const NY = "America/New_York"
/** The spec's clock (§0.1): Mon Oct 5 2026, 14:32 in New York. */
export const SPEC_NOW = Date.parse("2026-10-05T14:32:00-04:00")
/** The probe corpus's clock: the same Monday at 21:10. */
export const PROBE_NOW = Date.parse("2026-10-05T21:10:00-04:00")

/** A reading in one line: `exact open «span» RRULE @dtstart` plus each assumed part, `spacing` and the
 *  close-edge `veto`; `cue edge why «unread» core RRULE @dtstart`; `ambiguous edge «word»`;
 *  `event «span»`; `presence «span»`; `none`. */
export function summarizeReading(text: string, r: PhraseReading): string {
  const q = (s: Span) => `«${text.slice(s.start, s.end)}»`
  switch (r.kind) {
    case "exact":
      return [
        `exact ${r.edge} ${q(r.span)} ${r.rrule} @${r.dtstart}`,
        ...r.assumed.map((a) =>
          a.part === "meridiem" ? `meridiem:${a.shown}/${a.other}` : `${a.part}:${a.shown}${a.part === "time" && a.word ? `(${a.word})` : ""}`,
        ),
        ...(r.spacing ? ["spacing"] : []),
        ...(r.veto ? [`veto:${r.veto}`] : []),
      ].join(" ")
    case "cue":
      return `cue ${r.edge} ${r.why} ${q(r.unread)}${r.core ? ` core ${r.core.rrule} @${r.core.dtstart}` : ""}`
    case "ambiguous":
      return `ambiguous ${r.edge} «${r.word}»`
    case "event":
    case "presence":
      return `${r.kind} ${q(r.span)}`
    default:
      return "none"
  }
}

// ---- the probe corpus, verbatim ------------------------------------------------------------------------------

// Corpus written BEFORE the grammar. NOW = Mon Oct 5 2026 21:10 America/New_York.
// expect: {r, dt?} exact; {r, dt?, soft} = a defaulted time/day (graded on dates + must flag default);
// "MODEL" = needs the model (parser must decline with a cue); "NONE" = a dispatch (parser should stay silent).
export type ProbeExpect = { r: string; dt?: string; soft?: boolean } | "MODEL" | "NONE"
export type ProbeItem = { cat: "S" | "M" | "H" | "D"; text: string; expect: ProbeExpect; note?: string }
const MF = "MO,TU,WE,TH,FR"
export const PROBE_CORPUS: ProbeItem[] = [
  // ---- S: one weekday set / daily / weekdays / weekends, optional clock --------------------------------
  { cat: "S", text: "every Monday at 9am triage new issues", expect: { r: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0" } },
  { cat: "S", text: "weekdays at 8:30 summarize PRs", expect: { r: `FREQ=WEEKLY;BYDAY=${MF};BYHOUR=8;BYMINUTE=30` } },
  { cat: "S", text: "daily at 6pm check CI", expect: { r: "FREQ=DAILY;BYHOUR=18;BYMINUTE=0" } },
  { cat: "S", text: "triage new issues every Monday at 9am", expect: { r: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0" } },
  { cat: "S", text: "Every weekday at 9, post a standup summary of yesterday's merged PRs in #eng", expect: { r: `FREQ=WEEKLY;BYDAY=${MF};BYHOUR=9;BYMINUTE=0` } },
  { cat: "S", text: "every morning summarize overnight Sentry errors", expect: { r: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0", soft: true } },
  { cat: "S", text: "Every Friday at 4pm, write a summary of what shipped this week.", expect: { r: "FREQ=WEEKLY;BYDAY=FR;BYHOUR=16;BYMINUTE=0" } },
  { cat: "S", text: "every day at 7am check that the nightly build passed", expect: { r: "FREQ=DAILY;BYHOUR=7;BYMINUTE=0" } },
  { cat: "S", text: "On Mondays and Thursdays at 10am, review open dependabot PRs", expect: { r: "FREQ=WEEKLY;BYDAY=MO,TH;BYHOUR=10;BYMINUTE=0" } },
  { cat: "S", text: "every Sunday night clean up stale branches", expect: { r: "FREQ=WEEKLY;BYDAY=SU;BYHOUR=21;BYMINUTE=0", soft: true } },
  { cat: "S", text: "weekends at noon check the uptime dashboard", expect: { r: "FREQ=WEEKLY;BYDAY=SA,SU;BYHOUR=12;BYMINUTE=0" } },
  { cat: "S", text: "every Tuesday check for flaky tests", expect: { r: "FREQ=WEEKLY;BYDAY=TU;BYHOUR=9;BYMINUTE=0", soft: true } },
  { cat: "S", text: "daily: run the e2e suite against staging", expect: { r: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0", soft: true } },
  { cat: "S", text: "run the e2e suite against staging nightly", expect: { r: "FREQ=DAILY;BYHOUR=21;BYMINUTE=0", soft: true } },
  { cat: "S", text: "Every weekday morning, check if any PRs are waiting on my review", expect: { r: `FREQ=WEEKLY;BYDAY=${MF};BYHOUR=9;BYMINUTE=0`, soft: true } },
  { cat: "S", text: "every evening at 6 summarize what the agents did today", expect: { r: "FREQ=DAILY;BYHOUR=18;BYMINUTE=0" } },
  { cat: "S", text: "every Monday at 9am", expect: { r: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0" }, note: "no task yet: what people have typed mid-sentence" },
  { cat: "S", text: "Mondays 9am: update the roadmap doc from Linear", expect: { r: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0" } },
  { cat: "S", text: "every wednesday at 2:30pm run the load test and post results", expect: { r: "FREQ=WEEKLY;BYDAY=WE;BYHOUR=14;BYMINUTE=30" } },
  { cat: "S", text: "each Friday afternoon draft the weekly changelog", expect: { r: "FREQ=WEEKLY;BYDAY=FR;BYHOUR=14;BYMINUTE=0", soft: true } },
  { cat: "S", text: "every day at 17:00 check the error budget", expect: { r: "FREQ=DAILY;BYHOUR=17;BYMINUTE=0" } },
  { cat: "S", text: "Check for new CVEs in our dependencies every morning at 8.", expect: { r: "FREQ=DAILY;BYHOUR=8;BYMINUTE=0" } },
  { cat: "S", text: "at 9am every weekday, triage the support inbox", expect: { r: `FREQ=WEEKLY;BYDAY=${MF};BYHOUR=9;BYMINUTE=0` } },
  { cat: "S", text: "every Mon, Wed and Fri at 10 run the smoke tests", expect: { r: "FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=10;BYMINUTE=0" } },
  { cat: "S", text: "Every Thursday at 3 remind me to prep for the planning meeting", expect: { r: "FREQ=WEEKLY;BYDAY=TH;BYHOUR=15;BYMINUTE=0" }, note: "bare 3 read as 3pm" },
  { cat: "S", text: "weekdays at 9am and 5pm sync the issue tracker", expect: { r: `FREQ=WEEKLY;BYDAY=${MF};BYHOUR=9,17;BYMINUTE=0` } },
  { cat: "S", text: "every saturday morning run a full dependency audit", expect: { r: "FREQ=WEEKLY;BYDAY=SA;BYHOUR=9;BYMINUTE=0", soft: true } },
  { cat: "S", text: "hourly, check whether the deploy queue is stuck", expect: { r: "FREQ=HOURLY;BYMINUTE=0", dt: "2026-10-05T22:00" } },
  { cat: "S", text: "every hour check the status page", expect: { r: "FREQ=HOURLY;BYMINUTE=0", dt: "2026-10-05T22:00" } },
  { cat: "S", text: "every day at midnight rotate the logs", expect: { r: "FREQ=DAILY;BYHOUR=0;BYMINUTE=0" } },
  { cat: "S", text: "every weekday at 8:45am summarize new Slack threads in #incidents", expect: { r: `FREQ=WEEKLY;BYDAY=${MF};BYHOUR=8;BYMINUTE=45` } },
  { cat: "S", text: "every Friday at 5pm close stale issues", expect: { r: "FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0" } },
  { cat: "S", text: "Each morning, give me a summary of new GitHub notifications", expect: { r: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0", soft: true } },
  { cat: "S", text: "every Monday morning plan the week from the open issues", expect: { r: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0", soft: true } },
  { cat: "S", text: "daily at 9:15 post the CI flake report", expect: { r: "FREQ=DAILY;BYHOUR=9;BYMINUTE=15" } },
  { cat: "S", text: "Tuesdays at 11am review the on-call handoff notes", expect: { r: "FREQ=WEEKLY;BYDAY=TU;BYHOUR=11;BYMINUTE=0" } },
  { cat: "S", text: "every night at 11pm back up the database", expect: { r: "FREQ=DAILY;BYHOUR=23;BYMINUTE=0" } },
  { cat: "S", text: "Every weekday at noon check that staging matches main", expect: { r: `FREQ=WEEKLY;BYDAY=${MF};BYHOUR=12;BYMINUTE=0` } },
  { cat: "S", text: "every Sunday at 8pm prepare Monday's standup notes", expect: { r: "FREQ=WEEKLY;BYDAY=SU;BYHOUR=20;BYMINUTE=0" } },
  { cat: "S", text: "every day at 10am and 4pm check for new support tickets", expect: { r: "FREQ=DAILY;BYHOUR=10,16;BYMINUTE=0" } },
  { cat: "S", text: "every weekend morning summarize the week's incidents", expect: { r: "FREQ=WEEKLY;BYDAY=SA,SU;BYHOUR=9;BYMINUTE=0", soft: true } },
  { cat: "S", text: "on weekdays at 7:30 check the overnight batch jobs", expect: { r: `FREQ=WEEKLY;BYDAY=${MF};BYHOUR=7;BYMINUTE=30` } },
  { cat: "S", text: "every Wed at 1pm refresh the analytics dashboard", expect: { r: "FREQ=WEEKLY;BYDAY=WE;BYHOUR=13;BYMINUTE=0" } },
  { cat: "S", text: "Every day, pull the latest translations and open a PR", expect: { r: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0", soft: true } },
  { cat: "S", text: "each weekday at 9 check the release checklist", expect: { r: `FREQ=WEEKLY;BYDAY=${MF};BYHOUR=9;BYMINUTE=0` } },
  // ---- M: intervals, every other, month days, ordinals, windows, one-shots, limits, starts -------------
  { cat: "M", text: "every other Friday at 4 write the changelog", expect: { r: "FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;BYHOUR=16;BYMINUTE=0", dt: "2026-10-09T16:00" } },
  { cat: "M", text: "first weekday of the month at 10 bump deps", expect: { r: `FREQ=MONTHLY;BYDAY=${MF};BYSETPOS=1;BYHOUR=10;BYMINUTE=0` } },
  { cat: "M", text: "every 2 hours on weekdays from 9 to 5 check CI", expect: { r: `FREQ=HOURLY;INTERVAL=2;BYDAY=${MF};BYHOUR=9,11,13,15,17;BYMINUTE=0`, dt: "2026-10-05T09:00" } },
  { cat: "M", text: "on the 1st and 15th review billing", expect: { r: "FREQ=MONTHLY;BYMONTHDAY=1,15;BYHOUR=9;BYMINUTE=0", soft: true } },
  { cat: "M", text: "tomorrow at 8 run the migration", expect: { r: "FREQ=DAILY;COUNT=1;BYHOUR=8;BYMINUTE=0", dt: "2026-10-06T08:00" } },
  { cat: "M", text: "every 3 days at 9am rebase the long-lived feature branch", expect: { r: "FREQ=DAILY;INTERVAL=3;BYHOUR=9;BYMINUTE=0", dt: "2026-10-05T09:00" } },
  { cat: "M", text: "every two weeks on Monday at 10 groom the backlog", expect: { r: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;BYHOUR=10;BYMINUTE=0", dt: "2026-10-12T10:00" } },
  { cat: "M", text: "on the last day of every month at 5pm write the monthly report", expect: { r: "FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=17;BYMINUTE=0" } },
  { cat: "M", text: "the first Monday of every month at 9am, review the quarterly OKRs", expect: { r: "FREQ=MONTHLY;BYDAY=1MO;BYHOUR=9;BYMINUTE=0" } },
  { cat: "M", text: "every 15 minutes check if the deploy finished", expect: { r: "FREQ=HOURLY;BYMINUTE=0,15,30,45" } },
  { cat: "M", text: "every 4 hours check the queue depth", expect: { r: "FREQ=HOURLY;INTERVAL=4;BYMINUTE=0", dt: "2026-10-05T22:00" } },
  { cat: "M", text: "weekly on Fridays at 3pm post the metrics digest", expect: { r: "FREQ=WEEKLY;BYDAY=FR;BYHOUR=15;BYMINUTE=0" } },
  { cat: "M", text: "every Monday at 9am for the next 4 weeks, check the migration dashboards", expect: { r: "FREQ=WEEKLY;COUNT=4;BYDAY=MO;BYHOUR=9;BYMINUTE=0", dt: "2026-10-12T09:00" } },
  { cat: "M", text: "daily at 9am until Oct 30 check the beta signup numbers", expect: { r: "FREQ=DAILY;UNTIL=20261030;BYHOUR=9;BYMINUTE=0" } },
  { cat: "M", text: "starting next Monday, every weekday at 9 triage the support queue", expect: { r: `FREQ=WEEKLY;BYDAY=${MF};BYHOUR=9;BYMINUTE=0`, dt: "2026-10-12T09:00" } },
  { cat: "M", text: "on the 15th of every month check the billing reconciliation job", expect: { r: "FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=9;BYMINUTE=0", soft: true } },
  { cat: "M", text: "monthly on the 1st at 10am rotate the API keys", expect: { r: "FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=10;BYMINUTE=0" } },
  { cat: "M", text: "every other day at 8am prune old preview deployments", expect: { r: "FREQ=DAILY;INTERVAL=2;BYHOUR=8;BYMINUTE=0", dt: "2026-10-05T08:00" } },
  { cat: "M", text: "the last Friday of the month at 4pm, write the retro doc", expect: { r: "FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=16;BYMINUTE=0" } },
  { cat: "M", text: "check the SSL certificate renewals every year on January 2", expect: { r: "FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=2;BYHOUR=9;BYMINUTE=0", soft: true } },
  { cat: "M", text: "next Monday at 10am run the data backfill", expect: { r: "FREQ=DAILY;COUNT=1;BYHOUR=10;BYMINUTE=0", dt: "2026-10-12T10:00" } },
  { cat: "M", text: "in 2 hours check whether the canary is healthy", expect: { r: "FREQ=DAILY;COUNT=1;BYHOUR=23;BYMINUTE=10", dt: "2026-10-05T23:10" } },
  { cat: "M", text: "Friday at 3pm deploy the release branch", expect: { r: "FREQ=DAILY;COUNT=1;BYHOUR=15;BYMINUTE=0", dt: "2026-10-09T15:00" } },
  { cat: "M", text: "tonight at 11 run the full reindex", expect: { r: "FREQ=DAILY;COUNT=1;BYHOUR=23;BYMINUTE=0", dt: "2026-10-05T23:00" } },
  { cat: "M", text: "every 6 hours sync the mirror repo", expect: { r: "FREQ=HOURLY;INTERVAL=6;BYMINUTE=0", dt: "2026-10-05T22:00" } },
  { cat: "M", text: "every weekday at 9am for 2 weeks run the onboarding check", expect: { r: `FREQ=WEEKLY;COUNT=10;BYDAY=${MF};BYHOUR=9;BYMINUTE=0`, dt: "2026-10-06T09:00" } },
  { cat: "M", text: "every Monday and Wednesday at 9am starting Oct 12, check the experiment results", expect: { r: "FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=9;BYMINUTE=0", dt: "2026-10-12T09:00" } },
  { cat: "M", text: "every month on the 5th at 2pm generate the invoice summary", expect: { r: "FREQ=MONTHLY;BYMONTHDAY=5;BYHOUR=14;BYMINUTE=0" } },
  { cat: "M", text: "every 2nd Tuesday of the month at 11 review security alerts", expect: { r: "FREQ=MONTHLY;BYDAY=2TU;BYHOUR=11;BYMINUTE=0" } },
  { cat: "M", text: "the 1st of every month at 9am, archive last month's threads", expect: { r: "FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0" } },
  { cat: "M", text: "Mon-Fri at 8am summarize Dependabot alerts", expect: { r: `FREQ=WEEKLY;BYDAY=${MF};BYHOUR=8;BYMINUTE=0` } },
  { cat: "M", text: "every weekday at 6 check the overnight data pipeline", expect: { r: `FREQ=WEEKLY;BYDAY=${MF};BYHOUR=6;BYMINUTE=0` }, note: "bare 6: I read 6am (overnight job); a work-hours heuristic says 6pm" },
  { cat: "M", text: "every 2 weeks on Thursday at 2pm do the sprint review prep", expect: { r: "FREQ=WEEKLY;INTERVAL=2;BYDAY=TH;BYHOUR=14;BYMINUTE=0", dt: "2026-10-08T14:00" } },
  { cat: "M", text: "once a week check for outdated GitHub Actions versions", expect: { r: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0", soft: true }, note: "day is a default" },
  { cat: "M", text: "every morning, if there are new issues, label them", expect: { r: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0", soft: true }, note: "the if is the task's own" },
  { cat: "M", text: "every last workday of the month at 4 run payroll checks", expect: { r: `FREQ=MONTHLY;BYDAY=${MF};BYSETPOS=-1;BYHOUR=16;BYMINUTE=0` } },
  { cat: "M", text: "first thing every Monday, clear out the review queue", expect: { r: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0", soft: true } },
  { cat: "M", text: "every Monday and every Thursday at 9 review dependabot", expect: { r: "FREQ=WEEKLY;BYDAY=MO,TH;BYHOUR=9;BYMINUTE=0" } },
  { cat: "M", text: "every 2nd and 4th Wednesday at 3pm cut the release", expect: { r: "FREQ=MONTHLY;BYDAY=2WE,4WE;BYHOUR=15;BYMINUTE=0" } },
  { cat: "M", text: "every hour on the half hour check the build", expect: { r: "FREQ=HOURLY;BYMINUTE=30" } },
  { cat: "M", text: "last Friday of every quarter write the quarterly review", expect: { r: "FREQ=YEARLY;BYMONTH=3,6,9,12;BYDAY=-1FR;BYHOUR=9;BYMINUTE=0", soft: true } },
  // ---- H: needs judgement — conditions, events, vague counts, holidays, zones, typos, two rules --------
  { cat: "H", text: "every Monday unless it's a holiday post the digest", expect: "MODEL" },
  { cat: "H", text: "the day after each release draft notes", expect: "MODEL" },
  { cat: "H", text: "twice a week check for dependency updates", expect: "MODEL" },
  { cat: "H", text: "every weekday at 9am except holidays triage the inbox", expect: "MODEL" },
  { cat: "H", text: "a few times a day check the support queue", expect: "MODEL" },
  { cat: "H", text: "every business day except Fridays at 10 post the build health", expect: "MODEL" },
  { cat: "H", text: "every payday reconcile the expenses", expect: "MODEL" },
  { cat: "H", text: "at the start of each sprint, groom the backlog", expect: "MODEL" },
  { cat: "H", text: "every 90 minutes check the queue", expect: "MODEL" },
  { cat: "H", text: "evry monday at 9 triage issues", expect: "MODEL", note: "typo" },
  { cat: "H", text: "every Monday at 9 and every Friday at 5 sync the roadmap", expect: "MODEL", note: "two rules" },
  { cat: "H", text: "quarterly, review the access permissions", expect: "MODEL" },
  { cat: "H", text: "every weekday at 9 PT post the summary", expect: "MODEL", note: "zone" },
  { cat: "H", text: "until christmas, every morning check the holiday traffic dashboard", expect: "MODEL" },
  { cat: "H", text: "every weeknight at 10pm run the long benchmark suite", expect: "MODEL", note: "Mon–Thu or Sun–Thu?" },
  { cat: "H", text: "three times a day check the alerts", expect: "MODEL" },
  { cat: "H", text: "on the 31st of each month close the books", expect: "MODEL" },
  { cat: "H", text: "every Monday at 9am Pacific triage issues", expect: "MODEL", note: "zone" },
  { cat: "H", text: "every 30 minutes during business hours check the incident channel", expect: "MODEL" },
  { cat: "H", text: "every time the build fails fix it", expect: "NONE", note: "event = a dispatch" },
  { cat: "H", text: "whenever a PR is opened, review it", expect: "NONE", note: "event" },
  { cat: "H", text: "after every deploy, run the smoke tests", expect: "NONE", note: "event" },
  // ---- D: dispatches that contain schedule-ish words -----------------------------------------------------
  { cat: "D", text: "fix the daily build", expect: "NONE" },
  { cat: "D", text: "make the weekly digest email render on mobile", expect: "NONE" },
  { cat: "D", text: "every file in src/ should have a license header — add the missing ones", expect: "NONE" },
  { cat: "D", text: "add a GitHub Action that runs the tests every Monday at 9am", expect: "NONE", note: "META: a schedule is the subject" },
  { cat: "D", text: "change the nightly CI workflow to run at 3am instead of 2am", expect: "NONE", note: "META" },
  { cat: "D", text: "why did the cron job that runs every hour stop firing?", expect: "NONE", note: "META" },
  { cat: "D", text: "when the tests pass, merge the PR", expect: "NONE" },
  { cat: "D", text: "Review each PR opened since Monday and leave comments", expect: "NONE" },
  { cat: "D", text: "write a function that returns every other element", expect: "NONE" },
  { cat: "D", text: "summarize what happened today in #incidents", expect: "NONE" },
  { cat: "D", text: "add a 'remind me tomorrow at 9' option to the snooze menu", expect: "NONE", note: "META, quoted" },
  { cat: "D", text: "bump the timeout from 5 minutes to 10 minutes", expect: "NONE" },
  { cat: "D", text: "the build has been failing every day this week, find out why", expect: "NONE" },
  { cat: "D", text: "refactor the scheduler so every Monday at 9am isn't parsed as UTC", expect: "NONE", note: "META" },
  { cat: "D", text: "look at the hourly metrics and tell me if anything is off", expect: "NONE" },
  { cat: "D", text: "on Friday we shipped a regression; bisect it", expect: "NONE" },
  { cat: "D", text: "every PR needs a changelog entry; add a CI check for that", expect: "NONE" },
  { cat: "D", text: "check if the migration ran tonight", expect: "NONE" },
  { cat: "D", text: "Each morning standup takes too long, write a bot that summarizes it", expect: "NONE" },
  { cat: "D", text: "make the daily standup bot skip weekends", expect: "NONE" },
  { cat: "D", text: "every time I run pnpm install it hangs — debug it", expect: "NONE" },
  { cat: "D", text: "list every Friday release from the changelog", expect: "NONE" },
  { cat: "D", text: "the report should go out weekly", expect: "NONE", note: "a feature ask" },
  { cat: "D", text: "run the tests", expect: "NONE" },
  { cat: "D", text: "in 2 hours of debugging I couldn't find the leak; try valgrind", expect: "NONE" },
]

/** Where the grammar reads a probe item differently from the corpus ON PURPOSE (each at PROBE_NOW, scope
 *  `anywhere`). Everything else in the corpus is graded as written. */
export const PROBE_OVERRIDES: Record<string, { reads: string; why: string; sameRuns?: true }> = {
  "every 2 hours on weekdays from 9 to 5 check CI": {
    reads: "exact open «every 2 hours on weekdays from 9 to 5» FREQ=HOURLY;INTERVAL=2;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9,11,13,15,17;BYMINUTE=0 @2026-10-06T09:00",
    why: "The start is the first run after now (tomorrow 9am), not this morning's 9am. An even interval inside one day keeps the same runs.",
    sameRuns: true,
  },
  "every 3 days at 9am rebase the long-lived feature branch": {
    reads: "exact open «every 3 days at 9am» FREQ=DAILY;INTERVAL=3;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00",
    why: "An interval is anchored on its first run AFTER now. Anchored on today's 9am, which has passed, the first run would be Thursday — two and a half days out for a rule said on Monday night.",
  },
  "every other day at 8am prune old preview deployments": {
    reads: "exact open «every other day at 8am» FREQ=DAILY;INTERVAL=2;BYHOUR=8;BYMINUTE=0 @2026-10-06T08:00",
    why: "The same anchor: the first run is tomorrow's 8am, not Wednesday's.",
  },
  "every weekday at 6 check the overnight data pipeline": {
    reads: "exact open «every weekday at 6» FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=18;BYMINUTE=0 @2026-10-06T18:00 meridiem:6pm/6am",
    why: "The work-hours rule reads a bare 1–6 as pm (§3.2 E); the corpus author meant 6am. The guess is marked `assumed`, so the box dims the pm and its tooltip offers 6am. A flagged guess, not a silent one.",
  },
  "every morning, if there are new issues, label them": {
    reads: "cue open condition «if there are new issues» core FREQ=DAILY;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00",
    why: "An `if` touching the phrase is a qualifier the grammar does not read (§3.1, never eat a prefix). The corpus called it the task's own; the model decides that, after the human asks.",
  },
  "every hour on the half hour check the build": {
    reads: "cue open unsupported «on the half hour»",
    why: "§3.2 lists `on the half hour` as unsupported; it changes the core's own minute, so no core is shown.",
  },
  "quarterly, review the access permissions": {
    reads: "ambiguous open «quarterly»",
    why: "`quarterly` with no day is the ambiguous kind (§3.2): it says which day it needs instead of asking the model.",
  },
  "every weeknight at 10pm run the long benchmark suite": {
    reads: "ambiguous open «every weeknight»",
    why: "`weeknights` is the ambiguous kind (§3.2): Sunday–Thursday or Monday–Thursday.",
  },
  // Fix round 3, the temporal residue: a word of time left in what would be saved as the task makes the reading
  // a cue, because the grammar cannot know its span is all of WHEN. These three are the price, in this corpus.
  "every morning summarize overnight Sentry errors": {
    reads: "cue open leftover «overnight» core FREQ=DAILY;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00",
    why: "\"Overnight\" is a time of day; here it names the errors, but \"every hour overnight\" narrows the runs. One time of day over an assumed time keeps the core, so the model's answer agrees with it.",
  },
  "Every Friday at 4pm, write a summary of what shipped this week.": {
    reads: "cue open leftover «this week» core FREQ=WEEKLY;BYDAY=FR;BYHOUR=16;BYMINUTE=0 @2026-10-09T16:00",
    why: "\"This week\" is the summary's window here; after a run (\"check the canary this week only\") it bounds the schedule. A period can only narrow, so the core stays.",
  },
  "every evening at 6 summarize what the agents did today": {
    reads: "cue open leftover «today»",
    why: "\"Today\" may add a run of its own (\"…and today\"), so the cue shows no core.",
  },
}

/** The two known residual false offers (§2.6), pinned as OFFERS so any change to them is visible. Each costs
 *  one Esc. */
export const RESIDUAL_OFFERS = [
  "Each morning standup takes too long, write a bot that summarizes it",
  "the report should go out weekly",
]

// ---- the no-silent-prefix qualifiers (§15.1) ---------------------------------------------------------------------

/** Qualifiers that change what a schedule means wherever they sit in the text: a reading that leaves one
 *  outside its span must not be `exact`. */
export const STRONG_QUALIFIERS = [
  "unless it's a holiday",
  "for 3 weeks",
  "except Fridays",
  "only if CI is red",
  "starting next week",
  "until Oct 30",
  "only when the queue is empty",
  "but not on Fridays",
  "skip holidays",
  "excluding weekends",
  "during business hours",
  "after each release",
  "the day after each deploy",
  "till Friday",
  "beginning Oct 12",
  "from Nov 2",
  "for 5 times",
]
/** Qualifiers that are the task's own when they sit inside it ("… label them if there are new issues") but
 *  qualify the schedule when they touch its phrase. */
export const TOUCH_QUALIFIERS = ["if the build is green", "when CI is red", "while I'm working", "before standup", "after the deploy"]

/** Qualifiers found by the break-it battery (fix round 1, 2026-10-06) that the two lists above missed: each
 *  changes WHEN a schedule runs, and each was read as the task's first words while the phrase before it was
 *  offered exact. Tried in the five placements the battery used (after the phrase, comma-joined after it,
 *  ending the text, a clause before it, comma-joined at the end), in the box and in the mode. */
export const BROAD_QUALIFIERS = [
  // exclusions the strong list does not spell
  "apart from Fridays", "aside from Fridays", "besides Fridays", "save Sundays", "save for Sundays", "excl. weekends", "w/o weekends",
  "without weekends", "minus weekends", "bar Sundays", "omitting Sundays", "no Sundays", "Sundays off", "not Fridays", "never on Fridays",
  "Fridays excluded", "weekdays only",
  // a season, a month or a part of the calendar
  "in October", "in December", "in Q4", "this fall", "over the summer", "in odd weeks", "on even weeks", "on odd weeks",
  "every other week", "this month", "this quarter", "this year", "through Q4", "during the freeze",
  // conditions and counts said another way
  "once the migration lands", "in case the queue backs up", "as needed", "max 3 times", "at most 3 times", "x3", "(3x)",
  "3 times max", "no more than 3 times",
  // starts and stops said another way
  "first run next week", "first run on Oct 20", "next 4 weeks", "the next 4 weeks", "over the next 4 weeks", "stopping Oct 30",
  "no earlier than Oct 20",
  // zones
  "Berlin time", "London time", "Tokyo time", "in London", "Europe/Berlin", "America/Los_Angeles", "my time", "+0200",
]

/** Qualifiers found by the second break-it round (fix round 2, 2026-10-06), by the class of WHEN they change —
 *  new members of the classes `BROAD_QUALIFIERS` holds, which it could never hold all of. Round 2 answers with
 *  CLASSES, not more members: a closed-class word (a preposition, a subordinator, a modal) cannot open the
 *  imperative a task starts with, so right after a phrase it is part of WHEN (`WHEN_AFTER`). Same five
 *  placements, both scopes and the field. */
export const ROUND2_QUALIFIERS: Record<string, string[]> = {
  frequency: ["fortnightly", "biweekly", "alternating weeks", "on alternate weeks", "twice", "two times", "3x", "half-hourly", "semi-weekly"],
  bound: ["til EOY", "til the end of the year", "'til Christmas", "through year end", "for the rest of the year", "until further notice", "up until the launch"],
  condition: ["so long as CI is green", "providing CI is green", "given CI is green", "should CI be green", "depending on the load", "weather permitting", "where possible", "barring outages", "if possible"],
  anchor: ["following each release", "right after standup", "just before standup", "shortly after the deploy", "prior to the release", "ahead of standup", "upon each release", "post-launch"],
  zone: ["NZT", "AET", "SAST", "BRT", "AST", "WIB", "IDT", "Kyiv time", "in Kyiv", "Warsaw", "-0500"],
  clock: ["and again at 5", "then at 5", "and later at 5", "at half past", "at quarter past", "at the half hour"],
}

/** Two HELD-OUT sets of the same classes, written for fix round 2 to measure whether the closed-class rule
 *  generalizes rather than memorizes: #1 before any round-2 change (529 of 3,060 reads silently prefixed before
 *  the fix, 9 after it, none offered in the box), #2 after it (14 of 2,520, none offered). Each was measured
 *  once, its residue fixed in class, and is pinned here so it stays fixed. */
export const ROUND2_HELD_OUT: Record<string, string[]> = {
  frequency: ["every second week", "on alternating weekdays", "thrice", "four times", "2x", "bimonthly", "semimonthly", "tri-weekly", "every few days", "every other week", "four times weekly", "two or three times", "once or twice", "every few weeks", "semiannually", "tri-monthly"],
  bound: ["through the end of March", "until the end of the sprint", "up to the release", "till further notice", "ending in December", "for the remainder of Q4", "until we ship", "until the freeze lifts", "through the holidays", "until the migration is done", "for six weeks", "up through Friday", "ending next month", "until mid-November"],
  condition: ["as long as the queue is short", "provided that CI passes", "in the event of failures", "assuming nothing is on fire", "when convenient", "time permitting", "unless told otherwise", "on condition that CI passes", "if needed", "only on green builds", "except on release days", "if nobody objects", "unless I say otherwise", "as long as I'm away", "budget permitting", "in case of outages"],
  anchor: ["immediately after standup", "soon after the deploy", "directly after each merge", "just after lunch", "before each release", "upon arrival", "in the wake of each deploy", "pre-release", "half an hour before standup", "right before lunch", "after the nightly build", "ahead of each sprint review", "around lunchtime", "just past noon", "before EOD"],
  zone: ["HST", "Pacific Standard Time", "AEST", "in Berlin", "Lisbon time", "UTC−5", "-03:00", "Melbourne", "Chicago", "CEST", "ET", "CST", "Eastern", "in Tokyo", "Singapore time", "IST", "UTC+5:30", "Oslo", "WET"],
  clock: ["and then at 6", "plus at 5", "and at noon too", "at a quarter past", "at twenty past", "at ten to", "and once more at 4", "and also at 6", "plus noon", "and at 9pm", "at five past", "around half past", "at 10ish"],
}

/** A second sentence that changes WHEN, in either scope (fix round 2): the opening window ends at the first
 *  sentence, and the words that bound or qualify the schedule came after it. */
export const SECOND_SENTENCES = [
  "every Monday at 9am triage new issues. Stop after Christmas.",
  "every Monday at 9am triage new issues — fortnightly is fine",
  "every Monday at 9am triage new issues. Do this for the rest of the year.",
  "every Monday at 9am triage new issues. Only while the beta runs.",
]

/** The third break-it round's MAJOR findings (fix round 3, 2026-10-06), verbatim, by class: each text was read
 *  EXACT and wrong by grammar v3 — a word of time the reading left out (a zone at the end, a bound later in the
 *  sentence, a count before the phrase, a day or a time of day it read past) or a part of the phrase it
 *  dropped. Round 3 answers with the temporal residue (`schedule-phrase.ts`): none may read exact in either
 *  scope, except the two `ROUND3_READ` now reads in full. */
export const ROUND3_MAJORS: Record<string, string[]> = {
  "ordinal prefix eaten": ["review billing on the second last business day of the month", "the second last Friday of the month, review billing", "the 2nd-to-last weekday of the month review billing", "the third-to-last business day of the month review billing", "second to last Friday of every month review billing"],
  "count before a weekday": ["check the queue twice every Monday", "check the queue three times every Friday", "check the queue 3x every Monday", "check the queue two times every weekday", "check the queue twice on Mondays", "check the queue twice each Monday", "check the queue a couple of times every Monday", "check the queue 4 times on Fridays", "two times every Monday, check the queue"],
  "zone elsewhere": ["every Monday at 9am triage new issues (PT)", "every Monday at 9am triage new issues, times are PST", "Every Monday at 9am, triage new issues. All times Pacific.", "Every Monday at 9am triage new issues. Use UTC.", "Every Monday at 9am triage new issues, in UTC please", "every Monday at 9am triage new issues, I'm in London", "Every Monday at 9am, triage new issues. I'm in Denver.", "Every Monday at 9am triage new issues. (I'm in Tokyo, so use JST.)"],
  "a later bound": ["every 15 minutes check the deploy for the next 2 hours", "every hour check the canary today", "every day at 9am check the canary for 3 more weeks", "every Monday at 9am triage new issues for the next two sprints", "every Monday at 9am triage new issues. Then stop.", "every day at 9am check the canary this week only", "every Monday at 9am triage new issues next quarter", "every Monday at 9am triage new issues while the freeze lasts", "every day at 9am check the canary during the freeze", "every Monday at 9am triage new issues on release days", "every Monday at 9am check the canary, and recheck that evening"],
  "an adverb touching": ["every hour overnight check the queue", "every 2 hours overnight check the queue", "every Monday at 9am latest triage", "every Monday at 9am randomly triage", "every Monday at 9am ± 15m triage", "every Monday at 9am or later triage", "every Monday at 9am temporarily, triage", "check the queue nearly every day", "check the queue almost every day", "check the queue practically every weekday"],
  "a second day dropped": ["Mon and Fri mornings, run the sync", "Tue and Thu evenings, run the sync", "Sat and Sun mornings, water the plants", "run the sync weekday and Saturday mornings", "on the 1st and 15th and last day review billing", "on the 1st and 15th, and month-end, review billing", "on the 1st and 15th (and the 30th) review billing"],
  "the same bare clock twice": ["every day at 7 and 7 check the queue", "every day at 9 and 9 check the queue", "every day at 6, 12 and 6 check the queue"],
  "a said day or time replaced": ["every month on the fifteenth reconcile billing", "every month end, reconcile the ledger", "every week end, back up the laptop", "every Friday lunchtime, order pizza", "every day late morning check the queue", "every day sunset close the blinds", "review billing the first weekend of every month", "on the fifteenth of every month, reconcile billing", "the last week of every month, review billing"],
}
/** The two round-3 majors the spelled ordinals now read in full, and right. */
export const ROUND3_READ: Record<string, string> = {
  "every month on the fifteenth reconcile billing": "FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=9;BYMINUTE=0",
  "on the fifteenth of every month, reconcile billing": "FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=9;BYMINUTE=0",
}
/** Round 3's cores that refused the faithful reading (a second day or date the core left out), with that reading:
 *  a cue may carry a core only if this reading passes it (§4.3). */
export const ROUND3_CORES: { text: string; rrule: string; dtstart: string }[] = [
  { text: "Tuesday and Thursday afternoons, run the sync", rrule: "FREQ=WEEKLY;BYDAY=TU,TH;BYHOUR=14;BYMINUTE=0", dtstart: "2026-10-06T14:00" },
  { text: "every Monday-Wednesday-Friday at 9am triage", rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9;BYMINUTE=0", dtstart: "2026-10-07T09:00" },
  { text: "Saturday and Sunday mornings, water the plants", rrule: "FREQ=WEEKLY;BYDAY=SA,SU;BYHOUR=9;BYMINUTE=0", dtstart: "2026-10-10T09:00" },
  { text: "every January 1st and July 1st review billing", rrule: "FREQ=YEARLY;BYMONTH=1,7;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0", dtstart: "2027-01-01T09:00" },
  { text: "every Mon Wed Fri at 9 triage", rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9;BYMINUTE=0", dtstart: "2026-10-07T09:00" },
  { text: "every Mon, Wed-Fri at 9am triage", rrule: "FREQ=WEEKLY;BYDAY=MO,WE,TH,FR;BYHOUR=9;BYMINUTE=0", dtstart: "2026-10-07T09:00" },
  { text: "every Monday; Thursday at 9 check the canary", rrule: "FREQ=WEEKLY;BYDAY=MO,TH;BYHOUR=9;BYMINUTE=0", dtstart: "2026-10-08T09:00" },
]
/** Words of time the residue knows, at least one for each of its rules' alternatives, by the kind it reads
 *  them as — each the first word of time in "check the queue <words> and report". */
export const RESIDUE_WORDS: Record<string, string[]> = {
  narrow: ["unless it rains", "on holidays", "temporarily", "while the freeze lasts", "whilst away", "during the freeze", "throughout the launch", "on bank holidays", "in business hours", "in working hours", "in office hours", "in work hours", "from now on", "for now", "for the time being", "until further notice", "then stop.", "stop after the launch", "only if green", "only on green builds", "on release days", "on days when it rains"],
  bound: ["until the launch", "up until the launch", "till the launch", "til the launch", "through the launch", "thru the launch", "ending with the launch", "stopping oct 30", "up to the release", "no later than the release"],
  period: ["oct 12-30", "oct 12 – nov 2", "sep–dec", "in january", "in may", "in mar", "this week", "next quarter", "the next 4 weeks", "the last 24 hours", "the past week", "the previous sprint", "yesterday", "the rest of the year", "the remainder of the week", "q4", "fy2026", "fy 26", "in h2", "h1 only", "this summer", "over the summer", "in 2027"],
  day: ["this morning", "tomorrow night", "next weekend", "month end", "month-end", "eow", "the end of the month", "the start of each quarter", "mondays", "friday", "today", "tonight", "tomorrow", "weekends", "weekdays", "weeknights", "workdays", "the first business day", "the 2nd-to-last weekday", "the last friday of the month", "the second to last", "the 2nd last", "the 15th.", "the third of the month", "the 1st and 15th", "oct 20", "20 oct", "the 20th of october", "on 10/20", "10/20/2026", "2026-10-20", "mon-fri", "mon, wed and fri", "next mon", "mon at 9", "christmas", "new year's eve", "black friday", "labor day"],
  except: ["except fridays", "excepting fridays", "excluding weekends", "but not fridays", "other than mondays", "apart from fridays", "aside from fridays", "skip holidays", "skipping fridays", "not fridays", "no sundays", "never on fridays", "nor sundays", "without weekends", "w/o weekends", "excl. weekends", "minus weekends", "barring outages", "bar sundays", "besides fridays", "save sundays", "save for sundays", "omitting sundays", "only weekdays"],
  start: ["starting oct 12", "beginning monday", "from nov 2", "as of monday", "effective monday", "commencing monday", "no earlier than oct 20", "first run on oct 20", "first run next week"],
  for: ["for 3 weeks"],
  window: ["between 9 and 5", "within business hours"],
  zone: ["america/new_york", "europe/berlin", "etc/utc", "utc", "gmt+2", "utc-05:00", "+05:30", "in my time zone", "timezone", "my time", "local time", "server time", "standard time", "daylight savings time", "pacific time", "eastern time", "la time", "times are pacific", "london", "new york", "tokyo"],
  freq: ["every 2 hours", "each morning", "every other week", "every few days", "twice a week", "3 times a day", "2x a week", "twice weekly", "hourly", "daily", "nightly", "weekly", "biweekly", "semi-monthly", "everyday", "periodically", "from time to time", "every so often", "now and then", "once in a while", "on the hour", "on the half hour", "around the clock", "24/7", "at random times", "on a daily basis"],
  duration: ["24 hours", "a few days", "3 more weeks", "half an hour", "a couple of weeks", "48h", "30 mins", "2 wks"],
  clock: ["9am", "9:30", "9h30", "0930 hrs", "at 0930", "noon", "midnight", "overnight", "mornings", "lunchtime", "eod", "first thing", "at lunch", "before standup", "half past nine", "quarter to 5", "ten past noon", "5 past 9", "at 5.", "at 9 and 5, then", "at five in the morning"],
}

// ---- the pinned cases ------------------------------------------------------------------------------------------

export type CaseSource =
  | "probe"
  | "interpreter"
  | "todoist"
  | "hint"
  | "prior-art"
  | "spec"
  | "timebox"
  | "escape"
  | "edge"
  | "kind"

export interface PinnedCase {
  text: string
  source: CaseSource
  /** The reading under `scope: "edges"` (the prompt box outside the mode). */
  edges: string
  /** Under `scope: "anywhere"` (the box in the mode), when it differs from `edges`. */
  anywhere?: string
  exclude?: Span[]
  note?: string
}

export const CASES: PinnedCase[] = [
  // ---- probe
  { text: "every Monday at 9am triage new issues", source: "probe", edges: "exact open «every Monday at 9am» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00" },
  { text: "weekdays at 8:30 summarize PRs", source: "probe", edges: "exact open «weekdays at 8:30» FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=8;BYMINUTE=30 @2026-10-06T08:30 meridiem:8:30am/8:30pm" },
  { text: "daily at 6pm check CI", source: "probe", edges: "exact open «daily at 6pm» FREQ=DAILY;BYHOUR=18;BYMINUTE=0 @2026-10-05T18:00" },
  { text: "triage new issues every Monday at 9am", source: "probe", edges: "exact close «every Monday at 9am» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00", note: "The old hint's trailing-phrase negative, flipped to a close-edge offer by the spec (§14 Step 4)." },
  { text: "Every weekday at 9, post a standup summary of yesterday's merged PRs in #eng", source: "probe", edges: "exact open «Every weekday at 9» FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00 meridiem:9am/9pm" },
  { text: "every morning summarize overnight Sentry errors", source: "probe", edges: "cue open leftover «overnight» core FREQ=DAILY;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00", note: "Fix round 3: a word of time left in the task makes the reading a cue. A time of day over an assumed time keeps the core." },
  { text: "Every Friday at 4pm, write a summary of what shipped this week.", source: "probe", edges: "cue open leftover «this week» core FREQ=WEEKLY;BYDAY=FR;BYHOUR=16;BYMINUTE=0 @2026-10-09T16:00", note: "Fix round 3: \"this week\" can only narrow, so the core stays." },
  { text: "every day at 7am check that the nightly build passed", source: "probe", edges: "exact open «every day at 7am» FREQ=DAILY;BYHOUR=7;BYMINUTE=0 @2026-10-06T07:00" },
  { text: "On Mondays and Thursdays at 10am, review open dependabot PRs", source: "probe", edges: "exact open «On Mondays and Thursdays at 10am» FREQ=WEEKLY;BYDAY=MO,TH;BYHOUR=10;BYMINUTE=0 @2026-10-08T10:00" },
  { text: "every Sunday night clean up stale branches", source: "probe", edges: "exact open «every Sunday night» FREQ=WEEKLY;BYDAY=SU;BYHOUR=21;BYMINUTE=0 @2026-10-11T21:00 time:9pm(night)" },
  { text: "weekends at noon check the uptime dashboard", source: "probe", edges: "exact open «weekends at noon» FREQ=WEEKLY;BYDAY=SA,SU;BYHOUR=12;BYMINUTE=0 @2026-10-10T12:00" },
  { text: "every Tuesday check for flaky tests", source: "probe", edges: "exact open «every Tuesday» FREQ=WEEKLY;BYDAY=TU;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00 time:9am" },
  { text: "daily: run the e2e suite against staging", source: "probe", edges: "exact open «daily» FREQ=DAILY;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00 time:9am" },
  { text: "run the e2e suite against staging nightly", source: "probe", edges: "exact close «nightly» FREQ=DAILY;BYHOUR=21;BYMINUTE=0 @2026-10-05T21:00 time:9pm(nightly)" },
  { text: "Every weekday morning, check if any PRs are waiting on my review", source: "probe", edges: "exact open «Every weekday morning» FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00 time:9am(morning)" },
  { text: "every evening at 6 summarize what the agents did today", source: "probe", edges: "cue open leftover «today»", note: "Fix round 3: \"today\" may name a run of its own (\"…and today\"), so no core." },
  { text: "every Monday at 9am", source: "probe", edges: "exact open «every Monday at 9am» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00" },
  { text: "Mondays 9am: update the roadmap doc from Linear", source: "probe", edges: "exact open «Mondays 9am» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00" },
  { text: "every wednesday at 2:30pm run the load test and post results", source: "probe", edges: "exact open «every wednesday at 2:30pm» FREQ=WEEKLY;BYDAY=WE;BYHOUR=14;BYMINUTE=30 @2026-10-07T14:30" },
  { text: "each Friday afternoon draft the weekly changelog", source: "probe", edges: "exact open «each Friday afternoon» FREQ=WEEKLY;BYDAY=FR;BYHOUR=14;BYMINUTE=0 @2026-10-09T14:00 time:2pm(afternoon)" },
  { text: "every day at 17:00 check the error budget", source: "probe", edges: "exact open «every day at 17:00» FREQ=DAILY;BYHOUR=17;BYMINUTE=0 @2026-10-05T17:00" },
  { text: "Check for new CVEs in our dependencies every morning at 8.", source: "probe", edges: "exact close «every morning at 8» FREQ=DAILY;BYHOUR=8;BYMINUTE=0 @2026-10-06T08:00" },
  { text: "at 9am every weekday, triage the support inbox", source: "probe", edges: "exact open «at 9am every weekday» FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00" },
  { text: "every Mon, Wed and Fri at 10 run the smoke tests", source: "probe", edges: "exact open «every Mon, Wed and Fri at 10» FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=10;BYMINUTE=0 @2026-10-07T10:00 meridiem:10am/10pm" },
  { text: "Every Thursday at 3 remind me to prep for the planning meeting", source: "probe", edges: "exact open «Every Thursday at 3» FREQ=WEEKLY;BYDAY=TH;BYHOUR=15;BYMINUTE=0 @2026-10-08T15:00 meridiem:3pm/3am" },
  { text: "weekdays at 9am and 5pm sync the issue tracker", source: "probe", edges: "exact open «weekdays at 9am and 5pm» FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9,17;BYMINUTE=0 @2026-10-05T17:00" },
  { text: "every saturday morning run a full dependency audit", source: "probe", edges: "exact open «every saturday morning» FREQ=WEEKLY;BYDAY=SA;BYHOUR=9;BYMINUTE=0 @2026-10-10T09:00 time:9am(morning)" },
  { text: "hourly, check whether the deploy queue is stuck", source: "probe", edges: "exact open «hourly» FREQ=HOURLY;BYMINUTE=0 @2026-10-05T15:00" },
  { text: "every hour check the status page", source: "probe", edges: "exact open «every hour» FREQ=HOURLY;BYMINUTE=0 @2026-10-05T15:00" },
  { text: "every day at midnight rotate the logs", source: "probe", edges: "exact open «every day at midnight» FREQ=DAILY;BYHOUR=0;BYMINUTE=0 @2026-10-06T00:00" },
  { text: "every weekday at 8:45am summarize new Slack threads in #incidents", source: "probe", edges: "exact open «every weekday at 8:45am» FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=8;BYMINUTE=45 @2026-10-06T08:45" },
  { text: "every Friday at 5pm close stale issues", source: "probe", edges: "exact open «every Friday at 5pm» FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0 @2026-10-09T17:00" },
  { text: "Each morning, give me a summary of new GitHub notifications", source: "probe", edges: "exact open «Each morning» FREQ=DAILY;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00 time:9am(morning)" },
  { text: "every Monday morning plan the week from the open issues", source: "probe", edges: "exact open «every Monday morning» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00 time:9am(morning)" },
  { text: "daily at 9:15 post the CI flake report", source: "probe", edges: "exact open «daily at 9:15» FREQ=DAILY;BYHOUR=9;BYMINUTE=15 @2026-10-06T09:15 meridiem:9:15am/9:15pm" },
  { text: "Tuesdays at 11am review the on-call handoff notes", source: "probe", edges: "exact open «Tuesdays at 11am» FREQ=WEEKLY;BYDAY=TU;BYHOUR=11;BYMINUTE=0 @2026-10-06T11:00" },
  { text: "every night at 11pm back up the database", source: "probe", edges: "exact open «every night at 11pm» FREQ=DAILY;BYHOUR=23;BYMINUTE=0 @2026-10-05T23:00" },
  { text: "Every weekday at noon check that staging matches main", source: "probe", edges: "exact open «Every weekday at noon» FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=12;BYMINUTE=0 @2026-10-06T12:00" },
  { text: "every Sunday at 8pm prepare Monday's standup notes", source: "probe", edges: "exact open «every Sunday at 8pm» FREQ=WEEKLY;BYDAY=SU;BYHOUR=20;BYMINUTE=0 @2026-10-11T20:00" },
  { text: "every day at 10am and 4pm check for new support tickets", source: "probe", edges: "exact open «every day at 10am and 4pm» FREQ=DAILY;BYHOUR=10,16;BYMINUTE=0 @2026-10-05T16:00" },
  { text: "every weekend morning summarize the week's incidents", source: "probe", edges: "exact open «every weekend morning» FREQ=WEEKLY;BYDAY=SA,SU;BYHOUR=9;BYMINUTE=0 @2026-10-10T09:00 time:9am(morning)" },
  { text: "on weekdays at 7:30 check the overnight batch jobs", source: "probe", edges: "exact open «on weekdays at 7:30» FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=7;BYMINUTE=30 @2026-10-06T07:30 meridiem:7:30am/7:30pm" },
  { text: "every Wed at 1pm refresh the analytics dashboard", source: "probe", edges: "exact open «every Wed at 1pm» FREQ=WEEKLY;BYDAY=WE;BYHOUR=13;BYMINUTE=0 @2026-10-07T13:00" },
  { text: "Every day, pull the latest translations and open a PR", source: "probe", edges: "exact open «Every day» FREQ=DAILY;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00 time:9am" },
  { text: "each weekday at 9 check the release checklist", source: "probe", edges: "exact open «each weekday at 9» FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00 meridiem:9am/9pm" },
  { text: "every other Friday at 4 write the changelog", source: "probe", edges: "exact open «every other Friday at 4» FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;BYHOUR=16;BYMINUTE=0 @2026-10-09T16:00 meridiem:4pm/4am" },
  { text: "first weekday of the month at 10 bump deps", source: "probe", edges: "exact open «first weekday of the month at 10» FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1;BYHOUR=10;BYMINUTE=0 @2026-11-02T10:00 meridiem:10am/10pm" },
  { text: "every 2 hours on weekdays from 9 to 5 check CI", source: "probe", edges: "exact open «every 2 hours on weekdays from 9 to 5» FREQ=HOURLY;INTERVAL=2;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9,11,13,15,17;BYMINUTE=0 @2026-10-05T15:00" },
  { text: "on the 1st and 15th review billing", source: "probe", edges: "exact open «on the 1st and 15th» FREQ=MONTHLY;BYMONTHDAY=1,15;BYHOUR=9;BYMINUTE=0 @2026-10-15T09:00 time:9am" },
  { text: "tomorrow at 8 run the migration", source: "probe", edges: "none", anywhere: "exact open «tomorrow at 8» FREQ=DAILY;COUNT=1;BYHOUR=8;BYMINUTE=0 @2026-10-06T08:00 meridiem:8am/8pm" },
  { text: "every 3 days at 9am rebase the long-lived feature branch", source: "probe", edges: "exact open «every 3 days at 9am» FREQ=DAILY;INTERVAL=3;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00" },
  { text: "every two weeks on Monday at 10 groom the backlog", source: "probe", edges: "exact open «every two weeks on Monday at 10» FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;BYHOUR=10;BYMINUTE=0 @2026-10-12T10:00 meridiem:10am/10pm" },
  { text: "on the last day of every month at 5pm write the monthly report", source: "probe", edges: "exact open «on the last day of every month at 5pm» FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=17;BYMINUTE=0 @2026-10-31T17:00" },
  { text: "the first Monday of every month at 9am, review the quarterly OKRs", source: "probe", edges: "exact open «the first Monday of every month at 9am» FREQ=MONTHLY;BYDAY=1MO;BYHOUR=9;BYMINUTE=0 @2026-11-02T09:00" },
  { text: "every 15 minutes check if the deploy finished", source: "probe", edges: "exact open «every 15 minutes» FREQ=HOURLY;BYMINUTE=0,15,30,45 @2026-10-05T14:45" },
  { text: "every 4 hours check the queue depth", source: "probe", edges: "exact open «every 4 hours» FREQ=HOURLY;INTERVAL=4;BYMINUTE=0 @2026-10-05T15:00" },
  { text: "weekly on Fridays at 3pm post the metrics digest", source: "probe", edges: "exact open «weekly on Fridays at 3pm» FREQ=WEEKLY;BYDAY=FR;BYHOUR=15;BYMINUTE=0 @2026-10-09T15:00" },
  { text: "every Monday at 9am for the next 4 weeks, check the migration dashboards", source: "probe", edges: "exact open «every Monday at 9am for the next 4 weeks» FREQ=WEEKLY;COUNT=4;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00" },
  { text: "daily at 9am until Oct 30 check the beta signup numbers", source: "probe", edges: "exact open «daily at 9am until Oct 30» FREQ=DAILY;UNTIL=20261030;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00" },
  { text: "starting next Monday, every weekday at 9 triage the support queue", source: "probe", edges: "exact open «starting next Monday, every weekday at 9» FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00 meridiem:9am/9pm" },
  { text: "on the 15th of every month check the billing reconciliation job", source: "probe", edges: "exact open «on the 15th of every month» FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=9;BYMINUTE=0 @2026-10-15T09:00 time:9am" },
  { text: "monthly on the 1st at 10am rotate the API keys", source: "probe", edges: "exact open «monthly on the 1st at 10am» FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=10;BYMINUTE=0 @2026-11-01T10:00" },
  { text: "every other day at 8am prune old preview deployments", source: "probe", edges: "exact open «every other day at 8am» FREQ=DAILY;INTERVAL=2;BYHOUR=8;BYMINUTE=0 @2026-10-06T08:00" },
  { text: "the last Friday of the month at 4pm, write the retro doc", source: "probe", edges: "exact open «the last Friday of the month at 4pm» FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=16;BYMINUTE=0 @2026-10-30T16:00" },
  { text: "check the SSL certificate renewals every year on January 2", source: "probe", edges: "exact close «every year on January 2» FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=2;BYHOUR=9;BYMINUTE=0 @2027-01-02T09:00 time:9am" },
  { text: "next Monday at 10am run the data backfill", source: "probe", edges: "none", anywhere: "exact open «next Monday at 10am» FREQ=DAILY;COUNT=1;BYHOUR=10;BYMINUTE=0 @2026-10-12T10:00" },
  { text: "in 2 hours check whether the canary is healthy", source: "probe", edges: "none", anywhere: "exact open «in 2 hours» FREQ=DAILY;COUNT=1;BYHOUR=16;BYMINUTE=32 @2026-10-05T16:32" },
  { text: "Friday at 3pm deploy the release branch", source: "probe", edges: "none", anywhere: "exact open «Friday at 3pm» FREQ=DAILY;COUNT=1;BYHOUR=15;BYMINUTE=0 @2026-10-09T15:00" },
  { text: "tonight at 11 run the full reindex", source: "probe", edges: "none", anywhere: "exact open «tonight at 11» FREQ=DAILY;COUNT=1;BYHOUR=23;BYMINUTE=0 @2026-10-05T23:00" },
  { text: "every 6 hours sync the mirror repo", source: "probe", edges: "exact open «every 6 hours» FREQ=HOURLY;INTERVAL=6;BYMINUTE=0 @2026-10-05T15:00" },
  { text: "every weekday at 9am for 2 weeks run the onboarding check", source: "probe", edges: "exact open «every weekday at 9am for 2 weeks» FREQ=WEEKLY;COUNT=10;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00" },
  { text: "every Monday and Wednesday at 9am starting Oct 12, check the experiment results", source: "probe", edges: "exact open «every Monday and Wednesday at 9am starting Oct 12» FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00" },
  { text: "every month on the 5th at 2pm generate the invoice summary", source: "probe", edges: "exact open «every month on the 5th at 2pm» FREQ=MONTHLY;BYMONTHDAY=5;BYHOUR=14;BYMINUTE=0 @2026-11-05T14:00" },
  { text: "every 2nd Tuesday of the month at 11 review security alerts", source: "probe", edges: "exact open «every 2nd Tuesday of the month at 11» FREQ=MONTHLY;BYDAY=2TU;BYHOUR=11;BYMINUTE=0 @2026-10-13T11:00 meridiem:11am/11pm" },
  { text: "the 1st of every month at 9am, archive last month's threads", source: "probe", edges: "exact open «the 1st of every month at 9am» FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0 @2026-11-01T09:00" },
  { text: "Mon-Fri at 8am summarize Dependabot alerts", source: "probe", edges: "exact open «Mon-Fri at 8am» FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=8;BYMINUTE=0 @2026-10-06T08:00" },
  { text: "every weekday at 6 check the overnight data pipeline", source: "probe", edges: "exact open «every weekday at 6» FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=18;BYMINUTE=0 @2026-10-05T18:00 meridiem:6pm/6am" },
  { text: "every 2 weeks on Thursday at 2pm do the sprint review prep", source: "probe", edges: "exact open «every 2 weeks on Thursday at 2pm» FREQ=WEEKLY;INTERVAL=2;BYDAY=TH;BYHOUR=14;BYMINUTE=0 @2026-10-08T14:00" },
  { text: "once a week check for outdated GitHub Actions versions", source: "probe", edges: "exact open «once a week» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00 day:Monday time:9am" },
  { text: "every morning, if there are new issues, label them", source: "probe", edges: "cue open condition «if there are new issues» core FREQ=DAILY;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00" },
  { text: "every last workday of the month at 4 run payroll checks", source: "probe", edges: "exact open «every last workday of the month at 4» FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;BYHOUR=16;BYMINUTE=0 @2026-10-30T16:00 meridiem:4pm/4am" },
  { text: "first thing every Monday, clear out the review queue", source: "probe", edges: "exact open «first thing every Monday» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00 time:9am(first thing)" },
  { text: "every Monday and every Thursday at 9 review dependabot", source: "probe", edges: "exact open «every Monday and every Thursday at 9» FREQ=WEEKLY;BYDAY=MO,TH;BYHOUR=9;BYMINUTE=0 @2026-10-08T09:00 meridiem:9am/9pm" },
  { text: "every 2nd and 4th Wednesday at 3pm cut the release", source: "probe", edges: "exact open «every 2nd and 4th Wednesday at 3pm» FREQ=MONTHLY;BYDAY=2WE,4WE;BYHOUR=15;BYMINUTE=0 @2026-10-14T15:00" },
  { text: "every hour on the half hour check the build", source: "probe", edges: "cue open unsupported «on the half hour»" },
  { text: "last Friday of every quarter write the quarterly review", source: "probe", edges: "exact open «last Friday of every quarter» FREQ=YEARLY;BYMONTH=3,6,9,12;BYDAY=-1FR;BYHOUR=9;BYMINUTE=0 @2026-12-25T09:00 time:9am" },
  { text: "every Monday unless it's a holiday post the digest", source: "probe", edges: "cue open condition «unless it's a holiday» core FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00" },
  { text: "the day after each release draft notes", source: "probe", edges: "cue open event-offset «the day after each release»" },
  { text: "twice a week check for dependency updates", source: "probe", edges: "cue open vague «twice a week»" },
  { text: "every weekday at 9am except holidays triage the inbox", source: "probe", edges: "cue open condition «except holidays» core FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00" },
  { text: "a few times a day check the support queue", source: "probe", edges: "none", anywhere: "cue open vague «a few times a day»" },
  { text: "every business day except Fridays at 10 post the build health", source: "probe", edges: "cue open condition «except Fridays» core FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00" },
  { text: "every payday reconcile the expenses", source: "probe", edges: "cue open vague «every payday»" },
  { text: "at the start of each sprint, groom the backlog", source: "probe", edges: "cue open vague «at the start of each sprint»" },
  { text: "every 90 minutes check the queue", source: "probe", edges: "cue open unsupported «every 90 minutes»" },
  { text: "evry monday at 9 triage issues", source: "probe", edges: "none", anywhere: "cue inside typo «evry»" },
  { text: "every Monday at 9 and every Friday at 5 sync the roadmap", source: "probe", edges: "cue open compound «and every Friday at 5»" },
  { text: "quarterly, review the access permissions", source: "probe", edges: "ambiguous open «quarterly»" },
  { text: "every weekday at 9 PT post the summary", source: "probe", edges: "cue open zone «PT»" },
  { text: "until christmas, every morning check the holiday traffic dashboard", source: "probe", edges: "none", anywhere: "cue inside leftover «until christmas» core FREQ=DAILY;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00" },
  { text: "every weeknight at 10pm run the long benchmark suite", source: "probe", edges: "ambiguous open «every weeknight»" },
  { text: "three times a day check the alerts", source: "probe", edges: "none", anywhere: "cue open vague «three times a day»" },
  { text: "on the 31st of each month close the books", source: "probe", edges: "cue open unsupported «on the 31st of each month»" },
  { text: "every Monday at 9am Pacific triage issues", source: "probe", edges: "cue open zone «Pacific»" },
  { text: "every 30 minutes during business hours check the incident channel", source: "probe", edges: "cue open condition «during business hours» core FREQ=HOURLY;BYMINUTE=0,30 @2026-10-05T15:00" },
  { text: "every time the build fails fix it", source: "probe", edges: "event «every time»" },
  { text: "whenever a PR is opened, review it", source: "probe", edges: "none", anywhere: "event «whenever»" },
  { text: "after every deploy, run the smoke tests", source: "probe", edges: "event «after every deploy»" },
  { text: "fix the daily build", source: "probe", edges: "none" },
  { text: "make the weekly digest email render on mobile", source: "probe", edges: "none" },
  { text: "every file in src/ should have a license header — add the missing ones", source: "probe", edges: "event «every file»" },
  { text: "add a GitHub Action that runs the tests every Monday at 9am", source: "probe", edges: "exact close «every Monday at 9am» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00 veto:about", anywhere: "exact close «every Monday at 9am» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00" },
  { text: "change the nightly CI workflow to run at 3am instead of 2am", source: "probe", edges: "none" },
  { text: "why did the cron job that runs every hour stop firing?", source: "probe", edges: "none", anywhere: "exact inside «every hour» FREQ=HOURLY;BYMINUTE=0 @2026-10-05T15:00" },
  { text: "when the tests pass, merge the PR", source: "probe", edges: "none", anywhere: "event «when the tests pass»" },
  { text: "Review each PR opened since Monday and leave comments", source: "probe", edges: "none", anywhere: "event «each PR»" },
  { text: "write a function that returns every other element", source: "probe", edges: "none" },
  { text: "summarize what happened today in #incidents", source: "probe", edges: "none" },
  { text: "add a 'remind me tomorrow at 9' option to the snooze menu", source: "probe", edges: "none", anywhere: "exact inside «tomorrow at 9» FREQ=DAILY;COUNT=1;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00 meridiem:9am/9pm" },
  { text: "bump the timeout from 5 minutes to 10 minutes", source: "probe", edges: "none" },
  { text: "the build has been failing every day this week, find out why", source: "probe", edges: "none", anywhere: "cue inside leftover «this week» core FREQ=DAILY;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00" },
  { text: "refactor the scheduler so every Monday at 9am isn't parsed as UTC", source: "probe", edges: "none", anywhere: "cue inside condition «isn't parsed as UTC»", note: "A statement right after the phrase (fix round 1): the words are ABOUT the phrase, so the mode asks the model rather than read a rule." },
  { text: "look at the hourly metrics and tell me if anything is off", source: "probe", edges: "none" },
  { text: "on Friday we shipped a regression; bisect it", source: "probe", edges: "none" },
  { text: "every PR needs a changelog entry; add a CI check for that", source: "probe", edges: "event «every PR»" },
  { text: "check if the migration ran tonight", source: "probe", edges: "none", anywhere: "exact close «tonight» FREQ=DAILY;COUNT=1;BYHOUR=21;BYMINUTE=0 @2026-10-05T21:00 time:9pm(tonight)" },
  { text: "Each morning standup takes too long, write a bot that summarizes it", source: "probe", edges: "exact open «Each morning» FREQ=DAILY;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00 time:9am(morning)", note: "Known residual offer (§2.6)." },
  { text: "make the daily standup bot skip weekends", source: "probe", edges: "none" },
  { text: "every time I run pnpm install it hangs — debug it", source: "probe", edges: "event «every time»" },
  { text: "list every Friday release from the changelog", source: "probe", edges: "none", anywhere: "exact inside «every Friday» FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0 @2026-10-09T09:00 time:9am" },
  { text: "the report should go out weekly", source: "probe", edges: "exact close «weekly» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00 day:Monday time:9am", note: "Known residual offer (§2.6)." },
  { text: "run the tests", source: "probe", edges: "none" },
  { text: "in 2 hours of debugging I couldn't find the leak; try valgrind", source: "probe", edges: "none" },
  // ---- interpreter
  { text: "Write the monthly changelog on the last day of every month at 5pm.", source: "interpreter", edges: "exact close «on the last day of every month at 5pm» FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=17;BYMINUTE=0 @2026-10-31T17:00" },
  { text: "the day after each release, draft release notes from the merged PRs", source: "interpreter", edges: "cue open event-offset «the day after each release»" },
  { text: "while I'm working, keep an eye on CI", source: "interpreter", edges: "none", anywhere: "presence «while I'm working»" },
  // ---- todoist
  { text: "every day", source: "todoist", edges: "exact open «every day» FREQ=DAILY;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00 time:9am" },
  { text: "daily", source: "todoist", edges: "none", anywhere: "exact open «daily» FREQ=DAILY;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00 time:9am", note: "A phrase that is the whole text counts as the open edge, where the end of the text is not a clause boundary for an adverb: \"Daily\" alone is a word being typed." },
  { text: "every weekday", source: "todoist", edges: "exact open «every weekday» FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00 time:9am" },
  { text: "every workday", source: "todoist", edges: "exact open «every workday» FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00 time:9am" },
  { text: "every week", source: "todoist", edges: "exact open «every week» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00 day:Monday time:9am" },
  { text: "weekly", source: "todoist", edges: "none", anywhere: "exact open «weekly» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00 day:Monday time:9am" },
  { text: "every month", source: "todoist", edges: "exact open «every month» FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0 @2026-11-01T09:00 day:the 1st time:9am" },
  { text: "monthly", source: "todoist", edges: "none", anywhere: "exact open «monthly» FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0 @2026-11-01T09:00 day:the 1st time:9am" },
  { text: "every year", source: "todoist", edges: "cue open vague «every year»" },
  { text: "yearly", source: "todoist", edges: "none", anywhere: "cue open vague «yearly»" },
  { text: "everyday starting on aug 3", source: "todoist", edges: "exact open «everyday starting on aug 3» FREQ=DAILY;BYHOUR=9;BYMINUTE=0 @2027-08-03T09:00 time:9am" },
  { text: "everyday from aug 3", source: "todoist", edges: "exact open «everyday from aug 3» FREQ=DAILY;BYHOUR=9;BYMINUTE=0 @2027-08-03T09:00 time:9am" },
  { text: "everyday ending aug 3", source: "todoist", edges: "exact open «everyday ending aug 3» FREQ=DAILY;UNTIL=20270803;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00 time:9am" },
  { text: "everyday until aug 3", source: "todoist", edges: "exact open «everyday until aug 3» FREQ=DAILY;UNTIL=20270803;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00 time:9am" },
  { text: "every Wednesday, Friday, Saturday ending Saturday", source: "todoist", edges: "exact open «every Wednesday, Friday, Saturday ending Saturday» FREQ=WEEKLY;UNTIL=20261010;BYDAY=WE,FR,SA;BYHOUR=9;BYMINUTE=0 @2026-10-07T09:00 time:9am" },
  { text: "everyday for 3 weeks", source: "todoist", edges: "exact open «everyday for 3 weeks» FREQ=DAILY;COUNT=21;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00 time:9am" },
  { text: "everyday from 10 May until 20 May", source: "todoist", edges: "exact open «everyday from 10 May until 20 May» FREQ=DAILY;UNTIL=20270520;BYHOUR=9;BYMINUTE=0 @2027-05-10T09:00 time:9am" },
  { text: "every hour", source: "todoist", edges: "exact open «every hour» FREQ=HOURLY;BYMINUTE=0 @2026-10-05T15:00" },
  { text: "every 12 hours starting at 9pm", source: "todoist", edges: "exact open «every 12 hours starting at 9pm» FREQ=HOURLY;INTERVAL=12;BYMINUTE=0 @2026-10-05T21:00" },
  { text: "every mon, fri at 20:00", source: "todoist", edges: "exact open «every mon, fri at 20:00» FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=20;BYMINUTE=0 @2026-10-05T20:00" },
  { text: "every last workday at 3pm", source: "todoist", edges: "exact open «every last workday at 3pm» FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;BYHOUR=15;BYMINUTE=0 @2026-10-30T15:00" },
  { text: "every fri at noon", source: "todoist", edges: "exact open «every fri at noon» FREQ=WEEKLY;BYDAY=FR;BYHOUR=12;BYMINUTE=0 @2026-10-09T12:00" },
  { text: "every monday, friday", source: "todoist", edges: "exact open «every monday, friday» FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=9;BYMINUTE=0 @2026-10-09T09:00 time:9am" },
  { text: "every mon, fri", source: "todoist", edges: "exact open «every mon, fri» FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=9;BYMINUTE=0 @2026-10-09T09:00 time:9am" },
  { text: "every other day", source: "todoist", edges: "exact open «every other day» FREQ=DAILY;INTERVAL=2;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00 time:9am" },
  { text: "every other week", source: "todoist", edges: "exact open «every other week» FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00 day:Monday time:9am" },
  { text: "every other month", source: "todoist", edges: "exact open «every other month» FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0 @2026-11-01T09:00 day:the 1st time:9am" },
  { text: "every other year", source: "todoist", edges: "cue open vague «every other year»" },
  { text: "every other fri", source: "todoist", edges: "exact open «every other fri» FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;BYHOUR=9;BYMINUTE=0 @2026-10-09T09:00 time:9am" },
  { text: "every quarter", source: "todoist", edges: "ambiguous open «every quarter»" },
  { text: "quarterly", source: "todoist", edges: "ambiguous open «quarterly»" },
  { text: "Every mon at 8pm, tue at 9pm", source: "todoist", edges: "cue open compound «tue at 9pm»" },
  { text: "every day except", source: "todoist", edges: "cue open condition «except» core FREQ=DAILY;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00" },
  { text: "every 2, 15, 27", source: "todoist", edges: "none" },
  { text: "every 3rd friday", source: "todoist", edges: "cue open vague «every 3rd friday»" },
  { text: "every last day", source: "todoist", edges: "exact open «every last day» FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=9;BYMINUTE=0 @2026-10-31T09:00 time:9am" },
  { text: "every first sat of the month", source: "todoist", edges: "exact open «every first sat of the month» FREQ=MONTHLY;BYDAY=1SA;BYHOUR=9;BYMINUTE=0 @2026-11-07T09:00 time:9am" },
  // ---- hint
  { text: "Every weekday at 8:30 summarize CI", source: "hint", edges: "exact open «Every weekday at 8:30» FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=8;BYMINUTE=30 @2026-10-06T08:30 meridiem:8:30am/8:30pm" },
  { text: "each morning check the release branch", source: "hint", edges: "exact open «each morning» FREQ=DAILY;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00 time:9am(morning)" },
  { text: "every 2 hours look at main", source: "hint", edges: "exact open «every 2 hours» FREQ=HOURLY;INTERVAL=2;BYMINUTE=0 @2026-10-05T15:00" },
  { text: "every 15 minutes poll the deploy", source: "hint", edges: "exact open «every 15 minutes» FREQ=HOURLY;BYMINUTE=0,15,30,45 @2026-10-05T14:45" },
  { text: "every other Friday bump deps", source: "hint", edges: "exact open «every other Friday» FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;BYHOUR=9;BYMINUTE=0 @2026-10-09T09:00 time:9am" },
  { text: "every first weekday of the month bump deps", source: "hint", edges: "exact open «every first weekday of the month» FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1;BYHOUR=9;BYMINUTE=0 @2026-11-02T09:00 time:9am" },
  { text: "every day at 10am write release notes", source: "hint", edges: "exact open «every day at 10am» FREQ=DAILY;BYHOUR=10;BYMINUTE=0 @2026-10-06T10:00" },
  { text: "  daily: read the error log", source: "hint", edges: "exact open «daily» FREQ=DAILY;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00 time:9am" },
  { text: "weekdays at 9 triage", source: "hint", edges: "exact open «weekdays at 9» FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00 meridiem:9am/9pm" },
  { text: "Weekly review of open PRs", source: "hint", edges: "none", note: "The old hint lit this; an adjective before a noun is not a schedule." },
  { text: "on Mondays triage issues", source: "hint", edges: "exact open «on Mondays» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00 time:9am" },
  { text: "on weekdays at 6pm summarize", source: "hint", edges: "exact open «on weekdays at 6pm» FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=18;BYMINUTE=0 @2026-10-05T18:00" },
  { text: "on the 1st rotate the keys", source: "hint", edges: "exact open «on the 1st» FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0 @2026-11-01T09:00 time:9am" },
  { text: "Mondays at 9am triage", source: "hint", edges: "exact open «Mondays at 9am» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00" },
  { text: "Thursdays, run the flaky test sweep", source: "hint", edges: "exact open «Thursdays» FREQ=WEEKLY;BYDAY=TH;BYHOUR=9;BYMINUTE=0 @2026-10-08T09:00 time:9am" },
  { text: "Wednesdays check on the docs", source: "hint", edges: "none", note: "The old hint lit this. A bare plural is a schedule only beside a clock or before a clause boundary (§3.2 A)." },
  { text: "Saturdays clean up branches", source: "hint", edges: "none", note: "The old hint lit this; the same bare-plural rule." },
  { text: "tomorrow at 8 bump deps", source: "hint", edges: "none", anywhere: "exact open «tomorrow at 8» FREQ=DAILY;COUNT=1;BYHOUR=8;BYMINUTE=0 @2026-10-06T08:00 meridiem:8am/8pm", note: "The old hint lit this. One-shots are read only in the mode (§2.1)." },
  { text: "tonight at 11 run the migration dry run", source: "hint", edges: "none", anywhere: "exact open «tonight at 11» FREQ=DAILY;COUNT=1;BYHOUR=23;BYMINUTE=0 @2026-10-05T23:00", note: "The old hint lit this. One-shots are read only in the mode (§2.1)." },
  { text: "twice a day check the queue", source: "hint", edges: "cue open vague «twice a day»" },
  { text: "once a week clean up worktrees", source: "hint", edges: "exact open «once a week» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00 day:Monday time:9am" },
  { text: "at 9am every day triage", source: "hint", edges: "exact open «at 9am every day» FREQ=DAILY;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00" },
  { text: "", source: "hint", edges: "none" },
  { text: "   ", source: "hint", edges: "none" },
  { text: "every time the build fails, fix it", source: "hint", edges: "event «every time»" },
  { text: "everything is broken on main", source: "hint", edges: "none" },
  { text: "each PR needs a changelog entry", source: "hint", edges: "event «each PR»" },
  { text: "every file in src should use the logger", source: "hint", edges: "event «every file»" },
  { text: "every one of the tests is flaky", source: "hint", edges: "none" },
  { text: "fix the daily digest email", source: "hint", edges: "none" },
  { text: "daily-driver bug: the sidebar flickers", source: "hint", edges: "none" },
  { text: "the weekly report is wrong", source: "hint", edges: "none" },
  { text: "Monday is when we cut releases, prepare one", source: "hint", edges: "none" },
  { text: "today the CI is red, look at it", source: "hint", edges: "none" },
  // ---- prior-art
  { text: "each PR that touches auth needs a second review", source: "prior-art", edges: "event «each PR»" },
  { text: "create a daily markdown todolist", source: "prior-art", edges: "none" },
  { text: "a script I will run each morning", source: "prior-art", edges: "exact close «each morning» FREQ=DAILY;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00 time:9am(morning) veto:about", anywhere: "exact close «each morning» FREQ=DAILY;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00 time:9am(morning)" },
  { text: "review the PR from Sat morning", source: "prior-art", edges: "none", anywhere: "cue close leftover «from» core FREQ=DAILY;COUNT=1;BYHOUR=9;BYMINUTE=0 @2026-10-10T09:00" },
  { text: "do it now", source: "prior-art", edges: "none" },
  { text: "at 4pm EST the deploy broke", source: "prior-art", edges: "none" },
  { text: "fix the monthly report generator", source: "prior-art", edges: "none" },
  { text: "every Monday at 9am triage new issues and also every friday", source: "prior-art", edges: "cue open compound «every friday»", note: "rrule.js read Mondays only (prior art §4)." },
  { text: "every weekday at 9am except holidays", source: "prior-art", edges: "cue open condition «except holidays» core FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00", note: "rrule.js dropped the qualifier (prior art §4)." },
  { text: "every Monday at 9am for 3 weeks", source: "prior-art", edges: "exact open «every Monday at 9am for 3 weeks» FREQ=WEEKLY;COUNT=3;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00", note: "rrule.js dropped the limit (prior art §4)." },
  { text: "every monday until christmas", source: "prior-art", edges: "cue open leftover «until christmas» core FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00" },
  { text: "every day at 9", source: "prior-art", edges: "exact open «every day at 9» FREQ=DAILY;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00 meridiem:9am/9pm", note: "rrule.js fired at 9:32:17 from a 14:32:17 start; the grammar always writes BYMINUTE." },
  { text: "twice a day check for new issues", source: "prior-art", edges: "cue open vague «twice a day»" },
  { text: "on the last Friday of every month at 5pm write the report", source: "prior-art", edges: "exact open «on the last Friday of every month at 5pm» FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=17;BYMINUTE=0 @2026-10-30T17:00" },
  // ---- spec
  { text: "every Thursday at 3 prep the planning notes", source: "spec", edges: "exact open «every Thursday at 3» FREQ=WEEKLY;BYDAY=TH;BYHOUR=15;BYMINUTE=0 @2026-10-08T15:00 meridiem:3pm/3am" },
  { text: "every other Friday at 4pm write the changelog", source: "spec", edges: "exact open «every other Friday at 4pm» FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;BYHOUR=16;BYMINUTE=0 @2026-10-09T16:00" },
  { text: "daily at 9am until Oct 30 check the beta signups", source: "spec", edges: "exact open «daily at 9am until Oct 30» FREQ=DAILY;UNTIL=20261030;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00" },
  { text: "check the SSL renewals every year on January 2", source: "spec", edges: "exact close «every year on January 2» FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=2;BYHOUR=9;BYMINUTE=0 @2027-01-02T09:00 time:9am" },
  { text: "biweekly sync the roadmap doc", source: "spec", edges: "ambiguous open «biweekly»" },
  { text: "every 5 minutes check the deploy", source: "spec", edges: "exact open «every 5 minutes» FREQ=HOURLY;BYMINUTE=0,5,10,15,20,25,30,35,40,45,50,55 @2026-10-05T14:35 spacing" },
  { text: "quarterly on the first weekday, review access", source: "spec", edges: "exact open «quarterly on the first weekday» FREQ=MONTHLY;BYMONTH=1,4,7,10;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1;BYHOUR=9;BYMINUTE=0 @2027-01-01T09:00 time:9am" },
  // ---- timebox
  { text: "go until 10am tomorrow", source: "timebox", edges: "none", anywhere: "cue close leftover «until» core FREQ=DAILY;COUNT=1;BYHOUR=10;BYMINUTE=0 @2026-10-06T10:00" },
  { text: "don't stop until 10 am tomorrow", source: "timebox", edges: "none", anywhere: "cue close leftover «until» core FREQ=DAILY;COUNT=1;BYHOUR=10;BYMINUTE=0 @2026-10-06T10:00" },
  { text: "keep going until 6pm", source: "timebox", edges: "none" },
  { text: "work on the migration until tomorrow morning", source: "timebox", edges: "none", anywhere: "cue close leftover «until» core FREQ=DAILY;COUNT=1;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00" },
  { text: "stop at 5pm today", source: "timebox", edges: "none", anywhere: "cue close leftover «stop» core FREQ=DAILY;COUNT=1;BYHOUR=17;BYMINUTE=0 @2026-10-05T17:00" },
  { text: "go until 10am tomorrow, then summarize", source: "timebox", edges: "none", anywhere: "cue inside leftover «until» core FREQ=DAILY;COUNT=1;BYHOUR=10;BYMINUTE=0 @2026-10-06T10:00" },
  // ---- escape
  { text: "\"every Monday at 9am\" is parsed as UTC, fix it", source: "escape", edges: "none" },
  { text: "fix the parser for `every Monday at 9am`", source: "escape", edges: "none" },
  { text: "fix this:\n```\nevery Monday at 9am\n```", source: "escape", edges: "none" },
  { text: "/review every Monday at 9am", source: "escape", edges: "exact open «every Monday at 9am» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00" },
  { text: "the job that runs every Monday at 9am is broken, fix it", source: "escape", edges: "none", anywhere: "cue inside condition «is broken»", note: "A statement right after the phrase (fix round 1): the mode asks the model rather than read a rule." },
  { text: "why is “every Monday at 9am” read as UTC", source: "escape", edges: "none" },
  { text: "\"every Monday at 9am", source: "escape", edges: "none" },
  { text: "see the doc.\n\nevery Monday at 9am triage new issues", source: "escape", edges: "none", anywhere: "exact inside «every Monday at 9am» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00" },
  // ---- edge
  { text: "have it done by Friday every week", source: "edge", edges: "cue close leftover «by Friday» core FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00" },
  { text: "schedule a sync every Monday at 9am", source: "edge", edges: "exact close «every Monday at 9am» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00" },
  { text: "post the standup notes. every Monday at 9am", source: "edge", edges: "exact close «every Monday at 9am» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00" },
  { text: "every Monday at 9am. Then post the notes", source: "edge", edges: "exact open «every Monday at 9am» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00" },
  { text: "check CI every day at 5 p.m.", source: "edge", edges: "exact close «every day at 5 p.m.» FREQ=DAILY;BYHOUR=17;BYMINUTE=0 @2026-10-05T17:00" },
  { text: "every day at 9 a.m. check CI", source: "edge", edges: "exact open «every day at 9 a.m.» FREQ=DAILY;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00" },
  { text: "Ping me every morning at 9am.", source: "edge", edges: "exact close «every morning at 9am» FREQ=DAILY;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00" },
  { text: "trigger the deploy every Friday at 5pm", source: "edge", edges: "exact close «every Friday at 5pm» FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0 @2026-10-09T17:00" },
  { text: "make sure the cron job fires every Monday at 9am", source: "edge", edges: "exact close «every Monday at 9am» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00 veto:about", anywhere: "exact close «every Monday at 9am» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00" },
  { text: "finish the report before every Monday at 9am", source: "edge", edges: "cue close event-offset «before» core FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00" },
  { text: "- every Monday at 9am triage new issues", source: "edge", edges: "exact open «every Monday at 9am» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00" },
  { text: "(every Monday at 9am) triage new issues", source: "edge", edges: "exact open «every Monday at 9am» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00" },
  // ---- kind
  { text: "while I'm at lunch, fix the tests", source: "kind", edges: "none", anywhere: "presence «while I'm at lunch»" },
  { text: "when I'm at my desk, check CI", source: "kind", edges: "none", anywhere: "presence «when I'm at my desk»" },
  { text: "bi-weekly review the dashboards", source: "kind", edges: "ambiguous open «bi-weekly»" },
  { text: "bimonthly: clean the backlog", source: "kind", edges: "ambiguous open «bimonthly»" },
  { text: "every quarter check the access logs", source: "kind", edges: "ambiguous open «every quarter»" },
  { text: "today at 5pm deploy", source: "kind", edges: "none", anywhere: "exact open «today at 5pm» FREQ=DAILY;COUNT=1;BYHOUR=17;BYMINUTE=0 @2026-10-05T17:00" },
  { text: "on Oct 20 cut the release", source: "kind", edges: "none", anywhere: "exact open «on Oct 20» FREQ=DAILY;COUNT=1;BYHOUR=9;BYMINUTE=0 @2026-10-20T09:00 time:9am" },
  { text: "tomorrow morning summarize the incidents", source: "kind", edges: "none", anywhere: "exact open «tomorrow morning» FREQ=DAILY;COUNT=1;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00 time:9am(morning)" },
  { text: "this afternoon at 3 rerun the flaky tests", source: "kind", edges: "none", anywhere: "exact open «this afternoon at 3» FREQ=DAILY;COUNT=1;BYHOUR=15;BYMINUTE=0 @2026-10-05T15:00" },
  { text: "in 30 minutes check the canary", source: "kind", edges: "none", anywhere: "exact open «in 30 minutes» FREQ=DAILY;COUNT=1;BYHOUR=15;BYMINUTE=2 @2026-10-05T15:02" },
  { text: "every Monday at 9am and Friday at 5pm sync", source: "kind", edges: "cue open compound «and Friday at 5pm»" },
  { text: "every Monday at 9am, Friday at 5pm sync", source: "kind", edges: "cue open compound «Friday at 5pm»" },
  { text: "every morning and evening check the queue", source: "kind", edges: "cue open compound «and evening»" },
  { text: "first day of every quarter, review access", source: "kind", edges: "exact open «first day of every quarter» FREQ=YEARLY;BYMONTH=1,4,7,10;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0 @2027-01-01T09:00 time:9am" },
  { text: "the first weekday of each quarter at 10am plan the roadmap", source: "kind", edges: "exact open «the first weekday of each quarter at 10am» FREQ=MONTHLY;BYMONTH=1,4,7,10;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1;BYHOUR=10;BYMINUTE=0 @2027-01-01T10:00" },
  { text: "every 45 minutes check the queue", source: "kind", edges: "cue open unsupported «every 45 minutes»" },
  { text: "every 20 minutes poll the queue", source: "kind", edges: "exact open «every 20 minutes» FREQ=HOURLY;BYMINUTE=0,20,40 @2026-10-05T14:40" },
  { text: "every 30 minutes check the queue", source: "kind", edges: "exact open «every 30 minutes» FREQ=HOURLY;BYMINUTE=0,30 @2026-10-05T15:00" },
  { text: "every Friday EOD write the weekly summary", source: "kind", edges: "exact open «every Friday EOD» FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0 @2026-10-09T17:00 time:5pm(EOD)" },
  { text: "every weekday at 9 except Fridays, triage", source: "kind", edges: "cue open condition «except Fridays» core FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00" },
  { text: "on the 29th of each month pay the invoices", source: "kind", edges: "cue open unsupported «on the 29th of each month»" },
  { text: "every Feb 29 celebrate", source: "kind", edges: "cue open unsupported «every Feb 29»", note: "A leap-day rule runs every four years; the model reads it." },
  { text: "every 3 months on the 1st rotate keys", source: "kind", edges: "exact open «every 3 months on the 1st» FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0 @2026-11-01T09:00 time:9am" },
  { text: "every 2 Fridays sync", source: "kind", edges: "cue open vague «every 2 Fridays»" },
  { text: "every second Tuesday review", source: "kind", edges: "cue open vague «every second Tuesday»" },
  { text: "every third Thursday, demo day", source: "kind", edges: "cue open vague «every third Thursday»" },
  { text: "from Monday to Friday at 9am, triage", source: "kind", edges: "exact open «from Monday to Friday at 9am» FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00" },
  { text: "Monday through Friday at 9am triage", source: "kind", edges: "exact open «Monday through Friday at 9am» FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00" },
  { text: "Monday mornings, plan the week", source: "kind", edges: "exact open «Monday mornings» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00 time:9am(morning)" },
  { text: "weekday evenings check the deploy queue", source: "kind", edges: "exact open «weekday evenings» FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=18;BYMINUTE=0 @2026-10-05T18:00 time:6pm(evening)" },
  { text: "each sprint, groom the backlog", source: "kind", edges: "cue open vague «each sprint»" },
  { text: "every fortnight on Tuesday, review the roadmap", source: "kind", edges: "exact open «every fortnight on Tuesday» FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00 time:9am" },
  { text: "every Monday at 9:30am and 5pm sync", source: "kind", edges: "cue open unsupported «at 9:30am and 5pm»" },
  { text: "every day at 9am PT post the summary", source: "kind", edges: "cue open zone «PT»" },
  { text: "regularly check the error budget", source: "kind", edges: "none", anywhere: "cue open vague «regularly»" },
  { text: "every weekday at 9am for 2 weeks starting Oct 12, run the check", source: "kind", edges: "exact open «every weekday at 9am for 2 weeks starting Oct 12» FREQ=WEEKLY;COUNT=10;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00" },
  { text: "monthly on the 31st close the books", source: "kind", edges: "cue open unsupported «on the 31st»" },
  { text: "every Monday at 9 in the morning triage", source: "kind", edges: "exact open «every Monday at 9 in the morning» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00" },
  { text: "every day at 9 o'clock check CI", source: "kind", edges: "exact open «every day at 9 o'clock» FREQ=DAILY;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00 meridiem:9am/9pm" },
  { text: "every evening at 7 summarize the day", source: "kind", edges: "exact open «every evening at 7» FREQ=DAILY;BYHOUR=19;BYMINUTE=0 @2026-10-05T19:00" },
  { text: "@alice every Monday at 9am triage", source: "escape", edges: "exact open «every Monday at 9am» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00", exclude: [{"start":0,"end":6}] },
  { text: "every Monday at 9am triage [ctx: every Friday]", source: "escape", edges: "exact open «every Monday at 9am» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00", exclude: [{"start":27,"end":46}] },
  { text: "summarize @every-friday-bot", source: "escape", edges: "none", exclude: [{"start":10,"end":27}] },
]

/** "Change when" and the server's re-derive (§10.1): the WHOLE string must be the phrase. */
export const FIELD_CASES: { text: string; field: string }[] = [
  { text: "every Monday at 9am", field: "exact field «every Monday at 9am» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00" },
  { text: "Every weekday at 9", field: "exact field «Every weekday at 9» FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00 meridiem:9am/9pm" },
  { text: "every Monday at 9am triage new issues", field: "cue field leftover «triage new issues» core FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00" },
  { text: "tomorrow at 8", field: "exact field «tomorrow at 8» FREQ=DAILY;COUNT=1;BYHOUR=8;BYMINUTE=0 @2026-10-06T08:00 meridiem:8am/8pm" },
  { text: "in 2 hours", field: "exact field «in 2 hours» FREQ=DAILY;COUNT=1;BYHOUR=16;BYMINUTE=32 @2026-10-05T16:32" },
  { text: "next Monday at 10am", field: "exact field «next Monday at 10am» FREQ=DAILY;COUNT=1;BYHOUR=10;BYMINUTE=0 @2026-10-12T10:00" },
  { text: "on Oct 20", field: "exact field «on Oct 20» FREQ=DAILY;COUNT=1;BYHOUR=9;BYMINUTE=0 @2026-10-20T09:00 time:9am" },
  { text: "every weekday at 9am except holidays", field: "cue field condition «except holidays» core FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00" },
  { text: "every weekday at 9am except", field: "cue field condition «except» core FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00" },
  { text: "biweekly", field: "ambiguous field «biweekly»" },
  { text: "every time the build fails", field: "event «every time»" },
  { text: "while I'm working", field: "presence «while I'm working»" },
  { text: "every 5 minutes", field: "exact field «every 5 minutes» FREQ=HOURLY;BYMINUTE=0,5,10,15,20,25,30,35,40,45,50,55 @2026-10-05T14:35 spacing" },
  { text: "every 90 minutes", field: "cue field unsupported «every 90 minutes»" },
  { text: "evry monday at 9", field: "cue field typo «evry»" },
  { text: "twice a week", field: "cue field vague «twice a week»" },
  { text: "every Monday at 9am for 3 weeks", field: "exact field «every Monday at 9am for 3 weeks» FREQ=WEEKLY;COUNT=3;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00" },
  { text: "every day at 9am until Oct 30", field: "exact field «every day at 9am until Oct 30» FREQ=DAILY;UNTIL=20261030;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00" },
  { text: "starting next Monday, every weekday at 9", field: "exact field «starting next Monday, every weekday at 9» FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00 meridiem:9am/9pm" },
  { text: "  every Monday at 9am.  ", field: "exact field «every Monday at 9am» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00" },
  { text: "", field: "none" },
  { text: "Friday", field: "none" },
  { text: "Friday at 3pm", field: "exact field «Friday at 3pm» FREQ=DAILY;COUNT=1;BYHOUR=15;BYMINUTE=0 @2026-10-09T15:00" },
  { text: "every month on the 15th", field: "exact field «every month on the 15th» FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=9;BYMINUTE=0 @2026-10-15T09:00 time:9am" },
  { text: "quarterly", field: "ambiguous field «quarterly»" },
  { text: "on the first weekday of every quarter", field: "exact field «on the first weekday of every quarter» FREQ=MONTHLY;BYMONTH=1,4,7,10;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1;BYHOUR=9;BYMINUTE=0 @2027-01-01T09:00 time:9am" },
]

/** The spec's §3.3 table, row by row, at SPEC_NOW: where it sits, what it reads, and what the ledge says —
 *  `describe` is `describeSchedule` of the reading, `next` the first run as the echo's next line shows it. */
export interface SpecRow {
  row: number
  text: string
  scope: "edges" | "anywhere"
  reads: string
  offered: boolean
  describe?: string
  next?: string
}
export const SPEC_TABLE: SpecRow[] = [
  { row: 1, text: "every Monday at 9am triage new issues", scope: "edges", reads: "exact open «every Monday at 9am» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00", offered: true, describe: "every Monday at 9am", next: "Mon Oct 12" },
  { row: 2, text: "weekdays at 8:30 summarize PRs", scope: "edges", reads: "exact open «weekdays at 8:30» FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=8;BYMINUTE=30 @2026-10-06T08:30 meridiem:8:30am/8:30pm", offered: true, describe: "every weekday at 8:30am", next: "Tue Oct 6" },
  // Fix round 3: "overnight" is a word of time the phrase did not take, so the row is a cue (the spec's table
  // said exact). Its core is the old reading: one time of day over an assumed time cannot contradict it.
  { row: 3, text: "every morning summarize overnight Sentry errors", scope: "edges", reads: "cue open leftover «overnight» core FREQ=DAILY;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00", offered: true },
  { row: 4, text: "Every Thursday at 3 prep the planning notes", scope: "edges", reads: "exact open «Every Thursday at 3» FREQ=WEEKLY;BYDAY=TH;BYHOUR=15;BYMINUTE=0 @2026-10-08T15:00 meridiem:3pm/3am", offered: true, describe: "every Thursday at 3pm", next: "Thu Oct 8" },
  { row: 5, text: "every other Friday at 4pm write the changelog", scope: "edges", reads: "exact open «every other Friday at 4pm» FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;BYHOUR=16;BYMINUTE=0 @2026-10-09T16:00", offered: true, describe: "every other week on Friday at 4pm", next: "Fri Oct 9" },
  // The spec's DTSTART is 09:00 today; the grammar anchors on the first run after now (15:00). With an even
  // interval inside one day the runs are the same.
  { row: 6, text: "every 2 hours on weekdays from 9 to 5 check CI", scope: "edges", reads: "exact open «every 2 hours on weekdays from 9 to 5» FREQ=HOURLY;INTERVAL=2;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9,11,13,15,17;BYMINUTE=0 @2026-10-05T15:00", offered: true, describe: "every 2 hours from 9am to 5pm on weekdays", next: "Mon Oct 5, 3pm" },
  { row: 7, text: "on the 1st and 15th review billing", scope: "edges", reads: "exact open «on the 1st and 15th» FREQ=MONTHLY;BYMONTHDAY=1,15;BYHOUR=9;BYMINUTE=0 @2026-10-15T09:00 time:9am", offered: true, describe: "on the 1st and 15th of every month at 9am", next: "Thu Oct 15" },
  { row: 8, text: "first weekday of the month at 10 bump deps", scope: "edges", reads: "exact open «first weekday of the month at 10» FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1;BYHOUR=10;BYMINUTE=0 @2026-11-02T10:00 meridiem:10am/10pm", offered: true, describe: "on the first weekday of every month at 10am", next: "Mon Nov 2" },
  { row: 9, text: "the last Friday of the month at 4pm, write the retro doc", scope: "edges", reads: "exact open «the last Friday of the month at 4pm» FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=16;BYMINUTE=0 @2026-10-30T16:00", offered: true, describe: "on the last Friday of every month at 4pm", next: "Fri Oct 30" },
  { row: 10, text: "every 15 minutes check if the deploy finished", scope: "edges", reads: "exact open «every 15 minutes» FREQ=HOURLY;BYMINUTE=0,15,30,45 @2026-10-05T14:45", offered: true, describe: "every 15 minutes", next: "Mon Oct 5, 2:45pm" },
  { row: 11, text: "every Monday at 9am for the next 4 weeks, check the migration dashboards", scope: "edges", reads: "exact open «every Monday at 9am for the next 4 weeks» FREQ=WEEKLY;COUNT=4;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00", offered: true, describe: "every Monday at 9am, 4 times", next: "Mon Oct 12" },
  { row: 12, text: "daily at 9am until Oct 30 check the beta signups", scope: "edges", reads: "exact open «daily at 9am until Oct 30» FREQ=DAILY;UNTIL=20261030;BYHOUR=9;BYMINUTE=0 @2026-10-06T09:00", offered: true, describe: "every day at 9am, until Oct 30, 2026", next: "Tue Oct 6" },
  { row: 13, text: "starting next Monday, every weekday at 9 triage the support queue", scope: "edges", reads: "exact open «starting next Monday, every weekday at 9» FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00 meridiem:9am/9pm", offered: true, describe: "every weekday at 9am", next: "Mon Oct 12" },
  { row: 14, text: "triage new issues every Monday at 9am", scope: "edges", reads: "exact close «every Monday at 9am» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00", offered: true, describe: "every Monday at 9am", next: "Mon Oct 12" },
  { row: 15, text: "check the SSL renewals every year on January 2", scope: "edges", reads: "exact close «every year on January 2» FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=2;BYHOUR=9;BYMINUTE=0 @2027-01-02T09:00 time:9am", offered: true, describe: "every year on January 2 at 9am", next: "Sat Jan 2, 2027" },
  { row: 16, text: "weekends at noon check the uptime dashboard", scope: "edges", reads: "exact open «weekends at noon» FREQ=WEEKLY;BYDAY=SA,SU;BYHOUR=12;BYMINUTE=0 @2026-10-10T12:00", offered: true, describe: "every weekend day at 12pm", next: "Sat Oct 10" },
  { row: 17, text: "every Monday unless it's a holiday post the digest", scope: "edges", reads: "cue open condition «unless it's a holiday» core FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00", offered: true },
  { row: 18, text: "twice a week check for dependency updates", scope: "edges", reads: "cue open vague «twice a week»", offered: true },
  { row: 19, text: "biweekly sync the roadmap doc", scope: "edges", reads: "ambiguous open «biweekly»", offered: true },
  { row: 20, text: "every 5 minutes check the deploy", scope: "edges", reads: "exact open «every 5 minutes» FREQ=HOURLY;BYMINUTE=0,5,10,15,20,25,30,35,40,45,50,55 @2026-10-05T14:35 spacing", offered: false },
  { row: 21, text: "tomorrow at 8 run the migration", scope: "edges", reads: "none", offered: false },
  { row: 21, text: "tomorrow at 8 run the migration", scope: "anywhere", reads: "exact open «tomorrow at 8» FREQ=DAILY;COUNT=1;BYHOUR=8;BYMINUTE=0 @2026-10-06T08:00 meridiem:8am/8pm", offered: false, describe: "once, Tue Oct 6, 8am", next: "Tue Oct 6" },
  { row: 22, text: "every time the build fails, fix it", scope: "edges", reads: "event «every time»", offered: false },
  { row: 23, text: "while I'm working, keep an eye on CI", scope: "edges", reads: "none", offered: false },
  { row: 23, text: "while I'm working, keep an eye on CI", scope: "anywhere", reads: "presence «while I'm working»", offered: false },
  { row: 24, text: "add a GitHub Action that runs the tests every Monday at 9am", scope: "edges", reads: "exact close «every Monday at 9am» FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0 @2026-10-12T09:00 veto:about", offered: false },
  { row: 25, text: "fix the monthly report generator", scope: "edges", reads: "none", offered: false },
]
