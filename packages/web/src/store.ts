import { proxy } from "valtio"
import type { BoardSnapshot, ThreadView, BoardDelta, ProjectEnclosed } from "@frizz/shared"
import { applyBoardDelta } from "@frizz/shared"
import type { EditorWindowSummary } from "@frizz/shared"
import type { MarkdownScope } from "./lib/useMarkdown.ts"
import { disarmFullscreenMorph } from "./lib/fullscreenMorph.ts"
import { closeDrawerAnimated, focusDrawer } from "./lib/overlays.ts"
import { resolveThreadRoute } from "./lib/threadRouteState.ts"
import { standaloneThreadHref } from "./lib/standaloneThreadRoute.ts"
import { ownedByThisPage } from "./lib/projectOwnership.ts"
import { setGithubRepo } from "./lib/githubAutolink.ts"
import { setMentionIndex } from "./lib/mentionAutolink.ts"
import { resetGithubCards } from "./lib/githubHovercards.ts"
import { setLocalPathBase } from "./lib/localPathBase.ts"
import { basename } from "./lib/paths.ts"
import { prefersReducedMotion, SHEET_CLOSE_MS } from "./lib/sheet.ts"
import type { RestartAttempt } from "./api/restart.ts"

// Where a scroll-to-card lands a card's outer border below the viewport top (px), when its lane has no
// sticky header to clear (AllQueues.tsx useScrollToCard).
// 40px is the queue's own rhythm: the hairline rule between two cards carries `my-10` (40px) on each
// side, so a landed card sits under the viewport edge with exactly the space it has under its
// predecessor's rule. It was 12px until 2026-08-25, which read as the card being pressed against the
// top of the window (maintainer: "we should leave the full 40 px").
export const QUEUE_CARD_VIEWPORT_TOP = 40

export type ConnectionState = "connecting" | "open" | "closed"
/** A cross-project thread open in flight — see `store.pendingOpen`. */
export interface PendingOpen {
  projectSlug: string
  projectName: string
  slug: string
  title: string
}
export interface SocketPayloadFallback {
  actualBytes: number
  maxBytes: number
}
export type SocketTranscriptFallback =
  | ({ kind: "payload-too-large" } & SocketPayloadFallback)
  | { kind: "read-budget"; scope: "origin" | "global"; retryAfterMs: number }

