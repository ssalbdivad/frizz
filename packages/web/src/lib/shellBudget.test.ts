import { test } from "node:test"
import assert from "node:assert/strict"
import { shellBudgetLabel, shellBudgetTitle, shellOverBudget } from "./shellBudget.ts"

const NOW = Date.parse("2026-09-29T12:00:00.000Z")
const at = (ms: number) => new Date(NOW + ms).toISOString()

test("an unbudgeted shell reads nothing — there is no default to show", () => {
  assert.equal(shellBudgetLabel(undefined, NOW), undefined)
  assert.equal(shellBudgetLabel("garbage", NOW), undefined)
  assert.equal(shellBudgetTitle(undefined, NOW), undefined)
  assert.equal(shellOverBudget(undefined, NOW), false)
})

test("a declared budget counts down in the house grammar, then says it is over", () => {
  assert.equal(shellBudgetLabel(at(45 * 60_000), NOW), "45m left")
  assert.equal(shellBudgetLabel(at(2 * 3_600_000 + 5 * 60_000), NOW), "2h 5m left")
  assert.equal(shellBudgetLabel(at(20 * 3_600_000), NOW), "20h left")
  assert.equal(shellBudgetLabel(at(90_000), NOW), "1m left")
  assert.equal(shellBudgetLabel(at(30_000), NOW), "<1m left", "no seconds on a row that ticks every 30s")
  assert.equal(shellBudgetLabel(at(200), NOW), "<1m left", "never a 0s countdown")
  assert.equal(shellBudgetLabel(at(0), NOW), "over budget")
  assert.equal(shellBudgetLabel(at(-60_000), NOW), "over budget")
  assert.equal(shellOverBudget(at(-1), NOW), true)
  assert.equal(shellOverBudget(at(60_000), NOW), false)
  assert.match(shellBudgetTitle(at(60_000), NOW)!, /^Runtime budget ends .*stops the shell 10m later unless it is extended/)
  assert.match(shellBudgetTitle(at(-60_000), NOW)!, /^Past its runtime budget/)
})
