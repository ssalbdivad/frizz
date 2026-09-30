// A QUEUE CARD'S LIVE WORK — every sub-agent, Workflow and background shell the thread has running, in one
// column under its reply box, WHATEVER THE WORKER IS DOING.
//
// Until 2026-09-29 a card named its children only inside AwaitingSubAgentsCard, which is drawn in place of
// the worker's ```awaiting fence — at rest, with that fence, and no question open. Anything else drew
// none: a card held on screen while its worker ran the answer to one of its questions, a quiet-turn card,
// a done or a question beside live children, and every card from the moment a human reply retired the
// fence until the worker rested again. The maintainer, replying to a parent with children running: it "no
// longer appears to be running anything". The rail (Sidebar SubAgentRows) and the drawer's strip under
// its prompt box (ChatView BackgroundOpsStrip) read `subAgents` with no such gate; now the card does too.
//
// THE DRAWER'S STRIP, REPRODUCED. The same ChildOpRow at the drawer's own "sheet" density — dot, kind tag
// (AGENT / FLOW / SHELL), label, age, × — agents first in dispatch order with their subtrees indented,
// then shells, so a card reads exactly like the prompt box it opens into. It replaced QueueShellStrip,
// which drew the shell half alone with this same geometry. When the awaiting card IS drawn it lists the
// children with their returned siblings, so `agents` is off and only the shells are left here.
//
// NOT BackgroundOpsStrip itself, which reads the PAGE's board (useBoard) and stops through the page's
// `rpc` — on the cross-project page both name the FOCUSED project, which is usually not the card's. The
// thread, the ×, and the drill-in all come from the CARD's own project here.
//
// Shells: since 2026-09-29 one ends on a clock only when the worker declared one (server shell-budget.ts),
// so a dev server launched with no `timeout` runs until somebody stops it, and what keeps it from being
// forgotten is that the human SEES it. Each shell row carries its remaining budget where one was declared
// ("45m left", "over budget" — lib/shellBudget.ts).
import type { ThreadView } from "@frizz/shared"
import type { Api } from "../api/rpc.ts"
import { projectSlug } from "../lib/base-path.ts"
import { visibleChildOps } from "../lib/childOps.ts"
import { childOpDismisser } from "../lib/dismissChildOp.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { shellBudgetReading } from "../lib/shellBudget.ts"
import { pushSubAgentDrawer, store } from "../store.ts"
import { ChildOpRow } from "./ChildOpRow.tsx"

export function QueueChildOps({ project, thread, api, agents = true, onOpenThread }: {
  project: { slug: string }
  thread: Pick<ThreadView, "id" | "bgShells" | "subAgents">
  /** The card's OWN project's client — never the page's `rpc` (see the header). */
  api: Api
  /** False while the awaiting card above lists the children itself. */
  agents?: boolean
  /** Open the thread in place, where its drawer lists the same work with its output. */
  onOpenThread: () => void
}) {
  // Ticks the budget countdown; ChildOpRow ticks its own age off the same shared clock.
  const now = useNowMs()
  // The card's policy (lib/childOps.ts): running, stale and rested — a quiet child is unresolved work, and
  // a card that hid it read as "done underneath" while the rail still showed it.
  const children = agents ? visibleChildOps(thread.subAgents ?? [], "card") : []
  const shells = visibleChildOps(thread.bgShells ?? [], "sheet")
  if (children.length === 0 && shells.length === 0) return null
  // A CHILD'S TRANSCRIPT OPENS OVER THE PAGE'S PROJECT (AwaitingSubAgentsCard's openChild, for the same
  // reason): addressed by slug, read through the page's client — so on another project's card the row opens
  // the thread's own drawer instead, one click from the same child in its strip.
  const openChild = (child: { id: string; label: string; subagentType?: string; startedAt?: string }) => {
    const focused = projectSlug() === project.slug && store.board?.projectSlug === project.slug
    if (focused) pushSubAgentDrawer(thread.id, child.id, child)
    else onOpenThread()
  }
  return (
    // The drawer's geometry (ThreadComposerBox): the reply box above ends in `pb-3`, which `-mt-3` hands
    // back so the column hangs `pt-1.5` off the prompt box exactly as the drawer's does, and
    // `.ops-column-optical-inset` puts the last row's baseline 12px off the footer's hairline.
    <div className="-mt-3 shrink-0 px-5 pb-3" data-queue-ops={thread.id}>
      <div className="ops-column-optical-inset">
        <div className="flex flex-col gap-0.5 px-1 pt-1.5">
          {children.map((agent, i) => (
            <ChildOpRow
              key={agent.id ?? `a${i}`}
              kind={agent.workflow ? "WORKFLOW" : "AGENT"}
              label={agent.label}
              state={agent.state}
              density="sheet"
              depth={agent.depth}
              startedAt={agent.startedAt}
              parentSlug={thread.id}
              onOpen={agent.id ? () => openChild({ id: agent.id!, label: agent.label, subagentType: agent.subagentType, startedAt: agent.startedAt }) : undefined}
              onDismiss={childOpDismisser(thread.id, agent, "AGENT", api)}
              title={agent.phase ? `${agent.phase} › ${agent.label}` : undefined}
            />
          ))}
          {shells.map((s, i) => (
            <ChildOpRow
              key={s.id ?? `s${i}`}
              kind="SHELL"
              label={s.label}
              state={s.state}
              density="sheet"
              startedAt={s.startedAt}
              budget={shellBudgetReading(s.budgetEndsAt, now)}
              onOpen={onOpenThread}
              title={`${s.label}\nOpen the thread to read its output`}
              onDismiss={childOpDismisser(thread.id, s, "SHELL", api)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
