import { useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Copy, Ellipsis, FileText, Maximize2, Plug, RefreshCw, SquareTerminal } from "lucide-react"
import type { ThreadView } from "@frizz/shared"
import { captureFullscreenEnterAnchor, rememberFullscreenOrigin } from "../lib/fullscreenHandoff.ts"
import { armFullscreenMorph } from "../lib/fullscreenMorph.ts"
import { spaNavigate } from "../lib/router.ts"
import { prefersReducedMotion } from "../lib/sheet.ts"
import { standaloneThreadHref } from "../lib/standaloneThreadRoute.ts"
import { HEADER_ICON_CLASS } from "../lib/headerIcon.ts"
import { useCommandHandler, useShortcutLabel } from "../lib/keyboardRuntime.ts"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "./ui/Menu.tsx"
import { OpenTerminalDialog } from "./ThreadTerminals.tsx"
import { Tooltip } from "./Tooltip.tsx"
import { useTerminalCommandMenuItem } from "./ExternalTerminalCommand.tsx"
import { useDevFrizzBuild } from "../lib/devBuild.ts"
import { restartWorker } from "../lib/restartWorker.ts"
import { offersReloadPlugins, offersRestartWorker, reloadThreadPlugins } from "../lib/workerMaintenance.ts"

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
//
// The ⤢ came back beside it on 2026-09-29 (ExpandThreadLink.tsx) — on the queue card's header and in the
// drawer's strip, where Colin had it — as a restoration of the original's one-click door; this menu keeps
// its entry and the drawer keeps `f` on it, and both halves navigate through openFullscreen below.

/**
 * Go to a thread's /full page from the surface it is shown in — a route change, not a document load,
 * wrapped in a VIEW TRANSITION so the drawer's panel visibly slides into its /full position.
 *
 * `href` defaults to the page project's /full address; a queue card of ANOTHER project passes its own
 * (its project's prefix), because the page's is the focused project's. `from` is any element inside that surface: the surface is read off it once, whether or not the
 * navigation animates, because it is also what the reader's place is measured against (the scroll
 * hand-off is continuity, not decoration, and a reader on reduced motion needs it more, not less). The
 * drawer-stack clear this needs happens on the /full route's first render (routes.tsx StandaloneRoute),
 * not here: the old page is snapshotted two renders AFTER the click, so a click-time clear removed the
 * very sheet the transition slides.
 */
export function openFullscreen(slug: string, from: HTMLElement | null, href = standaloneThreadHref(slug)): void {
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
  spaNavigate(href, { viewTransition: animate })
}

// THE HEADER'S OPEN TERMINAL ICON. A terminal belongs to the thread you are reading (ThreadTerminals.tsx),
// so it opens from that thread's header, in the folder its agent is working in; `t` is its key. It was an
// item in the menu below until 2026-09-29, when the maintainer asked for the header to keep only the
// fullscreen door, the terminal and close: the terminal came up to an icon, LEADING the strip so the ⋯
// menu stays beside close, and the verbs that had held icon space there (copy terminal command, Reload
// plugins, Restart worker, the Frizz document) went down into the menu.
export function ThreadTerminalButton({ slug }: { slug: string }) {
  const button = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const keys = useShortcutLabel("thread.terminal")
  useCommandHandler(button, () => setOpen(true))
  return (
    <>
      <OpenTerminalDialog slug={slug} open={open} onOpenChange={setOpen} />
      <Tooltip label={keys ? `Open terminal (${keys})` : "Open terminal"}>
        <button
          ref={button}
          type="button"
          aria-label="Open terminal"
          data-command="terminal"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setOpen(true)}
          className={HEADER_ICON_CLASS}
        >
          <SquareTerminal size={14} strokeWidth={2} aria-hidden />
        </button>
      </Tooltip>
    </>
  )
}

// THE DRAWER'S ⋯ MENU: the rarer verbs. `f` presses its trigger and goes straight to /full where there is
// fullscreen to enter (`fullscreen`); on /full itself the ⤡ owns `f` and this menu offers only the rest.
export function ThreadMenu({ thread, fullscreen, onDoc }: { thread: ThreadView; fullscreen: boolean; onDoc?: () => void }) {
  const slug = thread.id
  const trigger = useRef<HTMLButtonElement>(null)
  const queryClient = useQueryClient()
  const devBuild = useDevFrizzBuild()
  const keys = useShortcutLabel("thread.fullscreen")
  const ownSession = thread.kind === "session" && thread.foreign !== true
  const terminalCommand = useTerminalCommandMenuItem(slug)
  // `f` on this drawer goes straight to /full: the key presses the thread's `fullscreen` control, which is
  // this menu's trigger, and the handler takes the press instead of opening the menu.
  useCommandHandler(trigger, () => { if (fullscreen) openFullscreen(slug, trigger.current) })
  return (
    <Menu onOpenChange={(open) => { if (open && ownSession) terminalCommand.prefetch() }}>
      <MenuTrigger asChild>
        <button
          ref={trigger}
          type="button"
          aria-label="More"
          title="More"
          data-thread-menu={slug}
          data-command={fullscreen ? "fullscreen" : undefined}
          // The strip's shared focus behaviour: a click here must not take the keyboard away from the
          // composer below it.
          onMouseDown={(event) => event.preventDefault()}
          className={HEADER_ICON_CLASS}
        >
          <Ellipsis size={15} aria-hidden />
        </button>
      </MenuTrigger>
      <MenuContent align="end">
        {fullscreen && (
          <MenuItem value="fullscreen" onSelect={() => openFullscreen(slug, trigger.current)} icon={<Maximize2 size={12} aria-hidden />}>
            <span className="flex min-w-0 flex-1 items-center justify-between gap-4">
              <span>Open fullscreen</span>
              {keys && <span className="text-[10px] text-muted-55">{keys}</span>}
            </span>
          </MenuItem>
        )}
        {onDoc && (
          <MenuItem value="doc" onSelect={onDoc} icon={<FileText size={12} aria-hidden />}>
            Frizz document
          </MenuItem>
        )}
        {ownSession && (
          <MenuItem value="copy-terminal-command" onSelect={terminalCommand.copy} icon={<Copy size={12} aria-hidden />}>
            {terminalCommand.label}
          </MenuItem>
        )}
        {offersReloadPlugins(thread) && (
          <MenuItem value="reload-plugins" onSelect={() => void reloadThreadPlugins(thread)} icon={<Plug size={12} aria-hidden />}>
            Reload plugins
          </MenuItem>
        )}
        {offersRestartWorker(thread, devBuild) && (
          <MenuItem value="restart-worker" onSelect={() => void restartWorker(queryClient, slug)} icon={<RefreshCw size={12} aria-hidden />}>
            Restart worker
          </MenuItem>
        )}
      </MenuContent>
    </Menu>
  )
}
