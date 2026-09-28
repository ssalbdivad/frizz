import { useCallback, useEffect, useRef, useState } from "react"
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { MACHINE_SETTING_KEYS, type Settings } from "@frizz/shared"
import { isRetryableRpcError, rpc } from "../api/rpc.ts"

// Every settings control WRITES AS YOU TOUCH IT — there is no Save button and no Cancel. A picker or a
// toggle persists on the click; a textarea persists this long after the last keystroke, so a long
// prompt is one write instead of one per character.
const SAVE_DEBOUNCE_MS = 500
// How long "Saved" lingers before the status goes quiet again.
const SAVED_LINGER_MS = 1600
// A REPLAYABLE failure — a mutation refused because Frizz is mid-update — is worth waiting out rather
// than reporting. A promotion takes a few seconds; six tries covers it without becoming a poller.
const RETRY_DELAY_MS = 2000
const MAX_RETRIES = 6

export type SaveState = "idle" | "saving" | "saved" | "error"

// The mutation key every settings write carries. A surface that dispatches a worker off the settings
// (the new-thread composer, the GitHub picker) gates on `useIsMutating({ mutationKey: SETTINGS_WRITE_KEY })`
// so a save still in flight — a compaction window picked a moment ago, a prompt edit flushed by closing
// its popover — lands before the dispatch that would read it.
export const SETTINGS_WRITE_KEY = ["settingsSet"] as const

/**
 * A save's MACHINE settings, published to every project's cached `settingsGet` — not only the entry of
 * the project the save was made under.
 *
 * The cache keeps one `settingsGet` entry per project (lib/queryKeyScope.ts folds the page's project
 * into every hash but the machine-wide keys'), and that is right for the query as a whole: most of
 * `Settings` is a project's own, so it cannot join MACHINE_WIDE. But `projectRail`, `notifications`,
 * `localFileOpener` and `homeFolder` are one value for the machine (MACHINE_SETTING_KEYS), and a reader
 * that is still bound to another project's entry has to see the new one too. That reader exists: the
 * project rail's hook lives in the layout, which a project switch on the one page does not re-render,
 * so it stays on the entry it was cold-loaded under (lib/projectRail.ts). Switch the page to another
 * project with the prompt box's picker, flip Project sidebar to On, and the save landed in the new
 * project's entry while the rail read the old one — it did not appear until a reload (2026-09-28, the
 * 2026-08-24 bug again: the old cure re-rendered the hook on every NAVIGATION, and on the one page a
 * project switch is not one). lib/projectRail.e2e.test.ts drives exactly that switch.
 *
 * Only the machine keys are written across, and nothing is refetched: a refetch runs under the CURRENT
 * page's project, so it would pour this project's own settings into every other project's entry.
 */
export function publishMachineSettings(queryClient: QueryClient, saved: Settings): void {
  const machine = Object.fromEntries(MACHINE_SETTING_KEYS.map((key) => [key, saved[key]])) as Partial<Settings>
  // On each Query itself, not through `setQueriesData`: that re-derives every match's HASH from its key,
  // and the hash is the CURRENT page's scope — so it wrote the one entry already written, N times.
  for (const query of queryClient.getQueryCache().findAll({ queryKey: ["settingsGet"] })) {
    const cached = query.state.data as Settings | undefined
    if (cached) query.setData({ ...cached, ...machine }, { manual: true })
  }
}

