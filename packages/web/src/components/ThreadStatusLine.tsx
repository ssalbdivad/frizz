import type { ReactNode } from "react"

// THE THREAD'S LIVE STATUS — what is happening in it NOW (server periodic-status.ts), set beside a NAME
// that stays put (maintainer 2026-09-29: the name is one or two words for the subject; what the thread is
// doing moves separately). Rendered at the END of a header's metadata line — the queue card's
// "project · Ready 9m ago" and the drawer's "READY · Last active 9m ago" — so it costs the header no
// height and the card nothing under it moves when the first status lands.
//
// It takes only the room the line has LEFT (`flex-1`, i.e. a zero flex-basis): the project chip and the
// time keep exactly the width they had before a status existed, and the status truncates into the rest.
// A shrink factor cannot say that — measured at 420px on the queue card, even `shrink-[100]` still took
// half a pixel off the project chip, which is enough to cut "names-proj" to "names-p…".
//
// NOT on the rail. A second line under a rail row is exactly what the rail refuses (Sidebar.tsx "A ROW
// IS ITS TITLE"); there the status rides the row indicator's tooltip.
//
// A shade stronger than the time beside it (fg/85, the project chip's weight, against the time's muted
// grey): the time is a reading ABOUT the thread, the status is what the thread is doing.
export function ThreadStatusLine({ status, lead }: { status: string | undefined; lead?: ReactNode }) {
  const text = status?.trim()
  if (!text) return null
  return (
    <>
      {lead}
      <span data-thread-status className="min-w-0 flex-1 truncate text-fg/85" title={text}>
        {text}
      </span>
    </>
  )
}
