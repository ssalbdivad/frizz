import { Infinity as InfinityIcon, Settings as SettingsIcon } from "lucide-react"
import { Link } from "react-router"
import { store } from "../store.ts"
import { setQueueFilter, useQueueFilter } from "../lib/crossProject.ts"
import { isPlainLeftClick } from "../lib/standaloneThreadRoute.ts"
import { STATUS_ROW_ACTION, STATUS_ROW_ICON } from "../lib/statusRow.ts"
import { QuotaChips, useQuotaChipsVisible } from "./QuotaBar.tsx"
import { RestartFrizzButton } from "./RestartFrizzButton.tsx"
import { KeyboardShortcutsButton } from "./KeyboardShortcuts.tsx"
import { useShortcutLabel, withShortcut } from "../lib/keyboardRuntime.ts"

// THE STATUS ROW — one loose line along the TOP OF THE PROMPT BOX, controls at the left edge and the
// page's name at the right:
//
//   ∞ │ settings · shortcuts · reload │ Claude 83% · Codex 59%                    Everything
//
// It rides Everything's prompt box, at the top of the page's left column (AllQueues.tsx).
//
// IT IS LOOSE, NOT A CHIP. Until 2026-08-19 this was a FIXED bar pinned to the page's upper-left
// corner with its own fill, hairline and shadow — a screen's width away from the column it described,
// and opaque because a full sidebar or a scrolling narrow rail would otherwise paint through it
// (maintainer: "move the top left status bar contents s.t. they are loose along the top of the sidebar
// prompt box"). In the column there is nothing to pass behind it, so the surface is gone: no fill, no
// border, no shadow, no z-index. Its two ends land on the composer's own border, which is what makes a
// borderless strip read as belonging to the box below it.
//
// CONTROLS LEFT, NAME RIGHT (maintainer 2026-08-19). The row briefly ran the other way — the name
// leading, controls and quota trailing — which reads as a heading with its buttons pushed away. This
// way the left edge is one uninterrupted run of things you can press, and the name anchors the right
// edge as the row's one piece of prose.
//
// TWO DIVIDERS, NOT ONE, and the first one is the point: ∞ is the PAGE — every project — while settings
// and reload act on the app you are already in. One divider would group all three as "buttons"; two say
// the first one is a door out. The second divider separates the buttons from the readouts.
//
// IT NAMES THE PAGE, AND ONLY THE PAGE. It sat atop a project's board too, where its right edge was that
// project's owner/repo linking to the repo, until the board and then the project view went (2026-09-28).
// Atop Everything it names what the page shows — "Everything" — and never the project a new thread goes
// to, which is chosen inside the prompt box beside the model (AllQueues.tsx ProjectPicker), nor the
// queue's filter, which sits in the READY header over the cards it filters (AllQueues.tsx): a control
// sits over what it scopes. A project's repo is its "Open on GitHub", in the project list's ⋯ menu
// (ProjectActions.tsx ProjectMenu). The connection indicator went on 2026-08-28: its one informative
// state, disconnected, is one the page also shows by going stale.
//
// THE GAP IS 12px OF INK, not 12px of box — the same law lib/iconRhythm.ts states for the thread
// footer, solved for a strip that mixes 24px icon squares, hairlines, quota pills and a name. Each of
// those wears a different amount of dead space inside its own layout box, so a uniform `gap-2` drew six
// different distances (measured 2026-08-14, `scripts/ink-gaps.mjs --pad=0`, every CSS gap 8px) ranging
// 8.00px to 20.00px — a 2.5× spread on one provably uniform gap. The fix is per-mark, not per-gap:
// STATUS_ROW_ACTION collapses each icon square onto its glyph's ink, and then this one `gap-3` is the
// whole rhythm. Readings for the current row are in StatusRow.test.ts.

function Divider() {
  return <span aria-hidden="true" className="h-3 w-px shrink-0 bg-border" />
}

/** Takes no props, and reads its live values itself. */
export function StatusRow() {
  // Whether there is a quota group behind the second divider at all. Every chip hides itself when it
  // has no reading, so without this a row with neither provider reporting draws a trailing hairline
  // with nothing after it.
  const quotaVisible = useQuotaChipsVisible()
  const settingsKeys = useShortcutLabel("app.settings")
  // The ∞ is "every project": pressed, it lifts the queue's filter, and it wears the page's pill only
  // while nothing is filtered — as the rail's own ∞ does (ProjectRail.tsx).
  const filtered = useQueueFilter() !== null

  return (
    <div
      data-status-row
      // `mb-2.5` is the only thing holding the row off the prompt box, and the row carries no padding
      // of its own: it is flush with the composer's border on both sides, so the column reads as one
      // block rather than a strip parked above a box.
      className="mb-2.5 flex min-w-0 items-center gap-3 text-[12px]"
    >
      {/* THE DOOR HOME — Everything, every project's queue on one page, and the page you are on: a click
          lifts the queue filter and returns to the page's top (a trip through `/` would remount the page
          under the operator). ONE door since 2026-09-24, when the project grid's house beside it folded
          into Everything. The infinity is the maintainer's glyph for Everything.
          A 24px target like its neighbours, and a ROUTER Link: it was a raw `<a href="/">` from 2026-08-19
          until 2026-09-04, which hard-loaded the document — measured at 116-411ms with a 0.15 CLS, and it
          threw away the app socket and the whole query cache on the way out. No `-ml-px` ink trim of its
          own: the infinity's stroke reaches one unit further out in lucide's 24-unit box (x=1 against the
          house's x=2), which is that pixel already. */}
      <Link
        to="/"
        title="Everything"
        aria-label="Everything"
        aria-current={filtered ? undefined : "page"}
        className={`${STATUS_ROW_ACTION} ${filtered ? "" : "bg-elevated text-fg"}`}
        onClick={(event) => {
          if (!isPlainLeftClick(event)) return
          event.preventDefault()
          setQueueFilter(null)
          window.scrollTo({ top: 0, behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })
        }}
      >
        <InfinityIcon size={STATUS_ROW_ICON} aria-hidden="true" />
      </Link>
      <Divider />
      <button
        type="button"
        aria-label="Settings"
        title={withShortcut("Settings", settingsKeys)}
        className={STATUS_ROW_ACTION}
        onClick={() => (store.showSettings = true)}
      >
        <SettingsIcon size={STATUS_ROW_ICON} aria-hidden="true" />
      </button>
      {/* The keyboard shortcuts sheet — also `?` from anywhere, which its title names. */}
      <KeyboardShortcutsButton />
      {/* Greyed when there is no update to install; null only before a supervisor has answered, when
          the gap collapses and the row stays even. */}
      <RestartFrizzButton />
      {quotaVisible && (
        <>
          <Divider />
          <QuotaChips />
        </>
      )}
      {/* THE PAGE, pinned to the right edge. min-w-0 so it gives way before anything to its left does;
          every mark before it is shrink-0 and therefore always reachable. */}
      <span data-status-row-page className="ml-auto min-w-0 truncate font-semibold text-fg/90">
        Everything
      </span>
    </div>
  )
}
