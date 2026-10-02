import { useState } from "react"
import { FileCode2 } from "lucide-react"
import { contextChipLabel, type SentEditorContext } from "../lib/composerContext.ts"
import { basename } from "../lib/paths.ts"

// WHAT THE EDITOR HAD IN FRONT, under a sent message — the editor block a sidebar send carries on its own
// (lib/composerContext.ts serializeEditorContext), taken off the end of the message and drawn as one quiet
// chip under the bubble instead of a header and a wall of `>` lines in it. The chip is the context bar's
// reading at the moment of the send — the same glyph, the same `r2-private.ts:91-116` label — so the human
// can see, message by message, what went with their words without it reading as words they wrote.
//
// Under the bubble, on the page, and never inside it: the bubble is the human's own prose, verbatim; this
// was attached by the sidebar. It also keeps the chip's click clear of a queued bubble's click-to-unqueue.
// A quoted selection opens its code below the chip, as a ⌘I chip's quote opens in the bubble
// (ChatView SentContextBody); a file with nothing selected, or a selection too long to quote, has nothing
// to open — its hover says where it was, and that is all there is.
export function SentEditorContextChip({ editor, queued }: { editor: SentEditorContext; queued?: boolean }) {
  const [open, setOpen] = useState(false)
  const selection = editor.kind === "selection" && editor.startLine !== undefined && editor.endLine !== undefined
  const label = selection ? contextChipLabel({ display: editor.display, startLine: editor.startLine, endLine: editor.endLine }) : basename(editor.display)
  const where = selection
    ? `${editor.display} · ${editor.startLine === editor.endLine ? `line ${editor.startLine}` : `lines ${editor.startLine}-${editor.endLine}`}`
    : `${editor.display}${editor.cursorLine !== undefined ? ` · line ${editor.cursorLine}` : ""}`
  const unsaved = editor.state === "untitled" ? " (never saved)" : editor.state === "unsaved" ? " (unsaved changes)" : ""
  // Each way a selection went, in the human's terms: quoted, named again (the thread had it already), or
  // named without its text (too long, or a file that may hold secrets).
  const how = editor.repeat
    ? " (still selected; quoted in an earlier message)"
    : editor.unquoted === "secret" ? " (its lines only: the file may hold secrets)" : editor.unquoted === "long" || (selection && editor.text === undefined) ? " (its lines, too long to quote)" : ""
  const title = selection
    ? `Sent with your message from the editor: ${where}${unsaved}${how}`
    : `Open in the editor when you sent this: ${where}${unsaved}`
  const body = (
    <>
      <FileCode2 aria-hidden size="1em" strokeWidth={2.25} className={MARK} />
      <span className="min-w-0 truncate">{label}</span>
    </>
  )
  const chip = `inline-flex max-w-56 items-baseline gap-1 rounded border border-border px-1 font-mono-keep text-[11px] leading-snug text-muted`
  return (
    <div data-sent-editor-context={editor.kind} className={`flex max-w-full flex-col items-end ${queued ? "opacity-50" : ""}`}>
      {editor.text !== undefined ? (
        <button
          type="button"
          title={title}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className={`${chip} transition-colors hover:bg-panel-2 hover:text-fg outline-none focus-visible:inset-ring-1 focus-visible:inset-ring-focus-ink-60 ${open ? "bg-panel-2 text-fg" : ""}`}
        >
          {body}
        </button>
      ) : (
        <span title={title} className={chip}>{body}</span>
      )}
      {open && editor.text !== undefined && (
        <div data-sent-editor-quote className="mt-1 max-w-full rounded-md border border-border bg-panel-2 px-2 py-1.5">
          <div className="truncate font-mono-keep text-[11px] text-muted">{where}</div>
          <div className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono-keep text-[11.5px] leading-4 text-fg/80">{editor.text}</div>
        </div>
      )}
    </div>
  )
}

// The bar's own placement for its glyph (EditorContextBar MARK): a 1em glyph on the text's cap band, in
// either font at any size, with nothing measured by hand.
const MARK = "shrink-0 self-baseline translate-y-[calc(0.5em_-_0.5cap)]"
