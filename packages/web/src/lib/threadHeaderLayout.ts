import { PANE_HEADER_HEIGHT_CLASS } from "./paneHeaderHeight.ts"

// Keep the drawer-header breakpoints in one importable contract.
//
// One row wide, the bar is the FIXED pane-header height every sheet header is, with no vertical
// padding — the row's content centres in it, and a minimum plus padding is how this header grew to
// 52.75px beside a 48px file viewer (lib/paneHeaderHeight.ts). Only the two-row wrap lets the height
// go back to auto, with its own padding, because two rows cannot fit in one bar.
//
// THE WRAP KEYS ON THE HEADER'S OWN WIDTH, not the viewport's. It was `max-[640px]`, which answered
// "is the WINDOW narrow" when the question is "is the DRAWER narrow" — and inside VS Code's sidebar the
// frame is the window, so a 450px sidebar paid 92px of two-row header (10/16 padding, the icon strip and
// ✕ on a second row) for a 164px title and a 180px strip that fit one 418px row. The wrapper below is a
// size container and the header reads it, so the drawer decides: under 27.5rem (440px) it is two rows —
// a 300px sidebar, and every phone, whose drawer is the screen and tops out at 430 CSS px — and from
// 440px up it is the desktop's one 48px row, which is also what a browser between 440 and 640 now gets
// (its drawer is just as wide as that sidebar's). ThreadTitle wraps its name to two lines on the same
// condition (THREAD_HEADER_NARROW), so the name it has a row to itself for is not cut on one line.
//
// The wrapper carries what positions the bar (sticky, its stacking) and nothing that draws: the border,
// the fill and the height stay on the header, so the bar is 48px border included exactly as before.
export const THREAD_HEADER_CONTAINER_CLASS = "@container/thread-header sticky top-0 z-10 min-w-0 shrink-0"
// The one condition: a container query on the wrapper above. Every class that keys on it is written out
// in FULL, here and in ThreadTitle — Tailwind finds a class by scanning the source for its literal text,
// so a variant assembled at runtime (`${THREAD_HEADER_NARROW}:${token}`) would never be generated.
// ThreadHeader.test checks each narrow token carries exactly this prefix, ThreadTitle's included.
export const THREAD_HEADER_NARROW = "@max-[27.5rem]/thread-header"
export const THREAD_HEADER_CLASS = `flex min-w-0 items-center gap-2.5 border-b border-border bg-panel px-3 ${PANE_HEADER_HEIGHT_CLASS} @max-[27.5rem]/thread-header:h-auto @max-[27.5rem]/thread-header:min-h-12 @max-[27.5rem]/thread-header:flex-wrap @max-[27.5rem]/thread-header:items-start @max-[27.5rem]/thread-header:gap-y-2 @max-[27.5rem]/thread-header:px-4 @max-[27.5rem]/thread-header:py-2.5`
export const THREAD_HEADER_TITLE_CLASS = "flex min-w-0 flex-1 items-center gap-2.5 pl-1 @max-[27.5rem]/thread-header:basis-full"
export const THREAD_HEADER_CONTROLS_CLASS = "flex shrink-0 items-center @max-[27.5rem]/thread-header:w-full"
