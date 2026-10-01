import assert from "node:assert/strict"
import test from "node:test"
import type { Settings } from "@frizz/shared"
import { adoptPublishedSettings } from "./useSettingsAutosave.tsx"

const base = {
  localFileOpener: "system",
  notifications: false,
  homeFolder: "/home/me",
  effort: "high",
  githubPrompt: "be terse",
} as unknown as Settings

const with_ = (over: Record<string, unknown>) => ({ ...base, ...over }) as unknown as Settings

// The editor offer's "Use VS Code" writes the External app while a Settings drawer may be open over a
// draft seeded with System; the drawer's next save of ANY field carried the whole draft and wrote System
// back (review C6). The drawer adopts what the cache now says for a machine key it has not touched.
test("an open draft adopts a machine setting another surface wrote", () => {
  const after = with_({ localFileOpener: "vscode" })
  assert.equal(adoptPublishedSettings(base, base, after).localFileOpener, "vscode")
  // Whatever else the draft holds is kept: an unsaved edit elsewhere in it stays.
  const edited = with_({ githubPrompt: "typing…" })
  assert.deepEqual(adoptPublishedSettings(edited, base, after), with_({ githubPrompt: "typing…", localFileOpener: "vscode" }))
  // Every machine key, not only the one the offer writes: the project rail's notifications toggle too.
  assert.deepEqual(adoptPublishedSettings(base, base, with_({ notifications: true, homeFolder: "/srv" })), with_({ notifications: true, homeFolder: "/srv" }))
})

test("a value the human chose in the draft is theirs, and nothing changed adopts nothing", () => {
  // The draft already moved this key off what the cache held: its own write is the next word on it.
  const mine = with_({ localFileOpener: "cursor" })
  assert.equal(adoptPublishedSettings(mine, base, with_({ localFileOpener: "vscode" })).localFileOpener, "cursor")
  // The cache moved nothing: the very same draft object comes back, so a state update is a no-op.
  assert.equal(adoptPublishedSettings(mine, base, { ...base }), mine)
  // A project's own key moves in the cache when the PAGE's project does; it is never poured in.
  const otherProject = with_({ effort: "low", githubPrompt: "another project's" })
  assert.equal(adoptPublishedSettings(base, base, otherProject), base)
})