// The whole app renders off this single valtio proxy. Board is a full snapshot
// pushed over SSE (no diff protocol); everything else is local UI state.
export const store = proxy({
  board: null as BoardSnapshot | null,
  connection: "connecting" as ConnectionState,
  // The durable supervisor, rather than a disposable board child, owns this truth. While it is
  // restarting, all text remains in the session-backed draft store but write RPCs are held locally.
  // This prevents a successful-looking old UI from racing a successor artifact.
  controlPlaneState: "ready" as "ready" | "restarting" | "failed",
  controlPlaneMessage: null as string | null,
  // A user-initiated update+restart flips the overlay on OPTIMISTICALLY (before the POST is acked) so
  // the block is instant. While an attempt is recorded here, the status poll must not apply a "ready"
  // it reads — that would tear the overlay down and could reload onto the old child — and it must not
  // believe ANY answer whose request started before the ack, whichever state it names: a "failed" that
  // was already in flight when the operator clicked retry used to clear this guard for the new attempt
  // (pullfrog on #35, 2026-09-11). `ackedAt` is set when the supervisor accepts the transition; the
  // record is cleared by App's poll effect once an answer requested after that ack observes it
  // (nextControlPlane in api/restart.ts), or by the button when the POST is rejected.
  controlPlaneRestartAttempt: null as RestartAttempt | null,
  showSettings: false,
  // The typed-path "add a project" dialog, one instance for the whole app (ProjectActions.tsx
  // AddProjectHost, mounted by the root layout): the folder picker's fallback when a machine has none,
  // and the launcher's `/?add=<dir>` proposal. Not reset on a project switch — adding a project is a
  // machine action, and the dialog must survive the navigation that the proposal itself triggers.
  // `enclosed` is the other question it asks: the chosen folder sits inside another project root, so
  // open that root, or add the folder as its own project.
  addProject: null as { reason?: string; proposed?: string; enclosed?: ProjectEnclosed } | null,
  showPalette: false,
  // The keyboard-shortcuts sheet (`?`, or the keyboard icon in the status row). Rendered by
  // <KeyboardLayer/>, which every page shell mounts — so it opens on Everything and /full alike.
  showShortcuts: false,
  // The anywhere-modal behind the "New thread" pill (Gmail-compose style).
  showNewThread: false,
  // The GitHub picker modal (Issues/PRs tabs → multi-select → batch dispatch). Its trigger appears
  // only when gh is authed AND the project is a GitHub repo; see GithubTrigger + openGithubPicker.
  // The modal reads the durable new-thread profile live and carries its own selector for it, so
  // nothing about the dispatch tuple is captured here.
  showGithubPicker: false,
  // The SIDE-DRAWER STACK — arbitrary depth. `thread` layers are full thread views (the Open-thread
  // sheet); `doc` layers are the frizz-document markdown; `file` layers are the built-in reader for a
  // FILE on disk — a `.md` rendered, anything else as source — opened from any link to one (see
  // lib/localViewer.ts for which files it takes); `subagent` and `shell` layers are read-only
  // operation drill-ins that overlay a thread. A drill-in within one thread's family
  // (its doc, its sub-agents) stacks OVER the previous layer (higher z, slight inset); any lateral open
  // REPLACES the layers it doesn't stack over (one drawer at a time — see openOrRaiseDrawer). Esc /
  // backdrop / browser-Back unwind the TOP layer first. There is no
  // standalone thread page — this stack is the only thread surface. Operation-only fields ride the
  // same entry so App can render its sheet without a board lookup after the operation finishes.
  drawers: [] as {
    id: number
    kind: "thread" | "doc" | "subagent" | "shell" | "file" | "terminal"
    slug: string
    routed?: boolean // URL/deep-link-created thread: visible on first paint, never an invisible animated backdrop
    subId?: string // subagent/shell: the launch tool_use id (the RPC handle + dedupe key) / terminal: its id
    label?: string // subagent: the dispatch description (header title) / file: the basename
    path?: string // file: the absolute file path
    scope?: MarkdownScope // file: opened from ANOTHER project's card on the everything page — whose gate
    // reads it and whose repo its prose links into (pushFileReader); absent = the page's own project
    subagentType?: string // subagent: the model+effort cell tag
    startedAt?: string // subagent: ISO8601 dispatch time (drives the header's running elapsed)
    openedAt?: number // bumped when an existing logical layer is focused/reopened
    closing?: boolean // set the instant this layer's slide-OUT begins, so URL/topThreadSlug stop
    // counting it before its 210ms removal (prevents a phantom /thread history push when a view
    // change races the close — see markDrawerClosing).
  }[],
  // Mirrors settings.notifications so the (React-free) SSE handler can gate desktop
  // notifications without reaching into TanStack Query. Kept in sync from App.
  notificationsEnabled: false,
  // True once the /ws multiplex confirms it's live (server pushes transcript updates into the query
  // cache). useTranscript reads this to DROP its 1.5s poll + subscribe instead; false before the socket
  // confirms and on SSE fallback (a pre-restart server without /ws), where polling stays exactly as today.
  socketTranscripts: false,
  // Explicit transport downgrades reported by the multiplex server. A board overflow switches the whole
  // board channel to SSE once; a transcript overflow/read-budget rejection pauses only that slug's live
  // subscription while the last complete copy remains visible and manually refreshable. All reset on reload.
  socketBoardFallback: null as SocketPayloadFallback | null,
  socketTranscriptFallbacks: {} as Record<string, SocketTranscriptFallback>,
  // A `/thread/<slug>` URL whose destination is not settled yet. The router cannot decide it alone: on
  // a cold load the board hasn't arrived, so it cannot say whether the slug is this project's thread.
  // The router parks the slug here and App resolves it the first render the board is authoritative
  // (see resolveRoutedThread). Parked slugs keep the address bar on /thread/<slug> meanwhile.
  routeThreadSlug: null as string | null,
  // Another project's thread, clicked open from the queue and not yet drawn: its drawer cannot exist until
  // the page has rebound to that project and its board has landed, which on a loaded machine took seconds
  // (2026-10-01: ~5s on WSL for "Show earlier messages"). PendingThreadSheet draws the drawer's frame for
  // it at once, and resolveRoutedThread hands over to the real drawer, already open, in the same commit.
  // Deliberately NOT reset by resetProjectState: it is set on the way OUT of one project, for the next.
  pendingOpen: null as PendingOpen | null,
  // The slug whose BOARD surface (thread drawer or queue card) is currently wearing
  // `view-transition-name: thread-chat`, so the /full page's thread column has somewhere to morph
  // back into when the fullscreen page is left for the board (browser Back, or the collapse icon).
  // Set render-phase by primeFullscreenReturn and cleared on a timer just past the animation — a
  // surface that KEPT the name would collide with the next door click's imperative tag, and duplicate
  // view-transition-names abort the whole transition.
  vtReturnTarget: null as string | null,
  // Transient bottom-center toast (e.g. "Steer failed …" when an eager reply is rejected). `id` bumps per call so
  // repeat toasts re-trigger the fade. Rendered by <Toaster>; null when nothing is showing.
  toast: null as { id: number; text: string; detail?: string; spinner?: boolean; sticky?: boolean; duration?: number; link?: ToastLink; action?: ToastAction } | null,
  // The /full page's SPLIT file viewer. True only while StandaloneThreadPage is mounted; while it is,
  // a file click renders BESIDE the thread (the thread column slides left) instead of as an overlay
  // drawer — the whole point of /full is seeing the transcript, and a sheet over it defeated that.
  // The queue page keeps the drawer: its main column is the queue, not the thread being read.
  splitFileViewer: false,
  // Keep each reader mounted under the next so following a link preserves its scroll and view mode.
  // Instance ids (not paths) also let A → B → A unwind through both visits independently.
  filePanels: [] as { id: number; path: string; closing?: boolean }[],
  // (Selected-context items staged for a prompt box's next message lived here, keyed by thread slug, until
  // 2026-10-01; they are keyed by draft and persisted with it now — lib/stagedContext.ts.)
  //
  // The EDITOR WINDOWS connected over the editor bridge (packages/vscode): which app each is and whether
  // it takes file opens. MACHINE-WIDE — one Frizz, every project — so a project switch leaves it alone.
  // Read at boot (`editorWindows`) and replaced whole by every `editors` event (lib/editorBridge.ts);
  // the settings drawer marks the External app that is connected, and the first connection offers it.
  editorWindows: [] as EditorWindowSummary[],
  // The in-app PICTURE VIEWER (components/ImageViewer), over every page and drawer. `paths` is what
  // ←/→ step through: the pictures rendered in the same card, drawer or page as the one clicked, in
  // reading order (imageGalleryFor in lib/local-file-links.ts), so a worker's before/after shots are
  // one keypress apart. null while closed. Not a drawer-stack layer — it is modal, it covers the
  // stack, and closing it must leave every layer beneath exactly as it was. `project` is set when the
  // pictures belong to another project's card, as a file reader's `scope` is.
  imageViewer: null as { paths: string[]; index: number; project?: string } | null,
})

