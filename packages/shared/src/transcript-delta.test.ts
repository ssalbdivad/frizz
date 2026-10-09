import { test } from "node:test"
import assert from "node:assert/strict"
import type { TranscriptMessage } from "./index.ts"
import { applyTranscriptPatch, diffTranscriptWindow, transcriptPatchOps } from "./transcript-delta.ts"

const msg = (text: string): TranscriptMessage => ({ role: "assistant", text, tools: [], parts: [] })
const idOf = (m: TranscriptMessage) => JSON.stringify(m)

// Diff two windows, ship the recipe, apply it to the old window: the result must be the new window.
function roundTrip(prev: TranscriptMessage[], next: TranscriptMessage[]) {
  const steps = diffTranscriptWindow(prev.map(idOf), next.map(idOf))
  const ops = transcriptPatchOps(steps, next)
  assert.deepEqual(applyTranscriptPatch(prev, ops), next)
  return { steps, ops }
}

const window = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => msg(`m${from + i}`))

test("an append is one keep and one put of only the new messages", () => {
  const { steps } = roundTrip(window(0, 5), window(0, 7))
  assert.deepEqual(steps, [{ keep: [0, 5] }, { put: [5, 2] }])
})

test("a slid window (head trimmed, tail appended) keeps the overlap from its new start", () => {
  const { steps } = roundTrip(window(0, 300), window(2, 302))
  assert.deepEqual(steps, [{ keep: [2, 298] }, { put: [298, 2] }])
})

test("an entry rewritten in place (a tool call gaining its result) is the only message put", () => {
  const prev = window(0, 6)
  const next = [...prev]
  next[3] = { ...prev[3], tools: [{ name: "Bash", status: "completed" }] }
  const { steps, ops } = roundTrip(prev, next)
  assert.deepEqual(steps, [{ keep: [0, 3] }, { put: [3, 1] }, { keep: [4, 2] }])
  assert.deepEqual(ops[1], { put: [next[3]] })
})

test("the streaming tail growing replaces only the last message", () => {
  const prev = window(0, 4)
  const next = [...prev.slice(0, 3), msg("m3 and more")]
  const { steps } = roundTrip(prev, next)
  assert.deepEqual(steps, [{ keep: [0, 3] }, { put: [3, 1] }])
})

test("a message inserted mid-window and one removed both round-trip", () => {
  roundTrip(window(0, 6), [...window(0, 2), msg("inserted"), ...window(2, 6)])
  roundTrip(window(0, 6), [...window(0, 2), ...window(3, 6)])
})

test("identical messages and reorders still reproduce the new window exactly", () => {
  const same = [msg("dup"), msg("dup"), msg("x"), msg("dup")]
  roundTrip(same, [msg("dup"), msg("x"), msg("dup"), msg("dup"), msg("dup")])
  roundTrip(window(0, 5), [...window(3, 5), ...window(0, 3)])
})

test("from or to an empty window", () => {
  assert.deepEqual(roundTrip([], window(0, 3)).steps, [{ put: [0, 3] }])
  assert.deepEqual(roundTrip(window(0, 3), []).steps, [])
})

test("a fold that rewrote every message is all put", () => {
  const prev = window(0, 4)
  const next = prev.map((m) => msg(`${m.text} (folded)`))
  assert.deepEqual(roundTrip(prev, next).steps, [{ put: [0, 4] }])
})

test("random edits always round-trip", () => {
  let seed = 7
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31
    return seed % n
  }
  for (let round = 0; round < 300; round++) {
    const prev = Array.from({ length: rand(20) }, () => msg(`v${rand(8)}`))
    const next = [...prev]
    for (let edits = rand(5); edits > 0; edits--) {
      const at = rand(next.length + 1)
      const kind = rand(3)
      if (kind === 0) next.splice(at, 0, msg(`new${rand(8)}`))
      else if (kind === 1 && next.length) next.splice(Math.min(at, next.length - 1), 1)
      else if (next.length) next[Math.min(at, next.length - 1)] = msg(`chg${rand(8)}`)
    }
    roundTrip(prev, next)
  }
})

test("apply refuses a recipe that reaches outside the window it is given", () => {
  const base = window(0, 3)
  assert.equal(applyTranscriptPatch(base, [{ keep: [2, 2] }]), undefined)
  assert.equal(applyTranscriptPatch(base, [{ keep: [-1, 1] }]), undefined)
  assert.equal(applyTranscriptPatch(base, [{ keep: [0.5, 1] }]), undefined)
  assert.equal(applyTranscriptPatch(base, [{ nope: true } as never]), undefined)
  const kept = applyTranscriptPatch(base, [{ keep: [1, 2] }])
  assert.equal(kept?.[0], base[1], "a kept message is the same object")
})
