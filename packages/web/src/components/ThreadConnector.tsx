// THE THREAD — a hairline from a rail row to its card on the cross-project page, drawn across the gutter
// between the two columns, so the row and the card read as ONE thread shown in two places rather than as
// an index entry and an unrelated panel.
//
// It ties the row the rail marks (the card being read, AllQueues.tsx useScrollspy) to that card; while
// the pointer rests on another Ready row it slides over to THAT row's card, off the top or bottom of the
// window when the card is scrolled away, which says where it went. It leaves the row just past its rest
// time, in the accent the rail's scroll marker already wears, and ends in a knot on the card's left
// border, lighting a short stretch of that border either side — the seam the thread is sewn into.
//
// Where it lands is lib/threadConnector.ts `landing`: level with the row whenever the card reaches that
// height, so the usual reading is one flat stroke. The rail is sticky and the cards scroll, so the knot
// slides down the card's edge as the card passes the row, and the stroke bends only once it has gone by.
//
// One fixed SVG under the lane headers (z-10), which cover the card too, and under the drawers' scrim.
// It is moved imperatively, not rendered: it has to stay glued to the card on every scroll frame, and a
// React render per frame for a hairline would be the most expensive pixel on the page.
import { useEffect, useRef } from "react"
import { OFFSCREEN, landing, snapToPixels, threadPath, type ThreadGeometry } from "../lib/threadConnector.ts"

/** Past the row's box, whose own 6px right padding already clears the rest time. */
const START_GAP = 1
/** Half the length of the lit stretch of the card's border, which fades out to either end. */
const SEAM = 56
/** The card's corner (BLOCK_RADIUS): the seam stops where the border starts to curve. */
const CORNER = 12
/** Sliding from one row to another, and the stroke drawing itself out of the row. */
const SLIDE_MS = 240
const DRAW_MS = 320

// THE ROW'S LINE, IN ITS INK. The stroke leaves the row just past its rest time, so it sits on the middle
// of those digits — not on the middle of the 19px line box, 0.5px lower (sans: Chrome floors the
// half-leading). Read once per row off a baseline probe and kept as an offset from the row's top, since the
// row moves when the rail scrolls but its text does not move within it.
let inkOffsets = new WeakMap<Element, number>()
let context: CanvasRenderingContext2D | null = null
function rowInk(row: HTMLElement): number {
  const top = row.getBoundingClientRect().top
  let offset = inkOffsets.get(row)
  if (offset === undefined) {
    offset = digitsMiddle(row) - top
    inkOffsets.set(row, offset)
  }
  return top + offset
}
function digitsMiddle(row: HTMLElement): number {
  const text = row.querySelector<HTMLElement>("time, .tabular-nums")
  // No rest time on the row: the middle of its first line (AllQueues.tsx ROW_BUTTON_CLASS: pt-1, 19px).
  if (!text) return row.getBoundingClientRect().top + 4 + 9.5
  const probe = document.createElement("span")
  probe.style.cssText = "display:inline-block;width:0;height:0;margin:0;padding:0;border:0"
  text.appendChild(probe)
  const baseline = probe.getBoundingClientRect().bottom
  probe.remove()
  const style = getComputedStyle(text)
  context ??= document.createElement("canvas").getContext("2d")
  if (!context) return baseline - parseFloat(style.fontSize) * 0.36
  context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  return baseline - context.measureText("0").actualBoundingBoxAscent / 2
}

