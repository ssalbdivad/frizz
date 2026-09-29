import assert from "node:assert/strict"
import test from "node:test"
import { buildWorkerPrompt } from "./workerPrompt.ts"

test("both worker backends receive the gerund activity-caption contract", () => {
  for (const backend of ["claude", "codex"] as const) {
    const prompt = buildWorkerPrompt(backend)
    assert.match(prompt, /starts with an `-ing` verb\*\*, in sentence case/)
    assert.match(prompt, /Reading src\/config\.ts/)
    // The imperative is the form that keeps slipping through, so the contract must name it and show
    // the conversion — and must forbid papering over it with a `Running` prefix.
    assert.match(prompt, /`Find relative links in the README` → `Finding relative links in the README`/)
    assert.match(prompt, /Never prefix a description with `Running`/)
  }
})

// THE CEILING, which is the counterweight to a stop criterion that otherwise only ever says "do not
// stop". Traced 2026-08-17 on `investigate-nubjs-nub-642`: dispatched to TRIAGE an issue and recommend
// what to do, it produced the analysis, asked one design question, got no answer for 36 hours, and then
// — under a Goal telling it that a written-up plan is not an ending and that unanswered calls are its own
// to make — decided the question itself and shipped seven commits, a moved global bin dir, shell-profile
// writing and a docs change. Nothing woke it but its own background completions.
//
// "Keep going" is unbounded by construction: there is always more to do in any repo, so a worker
// forbidden to stop can only stop by widening its remit. Both halves have to be in the contract.
test("the contract bounds the work to the task, not only the stopping", () => {
  for (const backend of ["claude", "codex"] as const) {
    const prompt = buildWorkerPrompt(backend)
    assert.match(prompt, /THE INSTRUCTION IS ALSO THE CEILING/)
    assert.match(prompt, /Work you notice on the way is a FINDING, not a task/)
    // An ANALYSIS job ends with its analysis. Denying that is what turned a triage into a feature branch.
    assert.match(prompt, /the document is the ending/i)
    assert.match(prompt, /Implementing what it proposes is the NEXT job/)
    // …and silence from the human is not a mandate.
    assert.match(prompt, /unanswered question is not permission to build the answer/i)
  }
})

