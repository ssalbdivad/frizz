import * as RadixDialog from "@radix-ui/react-dialog"
import { useEffect, useRef, useState } from "react"
import { useSnapshot } from "valtio"
import { Command } from "cmdk"
import { store, openThread, openNewThread, pushDrawer, topThreadSlug, closeDrawersById } from "../store.ts"
import { rpc } from "../api/rpc.ts"
import { useBoard, asThreads } from "../hooks.ts"
import { sortThreads, displayName, displayTitle } from "../groups.ts"
import { isCrossProjectPath } from "../lib/base-path.ts"
import { aboveDrawersZ } from "../lib/overlaySurface.ts"

// Cmd+K palette: fuzzy-jump to any thread (over title + slug, grouped like the sidebar) plus the
// common actions. cmdk owns the filtering; we set each item's `value` to the text we want matched.
//
// A MODAL RADIX DIALOG, from the same @radix-ui/react-dialog every drawer uses. It was a plain z-[60] div
// outside Radix's layer stack until 2026-10-01, which a thread drawer made unusable: below 800px (and at any
// width in an editor's sidebar) the thread is a modal Radix dialog, so its focus trap kept the keyboard in
// the thread — typing "pricing" left the input empty — its `body{pointer-events:none}` killed every click on
// the palette, and the first Escape closed the THREAD under the still-open palette. On a desktop the Escape
// order was the same and Tab walked out into the page. As a Radix layer it is the topmost one: its scope
// pauses the thread's trap, its content takes the pointer, Tab loops inside it, and Escape is its own.
export function CommandPalette() {
  const snap = useSnapshot(store)
  const board = useBoard()
  const [search, setSearch] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)
  // Captured as the palette opens, so closing it can hand focus back (see onCloseAutoFocus).
  const openerRef = useRef<HTMLElement | null>(null)

  // Reset the query each time it opens so a stale filter never hides everything.
  useEffect(() => {
    if (snap.showPalette) setSearch("")
  }, [snap.showPalette])

  if (!snap.showPalette) return null

  const threads = sortThreads(asThreads(board?.threads ?? []))
  // "Current thread" = the topmost open thread drawer (there is no nav selection anymore).
  const topSlug = snap.drawers.length ? [...snap.drawers].reverse().find((d) => d.kind === "thread")?.slug : undefined
  const selected = board?.threads.find((t) => t.id === topSlug)
  // Over every open drawer (lib/overlaySurface.ts aboveDrawersZ): a fixed z-[60] lost to the fifth layer.
  const z = aboveDrawersZ(snap.drawers.length)

  function close() {
    store.showPalette = false
  }

  function run(fn: () => void) {
    fn()
    close()
  }

  function jump(slug: string) {
    openThread(slug) // side drawer: chat, or the frizz doc for a never-spawned thread
  }

  return (
    <RadixDialog.Root open onOpenChange={(open) => { if (!open) close() }}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 bg-scrim-50" style={{ zIndex: z }} />
        <RadixDialog.Content
          aria-describedby={undefined}
          // Escape closes ONLY the palette. Radix dismisses it from a document-capture listener; without
          // this the key went on to DrawerStack's window listener, which would unwind a drawer under it too.
          onEscapeKeyDown={(event) => event.stopPropagation()}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            openerRef.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
            inputRef.current?.focus({ preventScroll: true })
          }}
          // Back to where the palette was opened from — unless the palette's own action put focus somewhere
          // on purpose (a jump focuses the thread it opened), which this must not undo.
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            const active = document.activeElement
            if (active && active !== document.body) return
            if (openerRef.current?.isConnected) openerRef.current.focus({ preventScroll: true })
          }}
          className="fixed left-1/2 top-[12vh] w-[560px] max-w-[92vw] -translate-x-1/2 outline-none"
          style={{ zIndex: z + 1 }}
        >
          <RadixDialog.Title className="sr-only">Command palette</RadixDialog.Title>
          <Command
            label="Command palette"
            className="w-full rounded-lg border border-border bg-panel shadow-2xl overflow-hidden"
            // cmdk defaults to matching the DOM text; we drive matching via each item's `value` instead.
            filter={(value: string, query: string, _keywords?: string[]) => (value.toLowerCase().includes(query.toLowerCase()) ? 1 : 0)}
          >
            <Command.Input
              ref={inputRef}
              value={search}
              onValueChange={setSearch}
              // The whole sentence needs ~300px of box. Narrower (a 300px sidebar) it clipped mid-word, "…run a
              // comman", and no ellipsis can help: Chrome draws none on the placeholder of a FOCUSED input, and
              // this one always is. So a narrow palette says the half that names what you type. `text-ellipsis`
              // still covers a long query once focus has left the box.
              placeholder={narrowPalette() ? "Jump to a thread…" : "Jump to a thread or run a command…"}
              className="w-full px-4 h-12 bg-transparent outline-none border-b border-border text-sm text-ellipsis placeholder:text-muted"
            />
            <Command.List className="max-h-[52vh] overflow-y-auto py-1.5">
              <Command.Empty className="px-4 py-6 text-center text-sm text-muted">No matches.</Command.Empty>

              <Command.Group heading="Actions" className="cmdk-group">
                {/* "Home" died with the Home view (the dispatch box is always visible on the queue);
                    "New thread" opens the anywhere-modal. Queue closes every drawer, back to the page. */}
                <Item value="new thread create home" onSelect={() => run(() => openNewThread())}>
                  New thread
                </Item>
                <Item value="queue todos inbox pending" onSelect={() => run(() => closeDrawersById(store.drawers.map((d) => d.id)))}>
                  Queue
                </Item>
                <Item value="open settings preferences" onSelect={() => run(() => (store.showSettings = true))}>
                  Open settings
                </Item>
                <Item value="keyboard shortcuts keys hotkeys keybindings rebind" onSelect={() => run(() => (store.showShortcuts = true))}>
                  Keyboard shortcuts
                </Item>
                {selected && (
                  <>
                    <Item
                      value={`open details drawer doc ${displayTitle(selected)}`}
                      onSelect={() => run(() => { const t = topThreadSlug(); if (t) pushDrawer("doc", t) })}
                    >
                      {/* "Open", honestly — closing the palette-pushed layer is Esc's job, not a toggle. */}
                      Open thread details
                    </Item>
                    <Item
                      value={`mark complete done ${displayTitle(selected)}`}
                      onSelect={() => run(() => rpc.markComplete({ slug: selected.id }).catch(() => {}))}
                    >
                      Mark “{displayTitle(selected)}” complete
                    </Item>
                    <Item
                      value={`mark read ${displayTitle(selected)}`}
                      onSelect={() => run(() => rpc.markRead({ slug: selected.id }).catch(() => {}))}
                    >
                      Mark “{displayTitle(selected)}” read
                    </Item>
                  </>
                )}
              </Command.Group>

              {/* The page's board has not arrived yet (an editor's sidebar draws its rows from another feed, so
                  it can paint them first): say so, rather than listing Actions alone as if there were no threads. */}
              {!board && <Command.Loading className="px-4 py-1.5 text-[12px] text-muted">Loading threads…</Command.Loading>}

              {threads.length > 0 && (
                // On the cross-project page the palette searches the FOCUSED project only (the page project) —
                // say whose, since in All projects the page around it shows every project's.
                <Command.Group heading={isCrossProjectPath() ? `Threads in ${board?.projectName ?? board?.projectLabel ?? "this project"}` : "Threads"} className="cmdk-group">
                  {threads.map((t) => (
                    // The handle AND the stored words, so "shell bud" finds `shell-budgets` as readily as "shell-b".
                    <Item key={t.id} value={`${displayTitle(t)} ${displayName(t)} ${t.id}`} onSelect={() => run(() => jump(t.id))}>
                      {/* The title is what a reader scans for, so it keeps the room: the slug gives way first
                          (at most 40% of the row) and goes entirely under 360px, where it left a long-slugged
                          thread 0px of title in a 300px sidebar. */}
                      <span className="min-w-0 flex-1 truncate">{displayTitle(t)}</span>
                      <span className="ml-auto min-w-0 max-w-[40%] truncate text-[11px] text-muted-70 max-[360px]:hidden">{t.id}</span>
                    </Item>
                  ))}
                </Command.Group>
              )}
            </Command.List>
          </Command>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

// The width under which the palette (92vw) is too narrow for its full placeholder — and for each row's slug
// beside its title (the slug's `max-[360px]:hidden`).
function narrowPalette(): boolean {
  return typeof window !== "undefined" && window.innerWidth <= 360
}

function Item({ value, onSelect, children }: { value: string; onSelect: () => void; children: React.ReactNode }) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="mx-1.5 px-2.5 py-1.5 rounded flex items-center gap-2 text-sm cursor-pointer data-[selected=true]:bg-panel-2 data-[selected=true]:text-fg text-muted"
    >
      {children}
    </Command.Item>
  )
}
