// THE FRIZZ SIDEBAR — a view in its own activity-bar container that IS the Frizz page: one iframe of the
// discovered origin, `?embed=vscode&theme=…&project=…`, relayed to the extension by a script in the
// webview document (sidebar-html.ts). The queue, the threads and the composers are the app's own, live
// over its own socket; what this file adds is what a frame cannot do for itself — keys VS Code would
// otherwise never see, files and links opened in the editor, VS Code's theme, the Ready badge, the
// editor commands' selections put straight into a composer, and the HEADER: the page draws none in the
// sidebar, so VS Code's own title row above the frame carries the header's doors (`frizz:command`), shown
// by the page's view (`frizz:route` → the `frizz.sidebarView` context key), and the badge's tooltip carries
// its counts. Design: plans/vscode-extension.md § The sidebar; the wire:
// packages/shared/src/embed-protocol.ts; the pure rules: embed.ts.
//
// Only `import type` from vscode, like app.ts.

import { randomUUID } from "node:crypto"
import type * as vscode from "vscode"
import type { EditorOpen } from "@frizz/shared/editor-protocol"
import type {
  EmbedAddContextMessage,
  EmbedCommandMessage,
  EmbedComposeMessage,
  EmbedComposedMessage,
  EmbedEditorContextMessage,
  EmbedHostMessage,
  EmbedHostStateMessage,
  EmbedNavigateMessage,
  EmbedPageMessage,
  EmbedRouteMessage,
} from "@frizz/shared/embed-protocol"
import { chordCommand, embedTheme, embedUrl, frameTarget, parsePageMessage } from "./embed.ts"
import { frameDocument, messageDocument, nonce, type ViewAction } from "./sidebar-html.ts"

type Vscode = typeof vscode

export const SIDEBAR_VIEW = "frizz.sidebar"
/** The command VS Code generates for every view: reveal it, open it if it never was, and focus it. */
export const SIDEBAR_FOCUS = `${SIDEBAR_VIEW}.focus`
/**
 * The context key the title row's buttons show by: the page's view ("queue", "thread", "settings",
 * "other"), or "" while no page has said where it is — a loading or missing page, whose buttons could
 * do nothing.
 */
export const SIDEBAR_VIEW_KEY = "frizz.sidebarView"

/**
 * How long a page gets to say `frizz:ready` before the view offers Reload. An installed Frizz boots its
 * page in a second or two; a Frizz run from source serves ~250 unbundled modules through Vite, which took
 * 13s and 42s to load on a busy machine (scripts/e2e-sidebar.ts, 2026-10-01) — and offered Reload under
 * a page that was only slow. An older Frizz, which has no embed mode, never says it, and its page still
 * shows under the bar.
 */
const READY_HINT_MS = 20_000
/** Status and project pushes arrive a frame apart after a connect; one render for the pair. */
const REFRESH_DEBOUNCE_MS = 200
const EVENTS_KEPT = 50

export interface SidebarHost {
  /** Where Frizz is: the connected origin, else the last discovery's. */
  origin(): string | undefined
  /** The project this window's folders map to, if any. */
  projectSlug(): string | undefined
  /** What to say when there is no Frizz to frame — the connection's own words, or undefined while it is still looking. */
  notFound(): string | undefined
  openFile(message: EditorOpen): Promise<{ ok: boolean; error?: string }>
  openInBrowser(): void
  reconnect(): void
  /** The page asked for the editor's context in its composer (`frizz:add-context`); resolves to what came of it, for the record. */
  addContext(message: EmbedAddContextMessage): Promise<string>
  /** What the page shows of the extension's own state (`frizz:host-state`): posted on ready, and by `pushState`. */
  hostState(): Omit<EmbedHostStateMessage, "type">
  /** The page's eye: share the editor with Frizz or stop (`frizz:share-editor`); resolves to what came of it. */
  setShareEditor(on: boolean): Promise<string>
  log: { info(line: string): void; warn(line: string): void }
}

/** What the view shows and did, for the end-to-end suite (FrizzExtensionApi.sidebar). */
export interface SidebarSnapshot {
  opened: boolean
  visible: boolean
  ready: boolean
  /** The "hasn't finished loading" bar is showing over the frame. */
  hinted: boolean
  /** The frame's address, after asExternalUri, when it shows the page. */
  url?: string
  /** The copy it shows instead of the page. */
  message?: string
  badge?: number
  /** The badge's tooltip: the page's counts when it said them, else the Ready count. */
  badgeTooltip?: string
  /** What `frizz.sidebarView` was set to, "" for none. */
  view: string
  /** The page's address for what it shows, from its last `frizz:route`. */
  href?: string
  /** Page messages as handled: the type, and what came of it (a command run, "ignored", "opened", "missing"…). */
  events: { type: string; outcome: string }[]
}

