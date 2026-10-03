import * as RadixDialog from "@radix-ui/react-dialog"
import { ChevronLeft, ChevronRight, ExternalLink, X } from "lucide-react"
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react"
import { useSnapshot } from "valtio"
import { closeLightbox, openLightbox, stepLightbox, store } from "../store.ts"
import { justifyRows } from "../lib/justifiedRows.ts"
import { lightboxLabel, resolveLightboxPath, type LightboxEntry, type LightboxImage } from "../lib/lightbox.ts"
import { useBackClosesLayer } from "../lib/backDismiss.ts"
import { openLocalPathExternally } from "../lib/local-file-links.ts"
import { localImageUrl } from "../lib/markdownTargets.ts"
import { useIsMobile } from "../lib/mobile.ts"
import { handleDialogEscape } from "../lib/selectOverlay.ts"
import { useLocalPathBase } from "../lib/useMarkdown.ts"
import { ImageFrame } from "./ImageFrame.tsx"

// A ```lightbox fence (lib/lightbox.ts for the grammar): the pictures a worker listed, laid out as ONE
// gallery inside the same frame every rendered picture in the transcript sits in (ImageFrame), and a
// full-screen viewer that pages through them when one is clicked.
//
// The gallery is JUSTIFIED ROWS (lib/justifiedRows.ts) — every picture in a row at one height, each at
// its own aspect ratio — so a phone shot and a desktop shot sit side by side at their real shapes, with
// nothing cropped. The gutter between two pictures is the mat's own padding, so the air between them is
// the air around them.

// = the mat's `p-1.5`.
const GAP = 6
// FRAMED_IMAGE's `max-h-[420px]`: one picture alone is exactly as tall as the same picture framed bare.
const MAX_ROW_HEIGHT = 420
// Until a picture loads its shape is unknown; a screenshot is the likeliest thing it is.
const DEFAULT_RATIO = 16 / 10
// The layout's range of shapes. A full-page capture (1440×9000) would otherwise be a sliver one row of
// its neighbours could not see; past these bounds the picture is contained inside its tile instead.
const MIN_RATIO = 0.4
const MAX_RATIO = 3

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

// The row height a gallery aims for at this width: a quarter of it, within reason. At the transcript's
// usual ~700px that is ~180px, which lays 2 shots as one row, 4 as two rows of 2 and 6 as two rows of 3.
const targetRowHeight = (width: number) => clamp(width / 4, 112, 180)

interface Tile {
  entry: LightboxEntry
  /** The resolved absolute path, or null when the line names nothing the image proxy can serve. */
  path: string | null
  label: string
  captioned: boolean
}

export function LightboxGallery({ entries }: { entries: LightboxEntry[] }) {
  const base = useLocalPathBase()
  const tiles = useMemo<Tile[]>(
    () => entries.map((entry) => {
      const path = resolveLightboxPath(entry.target, base)
      return { entry, path, ...lightboxLabel(entry, path) }
    }),
    [entries, base],
  )
  // Keyed by path: a picture's shape is a fact about the file, wherever it sits in the list.
  const [ratios, setRatios] = useState<Record<string, number>>({})
  const [broken, setBroken] = useState<Record<string, true>>({})
  const [rowsEl, setRowsEl] = useState<HTMLDivElement | null>(null)
  const width = useContentWidth(rowsEl)

  // Only the pictures that are there take a place in the rows. A line that names nothing the proxy can
  // serve, or a file that failed to load, is listed under them as its plain path — the fallback BlockImage
  // gives a single picture — rather than as a tile, where an empty box drew the eye harder than any
  // picture beside it.
  const shown = tiles.filter((tile) => tile.path !== null && !broken[tile.path])
  const missing = tiles.filter((tile) => !shown.includes(tile))
  const ratioOf = (tile: Tile) => clamp(ratios[tile.path!] || DEFAULT_RATIO, MIN_RATIO, MAX_RATIO)
  const rows = justifyRows(shown.map(ratioOf), width, {
    gap: GAP,
    target: targetRowHeight(width),
    maxHeight: MAX_ROW_HEIGHT,
    maxPerRow: 8,
  })
  // A gallery is labelled only when the worker captioned it: a bare list of files reads as pictures, and
  // the viewer names each one. Once any picture has a caption every tile carries a label line, in one
  // register, so the rows stay level.
  const labelled = tiles.some((tile) => tile.captioned)
  const images: LightboxImage[] = shown.map((tile) => ({ path: tile.path!, label: tile.label, captioned: tile.captioned }))

  if (shown.length === 0) {
    return (
      <div data-lightbox-gallery className="flex flex-col gap-1">
        {missing.map((tile, i) => <MissingPath key={i} tile={tile} />)}
      </div>
    )
  }
  return (
    <ImageFrame>
      <div ref={setRowsEl} data-lightbox-gallery className="flex w-full min-w-0 flex-col gap-1.5">
        {rows.map((row) => (
          // A row capped at MAX_ROW_HEIGHT is narrower than the mat, and centers in it the way a lone
          // framed picture does.
          <div key={row.start} data-lightbox-row className="mx-auto flex max-w-full gap-1.5" style={{ width: row.width }}>
            {shown.slice(row.start, row.end).map((tile, offset) => (
              <GalleryPicture
                key={row.start + offset}
                tile={tile}
                ratio={ratioOf(tile)}
                labelled={labelled}
                onOpen={() => openLightbox(images, row.start + offset)}
                onShape={(ratio) => setRatios((prev) => (prev[tile.path!] === ratio ? prev : { ...prev, [tile.path!]: ratio }))}
                onBroken={() => setBroken((prev) => ({ ...prev, [tile.path!]: true }))}
              />
            ))}
          </div>
        ))}
        {missing.map((tile, i) => <MissingPath key={i} tile={tile} />)}
      </div>
    </ImageFrame>
  )
}

