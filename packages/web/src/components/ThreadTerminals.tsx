import { lazy, Suspense, useEffect, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Loader2, SquareTerminal, X } from "lucide-react"
import type { ThreadTerminal, ThreadView } from "@frizz/shared"
import { useThreadApi, useThreadApiBase, useThreadProjectDir } from "../api/threadApi.tsx"
import type { Api } from "../api/rpc.ts"
import { useBoard } from "../hooks.ts"
import { CHILD_ARROW, CHILD_ARROW_CLASS, CHILD_KIND_TAG_CLASS, CHILD_MARK_SLOT_CLASS } from "../lib/childOps.ts"
import { compactElapsedSince } from "../lib/durationLabels.ts"
import { draftKey, useDraft } from "../lib/drafts.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { abbreviateHome } from "../lib/paths.ts"
import { promptingTerminal, runningTerminals, terminalFailed, terminalLive, terminalStateLabel } from "../lib/threadTerminals.ts"
import { projectSlug } from "../lib/base-path.ts"
import { pushTerminalDrawer, showToast, store } from "../store.ts"
import { Dialog } from "./ui/Dialog.tsx"

// A THREAD'S TERMINALS, drawn inside the thread (server thread-terminals.ts; lib/threadTerminals.ts). A
// terminal is opened ON a thread — the drawer's ⋯ menu, `t`, or a `$ cmd` line in its prompt box — and
// runs in the folder that thread's agent is working in. It never gets a row or a card of its own (the
// sidebar is a column of thread NAMES, and Colin's rule upstream is density): it shows as a line in its
// thread's strip, and as one small mark on its thread's row.
//
// LAZY for the same reason every xterm consumer is: @xterm/xterm is browser-only, and node (tests)
// imports these components transitively.
const TerminalPane = lazy(() => import("./TerminalPane.tsx").then((m) => ({ default: m.TerminalPane })))

// ── the strip ─────────────────────────────────────────────────────────────────────────────────────────

// THE ROW'S BOX IS THE OPS STRIP'S ROW BOX (ChildOpRow's sheet density): the same arrow, the same 9px mark
// slot, the same fixed kind-tag track, 11.5px throughout — so a terminal line sits in the drawer's strip
// under the ⤷ AGENT / ⤷ SHELL lines and the eye runs down ONE label column. Written out here rather than
// added as a fifth ChildOpRow kind because that row's states are liveness states only ("there is
// deliberately NO finished glyph"), and a terminal's finished run is worth a line: its exit code is the
// reason the human opened it.
const ROW = "flex min-w-0 items-center gap-1.5 text-[11.5px]"
const IDENTITY = "group flex min-w-0 max-w-[70%] items-center gap-1.5 overflow-hidden text-left outline-none rounded-sm focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus-ink-60"
// A finished run's mark, in the slot the live dot takes: the terminal glyph, 1em, centred on the label's
// cap band by the browser's own `cap` unit (the ThreadLinks icon's correction, which measured 0px in both
// fonts). The slot is 9px and the glyph ~11.5px; it overflows the slot symmetrically, as the links' does.
const DONE_ICON = "h-[1em] w-[1em] shrink-0 translate-y-[calc(0.5em_-_0.5cap)]"

/** The terminals strip of one thread: a line per open terminal. `surface="card"` is a queue card's copy,
 *  which also draws a terminal waiting at a prompt as its live pane, so the answer is typed right there —
 *  the prompt is WHY the card is in the queue. Renders nothing when the thread has none. */
