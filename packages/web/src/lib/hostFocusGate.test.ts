import assert from "node:assert/strict"
import test from "node:test"
import { HOST_FOCUS_MS, hostFocusGate } from "./hostFocusGate.ts"

// lib/hostFocusGate.ts: when a page framed in an editor's sidebar may focus something without having focus.

test("a page with focus focuses freely; one without, only after the host asks", () => {
  const gate = hostFocusGate()
  assert.equal(gate.allows(0, true), true)
  assert.equal(gate.allows(0, false), false, "a focus thief with no ask is dropped")
  gate.ask(1_000, false)
  assert.equal(gate.allows(1_100, false), true, "the host's ask lets the page's own focus land after the relay's")
  assert.equal(gate.allows(1_000 + HOST_FOCUS_MS + 1, false), false, "and the ask expires")
})

test("the ask ends when the page, having had focus since, loses it — the human went back to the editor", () => {
  const gate = hostFocusGate()
  gate.ask(0, true)
  gate.blurred()
  assert.equal(gate.allows(100, false), false, "a re-render's focus() 100ms after the human left is a thief")
  // The same with focus arriving after the ask (the relay focuses the frame, then the page's window gains it).
  const late = hostFocusGate()
  late.ask(0, false)
  late.focused(20)
  late.blurred()
  assert.equal(late.allows(200, false), false)
})

test("a blur before the asked-for focus lands does not end the ask (the relay's focus dance on the way in)", () => {
  const gate = hostFocusGate()
  gate.ask(0, false)
  gate.blurred()
  assert.equal(gate.allows(50, false), true)
  // …and a focus after the ask expired does not reopen it.
  const old = hostFocusGate()
  old.ask(0, false)
  old.focused(HOST_FOCUS_MS + 10)
  assert.equal(old.allows(HOST_FOCUS_MS + 20, false), false)
})
