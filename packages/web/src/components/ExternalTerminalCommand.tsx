import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Check, TerminalSquare } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { Api } from "../api/rpc.ts"
import { useThreadApi, useThreadProjectId } from "../api/threadApi.tsx"
import { copyTextToClipboard } from "../lib/clipboard.ts"
import { createCopyCommandFeedback } from "../lib/copyCommandFeedback.ts"
import { showToast } from "../store.ts"
import { HEADER_ICON_CLASS } from "../lib/headerIcon.ts"
import { Tooltip } from "./Tooltip.tsx"

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
const BUTTON_LABEL: Record<TerminalMode, string> = {
  attach: "Copy command to attach to this thread's live terminal",
  resume: "Copy command to resume this thread in a new terminal",
}

// react-query cache key for a thread's resolved resume command. It is prefetched on hover/focus (see
// CopyTerminalCommandButton) so the CLICK can write it SYNCHRONOUSLY — no server round-trip inside the
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

// Always clickable for a Frizz-owned session — resuming the same session in another terminal is safe
// (both CLIs allow multiple attached views), so there is no live-ownership gate. The click always
// attempts a copy; if the server genuinely has no resumable id (e.g. codex before its first turn),
// the copy surfaces the reason as a toast rather than pre-disabling the affordance.
export function CopyTerminalCommandButton({ slug }: { slug: string }) {
  const [copied, setCopied] = useState(false)
  const feedback = useRef<ReturnType<typeof createCopyCommandFeedback> | null>(null)
  if (!feedback.current) {
    feedback.current = createCopyCommandFeedback(setCopied, {
      setTimeout: (callback, delay) => window.setTimeout(callback, delay),
      clearTimeout: (timer) => window.clearTimeout(timer),
    })
  }
  const queryClient = useQueryClient()
  const copyAsync = useCopyTerminalCommand(slug)
  const api = useThreadApi()
  const commandKey = terminalCommandKey(useThreadProjectId(), slug)

  useEffect(() => () => feedback.current?.dispose(), [])

  // Warm the command into the query cache BEFORE the click, so handleCopy can write it synchronously.
  // Fires on hover and keyboard focus — both reliably precede the click by far more than the (DB-read)
  // RPC takes. staleTime dedupes repeat hovers; a failed resolve caches no data, so the click cleanly
  // falls through to the async path (which re-runs the RPC and surfaces the reason).
  function prefetch() {
    void queryClient.prefetchQuery({
      queryKey: commandKey,
      queryFn: () => resolveTerminalCommand(api, slug),
      staleTime: 15_000,
    })
  }

  // WARM cache (the common case, courtesy of the hover/focus prefetch): write the already-resolved command
  // SYNCHRONOUSLY inside the gesture — no RPC in the clipboard's activation window. That is what makes the
  // copy reliable in a live queue card (an async write otherwise lost that window to a focus/activation
  // blip) and what makes the check appear at once instead of a round-trip late. The check still lands only
  // once the clipboard write actually resolves — honest, but effectively instant since the value is in
  // hand; a genuine failure toasts and leaves no check. COLD cache: the activation-safe async path, unchanged.
  function handleCopy() {
    const resolved = queryClient.getQueryData<ResolvedTerminalCommand>(commandKey)
    if (resolved) {
      void copyTextToClipboard(resolved.command).then(
        () => {
          feedback.current?.begin()
          showToast(COPIED_TOAST[resolved.mode])
        },
        () => showToast(COPY_FAILED_TOAST, { duration: 7000 }),
      )
      return
    }
    copyAsync({ onSuccess: () => feedback.current?.begin() })
  }

  // The prefetch usually settles long before the click, so the label names the real mode. Before it
  // resolves there is nothing truthful to promise, so it stays generic rather than guessing "resume".
  const prefetched = queryClient.getQueryData<ResolvedTerminalCommand>(commandKey)
  const label = copied
    ? (prefetched ? COPIED_TOAST[prefetched.mode] : "Terminal command copied")
    : (prefetched ? BUTTON_LABEL[prefetched.mode] : "Copy terminal command")
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={handleCopy}
        onPointerEnter={prefetch}
        onFocus={prefetch}
        // The header action strip's own chrome (lib/headerIcon.ts), because that is the only strip this
        // renders in — the thread header and the queue card's, immediately left of HeaderActions. It
        // wore its own 24px square until 2026-08-26, one box size smaller than every mark beside it,
        // which drew 15.75px of ink to its neighbour against 20.25 and 21.5 across the rest of the row
        // (measured, `scripts/ink-gaps.mjs` --dsf=4, on a real drawer header). At 28px it lands at
        // 19.75 and the strip reads as one rhythm.
        className={HEADER_ICON_CLASS}
      >
        {copied
          ? <Check size={14} strokeWidth={2.2} className="text-fg" />
          : <TerminalSquare size={14} strokeWidth={1.8} />}
      </button>
    </Tooltip>
  )
}
