import { useState, type ComponentType } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { ChevronsDownUp, ChevronsUpDown, FileText, Loader2, RotateCcw } from "lucide-react"
import type { ThreadView } from "@frizz/shared"
import { Tooltip } from "./Tooltip.tsx"
import { MarkAsButton } from "./MarkAsButton.tsx"
import { offersRetry } from "../groups.ts"
import { retrySession } from "../lib/retrySession.ts"
import { HEADER_ICON_CLASS } from "../lib/headerIcon.ts"
import { ReloadPluginsButton } from "./ReloadPluginsButton.tsx"
import { RestartWorkerButton } from "./RestartWorkerButton.tsx"
import { CollapseThreadLink } from "./CollapseThreadLink.tsx"
import { ExpandThreadLink } from "./ExpandThreadLink.tsx"

// The retry message + follow-up now live in lib/retrySession so the sidebar's hover-revealed Retry
// shares this exact recovery path. Re-exported for existing importers.
export { STALLED_RETRY_MESSAGE } from "../lib/retrySession.ts"

// THE shared whole-thread action icons, rendered IDENTICALLY by the queue card header and the thread
// header so the two can never drift. Order left→right runs least→most important, so the primary verb
// sits at the far RIGHT. The verbs SPLIT on kind:
//   • SESSION (non-foreign): doc/open navigation, plus Retry on exactly the threads `offersRetry`
//     picks — the STALLED ones (the rail's yellow [!]) and the ones KILLED by a usage limit frizz will
//     auto-resume (the yellow hourglass, offered the same one-click continue). Every surface that renders this
//     component reads that same derivation, so the verb can never disagree between the card, the header
//     and the rail. It also carries the two live-process MAINTENANCE verbs — Reload plugins and Restart
//     worker — which sat in the lifecycle footer until 2026-08-26 (maintainer: "the restart worker
//     button should be at the top. I just realized it shouldn't be along the bottom"). They travel
//     TOGETHER: the plug glyph was chosen only because it sits beside the restart refresh and must not
//     share its vocabulary, so splitting them would orphan it. Each still gates itself (dev build,
//     broker-backed Claude, live process), so both render nothing on most rows.
//     Other lifecycle verbs (Mark as done / Snooze) live in ThreadLifecycleFooter; the AI rename
//     refresh is revealed by the title's own hover, in both this component's surfaces.
//   • SESSION (foreign): read-only. Only the doc/open NAVIGATION affordances — no kill/archive.
//   • LEGACY (kind !== "session"): the vestigial Mark-as split button, exactly as before.
export function HeaderActions({
  thread,
  expand,
  collapse,
  onDoc,
  onDone,
  onCollapse,
  collapsed,
  doneBusy,
  onStatusMutate,
  onStatusApplied,
  onStatusFailed,
}: {
  thread: ThreadView
  expand?: boolean // the drawer → the fullscreen door (ExpandThreadLink)
  collapse?: boolean // the /full page → the same door, closing (CollapseThreadLink). Never both.
  onDoc?: () => void // present only on the thread header → shows the frizz-document icon
  onDone: () => void // legacy Mark-as "done" path (parent-owned mutation)
  onCollapse?: () => void // queue cards → collapse/expand the card body to just its header
  collapsed?: boolean
  doneBusy?: boolean
  // Mutation pass-through for the LEGACY MarkAsButton choreography. Archive/Snooze callbacks belong
  // to ThreadLifecycleFooter.
  onStatusMutate?: () => void
  onStatusApplied?: () => void
  onStatusFailed?: () => void
}) {
  const isSession = thread.kind === "session"

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {onCollapse && (
        <IconBtn
          label={collapsed ? "Expand" : "Collapse"}
          icon={collapsed ? ChevronsUpDown : ChevronsDownUp}
          size={13}
          onClick={onCollapse}
        />
      )}
      {/* Maintenance FIRST, because the strip runs least→most important left→right and these are the
          two verbs you reach for about the worker rather than about the thread. */}
      <ReloadPluginsButton thread={thread} />
      <RestartWorkerButton thread={thread} />
      {onDoc && <IconBtn label="Frizz document" icon={FileText} size={14} onClick={onDoc} />}
      {/* THE FULLSCREEN DOOR, one slot, both directions — a real anchor that navigates IN PLACE on a
          plain click and leaves ⌘/middle/right-click to the browser. A surface only ever offers ONE of
          these: the drawer can be expanded, the /full page can be collapsed, and holding both halves in
          this one slot is what makes them share a position instead of the reader hunting for the way
          back (maintainer 2026-09-02: a collapse icon "in the same place where the expand icon is").
          Restored from 7a20f425; the drawer's ⋯ menu keeps its own entry and `f` (ThreadMenu.tsx). */}
      {expand && <ExpandThreadLink slug={thread.id} />}
      {collapse && <CollapseThreadLink slug={thread.id} />}
      {isSession ? (
        // A STALLED session (process gone, work unfinished) or one KILLED by an auto-resume usage limit
        // leads with recovery — Retry is the only exit/wait-state verb here; clearing a finished row is
        // the footer's job (Mark as done / Snooze). offersRetry already excludes foreign (read-only)
        // sessions, and — the point of the 2026-07-23 fix — archived and done-fenced ones, which are at
        // rest on purpose and must not advertise a recovery verb their rail row does not also mark.
        offersRetry(thread) ? <RetryButton slug={thread.id} /> : null
      ) : (
        <div className="ml-1">
          <MarkAsButton
            slug={thread.id}
            onDone={onDone}
            doneBusy={doneBusy}
            onMutateStart={onStatusMutate}
            onApplied={onStatusApplied}
            onFailed={onStatusFailed}
          />
        </div>
      )}
    </div>
  )
}

// Retry uses the same authoritative recovery path as any other follow-up (see lib/retrySession).
function RetryButton({ slug }: { slug: string }) {
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const apply = () => {
    setBusy(true)
    // retrySession is now an ordinary eager send: the thread paints as working and its retry message
    // appears as a queued bubble the instant this is clicked, so this local `busy` is only about THIS
    // button's own icon — the thread's feedback no longer waits on the round-trip.
    retrySession(queryClient, slug).finally(() => setBusy(false))
  }
  return (
    <Tooltip label="Retry — resume this session where it left off">
      <button
        onClick={apply}
        disabled={busy}
        aria-label="Retry exited session"
        onMouseDown={(e) => e.preventDefault()}
        className="ml-1 flex items-center gap-1.5 rounded-md border border-accent/45 bg-accent/10 px-2.5 py-1 text-[12px] font-medium text-accent outline-none transition-colors hover:border-accent/70 hover:bg-accent/15 disabled:opacity-50"
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
        Retry
      </button>
    </Tooltip>
  )
}

// A quiet icon button with an immediate dark tooltip. onMouseDown-preventDefault keeps DOM focus off the
// button so a click never steals the keyboard from a card's composer. `busy` swaps in a spinner.
function IconBtn({
  label,
  icon: Icon,
  size,
  busy,
  ...rest
}: { label: string; icon: ComponentType<{ size?: number; strokeWidth?: number }>; size: number; busy?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <Tooltip label={label}>
      <button
        {...rest}
        aria-label={label}
        onMouseDown={(e) => e.preventDefault()}
        className={HEADER_ICON_CLASS}
      >
        {busy ? <Loader2 size={size} strokeWidth={2} className="animate-spin" /> : <Icon size={size} strokeWidth={2} />}
      </button>
    </Tooltip>
  )
}

