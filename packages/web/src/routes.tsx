import { useEffect, useLayoutEffect, useState } from "react"
import { Navigate, Outlet, createBrowserRouter, useLocation, useNavigate, useParams } from "react-router"
import { useQuery } from "@tanstack/react-query"
import { App } from "./App.tsx"
import { ProjectRail, RAIL_INSET_CLASS } from "./components/ProjectRail.tsx"
import { StandaloneThreadPage } from "./components/StandaloneThreadPage.tsx"
import { AddProjectHost, Welcome } from "./components/ProjectActions.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { GithubHovercards } from "./components/GithubHovercards.tsx"
import { Toaster } from "./components/Toaster.tsx"
import { KeyboardLayer } from "./components/KeyboardShortcuts.tsx"
import { applyLocation, registerNavigate } from "./lib/router.ts"
import { setHomeFocus } from "./lib/base-path.ts"
import { defaultCrossProjectFocus, useCrossProjectPick } from "./lib/crossProject.ts"
import { lastFocusedProject, rememberLastFocusedProject, rememberTabView, resolveView, retiredProjectHref, tabView, viewAt, viewInSearch, viewSearch, type PageView } from "./lib/pageView.ts"
import type { ProjectCard } from "@frizz/shared"
import { rpc } from "./api/rpc.ts"
import { feedIsBoundTo, rebindProject } from "./api/socket.ts"
import { noteStandaloneThreadRender, primeFullscreenReturn, resetProjectState, showToast, store } from "./store.ts"
import { useProjectRailVisible } from "./lib/projectRail.ts"

// THE ROUTE TREE — and, more to the point, the LAYOUT that outlives a navigation.
//
// The rail is chrome: it draws every project on the machine and is identical on every page, so it
// must not be torn down and rebuilt when you use it. Before this it was mounted twice — once inside
// <App/> and once inside <ProjectGrid/> — because `main.tsx` chose ONE of three root shells from
// `location.pathname` at module load, which made every project switch a full document load. A layout
// route is the direct expression of "this part does not change": <RootLayout/> holds the rail and the
// tooltip provider, and the <Outlet/> below it holds the one page — Everything — or a redirect into it.
//
// WHAT A PROJECT SWITCH ACTUALLY COSTS, and why the router alone was never the whole job. Four things
// are bound to one project, and only the first two are this hook's business:
//   · the live feed — one socket per project (api/socket.ts rebindProject)
//   · the board store, the drawer stack and the current view (store.resetProjectState)
//   · the react-query cache, which now needs NOTHING here. It used to be swept on every switch,
//     exempting the project list so the rail would not blank mid-navigation; the cache is scoped by
//     project at the hash instead (lib/queryKeyScope.ts), so one project's entries are invisible to
//     another rather than deleted in front of it. Switching back finds a warm cache, and a response
//     that arrives late has nowhere wrong to land.
//   · the API base, which needs nothing: base-path.ts derives it from the page's path on every call,
//     and the router keeps `location` synchronous with navigation.
//
// A project switch on the page never remounts it: the page is keyed by a constant (CrossProjectPage), and
// what is per-project — the store's board and drawer stack — is reset by the binding instead. The rail
// above it is not keyed either, so it persists.

/** The one place that knows the URL shapes, so a route and a link cannot disagree. */
/** A thread drawer's prefix on the cross-project page (base-path.ts `crossProjectHref`); the page is `/`. */
export const CROSS_PROJECT_PATH = "/all/:slug"

