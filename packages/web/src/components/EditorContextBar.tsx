import { useLayoutEffect, useMemo, useRef, useState } from "react"
import { ChevronDown, FileCode2 } from "lucide-react"
import { embedded } from "../lib/embed.ts"
import { contextBarReading, editorAddChord, requestEditorContext, useEditorContext, type ContextBox, type EditorContextState } from "../lib/editorContext.ts"
import { detectPlatform } from "../lib/keybindings.ts"
import { basename, dirnameLike } from "../lib/paths.ts"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "./ui/Menu.tsx"

// THE CONTEXT BAR — the top strip inside a prompt box in an editor's sidebar (plans/vscode-extension.md
// § The editor in the sidebar). It shows what the editor around the sidebar has in front, live from
// `frizz:editor-context` (lib/editorContext.ts): the file, and when code is selected, its range and size.
// A click adds that as a chip in THIS box; the other open files are behind the control's chevron. It
// shows paths and line numbers only, and adds nothing on its own: a chip in the box is the only way
// context rides a message, exactly as in the browser.
//
// The prior art the maintainer pointed at, in this app's own vocabulary: Claude Code's VS Code extension
// names the selection under its prompt ("26 lines selected"), Copilot Chat offers the current file as a
// chip the human clicks to attach, and Cursor's composer lists its context as pills along the top of the
// box. Here the pill the bar offers IS the chip it will make — the same `r2-private.ts:91-116` label
// (contextChipLabel) — so what the human clicks is what lands.
//
// Two tones, because "is code highlighted right now" is the question the bar exists to answer at a
// glance (the maintainer asked for "some visual indicator" of it): a selection wears the accent, like
// the box's own focus ring; a file with nothing selected is a quiet outline — a suggestion.
//
// The control is a SPLIT button, the app's own (SnoozeButton): the reading adds what it names, the
// chevron offers the rest. A separate "3 open files" label beside it was tried first and, in a 300px
// sidebar, took the room the file's own name needed — `r2-private.ts:91-116` truncated to `r:91-116`.
//
// Embed mode only: in a browser tab nothing writes the editor's context, and the bar renders nothing.
export function EditorContextBar({ box }: { box: ContextBox }) {
  return embedded() ? <Bar box={box} /> : null
}

function Bar({ box }: { box: ContextBox }) {
  const { active, open } = useEditorContext()
  const reading = contextBarReading(active)
  const chord = useMemo(() => editorAddChord(detectPlatform()), [])
  if (!reading && open.length === 0) return null
  const selection = reading?.kind === "selection"
  const add = () => {
    if (active) requestEditorContext(box, selection ? { what: "selection" } : { what: "file", path: active.path })
  }
  // `inset-ring`, never `ring-inset`: that one is also a COLOUR utility here (theme.css --color-inset)
  // and paints every edge in it (Composer's CONTEXT_PILL has the measurement).
  const tone = selection
    ? "bg-accent/12 text-accent inset-ring-accent/35"
    : "text-muted inset-ring-border"
  const hover = selection ? "hover:bg-accent/12" : "hover:bg-panel-2 hover:text-fg"
  return (
    <div data-editor-context-bar className="flex items-center gap-2 px-1.5 pt-1.5">
      <div data-editor-context-control className={`flex h-6 min-w-0 items-stretch rounded-md text-[11.5px] leading-6 inset-ring transition-colors ${tone} ${reading ? "max-w-full" : ""}`}>
        {reading && (
          <button
            type="button"
            data-editor-context={reading.kind}
            // Keep the caret where it is: the add comes back to this box and puts it after the chip.
            onMouseDown={(e) => e.preventDefault()}
            onClick={add}
            // The readings are separate spans spaced by the row's gap, so the text alone would read
            // "r2-private.ts:91-11626 lines" to a screen reader.
            aria-label={`Add ${reading.name}${reading.range}${reading.count ? `, ${reading.count},` : ""} to the prompt`}
            title={selection
              ? `Add ${reading.where}${reading.range} to the prompt — or press ${chord} in the editor`
              : `Add ${reading.where} to the prompt — or select code and press ${chord} in the editor`}
            // 7px, not 6, on the right when the chevron follows: its glyph carries 0.88px of side
            // bearing, and the rule between them should sit centred in ink (6.88 | 6.88, sans).
            className={`flex min-w-0 items-baseline gap-1 pl-1.5 transition-colors ${open.length ? "rounded-l-md pr-[7px]" : "rounded-md pr-1.5"} ${hover}`}
          >
            {/* One glyph in both states: it is the same file either way, and the pill lighting up IS the
                news that lines are selected. (Lucide's TextSelect was tried for the selection: at this
                size its dashed box reads as a smudge.) */}
            <FileCode2 aria-hidden size="1em" strokeWidth={2.25} className={MARK} />
            {/* The name truncates and the range does not: `very-long-na…:1204-1288` still says which lines. */}
            <span className="min-w-0 truncate">{reading.name}</span>
            {reading.range && <span className="-ml-1 shrink-0">{reading.range}</span>}
            {reading.count && <span className="shrink-0 text-accent/70">{reading.count}</span>}
          </button>
        )}
        {reading && open.length > 0 && <span aria-hidden className="my-1.5 w-px shrink-0 bg-current opacity-20" />}
        {open.length > 0 && <OpenFiles box={box} open={open} labelled={!reading} hover={hover} />}
      </div>
      {!selection && <Hint chord={chord} />}
    </div>
  )
}

