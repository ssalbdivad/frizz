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
//
// A claim can also PASS: the key is not the claim's, but it belongs to the focused editor, which has not seen
// it yet — the box's open slash or mention menu (Escape closes it first, §7), or an IME composing (Escape is
// its cancel). The dialog then stays open and the key goes on to the editor, exactly as on the page with no
// dialog around the box. Before PASS the claim answered for the menu: in the dialog, Esc with a menu open
// left the mode and kept the menu, one Enter from accepting its row (fix round 1, X4).
export type EscapeVerdict = boolean | "pass"
export type EscapeEvent = { isComposing?: boolean }
type EscapeClaim = (event?: EscapeEvent) => EscapeVerdict
const escapeClaims: EscapeClaim[] = []

export function registerEscapeClaim(claim: EscapeClaim): () => void {
  escapeClaims.push(claim)
  return () => {
    const at = escapeClaims.lastIndexOf(claim)
    if (at >= 0) escapeClaims.splice(at, 1)
  }
}

/** Ask the claims, newest first: true when one acted, "pass" when one handed the key on to its editor. */
export function claimEscape(event?: EscapeEvent): EscapeVerdict {
  for (const claim of [...escapeClaims].reverse()) {
    const verdict = claim(event)
    if (verdict) return verdict
  }
  return false
}

/** A claim that answers only while focus is inside `root`, with what `act` says. */
export function focusedEscapeClaim(
  root: () => { contains(node: unknown): boolean } | null | undefined,
  act: (event?: EscapeEvent) => EscapeVerdict,
  active: () => unknown = () => (typeof document === "undefined" ? null : document.activeElement),
): EscapeClaim {
  return (event) => {
    const el = root()
    const focused = active()
    if (!el || !focused || !el.contains(focused)) return false
    return act(event)
  }
}

export function handleDialogEscape(event: Pick<KeyboardEvent, "preventDefault" | "stopPropagation"> & EscapeEvent): void {
  // preventDefault tells Radix not to dismiss this dialog. The Select is controlled, so its registry
  // callback has already closed it; the next Escape reaches this dialog with no active Select. A claim
  // (above) is the same shape one layer in: it has already acted, and the dialog stays — or it PASSED, and
  // the dialog stays while the key travels on to the focused editor that owns it.
  const verdict = dismissOpenSelect() || claimEscape(event)
  if (verdict) event.preventDefault()
  if (verdict !== "pass") event.stopPropagation()
}