// The placement rule's whole arc, because the contract has now taught five different things here and a
// stale assertion would resurrect the wrong one. (1) 2026-08-28 morning, "Same question showing up twice
// in a row": register-then-refence drew two cards, so the rule was "never also fence it". (2) The same
// afternoon the maintainer reversed it ("it kind of makes sense to me for the agent to decide where
// questions render in its own rest message"), and the fence became the PLACEMENT. (3) 2026-08-30 the
// maintainer retired placement ("Retire mid-prose placement" — measured: 15 of 17 real markers sat at
// the tail where the card lands anyway, 2 of 3,005 transcripts couched one mid-prose). (4) 2026-09-11 the
// FREE-FORM fence was retired outright — `ask` had been "better than a fenced block" since 2026-08-26
// while the contract went on teaching the fence, so workers wrote fences on every day from 2026-08-25 to
// 2026-09-11, and nothing tracks a fence's answer — and the empty placement marker came BACK with it,
// because a marker references a ROW: nothing about a question's lifecycle is guessed from prose. (5)
// 2026-09-28 the marker went again, for good reason this time: taught to place the card "after the
// paragraph that sets it up, before the one that says what happens either way", workers put prose under
// it — 7 of 15 real markers — and the maintainer: "questions should always appear at the bottom of the
// thread not in the middle any explanation should occur beforehand". The card draws itself at the bottom
// of the handoff, the contract teaches writing the explanation FIRST, and it must still teach the
// withdrawal — a question left out of the write-up is still open and still gates `done`.
test("the contract teaches that a registered question draws itself at the bottom, and how to unask one", () => {
  for (const backend of ["claude", "codex"] as const) {
    const prompt = buildWorkerPrompt(backend)
    const c = prompt.replace(/\s+/g, " ")
    assert.match(prompt, /EVERY OPEN QUESTION DRAWS ITS OWN CARD AT ITS REST/)
    assert.match(prompt, /draws NOTHING: one question, one card/)
    // The card is last, so the explanation is first — said where the worker asks AND where it stops.
    assert.match(c, /THE CARD IS THE LAST THING THE HUMAN READS — PUT EVERY WORD OF EXPLANATION BEFORE IT/)
    assert.match(c, /frizz draws every open question at the BOTTOM of your newest handoff, below its last line/)
    // An open question rides to the newest handoff through anything — a wake, another card's answer, a
    // typed message (2026-09-29): the worker decides what a message did to it, and a question set aside
    // (dismissed, or withdrawn after the human's message) is never asked again.
    assert.match(c, /AN OPEN QUESTION RIDES TO YOUR NEWEST HANDOFF/)
    assert.match(c, /A MESSAGE PAST A QUESTION DOES NOT CLOSE IT — YOU DECIDE WHAT IT DID/)
    assert.match(c, /NEVER ASK AGAIN a question the human dismissed, or one you withdrew after their newest message/)
    assert.doesNotMatch(c, /A REPLY PAST A QUESTION IS A PIVOT/)
    assert.doesNotMatch(c, /`unask` the old id and `ask` again/)
    // Answers come a question at a time, so the worker must act on each as it lands — the reason the
    // questions of one `ask` must be independent.
    assert.match(c, /ANSWERS ARRIVE ONE QUESTION AT A TIME/)
    assert.doesNotMatch(c, /send as one batch/)
    // Leaving one out is not how a worker drops it — that is what `unask` is for.
    assert.match(prompt, /it is one you\s+`unask`/)
    // The 2026-08-28 grammar ("place them all, or unask") must stay gone, and so must the couching.
    assert.doesNotMatch(prompt, /PLACE EVERY OPEN QUESTION/)
    assert.doesNotMatch(prompt, /A REGISTERED QUESTION IS NEVER ALSO FENCED/)
    assert.doesNotMatch(c, /before the one that says what happens either way/)
  }
})

// THE FREE-FORM ```question FENCE IS RETIRED (2026-09-11), and the contract has to say so where a worker
// reads it — both in § Questions for the human and in the End-of-turn signals list, which is what a
// worker reads when it STOPS. Since 2026-09-28 the empty placement marker is gone too, so the contract
// carries no ```question fence of any shape.
test("the contract teaches ask as the only way to ask, and no question fence at all — not even the marker", () => {
  for (const backend of ["claude", "codex"] as const) {
    const prompt = buildWorkerPrompt(backend)
    const c = prompt.replace(/\s+/g, " ")
    assert.match(c, /THERE IS NO `question` FENCE ANY MORE/)
    assert.match(c, /A QUESTION HAS NO FENCE ANY MORE/)
    assert.match(c, /WAITING ON A PERSON IS A REGISTERED QUESTION/)
    assert.match(c, /AN OPEN REGISTERED QUESTION IS THE HANDBACK/)
    // No fenced question of any shape — neither one with a body nor the retired empty marker.
    assert.deepEqual(prompt.match(/```question[^\n]*\n/g) ?? [], [])
    assert.doesNotMatch(c, /TO PLACE A QUESTION INSIDE YOUR PROSE/)
    assert.doesNotMatch(c, /Placement is OPTIONAL/)
    assert.doesNotMatch(c, /One marker per question/)
    assert.doesNotMatch(c, /PLACEMENT marker is not a signal block/)
    // And the free-form teaching is gone in every spelling it had.
    assert.doesNotMatch(c, /put each question in its own fenced `question` block/)
    assert.doesNotMatch(c, /Fence a question you did NOT register/)
    assert.doesNotMatch(c, /```question ` block IS the handback/)
    assert.doesNotMatch(c, /was retired 2026-08-30;\s*a marker you still write draws nothing/)
    assert.doesNotMatch(c, /surface it as a ` ```question `/)
    assert.doesNotMatch(c, /ask a ```question/)
  }
})
