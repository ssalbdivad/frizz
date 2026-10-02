// A CSS TRANSITION THE BROWSER NEVER STARTS, finished by the page — installed only in an editor's sidebar
// (lib/embedHost.ts), where the frame can be hidden while one is starting.
//
// Driven in real VS Code 1.140 (scripts/e2e-sidebar.ts, 2026-10-02, the thread's first-click.md): a thread
// opened from its row, and the side bar switched to the Explorer 150ms later — inside the drawer's
// slide-in — left the slide PENDING for good. Shown again, every document in the sidebar was rendering
// (rAF in each), yet the transition never got its start time: `translate` read 100%, so the drawer's
// layout stayed one frame-width to the right, where the page hit-tests it, while the screenshots drew it
// in place. A click on the drawer's controls then landed on the queue under it, or outside the frame
// altogether — the transcript chip that "would not unfold" and the context bar that "added nothing" in
// c4, 3 of the 14 runs that recorded the drawer. Hidden 0-600ms into the slide and shown 1s later, 2 hides
// of 20 stuck that way; with this sweep, 0 of 40 (in 20 of them it finished 49 transitions left pending).
//
// A transition pending for a whole sweep in a page that is drawing is one the browser lost, so it is
// FINISHED: the element takes its end state, the state the page asked for — what a human sees anyway.
// Pending while the frame is hidden is not lost, but finishing it then is just as right: nobody is
// watching the slide. CSS ANIMATIONS are left alone — a spinner is infinite, and has no end to jump to.

/** How often the page looks for stuck transitions. One pending across two looks has been pending for at least this long. */
export const SWEEP_MS = 500

/** The parts of an Animation the sweep reads. */
export interface TransitionLike {
  pending: boolean
  playState: AnimationPlayState
  finish(): void
}

/**
 * One sweep: finish every transition that was pending at the last sweep and still is, and return the
 * ones pending now, for the next sweep to judge. A transition starts on the frame after it is created,
 * so one seen pending twice, a sweep apart, was not going to start.
 */
export function sweepTransitions<T extends TransitionLike>(transitions: readonly T[], pendingLastTime: ReadonlySet<T>): Set<T> {
  const pending = new Set<T>()
  for (const transition of transitions) {
    if (!transition.pending || transition.playState !== "running") continue
    if (pendingLastTime.has(transition)) transition.finish()
    else pending.add(transition)
  }
  return pending
}

/** Sweep the document's CSS transitions every SWEEP_MS. */
export function finishStuckTransitions(): void {
  if (typeof document === "undefined" || typeof document.getAnimations !== "function" || typeof CSSTransition === "undefined") return
  let pending = new Set<CSSTransition>()
  setInterval(() => {
    const transitions = document.getAnimations().filter((animation): animation is CSSTransition => animation instanceof CSSTransition)
    pending = sweepTransitions(transitions, pending)
  }, SWEEP_MS)
}