// The tile's share of its row is its aspect ratio (`flex-grow`), and its picture box carries the same
// ratio, so every tile in a row comes out at one height without the row being measured twice.
function tileStyle(ratio: number) {
  return { flex: `${ratio} 1 0%` }
}

function GalleryPicture({ tile, ratio, labelled, onOpen, onShape, onBroken }: {
  tile: Tile
  ratio: number
  labelled: boolean
  onOpen: () => void
  onShape: (ratio: number) => void
  onBroken: () => void
}) {
  return (
    <button
      type="button"
      data-lightbox-tile
      onClick={onOpen}
      aria-label={`View ${tile.label}`}
      className="group flex min-w-0 cursor-zoom-in flex-col gap-1 rounded-md text-left outline-none focus-visible:ring-1 focus-visible:ring-focus-ink-60 focus-visible:ring-offset-2 focus-visible:ring-offset-panel-2"
      style={tileStyle(ratio)}
    >
      <span className="block w-full overflow-hidden rounded-md" style={{ aspectRatio: ratio }}>
        <img
          src={localImageUrl(tile.path!)}
          alt={tile.label}
          draggable={false}
          onLoad={(e) => {
            const { naturalWidth, naturalHeight } = e.currentTarget
            if (naturalWidth > 0 && naturalHeight > 0) onShape(naturalWidth / naturalHeight)
          }}
          onError={onBroken}
          className="block h-full w-full object-contain transition-[filter] group-hover:brightness-110"
        />
      </span>
      {labelled && (
        <span title={tile.label} className="block truncate font-sans text-[11px] leading-4 text-muted">
          {tile.label}
        </span>
      )}
    </button>
  )
}

// A line that names no picture the proxy can serve, or a file that failed to load: its plain path, in the
// muted mono BlockImage falls back to — nothing silently dropped.
function MissingPath({ tile }: { tile: Tile }) {
  return (
    <div data-lightbox-missing className="break-all font-mono-keep text-[12px] text-muted-70">
      {tile.path ?? tile.entry.target}
    </div>
  )
}

// The rows' content width, read before paint so the first frame is already laid out at the real width.
// Keyed on the ELEMENT, not a ref object: the rows mount late whenever every path starts unresolved (a
// relative path before the board names the project root), and a ref's identity never changes to say so.
function useContentWidth(el: HTMLElement | null): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    if (!el) return
    setWidth(el.clientWidth)
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(el)
    return () => observer.disconnect()
  }, [el])
  return width
}

/**
 * The viewer, hosted ONCE per page shell beside the Toaster (routes.tsx) and driven by `store.lightbox`.
 * Mounted means open.
 */
