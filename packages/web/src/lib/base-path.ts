import { FRIZZ_ROUTE_PREFIX } from "@frizz/shared"

// WHICH PROJECT THIS PAGE IS SHOWING, taken from its own URL.
//
// One Frizz per machine serves every project from one origin, and ONE PAGE shows them all: Everything,
// at bare `/`. A thread drawer open on it is `/all/<slug>/thread/<t>` — the address names the thread's
// project, because that is the thread's address — and its fullscreen page is the same plus `/full`.
// That works because Frizz's own routes live under `/_frizz/`, so the top-level namespace is the SPA's.
//
// THERE IS NO PROJECT PAGE. `/project/<slug>` was one — a project's board, then its "project view" —
// until 2026-09-28 (maintainer: "urls like this should not exist anymore"); nothing here parses or mints
// it now, and the route tree sends it home like any other unknown address (routes.tsx).
//
// AN EMPTY BASE IS A SUPPORTED STATE, not a bug: an unprefixed `/thread/<slug>/full` is the launching
// project's fullscreen page, and a page with no project at all (the welcome) has nothing to prefix.
//
// The page is always FOCUSED on one project — the one its prompt box dispatches into, or the one whose
// drawer is open — and the focus IS the page project: every helper below answers for it (the same API
// base, the same live feed, the same cache scope), which is what lets the whole drawer stack and composer
// work for any project on the one page.
//
// AT `/` THE FOCUS IS NOT IN THE URL. Where a new thread goes is a setting of the prompt box, like its
// model, not an address (maintainer 2026-09-28: "should not be reflected as a top-level url route like
// this: /all/frizz"). The route resolves it — the operator's remembered pick (lib/crossProject.ts) —
// and hands it here with `setHomeFocus`, so `/` answers as `/all/<focus>` did. A drawer's URL still
// names its thread's project, because that is the thread's address, not the box's target.

/**
 * The SPA's own top-level route names — the in-app links an agent writes unprefixed. This is the single definition of that set —
 * `isFrizzRoute` in markdownTargets.ts used to keep its own copy, and under a project prefix a stale
 * copy is not a small bug: every in-app link starts looking like a FILESYSTEM path to the markdown
 * sanitizer, and renders as a disabled local-file chip.
 */
export const APP_ROUTE_SEGMENTS = new Set(["thread", "status"])

/**
 * Machine-level pages: they are in-app, but they name no project and are never re-pointed under one.
 * `/` itself is one too (the cross-project page); `queues` and `projects` are old addresses of it (the
 * page before it was the home, and the project grid it absorbed), which the route tree sends home.
 */
export const MACHINE_ROUTE_SEGMENTS = new Set(["all", "projects", "queues"])

/**
 * This page’s path, or `/` where there is no page.
 *
 * These helpers are imported by modules that also run under node — the markdown sanitizer and the
 * socket transport both have unit tests with no DOM — so reading `location` unguarded turns a pure
 * function into one that throws depending on who imported it. A STUBBED location counts too: the
 * socket tests install one carrying only `origin`, so a present `location` is not a promise of a
 * present `pathname`.
 */
function here(pathname?: string): string {
  if (typeof pathname === "string") return pathname
  const current = typeof location === "undefined" ? undefined : location.pathname
  return typeof current === "string" ? current : "/"
}

/**
 * A drawer's project lives UNDER a segment of its own rather than at the root.
 *
 * `/nub/thread/x` would have made every project slug a top-level route name, so every page Frizz might
 * later want — settings, docs, a machine dashboard — would have to be fought for against a directory
 * somebody happens to have. `/all/nub/thread/x` costs one segment and keeps the root free.
 */
const CROSS_PROJECT_SEGMENT = "all"
export const CROSS_PROJECT_PREFIX = `/${CROSS_PROJECT_SEGMENT}`

let homeFocus: string | undefined

/**
 * The project the cross-project page at `/` is focused on — set by its route (routes.tsx
 * CrossProjectPage) during render, before anything below it asks, and cleared when `/` has none to show.
 */
export function setHomeFocus(slug: string | undefined): void {
  homeFocus = slug
}

function isHome(path: string): boolean {
  return path === "/" || path === ""
}

