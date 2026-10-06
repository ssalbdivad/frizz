import assert from "node:assert/strict"
import test from "node:test"
import { MAX_TOAST_ACTIONS, showToast, store } from "./store.ts"

const verb = (label: string) => ({ label, run: () => {} })

test("a toast carries at most two verbs, in order, with `action` as sugar that leads", () => {
  showToast("Triage issues scheduled", { actions: [verb("Undo"), verb("Open")] })
  assert.deepEqual(store.toast?.actions?.map((a) => a.label), ["Undo", "Open"])

  showToast("Snoozed", { action: verb("Undo") })
  assert.deepEqual(store.toast?.actions?.map((a) => a.label), ["Undo"])
  assert.equal("action" in (store.toast ?? {}), false, "the sugar is normalized away")

  showToast("Both", { action: verb("Undo"), actions: [verb("Open"), verb("Third")] })
  assert.equal(MAX_TOAST_ACTIONS, 2)
  assert.deepEqual(store.toast?.actions?.map((a) => a.label), ["Undo", "Open"])

  showToast("Bare")
  assert.equal(store.toast?.actions, undefined)
  showToast("Empty", { actions: [] })
  assert.equal(store.toast?.actions, undefined)
  store.toast = null
})
