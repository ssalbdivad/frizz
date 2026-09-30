import { createContext, useContext, useMemo, type ReactNode } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useMentionCandidates } from "../hooks/useMentionCandidates.ts"
import { fetchSubAgentDirectory } from "../hooks/useSubAgentDirectory.ts"
import { useThreadApi, useThreadProjectId } from "../api/threadApi.tsx"
import { basePath } from "../lib/base-path.ts"
import { mentionSegments, resolveSubAgentMention, type MentionCandidate, type MentionSegment } from "../lib/threadMentions.ts"
import { openThread, pushSubAgentDrawer } from "../store.ts"

// `@handle` IN A HUMAN'S MESSAGE OPENS THE THREAD IT NAMES. A transcript provides the index of the
// board's handles once, and every verbatim text run under it (LinkifiedText) links the mentions that
// resolve. Scoped by provider on purpose: only a transcript of the PAGE's project may resolve against the
// page's board — a cross-project queue card renders no provider, so its mentions stay text rather than
// linking to a same-named thread of the wrong project.
const MentionIndexContext = createContext<readonly MentionCandidate[]>([])

export function MentionIndexProvider({ children }: { children: ReactNode }) {
  const candidates = useMentionCandidates()
  // Re-render the transcript's text runs only when a handle is added, removed or renamed — not on every
  // board tick, which rewrites status lines and timestamps many times a minute.
  const key = candidates.map((c) => `${c.slug}\u0000${c.handle}`).join("\u0001")
  const index = useMemo(() => candidates, [key])
  return <MentionIndexContext.Provider value={index}>{children}</MentionIndexContext.Provider>
}

/** Split a text run by the mentions the surrounding transcript can resolve. */
export function useMentionSegments(text: string): MentionSegment[] {
  const index = useContext(MentionIndexContext)
  return useMemo(() => mentionSegments(text, index), [text, index])
}

export function MentionLink({ segment }: { segment: Extract<MentionSegment, { kind: "mention" }> }) {
  return segment.address ? <SubAgentMentionLink segment={segment} /> : <ThreadMentionLink segment={segment} />
}

function ThreadMentionLink({ segment }: { segment: Extract<MentionSegment, { kind: "mention" }> }) {
  return (
    <a
      href={`${basePath()}/thread/${segment.slug}`}
      title={segment.status ?? "Open thread"}
      data-thread-mention={segment.slug}
      className="underline underline-offset-2"
      // A plain click opens the thread's drawer in place; a modified click is left to the browser, so
      // ⌘-click still opens it in a new tab. Either way the bubble under it (click-to-unqueue while
      // queued) never sees the click.
      onClick={(e) => {
        e.stopPropagation()
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        e.preventDefault()
        openThread(segment.slug)
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {segment.text}
    </a>
  )
}

// `@thread.child` OPENS THE CHILD — its sub-agent drawer, found by address in the thread's directory,
// which keeps the children that have already returned (maintainer 2026-09-30: "some subagents are
// transient so probably we want to maintain some history of completed subagents so we can reference
// the thread if needed"). The segment links as soon as its THREAD resolves; whether the child is real is
// asked only on the click, so a transcript full of mentions costs no requests to draw. A child the
// directory does not know — a typo, a name since renamed — opens its thread instead, which is where it
// would have been. Only a query hook lives here, so it is a component of its own: a thread mention
// renders on surfaces with no query client.
function SubAgentMentionLink({ segment }: { segment: Extract<MentionSegment, { kind: "mention" }> }) {
  const queryClient = useQueryClient()
  const api = useThreadApi()
  const projectId = useThreadProjectId()
  const open = async () => {
    const directory = await fetchSubAgentDirectory(queryClient, api, projectId, segment.slug).catch(() => undefined)
    const entry = directory && resolveSubAgentMention(directory, segment.address!)
    if (entry) pushSubAgentDrawer(segment.slug, entry.id, { label: entry.label, subagentType: entry.subagentType, startedAt: entry.startedAt })
    else openThread(segment.slug)
  }
  return (
    <a
      href={`${basePath()}/thread/${segment.slug}`}
      title="Open sub-agent"
      data-thread-mention={segment.slug}
      data-subagent-mention={segment.address}
      className="underline underline-offset-2"
      // The thread link's click contract: a modified click is the browser's (⌘-click opens the THREAD in
      // a new tab — a sub-agent has no URL of its own), and the bubble never sees the click.
      onClick={(e) => {
        e.stopPropagation()
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        e.preventDefault()
        void open()
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {segment.text}
    </a>
  )
}
