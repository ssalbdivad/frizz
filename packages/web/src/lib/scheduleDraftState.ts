import { useCallback, useMemo, useSyncExternalStore } from "react"
import { draftKey, draftStore, useDraft, type DraftStore } from "./drafts.ts"
import { carryDraft } from "./stagedContext.ts"

// WHAT THE HUMAN SAID ABOUT THE DRAFT'S SCHEDULE IS PART OF THE DRAFT (plans/schedule-live-reading.md).
//
// The box reads its words for a schedule as they are typed, and Enter creates what it reads. The human can say
// "not a schedule" — × on the strip, Esc in the box, or Undo of the schedule just created — and from then Enter
// starts the thread, until the model reads a different phrase out of the words. That dismissal is as much the
// draft as the text is, so it is kept where the text is kept, under its own sibling key
// (`draftKey.dispatchSchedule`, the `dispatchProfile` precedent), and it lives and dies with it:
//
//   - it SURVIVES A REMOUNT and a SAME-TAB RELOAD, as the draft does (sessionStorage, never past the tab). Plain
//     component state did not: on 2026-10-05 a headless screenshot's viewport override remounted a box, and
//     what Enter meant for its text came back different from what the screen had said;
//   - every box on the key READS ONE VALUE, through `useDraft`'s subscription — the `c` dialog and the page box
//     under it edit one draft, and an Esc in one is an Esc in both;
//   - it is CLEARED IN THE SAME COMMIT AS THE PROMPT (`clearDispatchDraft`) and CARRIED WITH IT to another
//     project (`carryDispatchDraft`), so no box ever shows the text with another draft's dismissal.
//
// The model's readings are NOT kept here: they are re-derivable from the text, and the read cache holds them.
//
// Before 2026-10-06 the record (v1) held a schedule MODE and per-edge dismissals of a local grammar's offers.
// Both are gone with the grammar; a v1 record reads as nothing dismissed.

export type ScheduleDraftState = {
  v: 2
  /** The phrase the human said is not a schedule, as the model read it. */
  dismissed?: string
  /** Dismissed by Undo of the schedule just created: the box says so, with a way to schedule it after all. */
  undone?: true
  /** Said over a reading of EARLIER words (the strip was updating): it holds for the words on screen, and takes
   *  their reading's phrase once it lands (lib/scheduleIntent.ts `dismissedPhrase`). */
  pending?: true
}

export const SCHEDULE_DRAFT_NONE: ScheduleDraftState = Object.freeze({ v: 2 }) as ScheduleDraftState

/** A record that does not parse dismisses nothing: the worst it costs is the strip showing again. */
export function parseScheduleDraftState(raw: string): ScheduleDraftState {
  if (!raw) return SCHEDULE_DRAFT_NONE
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== "object" || (value as { v?: unknown }).v !== 2) return SCHEDULE_DRAFT_NONE
    const { dismissed, undone, pending } = value as { dismissed?: unknown; undone?: unknown; pending?: unknown }
    if (typeof dismissed !== "string" || !dismissed.trim()) return SCHEDULE_DRAFT_NONE
    return { v: 2, dismissed, ...(undone === true ? { undone: true as const } : {}), ...(pending === true ? { pending: true as const } : {}) }
  } catch {
    return SCHEDULE_DRAFT_NONE
  }
}

/** Nothing dismissed is the ABSENT key, so a box that never dismissed anything writes nothing and the draft
 *  store's bounded snapshot carries nothing for it. */
export function serializeScheduleDraftState(state: ScheduleDraftState): string {
  if (!state.dismissed?.trim()) return ""
  return JSON.stringify({ v: 2, dismissed: state.dismissed, ...(state.undone ? { undone: true } : {}), ...(state.pending ? { pending: true } : {}) })
}

export function readScheduleDraftState(key: string, store: Pick<DraftStore, "get"> = draftStore): ScheduleDraftState {
  return parseScheduleDraftState(store.get(key))
}

export type ScheduleDraftUpdate = ScheduleDraftState | ((prev: ScheduleDraftState) => ScheduleDraftState)

