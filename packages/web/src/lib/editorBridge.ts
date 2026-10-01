import type { QueryClient } from "@tanstack/react-query"
import { subscribe } from "valtio"
import type { EditorComposeItem, EditorWindowSummary, ProjectCard, Settings } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { isRemoteSession } from "../api/signOut.ts"
import { supervisorStatusQueryOptions } from "../api/supervisorStatus.ts"
import { getFrizzSupervisorStatus } from "../api/restart.ts"
import { publishMachineSettings } from "../hooks/useSettingsAutosave.tsx"
import { showToast, store, topThreadSlug } from "../store.ts"
import { innerPath, projectSlug } from "./base-path.ts"
import { rememberCrossProjectFocus } from "./crossProject.ts"
import { draftStore } from "./drafts.ts"
import { composeEdit, composeProjectsOf, composeTarget, type ComposeMove, type ComposeProject } from "./editorCompose.ts"
import { codeFilesDestination, connectedOpeners, EDITOR_OPENER_LABEL, editorOffer, parseOffered, type EditorOpener } from "./editorWindows.ts"
import { splitComposerValue } from "./imagePaths.ts"
import { MOBILE_QUERY } from "./mobile.ts"
import { homeHref, projectViewHref, viewAt } from "./pageView.ts"
import { basename } from "./paths.ts"
import { prefs } from "./prefs.ts"
import { readProjectsQueues } from "./projectsQueuesRead.ts"
import { spaNavigate } from "./router.ts"
import { addContextItem, stagedItems } from "./stagedContext.ts"
import { parseStandaloneThreadPath } from "./standaloneThreadRoute.ts"

// THE PAGE'S HALF OF THE EDITOR BRIDGE (packages/vscode; plans/vscode-extension.md). Three jobs, all
// machine-wide, so this module is set up once per page (main.tsx) rather than per project:
//
//  1. WHICH EDITOR WINDOWS ARE CONNECTED — store.editorWindows, read at boot and replaced by every
//     `editors` event. The settings drawer marks the External app that has a window behind it.
//  2. THE FIRST-CONNECTION OFFER — the first time this browser sees an accepting VS Code or Cursor window
//     while its code files go elsewhere, a toast offers to send them there. Once per editor per browser.
//  3. PROMPT-BOX INSERTS — "Add to Frizz prompt" in an editor leaves an item on the server and pings every
//     page (`compose-pending`). The page the human is LOOKING AT claims it (`composeTake`, first caller
//     wins) and puts it in the box in front of them — on the ping when it has focus, else on the focus
//     that follows (the human switching from their editor to this tab), and once at boot. There is no
//     leader election and no tab id: focus is the election, and the server's claim is the lock.

let queryClient: QueryClient | null = null
const OFFERED_KEY = "frizz.editorOffered"

export function initEditorBridge(client: QueryClient): void {
  queryClient = client
  void refreshEditorWindows()
  // The same wake signals the live feed uses (api/socket.ts). A refresh as well as a claim: an `editors`
  // event published while the feed was re-binding to another project is one this page never heard.
  const wake = () => {
    void drainCompose()
    void refreshEditorWindows()
  }
  window.addEventListener("focus", wake)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") wake()
  })
  if (document.hasFocus()) void drainCompose()
}

// ── 1. the connected windows ───────────────────────────────────────────────────────────────────────

async function refreshEditorWindows(): Promise<void> {
  let windows: EditorWindowSummary[] = []
  try {
    windows = (await rpc.editorWindows()).windows
  } catch {
    // A server from before the editor bridge has no such procedure: no windows, and nothing to say.
  }
  setEditorWindows(windows)
}

/** The windows, whole — from the boot read, a refresh, or an `editors` event (api/board-stream.ts). */
export function setEditorWindows(windows: EditorWindowSummary[]): void {
  store.editorWindows = windows
  void considerEditorOffer()
}

