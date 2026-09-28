import { type ReactNode } from "react"
import { useSnapshot } from "valtio"
import { store } from "../store.ts"
import { ThreadComposerBox } from "./ThreadComposerBox.tsx"

// The bar under the chat/terminal is now JUST the follow-up composer — the Done button and the
// ⋯ menu live in the workpane header (ThreadHeaderActions) next to the tabs. `ops` (the live
// background-operations strip) renders INSIDE the padded box rather than beside it, so those rows
// hang tight off the prompt and the box's own pb becomes their gap to the lifecycle footer.
//
// This is now a THIN wrapper around <ThreadComposerBox> — the same block the queue card renders.
// Everything the two surfaces must agree on (the draft key, the `/login`/`/logout` intercept, the
// model/effort footer, the status line) lives in that component.
export function ThreadActionBar({ slug, ops }: { slug: string; onTerminal?: () => void; ops?: ReactNode }) {
  const snap = useSnapshot(store)
  const thread = snap.board?.threads.find((t) => t.id === slug)

  if (!thread) return null

  // AN EXTERNAL SESSION GETS THE ORDINARY COMPOSER, and that is the whole feature. It has no registry
  // row yet, so frizz has no channel into it — but SENDING is what opens one: the follow-up promotes
  // the session to a real thread server-side and then delivers into it, in one round trip (see the
  // router's promoteExternalSession). Nothing here has to know that happened, because the promoted
  // thread keeps the id this composer is already mounted on.
  //
  // The placeholder is the only tell, and it is deliberately a plain description of the consequence
  // rather than a warning: you are about to start driving a conversation you had been reading.
  return (
    <ThreadComposerBox
      slug={slug}
      surface="chatComposer"
      id="followup-input"
      placeholder={thread.foreign ? "Send a message to take over this session…" : "Follow up…"}
      // PADDING ONLY — no border, no background. The separator + panel fill belong to the
      // [data-thread-chat-footer] wrapper in ChatView that hosts this bar; carrying them here too
      // stacked a second hairline directly under the first, so the line above the prompt box read
      // as a 2px rule instead of the queue card's single hairline. Same shape as the queue card's
      // own reply box (AllQueuesCard: `shrink-0 px-5 pb-3 pt-0`) and as drawer-composer-footer-fixture.
      className="shrink-0 px-3 py-3"
      ops={ops}
    />
  )
}

// The old ⋯ overflow menu is gone: the frizz-document, retry, and done actions all live as direct
// icons in the shared <HeaderActions> (Kill and Dismiss were dropped entirely — an exited session
// is retried from the header, or cleared through the lifecycle footer).