export function openNewThread(): void {
  store.showNewThread = true
}

// Open the GitHub picker modal (batch-dispatch from issues/PRs). The trigger that calls this is
// itself gated on gh being authed + in a GitHub repo, so the modal only opens when the RPCs can serve.
export function openGithubPicker(): void {
  store.showGithubPicker = true
}

export function closeGithubPicker(): void {
  store.showGithubPicker = false
}

let toastSeq = 0
// A toast's "Open thread". `project` is the slug of the project the thread was started IN, captured when
// it was started: a slug names a thread only within its project, and by the time the toast is clicked
// the page may be another project's — on the cross-project page, one dispatch and one click on another
// project's card apart.
export type ToastLink = { label: string; slug: string; project?: string }
// A toast's own verb — the snooze confirmation's "Undo". A callback where `link` is data, because the
// act belongs to whoever raised the toast: its thread's project client, and the card it faded out.
export type ToastAction = { label: string; run: () => void }
export function showToast(text: string, opts?: { detail?: string; spinner?: boolean; sticky?: boolean; duration?: number; link?: ToastLink; action?: ToastAction }) {
  store.toast = { id: ++toastSeq, text, ...opts }
}

// ── drawer stack ─────────────────────────────────────────────────────────────────────────────────
let drawerSeq = 0
let drawerOpenSeq = 0
type Drawer = (typeof store.drawers)[number]

