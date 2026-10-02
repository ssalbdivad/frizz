// THE QUEUE BUILDS AND LAYS OUT ONLY THE CARDS NEAR THE SCREEN. Every card keeps its slot in the DOM, at its
// place and its height — `j`/`k`, the rail's scroll-to, the viewport lock (lib/viewportLock.ts), the ghost
// gap and the scrollspy all read slots, and every slot is there — but what is INSIDE a slot is paid for only
// near the screen:
//
//   1. A card far from the screen is not BUILT until it is needed: its slot holds a stand-in of the guessed
//      height (AllQueuesCard.tsx CardStandIn), and the card proper — its queries, its markdown, its reply
//      box — mounts the moment the slot comes within a viewport of the screen, or earlier, a card at a time
//      in idle time (`step`, below), so a page left alone ends up with every card built and find-in-page
//      reaching every word.
//   2. A built card far from the screen is SKIPPED by the browser: `content-visibility: auto` (styles.css
//      `.frizz-card-slot`) — no style, layout or paint — and sized from the height it had the last time it
//      was drawn (`contain-intrinsic-size: auto`).
//
// WHY: with hundreds of cards the page was bound by building them and laying them out. Measured 2026-10-02
// on a 244-card mirror of the maintainer's machine, prod build, a loaded 16-core WSL box: a cold load spent
// 7s in ONE task mounting all 244 cards (React render + commit, 244 handoff fetches started from inside it),
// and a 15s trace of load + settle spent 4.9s in Layout and 2.6s in PrePaint, every forced layout — a
// composer snapping its height, a clamp checking its overflow — laying out all 244 cards.
//
// WHY NOT `content-visibility: auto` ON EVERY CARD, ALWAYS. It brings layout, style and PAINT containment
// with it even while the card is on screen, and paint containment clips everything a card draws outside
// its own box: its `shadow-lg`, the arrival ring's outline 2px outside the border (styles.css
// `[data-queue-flash]`), the leaving blur, and the reply box's `/` and `@` menus — which open BELOW the box
// when it sits near the top of the window and so hang past the card's bottom edge over the next one (it
// also makes each card a stacking context, so the next card would paint over that menu). So a card NEAR
// the screen — within a viewport of it — wears `data-near`, which turns content-visibility back off
// (styles.css): nothing a reader can see is ever contained. An IntersectionObserver keeps that mark
// current as the page scrolls.
//
// WHY NOT TRUE WINDOWING (unmounting what scrolls away, as @tanstack/react-virtual does). A card the reader
// has passed keeps its draft caret, its open "Show more", its focus, and its words for find-in-page; and the
// viewport lock, the ghost gap and the leaving fade all hold a card's slot at its real height. A card once
// built stays built, and content-visibility makes a built card that is off screen cost nothing to keep.
//
// A SKIPPED CARD STILL ANSWERS LAYOUT QUERIES — reading `scrollHeight` inside one makes the browser lay it
// out on the spot — so correctness never depends on any of this. Cost does: a composer snapping its
// height or a clamp measuring its body would force each far card's layout one at a time, which is the cost
// this exists to avoid. Those measurements wait for their card (`whenCardRendered`), and run before the
// frame in which the card is first drawn.
//
// AND EVERY CARD IS DRAWN ONCE, IN IDLE TIME (`step`). A card never drawn is sized from a 540px guess (the
// median card on that mirror: p10 315, p90 793), and a guess is wrong by hundreds of px either way. Left
// wrong, a glide to a far card (a rail click) would land and then snap by the sum of every guess it passed,
// the scrollbar would jitter as cards resolve, and scrolling UP through cards never seen would keep the
// viewport lock correcting for cards growing above the reader. So after load the far cards are built and
// drawn a card at a time — off screen, with their measurements — and kept for a couple of frames, long
// enough for `contain-intrinsic-size: auto` to remember their real height. From then on every skipped card
// is the height it really is, and nothing on the page can tell it is skipped.
import { flushSync } from "react-dom"

/** The card slot (AllQueuesCard.tsx). */
const SLOT = ".frizz-card-slot"
/** Set on a slot near the screen, where content-visibility is off (styles.css). Never rendered by React. */
const NEAR = "data-near"
/** How far past the top and bottom of the window a card counts as near. */
const MARGIN = "100% 0px"
/**
 * How long one idle step may keep working before it hands the thread back. Building a card costs 10–30ms
 * on the loaded mirror box and drawing one ~1–10ms, so a step builds ONE card, or draws several built ones.
 */
const STEP_BUDGET_MS = 8
/** How long a step may wait for an idle moment before running anyway, so a busy page still gets there. */
const STEP_IDLE_TIMEOUT_MS = 1_000

