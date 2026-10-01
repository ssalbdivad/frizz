import { test } from "node:test"
import assert from "node:assert/strict"
import { notConnectedMessage, statusView } from "./status.ts"

const connected = { kind: "connected" as const, origin: "http://127.0.0.1:9393", bootId: "b" }

test("connected, the item reads Frizz plus the workspace's Ready count, and the tooltip names each project", () => {
  const view = statusView(connected, [
    { id: "a", slug: "a", name: "frizz", dir: "/r/frizz", ready: 2, working: 1 },
    { id: "b", slug: "b", name: "site", dir: "/r/site", ready: 1, working: 0 },
    { id: "c", slug: "c", name: "docs", dir: "/r/docs" },
  ])
  assert.deepEqual(view, {
    text: "Frizz · 3 ready",
    tooltip: "frizz: 2 ready · 1 working\nsite: 1 ready · 0 working\ndocs\nClick to show Frizz.",
    command: "frizz.sidebar.focus",
    ready: 3,
  })
  assert.equal(statusView(connected, [{ id: "a", slug: "a", name: "frizz", dir: "/r", ready: 0, working: 4 }]).text, "Frizz", "nothing waiting, no number")
  assert.equal(statusView(connected, []).tooltip, "Click to show Frizz.")
})

test("offline or incompatible, a click tries again and the tooltip says why", () => {
  assert.deepEqual(statusView({ kind: "offline", reason: "Frizz isn't running." }, []), {
    text: "$(debug-disconnect) Frizz",
    tooltip: "Frizz isn't running. Click to try again.",
    command: "frizz.reconnect",
    ready: 0,
  })
  const incompatible = statusView({ kind: "incompatible", reason: "Update Frizz or the extension." }, [])
  assert.equal(incompatible.command, "frizz.reconnect")
  assert.match(incompatible.tooltip, /^Update Frizz or the extension\. Click to try again\.$/)
  assert.equal(statusView({ kind: "connecting" }, []).command, "frizz.reconnect")
})

test("a command with no connection says the connection's own reason, not that Frizz is stopped", () => {
  // A Frizz that is up but refused this window: the commands must not contradict the tooltip.
  assert.equal(notConnectedMessage({ kind: "offline", reason: "This Frizz has no editor connection yet. Update Frizz." }), "This Frizz has no editor connection yet. Update Frizz.")
  assert.equal(
    notConnectedMessage({ kind: "incompatible", reason: "This Frizz speaks a different version of the editor connection. Update Frizz or the extension." }),
    "This Frizz speaks a different version of the editor connection. Update Frizz or the extension.",
  )
  assert.equal(notConnectedMessage({ kind: "offline", reason: "Frizz isn't running." }), "Frizz isn't running.", "when it really is not running, it says so")
  assert.equal(notConnectedMessage({ kind: "connecting" }), "Still connecting to Frizz. Try again in a moment.")
})