// ── 2. the first-connection offer ──────────────────────────────────────────────────────────────────

let considering = false

async function considerEditorOffer(): Promise<void> {
  // Only on a page someone is looking at — a toast nobody saw would still spend the once-per-browser
  // offer — and never over the settings drawer, whose own draft would write the old choice back.
  if (typeof document === "undefined" || considering || document.visibilityState !== "visible" || store.showSettings || store.toast?.sticky) return
  const phone = window.matchMedia?.(MOBILE_QUERY).matches ?? false
  // Could anything be offered at all, whatever the settings say? Asked first so an `editors` event that
  // changes nothing worth offering costs no settings or supervisor read.
  if (!editorOffer({ windows: store.editorWindows, codeFiles: "frizz", opener: undefined, offered: readOffered(), phone, remote: false })) return
  considering = true
  try {
    const [settings, remote] = await Promise.all([readSettings(), readRemoteSession()])
    const kind = editorOffer({ windows: store.editorWindows, codeFiles: prefs.codeFiles, opener: settings.localFileOpener, offered: readOffered(), phone, remote })
    if (!kind) return
    rememberOffered(kind)
    const label = EDITOR_OPENER_LABEL[kind]
    showToast(`${label} is connected. Open code files there?`, {
      action: { label: `Use ${label}`, run: () => void sendCodeFilesTo(kind) },
      duration: 12_000,
    })
  } catch {
    // Settings unreadable right now: offer on a later event or focus rather than guess.
  } finally {
    considering = false
  }
}

function readOffered(): Set<string> {
  try {
    return parseOffered(localStorage.getItem(OFFERED_KEY))
  } catch {
    return new Set()
  }
}

function rememberOffered(kind: EditorOpener): void {
  try {
    localStorage.setItem(OFFERED_KEY, JSON.stringify([...readOffered(), kind]))
  } catch {
    // Storage disabled: the offer may come again next load, which is the lesser harm.
  }
}

// ── 2b. where an automatic browser's code files go ─────────────────────────────────────────────────

/**
 * Whether a code-file click on an "auto" browser goes to the External app (editorWindows.ts
 * codeFilesDestination), for lib/local-file-links.ts. Only asked while an editor window that takes opens
 * is connected, so a page with none never reads anything. What it needs beyond the windows — the
 * External app, and whether this is a remote session — comes from the page's caches when they hold it
 * (ensureQueryData: no request per click), and a failed read is the reader, which always works.
 */
export function autoCodeFilesMayGoToEditor(): boolean {
  return prefs.codeFiles === "auto" && connectedOpeners(store.editorWindows).size > 0
}

export async function autoCodeFilesGoToEditor(): Promise<boolean> {
  if (!autoCodeFilesMayGoToEditor()) return false
  try {
    const [settings, remote] = await Promise.all([
      queryClient ? queryClient.ensureQueryData({ queryKey: ["settingsGet"], queryFn: () => rpc.settingsGet() }) : rpc.settingsGet(),
      queryClient ? queryClient.ensureQueryData(supervisorStatusQueryOptions).then(isRemoteSession) : getFrizzSupervisorStatus().then(isRemoteSession),
    ])
    const phone = typeof window !== "undefined" && (window.matchMedia?.(MOBILE_QUERY).matches ?? false)
    return codeFilesDestination({ codeFiles: prefs.codeFiles, windows: store.editorWindows, opener: settings.localFileOpener, phone, remote }) === "editor"
  } catch {
    return false
  }
}

// The supervisor's word on whether this page came in over remote access (api/signOut.ts), through the
// one shared poll's cache when it is fresh. Strict like isRemoteSession: an unreachable supervisor reads
// "not remote", and the phone check still stands beside it.
async function readRemoteSession(): Promise<boolean> {
  const status = queryClient ? await queryClient.fetchQuery(supervisorStatusQueryOptions) : await getFrizzSupervisorStatus()
  return isRemoteSession(status)
}

