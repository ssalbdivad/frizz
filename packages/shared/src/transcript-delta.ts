import type { TranscriptMessage } from "./index.ts"

// The transcript push's delta encoding — the /ws twin of the board's `board-delta` (delta.ts), shaped for
// what a transcript actually is: an ORDERED window, not a keyed set. Type-only import above, so this file
// has no runtime dependency on index.ts and cannot form an import cycle with it.
//
// Why it exists: every transcript change used to push the WHOLE latest window — up to MAX_MESSAGES
// rendered messages, up to 3 MB — because a snapshot was the only frame the channel had. A worker appends
// a few KB per step, so the push re-sent the same few hundred KB per step. Measured 2026-10-08 on a
// disposable stack (12 simulated broker threads appending ~4 KB tool results at 5 Hz, one socket
// subscribed to all 12, 180 s): 23.9 MB of JSONL appended, 1558 MB pushed, a 65x amplification. With
// deltas the same run pushed 37.0 MB (1.55x), nearly all of it the new messages themselves.
//
// A delta is a recipe over the window the client ALREADY holds: copy these runs of the old window, put
// these new messages in between. Every case a window changes in is one recipe:
//   · an append                     → keep [0, n), put [new…]
//   · the window sliding (head trim) → keep [k, n-k), put [new…]
//   · an entry rewritten in place    → keep the runs either side, put the one changed message
//     (a tool call gaining its result, a streaming row growing, a projection relabelling an old row)
//   · a fold that rewrote everything → mostly `put`, at which point the sender sends the snapshot instead.
// Each delta names the window it applies to (`base`) and the one it produces (`sig`), so a client whose
// copy is not the base can never apply it to the wrong window: it asks for a fresh snapshot instead.

/** One step of a window recipe, in index space: `from`/`count` index the OLD window for `keep`, the NEW one for `put`. */
export type TranscriptWindowStep = { keep: [from: number, count: number] } | { put: [from: number, count: number] }

/** One step on the wire: a run of the client's held window, or the new messages themselves. */
export type TranscriptPatchOp = { keep: [from: number, count: number] } | { put: TranscriptMessage[] }

/**
 * Recipe turning the window whose per-message identities are `prev` into the one whose identities are
 * `next`. Identities are opaque strings (the server uses a content hash); equal strings mean equal
 * messages. Runs are matched greedily, preferring the run that continues the previous one, so an
 * append or a slide is a single `keep` plus a single `put`.
 */
export function diffTranscriptWindow(prev: readonly string[], next: readonly string[]): TranscriptWindowStep[] {
  const positions = new Map<string, number[]>()
  prev.forEach((id, i) => {
    const at = positions.get(id)
    if (at) at.push(i)
    else positions.set(id, [i])
  })
  const steps: TranscriptWindowStep[] = []
  let expected = 0 // where the previous keep run ended in `prev`: a continuation there is preferred
  let i = 0
  while (i < next.length) {
    const at = positions.get(next[i])
    if (!at) {
      const start = i
      while (i < next.length && !positions.has(next[i])) i++
      steps.push({ put: [start, i - start] })
      continue
    }
    const from = at.find((p) => p >= expected) ?? at[0]
    let count = 1
    while (i + count < next.length && from + count < prev.length && prev[from + count] === next[i + count]) count++
    const last = steps[steps.length - 1]
    if (last && "keep" in last && last.keep[0] + last.keep[1] === from) last.keep[1] += count
    else steps.push({ keep: [from, count] })
    expected = from + count
    i += count
  }
  return steps
}

/** Materialize a recipe for the wire: `put` index runs become the messages themselves. */
export function transcriptPatchOps(
  steps: readonly TranscriptWindowStep[],
  next: readonly TranscriptMessage[],
): TranscriptPatchOp[] {
  return steps.map((step) => ("keep" in step ? { keep: [step.keep[0], step.keep[1]] } : { put: next.slice(step.put[0], step.put[0] + step.put[1]) }))
}

/**
 * Apply a wire recipe to the window it was cut against. Kept messages are the SAME objects as in `base`,
 * so a renderer that memoizes by identity re-renders only what the delta actually carried. Returns
 * undefined for a recipe that reaches outside `base` — a malformed frame, or one cut against another
 * window — so the caller resyncs rather than rendering a wrong transcript.
 */
export function applyTranscriptPatch(
  base: readonly TranscriptMessage[],
  ops: readonly TranscriptPatchOp[],
): TranscriptMessage[] | undefined {
  const out: TranscriptMessage[] = []
  for (const op of ops) {
    if ("keep" in op) {
      const [from, count] = op.keep
      if (!Number.isInteger(from) || !Number.isInteger(count) || from < 0 || count < 0 || from + count > base.length) return undefined
      for (let j = from; j < from + count; j++) out.push(base[j])
    } else if (Array.isArray(op.put)) {
      out.push(...op.put)
    } else {
      return undefined
    }
  }
  return out
}
