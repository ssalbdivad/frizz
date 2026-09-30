import assert from "node:assert/strict"
import test from "node:test"
import { store } from "../store.ts"
import { baseName, resetExternalOpens, runExternalOpen } from "./externalOpen.ts"

test("an open shows a spinner at once, and a repeat press while it runs opens nothing more", async () => {
  resetExternalOpens()
  let opens = 0
  let finish!: (path: string) => void
  const open = () => runExternalOpen("editor:t", "Opening editor…", () => {
    opens++
    return new Promise<string>((resolve) => { finish = resolve })
  }, (path) => { store.toast = { id: 0, text: `Opened ${baseName(path)}` } }, (m) => `Could not: ${m}`)
  const first = open()
  assert.equal(store.toast?.text, "Opening editor…")
  assert.equal(store.toast?.spinner, true)
  await open()
  await open()
  assert.equal(opens, 1, "smashing the key spawns one opener")
  finish("/home/me/repo-perf/")
  await first
  assert.equal(store.toast?.text, "Opened repo-perf")
  await open()
  assert.equal(opens, 1, "the window is still coming up: held for the cooldown")
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
