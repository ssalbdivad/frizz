import type { EmbedHostMessage } from "@frizz/shared"
import { store } from "../store.ts"
import { crossProjectHref } from "./base-path.ts"
import { boardOrTimeout, composeInto, threadIsThere } from "./editorBridge.ts"
import { setEditorContext } from "./editorContext.ts"
import { runHostCommand } from "./embedCommand.ts"
import { repostRoute } from "./embedRoute.ts"
import { closeSettingsAnimated } from "./overlays.ts"
import { EMBED_READY, embedded, hostKeyChord, parseHostMessage, postToHost } from "./embed.ts"
import { basename } from "./paths.ts"
import { homeHref, projectViewHref } from "./pageView.ts"
import { spaNavigate } from "./router.ts"
import { setHostTheme } from "./theme.ts"

// THE PAGE'S SIDE OF THE SIDEBAR'S WIRE, live (lib/embed.ts holds the state and the pure checks;
// packages/shared/src/embed-protocol.ts the contract). Installed once, at boot, and only in embed mode:
//
//  - host → page: `frizz:theme`, `frizz:compose`, `frizz:navigate`, `frizz:editor-context` (lib/
//    editorContext.ts) and `frizz:command` (lib/embedCommand.ts), accepted only from `window.parent`
//    — the relay the extension's webview runs — and only in a shape the contract defines.
//  - page → host: `frizz:ready` once the page can act on those, and `frizz:key` for the chords the
//    page left alone. (`frizz:open-file` and `frizz:open-external` leave from the link handlers that
//    decide them, lib/local-file-links.ts and lib/external-links.ts.)

export function initEmbedHost(): void {
  if (!embedded() || typeof window === "undefined") return
  document.documentElement.dataset.embed = "vscode"
  window.addEventListener("message", (event) => {
    // The parent, and nothing else: another frame or a popup could post the same shapes, and a compose
    // from one would put its text into the human's prompt box.
    if (event.source !== window.parent || window.parent === window) return
    const message = parseHostMessage(event.data)
    if (message) void handle(message)
  })
  // Asked once the keydown has been everywhere it goes, so `defaultPrevented` says whether one of the
  // page's own handlers took it. A handler that stopped the event took it too, and it never gets here —
  // which is the same answer. BUBBLE phase on the window is not late enough by itself: the shortcut
  // runtime listens there too (keyboardRuntime useShortcutListener), and this listener, installed at boot,
  // runs before it — so every chord Frizz binds (⌘K, ⌘I, ⌘,) went to VS Code as well as to Frizz (driven
  // 2026-10-01, build2-shell.md). The next task runs after dispatch has finished, and the event keeps its
  // `defaultPrevented` after it.
  window.addEventListener("keydown", (event) => {
    setTimeout(() => {
      const chord = hostKeyChord(event)
      if (chord) postToHost(chord)
    }, 0)
  })
  // Ready once a board is in — the page's drafts and its drawer are keyed by it, and the router that
  // navigation goes through is mounted by then — or after 5s regardless, for a machine with nothing open.
  // The extension posts nothing before this; a compose that still beats the board waits for it (composeInto).
  // The title row's reading (lib/embedRoute.ts) goes again right behind it: the page has drawn its view
  // by then, and said so to a host that may not have been listening yet.
  void boardOrTimeout().then(() => {
    postToHost(EMBED_READY)
    repostRoute()
  })
}

async function handle(message: EmbedHostMessage): Promise<void> {
  if (message.type === "frizz:theme") {
    setHostTheme(message.theme)
    return
  }
  if (message.type === "frizz:editor-context") {
    setEditorContext(message)
    return
  }
  if (message.type === "frizz:command") {
    runHostCommand(message.command)
    return
  }
  if (message.type === "frizz:navigate") {
    // Whatever is over the page goes: the human asked to see a thread or a queue, not Settings — closed
    // by its own close, which sends a change still in its debounce.
    if (store.showSettings && !closeSettingsAnimated()) store.showSettings = false
    store.showPalette = false
    store.showShortcuts = false
    store.showNewThread = false
    const { to } = message
    if (to === "queue") spaNavigate(homeHref())
    else if ("thread" in to) {
      // A thread its project lacks would reload the frame (threadIsThere); stay on what is showing.
      if (await threadIsThere(to.thread, to.project)) spaNavigate(`${crossProjectHref(to.project)}/thread/${encodeURIComponent(to.thread)}`)
    }
    else spaNavigate(projectViewHref(to.project))
    return
  }
  let outcome: Awaited<ReturnType<typeof composeInto>>
  try {
    outcome = await composeInto(message.item, { target: message.target, focus: message.focus })
  } catch (error) {
    outcome = { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  postToHost(
    outcome.ok
      ? { type: "frizz:composed", id: message.id, ok: true }
      : { type: "frizz:composed", id: message.id, ok: false, error: `Couldn't add ${basename(message.item.path)} to Frizz's prompt box. ${outcome.reason}` },
  )
}