export function ThreadTerminalsStrip({
  thread,
  surface,
  onOpen,
  className,
}: {
  thread: Pick<ThreadView, "id" | "terminals">
  surface: "drawer" | "card"
  /** What opening a line does. Absent ⇒ the terminal's own drawer, over this thread's. */
  onOpen?: (terminal: ThreadTerminal) => void
  className?: string
}) {
  const terminals = thread.terminals ?? []
  const prompting = surface === "card" ? promptingTerminal(thread) : undefined
  const base = useThreadApiBase()
  if (terminals.length === 0) return null
  const open = onOpen ?? ((terminal: ThreadTerminal) => pushTerminalDrawer(thread.id, terminal.id, { label: terminal.command }))
  return (
    <div data-thread-terminals={surface} className={`flex min-w-0 flex-col gap-0.5 ${className ?? ""}`}>
      {terminals.map((terminal) => (
        <TerminalLine key={terminal.id} terminal={terminal} onOpen={() => open(terminal)} />
      ))}
      {prompting && (
        // Its live screen, a few rows tall: enough for the prompt and the lines above it. Keyed on the RUN,
        // like the drawer's pane, so a restart is a fresh screen. No focus grab — a card is one of many.
        <div data-terminal-prompt-pane={prompting.id} className="mt-1.5 flex h-[168px] min-w-0 overflow-hidden rounded-md border border-attention/40">
          <Suspense fallback={<div className="flex-1 bg-bg" />}>
            <TerminalPane key={`${prompting.id}:${prompting.runId}`} id={prompting.id} base={base} focusOnMount={false} exitedStatus={() => null} />
          </Suspense>
        </div>
      )}
    </div>
  )
}

function TerminalLine({ terminal, onOpen }: { terminal: ThreadTerminal; onOpen: () => void }) {
  const api = useThreadApi()
  const board = useBoard()
  const now = useNowMs()
  const [busy, setBusy] = useState(false)
  const running = terminal.state === "running"
  const failed = terminalFailed(terminal)
  const label = terminal.command
  // Where it runs, when that is not simply the project: the worktree's own name is what tells two
  // terminals on two checkouts apart at a glance. The full path is in the tooltip.
  const folder = terminal.cwd && terminal.cwd !== board?.projectDir ? terminal.cwd.split(/[\\/]/).filter(Boolean).pop() : undefined
  const reading = running && !terminal.awaitingInput ? compactElapsedSince(terminal.startedAt, now) : undefined
  const stateText = running && !terminal.awaitingInput ? undefined : terminalStateLabel(terminal)
  const where = terminal.cwd ? abbreviateHome(terminal.cwd, board?.homeDir) : undefined
  // The × is Stop while it runs and Remove once it has ended — the two honest meanings ChildOpRow's × has.
  const dismiss = () => {
    if (busy) return
    setBusy(true)
    const call = running ? api.terminalStop({ id: terminal.id }) : api.terminalRemove({ id: terminal.id })
    call
      .catch((error: unknown) => showToast(error instanceof Error ? error.message : `Could not ${running ? "stop" : "remove"} this terminal`))
      .finally(() => setBusy(false))
  }
  return (
    <div className={ROW} data-terminal-row={terminal.id} data-terminal-state={terminal.awaitingInput ? "prompt" : terminal.state}>
      <button
        type="button"
        onClick={onOpen}
        // The strip sits inside a card or drawer whose own mousedown handler would otherwise act on it.
        onMouseDown={(event) => event.stopPropagation()}
        title={where ? `Open terminal — ${label}\n${where}` : `Open terminal — ${label}`}
        aria-label={`Open terminal: ${label}`}
        className={`${IDENTITY} cursor-pointer`}
      >
        <span aria-hidden className={CHILD_ARROW_CLASS}>{CHILD_ARROW}</span>
        <span className={`frizz-op-dot-slot ${CHILD_MARK_SLOT_CLASS}`}>
          {terminalLive(terminal) ? (
            // A live run pulses the shell's azure: it is a shell process, the human's own.
            <span aria-hidden className="frizz-live-dot frizz-live-dot--shell" data-running-indicator="operation" />
          ) : terminal.awaitingInput ? (
            <span aria-hidden className="frizz-live-dot frizz-live-dot--attention" data-running-indicator="prompt" />
          ) : (
            <SquareTerminal aria-hidden className={`${DONE_ICON} ${failed ? "text-danger-soft" : "text-muted-45"}`} />
          )}
        </span>
        <span className={CHILD_KIND_TAG_CLASS}>TERM</span>
        <span className="font-mono-keep min-w-0 truncate text-[11px] text-muted-70 group-hover:text-fg/80 group-hover:underline">{label}</span>
      </button>
      <button
        type="button"
        onClick={dismiss}
        onMouseDown={(event) => event.stopPropagation()}
        disabled={busy}
        title={running ? "Stop — end this terminal's process" : "Remove — forget this finished terminal"}
        aria-label={`${running ? "Stop" : "Remove"} terminal: ${label}`}
        className="shrink-0 rounded-sm p-0.5 text-muted-45 outline-none transition-colors hover:text-fg focus-visible:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:opacity-50"
      >
        {busy ? <Loader2 size={11} className="animate-spin" /> : <X size={11} />}
      </button>
      <span className="ml-auto flex min-w-0 shrink-0 items-center gap-1 pl-1.5 text-muted-40">
        {folder && <span data-terminal-folder className="min-w-0 max-w-[12ch] truncate" title={where}>{folder}</span>}
        {folder && (stateText || reading) && <span aria-hidden className="text-muted-25">·</span>}
        {stateText && (
          <span className={terminal.awaitingInput ? "text-attention" : failed ? "text-danger-soft" : undefined}>{stateText}</span>
        )}
        {reading && <span title={`Running for ${reading}`}>{reading}</span>}
      </span>
    </div>
  )
}