function RootLayout() {
  useRegisterNavigate()
  // ONE decision drives the column AND the space reserved for it. They were separate — the rail was
  // conditional while every page kept an unconditional `pl-[57px]` — so turning the rail off left a
  // 57px lane of nothing down the left of every board. A hidden rail has to be gone from the layout,
  // not merely invisible in it.
  const railVisible = useProjectRailVisible()
  return (
    <TooltipProvider>
      {/* Outside the <Outlet/> on purpose: this is the element that must survive the navigation.
          OPT-IN: a permanent column of every project is a standing invitation to leave the project
          you are in, so it is off unless asked for. Hidden, the READY header's project switcher is the
          way to another project (AllQueues.tsx Switcher), a click away exactly when you meant to switch. */}
      {railVisible ? <ProjectRail /> : null}
      <div className={railVisible ? RAIL_INSET_CLASS : undefined}>
        <Outlet />
      </div>
      {/* HOSTED BY THE LAYOUT, not by the board. It lived inside <App/>, so `showToast` from anywhere
          else raised a toast with nowhere to render — silently, since the store field is set either
          way. The home page needs one (a bad project URL lands there, and says so), and it was exactly
          the kind of page that could never show one. Fixed-positioned, so it is inert until a toast
          exists. */}
      <Toaster />
      {/* The one add-project dialog (store.addProject): the folder picker's fallback from any door that
          adds a project, and the launcher's `/?add=<dir>` proposal. The layout's, because the proposal is
          read on `/` and then survives the redirect to the page it lands on. */}
      <AddProjectHost />
      {/* ALSO hosted by the layout, and for the same reason: prose carrying `#123` renders on the
          page, in a drawer and on the standalone `/thread/<slug>/full` page alike, and one delegated
          listener at the root covers all three. Inert until a pointer rests on a reference. */}
      <GithubHovercards />
      {/* The keyboard shortcuts and their sheet (`?`), for every page under the layout — the page and the
          welcome alike. /full mounts its own copy, since it sits outside this layout. */}
      <KeyboardLayer />
    </TooltipProvider>
  )
}

/**
 * Re-bind everything that belongs to one project, whenever the project changes.
 *
 * THE CONDITION IS ASKED OF THE FEED, and that is the whole point. This hook used to keep its own note
 * of the project it had bound, in a `useRef` — a second copy of a fact it did not own. Every switch
 * that changes which ROUTE matched (the home page to a board, a board to a thread page) unmounts one element
 * and mounts another, so the ref was born fresh, initialised to the slug it was looking at, and
 * therefore always answered "already bound". The feed stayed on the previous project while the URL, the
 * `<App/>` key and the board header all said the new one, and nothing short of a document load recovered
 * it (2026-08-11: every board on the machine rendered the launching project's threads).
 *
 * `feedIsBoundTo` asks the module that HOLDS the connection. It has nothing to remember and therefore
 * nothing to get wrong on a remount, and being called redundantly is free — which is what lets this stay
 * an ordinary effect instead of something that has to fire exactly once.
 */
function useProjectBinding(slug: string | undefined) {
  useEffect(() => {
    if (feedIsBoundTo(slug)) return
    resetProjectState()
    rebindProject()
  }, [slug])
}

// THERE IS NO PROJECT PAGE. Everything is the one page at `/` (maintainer 2026-09-28: "urls like this
// should not exist anymore: http://127.0.0.1:9393/project/frizz"), and what it shows is its VIEW, in its
// query: one project (`?project=<slug>`, focus mode, the default) or every project (`?all`) — see
// lib/pageView.ts. A retired `/project/<slug>` address lands focused on the project it names
// (retiredProjectHref); `/status/…` and anything else unknown lands on `/`, keeping the query a launcher
// may have sent (`?add=`, `?project=`).

/**
 * THE PAGE — one project's queue, or every project's, and the only page there is. At `/` it shows the
 * VIEW its address names (lib/pageView.ts). With a thread drawer open it is `/all/<slug>/thread/<t>` — the
 * thread's own address — and the view is the tab's.
 *
 * It is always BOUND to one project, the page project: the live feed, the store and every page-relative
 * helper (base-path.ts answers `/` through `setHomeFocus`, and `/all/<slug>/…` from the address) follow
 * it, so the prompt box dispatches into it and a thread drawer of it opens in place with the whole drawer
 * stack. Focused, the page project IS the view's project; showing All projects, it is the prompt box's
 * PICK (lib/crossProject.ts); under a drawer, the drawer's project. The list and the queue read
 * machine-wide data and name their project on every call (AllQueues.tsx, ProjectList.tsx).
 *
 * ONE component for both addresses, at the same depth, so react-router keeps the one instance mounted
 * across a drawer opening or closing, and across a change of view — the page must not remount under the
 * operator. `<App/>` is keyed by a CONSTANT for the same reason: what is per-project (the store's board
 * and drawer stack) is reset by the binding instead.
 *
 * With nothing to show — All projects on an empty machine, or one whose every directory is gone — there
 * is no page, so `/` renders the welcome instead (ProjectActions.tsx), the one place a project is added from.
 */
