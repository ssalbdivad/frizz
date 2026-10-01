import type { EmbedRouteMessage } from "@frizz/shared"
import { embedded, postToHost } from "./embed.ts"

// WHERE THE SIDEBAR IS, said to VS Code's title row (`frizz:route`, packages/shared/src/embed-protocol.ts).
// An editor's sidebar draws no header of its own (plans/vscode-extension.md § The editor in the sidebar):
// the row VS Code already draws above the frame is the header, so the page tells it the view's name and
// the reading beside it, and the row's buttons come back as `frizz:command` (lib/embedCommand.ts).
//
// The page's own surfaces decide the reading (AllQueues.tsx SidebarPage, StandaloneThreadPage.tsx); this
// module is what they share — the pure choice of what the row says, and a poster that says it only when
// it changed, since the page re-renders on every poll.

export type EmbedRoute = Omit<EmbedRouteMessage, "type">

/**
 * What the title row says, from what is in front of the human, most specific first: Settings over
 * everything, then the thread a drawer shows, then any other drawer (a file opened on its own), and
 * otherwise the queue — named by its scope ("All projects", a project's name), with its counts beside it.
 * Overlays that come and go in a moment (the palette, the shortcuts sheet, a menu) change nothing.
 */
export function sidebarRoute(input: {
  settings: boolean
  /** The title of the thread a drawer shows, else null. */
  thread: string | null
  /** The label of another drawer on top when no thread is open (a file's name), else null. */
  other: string | null
  /** The queue's scope: "All projects" or the focused project's name. */
  scope: string
  /** The queue's counts line (queueReading), or null while the queues are still loading. */
  reading: string | null
}): EmbedRoute {
  if (input.settings) return { view: "settings", title: "Settings" }
  if (input.thread !== null) return { view: "thread", title: input.thread }
  if (input.other !== null) return { view: "other", title: input.other }
  return input.reading ? { view: "queue", title: input.scope, description: input.reading } : { view: "queue", title: input.scope }
}

/**
 * The queue's counts as one line — the phone header's own words (lib/phonePage.ts phoneSubtitle), the asks
 * first: `1 needs you · 5 ready · 1 working`, or `Nothing needs you`. The title row has one tone, so the
 * accent part is just the first part.
 */
export function queueReading(subtitle: { accent: string | null; rest: string | null }): string {
  return [subtitle.accent, subtitle.rest].filter((part): part is string => !!part).join(" · ")
}

let last: EmbedRouteMessage | null = null

/** Tell the title row, if this page is in an editor's sidebar and the reading moved. */
export function reportRoute(route: EmbedRoute): void {
  if (!embedded()) return
  const message: EmbedRouteMessage = { type: "frizz:route", view: route.view, title: route.title, ...(route.description ? { description: route.description } : {}) }
  if (last && JSON.stringify(last) === JSON.stringify(message)) return
  last = message
  postToHost(message)
}

/**
 * Say the last reading again — right after `frizz:ready` (lib/embedHost.ts): the page renders its first
 * view before the board it waits on for ready has come, and an extension that listens only once the page
 * is ready would otherwise keep its default title until the reading next moved.
 */
export function repostRoute(): void {
  if (last) postToHost(last)
}
