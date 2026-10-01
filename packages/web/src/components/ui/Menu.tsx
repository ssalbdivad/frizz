import * as RadixMenu from "@radix-ui/react-dropdown-menu"
import type { ComponentProps, ReactNode } from "react"
import { OPAQUE_PORTAL_SURFACE_ABOVE_DIALOG_Z, OPAQUE_PORTAL_SURFACE_Z, OPAQUE_SURFACE_BASE } from "../../lib/overlaySurface.ts"

// Thin styled wrappers over Radix DropdownMenu so call sites read declaratively. The popover
// matches the Select: elevated bg, soft shadow, padded rounded items. These are anchored popovers,
// not modal dialogs: keep the surrounding app visible to assistive technology and pointer-capable
// while the menu is open. Radix defaults DropdownMenu to modal, which otherwise aria-hides #root and
// disables body pointer events even though no visual overlay is rendered.
export function Menu({ modal = false, ...props }: ComponentProps<typeof RadixMenu.Root>) {
  return <RadixMenu.Root modal={modal} {...props} />
}
export const MenuTrigger = RadixMenu.Trigger

export function MenuContent({
  children,
  align = "end",
  sideOffset = 6,
  aboveDialog = false,
}: {
  children: ReactNode
  align?: "start" | "center" | "end"
  sideOffset?: number
  /** Opened from inside the shared z-[200] Dialog, whose backdrop the default z-[110] paints beneath. */
  aboveDialog?: boolean
}) {
  return (
    <RadixMenu.Portal>
      <RadixMenu.Content
        align={align}
        sideOffset={sideOffset}
        className={`${aboveDialog ? OPAQUE_PORTAL_SURFACE_ABOVE_DIALOG_Z : OPAQUE_PORTAL_SURFACE_Z} ${OPAQUE_SURFACE_BASE} min-w-[184px] overflow-hidden rounded-lg p-1`}
      >
        {children}
      </RadixMenu.Content>
    </RadixMenu.Portal>
  )
}

export function MenuItem({
  children,
  onSelect,
  icon,
  danger,
  value,
  shortcut,
}: {
  children: ReactNode
  onSelect: () => void
  icon?: ReactNode
  danger?: boolean
  /** The item's key, formatted (useShortcutLabel), drawn muted at the row's end. */
  shortcut?: string | null
  /** Rendered as `data-value`, so a caller can find and focus one item (SnoozeButton opens its menu
   *  on the remembered preset rather than the first row). */
  value?: string
}) {
  return (
    <RadixMenu.Item
      onSelect={onSelect}
      data-value={value}
      className={`flex cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] outline-none transition-colors data-[highlighted]:bg-panel-2 ${
        danger
          ? "text-danger data-[highlighted]:text-danger-soft"
          : "text-muted data-[highlighted]:text-fg"
      }`}
    >
      {icon && <span className="flex w-3.5 shrink-0 items-center justify-center">{icon}</span>}
      {children}
      {shortcut && <span className="ml-auto pl-4 text-[11px] text-muted-55">{shortcut}</span>}
    </RadixMenu.Item>
  )
}

/** A muted heading over a run of items — what the menu is asking, when it opened without being clicked. */
export function MenuLabel({ children }: { children: ReactNode }) {
  return <RadixMenu.Label className="px-2.5 pb-1 pt-1.5 text-[11px] text-muted-55">{children}</RadixMenu.Label>
}

export function MenuSeparator() {
  return <RadixMenu.Separator className="my-1 h-px bg-border" />
}