const noop = () => {}
const waiters = new Map<HTMLElement, Set<() => void>>()
/** Each unbuilt slot's builder (its card's state setter); gone once the card is built. */
const builders = new Map<HTMLElement, () => void>()
/** Whether the observer last saw each slot within the margin. */
const inMargin = new WeakMap<HTMLElement, boolean>()
/** Slots mounted since the last placement (below). */
const unplaced = new Set<HTMLElement>()
/** Slots whose card has not been drawn as it is now, so sized by the guess or a stale height. */
const unprimed = new Set<HTMLElement>()
/** Slots drawn by `step` or `drawCardNow`, kept near until their height is remembered. */
const priming = new Set<HTMLElement>()
/** When each near slot's structure last changed (performance.now()), for `letGo`. */
const touched = new WeakMap<HTMLElement, number>()
/** Slots on their way to being skipped (`letGo`). */
const letting = new Set<HTMLElement>()
let observer: IntersectionObserver | null = null
let stepScheduled = false

// A SKIPPED CARD THAT CHANGES is re-drawn in idle time too. Its height was remembered as it last drew, and
// content that arrives while it is skipped — above all its handoff, which each card fetches after it is
// built and which is often still loading when it is first drawn (a 315px preview remembered for a card
// that clamps at ~600px) — is laid out by nobody. Structure only: a ticking "2m ago" changes text, not
// height, and would re-draw every card every minute. A card near the screen is laid out live already, but
// the time of its change is noted: a frame has to draw it before the card may be skipped (`letGo`).
let mutations: MutationObserver | null = null
function ensureMutations(): MutationObserver {
  mutations ??= new MutationObserver((records) => {
    let changed = false
    for (const record of records) {
      const target = record.target instanceof Element ? record.target : record.target.parentElement
      const slot = target?.closest<HTMLElement>(SLOT)
      if (!slot || !slot.isConnected) continue
      if (slot.hasAttribute(NEAR)) {
        touched.set(slot, performance.now())
        continue
      }
      if (unprimed.has(slot)) continue
      unprimed.add(slot)
      changed = true
    }
    if (changed) scheduleStep()
  })
  return mutations
}

/** Build the slot's card now, synchronously, if it is not built yet. Never called during React's own render
 *  or commit: from a microtask after it, an observer callback, an idle callback, or an event handler. */
function build(slot: HTMLElement): void {
  const builder = builders.get(slot)
  if (!builder) return
  builders.delete(slot)
  flushSync(builder)
}

function markNear(slot: HTMLElement): void {
  unprimed.delete(slot)
  if (!slot.hasAttribute(NEAR)) slot.setAttribute(NEAR, "")
  // Built with the mark already on, so the card's measurements run as it mounts (whenCardRendered).
  build(slot)
  const waiting = waiters.get(slot)
  if (!waiting) return
  waiters.delete(slot)
  for (const fn of waiting) fn()
}

// LET A CARD BE SKIPPED only once a frame has drawn it as it is now: `contain-intrinsic-size: auto`
// remembers the height a FRAME last laid out, not the one the DOM has. Measured 2026-10-02 on the 60-card
// fixture: a card's handoff landed 5ms before its idle draw ended, the card was skipped before any frame
// laid the handoff out, and it sat at 259px — its height without the handoff — against a real 621px, for
// good, since a change made while a card is near is nobody's to re-draw. So the mark comes off in an
// animation frame, and only if the card has not changed since the frame before it began: that frame drew
// everything done before it. Changed since, it waits for the next frame and asks again.
function letGo(slot: HTMLElement): void {
  if (priming.has(slot) || letting.has(slot) || !slot.hasAttribute(NEAR)) return
  letting.add(slot)
  let drawnFrom = Infinity
  const check = () => {
    const now = performance.now()
    // Wanted near again meanwhile (scrolled back, or drawn by a step), or gone.
    if (!slot.isConnected || priming.has(slot) || inMargin.get(slot) === true) {
      letting.delete(slot)
      return
    }
    if ((touched.get(slot) ?? -Infinity) < drawnFrom) {
      letting.delete(slot)
      slot.removeAttribute(NEAR)
      return
    }
    drawnFrom = now
    requestAnimationFrame(check)
  }
  requestAnimationFrame(() => {
    drawnFrom = performance.now()
    requestAnimationFrame(check)
  })
}

function ensureObserver(): IntersectionObserver {
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const slot = entry.target as HTMLElement
      inMargin.set(slot, entry.isIntersecting)
      if (entry.isIntersecting) markNear(slot)
      else letGo(slot)
    }
  }, { rootMargin: MARGIN })
  return observer
}

