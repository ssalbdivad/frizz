import * as RadixDialog from "@radix-ui/react-dialog"
import { useQuery } from "@tanstack/react-query"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react"
import { useSnapshot } from "valtio"
import { closeImageViewer, stepImageViewer, store } from "../store.ts"
import { localFileQuery } from "../lib/localFileQuery.ts"
import { isRasterImagePath } from "../lib/localViewer.ts"
import { localImageUrl } from "../lib/markdownTargets.ts"
import { basename } from "../lib/paths.ts"
import { handleDialogEscape } from "../lib/selectOverlay.ts"
import { OpenAction } from "./FileReaderDrawer.tsx"
import { SheetHeader } from "./ui/SheetHeader.tsx"

// THE PICTURE VIEWER: a click on any picture Frizz renders — a tool's screenshot, a delivered image, a
// path a worker wrote on its own line, a Markdown `![](…)`, an attachment — opens it HERE, over
// whatever page or drawer it was clicked in, instead of handing the file to the desktop opener (which on
// a WSL box meant a browser tab; see lib/localViewer.ts). Esc, the close button or a click anywhere off
// the picture puts it away and leaves everything beneath exactly as it was.
//
//   · FIT FIRST. The picture opens as large as the stage allows without being enlarged past its own
//     size; a click then shows it at ACTUAL SIZE (one image pixel per CSS pixel, the way the browser's
//     own image tab does), keeping the clicked point under the pointer, and a second click fits it
//     again. Only offered when fitting actually shrank it.
//   · ←/→ step through the pictures rendered beside it — the same card, drawer or page (the store's
//     `imageViewer.paths`), so a worker's before/after shots compare in place.
//   · "Open" is the way out to the OS's own viewer, as a click on a picture used to be. It closes this
//     first: its answer can be a toast (a copied path, an opener that failed), and toasts sit below
//     every modal layer.
//
// OVER the page, not instead of it: the page stays in view under the app's own scrim, the one its
// dialogs and drawers dim with (here at full strength, since the picture is the only thing in focus),
// because a page you can still see is what says a click off the picture goes back to it (maintainer
// 2026-09-28). It was opaque for a day, after a 95% veil ghosted the transcript into blurred shapes
// that read as rendering noise; the scrim keeps the page legible as a page.
//
// A Radix MODAL dialog, which is what keeps it the top of every stack without extra bookkeeping: its
// focus trap, its scroll lock, and its Escape — observed on document capture and stopped there by
// handleDialogEscape, so one press closes this and never also a drawer beneath. The keyboard runtime
// reads an open `aria-modal` dialog as "not the page", so a plain key typed here drives no card.
export function ImageViewer() {
  const snap = useSnapshot(store)
  const viewer = snap.imageViewer
  if (!viewer) return null
  const path = viewer.paths[viewer.index]!
  return (
    <RadixDialog.Root open onOpenChange={(open) => { if (!open) closeImageViewer() }}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay data-image-viewer-scrim className="overlay-in fixed inset-0 z-[200] bg-scrim backdrop-blur-[1px]" />
        <ViewerContent key={path} path={path} index={viewer.index} count={viewer.paths.length} project={viewer.project} />
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

// The stage's inset around the fitted picture, per side.
const STAGE_PAD = 24
// With more than one picture, the sides clear the step buttons (12px in, 36px wide) and a little air, so
// a picture as wide as the stage is never partly under one. Not on a phone, where the width is worth more
// than an unobstructed edge — the buttons sit over it there, as they do in every phone gallery.
const STEP_GUTTER = 64
const GUTTER_MIN_STAGE = 640

type Size = { width: number; height: number }

// The largest size `natural` takes inside `box` at its own aspect ratio, never enlarged past `natural`
// itself: a 40px crop blown up to the viewport is noise, and a 240px diagram blown up six times drew its
// 2px strokes 12px thick.
export function fitSize(natural: Size, box: Size): Size & { scale: number } {
  // Nothing to scale by (a picture that reports no size at all): the stage's own box.
  if (!(natural.width > 0 && natural.height > 0)) return { ...box, scale: 1 }
  const scale = Math.max(0, Math.min(box.width / natural.width, box.height / natural.height, 1))
  return { width: natural.width * scale, height: natural.height * scale, scale }
}

// The size an SVG declares for itself. Chrome answers `naturalWidth` with 300×150 — the default object
// size — for any SVG whose root lacks an absolute width AND height, whatever its viewBox says, so a
// square icon measured 2:1 and a mermaid diagram (`width="100%"`) measured 300 wide. Absolute
// width/height are left to the browser, which already converts `pt` and friends; otherwise the viewBox
// is the drawing's own coordinate size. null when the file declares neither.
//
// DOMParser builds an INERT document: nothing in it runs or fetches.
export function svgDeclaredSize(text: string): Size | "absolute" | null {
  const root = new DOMParser().parseFromString(text, "image/svg+xml").documentElement
  if (root.localName !== "svg") return null
  const absolute = (value: string | null) => !!value && /^\s*[\d.]+\s*(?:px|pt|pc|mm|cm|in)?\s*$/i.test(value)
  if (absolute(root.getAttribute("width")) && absolute(root.getAttribute("height"))) return "absolute"
  const box = root.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number)
  if (box?.length === 4 && box[2]! > 0 && box[3]! > 0) return { width: box[2]!, height: box[3]! }
  return null
}

// An SVG as an image the browser draws but never runs: a `data:` URL in an <img>, where scripts,
// external fetches and event handlers are all off — which is why SVG may be shown here at all while the
// `/local-image` proxy refuses to serve one (a navigable same-origin SVG IS a script).
function svgDataUrl(text: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`
}

function ViewerContent({ path, index, count, project }: { path: string; index: number; count: number; project?: string }) {
  const raster = isRasterImagePath(path)
  // A vector reads through the reader's text gate (the /local-image route refuses SVG) and becomes a
  // `data:` image. A read cut at the reader's 1 MiB ceiling is a broken drawing, so it counts as failed.
  // Through the card's project when the picture was on another project's card, as the reader does.
  const svg = useQuery({ ...localFileQuery(path, project), enabled: !raster })
  const svgText = !raster && svg.data && !svg.data.truncated ? svg.data.markdown : null
  const declared = useMemo(() => (svgText === null ? null : svgDeclaredSize(svgText)), [svgText])
  const src = raster ? localImageUrl(path) : svgText !== null ? svgDataUrl(svgText) : null
  const readFailure = raster ? null
    : svg.error ? (svg.error as Error).message
      : svg.data?.truncated ? "this drawing is too large to show"
        : null

  const contentRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const [natural, setNatural] = useState<Size | null>(null)
  const [stage, setStage] = useState<Size | null>(null)
  const [broken, setBroken] = useState(false)
  const [actual, setActual] = useState(false)
  // Where a zoom-in click landed: the picture's fraction under the pointer, and the pointer itself.
  const anchor = useRef<{ fx: number; fy: number; x: number; y: number } | null>(null)
  // The pointer-down target, so a drag that merely ENDS on the stage (a text selection in the header,
  // a scrollbar drag) is not read as a click on it.
  const downOn = useRef<EventTarget | null>(null)

  // The stage, tracked live: the fitted size follows a window resize or a rotated phone.
  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    const measure = () => setStage({ width: el.clientWidth, height: el.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const padX = count > 1 && stage && stage.width >= GUTTER_MIN_STAGE ? STEP_GUTTER : STAGE_PAD
  const box = stage ? { width: Math.max(0, stage.width - padX * 2), height: Math.max(0, stage.height - STAGE_PAD * 2) } : null
  const fitted = natural && box ? fitSize(natural, box) : null
  const zoomable = !!fitted && fitted.scale < 1

  // Actual size just took effect: scroll so the point that was clicked sits under the pointer again.
  useLayoutEffect(() => {
    const a = anchor.current
    const el = stageRef.current
    const img = imgRef.current
    anchor.current = null
    if (!actual || !a || !el || !img) return
    const r = img.getBoundingClientRect()
    el.scrollLeft += r.left + a.fx * r.width - a.x
    el.scrollTop += r.top + a.fy * r.height - a.y
  }, [actual])

  const onPicture = (event: ReactMouseEvent<HTMLImageElement>) => {
    if (actual) {
      setActual(false)
      return
    }
    if (!zoomable) return
    const r = event.currentTarget.getBoundingClientRect()
    anchor.current = { fx: (event.clientX - r.left) / r.width, fy: (event.clientY - r.top) / r.height, x: event.clientX, y: event.clientY }
    setActual(true)
  }

  // The empty stage is the backdrop. Its own scrollbar (actual size) is not, and a drag is not a click.
  const onStage = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as Element
    if (target !== downOn.current || !target.hasAttribute("data-viewer-backdrop")) return
    const el = event.currentTarget
    const rect = el.getBoundingClientRect()
    if (event.clientX - rect.left >= el.clientWidth || event.clientY - rect.top >= el.clientHeight) return
    closeImageViewer()
  }

  const name = basename(path)
  // Pixels and the scale they are drawn at — the two numbers a screenshot is judged by. A drawing that
  // declares no size of its own has neither: its "natural" size is the browser's 300×150 stand-in.
  const measured = raster || declared !== null
  const readout = measured && natural && fitted ? `${natural.width} × ${natural.height} · ${Math.round((actual ? 1 : fitted.scale) * 100)}%` : null
  const failure = readFailure ?? (broken ? "the file may have moved or been cleaned up" : null)

  return (
    <RadixDialog.Content
      ref={contentRef}
      aria-modal="true"
      aria-describedby={undefined}
      data-image-viewer
      onEscapeKeyDown={handleDialogEscape}
      // Focus the dialog itself, not its first button: the arrows work at once, and no control wears a
      // focus ring the pointer never asked for.
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        contentRef.current?.focus({ preventScroll: true })
      }}
      onKeyDown={(event) => {
        if (event.metaKey || event.ctrlKey || event.altKey) return
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault()
          stepImageViewer(event.key === "ArrowLeft" ? -1 : 1)
        }
      }}
      className="overlay-in fixed inset-0 z-[200] flex flex-col outline-none"
    >
      <RadixDialog.Title className="sr-only">{name}</RadixDialog.Title>
      <SheetHeader
        title={name}
        subtitle={path}
        // The file's name is what a phone's header has room for; its pixels are a desktop's detail. It sits
        // on the name's baseline (SheetHeader aligns its runs by baseline; it centred them until 2026-09-30,
        // when this run needed a measured 0.045em nudge to get there).
        meta={readout ? <span className="shrink-0 text-[11px] tabular-nums text-muted-60 max-sm:hidden">{readout}</span> : undefined}
        actions={
          <>
            {count > 1 && <span className="shrink-0 text-[12px] tabular-nums text-muted">{index + 1} / {count}</span>}
            {/* -mr-2: the close glyph's hover square carries 9px of dead space, so on the header's even
                gap "Open" sat 19.06px of ink from the ✕ but 11.21px from the counter. Pulled in, the
                three read as one evenly spaced cluster (ink gaps 11.21 / 11.06px). */}
            <OpenAction path={path} image={raster} project={project} onOpen={closeImageViewer} className="-mr-2" />
          </>
        }
        onClose={closeImageViewer}
      />
      <div className="relative min-h-0 flex-1">
        <div
          ref={stageRef}
          data-viewer-backdrop
          onPointerDown={(event) => { downOn.current = event.target }}
          onClick={onStage}
          className={`absolute inset-0 ${actual ? "overflow-auto" : "flex items-center justify-center overflow-hidden"}`}
        >
          {failure ? (
            <div className="px-6 text-center text-[13px] text-muted">Couldn’t show this picture: {failure}.</div>
          ) : src ? (
            <div data-viewer-backdrop className={actual ? "grid min-h-full min-w-full w-max place-items-center" : "contents"} style={actual ? { padding: STAGE_PAD } : undefined}>
              <img
                ref={imgRef}
                src={src}
                alt={name}
                onLoad={(event) => {
                  const img = event.currentTarget
                  setNatural(declared && declared !== "absolute" ? declared : { width: img.naturalWidth, height: img.naturalHeight })
                }}
                onError={() => setBroken(true)}
                onClick={onPicture}
                // The picture's own size at actual size; the fitted box otherwise. Until it has loaded
                // there is no size to fit, so it waits invisibly rather than flashing at its raw size.
                style={
                  actual && natural ? { width: natural.width, height: natural.height, maxWidth: "none" }
                    : fitted ? { width: fitted.width, height: fitted.height }
                      : { maxWidth: "100%", maxHeight: "100%" }
                }
                // The transparency grid is behind EVERY picture, not only SVG: it shows nowhere a picture
                // paints, so a screenshot is untouched, while an icon's black strokes on nothing stay
                // visible over the dimmed page.
                className={`frizz-transparency-grid block select-none rounded-sm shadow-2xl shadow-shadow-ink/40 ring-1 ring-border ${
                  natural ? "" : "opacity-0"
                } ${actual ? "cursor-zoom-out" : zoomable ? "cursor-zoom-in" : ""}`}
              />
            </div>
          ) : null}
        </div>
        {count > 1 && (
          <>
            <StepButton step={-1} disabled={index === 0} />
            <StepButton step={1} disabled={index === count - 1} />
          </>
        )}
      </div>
    </RadixDialog.Content>
  )
}

function StepButton({ step, disabled }: { step: 1 | -1; disabled: boolean }) {
  const Icon = step === -1 ? ChevronLeft : ChevronRight
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => stepImageViewer(step)}
      aria-label={step === -1 ? "Previous picture" : "Next picture"}
      className={`absolute top-1/2 ${step === -1 ? "left-3" : "right-3"} flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-border-strong bg-panel/85 text-fg/80 shadow-lg shadow-shadow-ink/30 outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:pointer-events-none disabled:opacity-0`}
    >
      <Icon size={18} aria-hidden="true" />
    </button>
  )
}
