// WHEN A PAGE IN AN EDITOR'S SIDEBAR MAY TAKE THE KEYBOARD WITHOUT HAVING IT — the rule lib/embedHost.ts
// guardFocus applies to every programmatic `focus()`, here on its own so the rule is testable without a
// browser. The page that has focus focuses what it likes. The page that does not may focus only right
// after the host asked it to (a compose with the caret, a title-row command, a navigation: the relay
// focuses the frame and the page's own focus lands after) — and only until the human leaves.
//
// THE LEAVING IS THE FIX (real VS Code e2e, 2026-10-02). The ask used to open a flat 1.5s window, and
// anything the page focused inside it got through, focused or not. So a human who clicked the context bar
// (a compose with the caret, an ask) and went straight back to the editor had the keyboard taken from them
// a beat later: the selection they made re-rendered the bar inside the drawer, Radix's focus scope
// refocused the drawer from its MutationObserver while the window was still open, and the focus pulled the
// whole webview in front of the editor — Alt+K then typed into the page (scripts/e2e-sidebar.ts c4, 5 runs
// of 5 with the run's own pace), and with the sidebar hidden a resetPage's command 1.5s earlier did the
// same to "the editor keeps the keyboard". So the window closes the moment the page, having had focus
// since the ask, loses it: the ask has been answered, and the blur is the human going somewhere else.
// Blurs BEFORE the focus has landed do not count — the relay's own focus dance (VS Code revealing the
// view, the relay focusing its frame) can blur a document on the way in.

export const HOST_FOCUS_MS = 1500

export interface HostFocusGate {
  /** The host asked for the keyboard (`hasFocus`: whether the page already has it, the relay having focused the frame first). */
  ask(now: number, hasFocus: boolean): void
  /** The page's window gained focus. */
  focused(now: number): void
  /** The page's window lost focus. */
  blurred(): void
  /** May a `focus()` called now go through? */
  allows(now: number, hasFocus: boolean): boolean
}

export function hostFocusGate(): HostFocusGate {
  let until = 0
  let landed = false
  return {
    ask(now, hasFocus) {
      until = now + HOST_FOCUS_MS
      landed = hasFocus
    },
    focused(now) {
      if (now < until) landed = true
    },
    blurred() {
      if (landed) until = 0
      landed = false
    },
    allows(now, hasFocus) {
      return hasFocus || now < until
    },
  }
}
