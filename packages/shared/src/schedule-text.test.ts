// The phrase the schedule interpreter finds, in the text around it (schedule-text.ts): where it sits, the
// prompt left once it is cut out, and the title the box gives a schedule the model did not name.

import assert from "node:assert/strict"
import test from "node:test"
import { cutPhrase, locatePhrase, provisionalScheduleTitle } from "./schedule-text.ts"
import { THREAD_HANDLE_MAX_CHARS, threadHandle } from "./thread-handle.ts"

test("provisionalScheduleTitle: verb and head noun, sentence case, within a thread name", () => {
  for (const [prompt, title] of [
    ["triage new issues", "Triage issues"],
    ["summarize overnight Sentry errors", "Summarize errors"],
    ["post the digest", "Post digest"],
    ["please check CI", "Check CI"],
    ["Triage New Issues", "Triage issues"],
    ["rebase the long-lived feature branch", "Rebase branch"],
    ["review open dependabot PRs, then merge the green ones", "Review PRs"],
    ["deploy", "Deploy"],
    ["update the roadmap doc from Linear", "Update Linear"],
    ["clean it up", "Clean"],
    ["", "Scheduled run"],
    ["   ", "Scheduled run"],
    ["the", "Scheduled run"],
    ["reconcile internationalization-translations", "Reconcile"],
    ["supercalifragilisticexpialidocious things", "Scheduled run"],
  ] as const) {
    const got = provisionalScheduleTitle(prompt)
    assert.equal(got, title, prompt)
    assert.ok(got.split(/\s+/).length <= 2, got)
    assert.ok((threadHandle(got)?.length ?? 0) <= THREAD_HANDLE_MAX_CHARS, got)
  }
})

test("cutPhrase takes the phrase and its seam, and changes nothing else", () => {
  const cut = (text: string, phrase: string) => cutPhrase(text, locatePhrase(text, phrase)!)
  assert.equal(cut("every Monday at 9am triage new issues", "every Monday at 9am"), "triage new issues")
  assert.equal(cut("triage new issues every Monday at 9am", "every Monday at 9am"), "triage new issues")
  assert.equal(cut("Every Friday at 4pm, write a summary of what shipped this week.", "Every Friday at 4pm"), "write a summary of what shipped this week.")
  assert.equal(cut("Mondays 9am: update the roadmap doc", "Mondays 9am"), "update the roadmap doc")
  assert.equal(cut("Check for new CVEs every morning at 8.", "every morning at 8"), "Check for new CVEs.")
  assert.equal(cut("triage — every Monday at 9am — the inbox", "every Monday at 9am"), "triage the inbox")
  assert.equal(cut("Ping me every morning at 9am. Keep it short", "every morning at 9am"), "Ping me. Keep it short")
  assert.equal(cut("every Monday at 9am", "every Monday at 9am"), "")
  // A phrase that was its own opening sentence leaves no stray full stop behind it.
  assert.equal(cut("Every Monday at 9am. Post the digest.", "Every Monday at 9am"), "Post the digest.")
  assert.equal(cut("Every Monday at 9am... post the digest", "Every Monday at 9am"), "post the digest")
  assert.equal(cut("every Monday at 9am .gitignore audit", "every Monday at 9am"), ".gitignore audit")
  // Its own whitespace and case are kept: only the seam is tidied.
  assert.equal(cut("every Monday at 9am  Triage   NEW issues", "every Monday at 9am"), "Triage   NEW issues")
})

test("locatePhrase finds the occurrence nearest the old one, exactly or ignoring case", () => {
  const text = "every day at 9am check CI, and note every day at 9am in the log"
  assert.deepEqual(locatePhrase(text, "every day at 9am"), { start: 0, end: 16 })
  assert.deepEqual(locatePhrase(text, "every day at 9am", 40), { start: 36, end: 52 })
  assert.deepEqual(locatePhrase("Every Day At 9am check CI", "every day at 9am"), { start: 0, end: 16 })
  assert.deepEqual(locatePhrase("check CI  every day at 9am ", " every day at 9am "), { start: 10, end: 26 })
  assert.equal(locatePhrase("check CI", "every day"), undefined)
  assert.equal(locatePhrase("check CI", "   "), undefined)
  // "İ" lowercases to two code units: the case-blind search must not shift every offset after it.
  assert.deepEqual(locatePhrase("İstanbul: EVERY DAY at 9am", "every day"), { start: 10, end: 19 })
})
