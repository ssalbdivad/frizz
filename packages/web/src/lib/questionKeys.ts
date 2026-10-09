// NUMBER KEYS ANSWER THE QUESTION IN FRONT OF YOU (requested 2026-10-07: options are numbered rather than
// lettered so the identifier on screen is the key that picks it). Every interactive QuestionBlockCard
// registers its options grid here; ONE window listener routes a bare 1–9 to the right grid. The card
// draws each option's number as a keycap, so the key on screen is the key that picks it.
//
// A DIGIT NEVER STAGES A PICK THE OPERATOR CANNOT SEE. Every route below ends at the same gate: the row
// the key names (option n, or the free-text row one past the last option) must be on screen and
// UNCOVERED, judged by a hit test at that row rather than by its box — so a row scrolled off the page,
// clipped by its drawer's scroller, under a card's sticky header or behind a scrim fails it. A key that
// fails it does nothing and is left to the page. (Until 2026-10-08 the unfocused fallback took the first
// card with ANY pixel of ANY grid on screen and then that card's first unanswered question wherever it
// was: scrolled so the next card filled the view, `2` staged an answer on a question scrolled away above.)
//
// WHICH QUESTION a digit answers, in order:
//   1. a text box has the caret ⇒ none. A digit typed into a composer or a "Something else…" box is a
//      digit. Escape in a composer hands the keyboard to its thread's question (`focusQuestionFrom`),
//      so "Esc, 2" answers without the mouse.
//   2. the grid holding focus (after a chip click, a keyboard pick, or a Tab onto a chip).
//   3. the topmost open dialog — the thread drawer. A dialog with no question (Settings, the ⌘K palette,
//      a popover) swallows the key: nothing behind an overlay is answered blind. An overlay counts when
//      it is `[role="dialog"]` and either Radix-open (`data-state="open"`) or `aria-modal` — SettingsDrawer
//      and CommandPalette are plain divs that carry both by hand for exactly this.
//   4. the queue card holding focus.
//   5. nothing focused: the first card with a question in view. (Upstream picks the card its queue rail
//      marks; this fork opens every thread in a drawer and has no queue-card column or scrollspy.)
// Within that surface: its first UNANSWERED question that is in view, else its first in view. A
// single-select pick then moves focus to the next unanswered question, so a rest that asks three things
// is answered with three keys.
//
// Grids register by ELEMENT rather than by id: the same thread's question can be mounted twice (a queue
// card under an open drawer of the same thread), and only the copy on the surface in front counts.

export type QuestionKeyResult = "picked" | "toggled" | "text" | false

export interface QuestionKeyTarget {
  /** Act on 1-based key `n`: pick (single), toggle (multi), or focus the free-text row. False when the
   *  key names nothing on this question. */
  press: (n: number) => QuestionKeyResult
  /** Has this question a staged answer? Read at call time, so it sees the latest render. */
  answered: () => boolean
  /** Does it offer options at all? A free-text-only question has nothing a digit can pick, so the
   *  router passes over it rather than parking the keyboard where every key is dead. */
  keyed: () => boolean
  /** The row key `n` acts on — option n's chip, or the free-text row for the key one past the last
   *  option — so the router can check the operator can see it. Null when the key names nothing. */
  row: (n: number) => HTMLElement | null
}

const targets = new Map<HTMLElement, QuestionKeyTarget>()
let listening = false

export function registerQuestionKeys(grid: HTMLElement, target: QuestionKeyTarget): () => void {
  targets.set(grid, target)
  if (!listening && typeof window !== "undefined") {
    window.addEventListener("keydown", onKey)
    listening = true
  }
  return () => {
    if (targets.get(grid) === target) targets.delete(grid)
  }
}

const OPEN_DIALOG = '[role="dialog"][data-state="open"], [role="dialog"][aria-modal="true"]'
const QUEUE_CARD = "[data-queue-card-root]"

// Keys that belong to whatever has focus: text entry, an open menu or listbox (Radix typeahead), the
// terminal. A focused BUTTON is not one of these — a sidebar row keeps focus after its click, and the
// question in the drawer it opened must still take the key.
function ownsKeys(el: Element): boolean {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true
  if (el instanceof HTMLInputElement) return !["button", "checkbox", "radio", "submit", "reset"].includes(el.type)
  if (el instanceof HTMLElement && el.isContentEditable) return true
  return !!el.closest('.xterm, [role="menu"], [role="listbox"], [role="menubar"], [role="combobox"]')
}

function inDomOrder(els: HTMLElement[]): HTMLElement[] {
  return els.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
}

/** Registered grids that are mounted, laid out and offer options, in document order. */
function liveGrids(): HTMLElement[] {
  return inDomOrder([...targets.keys()].filter((el) => el.isConnected && el.getClientRects().length > 0 && targets.get(el)?.keyed()))
}

