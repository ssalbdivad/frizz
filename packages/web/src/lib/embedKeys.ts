import type { ActionId, Platform } from "./keybindings.ts"

// THE KEYBOARD IN AN EDITOR'S SIDEBAR — what the shortcuts sheet (components/KeyboardShortcuts.tsx) says
// where the sidebar differs from the browser. Every key the sheet lists works there; these are the
// differences, said where the key is listed (plans/vscode-extension.md § The editor in the sidebar).
//
// WHERE A KEY GOES. While the frame has focus no VS Code keybinding sees a key (the sidebar spike,
// 2026-10-01), so every key reaches Frizz — and Frizz's chords that VS Code also binds (⌘K, its chord
// prefix; ⌘, its settings; ⌘I, its inline chat) are Frizz's there and VS Code's from the editor. The page
// forwards each Ctrl/Cmd chord it leaves alone (lib/embedHost.ts `frizz:key`), and the extension runs the
// ones its allowlist names: HOST_CHORDS below, which must stay the list in packages/vscode/src/embed.ts
// CHORDS (embedKeys.test.ts runs every one through the extension's own matcher).

/** What a key does in the sidebar, where that is not what its name in the sheet says. Shown under the name. */
export const SIDEBAR_KEY_HINTS: Partial<Record<ActionId, string>> = {
  // No cards: the next card is the next thread in the queue, opened in its drawer (SidebarPage.tsx).
  "queue.next": "Opens the next queued thread",
  "queue.prev": "Opens the previous one",
  // The drawer is the frame's width already; the door opens the thread in the browser (ExpandThreadLink.tsx).
  "thread.fullscreen": "Opens it in your browser",
  // Every thread opens in its drawer here, so there is no card to open one from.
  "thread.open": "Every thread opens in one here",
  // The extension binds ⌘I in the editor to add its selection to this prompt box — the same chord, and the
  // Frizz reader's own (FileViewerPanel ⌘I).
  "app.details": "In the editor, adds the selection",
}

/** The sheet's note over the keys, in the sidebar. */
export const SIDEBAR_KEYS_NOTE = "Keys reach Frizz while the sidebar has focus."

/**
 * A VS Code chord the sidebar passes on. `primary` is ⌘ on a Mac and Ctrl elsewhere, as VS Code spells it;
 * `ctrl` is Ctrl on every platform (VS Code binds the terminal and source control to Ctrl on a Mac too).
 * `code` is the physical key the extension matches (`KeyboardEvent.code`), `key` its cap.
 */
export interface HostChord {
  label: string
  primary: boolean
  ctrl: boolean
  shift: boolean
  code: string
  key: string
}

const chord = (label: string, spec: string): HostChord => {
  const parts = spec.split("+")
  const code = parts.pop()!
  const key = code.startsWith("Key") ? code.slice(3) : code.startsWith("Digit") ? code.slice(5) : code === "Backquote" ? "`" : code
  return { label, primary: parts.includes("primary"), ctrl: parts.includes("ctrl"), shift: parts.includes("shift"), code, key }
}

/** VS Code's own names, in VS Code's own default chords. */
export const HOST_CHORDS: readonly HostChord[] = [
  chord("Command palette", "primary+shift+KeyP"),
  chord("Go to file", "primary+KeyP"),
  chord("Toggle the side bar", "primary+KeyB"),
  chord("Toggle the panel", "primary+KeyJ"),
  chord("Toggle the terminal", "ctrl+Backquote"),
  chord("Back to the editor", "primary+Digit1"),
  chord("Explorer", "primary+shift+KeyE"),
  chord("Search", "primary+shift+KeyF"),
  chord("Source control", "ctrl+shift+KeyG"),
  chord("Run and debug", "primary+shift+KeyD"),
  chord("Extensions", "primary+shift+KeyX"),
]

/** The note under the VS Code group. */
export const HOST_CHORDS_NOTE = "Pressed in the sidebar, these go to VS Code. Its other keys work from the editor."

/** A chord's keycaps in each platform's order: Apple's ⌃⇧⌘, and Ctrl, Shift elsewhere. */
export function hostChordKeycaps(chord: HostChord, platform: Platform): string[] {
  if (platform === "mac") return [...(chord.ctrl ? ["⌃"] : []), ...(chord.shift ? ["⇧"] : []), ...(chord.primary ? ["⌘"] : []), chord.key]
  return ["Ctrl", ...(chord.shift ? ["Shift"] : []), chord.key]
}

/** The keydown a chord is on a platform, as the page forwards it (`frizz:key`) — for the pin test. */
export function hostChordEvent(chord: HostChord, platform: Platform): { code: string; ctrl: boolean; meta: boolean; shift: boolean; alt: boolean } {
  const mac = platform === "mac"
  return { code: chord.code, ctrl: chord.ctrl || (!mac && chord.primary), meta: mac && chord.primary, shift: chord.shift, alt: false }
}