// The write side of every settings surface — the drawer and the in-context popovers alike. Three
// invariants, all silent when broken:
//
//  - WRITES ARE SERIALIZED. Every payload is a WHOLE Settings object, so two overlapping requests that
//    land out of order leave the server holding the older snapshot. Chaining each write onto the
//    previous one's settled promise makes the last thing touched the last thing stored.
//  - A PENDING DEBOUNCE IS FLUSHED ON UNMOUNT. Otherwise the last half-second of typing dies with the
//    surface — precisely the keystrokes the Save button used to capture.
//  - A RETRYABLE FAILURE IS RETRIED. Removing the Save button also removed the operator's way to try
//    again, so the one failure the RPC layer certifies as side-effect-free — `isRetryableRpcError`,
//    which the composer already leans on during a control-plane restart — has to be replayed here.
//    Anything else is AMBIGUOUS (it may have landed) and must be reported, never re-sent.
export function useSettingsAutosave() {
  const [state, setState] = useState<SaveState>("idle")
  const pending = useRef<Settings | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const chain = useRef<Promise<unknown>>(Promise.resolve())
  const inflight = useRef(0)
  const linger = useRef<number | undefined>(undefined)
  const retries = useRef(0)
  // `flush` schedules its own retry, so it needs a handle to itself that doesn't make the callback
  // depend on its own identity. Assigned immediately below.
  const flushRef = useRef<() => void>(() => {})
  // A react-query mutation rather than a bare RPC so the write is visible to `useIsMutating` — and it
  // stays in the mutation cache after this surface unmounts, so a flush-on-close is still counted.
  const write = useMutation({ mutationKey: [...SETTINGS_WRITE_KEY], mutationFn: (next: Settings) => rpc.settingsSet(next) })
  const writeRef = useRef(write)
  writeRef.current = write
  const queryClient = useQueryClient()

  const flush = useCallback(() => {
    if (timer.current !== undefined) window.clearTimeout(timer.current)
    timer.current = undefined
    const next = pending.current
    if (!next) return
    pending.current = null
    inflight.current += 1
    setState("saving")
    chain.current = chain.current
      .then(() => writeRef.current.mutateAsync(next))
      .then((saved) => {
        // Publish the server's validated copy rather than racing queued writes with a refetch.
        queryClient.setQueryData(["settingsGet"], saved)
        publishMachineSettings(queryClient, saved)
        inflight.current -= 1
        retries.current = 0
        if (inflight.current > 0 || pending.current) return
        setState("saved")
        if (linger.current !== undefined) window.clearTimeout(linger.current)
        linger.current = window.setTimeout(() => setState("idle"), SAVED_LINGER_MS)
      })
      .catch((error: unknown) => {
        inflight.current -= 1
        setState("error")
        // A newer value is already queued behind this one — it supersedes this payload entirely, so
        // replaying the stale one would undo the newer edit.
        if (pending.current || !isRetryableRpcError(error) || retries.current >= MAX_RETRIES) return
        retries.current += 1
        pending.current = next
        timer.current = window.setTimeout(flushRef.current, RETRY_DELAY_MS)
      })
  }, [])
  flushRef.current = flush

  const queue = useCallback(
    (next: Settings, debounce = false) => {
      pending.current = next
      retries.current = 0
      if (timer.current !== undefined) window.clearTimeout(timer.current)
      timer.current = undefined
      if (!debounce) return flush()
      timer.current = window.setTimeout(flush, SAVE_DEBOUNCE_MS)
    },
    [flush],
  )

  useEffect(
    () => () => {
      flush()
      if (linger.current !== undefined) window.clearTimeout(linger.current)
    },
    [flush],
  )

  return { state, queue, flush }
}

// A settings surface's whole read/write loop: the server's copy seeds a local draft ONCE, and every
// change renders first and persists second through the autosave above. The draft is never re-seeded
// afterwards: every save publishes the stored value straight into the query cache, so a later fetch
// can only agree with what is here. `debounce` is for the free-text fields alone — a picker or a
// toggle is a single discrete intent and writes on the spot.
export function useSettingsDraft() {
  const settings = useQuery({ queryKey: ["settingsGet"], queryFn: () => rpc.settingsGet() })
  const [draft, setDraft] = useState<Settings | null>(() => settings.data ?? null)
  const { state, queue, flush } = useSettingsAutosave()

  useEffect(() => {
    if (settings.data && !draft) setDraft(settings.data)
  }, [settings.data, draft])

  const update = useCallback(
    (next: Settings, opts?: { debounce?: boolean }) => {
      setDraft(next)
      queue(next, opts?.debounce)
    },
    [queue],
  )

  return { draft, update, saveState: state, flush }
}

// The whole account of persistence, now that no button carries it. Quiet by design: the form writes
// itself, so the only states worth a word are the write in flight, the moment it lands, and the one
// that matters — a write that did NOT land, in the accent that means "this wants you".
export function SaveStatus({ state }: { state: SaveState }) {
  if (state === "idle") return null
  if (state === "error") return <span className="text-[11px] font-normal text-accent">Couldn't save</span>
  return (
    <span className={`text-[11px] font-normal ${state === "saved" ? "text-muted-70" : "text-muted"}`}>
      {state === "saving" ? "Saving…" : "Saved"}
    </span>
  )
}
