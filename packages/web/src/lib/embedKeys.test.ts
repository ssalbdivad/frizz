import assert from "node:assert/strict"
import test from "node:test"
import { chordCommand } from "../../../vscode/src/embed.ts"
import { HOST_CHORDS, SIDEBAR_KEY_HINTS, hostChordEvent, hostChordKeycaps } from "./embedKeys.ts"
import { ACTIONS } from "./keybindings.ts"

// The sidebar's half of the keyboard (lib/embedKeys.ts). The shortcuts sheet tells the human which chords
// go to VS Code from the sidebar; the EXTENSION decides which do (packages/vscode/src/embed.ts CHORDS). So
// every chord the sheet lists is run through the extension's own matcher, on both platforms — a chord
// dropped from its allowlist, or rebound there, fails here instead of being promised in the sheet.

test("every VS Code chord the sheet lists is one the extension runs, on a Mac and elsewhere", () => {
  for (const chord of HOST_CHORDS) {
    for (const platform of ["mac", "other"] as const) {
      assert.ok(chordCommand({ ...hostChordEvent(chord, platform), alt: false }, platform === "mac"), `${chord.label} on ${platform}`)
    }
  }
  // …and the matcher is the real thing: a chord it does not list maps to nothing (negative control).
  assert.equal(chordCommand({ code: "KeyW", ctrl: true, meta: false, shift: false, alt: false }, false), undefined)
})

test("caps in each platform's order", () => {
  const palette = HOST_CHORDS.find((chord) => chord.label === "Command palette")!
  assert.deepEqual(hostChordKeycaps(palette, "mac"), ["⇧", "⌘", "P"])
  assert.deepEqual(hostChordKeycaps(palette, "other"), ["Ctrl", "Shift", "P"])
  // Ctrl on a Mac too, as VS Code binds it.
  const terminal = HOST_CHORDS.find((chord) => chord.label === "Toggle the terminal")!
  assert.deepEqual(hostChordKeycaps(terminal, "mac"), ["⌃", "`"])
  const scm = HOST_CHORDS.find((chord) => chord.label === "Source control")!
  assert.deepEqual(hostChordKeycaps(scm, "mac"), ["⌃", "⇧", "G"])
  assert.deepEqual(hostChordKeycaps(scm, "other"), ["Ctrl", "Shift", "G"])
})

test("the sheet's sidebar hints name real shortcuts, in a few words", () => {
  const ids = new Set(ACTIONS.map((action) => action.id))
  for (const [id, hint] of Object.entries(SIDEBAR_KEY_HINTS)) {
    assert.ok(ids.has(id as never), id)
    assert.ok(hint.split(" ").length <= 6, `${id}: "${hint}" is not a few words`)
    assert.match(hint, /^[A-Z][^A-Z]*$/u, `${id}: sentence case`)
  }
})