// Kind is part of the identity: a chat thread and its document can deliberately stack, while a
// second request for that same chat (or document) must reuse the existing layer.
function sameDrawer(a: Drawer, b: Pick<Drawer, "kind" | "slug" | "path" | "subId">): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === "file") return a.path === b.path
  if (a.kind === "subagent" || a.kind === "shell" || a.kind === "terminal") return a.subId === b.subId
  return a.slug === b.slug
}

// The only layers a new drawer legitimately stacks OVER are its own thread's family: a sub-agent
// transcript, a shell's output or a terminal over its parent thread/doc, and a thread⇄doc pair sharing a
// slug. Everything else — sibling threads, sibling sub-agents — is a lateral move, not a drill-in.
function stacksOver(below: Drawer, next: Pick<Drawer, "kind" | "slug">): boolean {
  // A file reader is always a DRILL-IN: it is opened by clicking a link inside whatever is already
  // showing (a chat message, another document), so replacing that layer would close the very
  // prose the link was read from. It stacks over anything, its own kind included — following a doc's
  // link to a sibling doc and pressing Esc to come back is the whole point of a reader.
  if (next.kind === "file") return true
  if (next.kind === "subagent" || next.kind === "shell" || next.kind === "terminal") return (below.kind === "thread" || below.kind === "doc") && below.slug === next.slug
  if (next.kind === "doc") return below.kind === "thread" && below.slug === next.slug
  if (next.kind === "thread") return below.kind === "doc" && below.slug === next.slug
  return false
}

function openOrRaiseDrawer(next: Omit<Drawer, "id" | "closing" | "openedAt">): void {
  // ONE-DRAWER POLICY (maintainer 2026-07-21): opening a layer REPLACES every live layer it doesn't
  // logically stack over, so lateral moves (sidebar sibling thread/sub-agent clicks) swap the
  // open drawer instead of piling up; only drilling into the open thread's own child/doc stacks.
  const displaced = store.drawers.filter((d) => !d.closing && !sameDrawer(d, next) && !stacksOver(d, next)).map((d) => d.id)
  if (displaced.length) closeDrawersById(displaced)

  const matches = store.drawers.filter((drawer) => sameDrawer(drawer, next))
  if (!matches.length) {
    store.drawers.push({ ...next, id: ++drawerSeq, openedAt: ++drawerOpenSeq })
    return
  }

  // Keep the newest non-closing instance. This heals old duplicate state too: one logical layer
  // remains, so closing a drawer can never reveal an identical one beneath it.
  const existing = [...matches].reverse().find((drawer) => !drawer.closing) ?? matches[matches.length - 1]!
  const { closing: _closing, ...liveExisting } = existing
  const reopened = { ...liveExisting, ...next, openedAt: ++drawerOpenSeq }
  store.drawers = [...store.drawers.filter((drawer) => !sameDrawer(drawer, next)), reopened]
  // Existing layers are already mounted. Let their local focus manager restore focus after Valtio
  // publishes the reordered/reopened stack without manufacturing another component instance.
  queueMicrotask(() => focusDrawer(existing.id))
}

// Slugs whose panel is up in a live drawer — the chat sheet, or one of the thread's terminals (a terminal
// layer's slug is its thread's). The queue makes these threads' cards inert (AllQueues.tsx): a card is a
// second copy of the same questions and reply box — and, for a terminal waiting at a prompt, of the same
// live screen — so a second live copy under the sheet would take keys meant for the drawer (maintainer
// 2026-09-23). A closing layer does not count, so the card wakes as the drawer slides off it. A doc
// drawer shows different content and leaves the card alone.
export function slugsInThreadDrawers(drawers: readonly Pick<Drawer, "kind" | "slug" | "closing">[]): Set<string> {
  return new Set(drawers.filter((d) => !d.closing && (d.kind === "thread" || d.kind === "terminal")).map((d) => d.slug))
}

