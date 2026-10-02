import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react"
import { scanInputFences, type InputFenceRun } from "../lib/inputCodeFences.ts"
import { highlightToHtml } from "../lib/syntaxHighlight.ts"

// One fenced-code run of a textarea mirror, painted. The delimiter lines go muted; a body goes through
// the same highlight.js pipeline the transcript's fences use, inside `.hljs` so the shared token palette
// applies. `.input-hljs` (styles.css) strips the palette's italics and bold: the mirror must keep every
// advance width identical to the textarea's, and a slanted comment would drift the rest of its line.
// `highlightToHtml` escapes everything it is given, so its output is safe to inject.
export function renderInputFenceRun(text: string, run: InputFenceRun, key: number): ReactNode {
  const slice = text.slice(run.start, run.end)
  if (run.kind === "prose") return slice
  if (run.kind === "fence") return <span key={key} className="text-muted">{slice}</span>
  return <span key={key} className="hljs input-hljs" dangerouslySetInnerHTML={{ __html: highlightToHtml(slice, run.language) }} />
}

// The typography a mirror must share with its textarea for every glyph to land on the same pixel.
const COPIED = [
  "boxSizing", "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontVariant", "fontStretch",
  "fontFeatureSettings", "fontVariationSettings", "fontKerning", "lineHeight", "letterSpacing",
  "wordSpacing", "textIndent", "textTransform", "textAlign", "tabSize", "whiteSpace", "overflowWrap",
  "wordBreak", "direction", "color", "opacity",
  "paddingTop", "paddingLeft", "paddingBottom",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
] as const

// Code-fence highlighting for any plain <textarea>: render it as the textarea's NEXT SIBLING with the
// same value. Mounts nothing until the text holds a fence. While it does, it lays a pointer-transparent
// mirror exactly over the textarea and paints the text there, and the textarea's own glyphs go
// transparent (`-webkit-text-fill-color`, which leaves `color` — and so the caret, which follows it —
// untouched). The textarea keeps its background, border, focus ring, caret, selection and every event.
//
// The Composer does not use this: it already owns a mirror (for staged context pills and @mentions),
// and paints fences into that one instead, through the same `renderInputFenceRun`.
export function TextareaCodeFences({ value }: { value: string }) {
  const runs = useMemo(() => scanInputFences(value), [value])
  if (!runs) return null
  return <FenceMirror text={value} runs={runs} />
}

function FenceMirror({ text, runs }: { text: string; runs: InputFenceRun[] }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const mirror = ref.current
    const ta = mirror?.previousElementSibling
    if (!mirror || !(ta instanceof HTMLTextAreaElement)) return
    ta.style.setProperty("-webkit-text-fill-color", "transparent")
    // Re-synced every frame while mounted (only while a fence is on screen): a textarea moves and
    // resizes for reasons no observer reports — a dialog's open animation, content above it growing,
    // a drag of its resize handle — and one frame of drift detaches every coloured glyph from its own.
    let frame = 0
    const sync = () => {
      frame = requestAnimationFrame(sync)
      if (!ta.isConnected || ta.offsetParent === null) return
      const style = getComputedStyle(ta)
      for (const prop of COPIED) mirror.style[prop] = style[prop]
      // A classic scrollbar narrows the textarea's text box; the mirror has none, so it takes the
      // same width back as padding or its lines would wrap later than the textarea's.
      const borders = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)
      const scrollbar = ta.offsetWidth - ta.clientWidth - borders
      mirror.style.paddingRight = `${parseFloat(style.paddingRight) + Math.max(0, scrollbar)}px`
      mirror.style.width = style.width
      mirror.style.height = style.height
      // Position by measured offset rather than by assuming a containing block: the mirror is an
      // absolutely positioned sibling, and whichever ancestor it resolves against, the rect delta
      // (unscaled, so a zooming dialog stays exact) is how far it still has to move.
      const want = ta.getBoundingClientRect()
      const have = mirror.getBoundingClientRect()
      const scale = want.width / (parseFloat(style.width) || want.width || 1) || 1
      if (Math.abs(want.left - have.left) > 0.01 || Math.abs(want.top - have.top) > 0.01) {
        mirror.style.left = `${(parseFloat(mirror.style.left) || 0) + (want.left - have.left) / scale}px`
        mirror.style.top = `${(parseFloat(mirror.style.top) || 0) + (want.top - have.top) / scale}px`
      }
      mirror.scrollTop = ta.scrollTop
      mirror.scrollLeft = ta.scrollLeft
    }
    sync()
    return () => {
      cancelAnimationFrame(frame)
      ta.style.removeProperty("-webkit-text-fill-color")
    }
  }, [])
  return (
    <div
      ref={ref}
      aria-hidden
      data-textarea-code-fences
      className="pointer-events-none absolute left-0 top-0 m-0 select-none overflow-hidden border-solid border-transparent bg-transparent"
    >
      {runs.map((run, i) => renderInputFenceRun(text, run, i))}
      {/* A textarea gives a trailing newline its own empty line; a div does not, so without this the
          mirror is one line short and cannot scroll as far as the textarea when pinned to the bottom. */}
      {text.endsWith("\n") && " "}
    </div>
  )
}