export interface Sidebar {
  /** The view has been opened in this window and not closed since. */
  opened(): boolean
  /** The page in the frame said `frizz:ready` and is still the page there. */
  ready(): boolean
  /** Re-read where Frizz is and this window's project, and re-frame only when either changed. */
  refresh(): void
  /** Frame the page afresh. */
  reload(): void
  setBadge(ready: number): void
  /** Bring the view into sight; `preserveFocus` leaves the caret where it is (in the editor). */
  reveal(preserveFocus: boolean): Promise<void>
  /** Resolves true once the page is ready, false when it will not be (no page to frame) or after `ms`. */
  waitReady(ms: number): Promise<boolean>
  /** Post a compose to the page and wait for its answer; undefined when it was not ready or did not answer within `ms`. */
  compose(input: Omit<EmbedComposeMessage, "type" | "id">, ms: number): Promise<EmbedComposedMessage | undefined>
  navigate(to: EmbedNavigateMessage["to"]): Promise<boolean>
  /** The page's address for what the view shows (its last `frizz:route`), while it is in sight; else undefined. */
  href(): string | undefined
  /** Post to the page if it is ready; false if it is not, or the post failed. */
  post(message: EmbedEditorContextMessage | EmbedCommandMessage): Promise<boolean>
  /** The extension's state the page shows changed (sharing, the chords): tell a ready page. */
  pushState(): void
  /** Called with true when the page in the frame says it is ready, and false when that page is gone. */
  onReady(listener: (ready: boolean) => void): void
  snapshot(): SidebarSnapshot
}

