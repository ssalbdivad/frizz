import { X } from "lucide-react"
import type { ReactElement, ReactNode } from "react"
import { PANE_HEADER_HEIGHT_CLASS } from "../../lib/paneHeaderHeight.ts"

// The one side-sheet header bar. A fixed-height row (the pane-header height, px-4) with an optional leading icon, the
// title (carrying optional inline `meta` — e.g. a background shell's "running 3 min" — and/or a stacked
// `subtitle` line — e.g. a doc drawer's "<slug>.md"), optional trailing `actions` (settings' "● unsaved"),
// and the lucide close button. Replaces six near-identical hand-rolled headers that had drifted in
// height (h-11 vs h-12), padding (px-3 / px-4 / px-5), title weight, and close-button padding.
//
// `initialFocus` stamps data-dialog-initial-focus on the close button for Radix/focus managers that
// query it (ThreadSheet's onOpenAutoFocus / registerDrawerFocus); omitted, the attribute is absent.
export function SheetHeader({
  title,
  subtitle,
  icon,
  meta,
  actions,
  onClose,
  initialFocus,
  titleMono,
}: {
  title: string
  /** A string, or a node for a subtitle that must truncate somewhere other than its end (a path whose
   *  last folder is the part worth keeping — TerminalSheet's). Rendered inside the one truncating line. */
  subtitle?: ReactNode
  icon?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  onClose: () => void
  initialFocus?: boolean
  /** The title is a COMMAND LINE (a terminal's), set in mono as every surface sets a command: a step
   *  smaller than the sans title (the strip's own 11-in-11.5 ratio), so mono's wider face reads at its size,
   *  and at the regular weight the strip and the rail set a command in — mono at the sans title's
   *  `font-medium` reads visibly bolder (the rail's finding, AwaitingBackgroundCard WaitRow `mono`). */
  titleMono?: boolean
}): ReactElement {
  // THE TEXT BLOCK IS ONE WRAPPING LINE OF THREE PIECES — title, meta, subtitle — so a narrow drawer can move
  // the meta down beside the subtitle rather than squeeze the title to nothing. Wide: title and meta share
  // the first line (the subtitle, `basis-full`, is always the second). The title grows from zero up to its own
  // width (`basis-0 grow max-w-max`), so it never pushes the meta off the line; it truncates first, and the
  // meta keeps up to 70%. Under 28rem (a size container around the header — TerminalSheet's; without one
  // nothing here changes): the title takes the first line alone, and the meta leads the second. At 390px the
  // one-line header drew `read…` beside `waiting for input…` and `Test …` beside `running · 34m left · 2…`
  // (2026-09-30): neither what the drawer is nor a whole reading.
  //
  // BASELINES, not centres: the meta is a smaller run beside the title, and centring two sizes on one flex
  // line put the agent drawer's reading 1.06px under the title's baseline (sans 13px title) and your
  // terminal's 0.30px over it (mono 12.5px) — one header anatomy seating its reading two ways. `items-baseline`
  // puts every run on the title's baseline in any font, with nothing measured.
  return (
    <header className={`flex ${PANE_HEADER_HEIGHT_CLASS} shrink-0 items-center gap-2.5 border-b border-border bg-panel px-4`}>
      {icon}
      <div className="flex min-w-0 flex-1 flex-wrap content-center items-baseline gap-x-2">
        <span
          className={`min-w-0 max-w-max grow basis-0 truncate @max-[28rem]:max-w-full @max-[28rem]:basis-full ${titleMono ? "font-mono-keep text-[12.5px] font-normal" : "text-[13px] font-medium"}`}
          title={title}
        >
          {title}
        </span>
        {meta && <span data-sheet-meta className="flex min-w-0 max-w-[70%] shrink-0 @max-[28rem]:order-2">{meta}</span>}
        {subtitle && (
          <span className="min-w-0 basis-full truncate text-[10px] text-muted-60 @max-[28rem]:order-3 @max-[28rem]:grow @max-[28rem]:basis-0">
            {subtitle}
          </span>
        )}
      </div>
      {actions}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        {...(initialFocus ? { "data-dialog-initial-focus": "" } : {})}
        className="icon-hover-outline rounded-md p-1.5 text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg"
      >
        <X size={15} />
      </button>
    </header>
  )
}
