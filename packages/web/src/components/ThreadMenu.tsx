import { useRef } from "react"
import { Ellipsis, Maximize2 } from "lucide-react"
import { captureFullscreenEnterAnchor, rememberFullscreenOrigin } from "../lib/fullscreenHandoff.ts"
import { armFullscreenMorph } from "../lib/fullscreenMorph.ts"
import { spaNavigate } from "../lib/router.ts"
import { prefersReducedMotion } from "../lib/sheet.ts"
import { standaloneThreadHref } from "../lib/standaloneThreadRoute.ts"
import { HEADER_ICON_CLASS } from "../lib/headerIcon.ts"
import { useCommandHandler, useShortcutLabel } from "../lib/keyboardRuntime.ts"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "./ui/Menu.tsx"

// THE DRAWER'S "MORE" MENU, and the one way into a thread's /full page.
//
// Fullscreen was a door on every surface a thread appears on — the ⤢ on each queue card, on each row of
// the list, and in the drawer header — until 2026-09-28 (maintainer: "generally there are too many places
// in the ui where it is easy to navigate to a ui which is not the primary home ui (cross project). the
// single thread view is only marginally useful at best and should probably be a dropdown option"). So it
// is an option now, in the drawer of the thread you are already reading, and nowhere else: a card or a
// row opens the drawer, and the drawer is where you choose to take it further. `f` is the item's
// accelerator, pressed on the drawer you are reading (lib/keyboardRuntime.ts), and on /full the same key
// leaves (CollapseThreadLink).

/**
 * Go to a thread's /full page from the surface it is shown in — a route change, not a document load,
 * wrapped in a VIEW TRANSITION so the drawer's panel visibly slides into its /full position.
 *
 * `from` is any element inside that surface: the surface is read off it once, whether or not the
 * navigation animates, because it is also what the reader's place is measured against (the scroll
 * hand-off is continuity, not decoration, and a reader on reduced motion needs it more, not less). The
 * drawer-stack clear this needs happens on the /full route's first render (routes.tsx StandaloneRoute),
 * not here: the old page is snapshotted two renders AFTER the click, so a click-time clear removed the
 * very sheet the transition slides.
 */
export function openFullscreen(slug: string, from: HTMLElement | null): void {
  const animate = !prefersReducedMotion()
  const surface = from?.closest<HTMLElement>("[data-vt-chat]") ?? null
  // Where they are in it, for /full to restore instead of jumping to the tail (lib/fullscreenHandoff).
  captureFullscreenEnterAnchor(surface, slug)
  // And the address they are at, so the way OUT of /full leads back to this same drawer.
  if (typeof location !== "undefined") rememberFullscreenOrigin(slug, location.pathname)
  if (animate && surface) {
    // Tag it as the transition's shared element — imperatively, so exactly ONE element ever carries the
    // name (`view-transition-name` must be unique). The /full page's thread column wears the same name
    // statically, so the browser morphs one into the other — from the part of it the reader can SEE
    // (lib/fullscreenMorph).
    surface.style.viewTransitionName = "thread-chat"
    armFullscreenMorph(surface)
  }
  spaNavigate(standaloneThreadHref(slug), { viewTransition: animate })
}

export function ThreadMenu({ slug }: { slug: string }) {
  const trigger = useRef<HTMLButtonElement>(null)
  const keys = useShortcutLabel("thread.fullscreen")
  // `f` on this drawer goes straight to /full: the key presses the thread's `fullscreen` control, which is
  // this menu's trigger, and the handler takes the press instead of opening the menu.
  useCommandHandler(trigger, () => openFullscreen(slug, trigger.current))
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          ref={trigger}
          type="button"
          aria-label="More"
          title="More"
          data-thread-menu={slug}
          data-command="fullscreen"
          // The strip's shared focus behaviour: a click here must not take the keyboard away from the
          // composer below it.
          onMouseDown={(event) => event.preventDefault()}
          className={HEADER_ICON_CLASS}
        >
          <Ellipsis size={15} aria-hidden />
        </button>
      </MenuTrigger>
      <MenuContent align="end">
        <MenuItem value="fullscreen" onSelect={() => openFullscreen(slug, trigger.current)} icon={<Maximize2 size={12} aria-hidden />}>
          <span className="flex min-w-0 flex-1 items-center justify-between gap-4">
            <span>Open fullscreen</span>
            {keys && <span className="text-[10px] text-muted-55">{keys}</span>}
          </span>
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}