// The THREAD the drawer stack is showing: the topmost live layer that belongs to one — its chat, its
// doc, its terminal, or a sub-agent / shell drill-in (whose slug is the parent thread's). A reader
// layer names a FILE, so the walk passes under it to the thread it was opened from. A closing layer
// does not count: its row lets go the moment the slide-out starts, as the URL does. The project list
// lights this thread's row (Sidebar.tsx rowWashClass).
export function drawerThreadSlug(drawers: readonly Pick<Drawer, "kind" | "slug" | "closing">[]): string | null {
  for (let i = drawers.length - 1; i >= 0; i--) {
    const d = drawers[i]
    if (d.closing || d.kind === "file") continue
    return d.slug
  }
  return null
}

export function pushDrawer(kind: "thread" | "doc", slug: string, opts?: { routed?: boolean }): void {
  openOrRaiseDrawer({ kind, slug, routed: opts?.routed })
}

// Open one of a thread's TERMINALS (lib/threadTerminals.ts) as a layer over the thread it belongs to.
// `slug` is the THREAD, as for a sub-agent or a shell, so the layer is that thread's family: it stacks over
// the thread's own drawer and lights the thread's row. `id` is the terminal's /term handle and dedupe key.
export function pushTerminalDrawer(slug: string, id: string, opts?: { label?: string }): void {
  openOrRaiseDrawer({ kind: "terminal", slug, subId: id, label: opts?.label })
}

// Open a sub-agent's transcript as a new drawer layer OVER whatever's on top (typically the thread it
// was dispatched from). `slug` is the PARENT thread; `subId` is the dispatch tool_use id (the RPC
// handle). Deduped on subId so a double-click / re-click doesn't stack duplicates.
export function pushSubAgentDrawer(slug: string, subId: string, opts: { label: string; subagentType?: string; startedAt?: string }): void {
  openOrRaiseDrawer({ kind: "subagent", slug, subId, label: opts.label, subagentType: opts.subagentType, startedAt: opts.startedAt })
}

export function pushBackgroundShellDrawer(slug: string, id: string, opts: { label: string; startedAt?: string }): void {
  openOrRaiseDrawer({ kind: "shell", slug, subId: id, label: opts.label, startedAt: opts.startedAt })
}

// Open a thread from a listing/notification click-through, always as a drawer. Until 2026-09-28 a
// QUEUED thread short-circuited to its card on a project's board, where the card was the whole panel;
// on Everything a card is a summary and the thread itself is one level down, so there is no such card
// to land on. Routing is by runtime: a thread with NO session ever spawned (runtime "none" — no
// transcript, the chat drawer would be an empty placeholder) opens its frizz DOCUMENT drawer instead —
// there the doc IS the substance. Anything with a session (live or exited — exited transcripts are
// worth seeing) opens the chat drawer. The doc drawer carries the adopt ("Start a session") affordance.
export function openThread(slug: string): void {
  const t = store.board?.threads.find((x) => x.id === slug)
  pushDrawer(t && t.runtime === "none" ? "doc" : "thread", slug)
}

// Settle a parked `/thread/<slug>` URL, now that the board can say whose thread it is. A deep link
// deliberately asks for the CHAT surface even for a session-less thread (unlike openThread's
// doc-routing), so this pushes the thread layer rather than delegating. `routed` so a cold page paints
// the sheet already open instead of animating a phantom backdrop in.
export function resolveRoutedThread(): void {
  const slug = store.routeThreadSlug
  if (!slug || !store.board) return
  store.routeThreadSlug = null
  const route = resolveThreadRoute(store.board, slug)
  // A slug THIS project does not have. Since one server started serving every project that is usually
  // a thread another project has — and `/thread/<slug>` is the exact shape every pre-singleton
  // bookmark and every agent-written cross-reference uses, so it is not a rare typo. Pushing the
  // drawer anyway opened an empty sheet over the page that said nothing and offered nothing.
  // The `/full` page already knows how to recover: <MissingThread> asks `threadLocate` which project
  // owns the slug and relocates there. Hand it over rather than growing a second copy of that.
  // The frame PendingThreadSheet has been showing for this thread gives way to the real drawer in this
  // same store write, so the real one must paint already open (`routed`) rather than slide in a second time.
  const pending = store.pendingOpen?.slug === slug && store.pendingOpen.projectSlug === store.board.projectSlug
  if (pending || route.kind === "missing") store.pendingOpen = null
  if (route.kind === "missing") {
    if (typeof location !== "undefined") location.replace(standaloneThreadHref(slug))
    return
  }
  pushDrawer("thread", slug, { routed: pending || !openedInPlace() })
}