function measure(key: string): ThreadGeometry | null {
  const row = document.querySelector<HTMLElement>(`[data-xq-rail-row="${CSS.escape(key)}"]`)
  const slot = document.querySelector<HTMLElement>(`[data-xq-card="${CSS.escape(key)}"]`)
  const card = slot?.querySelector<HTMLElement>(".frizz-card-body")
  if (!row || !slot || !card || slot.dataset.queueLeaving === "true") return null
  const dpr = window.devicePixelRatio || 1
  const y1 = snapToPixels(rowInk(row), dpr)
  // A row scrolled out of the rail's own list has nothing to hang a stroke from.
  const list = row.closest("[data-xq-rail]")?.getBoundingClientRect()
  if (list && (y1 < list.top || y1 > list.bottom)) return null
  const x1 = row.getBoundingClientRect().right + START_GAP
  const c = card.getBoundingClientRect()
  // Centred on the card's 1px border.
  const x2 = c.left + 0.5
  if (x2 - x1 < 8) return null
  const header = slot.closest("[data-xq-lane]")?.querySelector(":scope > header")?.getBoundingClientRect().bottom ?? -Infinity
  const vh = window.innerHeight
  const at = landing(y1, c, header, vh)
  if (at === "above") return { x1, y1, x2, y2: -OFFSCREEN, edge: null }
  if (at === "below") return { x1, y1, x2, y2: vh + OFFSCREEN, edge: null }
  return { x1, y1, x2, y2: snapToPixels(at, dpr), edge: [Math.max(c.top, header) + CORNER, c.bottom - CORNER] }
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t

export function ThreadConnector({ activeKey }: { activeKey: string | null }) {
  const svgRef = useRef<SVGSVGElement>(null)
  const pathRef = useRef<SVGPathElement>(null)
  const knotRef = useRef<SVGCircleElement>(null)
  const seamRef = useRef<SVGRectElement>(null)
  const seamGradientRef = useRef<SVGLinearGradientElement>(null)
  const active = useRef(activeKey)
  active.current = activeKey
  const scheduleRef = useRef<() => void>(() => {})

  useEffect(() => {
    const svg = svgRef.current
    const path = pathRef.current
    const knot = knotRef.current
    const seam = seamRef.current
    const seamGradient = seamGradientRef.current
    if (!svg || !path || !knot || !seam || !seamGradient) return
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")
    let frame = 0
    let hovered: string | null = null
    // What is on screen, and for which thread: where a slide starts when the thread changes.
    let drawn: ThreadGeometry | null = null
    let drawnKey: string | null = null
    let slide: { from: ThreadGeometry; start: number } | null = null

    const render = (now: number) => {
      frame = 0
      const key = hovered ?? active.current
      const target = key ? measure(key) : null
      if (!target) {
        svg.dataset.shown = "false"
        drawn = null
        drawnKey = null
        slide = null
        return
      }
      if (key !== drawnKey) {
        // From another thread it SLIDES; from nothing it DRAWS itself out of the row, and the knot and
        // the seam arrive with its tip.
        if (!reduced?.matches) {
          if (drawn) slide = { from: drawn, start: now }
          else {
            const land = { delay: DRAW_MS - 120, fill: "backwards" as const }
            path.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: DRAW_MS, easing: "cubic-bezier(0.3, 0, 0, 1)" })
            knot.animate([{ transform: "scale(0)" }, { transform: "scale(1)" }], { ...land, duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1.4)" })
            seam.animate([{ opacity: 0 }, { opacity: 1 }], { ...land, duration: 240, easing: "ease-out" })
          }
        }
        drawnKey = key
      }
      let g = target
      if (slide) {
        const t = Math.min(1, (now - slide.start) / SLIDE_MS)
        const e = 1 - (1 - t) ** 3
        const from = slide.from
        g = { x1: mix(from.x1, g.x1, e), y1: mix(from.y1, g.y1, e), x2: mix(from.x2, g.x2, e), y2: mix(from.y2, g.y2, e), edge: g.edge }
        if (t >= 1) slide = null
      }
      drawn = g
      path.setAttribute("d", threadPath(g))
      knot.setAttribute("cx", String(g.x2))
      knot.setAttribute("cy", String(g.y2))
      const edge = g.edge
      knot.style.visibility = edge ? "" : "hidden"
      seam.style.visibility = edge ? "" : "hidden"
      if (edge) {
        // Cut to the straight run of the border, so it never draws past a rounded corner; the gradient
        // stays centred on the knot, so a cut seam just fades less on that side.
        const from = Math.max(g.y2 - SEAM, edge[0])
        seam.setAttribute("x", String(g.x2 - 0.5))
        seam.setAttribute("y", String(from))
        seam.setAttribute("height", String(Math.max(0, Math.min(g.y2 + SEAM, edge[1]) - from)))
        seamGradient.setAttribute("y1", String(g.y2 - SEAM))
        seamGradient.setAttribute("y2", String(g.y2 + SEAM))
      }
      svg.dataset.shown = "true"
      if (slide) schedule()
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(render)
    }
    scheduleRef.current = schedule

    const onOver = (event: PointerEvent) => {
      const row = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-xq-rail-row]") : null
      const next = row?.dataset.xqRailRow ?? null
      if (next === hovered) return
      hovered = next
      schedule()
    }
    const onLeave = () => {
      if (hovered === null) return
      hovered = null
      schedule()
    }
    const onResize = () => {
      inkOffsets = new WeakMap()
      schedule()
    }
    // Capture, so the rail's own scrolling list moves the stroke too, not only the page.
    window.addEventListener("scroll", schedule, { capture: true, passive: true })
    window.addEventListener("resize", onResize)
    document.addEventListener("pointerover", onOver)
    document.documentElement.addEventListener("pointerleave", onLeave)
    // Anything that moves either end without a scroll: a card growing ("Show more", a question answered),
    // rows coming and going, a card starting to leave.
    const resize = new ResizeObserver(schedule)
    const mutations = new MutationObserver(schedule)
    for (const el of document.querySelectorAll("#workpane, aside[aria-label='Projects']")) {
      resize.observe(el)
      mutations.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-queue-leaving"] })
    }
    schedule()
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener("scroll", schedule, { capture: true })
      window.removeEventListener("resize", onResize)
      document.removeEventListener("pointerover", onOver)
      document.documentElement.removeEventListener("pointerleave", onLeave)
      resize.disconnect()
      mutations.disconnect()
    }
  }, [])

  useEffect(() => scheduleRef.current(), [activeKey])

  return (
    <svg
      ref={svgRef}
      aria-hidden
      data-thread-connector
      data-shown="false"
      className="group/thread pointer-events-none fixed inset-0 z-[5] h-full w-full overflow-visible max-[800px]:hidden"
    >
      <defs>
        <linearGradient ref={seamGradientRef} id="frizz-thread-seam" gradientUnits="userSpaceOnUse" x1="0" x2="0">
          <stop offset="0" className="[stop-color:var(--color-accent)] [stop-opacity:0]" />
          <stop offset="0.5" className="[stop-color:var(--color-accent)] [stop-opacity:0.7]" />
          <stop offset="1" className="[stop-color:var(--color-accent)] [stop-opacity:0]" />
        </linearGradient>
      </defs>
      <g className="opacity-0 transition-opacity duration-150 group-data-[shown=true]/thread:opacity-100">
        <rect ref={seamRef} width={1} fill="url(#frizz-thread-seam)" />
        <path ref={pathRef} pathLength={1} strokeDasharray="1 1" fill="none" strokeWidth={1} strokeLinecap="round" className="stroke-accent/55" />
        <circle ref={knotRef} r={2.25} className="fill-accent [transform-box:fill-box] [transform-origin:center]" />
      </g>
    </svg>
  )
}
