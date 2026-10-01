import { useEffect, useRef, type ReactNode } from "react"
import { useSnapshot } from "valtio"
import { displayTitle } from "../groups.ts"
import { threadKey, type QueuesProject } from "../lib/allQueues.ts"
import { reportRoute, queueReading, sidebarRoute } from "../lib/embedRoute.ts"
import { registerQueueCursor } from "../lib/keyboardRuntime.ts"
import { phoneCounts, phoneQueue, phoneSubtitle } from "../lib/phonePage.ts"
import { prefs } from "../lib/prefs.ts"
import { store } from "../store.ts"
import { useOpenThreadInPlace } from "./AllQueuesCard.tsx"
import { StatusRow } from "./StatusRow.tsx"

// THE PAGE IN AN EDITOR'S SIDEBAR — the desktop app's left column, alone (plans/vscode-extension.md
// § The editor in the sidebar, and the app's own feel). The VS Code extension frames this page at any
// width from ~250px up (lib/embed.ts), and it is the DESKTOP app narrowed, not the phone app: someone who
// uses Frizz in the browser must recognize every surface in it.
//
// The desktop page is two columns: on the left the prompt box over the project list, on the right the
// queue's cards, with a thread's drawer sliding over them. The left column is already a sidebar — it is
// 272px at its narrowest (Sidebar.tsx SIDEBAR_COLUMN_CLASS) — so it is what this page draws, with the
// desktop's own parts at the desktop's own sizes: the prompt box (AllQueues.tsx FocusedComposer, the
// picker in its bottom strip on All projects), and the list (ProjectList.tsx), its 13px rows, rest times,
// spinners, hover verbs and quiet bands unchanged. The right column has no room, so a thread opens in its
// DRAWER, full width (styles.css `html[data-embed] .frizz-sheet-panel`), with the same header, transcript,
// reply box, Snooze and Mark as done the card and the drawer carry on the desktop; ✕ or Esc comes back here.
//
// Rejected, each drawn at 300 and 450px before choosing (build2-shell.md): the desktop's stacked page
// (the prompt box, then every Ready card at full height, the list below them all), which put the list
// thousands of pixels down; and the phone's page, which the first cut used — its own rows at a 15.5px
// title, tabs no desktop has, and touch targets.
//
// NO HEADER. VS Code's title row above the frame is the header (lib/embedRoute.ts): the view's name and
// its counts go there, and its buttons come back as `frizz:command` (lib/embedCommand.ts). What the
// desktop's status row carried that the title row cannot is kept in the page: the view's switcher heads
// the list (ProjectList `switcher`), in the slot the status row's title leaves empty on the desktop.
//
// THE KEYS ARE THE DESKTOP'S. `j` / `k` step the card being read on the desktop; here, with no cards,
// they open the next or previous Ready thread in its drawer, in the list's order, which is the reading a
// card gives in the sidebar. The thread keys (`r`, `d`, `s` …) then press the drawer's own controls, as
// they do on the desktop with a drawer open (lib/keyboardRuntime.ts).

export function SidebarPage({
  projects,
  shown,
  viewed,
  focusedSlug,
  hidden,
  loading,
  error,
  composer,
  list,
}: {
  /** Every project — what a row's key is looked up in. */
  projects: QueuesProject[]
  /** The view's projects: the focused one, or every one. */
  shown: QueuesProject[]
  viewed: QueuesProject | undefined
  focusedSlug: string | undefined
  hidden: (key: string) => boolean
  loading: boolean
  error: string | undefined
  /** The page's prompt box. */
  composer: ReactNode
  /** The project list, handed the row the human is reading. */
  list: (activeKey: string | null) => ReactNode
}) {
  const snap = useSnapshot(store)
  const direction = useSnapshot(prefs).queueOrder
  const active = useReadingRow(projects)

  // The title row's reading. The thread's title is the page project's board's — a drawer only ever shows
  // a thread of the page project (useOpenThreadInPlace moves the page to it).
  const top = [...snap.drawers].reverse().find((drawer) => !drawer.closing)
  const threadSlug = [...snap.drawers].reverse().find((drawer) => !drawer.closing && drawer.kind !== "file")?.slug ?? null
  const thread = threadSlug ? snap.board?.threads.find((t) => t.id === threadSlug) : undefined
  const scope = focusedSlug !== undefined ? (viewed?.name ?? focusedSlug) : "All projects"
  const reading = loading || error ? null : queueReading(phoneSubtitle(phoneCounts(phoneQueue(shown, hidden, undefined, direction))))
  const route = sidebarRoute({
    settings: snap.showSettings,
    thread: threadSlug ? (thread ? displayTitle(thread) : threadSlug) : null,
    other: !threadSlug && top ? (top.label ?? top.slug) : null,
    scope,
    reading,
  })
  useEffect(() => reportRoute(route), [route.view, route.title, route.description])

  return (
    <div data-sidebar-page className="min-h-screen bg-bg px-3 pb-8 pt-3 text-sm text-fg">
      <StatusRow settings={false} />
      {composer}
      {error ? (
        <p className="mt-6 text-center text-[13px] text-muted">Could not read the queues: {error}</p>
      ) : loading ? (
        <div className="flex justify-center pt-10">
          <span className="block h-5 w-5 animate-spin rounded-full border-2 border-muted/50 border-t-transparent" />
        </div>
      ) : (
        // The list in the box's own column, as on the desktop: its rows' 20px marker gutter starts at the
        // box's border.
        <div data-xq-rail="sidebar" className="mt-4 min-w-0">
          {list(active)}
        </div>
      )}
    </div>
  )
}

/**
 * THE ROW BEING READ, and `j` / `k` over the list. The thread up in the drawer is the one being read; with
 * the drawer closed the last one read stays marked (the rail's reading marker, Sidebar.tsx RailRow), so the
 * next `j` goes on from it — the desktop's reading line, held where the reader left it.
 */
function useReadingRow(projects: QueuesProject[]): string | null {
  const snap = useSnapshot(store)
  const openInPlace = useOpenThreadInPlace()
  const projectsRef = useRef(projects)
  projectsRef.current = projects
  const page = snap.board?.projectSlug
  const pageProject = projects.find((project) => project.slug === page)
  const slug = [...snap.drawers].reverse().find((drawer) => !drawer.closing && drawer.kind === "thread")?.slug
  const open = pageProject && slug ? threadKey(pageProject.id, slug) : null
  const last = useRef<string | null>(null)
  if (open) last.current = open
  const reading = open ?? last.current
  const readingRef = useRef(reading)
  readingRef.current = reading

  useEffect(
    () =>
      registerQueueCursor({
        // The Ready rows, in the list's own order — what the eye sees, top to bottom.
        keys: () =>
          [...document.querySelectorAll<HTMLElement>('[data-xq-rail="sidebar"] [data-xq-thread-row][data-xq-band="ready"]')]
            .map((row) => row.dataset.xqRailRow ?? "")
            .filter(Boolean),
        current: () => readingRef.current,
        // The drawer is the card: the thread keys press its controls (keyboardRuntime currentThreadSurface).
        root: () => null,
        go: (key) => {
          const project = projectsRef.current.find((candidate) => key.startsWith(`${candidate.id}/`))
          if (project) openInPlace(project, key.slice(project.id.length + 1))
        },
      }),
    [openInPlace],
  )
  return reading
}