function CrossProjectPage() {
  const { slug: drawerSlug, thread } = useParams()
  const home = usePageResolution(drawerSlug)
  const slug = drawerSlug ?? (home.kind === "page" ? home.slug : undefined)
  // Render-phase, before anything below asks base-path which project `/` is.
  if (drawerSlug === undefined) setHomeFocus(slug)
  useProjectBinding(slug)
  useRouteToStore()
  useState(() => primeFullscreenReturn(thread))
  if (drawerSlug === undefined && home.kind === "error") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg px-6 text-center text-[13px] text-muted">
        Could not read the project registry: {home.error}
      </div>
    )
  }
  if (drawerSlug === undefined && home.kind === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg">
        <span className="block h-5 w-5 animate-spin rounded-full border-2 border-muted/50 border-t-transparent" />
      </div>
    )
  }
  if (drawerSlug === undefined && home.kind === "welcome") return <Welcome projects={home.projects} />
  return <App key="cross-project" />
}

type PageResolution =
  | { kind: "page"; view: PageView; slug: string | undefined }
  | { kind: "loading" }
  | { kind: "error"; error: string }
  | { kind: "welcome"; projects: ProjectCard[] }

/**
 * What the page at this address shows, and which project it is bound to.
 *
 * At `/` the view is resolved against the registry (lib/pageView.ts resolveView) and then WRITTEN into
 * the address, so a bare `/` becomes `/?project=<slug>` or `/?all` before anything paints: a reload, a
 * bookmark or a copied link of this tab reopens exactly what it shows, whatever another tab has done
 * since. Under a drawer the view is the tab's (lib/pageView.ts viewAt), and the drawer's address is left
 * alone.
 *
 * `?project=<slug>` is how the launcher names the project it was run in (and `?focus=<slug>`, the same
 * from a launcher older than 2026-09-29). It is a query on `/` rather than a path so a new launcher that
 * joins an OLDER server — one whose page has no such view — still lands somewhere real.
 *
 * Two more arrive from outside and are answered HERE, on the way through:
 *  - `?add=<dir>` is the LAUNCHER asking: running `frizz` in an unknown folder does not adopt it, it
 *    sends the operator here to say yes. It opens the one add-project dialog, pre-filled.
 *  - `?unknown=<slug>` is the SERVER saying it sent a page here rather than let it hang: a drawer's
 *    `/all/<x>/thread/…` for a project nobody has (renamed, removed) would render the app, 404 every
 *    call and sit on its boot spinner forever (index.ts `unknownProjectPage`). A URL that silently
 *    became the home page reads as Frizz having swallowed it. `?project=<slug>` for a slug nobody has
 *    is said the same way.
 */
function usePageResolution(drawerSlug: string | undefined): PageResolution {
  const atHome = drawerSlug === undefined
  const { pathname, search } = useLocation()
  const navigate = useNavigate()
  const cards = useQuery({ queryKey: ["projectsList"], queryFn: () => rpc.projectsList() })
  // Which projects this server has open, so All projects binds one that can take a thread. Shared with
  // the page itself (same key), so the page it lands on paints from this read.
  const queues = useQuery({ queryKey: ["projectsQueues"], queryFn: () => rpc.projectsQueues() })
  const pickId = useCrossProjectPick()
  useState(() => {
    if (!atHome) return
    const asked = new URLSearchParams(search)
    const proposed = asked.get("add")
    if (proposed) store.addProject = { proposed }
    const unknown = asked.get("unknown")
    if (unknown) showToast(`No project named ${unknown}`, { duration: 7000 })
  })
  const resolved = !atHome
    ? { view: viewAt(pathname, search) ?? ({ kind: "project", slug: drawerSlug } as const) }
    : cards.data
      ? resolveView(cards.data, viewInSearch(search), tabView(), lastFocusedProject())
      : undefined
  const view = resolved?.view
  // Render-phase and idempotent, like setHomeFocus: everything below reads the tab's view (usePageView),
  // and a drawer's close goes home to it (lib/router.ts).
  if (view) rememberTabView(view)
  const focusedId = view?.kind === "project" ? cards.data?.find((card) => card.slug === view.slug)?.id : undefined
  useEffect(() => {
    if (focusedId) rememberLastFocusedProject(focusedId)
  }, [focusedId])
  const unknown = resolved && "unknown" in resolved ? resolved.unknown : undefined
  useEffect(() => {
    if (unknown) showToast(`No project named ${unknown}`, { duration: 7000 })
  }, [unknown])
  // A LAYOUT effect, so the address says what the page shows before anything paints under it.
  const canonical = atHome && view ? viewSearch(view) : null
  useLayoutEffect(() => {
    if (canonical !== null && search !== canonical) navigate(`/${canonical}`, { replace: true })
  }, [canonical, search, navigate])
  if (!atHome) return { kind: "loading" }
  if (cards.error) return { kind: "error", error: String(cards.error) }
  if (!cards.data || !view || queues.isPending) return { kind: "loading" }
  if (view.kind === "project") return { kind: "page", view, slug: view.slug }
  const openIds = queues.data ? new Set(queues.data.map((queue) => queue.projectId)) : undefined
  const pick = defaultCrossProjectFocus(cards.data, pickId, openIds)
  return pick ? { kind: "page", view, slug: pick } : { kind: "welcome", projects: cards.data }
}