// Navigation state for a thread opened IN PLACE by a click on the page — the cross-project page opening
// another project's thread, which has to change the URL (the focus moves) where a store-first open of
// the focus's own thread does not. Its drawer slides in like any clicked one; `routed` is for a URL that ARRIVED (a cold deep link,
// Back), where the sheet must already be open on the first paint.
export const IN_PLACE_OPEN_STATE = { inPlace: true } as const

function openedInPlace(): boolean {
  if (typeof history === "undefined") return false
  const usr = (history.state as { usr?: unknown } | null)?.usr
  return typeof usr === "object" && usr !== null && (usr as { inPlace?: unknown }).inPlace === true
}

// THE FULLSCREEN DOOR, PLAYED BACKWARDS. react-router re-arms the door's view transition for the POP
// back out of /full (it remembers which path pairs transitioned), and the collapse icon opts in
// explicitly — but the transition can only morph the /full thread column into a drawer that EXISTS and
// IS NAMED in the page's FIRST commit, the one the new-state snapshot reads. Left to the ordinary flow,
// the drawer arrives two effects later (applyPath parks the slug, resolveRoutedThread settles it) and
// nothing on the page ever wears the name, so Back played as a bare crossfade (maintainer 2026-09-02:
// "when I hit the back button on full-screen view, it doesn't undo the animation"). The fullscreen page
// records its slug on every render; routes.tsx CrossProjectPage consumes it in a render-phase
// initializer — the mirror of the fullscreen page's own render-phase drawer clear.
let lastStandaloneSlug: string | null = null
export function noteStandaloneThreadRender(slug: string): void {
  lastStandaloneSlug = slug
}

/** Whether the page now opens on the drawer the address names — the router takes that address as absorbed
 *  (lib/router.ts primeReturnFromFullscreen). */
export function primeFullscreenReturn(routedSlug: string | undefined): boolean {
  // The forward door started its morph from the visible part of the drawer; this render is inside the
  // REVERSE transition's update callback, so dropping that here — before the browser builds the reverse
  // leg's pseudo-elements — is what hands the return morph back to the browser's own keyframes.
  // Unconditional: any way back to the page retires it (lib/fullscreenMorph).
  disarmFullscreenMorph()
  const slug = lastStandaloneSlug
  lastStandaloneSlug = null
  if (!slug) return false
  // Name the drawer this slug renders as — ThreadSheet checks this.
  // Cleared well past the 200ms animation: clearing in an effect could beat the new-state capture
  // and un-name the element mid-transition.
  store.vtReturnTarget = slug
  if (typeof window !== "undefined") {
    window.setTimeout(() => {
      if (store.vtReturnTarget === slug) store.vtReturnTarget = null
    }, 600)
  }
  // The drawer itself, when the return URL names this thread: the same painted-open push
  // resolveRoutedThread would make — its chat — just in the commit
  // the snapshot actually reads; applyPath then finds the layer already present and leaves it be. A
  // QUEUED thread returns to its drawer too. It was skipped until 2026-09-28, for the project board,
  // where a queued thread's surface was its card; on the one page the card is a summary and the drawer
  // the thread, so the skip only sent the return one effect late, after the morph had nothing to land on.
  if (routedSlug !== slug || !store.board) return false
  const route = resolveThreadRoute(store.board, slug)
  if (route.kind !== "found") return false
  if (store.drawers.some((d) => d.kind === "thread" && d.slug === slug && !d.closing)) return true
  pushDrawer("thread", slug, { routed: true })
  return true
}

// Open a file that lives on disk in Frizz's OWN reader — a `.md` rendered, anything else as source —
// rather than handing the path to the desktop opener. Every link to one routes here
// (lib/local-file-links.ts): agent prose citing a repo doc, an inline-code path that resolved to a
// file, an attached log. `path` is the absolute path the server will re-gate; the basename is the
// header title. Queue drawers are deduped on path. `scope` is the card's project when the link was
// clicked on another project's card (AllQueuesCard ProjectLinkScope): the drawer then reads through that
// project's gate and renders against its repo, as the card itself does.
export function pushFileReader(path: string, scope?: MarkdownScope | null): void {
  // On /full the reader is a SPLIT PANEL beside the thread, not a sheet over it — route every
  // file open there while that page is mounted, stacking links from the transcript AND reader.
  if (store.splitFileViewer) {
    openFilePanel(path)
    return
  }
  openOrRaiseDrawer({ kind: "file", slug: path, path, label: basename(path), ...(scope ? { scope } : {}) })
}

