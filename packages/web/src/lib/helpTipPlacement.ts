// The placement rule for a CLICKABLE help tooltip (components/Tooltip.tsx — every Settings (?) and the runtime
// settings panel's), pure so the test beside it can pin it.
const EDGE = 12
const GAP_X = 8
const GAP_Y = 6

/**
 * Where a clickable help tooltip goes, given its trigger, its own measured size and the viewport.
 *
 * BESIDE the trigger, top-aligned, when it fits there — the desktop's placement, unchanged. It used to be
 * forced there: `left = min(max(12, right + 8), innerWidth − 364)` assumed the 352px maximum always fits,
 * which at 300px is −64, so every Settings (?) in an editor's sidebar ran 64px off the frame's left edge,
 * over its own label. And `top ≤ innerHeight − 96` assumed a tooltip under 96px, so a tall one (External
 * app's, 197px) ran off the bottom: y 920 in an 820px frame, 1001 in a 900px window (2026-10-01).
 *
 * Where it does not fit beside the trigger, it goes BELOW the label's row, left-aligned to the trigger and
 * shifted to stay 12px inside — so it covers the field it explains, never the label naming it — and ABOVE
 * when the room below is short. Every placement is finally clamped into the viewport by its real size.
 */
export function placeHelpTip(
  trigger: { left: number; right: number; top: number; bottom: number },
  tip: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)))
  const maxLeft = viewport.width - EDGE - tip.width
  const maxTop = viewport.height - EDGE - tip.height
  if (trigger.right + GAP_X <= maxLeft) {
    return { left: Math.max(EDGE, trigger.right + GAP_X), top: clamp(trigger.top - GAP_Y, EDGE, maxTop) }
  }
  const left = clamp(trigger.left, EDGE, maxLeft)
  const below = trigger.bottom + GAP_Y
  if (below <= maxTop) return { left, top: below }
  const above = trigger.top - GAP_Y - tip.height
  return { left, top: above >= EDGE ? above : clamp(below, EDGE, maxTop) }
}
