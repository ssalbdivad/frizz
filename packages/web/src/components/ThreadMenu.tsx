import { useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Copy, Ellipsis, FileText, Plug, RefreshCw, SquareTerminal } from "lucide-react"
import type { ThreadView } from "@frizz/shared"
import { captureFullscreenEnterAnchor, rememberFullscreenOrigin } from "../lib/fullscreenHandoff.ts"
import { armFullscreenMorph } from "../lib/fullscreenMorph.ts"
import { spaNavigate } from "../lib/router.ts"
import { prefersReducedMotion } from "../lib/sheet.ts"
import { standaloneThreadHref } from "../lib/standaloneThreadRoute.ts"
import { HEADER_ICON_CLASS } from "../lib/headerIcon.ts"
import { useCommandHandler, useShortcutLabel } from "../lib/keyboardRuntime.ts"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "./ui/Menu.tsx"
import { canSpinoff, SpinoffDialog, SpinoffMark } from "./Spinoff.tsx"
import { startComposerTerminal } from "./ThreadTerminals.tsx"
import { useThreadApi } from "../api/threadApi.tsx"
import { Tooltip } from "./Tooltip.tsx"
import { useTerminalCommandMenuItem } from "./ExternalTerminalCommand.tsx"
import { useDevFrizzBuild } from "../lib/devBuild.ts"
import { restartWorker } from "../lib/restartWorker.ts"
import { offersReloadPlugins, offersRestartWorker, reloadThreadPlugins } from "../lib/workerMaintenance.ts"

// openFullscreen, the one navigation into a thread's /full page, shared by the ⤢ door (ExpandThreadLink.tsx)
// on the queue card and in the drawer header. It lived here while fullscreen was this menu's item
// (2026-09-28, maintainer: "the single thread view is only marginally useful at best and should probably
// be a dropdown option"); the ⤢ came back as an icon on 2026-09-29, and the duplicate menu item went.

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
//
// One press opens a SHELL there, with nothing to fill in. It opened a folder + command dialog until
// 2026-09-29 (maintainer: "it should open shell by default, don't ask what command to run"): the server
// already resolves the agent's folder when none is sent (router terminalStart -> threadWorkingDir), and a
// one-off command already has its own door, a `$ cmd` line in the thread's prompt box.
export function ThreadTerminalButton({ slug }: { slug: string }) {
  const api = useThreadApi()
  const button = useRef<HTMLButtonElement>(null)
  const keys = useShortcutLabel("thread.terminal")
  const open = () => startComposerTerminal(api, slug, undefined, () => {})
  useCommandHandler(button, open)
  const label = "Open a terminal where this agent is working"
  return (
    <Tooltip label={keys ? `${label} (${keys})` : label}>
      <button
        ref={button}
        type="button"
        aria-label={label}
        data-command="terminal"
        onMouseDown={(event) => event.preventDefault()}
        onClick={open}
        className={HEADER_ICON_CLASS}
      >
        <SquareTerminal size={14} strokeWidth={2} aria-hidden />
      </button>
    </Tooltip>
  )
}

// THE HEADER'S ⋯ MENU: the rarer verbs. It carried "Open fullscreen" and owned `f` until 2026-09-29, when
// the ⤢ beside it came back as an icon (ExpandThreadLink) and took the key: one door, not two.
//
// SPINOFF leads it (Spinoff.tsx): a new thread briefed from this one, asked of the thread as a whole, and
// this item is its only door. It has no key: the single-letter rule (lib/keybindings.ts) wants an initial
// of its label, and `s` is Snooze's.
export function ThreadMenu({ thread, onDoc }: { thread: ThreadView; onDoc?: () => void }) {
  const slug = thread.id
  const trigger = useRef<HTMLButtonElement>(null)
  const queryClient = useQueryClient()
  const devBuild = useDevFrizzBuild()
  const ownSession = thread.kind === "session" && thread.foreign !== true
  const terminalCommand = useTerminalCommandMenuItem(slug)
  const [spinoffOpen, setSpinoffOpen] = useState(false)
  return (
    <>
    {canSpinoff(thread) && <SpinoffDialog thread={thread} open={spinoffOpen} onOpenChange={setSpinoffOpen} />}
    <Menu onOpenChange={(open) => { if (open && ownSession) terminalCommand.prefetch() }}>
      <MenuTrigger asChild>
        <button
          ref={trigger}
          type="button"
          aria-label="More"
          title="More"
          data-thread-menu={slug}
          // The strip's shared focus behaviour: a click here must not take the keyboard away from the
          // composer below it.
          onMouseDown={(event) => event.preventDefault()}
          className={HEADER_ICON_CLASS}
        >
          <Ellipsis size={15} aria-hidden />
        </button>
      </MenuTrigger>
      <MenuContent align="end">
        {canSpinoff(thread) && (
          <MenuItem value="spinoff" onSelect={() => setSpinoffOpen(true)} icon={<SpinoffMark size={12} />}>
            Spinoff
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
    </>
  )
}
