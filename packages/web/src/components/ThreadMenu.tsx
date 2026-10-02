import { useRef, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Code, Copy, Ellipsis, FileText, Loader2, Plug, RefreshCw, SquareTerminal, Trash2 } from "lucide-react"
import type { ThreadView } from "@frizz/shared"
import type { Api } from "../api/contract.ts"
import { captureFullscreenEnterAnchor, rememberFullscreenOrigin } from "../lib/fullscreenHandoff.ts"
import { armFullscreenMorph } from "../lib/fullscreenMorph.ts"
import { spaNavigate } from "../lib/router.ts"
import { prefersReducedMotion } from "../lib/sheet.ts"
import { standaloneThreadHref } from "../lib/standaloneThreadRoute.ts"
import { HEADER_ICON_CLASS } from "../lib/headerIcon.ts"
import { useCommandHandler, useShortcutLabel } from "../lib/keyboardRuntime.ts"
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "./ui/Menu.tsx"
import { Dialog } from "./ui/Dialog.tsx"
import { displayTitle } from "../groups.ts"
import { startComposerTerminal } from "./ThreadTerminals.tsx"
import { useThreadApi } from "../api/threadApi.tsx"
import { Tooltip } from "./Tooltip.tsx"
import { useTerminalCommandMenuItem } from "./ExternalTerminalCommand.tsx"
import { useDevFrizzBuild } from "../lib/devBuild.ts"
import { restartWorker } from "../lib/restartWorker.ts"
import { closeDrawersById, showToast, store } from "../store.ts"
import { runExternalOpen } from "../lib/externalOpen.ts"
import { embedded } from "../lib/embed.ts"
import { openInHostEditor } from "../lib/local-file-links.ts"
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

/** Open the thread's working folder in the External app (or `$EDITOR`) — the step `t` then `code .` took.
 *  The server resolves the folder, the same one a terminal on the thread starts in.
 *
 *  IN AN EDITOR'S SIDEBAR the editor is the one the human is sitting in, so the folder goes there, as a
 *  code-file link does (lib/local-file-links.ts openInHostEditor): the extension reveals it in this
 *  window's Explorer. Through the External app it opened a file manager or another window, or — with
 *  System default, or Copy path and no $EDITOR — said "Set External app to an editor in Settings" to a
 *  human already in one (sweep 2026-10-01). */
function openInEditor(api: Api, slug: string): void {
  if (embedded()) {
    api.threadWorkingDir({ slug }).then(
      ({ dir }) => openInHostEditor(dir),
      (cause: unknown) => showToast("Couldn't find this thread's folder", { detail: (cause instanceof Error ? cause.message : String(cause)).slice(0, 100) }),
    )
    return
  }
  void runExternalOpen(
    `editor:${slug}`,
    "Opening in editor…",
    () => api.openThreadFolder({ slug }),
    () => {},
    (message) => `Could not open an editor: ${message}`,
  )
}