// ── the row's mark ────────────────────────────────────────────────────────────────────────────────────

// ONE small glyph after a thread's title in the rail, while any terminal on it is running — the whole of
// a terminal's presence in the sidebar (a row is its title, and nothing else, bar trailers like the
// provider mark this sits beside). Azure like the running dot; attention-yellow while one waits at a
// prompt, which is also what put the thread in the queue. Absent when nothing runs: a finished terminal
// is history, read in the thread's strip.
//
// GEOMETRY, measured (visual-review cap-band probe, 13px sans title, dsf 6): see TERMINAL_MARK_CLASS.
export function ThreadTerminalMark({ thread }: { thread: Pick<ThreadView, "terminals"> }) {
  const running = runningTerminals(thread)
  if (running.length === 0) return null
  const prompting = running.some((terminal) => terminal.awaitingInput)
  const names = running.map((terminal) => terminal.command).join(", ")
  const label = prompting
    ? `Terminal waiting for input: ${promptingTerminal(thread)?.command ?? names}`
    : `${running.length === 1 ? "Terminal" : `${running.length} terminals`} running: ${names}`
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-thread-terminal-mark={prompting ? "prompt" : "running"}
      className={`${TERMINAL_MARK_CLASS} ${prompting ? "text-attention" : "text-shell"}`}
    >
      <SquareTerminal aria-hidden="true" focusable="false" className="size-full" strokeWidth={2.25} viewBox="2 2 20 20" />
    </span>
  )
}

// The glyph is lucide's square-terminal CROPPED to its ink (viewBox 2 2 20 20: the 18-unit rounded square
// plus its stroke), so the box IS the ink and `ml-1` is 4px of ink gap, as it is for the provider marks.
// 10px of ink, the codex/ACP marks' size, so the two trailers read as one family.
export const TERMINAL_MARK_CLASS = "ml-1 inline-flex size-[10px] shrink-0"

// ── opening one ───────────────────────────────────────────────────────────────────────────────────────

/** Start a terminal on a thread and show it: the terminal's drawer, over the thread's. */
export async function openThreadTerminal(api: Api, slug: string, input: { command?: string; cwd?: string }): Promise<void> {
  const { id } = await api.terminalStart({ slug, ...input })
  pushTerminalDrawer(slug, id, { label: input.command })
}

/** Open a terminal from the thread composer's `$` line (lib/threadTerminals.ts composerTerminalLine). */
export function startComposerTerminal(api: Api, slug: string, command: string | undefined, onFailed: () => void): void {
  openThreadTerminal(api, slug, { command }).catch((error: unknown) => {
    onFailed()
    showToast(`Could not open a terminal: ${(error instanceof Error ? error.message : String(error)).slice(0, 80)}`)
  })
}

// What the folder above is, in the dialog's own words.
const SOURCE_HINT = {
  transcript: "Where the agent is working now.",
  session: "The folder the agent's session started in.",
  project: "The project root.",
} as const

