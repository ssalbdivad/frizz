// A thread's time limit as the browser reads and writes it (threadDeadline.ts): how loud the reading is, when it
// ticks by the second, what the extend presets add to, and the prompt box's limit — raw text in the draft,
// resolved only at the Enter that starts the thread, cleared with the dispatch and kept with the pick.
import assert from "node:assert/strict"
import test from "node:test"
import { DraftStore, draftKey } from "./drafts.ts"
import { clearDispatchDraft } from "./scheduleDraftState.ts"
import {
  DEADLINE_FAST_WINDOW_MS,
  deadlineEndsLabel,
  deadlineNeedsFastTick,
  deadlineReading,
  deadlineTone,
  extendedDeadlineMs,
  limitPreview,
  resolveDraftDeadline,
} from "./threadDeadline.ts"

class MemoryStorage {
  values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

const MIN = 60_000
const NOW = new Date(2026, 9, 6, 14, 0, 0).getTime() // 14:00 local
const iso = (ms: number) => new Date(ms).toISOString()
const limit = (setAtMin: number, atMin: number) => ({ setAt: iso(NOW + setAtMin * MIN), at: iso(NOW + atMin * MIN) })

test("the tone follows the worker's own stages: quiet, then amber from the 80% converge point, then red", () => {
  // A 1h limit set 30m ago: half-way, plenty.
  assert.equal(deadlineTone(limit(-30, 30), NOW), "plenty")
  // The same hour, 47m in: still before the 48m converge point.
  assert.equal(deadlineTone(limit(-47, 13), NOW), "plenty")
  // 48m in — the instant the worker is told to start nothing new — goes amber.
  assert.equal(deadlineTone(limit(-48, 12), NOW), "closing")
  assert.equal(deadlineTone(limit(-59, 1), NOW), "closing")
  // At the deadline and after: over.
  assert.equal(deadlineTone(limit(-60, 0), NOW), "over")
  assert.equal(deadlineTone(limit(-68, -8), NOW), "over")
  // A 4h budget goes amber with 48m left, not in the last 5m alone.
  assert.equal(deadlineTone(limit(-192, 48), NOW), "closing")
  assert.equal(deadlineTone(limit(-191, 49), NOW), "plenty")
})

test("a deadline with no readable start is quiet until it runs out; an unreadable one is never loud", () => {
  assert.equal(deadlineTone({ setAt: "", at: iso(NOW + 2 * MIN) }, NOW), "plenty")
  assert.equal(deadlineTone({ setAt: "", at: iso(NOW - MIN) }, NOW), "over")
  assert.equal(deadlineTone({ setAt: iso(NOW), at: "nonsense" }, NOW), "plenty")
})

test("the reading is the shared one: minutes rounded up, seconds only under a minute, 'over by' past it", () => {
  assert.equal(deadlineReading({ at: iso(NOW + 42 * MIN) }, NOW), "42m left")
  assert.equal(deadlineReading({ at: iso(NOW + 41 * MIN + 10_000) }, NOW), "42m left")
  assert.equal(deadlineReading({ at: iso(NOW + 40_000) }, NOW), "40s left")
  assert.equal(deadlineReading({ at: iso(NOW - 8 * MIN) }, NOW), "over by 8m")
  assert.equal(deadlineReading({ at: "nonsense" }, NOW), undefined)
})

test("it ticks by the second only while the reading counts seconds, either side of the deadline", () => {
  const at = NOW + 10 * MIN
  assert.equal(deadlineNeedsFastTick(at, at - 2 * MIN), false)
  assert.equal(deadlineNeedsFastTick(at, at - 59_000), true)
  assert.equal(deadlineNeedsFastTick(at, at + 30_000), true)
  assert.equal(deadlineNeedsFastTick(at, at + 2 * MIN), false)
  // Wider than the shared clock's 30s step, so a 30s tick always lands inside it before the seconds begin.
  assert.ok(DEADLINE_FAST_WINDOW_MS > 60_000 + 30_000 - 1)
})

test("extend adds to the current deadline while it is ahead, and to now once it has passed", () => {
  assert.equal(extendedDeadlineMs(NOW + 20 * MIN, NOW, 30 * MIN), NOW + 50 * MIN)
  // Eight minutes over: +30m is thirty more minutes of work from now, not twenty-two.
  assert.equal(extendedDeadlineMs(NOW - 8 * MIN, NOW, 30 * MIN), NOW + 30 * MIN)
})

test("the box's limit resolves AT SUBMIT: '2h' is two hours from the Enter, not from the typing", () => {
  assert.deepEqual(resolveDraftDeadline("", NOW), { ok: true })
  assert.deepEqual(resolveDraftDeadline("   ", NOW), { ok: true })
  const typedAt = NOW - 45 * MIN
  const resolved = resolveDraftDeadline("2h", NOW)
  assert.equal(resolved.ok && resolved.deadline, iso(NOW + 120 * MIN))
  assert.notEqual(resolved.ok && resolved.deadline, iso(typedAt + 120 * MIN))
  const clock = resolveDraftDeadline("15:30", NOW)
  assert.equal(clock.ok && clock.deadline, iso(new Date(2026, 9, 6, 15, 30).getTime()))
})

test("a limit that no longer parses at submit says why, and resolves to nothing", () => {
  // Typed at 13:50 as "14:00", it was ten minutes away; at the 13:59:30 Enter it is thirty seconds away.
  const late = resolveDraftDeadline("14:00", new Date(2026, 9, 6, 13, 59, 30).getTime())
  assert.deepEqual(late, { ok: false, error: "A time limit must be at least 1m." })
  assert.deepEqual(resolveDraftDeadline("8d", NOW), { ok: false, error: "A time limit can be at most 7d." })
  const junk = resolveDraftDeadline("soonish", NOW)
  assert.equal(junk.ok, false)
})

test("the preview says when the typed limit ends, or what is wrong with it, and nothing for an empty field", () => {
  assert.equal(limitPreview("", NOW), undefined)
  assert.deepEqual(limitPreview("90m", NOW), { ok: true, text: deadlineEndsLabel(NOW + 90 * MIN, NOW) })
  assert.match(deadlineEndsLabel(NOW + 90 * MIN, NOW), /^Ends \d/)
  assert.match(deadlineEndsLabel(NOW + 20 * 60 * MIN, NOW), /^Ends tomorrow at /)
  assert.match(deadlineEndsLabel(NOW - 5 * MIN, NOW), /^Ended /)
  assert.deepEqual(limitPreview("30", NOW)?.ok, false)
})

test("the limit is part of the draft: cleared with the dispatch in one notify, kept with the pick by an alias", () => {
  const dir = "/work/limit"
  const drafts = new DraftStore(new MemoryStorage())
  const promptKey = draftKey.dispatch(dir)
  const pickKey = draftKey.dispatchProfile(dir)
  const limitKey = draftKey.dispatchDeadline(dir)
  assert.notEqual(limitKey, draftKey.dispatchDeadline("/elsewhere"), "one limit per project's box")
  drafts.set(promptKey, "port the parser")
  drafts.set(pickKey, JSON.stringify({ backend: "claude", model: "opus", effort: "high" }))
  drafts.set(limitKey, "2h")
  const seen: string[] = []
  drafts.subscribe(() => seen.push(`${drafts.get(promptKey)}|${drafts.get(limitKey)}`))
  clearDispatchDraft(dir, {}, drafts)
  assert.deepEqual(seen, ["|"], "the text and its limit leave in ONE commit")

  drafts.set(promptKey, "/login")
  drafts.set(pickKey, JSON.stringify({ backend: "codex", model: "gpt-5", effort: "high" }))
  drafts.set(limitKey, "45m")
  clearDispatchDraft(dir, { keepPick: true }, drafts)
  assert.equal(drafts.get(promptKey), "")
  assert.equal(drafts.get(limitKey), "45m", "an account alias consumes the text, not the settings of the thread about to start")
})
