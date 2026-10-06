import { test } from "node:test"
import assert from "node:assert/strict"
import type { ClaudeOneShotRequest } from "./backend/claude-oneshot.ts"
import { createEffortChooser, effortChooserSystemPrompt, parseEffortChoice } from "./effort-chooser.ts"

const LADDER = ["low", "medium", "high", "xhigh", "max", "ultracode"]

test("parseEffortChoice reads a rung through case, punctuation and chatter, and refuses one off the ladder", () => {
  assert.equal(parseEffortChoice("high", LADDER), "high")
  assert.equal(parseEffortChoice(" `XHigh`.\n", LADDER), "xhigh")
  assert.equal(parseEffortChoice("Not low — high.", LADDER), "high")
  assert.equal(parseEffortChoice("ultra", LADDER), undefined)
  assert.equal(parseEffortChoice("", LADDER), undefined)
})

test("the system prompt lists exactly the ladder it was given", () => {
  const system = effortChooserSystemPrompt(["low", "medium", "high"])
  assert.match(system, /- low: /)
  assert.match(system, /- high: /)
  assert.doesNotMatch(system, /ultracode|xhigh/)
})

test("the chooser asks Haiku and falls back on a failure or an off-ladder answer", async () => {
  const requests: ClaudeOneShotRequest[] = []
  const answers: Array<string | Error> = ["max", "banana", new Error("timed out")]
  const logged: string[] = []
  const choose = createEffortChooser({
    complete: async (request) => {
      requests.push(request)
      const next = answers.shift()!
      if (next instanceof Error) throw next
      return next
    },
    log: (message) => logged.push(message),
  })
  const input = { prompt: "Fix the race", efforts: LADDER, fallback: "high" }
  assert.equal(await choose(input), "max")
  assert.equal(await choose(input), "high")
  assert.equal(await choose(input), "high")
  assert.equal(requests[0]?.model, "haiku")
  assert.match(requests[0]?.prompt ?? "", /<task>\nFix the race\n<\/task>/)
  assert.equal(logged.length, 2)
  // No completer (switched off) ⇒ the fallback, with no call made.
  assert.equal(await createEffortChooser({})(input), "high")
})