async function readSettings(): Promise<Settings> {
  if (!queryClient) return rpc.settingsGet()
  return queryClient.fetchQuery({ queryKey: ["settingsGet"], queryFn: () => rpc.settingsGet() })
}

// Both halves of "code files go to the editor": this browser's "Open code files" (prefs) and the
// machine's External app. The settings write carries the WHOLE object (useSettingsAutosave), so it is
// built on a fresh read rather than whatever this page cached, and published to every project's cached
// copy the way the drawer's own save is — which is also how a Settings drawer open under the toast
// learns of it rather than writing its old External app back (useSettingsAutosave adoptPublishedSettings).
//
// The browser half is switched only once the machine half has landed. It was switched first until
// review C7, so a failed write left this browser sending every code-file click to the OLD External app
// (System, say) instead of the reader — a change nobody asked for, under a toast that said only that
// the External app could not be set. Exported for its test.
export async function sendCodeFilesTo(kind: EditorOpener): Promise<void> {
  const label = EDITOR_OPENER_LABEL[kind]
  try {
    const current = await rpc.settingsGet()
    const saved = await rpc.settingsSet({ ...current, localFileOpener: kind })
    prefs.codeFiles = "editor"
    if (queryClient) {
      queryClient.setQueryData(["settingsGet"], saved)
      publishMachineSettings(queryClient, saved)
    }
    showToast(`Code files open in ${label}`)
  } catch (error) {
    showToast(`Couldn't set the External app to ${label}`, { detail: error instanceof Error ? error.message.slice(0, 100) : undefined })
  }
}

// ── 3. prompt-box inserts ──────────────────────────────────────────────────────────────────────────

/** `compose-pending`: claim now only if this page is the one in front; else the next focus claims it. */
export function composePending(): void {
  if (typeof document !== "undefined" && document.hasFocus()) void drainCompose()
}

let draining: Promise<void> | null = null
let drainAgain = false

/** Claim and insert every waiting item, one at a time, in the order the editor sent them. */
export function drainCompose(): Promise<void> {
  if (draining) {
    drainAgain = true
    return draining
  }
  draining = (async () => {
    try {
      do {
        drainAgain = false
        // A cold page: the drawer the address names and the board its drafts are keyed by arrive with
        // the first board. An item inserted before then would miss a drawer that is about to open.
        await boardOrTimeout()
        for (;;) {
          let item: EditorComposeItem | null
          try {
            item = (await rpc.composeTake({})).item
          } catch {
            return // a server without the bridge, or one restarting: the next focus asks again
          }
          if (!item) break
          await insertComposeItem(item)
        }
      } while (drainAgain)
    } finally {
      draining = null
    }
  })()
  return draining
}

const THREAD_BOX = 'textarea[data-surface="chatComposer"]'
const NEW_THREAD_BOX = 'textarea[data-surface="newComposer"]'

async function insertComposeItem(item: EditorComposeItem): Promise<void> {
  const thread = threadInFront()
  const board = store.board ? { projectDir: store.board.projectDir, projectSlug: store.board.projectSlug } : undefined
  const projects = thread && board ? [] : await readComposeProjects()
  const target = composeTarget({
    // The project list could not be read: the item goes to the box in front of the human rather than
    // nowhere — the server has already handed it over, and a refusal would lose it.
    item: projects ? item : {},
    thread,
    board,
    pageSlug: projectSlug(),
    view: viewAt(location.pathname, location.search).kind,
    projects: projects ?? [],
  })
  if (target.kind === "refused") {
    showToast(`Couldn't add ${basename(item.path)} to the prompt box`, { detail: target.reason, duration: 6000 })
    return
  }
  const edit = composeEdit({ value: draftStore.get(target.key), staged: stagedItems(target.key), item, projectDir: target.projectDir })
  // The draft first, then the chip: a mounted box sweeps any staged item whose token its draft lacks.
  draftStore.set(target.key, edit.value)
  if (edit.stage) addContextItem(target.key, edit.stage)
  if (target.kind === "new") await movePage(target.move)
  // The desktop app's window does not come forward on `focus()` (api/board-stream.ts notify does the same).
  ;(window as { frizzDesktop?: { focusWindow?(): void } }).frizzDesktop?.focusWindow?.()
  await placeCaret(target.kind === "thread" ? THREAD_BOX : NEW_THREAD_BOX, splitComposerValue(edit.value).prose, edit.caret)
}