// Can the operator SEE this element? Hit-tested rather than read off its box, because a box on screen
// can still be hidden: under a card's sticky header, outside its drawer's scroller, behind a scrim. Three
// points down the middle of the part inside the viewport; any one landing on the element (or inside it)
// is enough, so a row half under a sticky header still counts by its uncovered half.
function seen(el: HTMLElement | null): boolean {
  if (!el?.isConnected) return false
  const r = el.getBoundingClientRect()
  const top = Math.max(r.top, 0)
  const bottom = Math.min(r.bottom, window.innerHeight)
  const left = Math.max(r.left, 0)
  const right = Math.min(r.right, window.innerWidth)
  if (bottom <= top || right <= left) return false
  const x = (left + right) / 2
  return [0.25, 0.5, 0.75].some((f) => {
    const hit = document.elementFromPoint(x, top + (bottom - top) * f)
    return !!hit && el.contains(hit)
  })
}

/** A question is in view when the operator can see at least one of its keyed rows. */
function inView(grid: HTMLElement): boolean {
  const target = targets.get(grid)
  if (!target) return false
  for (let n = 1; n <= 9; n++) {
    const row = target.row(n)
    if (!row) break
    if (seen(row)) return true
  }
  return false
}

/** The surface a grid answers on — the scope "next unanswered question" walks. */
function surfaceOf(grid: HTMLElement): Element {
  return grid.closest(OPEN_DIALOG) ?? grid.closest(QUEUE_CARD) ?? document.body
}

function preferred(grids: HTMLElement[]): HTMLElement | null {
  return grids.find((g) => !targets.get(g)?.answered()) ?? grids[0] ?? null
}

function gridFor(from: Element | null): HTMLElement | null {
  const own = from?.closest<HTMLElement>("[data-question-grid]")
  if (own && targets.has(own)) return own
  // Only a question the operator can see is a candidate from here on; the row the key names is checked
  // again by the caller.
  const live = liveGrids().filter(inView)
  const dialogs = document.querySelectorAll(OPEN_DIALOG)
  const top = dialogs[dialogs.length - 1]
  if (top) return preferred(live.filter((g) => top.contains(g)))
  const card = from?.closest(QUEUE_CARD)
  if (card) return preferred(live.filter((g) => card.contains(g)))
  const first = live[0]
  return first ? preferred(live.filter((g) => surfaceOf(g) === surfaceOf(first))) : null
}

// Hand the keyboard to a grid and bring it on screen. INSTANT, not smooth: the next digit is checked
// against what is on screen, and a key pressed while a smooth scroll is still carrying the next question
// in would find its row below the fold and do nothing.
function park(grid: HTMLElement) {
  grid.focus({ preventScroll: true })
  grid.scrollIntoView({ block: "nearest", behavior: "instant" })
}

function onKey(e: KeyboardEvent) {
  // A HELD key auto-repeats: on a single-select each repeat would pick on the question the last pick
  // just moved to, staging the same option down the whole rest. One press is one answer.
  if (e.defaultPrevented || e.repeat || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return
  if (!/^[1-9]$/.test(e.key)) return
  const from = e.target instanceof Element ? e.target : null
  if (from && ownsKeys(from)) return
  const grid = gridFor(from)
  const target = grid && targets.get(grid)
  if (!grid || !target) return
  const n = Number(e.key)
  // The one gate every route ends at: the row this key names must be in front of the operator.
  if (!seen(target.row(n))) return
  const result = target.press(n)
  if (!result) return
  e.preventDefault()
  if (result === "text") return
  if (result === "toggled") return park(grid)
  // After the render that staged the pick (and mounted any follow-up it opened), move on to the next
  // question still waiting on this surface; with none left, rest on this one so Enter sends.
  requestAnimationFrame(() => {
    const surface = surfaceOf(grid)
    const after = liveGrids().filter((g) => surfaceOf(g) === surface && (grid.compareDocumentPosition(g) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0)
    const next = after.find((g) => !targets.get(g)?.answered())
    park(next ?? (grid.isConnected ? grid : after[0] ?? grid))
  })
}

/** Escape in a composer: hand the keyboard to the question on the composer's own surface (its drawer or
 *  queue card), so the next digit answers it. False when that surface asks nothing — the caller blurs. */
export function focusQuestionFrom(el: Element): boolean {
  const surface = el.closest(OPEN_DIALOG) ?? el.closest(QUEUE_CARD)
  if (!surface) return false
  const grid = preferred(liveGrids().filter((g) => surface.contains(g)))
  if (!grid) return false
  park(grid)
  return true
}
