import { useEffect, useState } from "react"
import { useSnapshot } from "valtio"
import { Loader2 } from "lucide-react"
import { store, pushDrawer, type ToastLink } from "../store.ts"
import { crossProjectHref, projectSlug } from "../lib/base-path.ts"
import { spaNavigate } from "../lib/router.ts"

// Minimal toast (no dep): rises in at the BOTTOM RIGHT, holds, then sinks back down and fades.
// Each showToast bumps the id, which re-arms the timer so a repeat message (the same failure twice
// running, say) flashes again. Variants: `spinner` (in-flight feel), `sticky` (no auto-hide — replaced by the
// next toast, e.g. "Starting agent…" → the started confirmation), `link` (a button that opens
// the named thread in the side drawer) and `actions` (up to two buttons that run the raiser's own verbs —
// Undo, then Open).
export function Toaster() {
  const snap = useSnapshot(store)
  const toast = snap.toast
  const [visible, setVisible] = useState(false)
  // A thread drawer's lifecycle footer (Snooze / Mark as done) also anchors bottom-right, one layer
  // BELOW this toast (footer z-20 inside a z-51 drawer; toast z-70). At the resting bottom-4 the toast
  // sat directly on top of those buttons, and a `link` toast — whose pill used to be pointer-events-auto
  // — swallowed every click meant for them for its full (5s) life. So: keep the strip click-through and
  // only let the explicit action button intercept (below), AND lift the whole toast above the footer
  // whenever a drawer is open so it never covers those controls in the first place.
  const drawerOpen = snap.drawers.some((drawer) => !drawer.closing)

  useEffect(() => {
    if (!toast) return
    setVisible(true)
    if (toast.sticky) return
    // A toast with a button holds long enough to reach it; a bare one only has to be read.
    const t = setTimeout(() => setVisible(false), toast.duration ?? (toast.link || toast.actions?.length ? 5000 : 1600))
    return () => clearTimeout(t)
  }, [toast?.id])

  if (!toast) return null
  // A toast's buttons take the pointer and the Tab key only while it is SHOWN. A faded toast stays
  // mounted at opacity 0 until the next one replaces it, and its buttons kept both: an invisible
  // "Open thread" (or Undo, which would reverse a snooze minutes after its toast was gone) sat over
  // whatever was beneath. The fade's 32px drop does not take a button off screen: the snooze toast's
  // Undo stayed fully inside the viewport both at the page's bottom edge and above an open drawer's
  // footer (scripts/verify-snooze-undo.mjs).
  const buttonClass = `${visible ? "pointer-events-auto" : ""} shrink-0 rounded-md border border-border px-2 py-0.5 text-[12px] text-fg/90 transition-colors hover:bg-panel-2`
  const buttonTab = visible ? undefined : -1
  return (
    <div className={`pointer-events-none fixed right-4 z-[70] flex justify-end ${drawerOpen ? "bottom-20" : "bottom-4"}`}>
      <div
        data-toast
        role="status"
        aria-live="polite"
        aria-atomic="true"
        // Capped, because a toast is a STRIP and nothing may turn it into a panel. An unbounded one
        // stretched edge to edge across a 1440px viewport and four lines deep the first time a caller
        // passed it a supervisor's raw build log — the text has to wrap inside a strip-sized box
        // instead. `break-words` covers the other half of that failure: a long unbroken token (an
        // absolute path, a URL) would otherwise push straight past the cap.
        className={`flex max-w-[min(30rem,calc(100vw-2rem))] items-center gap-2.5 break-words rounded-lg border border-border-strong bg-elevated px-4 py-2 text-[13px] font-medium text-fg shadow-xl shadow-shadow-ink/40 transition-all duration-200 ease-out ${
          visible ? "translate-y-0 opacity-100" : "translate-y-8 opacity-0"
        }`}
      >
        {toast.spinner && <Loader2 size={13} className="animate-spin text-muted" />}
        {/* `detail` is a second line of its own rather than a clause of `text`: the snooze toast's "under
            <project> in the list" wrapped wherever the cap fell, leaving "in the list" alone on line two,
            and a balanced wrap cannot help — it keeps the box at full width and opens a hole before the
            button. Two lines shrink-wrap to the longer one. */}
        {toast.detail ? (
          <span className="min-w-0">
            {toast.text}
            <span className="block text-[12px] font-normal text-muted">{toast.detail}</span>
          </span>
        ) : (
          toast.text
        )}
        {toast.link && (
          <button
            onClick={() => {
              openToastLink(toast.link!)
              store.toast = null
            }}
            tabIndex={buttonTab}
            className={buttonClass}
          >
            {toast.link.label}
          </button>
        )}
        {toast.actions?.map((action) => (
          <button
            key={action.label}
            data-toast-action={action.label}
            onClick={() => {
              action.run()
              store.toast = null
            }}
            tabIndex={buttonTab}
            className={buttonClass}
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * A pointer on the toast is the toast's own, never a click OUTSIDE a drawer. The toast is not in any
 * sheet's DOM, so every sheet's outside-pointer dismissal read its buttons as a dismissal: Undo on a
 * snooze taken from a thread's drawer closed the drawer along with the snooze. (An "Open thread" loses
 * nothing: the drawer it opens goes through the store's stacking policy, which replaces a sibling.)
 */
export function isToastPointer(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-toast]") !== null
}

function openToastLink(link: ToastLink) {
  // Its own project's drawer, through the router, when the page is focused elsewhere by now; the thread
  // route opens the right surface for it.
  if (link.project !== undefined && link.project !== projectSlug()) {
    spaNavigate(`${crossProjectHref(encodeURIComponent(link.project))}/thread/${encodeURIComponent(link.slug)}`)
    return
  }
  pushDrawer("thread", link.slug)
}
