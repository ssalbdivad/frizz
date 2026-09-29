import type { MouseEvent } from "react"
import { Maximize2 } from "lucide-react"
import { isPlainLeftClick, standaloneThreadHref } from "../lib/standaloneThreadRoute.ts"
import { HEADER_ICON_CLASS } from "../lib/headerIcon.ts"
import { openFullscreen } from "./ThreadMenu.tsx"
import { Tooltip } from "./Tooltip.tsx"

// THE FULLSCREEN DOOR, ⤢ — the one-click way into a thread's /full page, on the queue card's header and in
// the drawer header's action strip. Recovered from 7a20f425, where it was Colin's door on every surface a
// thread appeared on (it replaced the ↗ "Open in new tab" arrow on 2026-08-28: the fullscreen view is the
// ordinary way to focus on a thread, in THIS tab, with the address bar following — and a new tab only on
// the gestures a browser already reserves for that). The fork moved fullscreen into the drawer's ⋯ menu
// on 2026-09-28 and deleted this; the menu entry and its `f` key stay (ThreadMenu.tsx), and this door is
// back beside them because a verb one click deep in a menu is not the same as a door you can see.
//
// It stands in HeaderActions' fullscreen slot in the drawer — the slot the /full page's ⤡ closing half
// (CollapseThreadLink) occupies, so the icon that takes the reader in and the one that brings them back
// share one position (maintainer 2026-09-02).
//
// A real anchor, so ⌘/middle/right-click and "copy link address" need no code; a plain left click
// navigates in place through the drawer menu's own openFullscreen, so both doors take one path — the view
// transition from the drawer's panel, the reader's place, and the way back out.
export function ExpandThreadLink({
  slug,
  href = standaloneThreadHref(slug),
  command = false,
  size = 14,
  className,
  label = "Open fullscreen",
}: {
  slug: string
  /** The /full address. Defaults to the PAGE project's; a card of another project passes its own. */
  href?: string
  /** Carry `data-command="fullscreen"`, so `f` on this surface presses it (lib/keyboardRuntime.ts). Off
   *  in the drawer, where the ⋯ menu's trigger already owns the key. */
  command?: boolean
  size?: number
  className?: string
  label?: string
}) {
  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    // Never let the click reach the card or row underneath, which would open the drawer as well.
    event.stopPropagation()
    if (!isPlainLeftClick(event)) return
    event.preventDefault()
    openFullscreen(slug, event.currentTarget, href)
  }
  return (
    <Tooltip label={label}>
      <a
        href={href}
        aria-label={label}
        data-expand-thread={slug}
        data-command={command ? "fullscreen" : undefined}
        // Focus must not leave a card's composer, as with every other icon verb in the strip.
        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation() }}
        onClick={onClick}
        className={className ?? HEADER_ICON_CLASS}
      >
        <Maximize2 size={size} />
      </a>
    </Tooltip>
  )
}