/**
 * The thread the human is reading: the topmost thread drawer, or the /full page's thread — which the
 * ADDRESS names, at any width. It was read off `store.splitFileViewer` until review C4, a layout flag the
 * /full page sets only at 1200px and wider, so in a window tiled half-width beside the editor an insert
 * went to a new-thread draft that page never shows, or navigated the human off the thread they were
 * reading. Exported for its test.
 */
export function threadInFront(): { slug: string; sessionId?: string } | undefined {
  const slug = topThreadSlug() ?? parseStandaloneThreadPath(innerPath())
  if (!slug) return undefined
  const thread = store.board?.threads.find((candidate) => candidate.id === slug)
  return thread ? { slug, sessionId: thread.sessionId } : undefined
}

async function readComposeProjects(): Promise<ComposeProject[] | null> {
  try {
    // The page's own reads, through its cache when they are fresh (AllQueues.tsx and routes.tsx share these keys).
    const [cards, queues] = await Promise.all([
      queryClient
        ? queryClient.fetchQuery({ queryKey: ["projectsList"], queryFn: () => rpc.projectsList(), staleTime: 5_000 })
        : rpc.projectsList(),
      queryClient
        ? queryClient.fetchQuery({ queryKey: ["projectsQueues"], queryFn: readProjectsQueues, staleTime: 5_000 })
        : readProjectsQueues(),
    ])
    return composeProjectsOf(cards as ProjectCard[], queues)
  } catch {
    return null
  }
}

/**
 * Show the box the item went into, with the page's own verbs: focused elsewhere, focus its project (the
 * switcher's navigation, so Back undoes it); showing All projects, make it the pick (the picker's — a
 * drawer open on the page binds it to the drawer's project, so aiming the box goes home). Resolves once
 * the page shows that project, so the next item in the same claim sees where the page now is.
 */
async function movePage(move: ComposeMove): Promise<void> {
  if (move.kind === "stay") return
  if (move.kind === "focus") spaNavigate(projectViewHref(move.slug))
  else {
    rememberCrossProjectFocus(move.id)
    if (innerPath() !== "/") spaNavigate(homeHref(), { replace: true })
  }
  await until(() => projectSlug() === move.slug, 3_000)
}

/** Focus the box once it shows the new draft — it may be remounting under a project switch — and put the caret after the insert. */
async function placeCaret(selector: string, prose: string, caret: number): Promise<void> {
  let box: HTMLTextAreaElement | undefined
  await until(() => {
    box = [...document.querySelectorAll<HTMLTextAreaElement>(selector)].find((el) => el.value === prose && el.getClientRects().length > 0)
    return box !== undefined
  }, 3_000)
  if (!box) return
  box.focus({ preventScroll: false })
  box.setSelectionRange(caret, caret)
}

function boardOrTimeout(): Promise<void> {
  if (store.board) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      stop()
      window.clearTimeout(timer)
      resolve()
    }
    const stop = subscribe(store, () => {
      if (store.board) done()
    })
    const timer = window.setTimeout(done, 5_000)
  })
}

/** Poll a condition until it holds or `ms` passes — a timer, not a frame, so a hidden tab still gets there. */
function until(holds: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  return new Promise((resolve) => {
    const check = () => {
      if (holds() || Date.now() > deadline) resolve()
      else window.setTimeout(check, 30)
    }
    check()
  })
}
