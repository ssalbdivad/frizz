import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { Api } from "../api/rpc.ts"
import { useThreadApi, useThreadProjectId } from "../api/threadApi.tsx"
import { copyTextToClipboard } from "../lib/clipboard.ts"
import { showToast } from "../store.ts"

// The command is one of TWO genuinely different things, and pasting the wrong one wastes real time:
// an ATTACH joins the live pane (shows an in-flight turn and any permission prompt the worker is
// parked on), a RESUME starts a separate process off the transcript and can show neither. So the
// label and the toast name which one you are getting rather than calling both "resume".
const COPY_FAILED_TOAST = "Could not copy terminal command"
type TerminalMode = "attach" | "resume"
const COPIED_TOAST: Record<TerminalMode, string> = {
  attach: "Attach command copied",
  resume: "Resume command copied",
}
const MENU_LABEL: Record<TerminalMode, string> = {
  attach: "Copy attach command",
  resume: "Copy resume command",
}

// react-query cache key for a thread's resolved resume command. It is prefetched when the menu opens (see
// useTerminalCommandMenuItem) so the PICK can write it SYNCHRONOUSLY — no server round-trip inside the
// clipboard gesture. That single change fixes both reported bugs: the copy stops silently failing inside
// a live queue card (the async write otherwise lost its activation/focus window across the RPC), and the
// "copied" check stops lagging a full round-trip behind the click.
// Keyed by PROJECT as well as slug: a thread slug is unique only within its project, and a queue card on
// the cross-project page resolves another project's thread (useThreadApi) — two projects' `fix-auth`
// must not share one cached command.
const terminalCommandKey = (projectId: string | undefined, slug: string) => ["terminalCommand", projectId ?? "", slug] as const

// Resolve the terminal command, surfacing the server's reason when there is none to copy. Carries the
// MODE alongside the text so the label/toast can name what it actually is.
interface ResolvedTerminalCommand { command: string; mode: TerminalMode }
function resolveTerminalCommand(api: Api, slug: string): Promise<ResolvedTerminalCommand> {
  return api.threadTerminalCommand({ slug }).then((result) => {
    if (!result.command) throw new Error(result.reason ?? "No verified provider session is available to resume")
    return { command: result.command, mode: result.mode === "attach" ? "attach" : "resume" }
  })
}

// COLD-cache fallback: a click that beat the hover/focus prefetch still needs the command, so it does the
// round-trip inside the gesture. A plain `writeText` AFTER awaiting the RPC loses the click's transient
// user activation — the write then silently fails (always in Safari; in Chrome once activation expires or
// the window blurs). So write via the async ClipboardItem form: `clipboard.write` is invoked SYNCHRONOUSLY
// within the gesture and fed a promise, and the browser keeps activation alive while it resolves. A
// rejecting item-promise rejects `write` with the SAME error, so the "no resumable session yet" reason
// still reaches the toast. Older engines without async-ClipboardItem support — and INSECURE origins,
// where the whole async clipboard API is undefined — fall back to fetch-then-copyTextToClipboard,
// whose execCommand path is what makes the copy work on a plain-http LAN address at all.
async function copyResumeCommandAsync(api: Api, slug: string): Promise<TerminalMode> {
  const resolved = resolveTerminalCommand(api, slug)
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    await navigator.clipboard.write([
      new ClipboardItem({ "text/plain": resolved.then(({ command }) => new Blob([command], { type: "text/plain" })) }),
    ])
    // The clipboard already holds it; awaiting the same settled promise only reads back the mode.
    return (await resolved).mode
  }
  const { command, mode } = await resolved
  await copyTextToClipboard(command)
  return mode
}

interface CopyCallbacks {
  onSuccess?: () => void
  onError?: () => void
}

// The THREAD's project, not the page's (api/threadApi.tsx): on the cross-project page a queue card's
// terminal net (ChatView TerminalNetCard) asks for another project's thread, and `rpc` there addresses
// the focused project, which either has no such slug or has a different thread under it.
export function useCopyTerminalCommand(slug: string): (callbacks?: CopyCallbacks) => void {
  const api = useThreadApi()
  const copy = useMutation({
    mutationFn: () => copyResumeCommandAsync(api, slug),
  })
  return (callbacks) => copy.mutate(undefined, {
    onSuccess: (mode) => {
      callbacks?.onSuccess?.()
      showToast(COPIED_TOAST[mode])
    },
    onError: (error) => {
      callbacks?.onError?.()
      showToast(error instanceof Error ? `${COPY_FAILED_TOAST}: ${error.message}` : COPY_FAILED_TOAST, { duration: 7000 })
    },
  })
}

// THE THREAD MENU'S "Copy terminal command" (ThreadMenu.tsx). It was an icon in the drawer header's
// action strip until 2026-09-29, when the maintainer moved it into the ⋯ menu: reached for rarely, and
// the in-app terminal now covers most of what it was for.
//
// Always offered for a Frizz-owned session — resuming the same session in another terminal is safe (both
// CLIs allow multiple attached views), so there is no live-ownership gate. The copy always attempts; if
// the server genuinely has no resumable id (e.g. codex before its first turn), the toast says why.
//
// `prefetch` runs when the menu OPENS, which reliably precedes the pick by far more than the (DB-read)
// RPC takes, so `copy` usually finds the command cached and writes it SYNCHRONOUSLY inside the gesture —
// no round-trip in the clipboard's activation window. A cold cache falls through to the activation-safe
// async path. The label names the resolved mode once it is known and stays generic before that.
export function useTerminalCommandMenuItem(slug: string): { prefetch: () => void; copy: () => void; label: string } {
  const queryClient = useQueryClient()
  const copyAsync = useCopyTerminalCommand(slug)
  const api = useThreadApi()
  const commandKey = terminalCommandKey(useThreadProjectId(), slug)

  function prefetch() {
    void queryClient.prefetchQuery({
      queryKey: commandKey,
      queryFn: () => resolveTerminalCommand(api, slug),
      staleTime: 15_000,
    })
  }

  function copy() {
    const resolved = queryClient.getQueryData<ResolvedTerminalCommand>(commandKey)
    if (resolved) {
      void copyTextToClipboard(resolved.command).then(
        () => showToast(COPIED_TOAST[resolved.mode]),
        () => showToast(COPY_FAILED_TOAST, { duration: 7000 }),
      )
      return
    }
    copyAsync()
  }

  const prefetched = queryClient.getQueryData<ResolvedTerminalCommand>(commandKey)
  return { prefetch, copy, label: prefetched ? MENU_LABEL[prefetched.mode] : "Copy terminal command" }
}
