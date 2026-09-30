import { createContext, useContext, useMemo, type ReactNode } from "react"
import { useMentionCandidates } from "../hooks/useMentionCandidates.ts"
import { basePath } from "../lib/base-path.ts"
import { mentionSegments, type MentionCandidate, type MentionSegment } from "../lib/threadMentions.ts"
import { openThread } from "../store.ts"

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
