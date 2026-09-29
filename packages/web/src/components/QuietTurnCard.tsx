// A TURN THAT HAS GONE SILENT — the server queues a thread whose turn is still in flight but has written
// nothing for a long stretch (board.ts quietTurnSince): a foreground call sitting at a prompt or a 2FA
// approval nobody can see, a wedged tool. The thread is still `running`, so the queue card's prompt box
// offers interrupt-and-send (⌘/Ctrl-Enter), and that is the verb this card points at.
//
// It NAMES THE CALL (thread.quietTurnCall) — "no activity" alone leaves the operator guessing what is
// running before they can decide whether to interrupt it (maintainer 2026-09-29: "it needs to always be
// transparent in these cases what is actually running").
import { Hourglass } from "lucide-react"
import type { ThreadView } from "@frizz/shared"
import { elapsedSince } from "../lib/durationLabels.ts"
import { chordKeycaps, detectPlatform } from "../lib/keybindings.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { CARD_BODY, TranscriptCard } from "./TranscriptCard.tsx"

type QuietCall = NonNullable<ThreadView["quietTurnCall"]>

export function showsQuietTurnCard(thread: Pick<ThreadView, "kind" | "runtime" | "needsYou" | "quietTurnSince"> | undefined): boolean {
  return thread?.kind === "session" && thread.runtime === "running" && thread.needsYou === true && thread.quietTurnSince !== undefined
}

// `mcp__chrome-devtools__click` reads as `click (chrome-devtools)`; every other tool name is already a word.
export function quietCallToolName(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  return mcp ? `${mcp[2]} (${mcp[1]})` : name
}

const interruptChord = chordKeycaps({ key: "enter", mod: true, alt: false, shift: false }, detectPlatform()).join(detectPlatform() === "mac" ? "" : "+")

export function QuietTurnCard({ thread }: { thread: Pick<ThreadView, "quietTurnSince" | "quietTurnCall" | "backend"> }) {
  const now = useNowMs()
  const quiet = elapsedSince(thread.quietTurnSince, now)
  // Codex and ACP take no interrupt from Frizz (ThreadComposerBox canInterrupt); their card says so.
  const interruptible = thread.backend !== "codex" && thread.backend !== "acp"
  const call = thread.quietTurnCall
  return (
    <TranscriptCard data-quiet-turn-card icon={Hourglass} label={quiet ? `No activity for ${quiet}` : "No activity"}>
      {call && <QuietCallDetail call={call} />}
      <p className={`${CARD_BODY}${call ? " mt-2" : ""}`}>
        It may be waiting on a prompt or a 2FA approval.
        {interruptible ? ` ${interruptChord} below stops it and sends your message.` : " A reply here waits until it finishes."}
      </p>
    </TranscriptCard>
  )
}

function QuietCallDetail({ call }: { call: QuietCall }) {
  const tool = quietCallToolName(call.name)
  return (
    <div data-quiet-turn-call className="min-w-0">
      <div className={CARD_BODY}>
        <span className="font-medium text-fg">{call.label ?? tool}</span>
        {call.label && <span className="text-muted"> · {tool}</span>}
      </div>
      {call.command && (
        <pre className="mt-1.5 max-h-40 max-w-full min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/70 bg-bg/40 px-2.5 py-2 font-mono-keep text-[11.5px] leading-relaxed text-fg/90">
          {call.command}
        </pre>
      )}
    </div>
  )
}