export function LightboxHost() {
  const { lightbox } = useSnapshot(store)
  if (!lightbox) return null
  return <LightboxViewer images={lightbox.images} index={lightbox.index} />
}

function LightboxViewer({ images, index }: { images: readonly LightboxImage[]; index: number }) {
  // On a phone the viewer takes a history entry of its own, so Back closes it and not the thread under
  // it (lib/backDismiss) — the same rule every sheet over a phone thread follows.
  useBackClosesLayer(useIsMobile(), false, closeLightbox)
  // Frizz opens this by writing store state, not through a Radix Trigger, so Radix has no element to
  // hand focus back to on close. Remember the thumbnail that opened it, as NewThreadDialog does.
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  const contentRef = useRef<HTMLDivElement>(null)
  const swipe = useRef<{ x: number; y: number; swiped: boolean } | null>(null)
  const image = images[index]
  if (!image) return null
  const many = images.length > 1

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft") stepLightbox(-1)
    else if (e.key === "ArrowRight") stepLightbox(1)
    else if (e.key === "Home") stepLightbox(-images.length)
    else if (e.key === "End") stepLightbox(images.length)
    else return
    e.preventDefault()
    e.stopPropagation()
  }
  // A click on the backdrop — the stage or the bar around the picture, not the picture or a control —
  // closes the viewer, as a click outside any dialog does.
  const dismissOnSelf = (e: MouseEvent) => {
    if (swipe.current?.swiped) return
    if (e.target === e.currentTarget) closeLightbox()
  }
  // A horizontal swipe pages on a touch screen. Pointer events rather than touch events so one handler
  // serves every input; the stage's `touch-action: pinch-zoom` keeps the browser from claiming the
  // horizontal pan for itself while still letting a phone zoom into the picture.
  const onPointerDown = (e: PointerEvent) => {
    swipe.current = e.pointerType === "touch" ? { x: e.clientX, y: e.clientY, swiped: false } : null
  }
  const onPointerUp = (e: PointerEvent) => {
    const start = swipe.current
    if (!start || e.pointerType !== "touch") return
    const dx = e.clientX - start.x
    const dy = e.clientY - start.y
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      start.swiped = true
      stepLightbox(dx < 0 ? 1 : -1)
    }
  }

  return (
    <RadixDialog.Root open onOpenChange={(open) => { if (!open) closeLightbox() }}>
      <RadixDialog.Portal>
        {/* Near-black in BOTH themes: a lightbox exists to put the picture on a neutral dark field, and
            a light-mode scrim would wash a dark screenshot out. 95% and blurred: at 90% the transcript's
            own text still read through around a narrow picture, and a light page came through as a
            muddy grey with its dark screenshots floating in it as blobs. */}
        <RadixDialog.Overlay className="overlay-in fixed inset-0 z-[200] bg-black/95 backdrop-blur-md" />
        <RadixDialog.Content
          ref={contentRef}
          data-lightbox
          aria-modal="true"
          aria-describedby={undefined}
          onEscapeKeyDown={handleDialogEscape}
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            contentRef.current?.focus({ preventScroll: true })
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            if (opener.current?.isConnected) opener.current.focus({ preventScroll: true })
          }}
          onKeyDown={onKeyDown}
          className="overlay-in fixed inset-0 z-[200] flex flex-col text-white outline-none"
        >
          <header
            onClick={dismissOnSelf}
            className="flex shrink-0 items-center gap-3 px-4 pb-2 pt-[max(env(safe-area-inset-top),12px)]"
          >
            <div className="min-w-0 flex-1">
              <RadixDialog.Title className={`truncate text-[13px] font-medium leading-5 text-white/90 ${image.captioned ? "" : "font-mono-keep"}`}>
                {image.label}
              </RadixDialog.Title>
              <div className="truncate font-mono-keep text-[11px] leading-4 text-white/45">{image.path}</div>
            </div>
            {/* `gap-4` is 16px of INK between every mark here, because each button is trimmed onto its
                own glyph (ViewerButton `trim`) — and the trim also lands the close glyph 16px from the
                window edge, mirroring the title's 16px on the left. */}
            <div data-lightbox-actions className="flex shrink-0 items-center gap-4">
              {many && (
                <span data-lightbox-counter className="text-[12px] tabular-nums text-white/60">
                  {index + 1} / {images.length}
                </span>
              )}
              <ViewerButton label="Open in default viewer" trim={OPEN_TRIM} onClick={() => openLocalPathExternally(image.path)}>
                <ExternalLink size={16} strokeWidth={VIEWER_PEN} absoluteStrokeWidth />
              </ViewerButton>
              <ViewerButton label="Close" trim={CLOSE_TRIM} onClick={closeLightbox}>
                <X size={18} strokeWidth={VIEWER_PEN} absoluteStrokeWidth />
              </ViewerButton>
            </div>
          </header>
          <div
            data-lightbox-stage
            onClick={dismissOnSelf}
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            className="relative flex min-h-0 flex-1 items-center justify-center px-3 pb-[max(env(safe-area-inset-bottom),16px)] sm:px-16"
            style={{ touchAction: "pinch-zoom" }}
          >
            <ViewerPicture key={image.path} image={image} />
            {many && index > 0 && (
              <PageButton side="left" onClick={() => stepLightbox(-1)} />
            )}
            {many && index < images.length - 1 && (
              <PageButton side="right" onClick={() => stepLightbox(1)} />
            )}
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

