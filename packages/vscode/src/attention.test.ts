import { test } from "node:test"
import assert from "node:assert/strict"
import { AttentionGate, attentionText, BODY_MAX, manyText, REPEAT_MS, SPACING_MS, type AttentionItem } from "./attention.ts"

const item = (slug: string, extra: Partial<AttentionItem> = {}): AttentionItem => ({ slug, projectSlug: "acme", title: slug, needs: "ready", ...extra })

test("one thread reads as the board names it, what it needs, and its line", () => {
  assert.equal(attentionText(item("tidy-the-sample-loop", { needs: "question", body: "Which branch should I merge into?" })), "tidy-the-sample-loop has a question: Which branch should I merge into?")
  assert.equal(attentionText(item("fix-the-build", { needs: "approval", body: "Run a command? pnpm install" })), "fix-the-build needs your approval: Run a command? pnpm install")
  assert.equal(attentionText(item("fix-the-build")), "fix-the-build is ready for you.")
  assert.equal(attentionText(item("fix-the-build", { projectName: "acme-api", needs: "terminal" })), "fix-the-build in acme-api is waiting for input in a terminal.")
  // One line, clipped: a toast is read in a glance.
  const said = attentionText(item("x", { body: `${"word ".repeat(80)}\nsecond line` }))
  assert.ok(!said.includes("\n"))
  assert.ok(said.length <= "x is ready for you: ".length + BODY_MAX, said)
  assert.ok(said.endsWith("…"))
})

test("several held together say how many and name them", () => {
  assert.equal(manyText([item("a"), item("b")]), "2 threads need you: a and b.")
  assert.equal(manyText([item("a"), item("b"), item("c")]), "3 threads need you: a, b and c.")
  assert.equal(manyText([item("a"), item("b"), item("c"), item("d"), item("e")]), "5 threads need you: a, b and 3 more.")
})

test("one notification at most every spacing; what comes inside it is held and said together once it ends", () => {
  const gate = new AttentionGate()
  let now = 1_000_000
  assert.deepEqual(gate.offer(item("a"), now), { items: [item("a")] }, "the first is shown at once")
  now += 1_000
  assert.equal(gate.offer(item("b"), now), undefined, "held")
  assert.equal(gate.offer(item("c"), now + 10), undefined, "held")
  assert.equal(gate.offer(item("b"), now + 20), undefined, "held once, not twice")
  assert.equal(gate.dueAt(), 1_000_000 + SPACING_MS)
  assert.equal(gate.due(now + 5_000), undefined, "not before the spacing ends")
  assert.deepEqual(gate.due(1_000_000 + SPACING_MS), { items: [item("b"), item("c")] })
  assert.equal(gate.dueAt(), undefined, "nothing held")
  // The spacing runs from that one now.
  assert.equal(gate.offer(item("d"), 1_000_000 + SPACING_MS + 1), undefined)
  assert.equal(gate.dueAt(), 1_000_000 + 2 * SPACING_MS)
})

test("the same thread again soon after is not news; later it is; the sidebar in sight drops what is held", () => {
  const gate = new AttentionGate()
  let now = 5_000_000
  assert.ok(gate.offer(item("a"), now))
  now += SPACING_MS + 1
  assert.equal(gate.offer(item("a"), now), undefined, "said a moment ago")
  // Another project's thread of the same name is another thread.
  assert.ok(gate.offer(item("a", { projectSlug: "other" }), now))
  now += REPEAT_MS
  assert.ok(gate.offer(item("a"), now), "long enough after, it is news again")
  now += 1
  assert.equal(gate.offer(item("b"), now), undefined)
  gate.clear()
  assert.equal(gate.dueAt(), undefined)
  assert.equal(gate.due(now + SPACING_MS), undefined)
})

test("the thread's line is plain text: a notification renders no Markdown", async () => {
  const { plainLine } = await import("./attention.ts")
  assert.equal(
    plainLine("**Done** — the loop is tidied. The change is in [a.ts](/repo/src/a.ts#L2-L3), see `sample()` and _the notes_."),
    "Done — the loop is tidied. The change is in a.ts, see sample() and the notes.",
  )
  assert.equal(plainLine("## Summary\n- one\n> quoted"), "Summary\none\nquoted")
  // A lone asterisk or an underscore inside a name is not emphasis.
  assert.equal(plainLine("2 * 3 = 6, snake_case_name"), "2 * 3 = 6, snake_case_name")
  assert.equal(attentionText(item("tidy-the-sample-loop", { body: "**Done** — see [a.ts](/repo/a.ts)." })), "tidy-the-sample-loop is ready for you: Done — see a.ts.")
})

test("a line clipped inside a link keeps its words without the link's marks", async () => {
  const { plainLine } = await import("./attention.ts")
  assert.equal(plainLine("The notes are in [the…"), "The notes are in the…")
  assert.equal(plainLine("The notes are in [the readme](/repo/RE…"), "The notes are in the readme")
  assert.equal(plainLine("see [a.ts](/r/a.ts) and [b"), "see a.ts and b")
})
