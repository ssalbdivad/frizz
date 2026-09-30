import { createContext, useContext, useMemo, type ReactNode } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useMentionCandidates } from "../hooks/useMentionCandidates.ts"
import { openSubAgentMention } from "../hooks/useSubAgentDirectory.ts"
import { useThreadApi, useThreadProjectId } from "../api/threadApi.tsx"
import { basePath } from "../lib/base-path.ts"
import { mentionSegments, type MentionCandidate, type MentionSegment } from "../lib/threadMentions.ts"
import type { ThreadView } from "@frizz/shared"
import { displayName, displayTitle, threadHandleOf } from "../groups.ts"
import { useBoard } from "../hooks.ts"
import { openThread, threadBySlug } from "../store.ts"

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

function ThreadMentionLink({ segment, href, onOpen, title, className = "underline underline-offset-2" }: {
  segment: Extract<MentionSegment, { kind: "mention" }>
  href?: string
  onOpen?: () => void
  title?: string
  className?: string
}) {
  return (
    <a
      href={href ?? `${basePath()}/thread/${segment.slug}`}
      title={title ?? segment.status ?? "Open thread"}
      data-thread-mention={segment.slug}
      className={className}
      // A plain click opens the thread's drawer in place; a modified click is left to the browser, so
      // ⌘-click still opens it in a new tab. Either way the bubble under it (click-to-unqueue while
      // queued) never sees the click.
      onClick={(e) => {
        e.stopPropagation()
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        e.preventDefault()
        if (onOpen) onOpen()
        else openThread(segment.slug)
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {segment.text}
    </a>
  )
}

// A THREAD NAMED BY FRIZZ, NOT BY A HUMAN'S TEXT — the spinoff card's child, the child's way back to its
// parent (Spinoff.tsx). It is the mention link above with the name filled in from the board rather than
// scanned out of prose, so a thread Frizz points at reads and clicks exactly like one the human typed:
// `@handle`, a plain click opens its drawer, a modified click follows the address. One link style, not
// a third (maintainer 2026-09-30: "link and mention the spinoff by name with the new @ feature").
//
// The name is the thread's handle when it has one; else what the board shows for it (a placeholder or
// a sentence-length title, which has no handle); else the bare slug, for a thread this board does not
// hold. `thread` resolves it on a surface whose threads are not the page's board — a queue card of
// another project passes its own row (or null when it has none, so the page's board is never asked about
// another project's slug), address and opener.
export function ThreadHandleLink({ slug, thread, href, onOpen, className }: {
  slug: string
  thread?: ThreadView | null
  href?: string
  onOpen?: () => void
  className?: string
}) {
  const board = useBoard()
  const t = thread === undefined ? threadBySlug(board, slug) : thread ?? undefined
  const handle = t ? threadHandleOf(t) : undefined
  const text = handle ? `@${handle}` : t ? displayTitle(t) : slug
  // The tooltip says what the handle cannot: the thread's name in words, and what it is doing now.
  const status = t?.statusLine?.trim()
  const title = t ? [displayName(t), status].filter(Boolean).join(" · ") : "Open thread"
  return (
    <ThreadMentionLink
      segment={{ kind: "mention", text, slug }}
      href={href}
      onOpen={onOpen}
      title={title}
      className={className}
    />
  )
}

// `@thread.child` OPENS THE CHILD — its sub-agent drawer, or its thread when the directory does not know
// it (openSubAgentMention, the click path agent prose shares). The segment links as soon as its THREAD
// resolves; whether the child is real is asked only on the click, so a transcript full of mentions costs
// no requests to draw. A component of its own because only it needs the query client: a thread mention
// renders on surfaces with none.
function SubAgentMentionLink({ segment }: { segment: Extract<MentionSegment, { kind: "mention" }> }) {
  const queryClient = useQueryClient()
  const api = useThreadApi()
  const projectId = useThreadProjectId()
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
        void openSubAgentMention(queryClient, api, projectId, segment.slug, segment.address!)
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {segment.text}
    </a>
  )
}
