import assert from "node:assert/strict"
import test from "node:test"
import { claimEscape, dismissOpenSelect, focusedEscapeClaim, handleDialogEscape, registerEscapeClaim, registerOpenSelect } from "./selectOverlay.ts"

test("the newest open Select owns one dialog Escape", () => {
  const dismissed: string[] = []
  const unregisterFirst = registerOpenSelect(() => dismissed.push("first"))
  const unregisterSecond = registerOpenSelect(() => dismissed.push("second"))
  let prevented = 0
  let stopped = 0

  handleDialogEscape({
    preventDefault: () => prevented++,
    stopPropagation: () => stopped++,
  })

  assert.deepEqual(dismissed, ["second"])
  assert.equal(prevented, 1)
  assert.equal(stopped, 1)
  assert.equal(dismissOpenSelect(), false)
  unregisterSecond()
  unregisterFirst()
})

test("a dialog Escape propagates to Radix dismissal when no Select is open", () => {
  let prevented = 0
  let stopped = 0
  handleDialogEscape({
    preventDefault: () => prevented++,
    stopPropagation: () => stopped++,
  })
  assert.equal(prevented, 0)
  assert.equal(stopped, 1)
})


// A fake DOM: a node is inside a root when the root's set holds it.
function root(...nodes: string[]) { return { contains: (node: unknown) => nodes.includes(node as string) } }
function escape() {
  let prevented = 0
  let stopped = 0
  handleDialogEscape({ preventDefault: () => prevented++, stopPropagation: () => stopped++ })
  return { prevented, stopped }
}

test("a schedule strip's claim keeps the dialog open only while focus is inside the claiming box", () => {
  let focus: string | null = "dialog-textarea"
  let on = true
  const left: string[] = []
  const unregister = registerEscapeClaim(focusedEscapeClaim(
    () => root("dialog-textarea", "dialog-model-pill"),
    () => {
      if (!on) return false
      on = false
      left.push("dialog")
      return true
    },
    () => focus,
  ))

  // First Escape: the strip is dismissed, the dialog stays (Radix sees preventDefault).
  assert.deepEqual(escape(), { prevented: 1, stopped: 1 })
  assert.deepEqual(left, ["dialog"])
  // Second Escape: nothing left to claim, so the dialog closes as before.
  assert.deepEqual(escape(), { prevented: 0, stopped: 1 })

  // A strip again, but focus is OUTSIDE the box (a drawer's button, the page body): not this claim's key.
  on = true
  focus = "page-button"
  assert.deepEqual(escape(), { prevented: 0, stopped: 1 })
  assert.equal(on, true, "a box without focus never acts on Escape")
  focus = null
  assert.equal(claimEscape(), false)
  assert.equal(on, true)

  unregister()
  focus = "dialog-textarea"
  assert.equal(claimEscape(), false, "an unregistered claim is never asked")
  assert.equal(on, true)
})

test("two boxes on one draft, both showing its strip: only the focused one claims", () => {
  let focus = "page-textarea"
  const acted: string[] = []
  const claim = (name: string, nodes: string[]) => registerEscapeClaim(focusedEscapeClaim(
    () => root(...nodes),
    () => { acted.push(name); return true },
    () => focus,
  ))
  const offPage = claim("page", ["page-textarea"])
  const offDialog = claim("dialog", ["dialog-textarea"])
  focus = "dialog-textarea"
  assert.equal(claimEscape(), true)
  assert.deepEqual(acted, ["dialog"])
  focus = "page-textarea"
  assert.equal(claimEscape(), true)
  assert.deepEqual(acted, ["dialog", "page"])
  offDialog()
  offPage()
  assert.equal(claimEscape(), false)
})

test("an open Select still wins Escape over a claim", () => {
  const order: string[] = []
  const unregisterClaim = registerEscapeClaim(() => { order.push("claim"); return true })
  const unregisterSelect = registerOpenSelect(() => order.push("select"))
  assert.deepEqual(escape(), { prevented: 1, stopped: 1 })
  assert.deepEqual(order, ["select"])
  assert.deepEqual(escape(), { prevented: 1, stopped: 1 })
  assert.deepEqual(order, ["select", "claim"])
  unregisterSelect()
  unregisterClaim()
})

test("a claim can PASS: the dialog stays, and the key goes on to the box's open menu or IME (fix round 1, X4)", () => {
  // The `c` dialog's box with its slash menu open and the strip showing: Radix asks the claim at the document's
  // capture phase, before the box's own handler. The menu is the box's to close first, as on the page — so the
  // claim neither acts nor lets the dialog close, and the key travels on to the box.
  let menuOpen = true
  let on = true
  const unregister = registerEscapeClaim(focusedEscapeClaim(
    () => root("dialog-textarea"),
    (event) => {
      if (event?.isComposing || menuOpen) return "pass"
      if (!on) return false
      on = false
      return true
    },
    () => "dialog-textarea",
  ))
  assert.deepEqual(escape(), { prevented: 1, stopped: 0 }, "the menu's Escape: the dialog stays, the key is not stopped")
  assert.equal(on, true, "and the strip is untouched")
  menuOpen = false
  let prevented = 0
  let stopped = 0
  handleDialogEscape({ preventDefault: () => prevented++, stopPropagation: () => stopped++, isComposing: true })
  assert.deepEqual({ prevented, stopped }, { prevented: 1, stopped: 0 }, "an IME's Escape is its own cancel")
  assert.equal(on, true)
  assert.deepEqual(escape(), { prevented: 1, stopped: 1 }, "the next Escape dismisses the strip")
  assert.equal(on, false)
  assert.deepEqual(escape(), { prevented: 0, stopped: 1 }, "and the one after closes the dialog")
  unregister()
})
