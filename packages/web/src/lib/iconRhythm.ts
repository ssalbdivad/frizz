/** HORIZONTAL rhythm for a strip of small marks — the sibling of `iconAlign.ts`, which does the same
 *  job vertically.
 *
 *  THE PROBLEM, stated once. `gap` spaces BOXES. The eye spaces INK. In a control strip those are not
 *  remotely the same measurement, because every mark wears a different amount of dead space inside its
 *  own box, from two independent sources:
 *
 *    1. the control's padding — a 24px hover square around a 12px glyph carries 6px a side;
 *    2. the GLYPH's own inset inside its svg — lucide's `Plug` paints only 8 of its 13 box px, while
 *       `RefreshCw` paints 10 of 12 and a bordered pill paints all of its box.
 *
 *  So a strip on one uniform `gap-1.5` drew SIX DIFFERENT distances. Measured on the shipped footer
 *  (`scripts/ink-gaps.mjs`, 2026-08-05, every CSS gap 6px):
 *
 *      context meter → hourglass    10.34px ink
 *      hourglass → heartbeat        12.50px
 *      plug → restart               20.50px   ← widest
 *      restart → Snooze pill        13.00px
 *      Snooze pill → Mark as done    5.78px   ← narrowest
 *
 *  A 3.5× spread, and the maintainer read it exactly off the pixels: "the perceived distance between
 *  the plug-in icon and the restart icon is much larger than the perceived distance between the
 *  restart icon and the left side of the snooze button, both of which are much larger than the space
 *  between the context icon and the heart… I'm sure the spacing is consistent in terms of the CSS, but
 *  what matters here is the visual spacing."
 *
 *  THE FIX. Collapse each mark's layout box onto its own ink with a negative margin equal to its
 *  MEASURED dead space, then let one `gap` mean what it says. After that the container's gap IS the
 *  ink gap, for pills and bare glyphs alike, and adding a mark to the strip is a one-line change
 *  rather than a re-tune.
 *
 *  Every constant below is a measurement, not a taste. Re-measure — never re-guess — if a glyph, an
 *  icon size, or a control's padding changes:
 *
 *      node scripts/ink-gaps.mjs http://localhost:5461/icon-rhythm-fixture.html \
 *        '[data-context-meter],[data-pending-snooze],[data-recurring-prompt],[data-reload-plugins],…'
 *
 *  and read `deadLeft`/`deadRight` off each mark. `packages/web/icon-rhythm-fixture.html` renders the
 *  real footer and the real composer rail side by side for exactly this.
 *
 *  THE ORDER ABOVE IS HISTORY, not the shipping strip, and TWO OF ITS MARKS HAVE LEFT. On 2026-08-11
 *  Reload plugins and Restart worker moved out of the right cluster into the LEFT one, behind the
 *  context meter (which stays far left, maintainer same day); on 2026-08-26 they left the footer
 *  altogether for the header's action strip ("the restart worker button should be at the top. I just
 *  realized it shouldn't be along the bottom"), and `INK_TRIM_PLUG` / `INK_TRIM_REFRESH` went with
 *  them — deleted rather than kept, because that strip is uniform 28px squares on a flat `gap-0.5`
 *  where every mark carries the same box and a trim would pull one verb out of the rhythm.
 *  The footer now reads meter · hourglass · goal … snooze · done. Both re-orders cost nothing to place,
 *  which is the property the trims buy — every mark's box is collapsed onto its own ink, so the
 *  container's one gap governs whatever sits beside whatever. Measured after the 2026-08-11 move:
 *  11.84 / 12.50 / 12.00 / 12.00 across the left cluster and 12.00 from the snooze split button to Mark
 *  as done, against the 12px target.
 *
 *  One consequence worth knowing before you change which mark comes FIRST. The footer's `px-3` clears
 *  the leading mark's BOX, so what the eye reads as the left inset is that padding minus the mark's own
 *  dead space — and the trims are what make the two agree. The meter, which leads it today, needs no
 *  trim (its ring reaches its own svg edge) and its ink lands 12.25px in; the plug, when it led the
 *  strip instead, put its box 4px from the edge and its ink at 12.5px. Either is within half a pixel of
 *  the 12px the right-hand pill keeps on the other side. An UNTRIMMED narrow glyph led there would sit a
 *  full dead-space width in. */

