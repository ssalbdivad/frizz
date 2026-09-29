// THE PAGE'S VIEW — which projects the one page shows: ONE project (focus mode, the default) or every
// project (All projects, opt-in).
//
// Focus mode is the default because cross-project noise breaks flow: a project is meant to be
// self-contained, and a page that interleaves every project's queue asks the reader to keep switching
// context they did not choose to switch (Colin McDonnell, Frizz's original author, whose version had one
// project per page and an opt-in rail of the others). Focused on a project, the list shows that project,
// the queue shows its cards, and the prompt box dispatches into it. All projects is the unified view the
// page was from 2026-09-24 to 2026-09-29 — every project's list and one queue across all of them, with the
// prompt box's own project picker — kept as a choice in the switcher (AllQueues.tsx ProjectSwitcher).
//
// THE VIEW LIVES IN THE ADDRESS, so every tab, bookmark and launch keeps its own:
//
//   /?project=<slug>   focused on that project — the launcher opens this for the project it ran in
//   /?all              All projects
//   /                  no view named: this TAB's view if it has one, else the project last focused in this
//                      browser, else All projects — and the address is rewritten to say which (routes.tsx)
//
// A thread drawer's address (`/all/<slug>/thread/<t>`) names the thread, not the view, so under a drawer
// the view is the tab's (sessionStorage), or the drawer's own project for a tab that has none — a link to
// a thread opened in a new tab lands focused on that thread's project. The query rides along when it is
// there; nothing strips it.
//
// NEVER SHARED BETWEEN TABS. The one cross-tab reading is the last-focused project (localStorage), and it
// is read only by a tab with no view of its own, at a bare `/`. Two tabs focused on two projects stay on
// them across reloads, whatever the other does. That is the whole reason the view is not the prompt box's
// PICK (lib/crossProject.ts), which IS one per browser: the pick aims All projects' prompt box and nothing
// else.

import { useLocation } from "react-router"

export type PageView = { kind: "project"; slug: string } | { kind: "all" }

export const ALL_PROJECTS: PageView = { kind: "all" }

const PROJECT_PARAM = "project"
const ALL_PARAM = "all"
/**
 * The launcher's name for `project` until 2026-09-29, when it named the prompt box's pick rather than a
 * view. A launcher from before then that JOINS this server still sends it, and it still means "the project
 * I was run in", so it reads as `project`.
 */
const LEGACY_FOCUS_PARAM = "focus"

/** The view an address's query names, or undefined when it names none. */
export function viewInSearch(search: string): PageView | undefined {
  const params = new URLSearchParams(search)
  if (params.has(ALL_PARAM)) return ALL_PROJECTS
  const slug = params.get(PROJECT_PARAM) ?? params.get(LEGACY_FOCUS_PARAM)
  return slug ? { kind: "project", slug } : undefined
}

/** `?project=<slug>` or `?all` — the query that names a view. */
export function viewSearch(view: PageView): string {
  return view.kind === "all" ? `?${ALL_PARAM}` : `?${PROJECT_PARAM}=${encodeURIComponent(view.slug)}`
}

/** The page showing a view: `/?project=<slug>` or `/?all`. */
export function viewHref(view: PageView): string {
  return `/${viewSearch(view)}`
}

/** The page focused on one project. */
export function projectViewHref(slug: string): string {
  return viewHref({ kind: "project", slug })
}

export function sameView(a: PageView | undefined, b: PageView | undefined): boolean {
  if (!a || !b) return a === b
  return a.kind === "all" ? b.kind === "all" : b.kind === "project" && a.slug === b.slug
}

/** A string that changes exactly when the view does — for keying state that belongs to one view. */
export function viewKey(view: PageView): string {
  return view.kind === "all" ? "*" : `project:${view.slug}`
}

// ---- This tab's view ----------------------------------------------------------------------------------

const TAB_KEY = "frizz.pageView"
let tab: PageView | null = null
let tabLoaded = false

/** The view this TAB last showed — survives a reload, never seen by another tab. */
export function tabView(): PageView | null {
  if (!tabLoaded) {
    tabLoaded = true
    try {
      const stored = sessionStorage.getItem(TAB_KEY)
      tab = stored === null ? null : viewInSearch(stored) ?? null
    } catch {
      tab = null
    }
  }
  return tab
}

/** Remember the view this tab shows. Idempotent, so the route may call it on every render. */
export function rememberTabView(view: PageView): void {
  if (tabLoaded && sameView(tab ?? undefined, view)) return
  tab = view
  tabLoaded = true
  try {
    sessionStorage.setItem(TAB_KEY, viewSearch(view))
  } catch {
    // Storage disabled: the address still carries the view; only a drawer's close forgets it.
  }
}

