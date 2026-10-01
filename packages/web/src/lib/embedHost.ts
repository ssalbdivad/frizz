import type { EmbedHostMessage } from "@frizz/shared"
import { store } from "../store.ts"
import { crossProjectHref } from "./base-path.ts"
import { boardOrTimeout, composeInto, threadIsThere } from "./editorBridge.ts"
import { EMBED_READY, embedded, hostKeyChord, parseHostMessage, postToHost } from "./embed.ts"
import { basename } from "./paths.ts"
import { homeHref, projectViewHref } from "./pageView.ts"
import { spaNavigate } from "./router.ts"
import { setHostTheme } from "./theme.ts"

// THE PAGE'S SIDE OF THE SIDEBAR'S WIRE, live (lib/embed.ts holds the state and the pure checks;
// packages/shared/src/embed-protocol.ts the contract). Installed once, at boot, and only in embed mode:
//
//  - host → page: `frizz:theme`, `frizz:compose`, `frizz:navigate`, accepted only from `window.parent`
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
  // BUBBLE phase on the window, the last place a keydown reaches: every handler of the page's own has had
  // its turn by then, so `defaultPrevented` says whether one took it. A handler that stopped the event
  // took it too, and it never gets here — which is the same answer.
  window.addEventListener("keydown", (event) => {
    const chord = hostKeyChord(event)
    if (chord) postToHost(chord)
  })
  // Ready once a board is in — the page's drafts and its drawer are keyed by it, and the router that
  // navigation goes through is mounted by then — or after 5s regardless, for a machine with nothing open.
  // The extension posts nothing before this; a compose that still beats the board waits for it (composeInto).
  void boardOrTimeout().then(() => postToHost(EMBED_READY))
}

async function handle(message: EmbedHostMessage): Promise<void> {
  if (message.type === "frizz:theme") {
    setHostTheme(message.theme)
    return
  }
  if (message.type === "frizz:navigate") {
    // Whatever is over the page goes: the human asked to see a thread or a queue, not Settings.
    store.showSettings = false
    store.phoneNewThread = null
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
