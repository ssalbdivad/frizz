import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import { rpc } from "../api/rpc.ts"
import { showToast } from "../store.ts"
import { Dialog } from "./ui/Dialog.tsx"
import { Select } from "./ui/Select.tsx"

// The periods both thread-deletion controls offer, in days — the house duration grammar spells them.
export const RETENTION_DAYS = [1, 7, 30, 90] as const

/**
 * Settings → Delete untouched threads now: the automatic period's one-off twin (server thread-retention.ts
 * picks the same set). The button COUNTS first — a dry run — and the dialog names the number, so nobody
 * deletes "some threads" blind; nothing to delete says so instead of opening a dialog.
 */
export function DeleteOldThreads() {
  const [days, setDays] = useState<number>(30)
  const [pending, setPending] = useState<number | null>(null)
  const queryClient = useQueryClient()
  const count = useMutation({
    mutationFn: () => rpc.deleteDoneThreads({ untouchedDays: days, dryRun: true }),
    onSuccess: ({ count }) => {
      if (count === 0) showToast(`No done threads untouched for ${days}d`)
      else setPending(count)
    },
  })
  const remove = useMutation({
    mutationFn: () => rpc.deleteDoneThreads({ untouchedDays: days }),
    onSuccess: ({ count }) => {
      setPending(null)
      showToast(`Deleted ${count} done ${count === 1 ? "thread" : "threads"}`)
      // The cross-project page's Done counts read these; each board's own push covers its rail.
      void queryClient.invalidateQueries({ queryKey: ["projectsQueues"] })
    },
  })
  const error = remove.error instanceof Error ? remove.error.message : remove.error ? String(remove.error) : null
  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <Select
          variant="bordered"
          value={String(days)}
          onValueChange={(v) => setDays(Number(v))}
          options={RETENTION_DAYS.map((d) => ({ value: String(d), label: `Untouched for ${d}d` }))}
          indicatorPosition="right"
          ariaLabel="Delete done threads untouched for"
        />
      </div>
      <button
        type="button"
        onClick={() => count.mutate()}
        disabled={count.isPending}
        className="button-outline flex shrink-0 items-center gap-1.5 rounded-md border border-border px-3 py-1 text-[12px] text-danger outline-none transition-colors hover:bg-danger-fill/10 disabled:opacity-60"
      >
        {count.isPending && <Loader2 size={12} className="animate-spin" />}
        Delete…
      </button>
      {pending !== null && (
        <Dialog
          open
          onOpenChange={(open) => { if (!open && !remove.isPending) setPending(null) }}
          title={`Delete ${pending} done ${pending === 1 ? "thread" : "threads"}?`}
          className="w-[420px] max-w-[92vw]"
          footer={
            <>
              <button
                type="button"
                onClick={() => setPending(null)}
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
                Delete
              </button>
            </>
          }
        >
          <div className="flex flex-col gap-3 p-4 text-[12.5px] leading-relaxed text-muted">
            <p>
              Every done thread you have not opened or acted on in the last {days}d, in every open project, is removed from Frizz with
              its notes. Pinned threads are kept. This cannot be undone.
            </p>
            {error ? <p className="text-[11.5px] text-danger">{error}</p> : null}
          </div>
        </Dialog>
      )}
    </div>
  )
}
