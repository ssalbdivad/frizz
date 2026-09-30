import { useContext, useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react"
import { useSnapshot } from "valtio"
import type { AccountBackend, ThreadSkill } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { restoreContextItems, showToast, store, takeContextItems } from "../store.ts"
import { buildMessageWithContext, hasToken } from "../lib/composerContext.ts"
import { splitComposerValue } from "../lib/imagePaths.ts"
import { useThreadComposerControls } from "../hooks/useThreadComposerControls.tsx"
import { Composer } from "./Composer.tsx"
import { useMentionCandidates, useOwnMention } from "../hooks/useMentionCandidates.ts"
import { LogoutConfirmModal, SignInModal } from "./SignInModal.tsx"
import { draftKey, draftStore, useDraft, useProjectDir } from "../lib/drafts.ts"
import { parseAccountAlias } from "../lib/signIn.ts"
import { useEagerFollowUp, type EagerFollowUpCallbacks } from "../lib/eagerComposerSubmission.ts"
import { canInterruptAndSend } from "../lib/composerKeyboard.ts"
import { useDeliverQueuedNow } from "../lib/deliverQueuedNow.ts"
import { useQueryClient } from "@tanstack/react-query"
import type { TranscriptData } from "../hooks.ts"
import { RegisteredAnsweringContext } from "./RegisteredQuestionCards.tsx"
import { composerTerminalLine } from "../lib/threadTerminals.ts"
import { startComposerTerminal } from "./ThreadTerminals.tsx"

// THE prompt box for a registered thread — the single block every "steer this thread" surface renders.
// The <Composer> leaf was already shared; the ~14 lines AROUND it were not, and the queue card's copy had
// silently drifted: it never intercepted the `/login` / `/logout` aliases, so typing `/login` into a cue
// card injected the literal string into the running worker's stdin while the same keystroke in the drawer
// opened the sign-in modal. Everything that must not diverge now lives here exactly once:
//
//   · the follow-up DRAFT key (so the queue card and the drawer are the same textarea, and a draft typed
//     in one is present in the other and survives a reload),
//   · the `/login` | `/logout` alias intercept + its SignInModal / LogoutConfirmModal,
//   · useThreadComposerControls (the model/effort footer and the backend busy fence),
//   · the {controls.status} line under the box.
//
// The two call sites keep their DELIBERATE differences as props, never as a forked tree: the padding
// wrapper (`className`), the running-operations rows rendered under the box (`ops` — the drawer passes
// BackgroundOpsStrip, the queue passes its ⤷ sub-agent lines plus a narrowed strip), and the send itself
// (`submitOverride`). Everything else is identical by construction.
// The skills typeahead's per-thread cache, shared by BOTH composer surfaces (the drawer and the queue
// card render the same thread) so opening either only ever asks the harness once. A failure is NOT
// cached: the common failure is "the session is not running yet", and the next `/` should ask again
// once it is. Module scope on purpose — the cache outlives any one composer mount.
const threadSkillsCache = new Map<string, Promise<ThreadSkill[]>>()
function fetchThreadSkills(slug: string): Promise<ThreadSkill[]> {
  const cached = threadSkillsCache.get(slug)
  if (cached) return cached
  const fetched = rpc.threadSkills({ slug }).then(
    (result) => result.skills,
    () => {
      threadSkillsCache.delete(slug)
      return []
    },
  )
  threadSkillsCache.set(slug, fetched)
  return fetched
}

export function ThreadComposerBox({
  slug,
  surface,
  placeholder,
  className,
  id,
  ops,
  submitOverride,
}: {
  slug: string
  // Pure data- tag forwarded to the textarea. Also the two surfaces' only behavioral fork inside
  // <Composer> itself (queueComposer owns Option-Enter); see lib/queueComposerKeyboard.ts.
  surface: "queueComposer" | "chatComposer"
  placeholder: string
  // The ONLY padding/chrome difference between the call sites — the drawer's bordered panel footer vs the
  // queue card's flush bottom block.
  className?: string
  // DOM id for the textarea. The drawer's is "followup-input".
  id?: string
  // Running background operations, rendered INSIDE the padded box under the prompt so those rows hang
  // tight off it. Composed by the caller — this component does not decide which ops a surface shows.
  ops?: ReactNode
  // Replaces the default eager follow-up send. The queue card passes its useLiveAnswering `sendMessage`,
  // so the card's free-form reply and its "Send answers" reply are literally the same send — one
  // controller, one optimistic card dissolve, one scroll policy (the queue suppresses the bottom pin;
  // it fights card exit/reorder). Callers WITHOUT an answering controller (the drawer) omit it and get
  // the plain eager follow-up. Deliberately not split into separate `onSent`/`scrollToBottom` props:
  // the override already carries both, and a second copy of them here could only ever disagree.
  submitOverride?: (text: string, callbacks: EagerFollowUpCallbacks) => void
}): ReactElement {
  const snap = useSnapshot(store)
  const thread = snap.board?.threads.find((candidate) => candidate.id === slug)
  const projectDir = useProjectDir()
  const key = draftKey.followUp(projectDir, slug, thread?.sessionId)
  const [message, setMessage, clearMessage] = useDraft(key)
  const controls = useThreadComposerControls(slug)
  const followUp = useEagerFollowUp(slug)
  const [signInFor, setSignInFor] = useState<AccountBackend | null>(null)
  const slashSuggest = useMemo(() => () => fetchThreadSkills(slug), [slug])
  // `@` mentions offer every OTHER thread on the board — this one cannot usefully point at itself.
  const mentions = useMentionCandidates(slug)
  const ownMention = useOwnMention(slug)
  const [logoutFor, setLogoutFor] = useState<AccountBackend | null>(null)
  // The thread's registered-question state, when this box sits under the surface that draws the cards.
  const answering = useContext(RegisteredAnsweringContext)

  // The ⌘I roster and its tokens. DELETING A TOKEN IS THE REMOVAL GESTURE: whenever the draft or
  // the roster changes, any staged item whose `@` token no longer appears in the prose is dropped —
  // so backspacing a reference out of the text retires its chip, exactly as the chip's × strips the
  // reference out of the text. Terminates: the write only fires when something is actually dropped.
  const stagedContext = snap.composerContext[slug]
  const contextTokens = useMemo(() => stagedContext?.map((item) => item.token) ?? [], [stagedContext])
  useEffect(() => {
    const items = store.composerContext[slug]
    if (!items?.length) return
    const { prose } = splitComposerValue(message)
    const kept = items.filter((item) => hasToken(prose, item.token))
    if (kept.length !== items.length) store.composerContext[slug] = kept
  }, [slug, message, stagedContext])

  // INTERRUPT AND SEND is offered only when there is something to interrupt AND a runtime that can be
  // preempted — `runtime === "running"` is exactly "process alive, turn in flight". The backend policy
  // (Claude only; Codex steers, ACP queues) lives in canInterruptAndSend, pinned by its test.
  const canInterrupt = canInterruptAndSend(thread, submitOverride !== undefined)
  // ⌘/Ctrl-Enter in an EMPTY box pushes the queued follow-up through — the queued bubble's ↑, from the
  // keyboard. Same gate as the forced send, plus a queued message in the transcript cache, read at
  // keypress time so this box does not re-render on every transcript push.
  const qc = useQueryClient()
  const { deliverNow } = useDeliverQueuedNow(slug)
  const pushQueued = () => {
    const messages = qc.getQueryData<TranscriptData>(["transcript", slug])?.messages
    if (!messages?.some((m) => m.queued)) return false
    deliverNow()
    return true
  }

  function send(interrupt = false) {
    const text = message.trim()
    if (!text) return
    // `/login` / `/logout` are frizz-owned account actions for THIS thread's backend — invoked
    // locally, never delivered to the worker as a prompt (a leading slash is not a stable provider
    // command transport across the live-paste vs dead-resume lifecycles).
    const alias = parseAccountAlias(text)
    if (alias) {
      clearMessage()
      if (thread?.backend === "acp") {
        showToast("An ACP agent signs in through its own CLI — Frizz holds no account for it")
        return
      }
      const backend: AccountBackend = thread?.backend === "codex" ? "codex" : "claude"
      if (alias === "login") setSignInFor(backend)
      else setLogoutFor(backend)
      return
    }
    // `$ npm test` is not a message: it opens a terminal on this thread, in the folder its agent is working
    // in, running that line — a bare `$` opens a shell there (lib/threadTerminals.ts composerTerminalLine).
    // Only on a thread Frizz owns; the queue card's copy of this box stays a reply box.
    const terminal = surface === "chatComposer" && thread?.kind === "session" && !thread.foreign ? composerTerminalLine(text) : undefined
    if (terminal) {
      clearMessage()
      startComposerTerminal(rpc, slug, terminal.command, () => {
        if (!draftStore.get(key)) setMessage(message)
      })
      return
    }
    // Staged ⌘I context items ride the send: serialized into the text (before any trailing
    // attachment paths) and cleared with it — restored on a rejected send exactly like the draft.
    const staged = takeContextItems(slug)
    const outgoing = buildMessageWithContext(text, staged, projectDir)
    const callbacks: EagerFollowUpCallbacks = {
      onOptimistic: clearMessage,
      // Never clobber a newer draft typed while the request was in flight.
      onRollback: () => {
        if (!draftStore.get(key)) setMessage(message)
        restoreContextItems(slug, staged)
      },
    }
    const deliver = () => {
      if (submitOverride) submitOverride(outgoing, callbacks)
      else followUp.submit(outgoing, { ...callbacks, interrupt })
    }
    // PICKED ANSWERS RIDE THE REPLY. A reply typed with a card's chip lit is the human adding a note to
    // that answer, not skipping it — sending the reply alone replied past the question and dropped the
    // pick (2026-09-29). The answers go first and the reply only once they have landed, so the worker
    // reads them in that order and a failed answer keeps the note in the box beside the card it belongs to.
    if (answering?.slug === slug && answering.staged > 0) {
      if (answering.sending) return
      answering.submit(deliver)
      return
    }
    deliver()
  }

  return (
    // `data-thread-action-bar` stays the drawer footer's stable anchor (fixtures/QA scripts measure the
    // prompt-box inset from it); `data-thread-composer-box` addresses either surface's block.
    <div
      data-thread-composer-box={surface}
      {...(surface === "chatComposer" ? { "data-thread-action-bar": "" } : {})}
      className={className}
    >
      <Composer
        contextTokens={contextTokens}
        id={id}
        surface={surface}
        value={message}
        onChange={setMessage}
        onSubmit={() => send()}
        onInterruptSubmit={canInterrupt ? () => send(true) : undefined}
        onPushQueued={canInterrupt ? pushQueued : undefined}
        slashSuggest={slashSuggest}
        mentionCandidates={mentions}
        ownMention={ownMention}
        placeholder={answering?.slug === slug && answering.staged > 0 ? "Add a note to your answers…" : placeholder}
        // NOT `|| followUp.pending`. The send is already committed locally (draft cleared, bubble
        // appended, and in the queue the card has already begun dissolving), so gating the textarea on
        // its round-trip only made the box go dead — and, because the browser blurs a disabled element,
        // cost the caret — for the ~½s the injection takes. What remains is a genuine backend
        // fence: a permission/profile change owning the runtime.
        busy={controls.busy}
        footer={controls.footer}
      />
      {controls.status}
      {/* The ops column's OPTICAL bottom inset, in ONE place for every surface that renders one — the
          amount and the reasoning live beside the font switch in styles.css, because it is
          font-dependent. `empty:hidden` is load-bearing: with no live ops React renders nothing here,
          and a bare negative margin would then eat into the composer's own 12px inset. */}
      <div className="ops-column-optical-inset empty:hidden">{ops}</div>
      {signInFor && <SignInModal backend={signInFor} onClose={() => setSignInFor(null)} onAuthed={() => setSignInFor(null)} />}
      {logoutFor && <LogoutConfirmModal backend={logoutFor} onClose={() => setLogoutFor(null)} />}
    </div>
  )
}