/** The slug this page is showing, or `undefined` for the unprefixed launching project. */
export function projectSlug(pathname?: string): string | undefined {
  const path = here(pathname)
  if (isHome(path)) return homeFocus
  const [, first, second] = path.split("/")
  return first === CROSS_PROJECT_SEGMENT && second ? second : undefined
}

/**
 * Is this the cross-project page (`/` with a focus, or `/all/<slug>…`) — rather than a page with no
 * project in it: the welcome, or the launching project's unprefixed fullscreen page?
 */
export function isCrossProjectPath(pathname?: string): boolean {
  const path = here(pathname)
  if (isHome(path)) return homeFocus !== undefined
  const [, first, second] = path.split("/")
  return first === CROSS_PROJECT_SEGMENT && Boolean(second)
}

/**
 * The cross-project page's prefix for a project — the one place that knows the shape, and only ever
 * with a path after it, a thread's (`/all/<slug>/thread/<t>`). The page itself is `/`: see
 * `everythingHref`.
 */
export function crossProjectHref(slug: string): string {
  return `${CROSS_PROJECT_PREFIX}/${slug}`
}

/**
 * The cross-project page, `/` — optionally aiming its prompt box at a project on the way in. `?focus=`
 * is read once by the route, remembered as the pick, and dropped from the address (routes.tsx).
 */
export function everythingHref(focusSlug?: string): string {
  return focusSlug ? `/?focus=${focusSlug}` : "/"
}

/** `/all/nub`, or `""` when this page names no project (the launching project's unprefixed /full). */
export function basePath(pathname?: string): string {
  const slug = projectSlug(here(pathname))
  return slug ? crossProjectHref(slug) : ""
}

/** The path with the project prefix removed — what the router reasons about. */
export function innerPath(pathname?: string): string {
  const path = here(pathname)
  const base = basePath(path)
  if (!base) return path || "/"
  return path.slice(base.length) || "/"
}

/**
 * An inner path put back in terms the address bar uses. The cross-project page's own root is `/`
 * whichever project a drawer had it focused on: closing the last drawer goes home, where the focus is
 * the pick again.
 */
export function outerPath(inner: string, pathname?: string): string {
  return inner === "/" ? "/" : `${basePath(pathname)}${inner}`
}

/**
 * An UNPREFIXED in-app route re-pointed at the project this page is showing, or `null` for anything
 * else (an already-prefixed link, `/`, a filesystem path, a web URL).
 *
 * A worker writes `[label](/thread/<slug>)` — the shape from when one server meant one project, and
 * the shape its prompt still teaches. Rendered verbatim on a page focused on `nub`, that anchor
 * addresses whichever project LAUNCHED the server: a plain left-click is caught by the thread-link interceptor
 * and opens the right thread, but ⌘-click, middle-click and "open link in new tab" hand the raw href
 * to the browser and land on a stranger's board (or on <MissingThread>). Rewriting the href at
 * sanitize time fixes every one of those without the author having to know which project they are in.
 *
 * `/` is deliberately NOT rewritten: it is the cross-project page, which is the same page everywhere.
 */
export function prefixedAppRoute(href: string | null | undefined, pathname?: string): string | null {
  if (!href || !href.startsWith("/") || href.startsWith("//")) return null
  const bare = href.replace(/[?#].*$/u, "")
  if (projectSlug(bare)) return null // already names its project
  const first = bare.split("/")[1] ?? ""
  if (!APP_ROUTE_SEGMENTS.has(first)) return null
  const outer = outerPath(href, pathname)
  return outer === href ? null : outer
}

/**
 * Where THIS page's API lives: `/_frizz/nub`, or `/_frizz` unprefixed.
 *
 * Every client URL builder goes through here, so a page always addresses the project it is showing
 * rather than whichever one happens to have launched the server.
 */
export function apiBase(pathname?: string): string {
  const slug = projectSlug(pathname)
  // The API keeps the FLAT `/_frizz/<slug>/…` shape. It already sits inside a reserved namespace, so
  // it has no root to protect, and the server's split stays a two-part one.
  return slug ? `${FRIZZ_ROUTE_PREFIX}/${slug}` : FRIZZ_ROUTE_PREFIX
}
