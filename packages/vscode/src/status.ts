// THE STATUS BAR ITEM, as data: what it says, what hovering it says, and what clicking it does.
//
// Connected, it is "Frizz", with this workspace's Ready count beside it when anything is waiting on the
// human — the one number worth a glance from the editor. Ready and Working are the page's own words
// for the queue and for what is spinning. A project the server has not opened yet has no counts (the
// `projects` push omits them), and says nothing rather than claiming zero.
//
// Offline, it stays short — a window with no Frizz running should not shout about it in every status
// bar — and the tooltip says what is true and that a click tries again.

import type { EditorProject } from "@frizz/shared/editor-protocol"
import type { ConnectionStatus } from "./connection.ts"

export interface StatusView {
  text: string
  tooltip: string
  command: "frizz.open" | "frizz.reconnect"
}

export function statusView(connection: ConnectionStatus, projects: readonly EditorProject[]): StatusView {
  switch (connection.kind) {
    case "connecting":
      return { text: "$(sync~spin) Frizz", tooltip: "Looking for Frizz…", command: "frizz.reconnect" }
    case "offline":
      return { text: "$(debug-disconnect) Frizz", tooltip: `${connection.reason.replace(/\.$/u, "")}. Click to try again.`, command: "frizz.reconnect" }
    case "incompatible":
      return { text: "$(warning) Frizz", tooltip: `${connection.reason} Click to try again.`, command: "frizz.reconnect" }
    case "connected": {
      const ready = projects.reduce((sum, project) => sum + (project.ready ?? 0), 0)
      const lines = projects.map((project) => {
        if (project.ready === undefined && project.working === undefined) return project.name
        return `${project.name}: ${project.ready ?? 0} ready · ${project.working ?? 0} working`
      })
      return {
        text: ready > 0 ? `Frizz · ${ready} ready` : "Frizz",
        tooltip: [...lines, "Click to open Frizz."].join("\n"),
        command: "frizz.open",
      }
    }
  }
}
