// A VIEW TRANSITION THE BROWSER GAVE UP ON IS NOT A FAULT. react-router wraps the fullscreen door and its
// way back in `document.startViewTransition` and observes none of the transition's promises, so when the
// browser abandons one its `ready` rejects with nobody listening, and the page reports an uncaught error.
// Two abandonments are the browser's own call, and the navigation lands either way:
//  - TimeoutError, "Transition was aborted because of timeout in DOM update": the update outran the
//    browser's 4s budget. Seen only on an overloaded machine — 1 of 6 runs of
//    scripts/verify-all-queues.mjs at a load average of ~37 (2026-09-29), failing its page-error gate.
//  - AbortError, "Transition was skipped": a newer transition, or a hidden document, superseded it.
// Anything else — a duplicate view-transition-name (InvalidStateError) above all, which is an authoring
// mistake — is still reported.
export function isAbandonedViewTransition(reason: unknown): boolean {
  if (typeof DOMException === "undefined" || !(reason instanceof DOMException)) return false
  if (reason.name === "TimeoutError") return /transition/i.test(reason.message)
  if (reason.name === "AbortError") return /transition was skipped/i.test(reason.message)
  return false
}

/** Keep an abandoned view transition out of the page's uncaught errors (main.tsx). */
export function installViewTransitionRejectionFilter(): void {
  if (typeof window === "undefined") return
  window.addEventListener("unhandledrejection", (event) => {
    if (isAbandonedViewTransition(event.reason)) event.preventDefault()
  })
}
