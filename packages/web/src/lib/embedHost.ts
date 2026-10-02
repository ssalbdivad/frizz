import type { EmbedHostMessage } from "@frizz/shared"
import { closeImageViewer, pushDrawer, showToast, store } from "../store.ts"
import { boardOrTimeout, composeInto, holdsBoardOf, openNamedThread, threadIsThere } from "./editorBridge.ts"
import { isTerminalPath } from "./composerContext.ts"
import { setEditorContext, takePendingAdd } from "./editorContext.ts"
import { runHostCommand } from "./embedCommand.ts"
import { repostRoute } from "./embedRoute.ts"
import { closeSettingsAnimated } from "./overlays.ts"
import { EMBED_READY, embedded, hostKeyChord, parseHostMessage, postToHost } from "./embed.ts"
import { bindingLookup, effectiveBindings, matchAction } from "./keybindings.ts"
import { basename } from "./paths.ts"
import { homeHref, projectViewHref } from "./pageView.ts"
import { prefs } from "./prefs.ts"
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
//    decide them, lib/local-file-links.ts and lib/external-links.ts; `frizz:add-context` from the
//    context bar over the sidebar's composers, lib/editorContext.ts.)

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
  // Heard in the CAPTURE phase, before any element can stop the keydown, and asked once it has been
  // everywhere it goes, so `defaultPrevented` says whether one of the page's own handlers took it.
  //
  // Capture, because stopping a key is not taking it: a question's answer box stops every key it sees
  // (QuestionBlockCard), so that its letters never reach the page's shortcuts — and a listener on the
  // window's bubble phase then never heard Ctrl+Shift+P, Ctrl+B or Ctrl+` typed there, while the options
  // grid and the prompt box forwarded them (sweep 2026-10-01). What Frizz handles itself still stays home:
  // ⌘K, ⌘I, ⌘, and Ctrl+Enter in a box are prevented by their handlers, and so is a chord the ? sheet is
  // recording.
  //
  // Asked after dispatch, because neither phase is late enough by itself: the shortcut runtime listens on
  // the window too (keyboardRuntime useShortcutListener), and a listener installed at boot runs before
  // it — so every chord Frizz binds went to VS Code as well as to Frizz (driven 2026-10-01,
  // build2-shell.md). The next task runs after dispatch has finished, and the event keeps its
  // `defaultPrevented` after it. A chord Frizz binds stays home even where nothing prevented it — the
  // answer box stops ⌘K before the shortcut runtime can hear it — since it is Frizz's, not VS Code's.
  window.addEventListener("keydown", (event) => {
    setTimeout(() => {
      const chord = hostKeyChord(event)
      if (chord && !frizzChord(event)) postToHost(chord)
    }, 0)
  }, true)
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

// The shortcut runtime's own reading of a key (lib/keyboardRuntime.ts), cached the same way: the overrides
// object is replaced whole on every change, so its identity says when the map is stale.
let cachedOverrides: unknown = null
let cachedLookup = bindingLookup(effectiveBindings({}))

function frizzChord(event: KeyboardEvent): boolean {
  if (prefs.keybindings !== cachedOverrides) {
    cachedOverrides = prefs.keybindings
    cachedLookup = bindingLookup(effectiveBindings(prefs.keybindings))
  }
  return matchAction(event, cachedLookup) !== null
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
    // by its own close, which sends a change still in its debounce. The picture viewer too, which sits
    // over every drawer: left up, it covered the queue it was sent back to, and the thread it was sent to.
    if (store.showSettings && !closeSettingsAnimated()) store.showSettings = false
    store.showPalette = false
    store.showShortcuts = false
    store.showNewThread = false
    closeImageViewer()
    const { to } = message
    if (to === "queue") spaNavigate(homeHref())
    else if ("thread" in to) {
      // Opened the way the page opens its own threads (openNamedThread). One its project lacks is not
      // navigated to, which would reload the frame (threadIsThere): on this page's own board it opens
      // the drawer that says so, as a link to it does; another project's is a toast.
      if (await threadIsThere(to.thread, to.project)) openNamedThread(to.thread, to.project, "open")
      else if (holdsBoardOf(to.project)) pushDrawer("thread", to.thread)
      else showToast("That thread isn't in Frizz.")
    }
    else spaNavigate(projectViewHref(to.project))
    return
  }
  // The host answers a context bar's click with a compose aimed at "front"; it goes back to the box whose
  // bar was clicked (lib/editorContext.ts requestEditorContext). Any other compose keeps its own target.
  const box = message.target === "front" ? takePendingAdd() : null
  let outcome: Awaited<ReturnType<typeof composeInto>>
  try {
    outcome = await composeInto(message.item, { target: box ? { box } : message.target, focus: message.focus, ...(message.note ? { note: message.note } : {}) })
  } catch (error) {
    outcome = { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  const what = isTerminalPath(message.item.path) ? "the terminal selection" : basename(message.item.path)
  postToHost(
    outcome.ok
      ? { type: "frizz:composed", id: message.id, ok: true }
      : { type: "frizz:composed", id: message.id, ok: false, error: `Couldn't add ${what} to Frizz's prompt box. ${outcome.reason}` },
  )
}
