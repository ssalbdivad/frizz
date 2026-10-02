import { proxy, subscribe } from "valtio"
import type { QueueDirection } from "../groups.ts"
import { DEFAULT_SNOOZE_PRESET, isSnoozePreset, type SnoozePreset } from "./snooze.ts"
import { sanitizeOverrides, type Overrides } from "./keybindings.ts"

// Client-only VIEW preferences — persisted in localStorage, never in the server Settings schema
// (that's operator dispatch config; this is how one browser likes to render). Seeded synchronously
// from localStorage so the first paint already reflects the saved choice, then mirrored back on
// every change. Components read via useSnapshot(prefs).
const KEY = "frizz.prefs.v1"

export interface Prefs {
  // Collapse rendered diff blocks to just their header row (click a header to expand that one).
  compactDiffs: boolean
  // Queue-card split Snooze remembers the operator's last duration choice across every card/reload.
  // A custom date is deliberately one-off and never overwrites this reusable preset.
  snoozePreset: SnoozePreset
  // Direction the Needs-you queue + the sidebar's rested band order by. FIFO (default) surfaces the
  // longest-waiting item first so the human cycles through everything; LIFO surfaces the most recent
  // arrival first. See groups.ts orderQueue.
  queueOrder: QueueDirection
  // The fullscreen rail's "Edited files" group folded to its heading (maintainer 2026-09-03: "make
  // Edited Files collapsible"). Open by default — the list is the rail's one non-wait group and the
  // reason the page has a rail at all — and remembered here rather than in the store because a
  // 22-file list a human folded once should stay folded on the next thread and the next reload.
  railFilesCollapsed: boolean
  // The operator's keyboard-shortcut CHANGES from the defaults (lib/keybindings.ts), not the whole
  // map: an action still on its default has no entry, so a default that changes in a later release
  // reaches everyone who never touched it. Per browser on purpose — a keyboard belongs to a machine.
  keybindings: Overrides
  // Where a click on a CODE file (anything the reader shows as source — not Markdown, not a picture)
  // goes. "frizz" is the reader, which always works: it needs no app installed and no desktop on the far
  // end. "editor" hands it straight to the external app the machine-wide `localFileOpener` setting
  // names, and falls back to the reader when that app cannot start. Per browser on purpose: a phone
  // reaching this Frizz over a tunnel should not launch Cursor on the desk.
  //
  // "auto" is a browser that has chosen neither, and it is the default: the external app exactly while
  // that app is an editor with the Frizz extension connected and taking opens, and the page is not a
  // phone or a remote session (lib/editorWindows.ts codeFilesDestination) — the reader otherwise, as
  // before. A connected editor is proof the app is there, on this machine, and that its owner installed
  // something whose whole job is to take these clicks; the reader default existed for when neither was
  // known. Until 2026-10-01 the default was "frizz" and only a one-time 12s toast switched it, so a
  // human who missed the toast clicked a link with VS Code connected and got the reader.
  codeFiles: CodeFiles
  // (No `sendEditorContext` here any more. The context bar's eye was a pref of the sidebar's frame from
  // 2026-10-01 to 2026-10-02; it is now the extension's `frizz.shareEditorState` (lib/editorContext.ts
  // setShareEditor), the one switch that also keeps the agents' tool out of the editor. A stored value is
  // ignored: the eye had not reached anyone's installed extension.)
}

export type CodeFiles = "auto" | "frizz" | "editor"

function coerceQueueOrder(v: unknown, fallback: QueueDirection): QueueDirection {
  return v === "fifo" || v === "lifo" ? v : fallback
}

// One-time re-default markers. They ride along in the stored blob but never in `Prefs` (what
// components read), and they are seeded into the fallback too — otherwise a browser starting FRESH
// after a migration ships stores no marker, and the very next load would revert the deliberate
// toggle that browser just made.
interface RedefaultMarkers {
  diffsRedefaulted?: boolean
  snoozeRedefaulted?: boolean
  codeFilesRedefaulted?: boolean
}

export function parseStoredPrefs(raw: string | null): Prefs {
  // Compact diffs by DEFAULT — expanded diff bodies are the opt-in.
  const fallback: Prefs & RedefaultMarkers = {
    compactDiffs: true,
    snoozePreset: DEFAULT_SNOOZE_PRESET,
    queueOrder: "fifo",
    railFilesCollapsed: false,
    keybindings: {},
    codeFiles: "auto",
    diffsRedefaulted: true,
    snoozeRedefaulted: true,
    codeFilesRedefaulted: true,
  }
  try {
    if (!raw) return fallback
    const stored = JSON.parse(raw) as Partial<Prefs> & RedefaultMarkers
    // The context bar's eye was a pref here for a day (2026-10-01); it is the extension's setting now
    // (lib/editorContext.ts setShareEditor). Dropped, so a stored value never rides the blob again.
    delete (stored as Record<string, unknown>).sendEditorContext
    // ONE-TIME migration (2026-07-09): the maintainer settled diffs as collapsed-by-default for
    // card-family consistency. A stored `compactDiffs: false` predating that decision was the OLD
    // default, not a choice — re-default it once. The marker makes a subsequent deliberate
    // Settings-toggle OFF stick forever.
    if (!stored.diffsRedefaulted) {
      stored.compactDiffs = true
      stored.diffsRedefaulted = true
    }
    // ONE-TIME migration (2026-09-29): the default moved from "1d" to "until tomorrow". Every pref
    // write persists the whole blob, so a stored "1d" is almost always the old default riding along
    // with some other toggle rather than a pick — re-default it once. A later deliberate "1d" sticks.
    if (!stored.snoozeRedefaulted) {
      if (stored.snoozePreset === "1d") stored.snoozePreset = "tomorrow"
      stored.snoozeRedefaulted = true
    }
    // ONE-TIME migration (2026-10-01): the default moved from "frizz" to "auto". The same reasoning as
    // the snooze preset: every pref write persists the whole blob, and the setting is one day old, so a
    // stored "frizz" is the old default riding along, not a pick. A later deliberate "In Frizz" sticks.
    if (!stored.codeFilesRedefaulted) {
      if (stored.codeFiles === "frizz") stored.codeFiles = "auto"
      stored.codeFilesRedefaulted = true
    }
    return {
      ...fallback,
      ...stored,
      snoozePreset: isSnoozePreset(stored.snoozePreset) ? stored.snoozePreset : fallback.snoozePreset,
      queueOrder: coerceQueueOrder(stored.queueOrder, fallback.queueOrder),
      railFilesCollapsed: typeof stored.railFilesCollapsed === "boolean" ? stored.railFilesCollapsed : fallback.railFilesCollapsed,
      keybindings: sanitizeOverrides(stored.keybindings),
      codeFiles: stored.codeFiles === "editor" || stored.codeFiles === "frizz" ? stored.codeFiles : "auto",
    }
  } catch {
    return fallback
  }
}

function seed(): Prefs {
  try {
    return parseStoredPrefs(typeof localStorage === "undefined" ? null : localStorage.getItem(KEY))
  } catch {
    return parseStoredPrefs(null)
  }
}

export const prefs = proxy<Prefs>(seed())

subscribe(prefs, () => {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(prefs))
  } catch {
    /* private mode / quota — the in-memory proxy still drives this session */
  }
})
