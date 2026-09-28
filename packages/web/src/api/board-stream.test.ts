import { test } from "node:test"
import assert from "node:assert/strict"
import type { ServerEvent } from "@frizz/shared"
import { BoardStream, notify } from "./board-stream.ts"
import { setHomeFocus } from "../lib/base-path.ts"
import { store } from "../store.ts"

test("BoardStream forwards typed-interaction invalidations without treating them as board deltas", () => {
  const seen: ServerEvent[] = []
  let resyncs = 0
  const stream = new BoardStream(() => resyncs++, (event) => seen.push(event))
  const event = {
    type: "interactions-invalidated",
    slug: "owned-thread",
    sessionId: "session-1",
    interactionId: "interaction-1",
    lifecycle: "pending",
    recordRevision: 0,
  } as const satisfies ServerEvent

  stream.handle(event)

  assert.deepEqual(seen, [event])
  assert.equal(resyncs, 0)
})

// A DESKTOP NOTIFICATION IS CLICKED LATER — often much later, since it is only ever raised while the
// window is hidden. By then the tab may be showing a different project, and `openThread` opens a slug
// in whatever project is showing. Slugs are unique only WITHIN a project, so the click did not fail
// and say so: it opened a DIFFERENT thread that happened to share the name. The last place in the
// client where "which project" was resolved at the moment of use rather than travelling with the work.
test("a notification click opens the thread in the project it was raised for, not the one on screen", () => {
  const globals = new Map<PropertyKey, PropertyDescriptor | undefined>()
  const install = (key: PropertyKey, value: unknown) => {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  const raised: { onclick: (() => void) | null }[] = []
  class FakeNotification {
    static permission = "granted"
    onclick: (() => void) | null = null
    constructor(readonly title: string, readonly opts: { body?: string; tag?: string }) { raised.push(this) }
    close(): void {}
  }
  // The page is Everything at `/`; which project it is showing is its FOCUS (lib/base-path.ts).
  const here = { pathname: "/", assign: (url: string) => { assigned.push(url) } }
  setHomeFocus("alpha")
  let assigned: string[] = []
  install("Notification", FakeNotification)
  install("document", { hidden: true })
  install("window", { focus: () => {} })
  install("location", here)

  const drawersBefore = store.drawers.length
  const notificationsBefore = store.notificationsEnabled
  store.notificationsEnabled = true

  try {
    const event = { type: "notify", slug: "fix-auth", title: "Done", body: "…" } as const satisfies ServerEvent

    // Raised on alpha, clicked on alpha: the in-app drawer, no navigation.
    notify(event)
    raised.at(-1)!.onclick!()
    assert.deepEqual(assigned, [], "the same project needs no document load")
    assert.equal(store.drawers.length, drawersBefore + 1, "it opens the thread in place")
    store.drawers = []

    // Raised on alpha, clicked after the tab moved to beta: beta must not open ITS `fix-auth`.
    assigned = []
    setHomeFocus("alpha")
    notify(event)
    setHomeFocus("beta")
    raised.at(-1)!.onclick!()
    assert.deepEqual(assigned, ["/all/alpha/thread/fix-auth"], "the click follows the notification's own project")
    assert.equal(store.drawers.length, 0, "and opens nothing on the project that happens to be showing")
  } finally {
    setHomeFocus(undefined)
    store.drawers = []
    store.notificationsEnabled = notificationsBefore
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
