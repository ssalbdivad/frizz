interface OpenSelectEntry {
  dismiss: () => void
}

let activeSelect: OpenSelectEntry | undefined
let escapeGuardInstalled = false

function ensureEscapeGuard(): void {
  if (escapeGuardInstalled || typeof window === "undefined") return
  escapeGuardInstalled = true
  // Radix's portaled menus and dialogs each observe the same native Escape. Claim it at the earliest
  // capture boundary from the shared registry so mount/listener ordering cannot close both layers.
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !activeSelect) return
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    dismissOpenSelect()
  }, { capture: true })
}

// A Radix Select portal is not a DOM descendant of its dialog. Keep one tiny process-local pointer
// to the currently open Select so a parent dialog's document-capture Escape handler can defer to it
// regardless of which Radix listener was registered first.
export function registerOpenSelect(dismiss: () => void): () => void {
  ensureEscapeGuard()
  const entry = { dismiss }
  activeSelect = entry
  return () => {
    if (activeSelect === entry) activeSelect = undefined
  }
}

export function dismissOpenSelect(): boolean {
  const entry = activeSelect
  if (!entry) return false
  activeSelect = undefined
  entry.dismiss()
  return true
}

// ESCAPE CLAIMS: something INSIDE a dialog that owns the first Escape itself — the new-thread box's schedule
// mode, which Escape leaves (plans/schedule-live-reading.md §7). Radix runs a dialog's Escape at the
// document's capture phase, before any handler in the dialog's own tree, so the `c` dialog closed — taking
// the box, its mode and the panel with it — before the box ever saw the key. A claim is asked first: it
// returns true only when it ACTED (it left the mode), and then the dialog stays open; the next Escape, with
// nothing left to claim, closes it as before.
//
// A claim must decide for ITSELF whether this Escape is its: two boxes can be in the mode at once (the page
// box and the `c` dialog over it share one draft), and only the one holding focus may take the key.
// `focusedEscapeClaim` builds that check.
type EscapeClaim = () => boolean
const escapeClaims: EscapeClaim[] = []

export function registerEscapeClaim(claim: EscapeClaim): () => void {
  escapeClaims.push(claim)
  return () => {
    const at = escapeClaims.lastIndexOf(claim)
    if (at >= 0) escapeClaims.splice(at, 1)
  }
}

/** Ask the claims, newest first; true when one acted. */
export function claimEscape(): boolean {
  for (const claim of [...escapeClaims].reverse()) if (claim()) return true
  return false
}

/** A claim that acts only while focus is inside `root` and `act` says it had something to undo. */
export function focusedEscapeClaim(
  root: () => { contains(node: unknown): boolean } | null | undefined,
  act: () => boolean,
  active: () => unknown = () => (typeof document === "undefined" ? null : document.activeElement),
): EscapeClaim {
  return () => {
    const el = root()
    const focused = active()
    if (!el || !focused || !el.contains(focused)) return false
    return act()
  }
}

export function handleDialogEscape(event: Pick<KeyboardEvent, "preventDefault" | "stopPropagation">): void {
  // preventDefault tells Radix not to dismiss this dialog. The Select is controlled, so its registry
  // callback has already closed it; the next Escape reaches this dialog with no active Select. A claim
  // (above) is the same shape one layer in: it has already acted, and the dialog stays.
  if (dismissOpenSelect() || claimEscape()) event.preventDefault()
  event.stopPropagation()
}
