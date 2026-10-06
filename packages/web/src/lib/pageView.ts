// THE PAGE'S VIEW — which projects the one page shows: every project (All projects, the home and the
// default) or ONE project (its board, focus mode).
//
// All projects is home (maintainer 2026-09-30: "by default frizz should open the all projects view that
// should be home and it shouldnt need a dedicated /all path"): every project's list and one queue across
// all of them, with the prompt box's own project picker. A project's BOARD — Colin McDonnell's one project
// per page, Frizz's original shape — is one click away in the switcher: the list is that project's, banded
// as his sidebar banded it (ProjectBoard.tsx), the queue shows its cards, and the prompt box dispatches
// into it.
//
// THE VIEW IS THE PATH, so every tab, bookmark and launch keeps its own, and a link says what it opens:
//
//   /                           All projects — the launcher opens this (`/all` is its other name)
//   /all/<slug>/thread/<t>      All projects, with that thread's drawer over it
//   /project/<slug>             that project's board
//   /project/<slug>/thread/<t>  the board, with that thread open (its card, or its drawer)
//   /project/<slug>/status/<s>  the board's status list
//
// `/project/<slug>` is Colin's own scheme (upstream singleton-frizz.md: `?project=` was considered there and
// rejected), restored 2026-10-06 (David: the fork is the base, and everything Colin decided is in it —
// plans/upstream-superset.md §2). From 2026-09-29 to then the board was a QUERY on `/` (`/?project=<slug>`,
// first spelled `?focus=`), and a drawer's address could not say which view it sat on, so each tab kept
// its view in sessionStorage. The path says it now, so there is nothing left for a tab to remember; the
// old queries redirect to the path (routes.tsx, legacyViewRedirect below).

import { useLocation } from "react-router"

export type PageView = { kind: "project"; slug: string } | { kind: "all" }

export const ALL_PROJECTS: PageView = { kind: "all" }

/** `/project/<slug>…` — a board's address — and its (still encoded) slug. */
const BOARD = /^\/project\/([^/?#]+)(?:\/|$)/u

/** The view a page at this path shows: a project's board for `/project/<slug>…`, else All projects. */
export function viewAt(pathname: string): PageView {
  const match = BOARD.exec(pathname)
  return match ? { kind: "project", slug: decodeSafely(match[1]!) } : ALL_PROJECTS
}

/** The page showing a view: `/project/<slug>` or `/`. */
export function viewHref(view: PageView): string {
  return view.kind === "all" ? "/" : `/project/${encodeURIComponent(view.slug)}`
}

/** A project's board. */
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

/** The address bar's path, or `/` where there is none (a unit test under node, a stubbed location). */
function currentPath(): string {
  const path = typeof location === "undefined" ? undefined : location.pathname
  return typeof path === "string" ? path : "/"
}

/** The view the page is showing right now, read off the address — for a handler, which has no hook. */
export function currentView(): PageView {
  return viewAt(currentPath())
}

/**
 * Where "home" is for this page — the page with no drawer open, showing its view: the board it is on, or
 * `/`. The store → URL writer closes the last drawer to this (lib/router.ts), and so does anything else
 * that means "back to the page".
 */
export function homeHref(pathname: string = currentPath()): string {
  return viewHref(viewAt(pathname))
}

/** The view the page is showing, live. */
export function usePageView(): PageView {
  return viewAt(useLocation().pathname)
}

/**
 * Whether the view names a project this machine has. `unknown` is a board's slug no project has — renamed,
 * removed, a typo — which the page says rather than silently showing something else; the server answers a
 * cold load of one the same way (packages/server index.ts unknownProjectPage), so this catches the ones
 * reached inside the page (a stale link, Back past a rename).
 */
export function resolveView(
  cards: readonly { slug: string }[],
  asked: PageView | undefined,
): { view: PageView; unknown?: string } {
  if (asked?.kind !== "project") return { view: ALL_PROJECTS }
  if (cards.some((card) => card.slug === asked.slug)) return { view: asked }
  return { view: ALL_PROJECTS, unknown: asked.slug }
}

// ---- The views' old addresses --------------------------------------------------------------------------

const PROJECT_PARAM = "project"
/** The board's query until 2026-09-29, when a launcher of that age sent it; it reads as `project`. */
const LEGACY_FOCUS_PARAM = "focus"
/** All projects' address until 2026-09-30, when it became the bare `/`. */
const ALL_PARAM = "all"

/**
 * Where an address that names its view in the QUERY lands now, or undefined for one that does not.
 *
 *   /?project=<slug>, /?focus=<slug>   → /project/<slug>
 *   /all/<s>/thread/<t>?project=…      → /project/<s>/thread/<t>   (and its /full)
 *   /?all                              → /
 *
 * A drawer's old address named its thread in the path and the tab's board in the query; the thread is what
 * it opens, so its own project's board is where it lands. Everything else the query carries (an editor's
 * `embed` and `theme`, a launcher's `add`) rides along.
 */
export function legacyViewRedirect(pathname: string, search: string): string | undefined {
  const params = new URLSearchParams(search)
  const slug = params.get(PROJECT_PARAM) || params.get(LEGACY_FOCUS_PARAM) || undefined
  if (!slug && !params.has(ALL_PARAM) && !params.has(PROJECT_PARAM) && !params.has(LEGACY_FOCUS_PARAM)) return undefined
  params.delete(PROJECT_PARAM)
  params.delete(LEGACY_FOCUS_PARAM)
  params.delete(ALL_PARAM)
  const rest = params.toString()
  const query = rest ? `?${rest}` : ""
  const drawer = /^\/all\/([^/]+)\/thread\/([^/]+)(\/full)?\/?$/u.exec(pathname)
  if (slug && drawer) return `/project/${drawer[1]}/thread/${drawer[2]}${drawer[3] ?? ""}${query}`
  if (slug && (pathname === "/" || pathname === "/all" || pathname === "/all/")) return `${projectViewHref(slug)}${query}`
  return `${pathname}${query}`
}

function decodeSafely(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}
