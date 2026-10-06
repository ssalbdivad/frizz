import { useCallback, useMemo, useSyncExternalStore } from "react"
import { draftKey, draftStore, useDraft, type DraftStore } from "./drafts.ts"
import { carryDraft } from "./stagedContext.ts"

// THE SCHEDULE MODE IS PART OF THE DRAFT (plans/schedule-live-reading.md §9 I-4).
//
// What Enter does with a new thread's text — start it now, or create the schedule the panel shows — is as
// much the draft as the text is, so it is kept where the text is kept, under its own sibling key
// (`draftKey.dispatchSchedule`, the `dispatchProfile` precedent), and it lives and dies with it:
//
//   - it SURVIVES A REMOUNT. The box is remounted by things the human never sees — a layout pass across
//     the phone breakpoint, a viewport change. Plain component state did not survive that, the draft did:
//     on 2026-10-05 a headless screenshot's viewport override remounted a box in schedule mode, the text
//     came back with the mode gone, and the next Enter STARTED a real worker from text that was being set
//     up as a schedule. A module-level map (ScheduleComposer's `kept`, the first fix) closed the remount
//     but not a reload, and it was per box — the `c` dialog and the page box beneath it, which edit ONE
//     draft, could disagree about what Enter does with it;
//   - it SURVIVES A SAME-TAB RELOAD, as the draft does (sessionStorage, never past the tab);
//   - every box on the key READS ONE VALUE, through `useDraft`'s subscription, so a box that turns the mode
//     on turns it on in every other box editing the same text;
//   - it is CLEARED IN THE SAME COMMIT AS THE PROMPT (`clearDispatchDraft`), so no subscriber ever renders
//     the text without the mode it was typed in.
//
// A model's reading of the text is NOT kept here: it is re-derivable from the text, and a reload in the
// mode reads it again. `dismissed` is the per-edge "not a schedule" of the live offer (§8); nothing sets it
// yet, and it is in the record now so the record's shape does not change under the live reading.

export type ScheduleEdge = "open" | "close"
export type ScheduleDraftState = { v: 1; on: boolean; dismissed: { open?: true; close?: true } }

export const SCHEDULE_DRAFT_OFF: ScheduleDraftState = Object.freeze({ v: 1, on: false, dismissed: Object.freeze({}) }) as ScheduleDraftState

/** A record that does not parse is OFF: the send glyph then reads `↑`, so Enter's meaning on screen and
 *  Enter's act still agree (I-5). */
export function parseScheduleDraftState(raw: string): ScheduleDraftState {
  if (!raw) return SCHEDULE_DRAFT_OFF
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== "object" || (value as { v?: unknown }).v !== 1) return SCHEDULE_DRAFT_OFF
    const { on, dismissed } = value as { on?: unknown; dismissed?: unknown }
    const d = dismissed && typeof dismissed === "object" ? (dismissed as Record<string, unknown>) : {}
    return {
      v: 1,
      on: on === true,
      dismissed: { ...(d.open === true ? { open: true as const } : {}), ...(d.close === true ? { close: true as const } : {}) },
    }
  } catch {
    return SCHEDULE_DRAFT_OFF
  }
}

/** The resting state — off, nothing dismissed — is the ABSENT key, so a box that never touched the mode
 *  writes nothing and the draft store's bounded snapshot carries nothing for it. */
export function serializeScheduleDraftState(state: ScheduleDraftState): string {
  if (!state.on && !state.dismissed.open && !state.dismissed.close) return ""
  return JSON.stringify({ v: 1, on: state.on, dismissed: state.dismissed })
}

export function readScheduleDraftState(key: string, store: Pick<DraftStore, "get"> = draftStore): ScheduleDraftState {
  return parseScheduleDraftState(store.get(key))
}

export type ScheduleDraftUpdate = ScheduleDraftState | ((prev: ScheduleDraftState) => ScheduleDraftState)

export function writeScheduleDraftState(key: string, next: ScheduleDraftUpdate, store: Pick<DraftStore, "get" | "set"> = draftStore): void {
  // The functional form reads the STORE at call time, not the value a render captured: two writes in one
  // handler (leave the mode, then dismiss its edge) compose instead of the second undoing the first.
  const resolved = typeof next === "function" ? next(readScheduleDraftState(key, store)) : next
  store.set(key, serializeScheduleDraftState(resolved))
}

/** One box's view of the mode, keyed by `draftKey.dispatchSchedule(projectDir)`. */
export function useScheduleDraftState(key: string): readonly [ScheduleDraftState, (next: ScheduleDraftUpdate) => void] {
  const [raw] = useDraft(key)
  const state = useMemo(() => parseScheduleDraftState(raw), [raw])
  const set = useCallback((next: ScheduleDraftUpdate) => writeScheduleDraftState(key, next), [key])
  return [state, set] as const
}

/** Every key a new thread's draft spans: its prompt, its schedule mode and its profile pick. */
export function dispatchDraftKeys(projectDir: string | undefined, { keepPick = false }: { keepPick?: boolean } = {}): string[] {
  return [
    draftKey.dispatch(projectDir),
    draftKey.dispatchSchedule(projectDir),
    ...(keepPick ? [] : [draftKey.dispatchProfile(projectDir)]),
  ]
}

/**
 * Clear a new thread's draft — the prompt, its schedule mode and its profile pick — in ONE synchronous
 * commit with ONE notify. Every path that consumes the draft (a dispatch, a lazy save, a created schedule)
 * goes through here, so the mode can never outlive the text it was set on, nor the text the mode.
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
 * choice, its staged chips with the text — and its schedule MODE with the text, dismissals and all (I-4). The
 * mode stayed behind until fix round 2 (carry-drops-mode, driven on a real stack): Tab set the panel up, the
 * re-aim landed the text in the other project's box with the mode off, and Enter DISPATCHED it; the `{on:true}`
 * left under the old project then put the next text typed there straight into the mode. Now the mode lands in
 * the commit the text lands in, replacing whatever the target held, and leaves with it. Only into an empty box
 * (`carryDraft`), so a draft already waiting in the target keeps its own text and mode. (The profile pick was
 * never carried, and still is not: that is not this fix's question.)
 */
export function carryDispatchDraft(fromDir: string | undefined, toDir: string | undefined): void {
  if (!fromDir || !toDir || fromDir === toDir) return
  // A create in flight owns these words (see `beginDraftCreate`): they stay where it will take them from.
  if (isDraftCreating(draftKey.dispatchSchedule(fromDir))) return
  carryDraft(draftKey.dispatch(fromDir), draftKey.dispatch(toDir), [[draftKey.dispatchSchedule(fromDir), draftKey.dispatchSchedule(toDir)]])
}

// ---- a create in flight owns its draft (fix round 3) -------------------------------------------------------
//
// From the Enter that sends `createSchedule` to the moment its words leave the box (the RPC, then the mark's
// 220ms wash), the draft IS the schedule being made. Two things went wrong in that window, both driven on the
// fixture: the box re-aimed at another project carried the words and their {on:true} away, the create then
// cleared the old project's key — already empty — and the same schedule sat one Enter from being created
// again over there (reaim-during-wash); and Undo of the previous schedule merged its words ABOVE the ones
// being created, so the create no longer found its own words at the start of the box and left them there
// (undo-during-next-create). So, per draft — the mode's key, which every box on the draft shares, and which
// outlives the box that pressed Enter (the `c` dialog closes on create, the All-projects box remounts on a
// re-aim):
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

/** A create on this draft (its mode's key) is in flight. Returns the call that says it landed or failed —
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