/**
 * Any address the page does not have: a retired project address focused on its project, anything else
 * `/`, keeping the query (`?add=`, `?project=`, `?unknown=`) it carries.
 */
function HomeRedirect() {
  const { pathname, search } = useLocation()
  return <Navigate to={retiredProjectHref(pathname) ?? `/${search}`} replace />
}

/**
 * URL → store, for the routes INSIDE the page.
 *
 * The drawer stack is valtio state, not route state, because a drawer is a stack with its own
 * animated unwind and several ways to open — so the URL is one input to it rather than its owner.
 * This is the direction react-router does not do for us: it resolves the path, and `applyPath` turns
 * that into "which thread is open, and is it a drawer or a queue card". The other direction (store →
 * URL) lives in lib/router.ts, which now navigates rather than calling history directly.
 */
function useRouteToStore() {
  const location = useLocation()
  useEffect(() => {
    applyLocation(location.pathname)
  }, [location.pathname])
}

// Hands react-router's navigate to lib/router's module-level `spaNavigate`, for the leaves that must
// change the URL without router context (see registerNavigate). Both shells call it: each is the root
// of its own tree, and the fullscreen page has no RootLayout above it.
function useRegisterNavigate(): void {
  const navigate = useNavigate()
  useEffect(() => {
    registerNavigate((path, options) => navigate(path, options))
    return () => registerNavigate(null)
  }, [navigate])
}

/** The focused single-thread page. Deliberately OUTSIDE the layout: it has no rail, and should not. */
function StandaloneRoute() {
  const { thread, slug } = useParams()
  useRegisterNavigate()
  useProjectBinding(slug)
  // Any drawer stack left by the page we came from is cleared HERE, on this route's first render —
  // deliberately NOT in the fullscreen door's click handler, and deliberately not in an effect. The
  // door's navigation runs inside a view transition, which snapshots the OLD page two renders after
  // the click — a click-time clear removed the very sheet the transition slides into place. And the
  // NEW page is snapshotted at this render's commit, so an effect would be one paint too late: this
  // page's own DrawerStack would be captured painting the thread's sheet over itself mid-transition.
  // A render-phase write (the useState initializer runs exactly once, before the children render)
  // means DrawerStack below already sees the empty stack in the same pass.
  useState(() => { if (store.drawers.length > 0) store.drawers = [] })
  // Recorded every render, consumed by CrossProjectPage's mount (primeFullscreenReturn): this is how the
  // page knows its first render is the return leg of the fullscreen door and should prime the reverse
  // morph's target.
  noteStandaloneThreadRender(thread!)
  return (
    <>
      <StandaloneThreadPage slug={thread!} />
      {/* Its own, since it is outside the layout. This page renders a full transcript, so it has the
          copy-a-code-block control — whose only feedback is a toast, which until now had nowhere to
          go here. Skipping the rail does not mean skipping the feedback. */}
      <Toaster />
      {/* Its own for the same reason: `e`, `h`, `r` and `f` (which leaves) work on this thread too. */}
      <KeyboardLayer />
    </>
  )
}

export const router = createBrowserRouter([
  // The focused single-thread pages sit OUTSIDE the layout — they have no rail, and should not.
  { path: "/thread/:thread/full", element: <StandaloneRoute /> },
  { path: `${CROSS_PROJECT_PATH}/thread/:thread/full`, element: <StandaloneRoute /> },
  {
    element: <RootLayout />,
    children: [
      // The SAME element at the same depth for `/` and a drawer on it, so react-router keeps the one
      // instance mounted across a drawer opening or closing — the page must not remount under you.
      { path: "/", element: <CrossProjectPage /> },
      { path: `${CROSS_PROJECT_PATH}/thread/:thread`, element: <CrossProjectPage /> },
      // Anything else is the page — never a blank route (see "THERE IS NO PROJECT VIEW" above).
      { path: "*", element: <HomeRedirect /> },
    ],
  },
])
