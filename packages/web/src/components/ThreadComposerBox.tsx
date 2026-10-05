import { useContext, useMemo, useState, type ReactElement, type ReactNode } from "react"
import { useSnapshot } from "valtio"
import { awaitingSteps, expandUserCommandDraft, type AccountBackend, type ThreadSkill, type ThreadView } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { showToast, store } from "../store.ts"
import { outgoingMessage } from "../lib/editorContext.ts"
import { restoreContextItems, takeContextItems, useStagedContextSources, useStagedContextTokens } from "../lib/stagedContext.ts"
import { useThreadComposerControls } from "../hooks/useThreadComposerControls.tsx"
import { Composer } from "./Composer.tsx"
import { EditorContextBar } from "./EditorContextBar.tsx"
import { EditorLine } from "./EditorLine.tsx"
import { embedFileMentions } from "../lib/editorReach.ts"
import { useMentionCandidates, useOwnMention } from "../hooks/useMentionCandidates.ts"
import { LogoutConfirmModal, SignInModal } from "./SignInModal.tsx"
import { draftKey, draftStore, mergeIntoDraft, useDraft, useProjectDir } from "../lib/drafts.ts"
import { noteFailedDraftOrigin, takeSupersededFailure } from "../lib/failedDelivery.ts"
import { parseAccountAlias } from "../lib/signIn.ts"
import { useEagerFollowUp, type EagerFollowUpCallbacks } from "../lib/eagerComposerSubmission.ts"
import { canInterruptAndSend } from "../lib/composerKeyboard.ts"
import { useDeliverQueuedNow } from "../lib/deliverQueuedNow.ts"
import { useQueryClient } from "@tanstack/react-query"
import type { TranscriptData } from "../hooks.ts"
import { RegisteredAnsweringContext } from "./RegisteredQuestionCards.tsx"
import { composerTerminalLine } from "../lib/threadTerminals.ts"
import { startComposerTerminal } from "./ThreadTerminals.tsx"
import { LazyThreadBox } from "./LazyThreadBox.tsx"
import { useIsMobile } from "../lib/mobile.ts"
import { threadLifecycleAvailability } from "../lib/threadLifecycle.ts"
import { PhoneDoneButton } from "./PhoneDoneButton.tsx"
import { fetchUserCommands, mergeSlashItems, useUserCommands } from "../hooks/useUserCommands.ts"
import type { PhoneBarApi } from "./Composer.tsx"

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
  phoneBarOverride,
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
  // THE PHONE BAR'S THIRD STATE. While set, the drawer's resting phone bar renders this in place of
  // its row — a thread with open registered questions shows [keyboard] + "Answer N questions" there.
  // `api.editReply()` (the keyboard button) switches back to the prompt and focuses it inside the same
  // tap; the override returns once the field is empty and blurred. Ignored above the phone breakpoint
  // and on the queue card. See PhoneComposerLayout in Composer.tsx.
  phoneBarOverride?: (api: PhoneBarApi) => ReactNode
}): ReactElement {
  const snap = useSnapshot(store)
  const thread = snap.board?.threads.find((candidate) => candidate.id === slug)
  const projectDir = useProjectDir()
  const key = draftKey.followUp(projectDir, slug, thread?.sessionId)
  const [message, setMessage, clearMessage] = useDraft(key)
  const controls = useThreadComposerControls(slug)
  const followUp = useEagerFollowUp(slug)
  const [signInFor, setSignInFor] = useState<AccountBackend | null>(null)
  const qc = useQueryClient()
  const userCommandsQuery = useUserCommands()
  const userCommands = userCommandsQuery.data?.commands
  // The thread's harness skills and the operator's own user commands, as one menu (useUserCommands.ts).
  const slashSuggest = useMemo(
    () => () => Promise.all([fetchThreadSkills(slug), fetchUserCommands(qc, projectDir)]).then(([skills, commands]) => mergeSlashItems(skills, commands)),
    [slug, qc, projectDir],
  )
  // `@` mentions offer every OTHER thread on the board — this one cannot usefully point at itself.
  const mentions = useMentionCandidates(slug)
  const ownMention = useOwnMention(slug)
  const [logoutFor, setLogoutFor] = useState<AccountBackend | null>(null)
  // The thread's registered-question state, when this box sits under the surface that draws the cards.
  const answering = useContext(RegisteredAnsweringContext)

  // The staged selections' tokens, painted as chips; deleting a token's text drops its item
  // (lib/stagedContext.ts). Keyed by this draft, so the queue card's copy of the box shows the same.
  const contextTokens = useStagedContextTokens(key, message)
  const contextSources = useStagedContextSources(key, projectDir)

  // INTERRUPT AND SEND is offered only when there is something to interrupt AND a runtime that can be
  // preempted — `runtime === "running"` is exactly "process alive, turn in flight". The backend policy
  // (Claude only; Codex steers, ACP queues) lives in canInterruptAndSend, pinned by its test.
  const canInterrupt = canInterruptAndSend(thread, submitOverride !== undefined)
  // ⌘/Ctrl-Enter in an EMPTY box pushes the queued follow-up through — the queued bubble's ↑, from the
  // keyboard. Same gate as the forced send, plus a queued message in the transcript cache, read at
  // keypress time so this box does not re-render on every transcript push.
  const { deliverNow } = useDeliverQueuedNow(slug)
  const pushQueued = () => {
    const messages = qc.getQueryData<TranscriptData>(["transcript", slug])?.messages
    if (!messages?.some((m) => m.queued)) return false
    deliverNow()
    return true
  }
  // THE PHONE BAR — the drawer's composer below the phone breakpoint (the queue card never renders
  // on a phone). Its right-hand verb follows the thread: Done while it rests and can be completed,
  // Send once there is text, a dimmed ↑ while a turn runs.
  const isMobile = useIsMobile()
  const phoneBar = isMobile && surface === "chatComposer"
  const turnRunning = thread?.runtime === "running" || thread?.runtime === "spawning"
  // NOT WHILE THE THREAD WAITS ON STEPS (`steps:` in its last fence). The card above carries its own
  // "Done", which means "I did the steps" and sends a reply; this one would mean "archive the thread",
  // and two Done verbs one above the other on a phone read as the same button.
  const stepsOpen = thread?.lastFence?.kind === "awaiting" && awaitingSteps(thread.lastFence.hints).length > 0
  const canComplete = thread ? threadLifecycleAvailability(thread).archive && !turnRunning && !stepsOpen : false

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
    // attachment paths) and cleared with it — restored on a rejected send exactly like the draft. In an
    // editor's sidebar the drawer's box — the one that shows the context bar — also carries what the
    // editor has in front, read now; the queue card's copy shows no bar and so carries none of it. The
    // thread's transcript rides along so a selection it already quoted is named, not quoted again.
    // A USER COMMAND (`/commit fix the tests`) goes out as the prompt it names, expanded here so it means
    // the same on every backend; the transcript reads it back as what was typed (messagePresentation.ts).
    const staged = takeContextItems(key)
    // A thread working in a worktree reads paths against IT, so they are written for it, with a word on
    // whose copy the context is (lib/composerContext.ts worktreeNote).
    const outgoing = outgoingMessage(expandUserCommandDraft(text, userCommands ?? []) ?? text, staged, projectDir, surface === "chatComposer", {
      history: qc.getQueryData<TranscriptData>(["transcript", slug])?.messages,
      checkout: thread?.checkout,
    })
    const callbacks: EagerFollowUpCallbacks = {
      onOptimistic: clearMessage,
      // Re-sending words an earlier failure handed back replaces that failure's bubble — see
      // lib/failedDelivery.ts.
      supersedes: takeSupersededFailure(key, outgoing),
      // Never clobber a newer draft typed while the request was in flight — and never DROP the failed
      // message for it either. This used to restore only into an empty box, so a failed send was
      // silently discarded whenever the operator had typed anything since; the words now go above
      // whatever is there (mergeIntoDraft). The server keeps its own copy too when it can (`kept`),
      // because this draft is sessionStorage and does not survive a browser restart.
      onRollback: (failure) => {
        mergeIntoDraft(key, message)
        restoreContextItems(key, staged)
        noteFailedDraftOrigin(key, { ...failure, text: message })
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

  // A LAZY THREAD has no agent to steer yet: its box is the note, and sending it starts one (LazyThreadBox).
  if (thread?.lazyPrompt !== undefined) {
    return (
      <div {...(surface === "chatComposer" ? { "data-thread-action-bar": "" } : {})} className={className}>
        <LazyThreadBox thread={thread as ThreadView} surface={surface} id={id} />
      </div>
    )
  }

  if (phoneBar) {
    return (
      <div data-thread-composer-box={surface} data-thread-action-bar="" data-phone-thread-bar="">
        <Composer
          contextTokens={contextTokens}
          id={id}
          surface={surface}
          value={message}
          onChange={setMessage}
          onSubmit={() => send()}
          onInterruptSubmit={canInterrupt ? () => send(true) : undefined}
          slashSuggest={slashSuggest}
          // A command saved in Settings refreshes the menu on the next `/`.
          slashSuggestVersion={userCommandsQuery.dataUpdatedAt}
          // An external session keeps its own sentence (it says what sending does); otherwise the verb
          // is the thread's state: steering a turn in flight, or replying to one at rest.
          placeholder={thread?.foreign ? placeholder : turnRunning ? "Steer…" : "Reply…"}
          busy={controls.busy}
          phone={{
            layout: "bar",
            tools: controls.phoneTools,
            idlePrimary: canComplete && thread ? (compact) => <PhoneDoneButton thread={thread as ThreadView} compact={compact} /> : undefined,
            override: phoneBarOverride,
            onLongPressSend: canInterrupt ? () => send(true) : undefined,
          }}
        />
        {controls.status}
        <div className="ops-column-optical-inset empty:hidden">{ops}</div>
        {signInFor && <SignInModal backend={signInFor} onClose={() => setSignInFor(null)} onAuthed={() => setSignInFor(null)} />}
        {logoutFor && <LogoutConfirmModal backend={logoutFor} onClose={() => setLogoutFor(null)} />}
      </div>
    )
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
        contextSources={contextSources}
        // In an editor's sidebar, what the editor has in front, one click from a chip in this box. The
        // drawer's box only: the queue card's copy of it is one of many on a page, and a bar on each
        // would be noise.
        header={surface === "chatComposer" ? <EditorContextBar box={{ key, projectDir, surface }} /> : undefined}
        // In a browser tab, the same box's quiet line naming what the editor beside it has in front.
        aside={surface === "chatComposer" ? <EditorLine box={{ key, projectDir, surface }} /> : undefined}
        id={id}
        surface={surface}
        value={message}
        onChange={setMessage}
        onSubmit={() => send()}
        onInterruptSubmit={canInterrupt ? () => send(true) : undefined}
        onPushQueued={canInterrupt ? pushQueued : undefined}
        slashSuggest={slashSuggest}
          // A command saved in Settings refreshes the menu on the next `/`.
          slashSuggestVersion={userCommandsQuery.dataUpdatedAt}
        mentionCandidates={mentions}
        ownMention={ownMention}
        // In an editor's sidebar, `@` offers the editor's files too, and a file dragged in from its
        // explorer lands as a reference (lib/editorReach.ts).
        fileMentions={embedFileMentions(projectDir)}
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
