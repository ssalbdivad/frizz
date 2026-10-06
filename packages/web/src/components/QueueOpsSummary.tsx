import { useEffect, useRef, useState, type ReactNode } from "react"
import { ExternalLink, FileText } from "lucide-react"
import { CHILD_RESTED_DOT_CLASS, CHILD_STALE_DOT_CLASS } from "../lib/childOps.ts"
import { isRunningOperation } from "../lib/operationIndicators.ts"
import type { QueueOpsCount, QueueOpsKind } from "../lib/queueOpsCounts.ts"
import { Popover, PopoverAnchor, PopoverContent } from "./ui/Popover.tsx"

// THE QUEUE CARD'S LIVE OPS, CONDENSED: one line of counts at the right, just above the docked prompt
// box — "● 2 agents  ● 1 shell  ● 1 PR  ▤ 2 files" — with the ⤷ rows themselves one hover away.
//
// Until 2026-10-05 every live op was its own ⤷ row hanging under the card's prompt box, then the
// lifecycle footer under those: on a busy thread the bottom of a card was a column of rows taller than
// the reply it carried, all of it scrolling away with the card. The prompt box now docks to the bottom
// of the screen while the card is on it, and a dock cannot carry a column of rows, so the rows fold into
// counts (maintainer: "the area where we list out all of the sub agents and the files and all of that
// should probably just show up as like a condensed view, like to the upper right of the prompt box,
// where it just lists out the number of subagents, the number of files, et cetera … Then you can hover
// over to see the details").
//
// THE ROWS IN THE PANEL ARE THE REAL ONES — the components that drew them under the box — so a row still
// opens its drawer, stops its child, and reads its CI the way it did. The CALLER composes them and hands
// in the counts (lib/queueOpsCounts.ts, taken from the same lists by the same filters, so the line and the
// panel cannot disagree). Upstream's card read its rows off the page's board (QueueSubAgentLines,
// BackgroundOpsStrip); the fork's cross-project card cannot — on that page the board is the FOCUSED
// project's, usually not the card's — so AllQueuesCard passes rows drawn from its own project.
//
// THE MARK IS THE ROWS' OWN LIVENESS DOT, in the row's hue (yellow agent, blue shell, violet watch), and
// it pulses only while at least one row of that kind is running. Otherwise it is the rows' own settled
// mark (lib/childOps.ts): the hollow ring when one of them rested, the flat dot when they went stale.
export function QueueOpsSummary({ counts: groups, children }: { counts: readonly QueueOpsCount[]; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(closeTimer.current), [])
  const panelRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  // The last op can end, or be stopped from its × in the panel, while the panel is open — and nothing
  // then says close: its anchor unmounts with the line, so no pointer leaves it and Radix sends no
  // change. Left `true`, the panel sprang open by itself, over the transcript, the next time the agent
  // started anything. With nothing to count it is closed.
  const empty = groups.length === 0
  useEffect(() => {
    if (!empty) return
    clearTimeout(closeTimer.current)
    setOpen(false)
  }, [empty])
  if (empty) return null
  const words = groups.map((group) => `${group.n} ${group.n === 1 ? group.one : group.many}`)
  const openNow = () => {
    clearTimeout(closeTimer.current)
    setOpen(true)
  }
  // The panel opens on hover and holds buttons, so the pointer must be able to cross the gap between the
  // line and the panel without it closing — the same grace ContextMeter's panel gives.
  const closeSoon = () => {
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setOpen(false), 150)
  }
  // THE KEYBOARD'S WAY IN. Focus opens the panel the way hover does, but it is portaled to the end of the
  // page, so Tab from the line goes to the prompt box and the panel closes — its rows (open a drawer,
  // stop a child) were Tab stops when they hung under the box. Enter, Space or ↓ on the line moves focus
  // to the panel's first control; Escape there brings it back to the line.
  const focusPanel = () => {
    openNow()
    requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>("button, a[href], [tabindex]:not([tabindex='-1'])")?.focus())
  }
  return (
    // `-mt-2`: the dock's top inset is 12px, the same as its bottom; with this line in it the line takes
    // the top of that inset, so the prompt box sits 28px + 4px under the dock's rule rather than 40px.
    <div data-queue-ops-summary className="-mt-2 flex h-7 min-w-0 items-center justify-end">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <button
            type="button"
            aria-label={`${words.join(", ")} — show them`}
            aria-haspopup="dialog"
            aria-expanded={open}
            onMouseEnter={openNow}
            onMouseLeave={closeSoon}
            onFocus={openNow}
            ref={buttonRef}
            onClick={(event) => {
              // The line sits inside a queue card; the click is this control's, not the card's. A click
              // OPENS, never toggles: with a mouse the hover already opened the panel. A keyboard click
              // (Enter or Space, `detail` 0) carries focus into it.
              event.stopPropagation()
              if (event.detail === 0) focusPanel()
              else openNow()
            }}
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown") return
              event.preventDefault()
              focusPanel()
            }}
            onMouseDown={(event) => event.preventDefault()}
            className={`flex min-w-0 items-center gap-3 rounded-md px-1.5 py-0.5 text-[11.5px] outline-none transition-colors focus-visible:ring-1 focus-visible:ring-focus-ink-60 ${open ? "bg-panel-2 text-fg/85" : "text-muted-70 hover:bg-panel-2 hover:text-fg/85"}`}
          >
            {groups.map((group) => (
              <span key={group.key} data-ops-count={group.key} className="flex items-baseline gap-1.5 whitespace-nowrap">
                {/* ON THE CAP BAND, computed by the browser (the ThreadLinks icon idiom): a 1em slot whose
                    bottom sits on the baseline, lifted so its centre lands at half the cap height — the
                    count beside it is digits, which are cap-height ink. The mark is ABSOLUTELY centred in
                    the slot, never a flex child of it: a flex slot takes its baseline from its first
                    child, so a 6px dot's bottom edge (not the slot's) landed on the baseline and the dot
                    rode ~2px low. An empty block synthesizes its baseline from its own bottom edge. */}
                <span aria-hidden className="relative block h-[1em] w-[1em] shrink-0 self-baseline translate-y-[calc(0.5em_-_0.5cap)]">
                  <span className="absolute inset-0 flex items-center justify-center"><CountMark kind={group.key} states={group.states} /></span>
                </span>
                <span><span className="tabular-nums text-fg/85">{group.n}</span> {group.n === 1 ? group.one : group.many}</span>
              </span>
            ))}
          </button>
        </PopoverAnchor>
        <PopoverContent
          side="top"
          align="end"
          sideOffset={4}
          data-queue-ops-panel
          aria-label="Running for this thread"
          onMouseEnter={openNow}
          onMouseLeave={closeSoon}
          // Hover opened it, so focus stays where the operator left it — the caret in the prompt box.
          onOpenAutoFocus={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            // Replaces the wrapper's handler, so it keeps that handler's one job: this Escape is the
            // panel's, not the window's (App, or /full's exit).
            event.stopPropagation()
            if (panelRef.current?.contains(document.activeElement)) buttonRef.current?.focus()
          }}
          ref={panelRef}
          onClick={(event) => event.stopPropagation()}
          className="flex w-[440px] max-w-[calc(100vw-1.5rem)] flex-col px-3 py-2"
        >
          {children}
        </PopoverContent>
      </Popover>
    </div>
  )
}

function CountMark({ kind, states }: { kind: QueueOpsKind; states: readonly (string | undefined)[] }) {
  switch (kind) {
    case "agent":
    case "workflow": return <Dot hue="agent" states={states} />
    case "terminal": return <Dot hue="shell" states={states} />
    case "pr":
    case "issue": return <Dot hue="github" states={states} />
    case "file": return <FileText aria-hidden className="h-[1em] w-[1em] text-muted-45" />
    case "link": return <ExternalLink aria-hidden className="h-[1em] w-[1em] text-muted-45" />
  }
}

function Dot({ hue, states }: { hue: "agent" | "shell" | "github"; states: readonly (string | undefined)[] }) {
  if (states.some(isRunningOperation)) return <span className={`frizz-live-dot frizz-live-dot--${hue}`} />
  return <span className={states.includes("rested") ? CHILD_RESTED_DOT_CLASS : CHILD_STALE_DOT_CLASS} />
}