// PLACEMENT, before the first paint of a newly mounted slot. The observer's first report is delivered
// after a frame has painted, so a card mounted on screen would be painted once as its stand-in (and a built
// one contained, its shadow cut off, its composer and clamp unmeasured) and corrected the frame after. So
// the slots a commit mounted are placed in a microtask — after React's commit, still before paint — from
// one read of their boxes: one layout, and a cheap one, since every unplaced slot is a stand-in or skipped.
// The near ones are built there and then (`build`, synchronously), so the first frame shows real cards.
function place(): void {
  const slots = [...unplaced].filter((slot) => slot.isConnected)
  unplaced.clear()
  const viewport = window.innerHeight
  const near = slots.filter((slot) => {
    const rect = slot.getBoundingClientRect()
    return rect.bottom > -viewport && rect.top < viewport * 2
  })
  for (const slot of near) markNear(slot)
  scheduleStep()
}

/**
 * The slot's ref (React 19 ref callback, so it returns its own cleanup): registers a card slot with the
 * observer and places it before its first paint. `build` is how the card is told to mount its content —
 * omitted for a slot whose content is always built.
 */
export function observeCardSlot(slot: HTMLElement | null, buildCard?: () => void): (() => void) | undefined {
  if (!slot) return undefined
  if (unplaced.size === 0) queueMicrotask(place)
  unplaced.add(slot)
  unprimed.add(slot)
  if (buildCard) builders.set(slot, buildCard)
  ensureObserver().observe(slot)
  // Disconnected with the slot: a node's registrations go with the node.
  ensureMutations().observe(slot, { childList: true, subtree: true })
  return () => {
    observer?.unobserve(slot)
    unplaced.delete(slot)
    unprimed.delete(slot)
    priming.delete(slot)
    letting.delete(slot)
    waiters.delete(slot)
    builders.delete(slot)
  }
}

/** Whether `el` sits in a card the browser is currently skipping (or about to: not yet placed). */
export function inSkippedCard(el: Element): boolean {
  const slot = el.closest<HTMLElement>(SLOT)
  return slot !== null && !slot.hasAttribute(NEAR)
}

/**
 * Run `fn` once `el`'s card is drawn — now, if it is near the screen or is not in a card at all (a drawer's
 * composer). For a measurement that would otherwise force a skipped card's layout. Returns a cancel.
 */
export function whenCardRendered(el: Element, fn: () => void): () => void {
  const slot = el.closest<HTMLElement>(SLOT)
  if (!slot || slot.hasAttribute(NEAR)) {
    fn()
    return noop
  }
  const once = () => fn()
  let set = waiters.get(slot)
  if (!set) waiters.set(slot, (set = new Set()))
  set.add(once)
  return () => {
    const current = waiters.get(slot)
    current?.delete(once)
    if (current?.size === 0) waiters.delete(slot)
  }
}

/**
 * Build and draw a card NOW, wherever it is — for a move that is about to take the reader to it (a rail
 * row, `j`/`k`): what lands must be the card, with its root to ring and its real height, not a stand-in.
 * Held near for a couple of frames like a primed card, then handed back to the observer.
 */
export function drawCardNow(slot: HTMLElement): void {
  priming.add(slot)
  markNear(slot)
  releaseAfterDraw([slot])
}

// Two frames and a task: the first frame lays the cards out, React commits whatever a measurement set (a
// clamp turning on is a state update), and the second frame lays THAT out, which is the height
// `contain-intrinsic-size: auto` must remember. Then any the reader is not near go back to the observer,
// through `letGo`, which holds one still changing (a handoff landing) until a frame has drawn it.
function releaseAfterDraw(slots: HTMLElement[]): void {
  requestAnimationFrame(() => window.setTimeout(() => requestAnimationFrame(() => window.setTimeout(() => {
    for (const slot of slots) {
      priming.delete(slot)
      if (slot.isConnected && inMargin.get(slot) !== true) letGo(slot)
    }
  }, 0)), 0))
}

const idle = (fn: () => void) =>
  typeof requestIdleCallback === "function" ? requestIdleCallback(fn, { timeout: STEP_IDLE_TIMEOUT_MS }) : window.setTimeout(fn, 50)

function scheduleStep(): void {
  if (stepScheduled || unprimed.size === 0) return
  stepScheduled = true
  idle(step)
}

// One idle step: build and draw the next cards down the page — at least one, and more while the step is
// within its budget — and hold them drawn until their heights are remembered. The next step is asked for
// at once rather than after that hold, so the page is built as fast as it is idle. (An unbuilt slot is
// always unprimed too: a slot is both from the moment it mounts, and `markNear` builds what it draws.)
function step(): void {
  stepScheduled = false
  const started = performance.now()
  const batch: HTMLElement[] = []
  for (const slot of [...unprimed]) {
    if (batch.length > 0 && performance.now() - started > STEP_BUDGET_MS) break
    if (!slot.isConnected) { unprimed.delete(slot); builders.delete(slot); continue }
    batch.push(slot)
    priming.add(slot)
    markNear(slot)
  }
  if (batch.length > 0) releaseAfterDraw(batch)
  scheduleStep()
}
