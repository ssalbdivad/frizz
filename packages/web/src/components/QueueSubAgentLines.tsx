import type { SubAgentView } from "@frizz/shared"
import { pushSubAgentDrawer } from "../store.ts"
import { visibleChildOps } from "../lib/childOps.ts"
import { childOpDismisser } from "../lib/dismissChildOp.ts"
import { ChildOpRow } from "./ChildOpRow.tsx"

// A queue handoff should name the work still running beneath the parent without turning it into a
// second operations toolbar. Live AND stale children render here (visibleChildOps "card", unified onto
// the rail's policy — a stale child is unresolved work, not gone, and a card that hid it read as "done
// underneath" while the rail still showed it); background shells/Monitors remain in BackgroundOpsStrip
// below as a separate runtime concern. The row itself is the shared ChildOpRow at "card" density — the
// same component, tokens and glyph the sidebar rail and the drawer's ops strip render. The dispatch's
// model+effort tag was REMOVED from these lines on 2026-07-27 (maintainer): the profile belongs to the
// prompt box's own control one line up, not repeated on every child line. It still rides the drill-in
// so the drawer knows which cell it opened.
//
// It DOES carry the dismiss × (maintainer 2026-07-30 — "the X button to stop a sub-agent should show up
// everywhere sub-agents are listed"). That is not the "second operations toolbar" this comment has
// always warned against: the card names the live work, and retiring a child that finished without
// signalling is the one action that reading provokes. Everything else — the kind tag, the counters, the
// profile — still stays off the card.
// Whether this card will actually draw any ⤷ child lines. The card renders these lines and the
// background-ops strip as two SIBLING lists in one visual column, so the strip has to know whether it
// is opening that column or continuing it (the project board's card, TodosView, asked this until
// 2026-09-28; subagent-completion-fixture and operation-indicators-fixture still do) — and it must get
// the same answer this component does. Exported from here, and used by the component itself, so the two cannot drift.
export function hasQueueSubAgentLines(subAgents: readonly SubAgentView[]): boolean {
  return visibleChildOps(subAgents, "card").length > 0
}

export function QueueSubAgentLines({
  slug,
  subAgents,
  // The ops COLUMN's padding, which is positional and therefore the caller's to set — the same prop
  // BackgroundOpsStrip takes, for the same reason. These lines and that strip stack into one column,
  // so only the list that ends the column may carry its bottom air (8px before the lifecycle footer);
  // a list with the strip beneath it must not, or the two paddings sum into a gap between them.
  // Default = the column's opening padding with no bottom air, i.e. what a lone fixture wants.
  className = "px-1 pt-1.5",
}: {
  slug: string
  subAgents: readonly SubAgentView[]
  className?: string
}) {
  const visible = visibleChildOps(subAgents, "card")
  if (visible.length === 0) return null
  return (
    <div data-queue-subagents className={`flex min-w-0 flex-col gap-0.5 ${className}`}>
      {visible.map((agent, index) => (
        <ChildOpRow
          key={agent.id ?? `${agent.startedAt}-${index}`}
          kind="AGENT"
          label={agent.label}
          state={agent.state}
          density="card"
          depth={agent.depth}
          startedAt={agent.startedAt}
          // What the child is DOING right now. The counters stay off a handoff card (see ChildOpRow).
          parentSlug={slug}
          onOpen={agent.id ? () => pushSubAgentDrawer(slug, agent.id!, { label: agent.label, subagentType: agent.subagentType, startedAt: agent.startedAt }) : undefined}
          onDismiss={childOpDismisser(slug, agent)}
        />
      ))}
    </div>
  )
}