// THE "OPEN TERMINAL" DIALOG — two fields and a button. The FOLDER opens on where the thread's agent is
// working right now (the server's threadWorkingDir: the newest folder its transcript names, lifted to the
// checkout it lies in — the project root, or the worktree the agent moved into), and the human can
// retarget it before anything runs. The COMMAND is optional: empty opens an interactive shell there.
export function OpenTerminalDialog({ slug, open, onOpenChange }: { slug: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const api = useThreadApi()
  const board = useBoard()
  const projectDir = useThreadProjectDir()
  const [command, setCommand, clearCommand] = useDraft(draftKey.terminalCommand(projectDir, slug))
  const commandRef = useRef<HTMLInputElement>(null)
  const where = useQuery({
    queryKey: ["threadWorkingDir", projectDir, slug],
    queryFn: () => api.threadWorkingDir({ slug }),
    enabled: open,
    // Re-read on every opening: the agent may have moved since.
    staleTime: 0,
  })
  const [folder, setFolder] = useState("")
  const [touched, setTouched] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Fill the folder from the reading until the human edits it; reset both when the dialog reopens.
  useEffect(() => {
    if (!open) {
      setTouched(false)
      setError(null)
      return
    }
    if (!touched && where.data) setFolder(abbreviateHome(where.data.dir, board?.homeDir))
  }, [open, where.data, touched, board?.homeDir])

  function submit() {
    const cwd = folder.trim()
    if (pending || !cwd) return
    setPending(true)
    setError(null)
    const line = command.trim() || undefined
    openThreadTerminal(api, slug, { command: line, cwd: expandHome(cwd, board?.homeDir) })
      .then(() => {
        clearCommand()
        onOpenChange(false)
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setPending(false))
  }

  const field = "font-mono-keep block w-full min-w-0 rounded-md border border-border bg-bg px-2.5 py-1.5 text-[12.5px] text-fg outline-none transition-colors placeholder:font-sans placeholder:text-muted focus:border-accent"
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!pending) onOpenChange(next) }}
      title="Open terminal"
      className="w-[460px] max-w-[92vw]"
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        commandRef.current?.focus()
      }}
      footer={
        <>
          <button
            type="button"
            disabled={pending}
            onClick={() => onOpenChange(false)}
            className="button-outline rounded-md px-3 py-1.5 text-[12px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-45"
          >
            Cancel
          </button>
          <button
            type="button"
            data-open-terminal-submit
            disabled={pending || !folder.trim()}
            onClick={submit}
            className="button-outline flex items-center gap-1.5 rounded-md bg-fg px-3 py-1.5 text-[12px] font-medium text-bg outline-none transition-opacity hover:opacity-90 disabled:opacity-45"
          >
            {pending && <Loader2 size={12} className="animate-spin" />}
            Open terminal
          </button>
        </>
      }
    >
      <form
        data-open-terminal
        className="flex flex-col gap-3 p-4 text-[12px]"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-muted">Folder</span>
          <input
            data-open-terminal-folder
            value={folder}
            onChange={(event) => {
              setTouched(true)
              setFolder(event.target.value)
            }}
            placeholder={where.isLoading ? "Finding where the agent is working…" : "/path/to/folder"}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            data-1p-ignore
            className={field}
          />
          <span className="text-[11px] text-muted-60">
            {where.data && !touched ? SOURCE_HINT[where.data.source] : where.isError ? "Could not tell where the agent is working." : " "}
          </span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted">Command</span>
          <div className="relative flex items-center">
            <span aria-hidden className="font-mono-keep pointer-events-none absolute left-2.5 select-none text-[12.5px] text-muted-60">$</span>
            <input
              ref={commandRef}
              data-open-terminal-command
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="Leave empty for a shell"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              data-1p-ignore
              className={`${field} pl-6`}
            />
          </div>
        </label>
        {error && <p role="alert" className="text-[11.5px] text-danger-soft">{error}</p>}
        {/* Enter in either field submits; the hidden button is what makes it a real form submit. */}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

function expandHome(path: string, homeDir: string | undefined): string {
  if (!homeDir) return path
  if (path === "~") return homeDir
  return path.startsWith("~/") ? `${homeDir}/${path.slice(2)}` : path
}

/** Whether a card's thread is the page's focused project's, so its terminal can open over its drawer here. */
export function focusedProject(slug: string | undefined): boolean {
  const focus = projectSlug()
  return slug === focus && store.board?.projectSlug === focus
}
