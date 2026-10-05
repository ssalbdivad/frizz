import { test } from "node:test"
import assert from "node:assert/strict"
import { startsWithRecurrence } from "./scheduleHint.ts"

test("a recurrence phrase at the start lights the hint", () => {
  for (const text of [
    "every Monday at 9am triage new issues",
    "Every weekday at 8:30 summarize CI",
    "each morning check the release branch",
    "every 2 hours look at main",
    "every 15 minutes poll the deploy",
    "every other Friday bump deps",
    "every first weekday of the month bump deps",
    "every day at 10am write release notes",
    "  daily: read the error log",
    "weekdays at 9 triage",
    "Weekly review of open PRs",
    "on Mondays triage issues",
    "on weekdays at 6pm summarize",
    "on the 1st rotate the keys",
    "Mondays at 9am triage",
    "Thursdays, run the flaky test sweep",
    "Wednesdays check on the docs",
    "Saturdays clean up branches",
    "tomorrow at 8 bump deps",
    "tonight at 11 run the migration dry run",
    "twice a day check the queue",
    "once a week clean up worktrees",
    "at 9am every day triage",
  ]) {
    assert.equal(startsWithRecurrence(text), true, text)
  }
})

test("a dispatch that only mentions repetition stays dark", () => {
  for (const text of [
    "",
    "   ",
    "every time the build fails, fix it",
    "everything is broken on main",
    "each PR needs a changelog entry",
    "every file in src should use the logger",
    "every one of the tests is flaky",
    "fix the daily digest email",
    "daily-driver bug: the sidebar flickers",
    "the weekly report is wrong",
    "Monday is when we cut releases, prepare one",
    "triage new issues every Monday at 9am",
    "today the CI is red, look at it",
  ]) {
    assert.equal(startsWithRecurrence(text), false, text)
  }
})