// THE HEADER'S ⋯ MENU: the rarer verbs. It carried "Open fullscreen" and owned `f` until 2026-09-29, when
// the ⤢ beside it came back as an icon (ExpandThreadLink) and took the key: one door, not two. Spinoff
// led it for an evening, until the maintainer wanted it one press away on every card and header
// (SpinoffButton, Spinoff.tsx). The queue card carries it too (AllQueuesCard.tsx), inside the card's
// ThreadProjectScope, with `restart={false}`: Restart worker sends through the eager follow-up path,
// which always addresses the PAGE's project, so on another project's card it would restart the wrong
// thread. Every other item resolves through the scoped client.
export function ThreadMenu({ thread, onDoc, restart = true, className = HEADER_ICON_CLASS }: { thread: ThreadView; onDoc?: () => void; restart?: boolean; className?: string }) {
  const slug = thread.id
  const trigger = useRef<HTMLButtonElement>(null)
  const queryClient = useQueryClient()
  const api = useThreadApi()
  const devBuild = useDevFrizzBuild()
  const ownSession = thread.kind === "session" && thread.foreign !== true
  const terminalCommand = useTerminalCommandMenuItem(slug)
  const [open, setOpen] = useState(false)
  const onOpenChange = (next: boolean) => {
    setOpen(next)
    if (next && ownSession) terminalCommand.prefetch()
  }
  // The items' keys work without opening the menu: an item exists only while its menu is open, so the
  // trigger — the surface's one always-rendered anchor — carries their commands beside its own `m`.
  useCommandHandler(trigger, () => onOpenChange(true), "menu")
  useCommandHandler(trigger, () => { if (ownSession) openInEditor(api, slug) }, "editor")
  useCommandHandler(trigger, () => { if (ownSession) terminalCommand.copy() }, "copyCommand")
  const editorKeys = useShortcutLabel("thread.editor")
  const copyKeys = useShortcutLabel("thread.copyCommand")
  const menuKeys = useShortcutLabel("thread.menu")
  const [deleting, setDeleting] = useState(false)
  return (
    <>
    <Menu open={open} onOpenChange={onOpenChange}>
      <MenuTrigger asChild>
        <button
          ref={trigger}
          type="button"
          aria-label="More actions"
          title={menuKeys ? `More actions (${menuKeys})` : "More actions"}
          data-thread-menu={slug}
          data-command="menu editor copyCommand"
          // The strip's shared focus behaviour: a click here must not take the keyboard away from the
          // composer below it.
          onMouseDown={(event) => event.preventDefault()}
          className={className}
        >
          <Ellipsis size={15} aria-hidden />
        </button>
      </MenuTrigger>
      <MenuContent align="end">
        {onDoc && (
          <MenuItem value="doc" onSelect={onDoc} icon={<FileText size={12} aria-hidden />}>
            Frizz document
          </MenuItem>
        )}
        {ownSession && (
          <MenuItem value="open-in-editor" onSelect={() => openInEditor(api, slug)} icon={<Code size={12} aria-hidden />} shortcut={editorKeys}>
            Open in editor
          </MenuItem>
        )}
        {ownSession && (
          <MenuItem value="copy-terminal-command" onSelect={terminalCommand.copy} icon={<Copy size={12} aria-hidden />} shortcut={copyKeys}>
            {terminalCommand.label}
          </MenuItem>
        )}
        {offersReloadPlugins(thread) && (
          <MenuItem value="reload-plugins" onSelect={() => void reloadThreadPlugins(api, thread)} icon={<Plug size={12} aria-hidden />}>
            Reload plugins
          </MenuItem>
        )}
        {restart && offersRestartWorker(thread, devBuild) && (
          <MenuItem value="restart-worker" onSelect={() => void restartWorker(queryClient, slug)} icon={<RefreshCw size={12} aria-hidden />}>
            Restart worker
          </MenuItem>
        )}
        {ownSession && (
          <>
            <MenuSeparator />
            <MenuItem value="delete-thread" danger onSelect={() => setDeleting(true)} icon={<Trash2 size={12} aria-hidden />}>
              Delete thread…
            </MenuItem>
          </>
        )}
      </MenuContent>
    </Menu>
    {deleting && <DeleteThreadDialog thread={thread} onClose={() => setDeleting(false)} />}
    </>
  )
}

/**
 * The ⋯ menu's Delete, confirmed. It says what the operator could not otherwise know: a working agent is
 * stopped, and the name is free for a new thread (server router.ts deleteOwnedThread). Deleting old done
 * threads in bulk lives in Settings.
 */
function DeleteThreadDialog({ thread, onClose }: { thread: ThreadView; onClose: () => void }) {
  const api = useThreadApi()
  const name = displayTitle(thread)
  // Only a turn in flight earns the line: an idle worker is stopped too, but nobody is waiting on it.
  const working = thread.runtime === "running" || thread.runtime === "spawning" || thread.runtime === "perm-prompt"
  const remove = useMutation({
    mutationFn: () => api.deleteThread({ slug: thread.id }),
    onSuccess: () => {
      showToast(`Deleted ${name}`)
      onClose()
      // Its drawers (the thread, its sub-agents, shells and terminals) have nothing left to show; slide
      // them out rather than leave "Thread unavailable" where the thread was.
      closeDrawersById(store.drawers.filter((d) => d.slug === thread.id && !d.closing).map((d) => d.id))
    },
  })
  const error = remove.error instanceof Error ? remove.error.message : remove.error ? String(remove.error) : null
  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open && !remove.isPending) onClose() }}
      title={`Delete ${name}?`}
      className="w-[420px] max-w-[92vw]"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={remove.isPending}
            className="button-outline rounded-md px-3 py-1.5 text-[12px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-45"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
            className="button-outline flex items-center gap-1.5 rounded-md bg-danger-button/90 px-3 py-1.5 text-[12.5px] font-medium text-white outline-none transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {remove.isPending && <Loader2 size={12} className="animate-spin" />}
            Delete thread
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3 p-4 text-[12.5px] leading-relaxed text-muted">
        <p>
          {working ? "Its agent is stopped mid-turn, and the thread is" : "The thread is"} removed from Frizz with its notes and
          terminals. Its name is free for a new thread. This cannot be undone.
        </p>
        {error ? <p className="text-[11.5px] text-danger">{error}</p> : null}
      </div>
    </Dialog>
  )
}
