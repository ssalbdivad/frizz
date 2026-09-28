import { Settings as SettingsIcon } from "lucide-react"
import { store } from "../store.ts"
import { STATUS_ROW_ACTION, STATUS_ROW_ICON } from "../lib/statusRow.ts"
import { QuotaChips, useQuotaChipsVisible } from "./QuotaBar.tsx"
import { RestartFrizzButton } from "./RestartFrizzButton.tsx"
import { KeyboardShortcutsButton } from "./KeyboardShortcuts.tsx"
import { useShortcutLabel, withShortcut } from "../lib/keyboardRuntime.ts"

// THE STATUS ROW — one loose line along the TOP OF THE PROMPT BOX, the app's controls and then its
// readouts:
//
//   settings · shortcuts · reload │ Claude 83% · Codex 59%
//
// It rides the page's prompt box, at the top of its left column (AllQueues.tsx).
//
// IT IS LOOSE, NOT A CHIP. Until 2026-08-19 this was a FIXED bar pinned to the page's upper-left
// corner with its own fill, hairline and shadow — a screen's width away from the column it described,
// and opaque because a full sidebar or a scrolling narrow rail would otherwise paint through it
// (maintainer: "move the top left status bar contents s.t. they are loose along the top of the sidebar
// prompt box"). In the column there is nothing to pass behind it, so the surface is gone: no fill, no
// border, no shadow, no z-index. Its two ends land on the composer's own border, which is what makes a
// borderless strip read as belonging to the box below it.
//
// NO DOOR AND NO NAME (maintainer 2026-09-28: "there should no longer be an everything or an infinity
// button on the threads view on the left"). The row led with ∞, the door to Everything, and ended on the
// page's name — and before that, atop a project's board, on the project's owner/repo linking to its repo.
// With one page there is nowhere for a door to go and nothing for a name to tell apart. A project's repo
// is its "Open on GitHub", in the project list's ⋯ menu (ProjectActions.tsx ProjectMenu); the queue's
// filter sits in the READY header over the cards it filters. The connection indicator went on
// 2026-08-28: its one informative state, disconnected, is one the page also shows by going stale.
//
// ONE DIVIDER, between the buttons and the readouts.
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

  return (
    <div
      data-status-row
      // `mb-2.5` is the only thing holding the row off the prompt box, and the row carries no padding
      // of its own: it is flush with the composer's border on both sides, so the column reads as one
      // block rather than a strip parked above a box.
      className="mb-2.5 flex min-w-0 items-center gap-3 text-[12px]"
    >
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
    </div>
  )
}
