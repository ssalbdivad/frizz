import { useSyncExternalStore } from "react"
import { embedded } from "./embed.ts"

// THE PHONE BREAKPOINT, and why it is not the 800px one the layout already uses.
//
// The app has had a `max-[800px]` stack point for a long time: below it the sidebar and the workpane
// stop sitting side by side and stack vertically. That is a TABLET layout — the same surfaces, one
// above the other — and it is unchanged by anything here.
//
// This is a different question: below what width does the desktop's information model stop working at
// all? A 390pt viewport cannot hold a rail AND a workpane in any arrangement, so the phone gets its own
// layout of the page (components/PhonePage.tsx: a header, three tabs, one list) rather than a squeezed
// one. 700px is where that switch happens: wide enough that every phone in portrait and most in
// landscape get the phone layout, narrow enough
// that a small window on a desktop keeps the layout its user knows.
export const MOBILE_MAX_PX = 700
export const MOBILE_QUERY = `(max-width: ${MOBILE_MAX_PX}px)`

const listeners = new Set<() => void>()
let media: MediaQueryList | null = null

function subscribe(callback: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {}
  if (!media) {
    media = window.matchMedia(MOBILE_QUERY)
    // ONE MediaQueryList for the whole app, with the components subscribed to it — not one listener per
    // caller. Several surfaces ask this question (the shell, the cross-project page, the status bar), and a query that
    // every one of them re-creates answers the same thing while costing a listener each.
    media.addEventListener("change", () => listeners.forEach((l) => l()))
  }
  listeners.add(callback)
  return () => listeners.delete(callback)
}

// The VIEWPORT's answer alone: is it phone-sized? Embed mode does not enter into it — see the two
// questions below, which are what the app actually asks.
function viewportIsPhone(): boolean {
  return media ? media.matches : typeof window !== "undefined" && !!window.matchMedia?.(MOBILE_QUERY).matches
}

// TWO QUESTIONS, NOT ONE. This module answered a single "is this a phone?" until 2026-10-01, and an
// editor's sidebar (lib/embed.ts) answered yes to it at any width — which bought the sidebar the phone's
// one-column STRUCTURE it wanted and, with it, every phone BEHAVIOUR it did not: the answer sheet in place
// of inline question cards, a 16.5px type scale and 44px targets, the Settings page with the phone's rows,
// a floating New thread pill. A sidebar has a pointer and a keyboard; it is the desktop app in a narrow
// column, not a phone (plans/vscode-extension.md § The editor in the sidebar, and the app's own feel).
// So the two halves are asked separately:
//
//  - THE PHONE — its own page (PhonePage.tsx), its sheets, its touch-sized controls, no keyboard: this
//    module, phoneLayout / useIsMobile. A phone-sized viewport, and never a sidebar.
//  - ONE COLUMN — the page with nothing beside it, its drawers the full width: a phone, and a sidebar at
//    any width. Asked where the column is drawn — AllQueues.tsx (embedded() → SidebarPage), ui/Sheet.tsx
//    useNarrowDrawer, and styles.css `html[data-embed]` beside the 700px query — rather than here.

function phoneSnapshot(): boolean {
  return !embedded() && viewportIsPhone()
}

/**
 * The same answer as useIsMobile, outside React — for a module that acts on the layout rather than
 * rendering it (lib/editorBridge.ts opening the phone's New thread sheet). False in an editor's sidebar,
 * whose new-thread box is the desktop's, always on screen (AllQueues.tsx SidebarPage).
 */
export function phoneLayout(): boolean {
  return phoneSnapshot()
}

/**
 * Is this a phone-shaped viewport — the phone's page and touch behaviour? Never in an editor's sidebar.
 *
 * `useSyncExternalStore` rather than a `useState` + effect pair: the effect version renders ONCE with
 * the wrong answer before it corrects itself, which on a cold load means the desktop shell mounts, binds
 * its sticky sidebar and its scroll spy, and is then thrown away — a visible flash of the wrong layout
 * on exactly the devices least able to afford it.
 */
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, phoneSnapshot, () => false)
}