// ---- The last project focused, in this browser ---------------------------------------------------------

// By ID, not slug: a rename changes the slug, and a remembered slug that no longer resolves would quietly
// fall back to All projects.
const LAST_KEY = "frizz.lastFocusedProject"

export function lastFocusedProject(): string | null {
  try {
    return localStorage.getItem(LAST_KEY)
  } catch {
    return null
  }
}

export function rememberLastFocusedProject(projectId: string): void {
  try {
    if (localStorage.getItem(LAST_KEY) !== projectId) localStorage.setItem(LAST_KEY, projectId)
  } catch {
    // Storage disabled: a bare `/` opens All projects instead.
  }
}

// ---- Reading it -----------------------------------------------------------------------------------------

/** A thread drawer's project, from its address (`/all/<slug>/thread/<t>`), or undefined. */
function drawerProject(pathname: string): string | undefined {
  const match = /^\/all\/([^/]+)\/thread\//u.exec(pathname)
  if (!match) return undefined
  try {
    return decodeURIComponent(match[1]!)
  } catch {
    return undefined
  }
}

/**
 * The view a page at this address shows: the one its query names, else this tab's, else — under a thread
 * drawer — the drawer's own project. Undefined only at a bare `/` in a tab that has shown nothing yet,
 * which the route resolves from the last-focused project (routes.tsx) before anything renders under it.
 */
export function viewAt(pathname: string, search: string): PageView | undefined {
  const asked = viewInSearch(search)
  if (asked) return asked
  const remembered = tabView()
  if (remembered) return remembered
  const slug = drawerProject(pathname)
  return slug ? { kind: "project", slug } : undefined
}

/**
 * Where "home" is for this tab — the page with no drawer open, showing this tab's view. The store → URL
 * writer closes the last drawer to this (lib/router.ts), and so does anything else that means "back to
 * the page".
 */
export function homeHref(): string {
  const view = tabView()
  return view ? viewHref(view) : "/"
}

/** The view the page is showing, live. */
export function usePageView(): PageView {
  const { pathname, search } = useLocation()
  return viewAt(pathname, search) ?? ALL_PROJECTS
}

/**
 * The view a page at a bare-or-named `/` resolves to, against the projects this machine has:
 *
 *   1. the view the address names — `?all`, or `?project=<slug>` when that slug is a registered project
 *      (its directory may be gone: asked for by name, it is shown, saying so);
 *   2. else this tab's own view, if its project is still here;
 *   3. else the project last focused in this browser, if it is still here;
 *   4. else All projects.
 *
 * `unknown` is a slug the address asked for that no project has — renamed, removed, a typo — which the
 * page says rather than silently showing something else.
 */
export function resolveView(
  cards: readonly { id: string; slug: string; stale?: boolean }[],
  asked: PageView | undefined,
  remembered: PageView | null,
  lastId: string | null,
): { view: PageView; unknown?: string } {
  if (asked?.kind === "all") return { view: ALL_PROJECTS }
  if (asked?.kind === "project" && cards.some((card) => card.slug === asked.slug)) return { view: asked }
  const unknown = asked?.kind === "project" ? asked.slug : undefined
  const usable = (slug: string) => cards.some((card) => card.slug === slug && !card.stale)
  if (remembered?.kind === "all") return { view: ALL_PROJECTS, unknown }
  if (remembered?.kind === "project" && usable(remembered.slug)) return { view: remembered, unknown }
  const last = lastId ? cards.find((card) => card.id === lastId && !card.stale) : undefined
  if (last) return { view: { kind: "project", slug: last.slug }, unknown }
  return { view: ALL_PROJECTS, unknown }
}

/**
 * Where a retired project address lands: focused on the project it names. `/project/<slug>` was a
 * project's own page until 2026-09-28, and old handoffs, toasts and bookmarks are full of it; its drawer
 * `/project/<slug>/thread/<t>` becomes that thread's drawer on the page, focused on its project, and its
 * `/full` the thread's fullscreen page. Undefined for any other address.
 */
export function retiredProjectHref(pathname: string): string | undefined {
  const match = /^\/project\/([^/]+)(?:\/thread\/([^/]+)(\/full)?)?(?:\/.*)?$/u.exec(pathname)
  if (!match) return undefined
  const [, slug, thread, full] = match
  if (!thread) return `/${viewSearch({ kind: "project", slug: decodeSafely(slug!) })}`
  const drawer = `/all/${slug}/thread/${thread}`
  return full ? `${drawer}/full` : `${drawer}${viewSearch({ kind: "project", slug: decodeSafely(slug!) })}`
}

function decodeSafely(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}
