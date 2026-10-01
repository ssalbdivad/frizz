import type { EmbedCommandMessage } from "@frizz/shared"
import { store } from "../store.ts"
import { homeHref } from "./pageView.ts"
import { spaNavigate } from "./router.ts"

// THE TITLE ROW'S BUTTONS — VS Code's own row above the sidebar's frame carries what a Frizz header would
// (plans/vscode-extension.md § The editor in the sidebar), and each button arrives here as a
// `frizz:command`. Each does what the same door does in the app: the shortcut's own verb where one exists.

export function runHostCommand(command: EmbedCommandMessage["command"]): void {
  if (command === "jump") {
    store.showPalette = true
    return
  }
  if (command === "settings") {
    store.showSettings = true
    return
  }
  // The rest change what the page shows, so whatever is over it goes first.
  store.showSettings = false
  store.showPalette = false
  if (command === "queue") {
    store.phoneNewThread = null
    spaNavigate(homeHref())
    return
  }
  store.phoneNewThread = { focus: true }
}