export function writeScheduleDraftState(key: string, next: ScheduleDraftUpdate, store: Pick<DraftStore, "get" | "set"> = draftStore): void {
  // The functional form reads the STORE at call time, not the value a render captured, so two writes in one
  // handler compose instead of the second undoing the first.
  const resolved = typeof next === "function" ? next(readScheduleDraftState(key, store)) : next
  store.set(key, serializeScheduleDraftState(resolved))
}

/** One box's view of the draft's dismissal, keyed by `draftKey.dispatchSchedule(projectDir)`. */
export function useScheduleDraftState(key: string): readonly [ScheduleDraftState, (next: ScheduleDraftUpdate) => void] {
  const [raw] = useDraft(key)
  const state = useMemo(() => parseScheduleDraftState(raw), [raw])
  const set = useCallback((next: ScheduleDraftUpdate) => writeScheduleDraftState(key, next), [key])
  return [state, set] as const
}

/** Every key a new thread's draft spans: its prompt, its schedule dismissal, its profile pick and its time
 *  limit. `keepPick` keeps the limit with the pick: both are settings of the thread about to start. */
export function dispatchDraftKeys(projectDir: string | undefined, { keepPick = false }: { keepPick?: boolean } = {}): string[] {
  return [
    draftKey.dispatch(projectDir),
    draftKey.dispatchSchedule(projectDir),
    ...(keepPick ? [] : [draftKey.dispatchProfile(projectDir), draftKey.dispatchDeadline(projectDir)]),
  ]
}

/**
 * Clear a new thread's draft — the prompt, its schedule dismissal and its profile pick — in ONE synchronous
 * commit with ONE notify. Every path that consumes the draft (a dispatch, a lazy save, a created schedule)
 * goes through here, so a dismissal never outlives the text it was said about.
 *
 * `keepPick`: the `/login` / `/logout` alias consumes the TEXT as an account action, not the draft's
 * thread — the pick is the profile the human is about to sign in to and then dispatch on, so it stays.
 * (Staged context chips live in their own store; callers take them with `takeContextItems`.)
 */
export function clearDispatchDraft(
  projectDir: string | undefined,
  opts: { keepPick?: boolean } = {},
  store: Pick<DraftStore, "clearMany"> = draftStore,
): void {
  store.clearMany(dispatchDraftKeys(projectDir, opts))
}

/**
 * The new-thread box RE-AIMED at another project (All projects: its picker, ⌥↑/⌥↓): the text goes with the
 * choice, its staged chips with the text — and its dismissal with the text, landing in the commit the text lands
 * in and replacing whatever the target held. Only into an empty box (`carryDraft`), so a draft already waiting
 * in the target keeps its own. (The profile pick was never carried, and still is not.)
 */
export function carryDispatchDraft(fromDir: string | undefined, toDir: string | undefined): void {
  if (!fromDir || !toDir || fromDir === toDir) return
  // A create in flight owns these words (see `beginDraftCreate`): they stay where it will take them from.
  if (isDraftCreating(draftKey.dispatchSchedule(fromDir))) return
  carryDraft(draftKey.dispatch(fromDir), draftKey.dispatch(toDir), [[draftKey.dispatchSchedule(fromDir), draftKey.dispatchSchedule(toDir)]])
}

// ---- a create in flight owns its draft -----------------------------------------------------------------------
//
// From the Enter that sends `createSchedule` to the moment its words leave the box (the RPC, then the mark's
// 220ms wash), the draft IS the schedule being made. Two things went wrong in that window, both driven on the
// fixture: the box re-aimed at another project carried the words away, the create then cleared the OLD key,
// already empty, and the same schedule sat one Enter from being created again over there (reaim-during-wash);
// and Undo of the previous schedule merged its words ABOVE the ones being created, so the create no longer found
// its own words at the start of the box and left them there (undo-during-next-create). So, per draft — the
// dismissal's key, which every box on the draft shares, and which outlives the box that pressed Enter (the `c`
// dialog closes on create, the All-projects box remounts on a re-aim):
//   - the draft does not MOVE while a create on it is in flight (`carryDispatchDraft` declines; the re-aimed
//     box opens on the other project's own draft, and the words leave with their create);
//   - Undo puts its words back only after every create on the draft has landed (`afterDraftCreates`), so the
//     words being created are gone first and only the undone ones come back;
//   - every box on the draft reads it as creating (`useDraftCreating`): a box remounted mid-create is not one
//     Enter from creating the same words a second time.
// Kept for the tab, like the draft store's own snapshot; a reload mid-create forgets it, and the create's
// words are then the draft's as they were.

