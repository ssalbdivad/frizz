import assert from "node:assert/strict"
import test from "node:test"
import { aboveDrawersZ, OPAQUE_PORTAL_SURFACE_CLASS, OPAQUE_PORTAL_SURFACE_Z, OPAQUE_SURFACE_BASE, OVERLAY_Z_CLASS, TOAST_Z } from "./overlaySurface.ts"

test("portal selector surfaces are explicitly opaque and stack above the desktop sidebar", () => {
  assert.match(OPAQUE_PORTAL_SURFACE_CLASS, /bg-elevated/)
  assert.match(OPAQUE_PORTAL_SURFACE_CLASS, /opacity-100/)
  assert.match(OPAQUE_PORTAL_SURFACE_CLASS, /border-border/)
  assert.match(OPAQUE_PORTAL_SURFACE_CLASS, /shadow-2xl/)
  const zIndexClass = OPAQUE_PORTAL_SURFACE_CLASS.match(/z-\[(\d+)\]/)
  assert.ok(zIndexClass, "portal surface must declare an explicit z-index")
  const zIndex = Number(zIndexClass[1])
  assert.equal(zIndex, 110)
  assert.ok(zIndex > 100, "portal surface must paint above the desktop sidebar's z-[100] layer")
  assert.doesNotMatch(OPAQUE_PORTAL_SURFACE_CLASS, /pop-in/)
})

test("the opaque surface base carries NO z-index, so a caller applies exactly one z utility", () => {
  // Prevents the Tailwind footgun of stacking two z-* classes on one element (source-order-decided).
  assert.doesNotMatch(OPAQUE_SURFACE_BASE, /\bz-\[/)
  assert.doesNotMatch(OPAQUE_SURFACE_BASE, /\bz-\d/)
  assert.match(OPAQUE_SURFACE_BASE, /bg-elevated/)
  assert.match(OPAQUE_SURFACE_BASE, /opacity-100/)
})

test("anchored overlays (tooltip/popover) stack above the sidebar, selector surface, and modal dialog", () => {
  const m = OVERLAY_Z_CLASS.match(/z-\[(\d+)\]/)
  assert.ok(m, "overlay z must be an explicit arbitrary z-index")
  const z = Number(m[1])
  assert.ok(z > 100, "must paint above the desktop sidebar's z-[100] layer")
  assert.ok(z > 110, "must paint above the opaque selector surface (z-[110])")
  assert.ok(z > 200, "must paint above the modal Dialog (z-[200]) so a popover opened inside one still shows")
  assert.ok(z < 300, "must stay below the restart scrim (z-[300]), which alone must cover the whole app")
})

test("a modal opened over the drawer stack paints above its top layer, and below toasts and pickers", () => {
  // DrawerStack: a layer at depth d paints its scrim at 50 + 2d and a thread's panel at 51 + 2d.
  const topPanel = (count: number) => 51 + 2 * (count - 1)
  assert.equal(aboveDrawersZ(0), 52)
  for (let count = 1; count <= 8; count++) {
    const z = aboveDrawersZ(count)
    assert.ok(z > topPanel(count), `${count} drawers: scrim ${z} must clear the top panel ${topPanel(count)}`)
    assert.ok(z + 1 < TOAST_Z, `${count} drawers: the panel (${z + 1}) must stay under toasts (${TOAST_Z})`)
  }
  // Past nine drawers the tier holds under toasts rather than climbing into them.
  assert.equal(aboveDrawersZ(40), TOAST_Z - 2)
  const pickers = Number(OPAQUE_PORTAL_SURFACE_Z.match(/z-\[(\d+)\]/)![1])
  assert.ok(aboveDrawersZ(40) + 1 < pickers, "a picker the dialog opens (z-[110]) must paint above it")
})
