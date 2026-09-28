// THE THREADS, TWISTED INTO ONE CORD — the gutter between the rail and the cards on the cross-project
// page. A faint two-strand cord runs down it beside the rail's thread rows, twisted once at every row, so
// its strands cross level with each row (lib/threadConnector.ts `twist`). It says what a row IS — one
// thread of the machine's work, twisted in with every other — before anything says what state it is in,
// and it stays faint enough to read as texture rather than as a rule. A plain weave was tried first, a
// stub out of every row across strands running down the gutter: it read as a ruler and its ticks.
//
// ONE thread leaves the cord: the row the rail marks (the card being read, AllQueues.tsx useScrollspy).
// The cord glints in the accent the rail's scroll marker wears for a twist either side of that row's
// crossing, and the thread runs out of the crossing, across the gutter to its card, where it ends in a
// knot on the card's left border and lights a short stretch of that border either side — the seam it is
// sewn into. While the pointer rests on another thread row that has a card, the glint slides along the
// cord to that row and the thread follows it out to ITS card — off the top or bottom of the window when
// the card is scrolled away, which says where it went.
//
// Where it lands is `landing`: level with the row whenever the card reaches that height, so the usual
// reading is one flat stroke. The rail is sticky and the cards scroll, so the knot slides down the
// card's edge as the card passes the row, and the stroke bends only once the card has gone by.
//
// One fixed SVG under the lane headers (z-10), which cover the card too, and under the drawers' scrim.
// It is moved imperatively, not rendered: it has to stay glued to the card on every scroll frame, and a
// React render per frame for a hairline would be the most expensive pixel on the page.
import { useEffect, useRef } from "react"
import { OFFSCREEN, landing, snapToPixels, threadPath, twist, type ThreadGeometry } from "../lib/threadConnector.ts"

/** Past the row's box, whose own 6px right padding already clears the rest time. */
const START_GAP = 1
/** The cord's centre, past where a row's box ends, and how far each strand bows out either side of it. */
const CORD_OFFSET = 6
const CORD_REACH = 3.5
/** How far the cord runs past the first and last rows, fading out over that stretch. */
const CORD_TAIL = 18
/** The longest twist between two crossings: about one row, which is what most of them are. */
const CORD_LINK = 30
/** Half the length of the lit stretch of the card's border, which fades out to either end. */
const SEAM = 56
/** Half the length of the lit stretch of the cord where the thread leaves it: a twist either side. */
const GLINT = 26
/** The card's corner (BLOCK_RADIUS): the seam stops where the border starts to curve. */
const CORNER = 12
/** Sliding from one row to another, and the stroke drawing itself out of the cord. */
const SLIDE_MS = 240
const DRAW_MS = 320

// A ROW'S LINE, IN ITS INK. The cord crosses just past the row's rest time, so the crossing — and the
// thread leaving it — sits on the middle of those digits — not on the middle of the 19px line box, 0.5px lower (sans: Chrome floors the
// half-leading). A row with no rest time takes its title's lowercase instead, which sits at the same
// height in sans. Read once per row off a baseline probe on the FIRST line (a wrapped title's last line
// would be a line too low) and kept as an offset from the row's top: the row moves when the rail
// scrolls, its text does not move within it.
let inkOffsets = new WeakMap<Element, number>()
let context: CanvasRenderingContext2D | null = null
function rowInk(row: HTMLElement): number {
  const top = row.getBoundingClientRect().top
  let offset = inkOffsets.get(row)
  if (offset === undefined) {
    offset = inkMiddle(row) - top
    inkOffsets.set(row, offset)
  }
  return top + offset
}
function inkMiddle(row: HTMLElement): number {
  const digits = row.querySelector<HTMLElement>("time, .tabular-nums")
  const text = digits ?? row.querySelector<HTMLElement>("button span.break-words, button .font-mono-keep")
  // AllQueues.tsx ROW_BUTTON_CLASS: pt-1, then a 19px first line.
  if (!text) return row.getBoundingClientRect().top + 4 + 9.5
  const probe = document.createElement("span")
  probe.style.cssText = "display:inline-block;width:0;height:0;margin:0;padding:0;border:0"
  text.insertBefore(probe, text.firstChild)
  const baseline = probe.getBoundingClientRect().bottom
  probe.remove()
  const style = getComputedStyle(text)
  context ??= document.createElement("canvas").getContext("2d")
  if (!context) return baseline - parseFloat(style.fontSize) * 0.36
  context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  return baseline - context.measureText(digits ? "0" : "x").actualBoundingBoxAscent / 2
}