const inFlight = new Map<string, number>()
const settledWaiters = new Map<string, Array<() => void>>()
const creatingListeners = new Set<() => void>()

/** A create on this draft (its dismissal's key) is in flight. Returns the call that says it landed or failed —
 *  safe to call twice: only the first releases the hold. */
export function beginDraftCreate(key: string): () => void {
  inFlight.set(key, (inFlight.get(key) ?? 0) + 1)
  for (const l of [...creatingListeners]) l()
  let ended = false
  return () => {
    if (ended) return
    ended = true
    const left = (inFlight.get(key) ?? 1) - 1
    if (left > 0) inFlight.set(key, left)
    else {
      inFlight.delete(key)
      const waiters = settledWaiters.get(key) ?? []
      settledWaiters.delete(key)
      for (const w of waiters) w()
    }
    for (const l of [...creatingListeners]) l()
  }
}

export function isDraftCreating(key: string): boolean {
  return inFlight.has(key)
}

/** Resolves once no create on this draft is in flight — at once when none is. */
export function afterDraftCreates(key: string): Promise<void> {
  if (!inFlight.has(key)) return Promise.resolve()
  return new Promise((resolve) => {
    const list = settledWaiters.get(key) ?? []
    list.push(resolve)
    settledWaiters.set(key, list)
  })
}

/** Whether a create on this draft is in flight, from any box. */
export function useDraftCreating(key: string): boolean {
  const subscribe = useCallback((listener: () => void) => {
    creatingListeners.add(listener)
    return () => { creatingListeners.delete(listener) }
  }, [])
  const read = useCallback(() => inFlight.has(key), [key])
  return useSyncExternalStore(subscribe, read, read)
}

// ---- one held Enter per draft ----------------------------------------------------------------------------------
//
// An Enter on words not read yet HOLDS until their answer lands (lib/scheduleIntent.ts `submitStep`). The hold was
// each box's own, and the page box and the `c` dialog over it are two boxes on one draft: the page box held, the
// dialog's Enter held too, and the one answer landed in both in the same effect pass — two identical schedules,
// or two threads, for one human submit (fix round 2026-10-06, A; 2 of 2 cases). The hold is the DRAFT's: the
// newest Enter takes it, the box that held it before lets go, and acting on the draft (a dispatch, a create)
// releases it for every box. Kept for the tab, like the creates above.

const holds = new Map<string, symbol>()
const holdListeners = new Set<() => void>()
const holdsChanged = () => { for (const l of [...holdListeners]) l() }

/** `owner`'s Enter is held on this draft now; whichever box held it before no longer does. */
export function claimDraftHold(key: string, owner: symbol): void {
  if (holds.get(key) === owner) return
  holds.set(key, owner)
  holdsChanged()
}

/** `owner` lets go of its hold on this draft — or, with no owner, the draft was acted on and no hold on it stands. */
export function releaseDraftHold(key: string, owner?: symbol): void {
  if (!holds.has(key) || (owner !== undefined && holds.get(key) !== owner)) return
  holds.delete(key)
  holdsChanged()
}

/** The box whose Enter is held on this draft, if any. */
export function draftHolder(key: string): symbol | undefined {
  return holds.get(key)
}

export function subscribeDraftHolds(listener: () => void): () => void {
  holdListeners.add(listener)
  return () => { holdListeners.delete(listener) }
}

/** `draftHolder`, re-rendering when it changes. */
export function useDraftHolder(key: string): symbol | undefined {
  const read = useCallback(() => holds.get(key), [key])
  return useSyncExternalStore(subscribeDraftHolds, read, read)
}