/** The strip's one optical distance: 12px of clear space between any two marks, whatever they are.
 *
 *  Chosen, not inherited. It is where the left cluster already sat (10.3 / 12.5px) — the one part of
 *  the strip the maintainer did NOT call wrong — and it is the tightest value the right cluster can
 *  hold without the two 24px icon hover-squares overlapping by more than a hair. Below ~11px the two
 *  bare glyphs start to read as one mark; above ~14px the two pills come apart. */
export const STRIP_INK_GAP = "gap-3"

/** `PendingSnooze` — lucide `AlarmClock` at 12px (ink 9.5px across, so 1.25px inset a side) inside `px-0.5`.
 *
 *  It was the `Hourglass` until 2026-09-19 (ink 7px across, 2.5px inset, `-mx-1`); the human's own
 *  snooze wears the alarm clock on every surface now. The clock's bells and feet reach further out than
 *  the hourglass's caps, so the trim is nearly just the padding. Measured on the rail fixture at dsf 8
 *  (scripts/verify-rail-status-glyphs.mjs, the `user-snoozed` slot): the clock inks 0.79 of its box
 *  across against the hourglass's 0.58, and the ratio is the glyph's, whatever the size.
 *
 *  There is deliberately no constant for `ContextMeter`: its `em`-sized ring reaches its own svg edge
 *  (0.3px a side), which is under the floor where a correction smears the mark rather than moving it.
 *  It is measured, not missed. */
export const INK_TRIM_ALARM = "-mx-[3px]"


/** Bare composer icons carry dead space; the filled Send button paints its full box.
 *  These offsets leave ~14.5px between resting ink edges (not uniform box gaps).
 *  Hover outlines do not participate in the resting rhythm. */
export const RAIL_SEND_OFFSET = "right-2"
export const RAIL_ACTION_OFFSET = "right-[43px]"
export const RAIL_PAPERCLIP_OFFSET = "right-[71px]"
export const RAIL_PAPERCLIP_PLAIN_OFFSET = "right-[44px]"

/** Reserve the leftmost button's edge (99px with GitHub, 72px without), plus 8px for prose. */
export const RAIL_RESERVE_WITH_ACTION = "pr-[6.6875rem]"
export const RAIL_RESERVE_PLAIN = "pr-20"

/** The new-thread box's lazy-save glyph (`Snail`) takes the slot directly left of Send, and every slot
 *  further left moves over by one 28px pitch. The snail's ink is wider than the other bare glyphs', so
 *  at the rail action's own `right-[43px]` it read 13.5px from Send; it sits 1px further out instead.
 *  Measured with scripts/ink-gaps.mjs on composer-icons-fixture `?lazy` (dark): 14.25 · 14.25 · 14.5
 *  with GitHub, 14.25 · 14.5 without, against 14.25 / 14.75 on the strip without the snail. The
 *  reserves grow by the same 28px. */
export const RAIL_LAZY_OFFSET = "right-[44px]"
export const RAIL_LAZY_ACTION_OFFSET = "right-[71px]"
export const RAIL_LAZY_PAPERCLIP_OFFSET = "right-[99px]"
export const RAIL_LAZY_PAPERCLIP_PLAIN_OFFSET = "right-[72px]"
export const RAIL_LAZY_RESERVE_WITH_ACTION = "pr-[8.4375rem]"
export const RAIL_LAZY_RESERVE_PLAIN = "pr-[6.75rem]"

/** The new-thread box's SCHEDULE glyph (`Repeat`, plans/scheduled-threads.md §3) takes the slot directly
 *  left of the snail, and every slot further left moves over by one more 28px pitch; the reserves grow by
 *  the same 28px. Provisional pitch-only values until measured — see the readings below once taken. */
export const RAIL_SCHEDULE_OFFSET = "right-[72px]"
export const RAIL_SCHEDULE_ACTION_OFFSET = "right-[99px]"
export const RAIL_SCHEDULE_PAPERCLIP_OFFSET = "right-[127px]"
export const RAIL_SCHEDULE_PAPERCLIP_PLAIN_OFFSET = "right-[100px]"
export const RAIL_SCHEDULE_RESERVE_WITH_ACTION = "pr-[10.1875rem]"
export const RAIL_SCHEDULE_RESERVE_PLAIN = "pr-[8.5rem]"
