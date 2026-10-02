import * as RT from "@radix-ui/react-tooltip"
import { createPortal } from "react-dom"
import { cloneElement, isValidElement, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from "react"
import { OVERLAY_Z_CLASS } from "../lib/overlaySurface.ts"
import { placeHelpTip } from "../lib/helpTipPlacement.ts"

// A small dark shadcn-style tooltip that shows IMMEDIATELY on hover (delayDuration 0) — used for the
// icon-only affordances (card-header actions) where a label needs to appear the instant you point at
// the glyph. One <Provider> wraps the app (App.tsx); each <Tooltip> wraps a single trigger element.

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RT.Provider delayDuration={0} skipDelayDuration={0} disableHoverableContent>
      {children}
    </RT.Provider>
  )
}

export function Tooltip({
  label,
  children,
  side = "top",
  clickable = false,
  multiline = false,
  disabled = false,
}: {
  label: string
  children: ReactNode
  side?: "top" | "right" | "bottom" | "left"
  /** Force it shut without unmounting the trigger — for a trigger being dragged, where the pointer is
   *  necessarily inside the thing it is moving and a delayDuration-0 tooltip would open on grab and
   *  chase it. Unmounting the wrapper instead would destroy the element holding pointer capture. */
  disabled?: boolean
  /** Lets help controls remain available on touch-only, narrow viewports. */
  clickable?: boolean
  /** Preserve `\n` in the label as real line breaks (whitespace-pre-line) — for multi-row labels like
   *  the quota breakdown. Default (whitespace-normal) collapses newlines to spaces, as before. */
  multiline?: boolean
}) {
  const whitespace = multiline ? "whitespace-pre-line" : "whitespace-normal"
  const [open, setOpen] = useState(false)
  const contentId = useId()
  const clickableChild = clickable && isValidElement(children)
    ? children as ReactElement<{ "aria-describedby"?: string }>
    : null
  const trigger = clickableChild ? cloneElement(clickableChild, { "aria-describedby": contentId }) : children
  const triggerRef = useRef<HTMLSpanElement>(null)
  const tipRef = useRef<HTMLSpanElement>(null)
  // The clickable branch places itself (below), once it can measure what it drew; until then it is hidden.
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null)
  const placed = clickable && isValidElement(children)
  useLayoutEffect(() => {
    if (!open || !placed) {
      setPlace(null)
      return
    }
    const trigger = triggerRef.current?.getBoundingClientRect()
    const tip = tipRef.current?.getBoundingClientRect()
    if (!trigger || !tip) return
    setPlace(placeHelpTip(trigger, { width: tip.width, height: tip.height }, { width: window.innerWidth, height: window.innerHeight }))
  }, [open, label, placed])

  if (clickableChild) {
    const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
      if (event.key === "Escape") {
        event.stopPropagation()
        setOpen(false)
      }
    }
    return (
      <span
        ref={triggerRef}
        className="inline-flex"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        onKeyDown={onKeyDown}
      >
        {trigger}
        {open && createPortal(
          <span
            ref={tipRef}
            id={contentId}
            role="tooltip"
            className={`${OVERLAY_Z_CLASS} max-w-[min(22rem,calc(100vw-1.5rem))] rounded-md border border-border bg-elevated px-3 py-2 text-[11px] leading-relaxed text-fg shadow-md shadow-shadow-ink/40 break-words ${whitespace}`}
            // Measured at the far left, where nothing narrows it, then placed (useLayoutEffect, before paint).
            // `pointer-events: none`, as Radix's tooltips are (disableHoverableContent): the help text is a
            // React child of the trigger, so a pointer resting on it counted as still on the (?) and kept it
            // open — and placed over the next field it hid that field's (?) from the pointer, which reached
            // the help under it only by first leaving the column.
            style={{ position: "fixed", pointerEvents: "none", left: place?.left ?? -10_000, top: place?.top ?? 0, visibility: place ? undefined : "hidden" }}
          >
            {label}
          </span>,
          document.body,
        )}
      </span>
    )
  }

  return (
    <RT.Root open={open && !disabled} onOpenChange={setOpen}>
      <RT.Trigger asChild>{trigger}</RT.Trigger>
      <RT.Portal>
        <RT.Content
          id={contentId}
          side={side}
          sideOffset={5}
          collisionPadding={12}
          className={`${OVERLAY_Z_CLASS} max-w-[min(22rem,calc(100vw-1.5rem))] select-none rounded-md border border-border bg-elevated px-3 py-2 text-[11px] leading-relaxed text-fg shadow-md shadow-shadow-ink/40 break-words ${whitespace}`}
        >
          {label}
          <RT.Arrow className="fill-elevated" />
        </RT.Content>
      </RT.Portal>
    </RT.Root>
  )
}