interface Rail {
  /** Every thread row, in order, and whether it shows inside the rail's own scrolling list. */
  rows: { y: number; key: string | undefined; visible: boolean }[]
  /** The cord's centre line, where its strands cross at every row. */
  x: number
  /** The rail's own scrolling list, which the cord is cut to. */
  box: DOMRect
}

/**
 * The rail's thread rows and the cord laid off their right edge. Rows scrolled out of the list count
 * too: the cord runs on past the list's edge and is cut there, as the rows are, rather than fading out
 * as though the list ended where it was scrolled to.
 */
function readRail(dpr: number): Rail | null {
  const list = document.querySelector<HTMLElement>("[data-xq-rail]")
  if (!list) return null
  const box = list.getBoundingClientRect()
  const rows: Rail["rows"] = []
  let right = -Infinity
  for (const row of list.querySelectorAll<HTMLElement>("[data-xq-thread-row]")) {
    const y = snapToPixels(rowInk(row), dpr)
    right = Math.max(right, row.getBoundingClientRect().right)
    rows.push({ y, key: row.dataset.xqRailRow, visible: y >= box.top && y <= box.bottom })
  }
  if (rows.length === 0) return null
  return { rows, x: snapToPixels(right + START_GAP + CORD_OFFSET, dpr), box }
}

function measure(key: string, rail: Rail, dpr: number): ThreadGeometry | null {
  const row = rail.rows.find((r) => r.key === key && r.visible)
  const slot = document.querySelector<HTMLElement>(`[data-xq-card="${CSS.escape(key)}"]`)
  const card = slot?.querySelector<HTMLElement>(".frizz-card-body")
  if (!row || !slot || !card || slot.dataset.queueLeaving === "true") return null
  const x1 = rail.x
  const y1 = row.y
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

/** Write an attribute only when it changed: most frames move the thread and leave the cord alone. */
function set(el: Element, name: string, value: string) {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value)
}