/** The other files open in the editor, each one a whole-file chip. Labelled when it is all the bar has. */
function OpenFiles({ box, open, labelled, hover }: { box: ContextBox; open: EditorContextState["open"]; labelled: boolean; hover: string }) {
  const count = `${open.length} open ${open.length === 1 ? "file" : "files"}`
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          data-editor-open-files
          aria-label={`Add an open file (${count})`}
          title={`Add an open file (${count})`}
          className={`flex shrink-0 items-baseline transition-colors ${labelled ? "gap-0.5 rounded-md px-1.5" : "rounded-r-md px-1"} ${hover} data-[state=open]:bg-panel-2 data-[state=open]:text-fg`}
        >
          {/* The chevron rides a text baseline like every glyph beside text. Alone in the split's right
              half it has no text of its own, and a baseline row then took its BOX bottom as the
              baseline — it rode 3px high; centred on the control instead it sat 0.5px low of the
              reading's cap band. A zero-width space gives it the reading's own baseline: 0.00px. */}
          {labelled ? count : <span aria-hidden>{"\u200b"}</span>}
          <ChevronDown aria-hidden size="1em" strokeWidth={2.25} className={MARK} />
        </button>
      </MenuTrigger>
      {/* Kept 8px off the frame's edges: a sidebar is narrow enough that the menu usually has to shift. */}
      <MenuContent align="start" collisionPadding={8}>
        <div className="max-h-72 max-w-[min(26rem,calc(100vw-24px))] overflow-y-auto">
          <div className="px-2.5 pb-1 pt-1 text-[11px] text-muted-55">Add an open file</div>
          {open.map((file) => (
            <MenuItem key={file.path} onSelect={() => requestEditorContext(box, { what: "file", path: file.path })}>
              <span data-editor-open-file={file.label} title={file.label} className="flex min-w-0 items-baseline gap-1.5">
                <span className="shrink-0">{basename(file.label)}</span>
                {dirnameLike(file.label) && <span className="min-w-0 truncate text-[11px] text-muted-55">{dirnameLike(file.label)}</span>}
              </span>
            </MenuItem>
          ))}
        </div>
      </MenuContent>
    </Menu>
  )
}

/**
 * How to add LINES, for a bar that has none selected: the editor's chord, which the human cannot learn
 * from anywhere else in the sidebar. The longest wording that fits the room the control leaves, measured
 * — never one cut to "Select code and pr…", and nothing at all when even the short one does not fit (the
 * control's tooltip says it too). The room changes with the file's name as much as with the sidebar's
 * width, so a fixed breakpoint could not pick.
 */
function Hint({ chord }: { chord: string }) {
  const variants = [`Select code and press ${chord}`, `Select, then ${chord}`, `Select + ${chord}`]
  const slotRef = useRef<HTMLSpanElement>(null)
  const measureRef = useRef<HTMLSpanElement>(null)
  const [fit, setFit] = useState(0)
  useLayoutEffect(() => {
    const slot = slotRef.current
    const measure = measureRef.current
    if (!slot || !measure) return
    const choose = () => {
      const room = slot.clientWidth - parseFloat(getComputedStyle(slot).paddingRight)
      const widths = [...measure.children].map((child) => (child as HTMLElement).offsetWidth)
      const index = widths.findIndex((width) => width <= room)
      setFit(index === -1 ? variants.length : index)
    }
    choose()
    const observer = new ResizeObserver(choose)
    observer.observe(slot)
    return () => observer.disconnect()
  }, [chord])
  return (
    // `pr-0.5`: the text's last ink then sits 9px in from the box's edge, over the send button's (sans).
    <span ref={slotRef} data-editor-context-hint className="relative min-w-0 flex-1 overflow-hidden whitespace-nowrap pr-0.5 text-right text-[11px] leading-6 text-muted-70">
      {variants[fit]}
      <span ref={measureRef} aria-hidden data-hint-measure className="invisible absolute left-0 top-0 flex">
        {variants.map((variant) => <span key={variant}>{variant}</span>)}
      </span>
    </span>
  )
}

// A 1em glyph on the text's cap band (CLAUDE.md § optical spacing): baseline-aligned in a baseline row,
// lifted by half its box less half the font's own cap height — so it sits right in either font, at any
// size, with nothing measured by hand.
const MARK = "shrink-0 self-baseline translate-y-[calc(0.5em_-_0.5cap)]"