export function registerSidebar(api: Vscode, context: vscode.ExtensionContext, host: SidebarHost): Sidebar {
  let view: vscode.WebviewView | undefined
  /** `origin project` of the page in the frame; a change to either is a different page. */
  let framedKey: string | undefined
  let frameUrl: string | undefined
  /** The origin of the page in the frame — the only one a route's address may be on. */
  let frameOrigin: string | undefined
  /** The page's address for what it shows, from its last route (⋯ Open in browser opens it). */
  let routeHref: string | undefined
  let routeCounts: string | undefined
  let message: string | undefined
  let ready = false
  let hinted = false
  let renders = 0
  let readyTimer: NodeJS.Timeout | undefined
  let refreshTimer: NodeJS.Timeout | undefined
  let badge = 0
  /** The relay reports the platform of the UI it runs in, which under a remote window is not the extension host's. */
  let mac = process.platform === "darwin"
  const events: SidebarSnapshot["events"] = []
  const pending = new Map<string, (answer: EmbedComposedMessage | undefined) => void>()
  let waiters: ((ready: boolean) => void)[] = []
  const readyListeners: ((ready: boolean) => void)[] = []
  /** The value `frizz.sidebarView` has, so it is set only on a change. */
  let routeView = ""

  const theme = () => embedTheme(api.window.activeColorTheme.kind)
  const record = (type: string, outcome: string) => {
    events.push({ type, outcome })
    if (events.length > EVENTS_KEPT) events.shift()
  }
  const settle = (value: boolean) => {
    const settled = waiters
    waiters = []
    for (const waiter of settled) waiter(value)
  }

  const post = async (data: EmbedHostMessage | { view: "hint"; show: boolean }): Promise<boolean> => {
    if (!view || !frameUrl) return false
    try {
      return await view.webview.postMessage(data)
    } catch {
      return false
    }
  }

  function setReady(next: boolean): void {
    const changed = next !== ready
    ready = next
    hinted = false
    clearTimeout(readyTimer)
    readyTimer = undefined
    if (!next) {
      // A page that is gone answers nothing: what waited on it falls back now, not at its timeout.
      for (const [id, resolve] of pending) {
        pending.delete(id)
        resolve(undefined)
      }
      // The page that said where it was is gone; the title row stops claiming it.
      applyRoute(undefined)
    }
    if (changed) for (const listener of readyListeners) listener(next)
  }

  /**
   * What the page's `frizz:route` says to VS Code: the context key the title row's buttons show by, and the
   * counts, which ride the badge's tooltip. Undefined resets them, for a page that is gone or not yet ready.
   *
   * NOT the view's `title` or `description`, though the route carries both. A single-view container's
   * row reads "<container>: <view title>", and VS Code re-cases it — capitalize on 1.140, uppercase on
   * 1.90 — so a thread's handle came out "Frizz: Tidy-The-Sample-Loop", and it drops the description
   * there altogether (scripts/e2e-sidebar.ts, 2026-10-01). The row says "Frizz"; the page names the
   * thread it shows in its own drawer header, and the list names its scope.
   */
  function applyRoute(route: EmbedRouteMessage | undefined): void {
    const counts = route?.description || undefined
    if (counts !== routeCounts) {
      routeCounts = counts
      applyBadge()
    }
    routeHref = route?.href
    const next = route?.view ?? ""
    if (next === routeView) return
    routeView = next
    void api.commands.executeCommand("setContext", SIDEBAR_VIEW_KEY, next)
  }

  function showMessage(text: string, actions: readonly ViewAction[]): void {
    framedKey = undefined
    frameUrl = undefined
    frameOrigin = undefined
    setReady(false)
    settle(false)
    if (!view || text === message) return
    message = text
    view.webview.html = messageDocument({ nonce: nonce(), text, actions })
  }

  async function render(force: boolean): Promise<void> {
    if (!view) return
    const origin = host.origin()
    if (!origin) {
      // A page already showing stays: it says it is offline itself, keeps its drafts on screen, and
      // reconnects on its own when Frizz is back on the same port. A new port re-frames it (below).
      if (frameUrl && !force) return
      const reason = host.notFound()
      // Still looking: say so and offer nothing; looked and found nothing: say why, and offer to look again.
      showMessage(reason ?? "Looking for Frizz…", reason ? [{ action: "retry", label: "Try again" }] : [])
      return
    }
    const slug = host.projectSlug()
    const key = `${origin} ${slug ?? ""}`
    if (!force && key === framedKey) return
    framedKey = key
    const generation = ++renders
    const wanted = embedUrl(origin, theme(), slug)
    let external: string
    try {
      // The address as the WINDOW reaches it: identity locally; under a remote window, the forwarded one.
      external = (await api.env.asExternalUri(api.Uri.parse(wanted))).toString(true)
    } catch (error) {
      host.log.warn(`The sidebar couldn't resolve ${wanted}: ${(error as Error).message}`)
      external = wanted
    }
    if (generation !== renders || !view) return
    const target = frameTarget(wanted, external)
    if (target.kind === "remapped") {
      host.log.warn(`The sidebar can't show Frizz: this window reaches it on port ${target.external}, and Frizz only answers on port ${target.port}.`)
      showMessage("Frizz can't load in this window's sidebar. Open it in your browser instead.", [{ action: "browser", label: "Open in browser" }])
      framedKey = key
      return
    }
    host.log.info(`The sidebar shows ${target.url}.`)
    setReady(false)
    message = undefined
    frameUrl = target.url
    frameOrigin = target.origin
    view.webview.html = frameDocument({ nonce: nonce(), url: target.url, origin: target.origin })
    readyTimer = setTimeout(() => {
      host.log.warn(`The sidebar's page didn't say it was ready within ${READY_HINT_MS / 1000}s.`)
      hinted = true
      void post({ view: "hint", show: true })
      settle(false)
    }, READY_HINT_MS)
  }

  async function onPageMessage(page: EmbedPageMessage): Promise<void> {
    switch (page.type) {
      case "frizz:ready": {
        setReady(true)
        record(page.type, "ready")
        void post({ view: "hint", show: false })
        // The page read its theme from the URL when the frame was made; VS Code's may have changed since.
        void post({ type: "frizz:theme", theme: theme() })
        void post({ type: "frizz:host-state", ...host.hostState() })
        settle(true)
        return
      }
      case "frizz:composed": {
        const resolve = pending.get(page.id)
        pending.delete(page.id)
        record(page.type, resolve ? (page.ok ? "ok" : `refused: ${page.error ?? ""}`) : "unknown id")
        resolve?.(page)
        return
      }
      case "frizz:open-file": {
        const { type: _, ...open } = page
        const result = await host.openFile({ t: "open", id: randomUUID(), ...open })
        record(page.type, result.ok ? "opened" : "missing")
        if (!result.ok) void api.window.showWarningMessage(result.error ?? `Couldn't open ${page.path}.`)
        return
      }
      case "frizz:open-external": {
        const opened = await api.env.openExternal(api.Uri.parse(page.url, true))
        record(page.type, opened ? "opened" : "declined")
        return
      }
      case "frizz:key": {
        const command = chordCommand(page, mac)
        record(page.type, command ?? "ignored")
        if (command) await api.commands.executeCommand(command)
        return
      }
      case "frizz:add-context": {
        record(page.type, await host.addContext(page))
        return
      }
      case "frizz:share-editor": {
        record(page.type, await host.setShareEditor(page.on))
        // Whatever came of it, the page shows what is TRUE now: a write that did not take puts its eye back.
        void post({ type: "frizz:host-state", ...host.hostState() })
        return
      }
      case "frizz:route": {
        applyRoute(page)
        record(page.type, page.view)
        return
      }
    }
  }

  function onMessage(raw: unknown): void {
    if (!raw || typeof raw !== "object") return
    const envelope = raw as { view?: unknown; mac?: unknown; page?: unknown }
    if (typeof envelope.view === "string") {
      switch (envelope.view) {
        case "platform":
          mac = envelope.mac === true
          return
        case "retry":
          host.reconnect()
          return
        case "reload":
          reload()
          return
        case "browser":
          host.openInBrowser()
          return
      }
      return
    }
    if (!("page" in envelope) || !frameUrl) return
    const page = parsePageMessage(envelope.page, frameOrigin)
    if (!page) {
      const type = (envelope.page as { type?: unknown } | null)?.type
      record(typeof type === "string" ? type.slice(0, 64) : typeof envelope.page, "ignored")
      return
    }
    onPageMessage(page).catch((error: unknown) => host.log.warn(`The sidebar couldn't act on ${page.type}: ${(error as Error).message}`))
  }

  function applyBadge(): void {
    if (view) view.badge = badge > 0 ? { value: badge, tooltip: routeCounts ?? `${badge} ready` } : undefined
  }

  function reload(): void {
    if (!host.origin()) host.reconnect()
    void render(true)
  }

  context.subscriptions.push(
    api.window.registerWebviewViewProvider(SIDEBAR_VIEW, {
      resolveWebviewView(resolved) {
        view = resolved
        message = undefined
        resolved.webview.options = { enableScripts: true, localResourceRoots: [] }
        resolved.webview.onDidReceiveMessage(onMessage)
        resolved.onDidDispose(() => {
          if (view !== resolved) return
          view = undefined
          framedKey = undefined
          frameUrl = undefined
          frameOrigin = undefined
          message = undefined
          setReady(false)
          settle(false)
        })
        applyBadge()
        void render(true)
      },
    }, { webviewOptions: { retainContextWhenHidden: true } }),
    api.window.onDidChangeActiveColorTheme(() => {
      if (ready) void post({ type: "frizz:theme", theme: theme() })
    }),
    { dispose: () => {
      clearTimeout(readyTimer)
      clearTimeout(refreshTimer)
    } },
  )

  return {
    opened: () => view !== undefined,
    ready: () => ready,
    refresh() {
      clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => void render(false), REFRESH_DEBOUNCE_MS)
    },
    reload,
    setBadge(next) {
      badge = next
      applyBadge()
    },
    async reveal(preserveFocus) {
      if (view) view.show(preserveFocus)
      else await api.commands.executeCommand(SIDEBAR_FOCUS)
    },
    waitReady(ms) {
      if (ready) return Promise.resolve(true)
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiters = waiters.filter((waiter) => waiter !== done)
          resolve(false)
        }, ms)
        const done = (value: boolean) => {
          clearTimeout(timer)
          resolve(value)
        }
        waiters.push(done)
      })
    },
    compose(input, ms) {
      if (!ready) return Promise.resolve(undefined)
      const id = randomUUID()
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          resolve(undefined)
        }, ms)
        pending.set(id, (answer) => {
          clearTimeout(timer)
          resolve(answer)
        })
        void post({ type: "frizz:compose", id, ...input }).then((sent) => {
          if (sent) return
          pending.delete(id)
          clearTimeout(timer)
          resolve(undefined)
        })
      })
    },
    async navigate(to) {
      return ready && (await post({ type: "frizz:navigate", to }))
    },
    href: () => (ready && view?.visible ? routeHref : undefined),
    async post(message) {
      return ready && (await post(message))
    },
    pushState() {
      if (ready) void post({ type: "frizz:host-state", ...host.hostState() })
    },
    onReady(listener) {
      readyListeners.push(listener)
    },
    snapshot: () => ({
      opened: view !== undefined,
      visible: view?.visible ?? false,
      ready,
      hinted,
      ...(frameUrl ? { url: frameUrl } : {}),
      ...(message ? { message } : {}),
      ...(view?.badge ? { badge: view.badge.value } : {}),
      ...(view?.badge ? { badgeTooltip: view.badge.tooltip } : {}),
      view: routeView,
      ...(routeHref ? { href: routeHref } : {}),
      events: [...events],
    }),
  }
}
