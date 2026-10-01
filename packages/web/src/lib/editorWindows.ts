import type { EditorWindowSummary, LocalFileOpener } from "@frizz/shared"

// WHAT THE PAGE MAKES OF THE CONNECTED EDITOR WINDOWS (store.editorWindows; packages/vscode is the
// extension, plans/vscode-extension.md the design) — the pure half: which External app choices have a
// window behind them, and whether this browser should be offered one. lib/editorBridge.ts acts on it.

/** The External app choices an editor window can stand behind. Windsurf runs the extension, but the setting has no Windsurf. */
export type EditorOpener = Extract<LocalFileOpener, "vscode" | "cursor">

export const EDITOR_OPENER_LABEL: Record<EditorOpener, string> = { vscode: "VS Code", cursor: "Cursor" }

/**
 * The External app choices a connected window would take a file for. Only a window that ACCEPTS opens
 * counts: one whose `frizz.openFileLinks` is off is connected, but a file sent to that app would go to
 * its CLI exactly as if no window were there, so marking it connected would promise what it will not do.
 */
export function connectedOpeners(windows: readonly EditorWindowSummary[]): Set<EditorOpener> {
  const kinds = new Set<EditorOpener>()
  for (const window of windows) {
    if (window.acceptsOpens && (window.kind === "vscode" || window.kind === "cursor")) kinds.add(window.kind)
  }
  return kinds
}

/**
 * The editor to offer this browser's code files to, or null. Offered when a window of that editor is
 * connected and accepting, this browser's code files do not already go there (both halves: "Open code
 * files" is In external app AND External app is that editor), it has never been offered here before,
 * and the page is neither the phone layout nor a remote-access session: a device reaching this Frizz
 * over a tunnel should not be asked to send its clicks to an editor on the desk (prefs.ts `codeFiles`),
 * where an open lands in a window it cannot see and the reader never opens. Phone width alone stood in
 * for "remote" until review C8, so a laptop on the tunnel was asked. Windows are taken in the order the
 * server lists them, so two editors connecting at once are offered one at a time.
 */
export function editorOffer({ windows, codeFiles, opener, offered, phone, remote }: {
  windows: readonly EditorWindowSummary[]
  codeFiles: "frizz" | "editor"
  opener: LocalFileOpener | undefined
  offered: ReadonlySet<string>
  phone: boolean
  /** The supervisor says this page came in over remote access (api/signOut.ts isRemoteSession). */
  remote: boolean
}): EditorOpener | null {
  if (phone || remote) return null
  for (const window of windows) {
    if (!window.acceptsOpens || (window.kind !== "vscode" && window.kind !== "cursor")) continue
    const kind: EditorOpener = window.kind
    if (offered.has(kind)) continue
    if (codeFiles === "editor" && opener === kind) continue
    return kind
  }
  return null
}

/** The editors this browser has been offered (a localStorage marker), read leniently: damage reads as none. */
export function parseOffered(raw: string | null): Set<string> {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [])
  } catch {
    return new Set()
  }
}
