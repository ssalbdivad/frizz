/**
 * Where the queue's scrollspy reads (AllQueues.tsx useScrollspy), in viewport px from the top.
 *
 * A third of the way down, until the page nears its bottom. A fixed line there meant the last card or
 * two — which the page cannot scroll high enough to cross it — could never be the one being read:
 * scrolled all the way down, the rail still marked the card ABOVE the one filling the screen (maintainer
 * 2026-09-30). So over the last two-thirds of a viewport of scroll the line slides down to the bottom
 * edge, and at the bottom it sits past every card, which reads the last one. A page shorter than that
 * slides over whatever scroll it has; a page that does not scroll keeps the line where it was, so its
 * first card stays the one being read.
 */
export function readingLine(viewport: number, scrollY: number, scrollHeight: number): number {
  const rest = viewport / 3
  const slide = Math.min(viewport - rest, scrollHeight - viewport)
  if (slide <= 0) return rest
  const remaining = Math.max(0, scrollHeight - viewport - scrollY)
  return rest + (viewport - rest) * Math.max(0, 1 - remaining / slide)
}
