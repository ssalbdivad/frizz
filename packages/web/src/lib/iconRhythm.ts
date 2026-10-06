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
 *  THE STRIP THIS WAS WRITTEN FOR IS GONE. The lifecycle footer went on 2026-10-05: its context
 *  reading moved up into the header's second line (ContextMeter), its goal down into the composer rail
 *  below, and snooze and mark as done into the header's action strip as bare icons on that strip's
 *  uniform 28px squares (ThreadLifecycle.tsx), where every mark carries the same box and no trim
 *  applies. Its strip gap and its last trim (the snoozed alarm clock's) went with it.
 *
 *  What remains is the composer RAIL, whose marks sit at absolute offsets rather than on a gap — the
 *  same law applied per mark: each offset is chosen so the INK between neighbours, not their boxes,
 *  keeps one distance. Every constant below is a measurement, not a taste. Re-measure — never
 *  re-guess — if a glyph, an icon size, or a control's padding changes (`scripts/ink-gaps.mjs`, and
 *  read `deadLeft`/`deadRight` off each mark). */


/** Bare composer icons carry dead space; the filled Send button paints its full box.
 *  These offsets leave ~14.5px between resting ink edges (not uniform box gaps).
 *  Hover outlines do not participate in the resting rhythm. */
export const RAIL_SEND_OFFSET = "right-2"
export const RAIL_ACTION_OFFSET = "right-[43px]"
export const RAIL_PAPERCLIP_OFFSET = "right-[71px]"
export const RAIL_PAPERCLIP_PLAIN_OFFSET = "right-[44px]"

/** The thread composer's Goal, at the rail's LEFT end beyond the paperclip (Composer `railLead`).
 *  Its own constant, not the paperclip's or the action's: GoalMark at 15px paints 7px of dead box on
 *  its right against the paperclip's 8.25px on its left, so a box gap of -1px (the two hover squares
 *  overlap by a pixel of empty padding) draws 14.25px of ink between them, against 14.75px from the
 *  paperclip to send. Measured on a real queue card with scripts/ink-gaps.mjs at dsf 4, 2026-10-05;
 *  the two glyphs also read at one weight there (mean contrast 338.5 against 338.9). */
export const RAIL_LEAD_OFFSET = "right-[71px]"
export const RAIL_LEAD_WITH_ACTION_OFFSET = "right-[98px]"

/** Reserve the leftmost button's edge (99px with GitHub or the Goal, 72px with neither, 126px with
 *  both), plus 8px for prose. */
export const RAIL_RESERVE_WITH_ACTION = "pr-[6.6875rem]"
export const RAIL_RESERVE_WITH_BOTH = "pr-[8.375rem]"
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
