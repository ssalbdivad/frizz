// A QUEUE CARD'S RUNNING BACKGROUND SHELLS — what the thread left running while it rests on you.
//
// Since 2026-09-29 a background shell ends on a clock only when the worker declared one (server
// shell-budget.ts). A dev server launched with no `timeout` runs until it exits or somebody stops it, so
// what keeps it from being forgotten is that the human SEES it: on the drawer's strip under the prompt box
// (ChatView BackgroundOpsStrip) and, here, on the card the queue hands them. The board's own queue card
// rendered that strip under its reply box until 2026-09-28; this card had drawn nothing since, so a
// rested thread with a shell still running read as a thread with nothing running.
//
// NOT BackgroundOpsStrip itself, which reads the PAGE's board (useBoard) and stops through the page's
// `rpc` — on the cross-project page both name the FOCUSED project, which is usually not the card's. The
// rows are the same ChildOpRow, at the same density, with the same × policy (childOpDismisser), so the
// two surfaces read as one; what differs is that the thread and the stop both come from the CARD's own
// project. Shells only: live sub-agents keep a thread out of the queue (board.hasLiveBackgroundWork), and
// links belong to the drawer.
//
// Each row: the label, its age (ChildOpRow's own live clock), the remaining budget where one was declared
// ("45m left", "over budget" — lib/shellBudget.ts), and the × that stops it. The row opens the thread in
// place, where the drawer's strip drills into its output.
import { childOpDismisser } from "../lib/dismissChildOp.ts"
import { visibleChildOps } from "../lib/childOps.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { shellBudgetReading } from "../lib/shellBudget.ts"
import type { Api } from "../api/rpc.ts"
import type { ThreadView } from "@frizz/shared"
import { ChildOpRow } from "./ChildOpRow.tsx"

export function QueueShellStrip({ thread, api, onOpen }: {
  thread: Pick<ThreadView, "id" | "bgShells">
  /** The card's OWN project's client — never the page's `rpc` (see the header). */
  api: Api
  /** Open the thread in place, where its drawer lists the same shells with their output. */
  onOpen?: () => void
}) {
  // Ticks the budget countdown; ChildOpRow ticks its own age off the same shared clock.
  const now = useNowMs()
  const shells = visibleChildOps(thread.bgShells ?? [], "sheet")
  if (shells.length === 0) return null
  return (
    // The drawer's geometry, reproduced (ThreadComposerBox): the reply box above ends in `pb-3`, which
    // `-mt-3` hands back so the column hangs `pt-1.5` off the prompt box exactly as the drawer's does, and
    // `.ops-column-optical-inset` puts the last row's baseline 12px off the footer's hairline.
    <div className="-mt-3 shrink-0 px-5 pb-3" data-queue-shells={thread.id}>
      <div className="ops-column-optical-inset">
        <div className="flex flex-col gap-0.5 px-1 pt-1.5">
          {shells.map((s, i) => (
            <ChildOpRow
              key={s.id ?? `s${i}`}
              kind="SHELL"
              label={s.label}
              state={s.state}
              density="sheet"
              startedAt={s.startedAt}
              budget={shellBudgetReading(s.budgetEndsAt, now)}
              onOpen={onOpen}
              title={onOpen ? `${s.label}\nOpen the thread to read its output` : s.label}
              onDismiss={childOpDismisser(thread.id, s, "SHELL", api)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
