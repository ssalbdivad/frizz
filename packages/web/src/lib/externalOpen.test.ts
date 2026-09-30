import assert from "node:assert/strict"
import test from "node:test"
import { store } from "../store.ts"
import { baseName, resetExternalOpens, runExternalOpen } from "./externalOpen.ts"

test("baseName names the folder a trailing slash would hide", () => assert.equal(baseName("/home/me/repo-perf/"), "repo-perf"))

test("an open spins from the press until the server answers, and a repeat press meanwhile opens nothing more", async () => {
  resetExternalOpens()
  let opens = 0
  let finish!: (path: string) => void
  const open = () => runExternalOpen("editor:t", "Opening editor…", () => {
    opens++
    return new Promise<string>((resolve) => { finish = resolve })
  }, () => {}, (m) => `Could not: ${m}`)
  const first = open()
  assert.equal(store.toast?.text, "Opening editor…")
  assert.equal(store.toast?.spinner, true)
  await open()
  await open()
  assert.equal(opens, 1, "smashing the key spawns one opener")
  assert.equal(store.toast?.text, "Opening editor…", "still spinning while the launcher runs")
  finish("/home/me/repo-perf/")
  await first
  assert.equal(store.toast, null, "the window is up: the spinner goes, with no \"opened\" to read")
  await open()
  assert.equal(opens, 1, "a press just after the answer is the same burst: held for the cooldown")
  await runExternalOpen("editor:other", "Opening editor…", async () => { opens++ }, () => {}, (m) => m)
  assert.equal(opens, 2, "a different target is not held")
})

test("a failed open says why and can be retried at once", async () => {
  resetExternalOpens()
  let opens = 0
  const open = () => runExternalOpen("file:x", "Opening x…", async () => { opens++; throw new Error("no editor") }, () => {}, (m) => `Could not open: ${m}`)
  await open()
  assert.equal(store.toast?.text, "Could not open: no editor")
  await open()
  assert.equal(opens, 2)
})
