import type { CSSProperties, ReactNode } from "react"
import { Check, ChevronDown, Layers, ListFilter, X } from "lucide-react"
import type { ProjectCard } from "@frizz/shared"
import { ProjectSquare } from "./ProjectRail.tsx"
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "./ui/Menu.tsx"

// THE QUEUE FILTER — the READY header's right end: which projects' cards the queue shows, as a control
// (maintainer 2026-09-28: the filtering was unclear — "there should be some kind of filtering symbol …
// where you can click a project name or you can click everything", with "some clear filter indicator";
// then, the same day: "have project filters only affect which threads are displayed on the right side and
// have the ui reflect that").
//
//   every project:     ⧩ All projects ▾             — quiet: the menu, All projects, then every project
//   one project:      (⧩ ▣ name ✕)                  — a HELD pill; ✕ lifts the filter
//
// It sits over the cards it filters, and filters nothing else: the list on the left keeps every project,
// and marks the filtered one with the same glyph (ProjectList.tsx). It stood at the status row's right end
// until then, above the prompt box, where it read as scoping the whole page — and choosing a project there
// opened that project's own view, which is gone.
//
// It must not read like the prompt box's project picker (AllQueues.tsx ProjectPicker): that one says
// where a new thread GOES; this one says what you are LOOKING AT. Hence the filter glyph leading this one,
// and that one living INSIDE the box's bottom strip beside the model, drawn as a setting of the next
// thread.
//
// Ink gaps (sans, scripts/ink-gaps.mjs, measured in the status row at this same 12px): glyph→name 8.00px
// on the flex gap alone against 5.18px name→chevron, so the glyph gives back 1px of its dead box
// (→7.00px); in the pill glyph→square 6.75px and square→name 7.00px already read as one run, and the ✕
// sits 10.37px off the name because it is a separate control.

export interface FilterProject {
  id: string
  slug: string
  name: string
  card: ProjectCard
  /** Ready threads — the accent badge, as on the rail. */
  ready: number
}

/** The accent count the rail and the project list wear. */
export function QueueBadge({ count }: { count: number }) {
  return (
    <span
      aria-label={`${count} in the queue`}
      data-xq-queue-count={count}
      className="flex h-[16px] min-w-[16px] shrink-0 items-center justify-center rounded-full bg-accent-fill px-[4px] text-[10px] font-semibold leading-none proportional-nums text-on-accent"
    >
      {/* The cap band, not the line box — the rail badge's own fix (ProjectRail.tsx). */}
      <span style={{ textBox: "trim-both cap alphabetic" } as CSSProperties}>{count}</span>
    </span>
  )
}

export function ProjectFilter({
  projects,
  current,
  label,
  onEverything,
  onProject,
  onClear,
  footer,
  onOpenChange,
}: {
  projects: FilterProject[]
  /** The one project shown, or undefined for Everything. */
  current: FilterProject | undefined
  /** What the pill says for `current` — its name by default. */
  label?: ReactNode
  onEverything: () => void
  onProject: (project: FilterProject) => void
  onClear: () => void
  /** Extra menu items under the list. */
  footer?: ReactNode
  onOpenChange?: (open: boolean) => void
}) {
  const total = projects.reduce((sum, project) => sum + project.ready, 0)
  const trigger = (
    <MenuTrigger asChild>
      <button
        type="button"
        data-xq-view-filter={current ? "narrowed" : "everything"}
        title={current ? `Showing only ${current.name}. Choose what to show` : "Showing every project. Choose what to show"}
        aria-label={`Showing ${current ? `only ${current.name}` : "every project"}. Choose what to show`}
        // Quiet while it filters nothing — muted, like the READY label beside it — and full weight only as
        // the held pill, when one project's cards are all there is to see.
        className={`flex min-w-0 items-baseline gap-1.5 py-0.5 outline-none transition-colors hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60 data-[state=open]:text-fg ${
          current ? "rounded-full pl-2 pr-1 font-semibold text-fg/90" : "-mr-1.5 rounded-md px-1.5 font-medium text-muted-80 hover:bg-hover data-[state=open]:bg-hover"
        }`}
      >
        <ListFilter size={12} aria-hidden data-xq-view-filter-glyph className={`${current ? "" : "-mr-px "}shrink-0 self-baseline translate-y-[calc(0.5em_-_0.5cap)] text-muted`} />
        {current && (
          <span className="flex shrink-0 self-baseline translate-y-[calc(7px_-_0.5cap)]">
            <ProjectSquare project={current.card} size={14} />
          </span>
        )}
        <span data-xq-view-filter-label className="min-w-0 truncate">{current ? (label ?? current.name) : "All projects"}</span>
        {!current && <ChevronDown size={12} aria-hidden data-xq-view-filter-chevron className="-ml-[3.5px] shrink-0 self-baseline translate-y-[calc(0.5em_-_0.5cap)] text-muted" />}
      </button>
    </MenuTrigger>
  )
  return (
    <Menu onOpenChange={onOpenChange}>
      {current ? (
        // HELD, like a chip on a filtered list: drawn for as long as the filter is on, so one project
        // never passes for the whole machine, and its ✕ lifts it.
        <span data-xq-view-filter-pill className="flex min-w-0 items-center rounded-full border border-border bg-elevated">
          {trigger}
          <button
            type="button"
            data-xq-view-filter-clear
            title="Show everything"
            aria-label="Clear the filter and show everything"
            className="mr-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60"
            onClick={onClear}
          >
            <X size={12} aria-hidden />
          </button>
        </span>
      ) : (
        trigger
      )}
      <MenuContent align="end">
        <div className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-medium text-muted-55">Show</div>
        <MenuItem onSelect={onEverything} icon={<Layers size={14} aria-hidden />} value="everything">
          <span className={`min-w-0 flex-1 truncate ${current ? "" : "text-fg"}`}>All projects</span>
          {total > 0 && <QueueBadge count={total} />}
          <span className="flex w-3 shrink-0 justify-center">{!current && <Check size={12} aria-label="Current" className="text-fg" />}</span>
        </MenuItem>
        <MenuSeparator />
        <div className="max-h-[min(50vh,360px)] overflow-y-auto">
          {projects.map((project) => {
            const selected = current?.id === project.id
            return (
              <MenuItem key={project.id} value={project.slug} onSelect={() => onProject(project)} icon={<ProjectSquare project={project.card} size={14} />}>
                <span className={`min-w-0 flex-1 truncate ${selected ? "text-fg" : ""}`}>{project.name}</span>
                {project.ready > 0 && <QueueBadge count={project.ready} />}
                <span className="flex w-3 shrink-0 justify-center">{selected && <Check size={12} aria-label="Current" className="text-fg" />}</span>
              </MenuItem>
            )
          })}
        </div>
        {footer && (
          <>
            <MenuSeparator />
            {footer}
          </>
        )}
      </MenuContent>
    </Menu>
  )
}
