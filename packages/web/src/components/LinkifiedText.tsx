import { useEffect, useMemo } from "react"
import { plainLinkSegments } from "../lib/plainLinks.ts"
import { noteGithubRefs } from "../lib/githubHovercards.ts"
import { useGithubRepoForLinks } from "../lib/useMarkdown.ts"
import { MentionLink, useMentionSegments } from "./MentionLinks.tsx"
import { scanInputFences } from "../lib/inputCodeFences.ts"
import { FenceCodeSpan } from "./TextareaCodeFences.tsx"

// Plain user text with the link-shaped runs made clickable — the render half of lib/plainLinks.ts.
// For the surfaces that show a human's words verbatim (the user bubble, an answers-card reply) where
// full markdown would rewrite what they typed: every text byte renders as-is, but a pasted URL or a
// GitHub ref becomes the same anchor it would be in agent prose, hovercard included.
//
// Fenced code is the one structure honoured: what the prompt box highlighted as it was typed
// (TextareaCodeFences) reads the same once sent. The bytes still render verbatim — delimiters and all,
// muted — but a body is monospaced and coloured by the transcript's highlight.js pipeline, and nothing
// inside it is linkified: a `#123` in a code comment is code, not a reference.
export function LinkifiedText({ text }: { text: string }) {
  const runs = useMemo(() => scanInputFences(text), [text])
  if (!runs) return <LinkedRun text={text} />
  return (
    <>
      {runs.map((run, i) => {
        const slice = text.slice(run.start, run.end)
        if (run.kind === "prose") return <LinkedRun key={i} text={slice} />
        if (run.kind === "fence") return <span key={i} className="font-mono-keep text-[0.9em] opacity-55">{slice}</span>
        // `highlightToHtml` escapes everything it is given; its only markup is hljs's token spans.
        return <FenceCodeSpan key={i} code={slice} language={run.language} className="font-mono-keep text-[0.9em]" />
      })}
    </>
  )
}

function LinkedRun({ text }: { text: string }) {
  // A render input for the same reason useMarkdownHtml subscribes: plainLinkSegments reads the repo
  // from githubAutolink's module state (it arrives from the board a beat after the transcript), so
  // `repo` is deliberately a dependency without appearing in the body.
  const repo = useGithubRepoForLinks()
  const segments = useMemo(() => plainLinkSegments(text), [text, repo])
  // Queue the hovercard fetch at render time, same contract as useGithubHovercardRefs — the delegated
  // pointerover has its own just-in-time request, but pre-noting means a hover is never blank.
  const refs = useMemo(
    () => segments.flatMap((s) => (s.kind === "link" && s.ghRef ? [s.ghRef] : [])),
    [segments],
  )
  useEffect(() => {
    if (refs.length > 0) noteGithubRefs(refs)
  }, [refs])
  return (
    <>
      {segments.map((s, i) =>
        s.kind === "text" ? (
          <MentionText key={i} text={s.text} />
        ) : (
          <a
            key={i}
            href={s.href}
            target="_blank"
            rel="noopener noreferrer"
            title={s.title}
            data-gh-ref={s.ghRef ?? undefined}
            // Inherit the host's text colour (this renders on BOTH the user bubble and the dark
            // answers chip; md-body's accent yellow is illegible on the former) — the underline alone
            // carries "clickable", the same treatment .md-inline links get.
            className="underline underline-offset-2"
            // The user bubble is itself clickable while queued (click-to-unqueue) — a link click or
            // an Enter on a focused link must open the link, not retract the message.
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {s.text}
          </a>
        ),
      )}
    </>
  )
}

// A plain run with its `@handle` mentions linked to the threads they name — only under a transcript that
// provides the board's handles (MentionLinks.tsx); anywhere else the run renders exactly as typed.
function MentionText({ text }: { text: string }) {
  const segments = useMentionSegments(text)
  return <>{segments.map((s, i) => (s.kind === "text" ? s.text : <MentionLink key={i} segment={s} />))}</>
}
