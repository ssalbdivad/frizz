import { useSyncExternalStore } from "react"
import type { ProjectCard } from "@frizz/shared"

// THE CROSS-PROJECT PAGE'S FOCUS — which project `/` is aimed at.
//
// The cross-project page is always focused on one project: the one its prompt box dispatches into, and
// the page project for every "which project" question (see base-path.ts). The address does not name it
// — where a new thread goes is the box's setting, like its model (maintainer 2026-09-28) — so `/` reads
// it from here: the project the operator last chose in this browser, and failing that the one opened
// most recently on the machine, which is the project a `frizz` run in a repo has just opened, so a fresh
// launch lands where the operator is standing.
//
// Remembered by ID, not slug: a rename changes the slug, and a remembered slug that no longer resolves
// would quietly fall back to another project.

const FOCUS_KEY = "frizz.crossProjectFocus"

// THE PICK, as opposed to the focus. The focus moves whenever a thread of another project is opened (its
// drawer needs that project bound, and its address names it: `/all/<slug>/thread/<t>`), but the operator
// did not CHOOSE that project for their next thread by reading one of its threads. So `/` is focused on
// the last project they did choose — in the prompt box's picker, or by arriving with `?focus=` — and
// closing the last drawer, which goes home, is going back to it.
let pick: string | null = null
let loaded = false
const listeners = new Set<() => void>()

export function rememberCrossProjectFocus(projectId: string): void {
  if (pick === projectId && loaded) return
  pick = projectId
  loaded = true
  try {
    localStorage.setItem(FOCUS_KEY, projectId)
  } catch {
    // Storage disabled or full: the page still works, it just forgets where it was.
  }
  for (const listener of listeners) listener()
}

export function rememberedCrossProjectFocus(): string | null {
  if (!loaded) {
    loaded = true
    try {
      pick = localStorage.getItem(FOCUS_KEY)
    } catch {
      pick = null
    }
  }
  return pick
}