// ── the picture viewer ───────────────────────────────────────────────────────────────────────────

// Show `path` in the picture viewer. `gallery` is the set ←/→ step through; a path that is not in it
// (a Markdown link TO a picture, which is text rather than a rendered one) opens on its own. `project`
// as for pushFileReader: the pictures are another project's card's.
export function openImageViewer(path: string, gallery: readonly string[] = [], project?: string): void {
  const paths = gallery.includes(path) ? [...gallery] : [path]
  store.imageViewer = { paths, index: paths.indexOf(path), ...(project ? { project } : {}) }
}

export function closeImageViewer(): void {
  store.imageViewer = null
}

// Clamped, not wrapped: the ends are where the rendered pictures end, and a viewer that silently
// jumps from the last shot back to the first reads as having shown a new one.
export function stepImageViewer(step: 1 | -1): void {
  const viewer = store.imageViewer
  if (!viewer) return
  viewer.index = Math.min(viewer.paths.length - 1, Math.max(0, viewer.index + step))
}

// ── the /full split file viewer ──────────────────────────────────────────────────────────────────
let filePanelSeq = 0

export function openFilePanel(path: string): void {
  store.filePanels.push({ path, id: ++filePanelSeq })
}

export function closeFilePanel(): void {
  const top = store.filePanels.at(-1)
  // A closing layer still owns the top until its slide finishes, like the drawer stack.
  if (!top || top.closing) return
  top.closing = true
  const id = top.id
  window.setTimeout(() => {
    store.filePanels = store.filePanels.filter((panel) => panel.id !== id)
  }, prefersReducedMotion() ? 0 : SHEET_CLOSE_MS)
}

export function popDrawer(): void {
  const top = store.drawers[store.drawers.length - 1]
  if (top) closeDrawersById([top.id])
}

export function topDrawer() {
  return store.drawers[store.drawers.length - 1]
}

// Mark a drawer-stack entry as animating-OUT the instant its slide begins, so the URL sync and
// topThreadSlug stop counting it BEFORE the ~210ms removal lands. Without this, a synchronous view
// change during the close window (e.g. browser-Back into a status list, or the palette's Queue
// action) would still see the present-but-closing layer and push a phantom /thread history entry.
export function markDrawerClosing(id: number): void {
  const d = store.drawers.find((x) => x.id === id)
  if (d) d.closing = true
}

// Exit timers are intentionally conditional. If the same logical drawer is reopened before its
// transition finishes, `openOrRaiseDrawer` clears closing and this old timer becomes a no-op.
export function removeDrawerAfterExit(id: number): void {
  const drawer = store.drawers.find((entry) => entry.id === id)
  if (drawer?.closing) store.drawers = store.drawers.filter((entry) => entry.id !== id)
}

// Unwind drawer-stack entries by id THROUGH their registered animated closers (the slide-out plays)
// instead of an instant `store.drawers = …` splice — the fix for "drawers animate in but not out"
// on the non-component close paths (router back/forward unwind, palette Queue). Any id whose drawer
// isn't mounted (no registered closer — e.g. at boot before components mount) is raw-filtered so the
// stack still settles correctly.
export function closeDrawersById(ids: number[]): void {
  const orphans: number[] = []
  for (const id of ids) if (!closeDrawerAnimated(id)) orphans.push(id)
  if (orphans.length) {
    const drop = new Set(orphans)
    store.drawers = store.drawers.filter((d) => !drop.has(d.id))
  }
}

// The slug of the topmost THREAD layer (for ⌘I, the URL, and other "current thread" consumers).
// Layers mid-close are skipped: they're sliding out and must not keep the URL pinned to /thread.
export function topThreadSlug(): string | null {
  for (let i = store.drawers.length - 1; i >= 0; i--) {
    const d = store.drawers[i]
    if (d.kind === "thread" && !d.closing) return d.slug
  }
  return null
}

