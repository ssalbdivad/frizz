// THE LIST NEVER SWAPS A ROW OUT FROM UNDER THE POINTER (maintainer 2026-09-30: "very important we avoid
// unintuitive scenarios like this and randomly aggressively hiding or swapping threads"). A parked thread
// flickered out of Snoozed and back while the operator was aiming at it; they clicked where it had been,
// opened a DIFFERENT thread, and the message meant for the first one closed a PR on the second. The queue
// already had this guarantee for its cards (lib/stableQueue.ts); this is the project list's half.
//
// WHILE THE LIST IS HELD (lib/listHold.ts says when: the pointer is over it, or a click in it is still in
// flight), ITS LAYOUT IS THE ONE LAST DRAWN. Every row keeps its band and its place; what it SAYS stays
// live — the caller draws each slot from the thread as it is now, so a spinner stops, a status changes, a
// rest time ticks, all in the row the human is pointing at. When the hold ends, the live layout is drawn.
//
//   - A thread that LEAVES its band on its own (woke itself, parked itself, finished, was answered from
//     another tab) is still drawn where it was, as itself, `held`. Not a ghost gap, as the queue draws: a
//     gap in a list of one-line rows is a hole the pointer falls through onto the row beyond, and the row
//     that was there is exactly what the human was aiming at — a click on it still opens THAT thread.
//   - A thread that ARRIVES new is appended at its band's END at once. It used to wait for the hold to
//     end, so nothing below it moved — but a thread that was in no band drawn was then on no band at all
//     (maintainer 2026-10-06: "it should never be the case that a thread should be totally invisible for
//     any circumstances"; then chose appending, accepting the shift below it). A thread that MOVED bands
//     is already drawn, so it stays in its old place, once, until the hold ends.
//   - A thread the HUMAN moved (`moved`: pinned, reopened, replied to, finished, dispatched — anything this
//     tab did to it, lib/humanActs.ts) goes where the live layout puts it at once. That motion is theirs;
//     holding it would read as the click not landing. Its old slot closes and it is placed after its
//     nearest live predecessor that is drawn in the same section, else at the section's top.
//
// Not held: the live layout drawn fresh (`frozen` false, or nothing drawn before). The sections themselves
// are the caller's fixed vocabulary — a project's bands, or the list's runs of projects — so their order
// is the one last drawn, and a section only the live layout has follows them.
//
// A key the live layout lists twice (a cached board a beat behind the poll can list one thread as Snoozed
// and Done) is drawn once, in the first section that lists it, which the caller orders fresher-first.

export interface HeldSlot<T> {
  key: string
  item: T
  /** Drawn where the live layout no longer puts it — it moved or left on its own while held. */
  held: boolean
}

export interface HeldSection<T> {
  id: string
  slots: HeldSlot<T>[]
}

export interface LiveSection<T> {
  id: string
  items: readonly T[]
}

export interface HoldLayoutInput<T> {
  /** What the last render drew, as this returned it. Empty on a first draw. */
  prev: readonly HeldSection<T>[]
  /** The layout as it is now. */
  target: readonly LiveSection<T>[]
  keyOf: (item: T) => string
  /** Whether the layout is held (lib/listHold.ts). False draws `target` as it is. */
  frozen: boolean
  /** A thread the human moved from this tab: it goes where `target` puts it, held or not. */
  moved: (key: string) => boolean
  /** The thread as it is now, for one `target` no longer lists anywhere (it went Done, say). Else as last drawn. */
  live?: (key: string) => T | undefined
}

export function holdLayout<T>({ prev, target, keyOf, frozen, moved, live }: HoldLayoutInput<T>): HeldSection<T>[] {
  // Where the live layout puts each key: its section and the item, first listing wins.
  const now = new Map<string, { section: string; item: T }>()
  const fresh: HeldSection<T>[] = []
  for (const section of target) {
    const slots: HeldSlot<T>[] = []
    for (const item of section.items) {
      const key = keyOf(item)
      if (now.has(key)) continue
      now.set(key, { section: section.id, item })
      slots.push({ key, item, held: false })
    }
    fresh.push({ id: section.id, slots })
  }
  if (!frozen || prev.length === 0) return fresh

  // Every section as last drawn, in its place — minus the threads the human moved — then any section only
  // the live layout has.
  const out: HeldSection<T>[] = prev.map((section) => ({
    id: section.id,
    slots: section.slots.flatMap((slot): HeldSlot<T>[] => {
      if (moved(slot.key)) return []
      const at = now.get(slot.key)
      if (at) return [{ key: slot.key, item: at.item, held: at.section !== section.id }]
      return [{ key: slot.key, item: live?.(slot.key) ?? slot.item, held: true }]
    }),
  }))
  for (const section of target) if (!out.some((drawn) => drawn.id === section.id)) out.push({ id: section.id, slots: [] })

  // The human's moves land where the live layout puts them.
  for (const section of target) {
    const into = out.find((drawn) => drawn.id === section.id)!
    const keys = section.items.map(keyOf)
    keys.forEach((key, index) => {
      const at = now.get(key)
      if (!at || at.section !== section.id || !moved(key)) return
      let after = -1
      for (let i = index - 1; i >= 0 && after < 0; i--) after = into.slots.findIndex((slot) => slot.key === keys[i])
      into.slots.splice(after + 1, 0, { key, item: at.item, held: false })
    })
  }

  // Every other arrival goes at its band's END: nothing above it moves, and no thread is ever off the list.
  const drawnKeys = new Set(out.flatMap((section) => section.slots.map((slot) => slot.key)))
  for (const section of target) {
    const into = out.find((drawn) => drawn.id === section.id)!
    for (const item of section.items) {
      const key = keyOf(item)
      if (drawnKeys.has(key) || now.get(key)?.section !== section.id) continue
      drawnKeys.add(key)
      into.slots.push({ key, item, held: false })
    }
  }
  return out
}

