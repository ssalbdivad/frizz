import assert from "node:assert/strict"
import test from "node:test"
import { DraftStore, draftKey, draftStore } from "./drafts.ts"
import {
  SCHEDULE_DRAFT_OFF,
  afterDraftCreates,
  beginDraftCreate,
  carryDispatchDraft,
  clearDispatchDraft,
  isDraftCreating,
  parseScheduleDraftState,
  readScheduleDraftState,
  serializeScheduleDraftState,
  writeScheduleDraftState,
} from "./scheduleDraftState.ts"

class MemoryStorage {
  values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

const dir = "/work/frizz"
const promptKey = draftKey.dispatch(dir)
const modeKey = draftKey.dispatchSchedule(dir)
const pickKey = draftKey.dispatchProfile(dir)

test("the mode is a sibling of the prompt's key, per project", () => {
  assert.notEqual(modeKey, promptKey)
  assert.notEqual(modeKey, pickKey)
  assert.notEqual(draftKey.dispatchSchedule("/other"), modeKey)
})

test("the resting state is the absent key, and a corrupt record reads off", () => {
  assert.equal(serializeScheduleDraftState(SCHEDULE_DRAFT_OFF), "")
  assert.equal(serializeScheduleDraftState({ v: 1, on: false, dismissed: {} }), "")
  assert.deepEqual(parseScheduleDraftState(""), SCHEDULE_DRAFT_OFF)
  assert.deepEqual(parseScheduleDraftState("{"), SCHEDULE_DRAFT_OFF)
  assert.deepEqual(parseScheduleDraftState(JSON.stringify({ v: 2, on: true })), SCHEDULE_DRAFT_OFF)
  assert.deepEqual(parseScheduleDraftState(JSON.stringify({ v: 1, on: "yes", dismissed: { open: 1 } })), SCHEDULE_DRAFT_OFF)
  // A dismissal alone is worth keeping: the edge stays dark across a reload.
  const dismissedOnly = { v: 1 as const, on: false, dismissed: { close: true as const } }
  assert.deepEqual(parseScheduleDraftState(serializeScheduleDraftState(dismissedOnly)), dismissedOnly)
})

test("the mode survives a same-tab reload: a fresh DraftStore over the same storage reads it on", () => {
  const storage = new MemoryStorage()
  const before = new DraftStore(storage)
  before.set(promptKey, "every Monday at 9am triage new issues")
  writeScheduleDraftState(modeKey, { v: 1, on: true, dismissed: { open: true } }, before)

  const after = new DraftStore(storage) // the reload
  assert.equal(after.get(promptKey), "every Monday at 9am triage new issues")
  assert.deepEqual(readScheduleDraftState(modeKey, after), { v: 1, on: true, dismissed: { open: true } })

  // Turning it off writes the absent key, so the next reload is off too — not a stale `on`.
  writeScheduleDraftState(modeKey, (prev) => ({ ...prev, on: false, dismissed: {} }), after)
  assert.equal(after.get(modeKey), "")
  assert.equal(readScheduleDraftState(modeKey, new DraftStore(storage)).on, false)
})

test("two boxes on one key see the mode flip together, in the same notify", () => {
  const drafts = new DraftStore(new MemoryStorage())
  // The All-projects page box and the `c` dialog over it: two subscribers reading one key.
  const seen: Array<[string, boolean]> = []
  for (const box of ["page", "dialog"]) {
    drafts.subscribe(() => seen.push([box, readScheduleDraftState(modeKey, drafts).on]))
  }
  writeScheduleDraftState(modeKey, (prev) => ({ ...prev, on: true }), drafts)
  assert.deepEqual(seen, [["page", true], ["dialog", true]])
  seen.length = 0
  writeScheduleDraftState(modeKey, (prev) => ({ ...prev, on: false }), drafts)
  assert.deepEqual(seen, [["page", false], ["dialog", false]])
})

test("functional writes read the store at call time, so two in one handler compose", () => {
  const drafts = new DraftStore(new MemoryStorage())
  writeScheduleDraftState(modeKey, { v: 1, on: true, dismissed: {} }, drafts)
  // Leave the mode, then dismiss the edge — the second must not resurrect `on`.
  writeScheduleDraftState(modeKey, (prev) => ({ ...prev, on: false }), drafts)
  writeScheduleDraftState(modeKey, (prev) => ({ ...prev, dismissed: { ...prev.dismissed, open: true } }), drafts)
  assert.deepEqual(readScheduleDraftState(modeKey, drafts), { v: 1, on: false, dismissed: { open: true } })
})

test("clearDispatchDraft clears the prompt, the mode and the pick in ONE notify, and nothing else", () => {
  const storage = new MemoryStorage()
  const drafts = new DraftStore(storage)
  const otherProject = draftKey.dispatch("/elsewhere")
  drafts.set(promptKey, "every Monday at 9am triage new issues")
  drafts.set(pickKey, JSON.stringify({ backend: "claude", model: "opus", effort: "high" }))
  writeScheduleDraftState(modeKey, { v: 1, on: true, dismissed: {} }, drafts)
  drafts.set(otherProject, "keep me")

  // What every subscriber can observe: never a snapshot with the text and the mode off, or the reverse.
  const observed: Array<{ prompt: string; on: boolean; pick: string }> = []
  drafts.subscribe(() => observed.push({ prompt: drafts.get(promptKey), on: readScheduleDraftState(modeKey, drafts).on, pick: drafts.get(pickKey) }))
  clearDispatchDraft(dir, {}, drafts)

  assert.deepEqual(observed, [{ prompt: "", on: false, pick: "" }], "one notify, every key already cleared")
  assert.equal(drafts.get(otherProject), "keep me")
  const reloaded = new DraftStore(storage)
  assert.equal(reloaded.get(promptKey), "")
  assert.equal(reloaded.get(pickKey), "")
  assert.equal(readScheduleDraftState(modeKey, reloaded).on, false)

  // Nothing to clear → no notify at all.
  observed.length = 0
  clearDispatchDraft(dir, {}, drafts)
  assert.deepEqual(observed, [])
})

test("clearDispatchDraft keepPick: an account alias consumes the text, not the profile about to be used", () => {
  const drafts = new DraftStore(new MemoryStorage())
  drafts.set(promptKey, "/login")
  drafts.set(pickKey, JSON.stringify({ backend: "codex", model: "gpt-5", effort: "high" }))
  writeScheduleDraftState(modeKey, { v: 1, on: false, dismissed: { open: true } }, drafts)
  clearDispatchDraft(dir, { keepPick: true }, drafts)
  assert.equal(drafts.get(promptKey), "")
  assert.equal(drafts.get(modeKey), "")
  assert.notEqual(drafts.get(pickKey), "")
})

// Fix round 2, carry-drops-mode: the All-projects box re-aimed at another project (its picker, ⌥↑/⌥↓) moved
// the TEXT and left the mode behind. Driven on a real stack: Tab, re-aim, Enter — a dispatch of text that was
// being set up as a schedule, and an orphaned {on:true} that put the next text typed back in the old project
// straight into the mode. Wherever the text goes, its mode and its dismissals go (I-4), in the commit the text
// lands in, and nothing is left behind.
test("re-aiming the box carries the mode and its dismissals with the text, and leaves nothing behind", () => {
  const a = "/work/carry-a", b = "/work/carry-b", c = "/work/carry-c"
  const text = "every Monday at 9am triage new issues"
  draftStore.set(draftKey.dispatch(a), text)
  writeScheduleDraftState(draftKey.dispatchSchedule(a), { v: 1, on: true, dismissed: { close: true } })
  // A stale record under the target with no text there: the carried draft's own state replaces it.
  writeScheduleDraftState(draftKey.dispatchSchedule(b), { v: 1, on: false, dismissed: { open: true } })
  const observed: Array<{ b: string; bOn: boolean; a: string; aOn: boolean }> = []
  const unsubscribe = draftStore.subscribe(() =>
    observed.push({
      b: draftStore.get(draftKey.dispatch(b)),
      bOn: readScheduleDraftState(draftKey.dispatchSchedule(b)).on,
      a: draftStore.get(draftKey.dispatch(a)),
      aOn: readScheduleDraftState(draftKey.dispatchSchedule(a)).on,
    }),
  )
  carryDispatchDraft(a, b)
  unsubscribe()
  assert.equal(draftStore.get(draftKey.dispatch(b)), text)
  assert.deepEqual(readScheduleDraftState(draftKey.dispatchSchedule(b)), { v: 1, on: true, dismissed: { close: true } })
  assert.equal(draftStore.get(draftKey.dispatch(a)), "")
  assert.equal(draftStore.get(draftKey.dispatchSchedule(a)), "", "no orphaned mode under the project the text left")
  // No subscriber ever saw the carried text in a box whose Enter would dispatch it.
  for (const o of observed) assert.ok(!(o.b === text && !o.bOn), `observed ${JSON.stringify(o)}`)

  // The mode OFF travels too: text set up as a dispatch never lands under a mode left on in the target.
  writeScheduleDraftState(draftKey.dispatchSchedule(c), { v: 1, on: true, dismissed: {} })
  writeScheduleDraftState(draftKey.dispatchSchedule(b), SCHEDULE_DRAFT_OFF)
  carryDispatchDraft(b, c)
  assert.equal(draftStore.get(draftKey.dispatch(c)), text)
  assert.equal(readScheduleDraftState(draftKey.dispatchSchedule(c)).on, false)

  // Never into a draft already waiting there: neither the text nor the mode moves.
  draftStore.set(draftKey.dispatch(a), "mine")
  writeScheduleDraftState(draftKey.dispatchSchedule(c), { v: 1, on: true, dismissed: {} })
  carryDispatchDraft(c, a)
  assert.equal(draftStore.get(draftKey.dispatch(a)), "mine")
  assert.equal(draftStore.get(draftKey.dispatchSchedule(a)), "")
  assert.equal(draftStore.get(draftKey.dispatch(c)), text)
  assert.equal(readScheduleDraftState(draftKey.dispatchSchedule(c)).on, true)

  for (const dir of [a, b, c]) clearDispatchDraft(dir)
})

// Fix round 3: a CREATE IN FLIGHT owns its draft until it lands. Two findings, driven on the fixture:
//   - reaim-during-wash: the box re-aimed (and so remounted) inside the create's RPC and 220ms wash. The carry
//     moved the text and its {on:true} to the other project, then the create cleared the OLD key, already
//     empty — a second, identical schedule one Enter away in the new project's box;
//   - undo-during-next-create: Undo of the last schedule clicked while the next one was still creating merged
//     its words ABOVE the next one's, so the next create's `onCreated` no longer found its own words at the
//     start and kept them all — the created words stayed in the box, under a mode turned off.
// So the draft does not move while a create on it is in flight, and Undo puts its words back only once every
// create on that draft has landed (or failed).
test("a create in flight holds its draft: no carry while it creates, and the carry works again once it lands", () => {
  const a = "/work/inflight-a", b = "/work/inflight-b"
  const key = draftKey.dispatchSchedule(a)
  const text = "every Monday at 9am triage new issues"
  draftStore.set(draftKey.dispatch(a), text)
  writeScheduleDraftState(key, { v: 1, on: true, dismissed: {} })
  assert.equal(isDraftCreating(key), false)
  const end = beginDraftCreate(key)
  assert.equal(isDraftCreating(key), true)
  carryDispatchDraft(a, b)
  assert.equal(draftStore.get(draftKey.dispatch(b)), "", "nothing moved into the other project's box")
  assert.equal(draftStore.get(draftKey.dispatchSchedule(b)), "", "nor its mode")
  assert.equal(draftStore.get(draftKey.dispatch(a)), text, "the words stay where the create will take them from")
  end()
  end() // idempotent: a second end never releases another create's hold
  assert.equal(isDraftCreating(key), false)
  carryDispatchDraft(a, b)
  assert.equal(draftStore.get(draftKey.dispatch(b)), text, "landed: the draft moves again")
  for (const dir of [a, b]) clearDispatchDraft(dir)
})

test("afterDraftCreates waits for every create on that draft, and only that draft", async () => {
  const key = draftKey.dispatchSchedule("/work/inflight-c")
  const other = draftKey.dispatchSchedule("/work/inflight-d")
  const settled = (p: Promise<void>) => Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 20))])
  assert.equal(await settled(afterDraftCreates(key)), true, "nothing in flight: at once")
  const first = beginDraftCreate(key)
  const second = beginDraftCreate(key)
  const busy = beginDraftCreate(other)
  const waiting = afterDraftCreates(key)
  assert.equal(await settled(waiting), false, "two in flight")
  first()
  assert.equal(await settled(waiting), false, "one still in flight")
  second()
  assert.equal(await settled(waiting), true, "both landed; the other draft's create does not hold this one")
  busy()
})
