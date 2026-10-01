import assert from "node:assert/strict"
import test from "node:test"
import { parseStoredPrefs } from "./prefs.ts"

test("client preferences persist a validated snooze preset across reloads", () => {
  assert.equal(parseStoredPrefs(JSON.stringify({ compactDiffs: true, snoozePreset: "3d", diffsRedefaulted: true })).snoozePreset, "3d")
  assert.equal(parseStoredPrefs(JSON.stringify({ compactDiffs: true, snoozePreset: "tomorrow", diffsRedefaulted: true })).snoozePreset, "tomorrow")
})

test("missing, malformed, and stale snooze preferences fall back to tomorrow", () => {
  assert.equal(parseStoredPrefs(null).snoozePreset, "tomorrow")
  assert.equal(parseStoredPrefs("not-json").snoozePreset, "tomorrow")
  assert.equal(parseStoredPrefs(JSON.stringify({ snoozePreset: "custom", diffsRedefaulted: true })).snoozePreset, "tomorrow")
})

test("a stored 1d from before the tomorrow default is re-defaulted once, then sticks", () => {
  assert.equal(parseStoredPrefs(JSON.stringify({ snoozePreset: "1d", diffsRedefaulted: true })).snoozePreset, "tomorrow")
  assert.equal(parseStoredPrefs(JSON.stringify({ snoozePreset: "3d", diffsRedefaulted: true })).snoozePreset, "3d")
  assert.equal(parseStoredPrefs(JSON.stringify({ snoozePreset: "1d", diffsRedefaulted: true, snoozeRedefaulted: true })).snoozePreset, "1d")
})

test("queue order defaults to FIFO and only accepts fifo/lifo", () => {
  // Default (nothing stored / malformed) → fifo.
  assert.equal(parseStoredPrefs(null).queueOrder, "fifo")
  assert.equal(parseStoredPrefs("not-json").queueOrder, "fifo")
  // Both valid values round-trip; anything else falls back to fifo.
  assert.equal(parseStoredPrefs(JSON.stringify({ queueOrder: "lifo", diffsRedefaulted: true })).queueOrder, "lifo")
  assert.equal(parseStoredPrefs(JSON.stringify({ queueOrder: "fifo", diffsRedefaulted: true })).queueOrder, "fifo")
  assert.equal(parseStoredPrefs(JSON.stringify({ queueOrder: "sideways", diffsRedefaulted: true })).queueOrder, "fifo")
})

test("the rail's edited-files fold is open by default and only a boolean folds it", () => {
  assert.equal(parseStoredPrefs(null).railFilesCollapsed, false)
  assert.equal(parseStoredPrefs("not-json").railFilesCollapsed, false)
  assert.equal(parseStoredPrefs(JSON.stringify({ railFilesCollapsed: true, diffsRedefaulted: true })).railFilesCollapsed, true)
  assert.equal(parseStoredPrefs(JSON.stringify({ railFilesCollapsed: "yes", diffsRedefaulted: true })).railFilesCollapsed, false)
})

test("keyboard-shortcut overrides persist, and a bad entry falls back to its default alone", () => {
  assert.deepEqual(parseStoredPrefs(null).keybindings, {})
  assert.deepEqual(parseStoredPrefs("not-json").keybindings, {})
  assert.deepEqual(
    parseStoredPrefs(JSON.stringify({ keybindings: { "thread.snooze": "x", "thread.done": "mod+w", "nope": "x" }, diffsRedefaulted: true })).keybindings,
    { "thread.snooze": "x" },
  )
  assert.deepEqual(parseStoredPrefs(JSON.stringify({ keybindings: "garbage", diffsRedefaulted: true })).keybindings, {})
})

test("code files are automatic by default; a stored In Frizz from before is the old default, once", () => {
  assert.equal(parseStoredPrefs(null).codeFiles, "auto")
  assert.equal(parseStoredPrefs(JSON.stringify({ codeFiles: "editor", diffsRedefaulted: true })).codeFiles, "editor")
  assert.equal(parseStoredPrefs(JSON.stringify({ codeFiles: "cursor", diffsRedefaulted: true })).codeFiles, "auto")
  // Every pref write persists the whole blob, so a "frizz" stored before the default moved is the old
  // default riding along: re-defaulted once. After that (the marker is set), "In Frizz" is a choice.
  const old = parseStoredPrefs(JSON.stringify({ codeFiles: "frizz", diffsRedefaulted: true }))
  assert.equal(old.codeFiles, "auto")
  assert.equal(parseStoredPrefs(JSON.stringify(old)).codeFiles, "auto")
  const chosen = parseStoredPrefs(JSON.stringify({ ...old, codeFiles: "frizz" }))
  assert.equal(chosen.codeFiles, "frizz")
  assert.equal(parseStoredPrefs(JSON.stringify(chosen)).codeFiles, "frizz")
  // A fresh browser carries the marker from its first write, so its own later "In Frizz" sticks too.
  assert.equal(parseStoredPrefs(JSON.stringify({ ...parseStoredPrefs(null), codeFiles: "frizz" })).codeFiles, "frizz")
})