function ViewerPicture({ image }: { image: LightboxImage }) {
  const [broken, setBroken] = useState(false)
  if (broken) {
    return (
      <div className="pointer-events-none max-w-md text-center">
        <div className="text-[13px] text-white/70">Image unavailable</div>
        <div className="mt-1 break-all font-mono-keep text-[11px] text-white/45">{image.path}</div>
      </div>
    )
  }
  return (
    <img
      src={localImageUrl(image.path)}
      alt={image.label}
      draggable={false}
      onError={() => setBroken(true)}
      // The hairline is the picture's edge: agent screenshots are overwhelmingly dark UI, which on a
      // near-black field has none of its own (the mat does this job in the transcript's frame).
      className="block max-h-full max-w-full select-none rounded-md object-contain ring-1 ring-white/10"
    />
  )
}

// The header buttons' layout footprints, collapsed onto their glyphs' ink so the strip's one `gap` is
// the distance the eye reads. Measured with scripts/ink-gaps.mjs at dsf 4 on the real viewer: a 36px
// square paints ExternalLink@16 across 13.5px (11.25px dead a side) and X@18 across 10.5px (12.75px).
// Untrimmed, the strip drew 23.5px and 26px of ink on one nominal gap and parked the close glyph 28.75px
// off the window edge against the title's 16.5px. The squares now OVERLAP by 8px between the two icons;
// that is empty padding on both sides, only the hovered one paints, and the later one (Close) takes the
// pointer there — the 36px squares stay because they are the touch target on a phone.
const OPEN_TRIM = "-mx-[11.25px]"
const CLOSE_TRIM = "-mx-[12.75px]"
// Every glyph in the viewer's chrome draws with one PAINTED pen. Lucide scales its stroke with the icon,
// so at a shared `strokeWidth={2}` the 18px close glyph painted 1.5px against the 16px open glyph's
// 1.33px and read as the heavier of the pair; `absoluteStrokeWidth` pins the painted width instead.
const VIEWER_PEN = 1.5

function ViewerButton({ label, trim, onClick, children }: { label: string; trim: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`flex h-9 w-9 items-center justify-center rounded-md text-white/70 outline-none transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-1 focus-visible:ring-white/60 ${trim}`}
    >
      {children}
    </button>
  )
}

// The side arrows are for a mouse. On a touch screen the picture fills the width, so they would sit on
// top of it, and a swipe already pages (the stage's pointer handlers) — so a coarse pointer drops them.
function PageButton({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight
  return (
    <button
      type="button"
      data-lightbox-page={side}
      aria-label={side === "left" ? "Previous image" : "Next image"}
      onClick={onClick}
      className={`absolute top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white/80 outline-none backdrop-blur-sm transition-colors hover:bg-white/20 hover:text-white focus-visible:ring-1 focus-visible:ring-white/60 pointer-coarse:hidden ${
        side === "left" ? "left-3" : "right-3"
      }`}
    >
      <Icon size={20} strokeWidth={VIEWER_PEN} absoluteStrokeWidth />
    </button>
  )
}
