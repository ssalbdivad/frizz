import { openNewThread, store } from "../store.ts"

// The new-thread key, `c`. With the page in front of you the prompt box at the top of its left column IS
// the new-thread door, so the key puts the caret in it. With a drawer over the page the rail sits behind
// its scrim, so the anywhere-modal opens instead and the drawer stays where it was — Gmail's compose
// window over the conversation you were reading. (`t` opened the box on its Terminal tab until
// 2026-09-29; a terminal belongs to a thread now, and `t` opens one on the thread you are reading.)
//
// A module of its own since 2026-10-01, when a second caller arrived: the New thread button in VS Code's
// title row over an editor's sidebar (lib/embedCommand.ts), which is the same door and must not drift
// from the key.
export function openDispatch(): void {
  if (!store.drawers.some((drawer) => !drawer.closing)) {
    const form = [...document.querySelectorAll<HTMLElement>("[data-dispatch-form]")].find((el) => !el.closest('[role="dialog"]'))
    if (form) {
      form.querySelector<HTMLElement>('[data-surface="newComposer"]')?.focus()
      return
    }
  }
  openNewThread()
}