export function subscribeCrossProjectFocus(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The project the operator last CHOSE on the cross-project page, by id — live across the page. */
export function useCrossProjectPick(): string | null {
  return useSyncExternalStore(subscribeCrossProjectFocus, rememberedCrossProjectFocus, () => null)
}

/**
 * Where ⌥↓ (`step` 1) or ⌥↑ (-1) in the prompt box sends the next thread: the project below or above the
 * focus in the picker's own list (AllQueues.tsx ProjectPicker — every project whose directory still
 * exists, in the rail's order), wrapping round at either end.
 *
 * Only a project this server has OPEN: the key carries the draft into the box it lands on, and a project
 * that is not open never shows one (the landing's own rule, below). Undefined when no other project
 * qualifies, so the key keeps its ordinary meaning.
 */
export function stepPick<P extends { slug: string; open: boolean; stale: boolean }>(projects: readonly P[], focus: string | undefined, step: 1 | -1): P | undefined {
  const choices = projects.filter((project) => !project.stale)
  const at = choices.findIndex((project) => project.slug === focus)
  // A focus the list does not hold sits just outside it, so either direction starts at an end.
  const from = at !== -1 ? at : step === 1 ? -1 : choices.length
  for (let distance = 1; distance <= choices.length; distance++) {
    const candidate = choices[(((from + step * distance) % choices.length) + choices.length) % choices.length]
    if (candidate.open && candidate.slug !== focus) return candidate
  }
  return undefined
}

/**
 * The project `/` focuses: the remembered one if it is still registered and its directory still exists,
 * else the most recently opened such project, else none (no usable project — `/` then shows the welcome
 * page, where one is added).
 *
 * `openIds`, when known, narrows that to projects whose board this server has open: a project another
 * Frizz serves, or one that failed to open, can be focused but never takes a thread, and landing on it
 * showed a prompt box that never arrived. It only narrows — with none open (a boot still opening them)
 * the page lands as it would without the list.
 */
export function defaultCrossProjectFocus(
  cards: readonly Pick<ProjectCard, "id" | "slug" | "stale" | "lastOpenedAt" | "home">[],
  rememberedId: string | null,
  openIds?: ReadonlySet<string>,
): string | undefined {
  const present = cards.filter((card) => !card.stale)
  const open = openIds ? present.filter((card) => openIds.has(card.id)) : present
  const usable = open.length > 0 ? open : present
  const remembered = rememberedId ? usable.find((card) => card.id === rememberedId) : undefined
  if (remembered) return remembered.slug
  // The Home workspace is focused only when CHOSEN. It exists on every machine, so falling back to it
  // would mean an empty machine never shows the welcome page that adds its first project — and nobody
  // "last opened" it in a terminal, which is what the fallback is reading.
  let latest: (typeof usable)[number] | undefined
  for (const card of usable) {
    if (card.home) continue
    if (!latest || Date.parse(card.lastOpenedAt || "") > Date.parse(latest.lastOpenedAt || "")) latest = card
  }
  return latest?.slug
}

// THE QUEUE FILTER — which project's cards the page's RIGHT side shows, by id; `null` is every project.
//
// It filters the queue and NOTHING ELSE (maintainer 2026-09-28: "have project filters only affect which
// threads are displayed on the right side and have the ui reflect that"). The project list on the left
// keeps every project whatever it is set to, and the prompt box keeps its own pick above — so the
// control that sets it sits over the queue it filters (the READY header), not in the column beside it.
// There is no other way to look at one project: the project view it replaced is gone, and every one of
// its addresses lands here with this set (routes.tsx LegacyProjectRedirect).
//
// Per TAB (sessionStorage): a filter is how this window is being read right now. It survives a reload —
// which a dev server hands out constantly — but a new tab, or a fresh launch, opens on everything.
// Remembered by id, like the pick, so a rename does not quietly clear it.

const FILTER_KEY = "frizz.queueFilter"
let filter: string | null = null
let filterLoaded = false
const filterListeners = new Set<() => void>()

/** The project the queue is filtered to, by id, or `null` for every project. */
export function queueFilter(): string | null {
  if (!filterLoaded) {
    filterLoaded = true
    try {
      filter = sessionStorage.getItem(FILTER_KEY)
    } catch {
      filter = null
    }
  }
  return filter
}

/** Filter the queue to one project, by id — or `null` to show every project's cards again. */
export function setQueueFilter(projectId: string | null): void {
  if (queueFilter() === projectId) return
  filter = projectId
  try {
    if (projectId) sessionStorage.setItem(FILTER_KEY, projectId)
    else sessionStorage.removeItem(FILTER_KEY)
  } catch {
    // Storage disabled: the filter still holds for this page, it just does not survive a reload.
  }
  for (const listener of filterListeners) listener()
}

function subscribeQueueFilter(listener: () => void): () => void {
  filterListeners.add(listener)
  return () => filterListeners.delete(listener)
}

/** The queue filter, live: the project id the right side shows, or `null` for every project. */
export function useQueueFilter(): string | null {
  return useSyncExternalStore(subscribeQueueFilter, queueFilter, () => null)
}

// HOW MUCH OF EACH PROJECT THE LIST SHOWS — the left side's own folds, independent of the filter. Two of
// them, one inside the other (maintainer 2026-09-28: "the collapse button associated with each project
// should actually collapse all threads associated with that project, including open threads. There needs
// to be perhaps a sub button that expands or collapses other categories like done or snoozed … But again,
// we need a primary collapse button that would easily allow you to visually filter which projects you're
// looking at"):
//
//   COLLAPSED — the primary fold: the project is its one row and nothing under it, not even its work in
//               flight. Every project starts open, so this set names the ones folded away.
//   DRILLED   — the rest of a project: its Snoozed, Done and External bands, under its work in flight.
//               Every project starts without them, so this set names the ones showing them.
//
// Per BROWSER (localStorage), like the rail's own band folds: which projects you keep open is how you
// arrange your desk, not how you are reading one window.

/** A set of project ids kept in localStorage, read once and live after that. */
function persistedProjectSet(key: string) {
  let ids: ReadonlySet<string> | null = null
  const listeners = new Set<() => void>()
  const read = (): ReadonlySet<string> => {
    if (!ids) {
      let stored: unknown = []
      try {
        stored = JSON.parse(localStorage.getItem(key) ?? "[]")
      } catch {
        stored = []
      }
      ids = new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [])
    }
    return ids
  }
  const set = (projectId: string, on = !read().has(projectId)): void => {
    const current = read()
    if (current.has(projectId) === on) return
    const next = new Set(current)
    if (on) next.add(projectId)
    else next.delete(projectId)
    ids = next
    try {
      localStorage.setItem(key, JSON.stringify([...next]))
    } catch {
      // Storage disabled or full: the list still folds, it just forgets on reload.
    }
    for (const listener of listeners) listener()
  }
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  return { read, set, subscribe }
}

const NONE: ReadonlySet<string> = new Set()
const collapsed = persistedProjectSet("frizz.collapsedProjects")
// The drill kept the key it had when it was the list's only fold, so a project opened then is open now.
const drilled = persistedProjectSet("frizz.expandedProjects")

/** Fold one project away in the list, or back open; `on` omitted toggles it. */
export function setProjectCollapsed(projectId: string, on?: boolean): void {
  collapsed.set(projectId, on)
}

/** The projects folded away in the list, by id — live, and a stable Set between changes. */
export function useCollapsedProjects(): ReadonlySet<string> {
  return useSyncExternalStore(collapsed.subscribe, collapsed.read, () => NONE)
}

/** Show or hide the rest of one project — its Snoozed, Done and External; `on` omitted toggles it. */
export function setProjectDrilled(projectId: string, on?: boolean): void {
  drilled.set(projectId, on)
}

/** The projects showing the rest of themselves in the list, by id — live, and stable between changes. */
export function useDrilledProjects(): ReadonlySet<string> {
  return useSyncExternalStore(drilled.subscribe, drilled.read, () => NONE)
}
