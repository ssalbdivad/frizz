import type { EmbedCommandMessage } from "@frizz/shared"
import { closeDrawersById, store } from "../store.ts"
import { openDispatch } from "./newThreadDoor.ts"
import { closeSettingsAnimated } from "./overlays.ts"

// THE TITLE ROW'S BUTTONS — VS Code's own row above the sidebar's frame carries what a Frizz header would
// (plans/vscode-extension.md § The editor in the sidebar), and each button arrives here as a
// `frizz:command`. Each is the app's own door, called rather than re-implemented, so a button and the key
// or menu item it stands for cannot drift:
//
//   new-thread  `c`'s door (lib/newThreadDoor.ts): the caret in the page's prompt box, or, over an open
//               thread, the new-thread dialog over it.
//   queue       the palette's Queue: every drawer closed, back to the page under them.
//   jump        ⌘K: the palette.
//   settings    ⌘,: Settings.
//
// A button is pressed in VS Code, not in the frame, so whatever transient layer the page had up (the
// palette, the shortcuts sheet, a dialog) goes first, as a click outside it would have closed it.

export function runHostCommand(command: EmbedCommandMessage["command"]): void {
  store.showShortcuts = false
  if (command === "jump") {
    store.showPalette = true
    return
  }
  store.showPalette = false
  if (command === "settings") {
    store.showSettings = true
    return
  }
  // The rest are about the page under Settings, so Settings goes too — by its own close, which sends a
  // change still waiting in its debounce rather than dropping it with the drawer.
  if (store.showSettings && !closeSettingsAnimated()) store.showSettings = false
  if (command === "queue") {
    store.showNewThread = false
    closeDrawersById(store.drawers.map((drawer) => drawer.id))
    return
  }
  openDispatch()
}