export function ThreadConnector({ activeKey }: { activeKey: string | null }) {
  const svgRef = useRef<SVGSVGElement>(null)
  const strandRefs = [useRef<SVGPathElement>(null), useRef<SVGPathElement>(null)] as const
  const cordFadeRef = useRef<SVGLinearGradientElement>(null)
  const cordMaskRef = useRef<SVGRectElement>(null)
  const glintRefs = [useRef<SVGPathElement>(null), useRef<SVGPathElement>(null)] as const
  const glintFadeRef = useRef<SVGLinearGradientElement>(null)
  const pathRef = useRef<SVGPathElement>(null)
  const knotRef = useRef<SVGCircleElement>(null)
  const seamRef = useRef<SVGRectElement>(null)
  const seamGradientRef = useRef<SVGLinearGradientElement>(null)
  const active = useRef(activeKey)
  active.current = activeKey
  const scheduleRef = useRef<() => void>(() => {})

  useEffect(() => {
    const svg = svgRef.current
    const [strandA, strandB, cordFade, cordMask] = [strandRefs[0].current, strandRefs[1].current, cordFadeRef.current, cordMaskRef.current]
    const [glintA, glintB, glintFade] = [glintRefs[0].current, glintRefs[1].current, glintFadeRef.current]
    const [path, knot, seam, seamGradient] = [pathRef.current, knotRef.current, seamRef.current, seamGradientRef.current]
    if (!svg || !strandA || !strandB || !cordFade || !cordMask || !glintA || !glintB || !glintFade) return
    if (!path || !knot || !seam || !seamGradient) return
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")
    let frame = 0
    let hovered: string | null = null
    // What is on screen, and for which thread: where a slide starts when the thread changes.
    let drawn: ThreadGeometry | null = null
    let drawnKey: string | null = null
    let slide: { from: ThreadGeometry; start: number } | null = null

    const render = (now: number) => {
      frame = 0
      const dpr = window.devicePixelRatio || 1
      const rail = readRail(dpr)
      const key = hovered ?? active.current
      const target = rail && key ? measure(key, rail, dpr) : null

      // The cord: always there while the rail has thread rows, whether or not a thread leaves it. One mask
      // cuts it and its glint to the rail's list and fades both out over the tails.
      if (rail) {
        const ys = rail.rows.map((r) => r.y)
        const [a, b] = twist(ys, rail.x, CORD_REACH, CORD_TAIL, CORD_LINK)
        set(strandA, "d", a)
        set(strandB, "d", b)
        set(glintA, "d", a)
        set(glintB, "d", b)
        const top = ys[0]! - CORD_TAIL
        const length = ys[ys.length - 1]! + CORD_TAIL - top
        set(cordFade, "y1", String(top))
        set(cordFade, "y2", String(top + length))
        const stops = cordFade.querySelectorAll("stop")
        set(stops[1]!, "offset", String(Math.min(0.5, CORD_TAIL / length)))
        set(stops[2]!, "offset", String(1 - Math.min(0.5, CORD_TAIL / length)))
        set(cordMask, "y", String(rail.box.top))
        set(cordMask, "height", String(rail.box.height))
      } else {
        for (const strand of [strandA, strandB, glintA, glintB]) set(strand, "d", "")
      }

      if (!target) {
        set(svg, "data-shown", "false")
        drawn = null
        drawnKey = null
        slide = null
        return
      }
      if (key !== drawnKey) {
        // From another thread it SLIDES; from nothing it DRAWS itself out of the cord, and the knot and
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
      set(glintFade, "y1", String(g.y1 - GLINT))
      set(glintFade, "y2", String(g.y1 + GLINT))
      set(path, "d", threadPath(g))
      set(knot, "cx", String(g.x2))
      set(knot, "cy", String(g.y2))
      const edge = g.edge
      set(knot, "visibility", edge ? "visible" : "hidden")
      set(seam, "visibility", edge ? "visible" : "hidden")
      if (edge) {
        // Cut to the straight run of the border, so it never draws past a rounded corner; the gradient
        // stays centred on the knot, so a cut seam just fades less on that side.
        const top = Math.max(g.y2 - SEAM, edge[0])
        set(seam, "x", String(g.x2 - 0.5))
        set(seam, "y", String(top))
        set(seam, "height", String(Math.max(0, Math.min(g.y2 + SEAM, edge[1]) - top)))
        set(seamGradient, "y1", String(g.y2 - SEAM))
        set(seamGradient, "y2", String(g.y2 + SEAM))
      }
      set(svg, "data-shown", "true")
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
    // Capture, so the rail's own scrolling list moves the cord too, not only the page.
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
        <linearGradient ref={cordFadeRef} id="frizz-thread-cord-fade" gradientUnits="userSpaceOnUse" x1="0" x2="0">
          <stop offset="0" stopColor="white" stopOpacity={0} />
          <stop offset="0.05" stopColor="white" />
          <stop offset="0.95" stopColor="white" />
          <stop offset="1" stopColor="white" stopOpacity={0} />
        </linearGradient>
        <mask id="frizz-thread-cord" maskUnits="userSpaceOnUse" x={-1e4} y={-1e4} width={2e4} height={2e4}>
          <rect ref={cordMaskRef} x={-1e4} width={2e4} fill="url(#frizz-thread-cord-fade)" />
        </mask>
        <linearGradient ref={glintFadeRef} id="frizz-thread-glint" gradientUnits="userSpaceOnUse" x1="0" x2="0">
          <stop offset="0" className="[stop-color:var(--color-accent)] [stop-opacity:0]" />
          <stop offset="0.5" className="[stop-color:var(--color-accent)] [stop-opacity:0.6]" />
          <stop offset="1" className="[stop-color:var(--color-accent)] [stop-opacity:0]" />
        </linearGradient>
        <linearGradient ref={seamGradientRef} id="frizz-thread-seam" gradientUnits="userSpaceOnUse" x1="0" x2="0">
          <stop offset="0" className="[stop-color:var(--color-accent)] [stop-opacity:0]" />
          <stop offset="0.5" className="[stop-color:var(--color-accent)] [stop-opacity:0.7]" />
          <stop offset="1" className="[stop-color:var(--color-accent)] [stop-opacity:0]" />
        </linearGradient>
      </defs>
      <g data-thread-cord fill="none" strokeWidth={1} mask="url(#frizz-thread-cord)">
        <g className="stroke-fg opacity-20">
          <path ref={strandRefs[0]} />
          <path ref={strandRefs[1]} />
        </g>
        <g stroke="url(#frizz-thread-glint)" className="opacity-0 transition-opacity duration-150 group-data-[shown=true]/thread:opacity-100">
          <path ref={glintRefs[0]} />
          <path ref={glintRefs[1]} />
        </g>
      </g>
      <g className="opacity-0 transition-opacity duration-150 group-data-[shown=true]/thread:opacity-100">
        <rect ref={seamRef} width={1} fill="url(#frizz-thread-seam)" />
        <path ref={pathRef} pathLength={1} strokeDasharray="1 1" fill="none" strokeWidth={1} strokeLinecap="round" className="stroke-accent/55" />
        <circle ref={knotRef} r={2.25} className="fill-accent [transform-box:fill-box] [transform-origin:center]" />
      </g>
    </svg>
  )
}