// The slug the ADDRESS BAR names: the topmost thread layer. A thread's terminal, like its sub-agents and
// shells, is a drill-in the URL does not name — it stacks over the thread the address already names.
export function topRoutedSlug(): string | null {
  for (let i = store.drawers.length - 1; i >= 0; i--) {
    const d = store.drawers[i]
    if (d.kind === "thread" && !d.closing) return d.slug
  }
  return null
}

// THE DOOR. Every board that reaches the UI comes through one of these two functions, so this is where
// "is this even our project's board?" is asked — on the board's OWN evidence (the server stamps it with
// `projectSlug`), not on any client bookkeeping. Bookkeeping is what failed in `0fb8574`; a payload that
// names its own project cannot be talked into belonging here by a stale ref, a missed effect or a
// transport nobody re-pointed. See lib/projectOwnership.ts.
//
// Dropping is silent on purpose: the commonest way to arrive here foreign is a perfectly healthy race —
// a keyframe or an `rpc.board()` seed already on the wire when the operator switched projects — and a
// console warning per switch would be noise about the system working.

// A full board KEYFRAME arrives from SSE (React-free) — on connect and on resync. Just store it;
// every surface derives its own view of the thread list per render (there is no selection state to
// reconcile — the focus machine that needed one is gone).
export function setBoard(board: BoardSnapshot) {
  if (!ownedByThisPage(board.projectSlug)) return
  setGithubRepo(board.githubRepo)
  setLocalPathBase(board.projectDir, board.homeDir)
  setMentionIndex(board.projectSlug, board.threads)
  store.board = board
}

/**
 * Forget everything that belonged to the project we are leaving.
 *
 * The rail switches projects WITHOUT a document load, which used to do this for free. Every field
 * here is per-project, and carrying any of it across is a visible bug rather than stale data: a
 * drawer would stay open over a board that has never heard of its thread, and the row above the
 * prompt box would name — and link to — the repo you just left.
 *
 * Machine-wide state (the settings/notification mirror, the control-plane status, whether the palette
 * is open) is deliberately NOT touched — none of it changes when the project does.
 */
export function resetProjectState() {
  setGithubRepo(null)
  setLocalPathBase(null)
  setMentionIndex(null, null)
  resetGithubCards()
  store.board = null
  store.connection = "connecting"
  store.drawers = []
  store.filePanels = []
  store.imageViewer = null
  store.routeThreadSlug = null
  store.socketBoardFallback = null
  store.socketTranscriptFallbacks = {}
  store.showSettings = false
  store.showNewThread = false
  store.showGithubPicker = false
}

// STARTUP seed only (App fires an rpc.board() to paint before SSE connects). Unlike setBoard this must
// NOT clobber a board the SSE stream has already established + advanced with deltas — a late-resolving
// seed would otherwise revert applied deltas (the seq keeps advancing but the content rolls back). So
// it lands only when nothing is there yet; once the SSE keyframe has set the board, the seed is a no-op.
//
// "Nothing is there yet" is ALSO the state a project switch leaves behind (resetProjectState nulls the
// board), which is what made the ownership check load-bearing here rather than belt-and-braces: the
// previous project's in-flight seed lands into the emptied store and paints its threads under the new
// project's URL. The guard is the only thing standing between that race and the operator.
export function seedBoard(board: BoardSnapshot) {
  if (!ownedByThisPage(board.projectSlug)) return
  if (store.board !== null) return
  setGithubRepo(board.githubRepo)
  setLocalPathBase(board.projectDir, board.homeDir)
  setMentionIndex(board.projectSlug, board.threads)
  store.board = board
}

// Apply a per-thread delta IN PLACE (upsert/remove threads, patch board-level meta) — valtio's
// fine-grained reactivity means only the changed rows re-render (the audit's S2 fix), vs. setBoard's
// wholesale replace. Returns false when there's no base board to apply onto (caller must resync).
export function applyDelta(delta: BoardDelta): boolean {
  if (store.board === null) return false
  applyBoardDelta(store.board, delta)
  return true
}

export function threadBySlug(board: BoardSnapshot | null, slug: string | null): ThreadView | undefined {
  if (!board || !slug) return undefined
  return board.threads.find((t) => t.id === slug)
}
