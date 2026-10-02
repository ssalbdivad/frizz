import * as RadixDialog from "@radix-ui/react-dialog"
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useIsMutating, useMutation, useQuery } from "@tanstack/react-query"
import { expandUserCommandDraft, type AccountBackend, type CreateLazyThreadInput, type DispatchInput } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { useSnapshot } from "valtio"
import { showToast, store } from "../store.ts"
import { Composer } from "./Composer.tsx"
import { EditorContextBar } from "./EditorContextBar.tsx"
import { embedFileMentions } from "../lib/editorReach.ts"
import { useMentionCandidates } from "../hooks/useMentionCandidates.ts"
import { userCommandItems, useUserCommands } from "../hooks/useUserCommands.ts"
import { GithubTrigger, useGithubTriggerVisible } from "./GithubTrigger.tsx"
import { ProfileGridSelector } from "./ProfileGridSelector.tsx"
import { SETTINGS_WRITE_KEY } from "../hooks/useSettingsAutosave.tsx"
import { AcpModelSelect } from "./AcpModelSelect.tsx"
import { MakeDefaultButton } from "./MakeDefaultButton.tsx"
import { LogoutConfirmModal, SignInModal } from "./SignInModal.tsx"
import { dispatchProfileGroups } from "../lib/dispatchPreferences.ts"
import { useDispatchProfile, useDraftDispatchPick } from "../hooks/useDispatchProfile.ts"
import { handleDialogEscape } from "../lib/selectOverlay.ts"
import { draftKey, draftStore, useDraft, useProjectDir } from "../lib/drafts.ts"
import type { ComposerContextItem } from "../lib/composerContext.ts"
import { outgoingMessage } from "../lib/editorContext.ts"
import { restoreContextItems, stagedItems, takeContextItems, useStagedContextSources, useStagedContextTokens } from "../lib/stagedContext.ts"
import { projectSlug } from "../lib/base-path.ts"
import { parseAccountAlias } from "../lib/signIn.ts"
import { PROMPT_CONTROL_TYPOGRAPHY_CLASS } from "../lib/promptControlTypography.ts"
import { aboveDrawersZ } from "../lib/overlaySurface.ts"

/** The directories of the project a prompt box dispatches into, named by its caller (DispatchForm `dirs`). */
export interface DispatchDirs {
  projectDir: string | undefined
  homeDir: string | undefined
}

// THE prompt box: it starts an agent thread. Shared by every surface that can start one: the rail, the
// empty board's centered box and the anywhere-modal.
//
// It had a second tab until 2026-09-29, TERMINAL, which ran one shell command as a top-level thread of
// its own. A thread is a prompt now and nothing else; a terminal is opened ON a thread, in the folder its
// agent is working in (ThreadTerminals.tsx), so it is never a row of its own and never ignores which
// worktree the agent chose.
export function DispatchForm({
  autoFocus,
  onDispatched,
  target,
  dirs,
}: {
  autoFocus?: boolean
  onDispatched?: () => void
  /**
   * WHERE the thread goes, when that is a choice — the cross-project page's project picker. It is the
   * FIRST pill in the box's bottom strip, beside the model, because it is a setting of the thread about
   * to start, like the model. It sat at the tab row's right end until 2026-09-28, directly under the
   * status row's project filter, and two project names stacked one over the other read as one control
   * (maintainer: "lack of clarity on the distinction between the filter view … and the prompt selection
   * box"). A board has no choice to make and passes nothing.
   */
  target?: ReactNode
  /**
   * The directories of the project the box dispatches into, when the caller knows them before the
   * store's board for it has landed — the cross-project page re-aiming its box (AllQueues.tsx
   * FocusedComposer). They key the drafts, so the box can take the new project at once rather than
   * waiting on its feed. Everywhere else the store's board is the page project's, and says the same.
   */
  dirs?: DispatchDirs
}) {
  return (
    <div data-dispatch-form className="w-full flex flex-col gap-1.5">
      <PromptForm autoFocus={autoFocus} onDispatched={onDispatched} target={target} dirs={dirs} />
    </div>
  )
}

// The prompt form — composer + quiet selects row. There is no title field — the server derives a
// fallback and Claude names the session itself (ai-title), which the UI prefers for display.
function PromptForm({
  autoFocus,
  onDispatched,
  target,
  dirs,
}: {
  autoFocus?: boolean
  onDispatched?: () => void
  target?: ReactNode
  dirs?: DispatchDirs
}) {
  // A settings write still in flight — a compaction window picked in the model picker a moment ago —
  // must land before a dispatch that would read it.
  const savingSettings = useIsMutating({ mutationKey: [...SETTINGS_WRITE_KEY] }) > 0
  // Gate the leftAction slot itself, not just the icon: Composer reserves rail space whenever the
  // prop is set, so a hidden GithubTrigger must mean NO prop — not a null-rendering element.
  const githubTriggerVisible = useGithubTriggerVisible()
  // A new thread can be pointed at any thread on the board it is dispatched into (`@shell-budgets`).
  const mentions = useMentionCandidates()
  // No session yet, so no harness to list skills: the `/` menu here is the operator's own user commands,
  // which Frizz expands itself (useUserCommands.ts) — `/commit` starts a thread on that prompt.
  const userCommandsQuery = useUserCommands()
  const userCommands = userCommandsQuery.data?.commands
  const slashSuggest = useMemo(() => () => Promise.resolve(userCommandItems(userCommands ?? [])), [userCommands])
  const expandedPrompt = (text: string) => expandUserCommandDraft(text, userCommands ?? []) ?? text
  const boardDir = useProjectDir()
  const projectDir = dirs ? dirs.projectDir : boardDir
  // Queue and modal are the same semantic new-thread composer.
  const [prompt, setPrompt, clearPrompt] = useDraft(draftKey.dispatch(projectDir))
  const promptKey = draftKey.dispatch(projectDir)
  const submittedDraftRef = useRef("")
  // SELECTED CONTEXT in a new thread's prompt — a selection sent from an editor window lands here as an
  // `@a.ts:12-20` chip (lib/editorCompose.ts), staged under this box's own draft key and serialized into
  // the prompt on dispatch exactly as a reply box serializes it (composerContext.ts), so the new thread's
  // first message renders its chips like any later one. The box had no chips until 2026-10-01.
  const contextTokens = useStagedContextTokens(promptKey, prompt)
  const contextSources = useStagedContextSources(promptKey, projectDir)
  const submittedContextRef = useRef<ComposerContextItem[]>([])
  const [pendingDispatch, setPendingDispatch] = useState<string | null>(null)
  // The new-thread default (shared with the GitHub picker) with this prompt's own pick over it. The
  // pick is part of the draft: it lasts until this prompt is dispatched, then the box is back on the
  // default — escalating one task to max no longer leaves every later thread on max.
  const pickKey = draftKey.dispatchProfile(projectDir)
  const pickState = useDraftDispatchPick(pickKey)
  const [pick, setPick] = pickState
  const submittedPickRef = useRef(pick)
  const { resolved, defaultResolved, picked, codexList, claudeList, acpList, loadError: profileLoadError, choose, chooseAcpModel, makeDefault } = useDispatchProfile(pickState)

  // Per-provider LOCAL credential presence, polled so the submit gate has a fresh value without a
  // round-trip on every keystroke. The gate blocks ONLY on a positive "signed-out" (fails open on
  // "unknown"/loading/error), so a stale or missing snapshot can never trap a logged-in user.
  const authStatus = useQuery({ queryKey: ["authStatus"], queryFn: () => rpc.authStatus(), staleTime: 30_000 })
  // When submit is gated, the built dispatch is stashed here and the sign-in modal opens for this
  // backend; a successful re-check runs the stashed dispatch unchanged.
  const [signInFor, setSignInFor] = useState<AccountBackend | null>(null)
  const [logoutFor, setLogoutFor] = useState<AccountBackend | null>(null)
  const gatedInputRef = useRef<DispatchInput | null>(null)

  // Dispatch does NOT navigate anywhere: you stay on the queue, the new thread appears in the
  // sidebar, and the toast walks through the lifecycle — an immediate spinner while the server
  // waits out session startup, then a link that opens the thread in the side drawer.
  const dispatch = useMutation({
    mutationFn: (input: DispatchInput) => {
      const project = projectSlug()
      return rpc.dispatch(input).then((res) => ({ ...res, project }))
    },
    onMutate: () => showToast("Starting thread…", { spinner: true, sticky: true }),
    onSuccess: (res) => {
      // The board stream now owns the durable thread row. Drop our local bridge as soon as the
      // server acknowledges it, preventing an optimistic card + server card duplicate.
      setPendingDispatch(null)
      onDispatched?.()
      showToast("Thread started", { link: { label: "Open thread", slug: res.slug, project: res.project } })
    },
    onError: (e, input) => {
      // A submit clears before the RPC starts. Restore only into a still-empty field so retry is
      // effortless without overwriting text typed during the failed request.
      if (!draftStore.get(promptKey)) setPrompt(submittedDraftRef.current || input.prompt)
      // Its chips come back with it, or the restored token would be bare text with nothing behind it.
      restoreContextItems(promptKey, submittedContextRef.current)
      submittedContextRef.current = []
      // The pick comes back with its prompt, on the same terms: a retry must not quietly run on the
      // default, and a pick made during the failed request is not overwritten.
      if (!draftStore.get(pickKey)) setPick(submittedPickRef.current)
      setPendingDispatch(null)
      // Server-side auth preflight rejection (the client gate can miss on a stale snapshot): open the
      // same sign-in modal with the dispatch stashed, instead of a dead-end failure toast. The server
      // created no thread state, and the draft was restored above.
      const auth = /^AUTH_REQUIRED:(claude|codex)$/.exec((e as Error).message)
      if (auth) {
        gatedInputRef.current = input
        setSignInFor(auth[1] as AccountBackend)
        showToast(`Signed out of ${auth[1] === "claude" ? "Claude" : "Codex"}`, { duration: 3000 })
        return
      }
      showToast(`Dispatch failed: ${(e as Error).message.slice(0, 80)}`)
    },
  })

  // SAVE AS A LAZY THREAD (plans/lazy-threads.md): the same prompt, written down as a thread with no agent behind it.
  // No auth gate — nothing is started, so no provider is contacted; the sign-in, if one is needed, comes
  // when the lazy thread is launched. The draft clears like a dispatch's and comes back on failure the same way.
  const saveLazy = useMutation({
    mutationFn: (input: CreateLazyThreadInput) => {
      const project = projectSlug()
      return rpc.createLazyThread(input).then((res) => ({ ...res, project }))
    },
    onSuccess: (res) => {
      onDispatched?.()
      showToast("Lazy thread added", { link: { label: "Open", slug: res.slug, project: res.project } })
    },
    onError: (e, input) => {
      if (!draftStore.get(promptKey)) setPrompt(submittedDraftRef.current || input.prompt)
      restoreContextItems(promptKey, submittedContextRef.current)
      submittedContextRef.current = []
      if (!draftStore.get(pickKey)) setPick(submittedPickRef.current)
      showToast(`Could not add the lazy thread: ${(e as Error).message.slice(0, 80)}`)
    },
  })

  function submitLazy() {
    if (!prompt.trim() || !resolved || savingSettings || parseAccountAlias(prompt)) return
    const input: CreateLazyThreadInput = {
      // The chips — which the human placed, on purpose — and NOT the editor block, at saving or at launch.
      // A lazy thread is written down for later. The block says what the editor showed "when they sent
      // this"; baked into the note it would be read hours later as the moment of launch, and it sat in an
      // editable note the human never typed. Attached at launch instead, it would describe whatever the
      // editor happens to show then — unrelated to a note written earlier, more often than not — from a box
      // (LazyThreadBox) that shows no context bar, so the human could neither see it go nor turn it off.
      // If the note means the editor ("fix this"), the agent reads it then through its editor tool.
      prompt: outgoingMessage(expandedPrompt(prompt), stagedItems(promptKey), projectDir, false).trim(),
      // The pick rides along: it is what the lazy thread starts on when it is launched, unless changed then.
      model: resolved.model,
      backend: resolved.backend,
      effort: (resolved.effort || undefined) as CreateLazyThreadInput["effort"],
    }
    submittedDraftRef.current = prompt
    submittedPickRef.current = pick
    submittedContextRef.current = takeContextItems(promptKey)
    clearPrompt()
    setPick(undefined)
    saveLazy.mutate(input)
  }

  // Fire the dispatch and do the one-shot UI bookkeeping (optimistic toast + prompt clear). Called both
  // on a clean submit and after the sign-in gate is cleared, so the prompt is only cleared once the
  // thread is actually being started — a gated submit leaves the draft intact.
  function runDispatch(input: DispatchInput) {
    submittedDraftRef.current = prompt
    submittedPickRef.current = pick
    // Taken here, not in submit: a submit the sign-in gate holds keeps its draft, and so its chips.
    submittedContextRef.current = takeContextItems(promptKey)
    clearPrompt()
    setPick(undefined)
    setPendingDispatch(input.prompt)
    dispatch.mutate(input)
  }

  function submit() {
    if (!prompt.trim() || !resolved || savingSettings) return
    // `/login` and `/logout` are frizz-owned aliases for the typed provider account actions — they
    // invoke the sign-in / sign-out flow for the SELECTED backend and never become prompt text.
    const alias = parseAccountAlias(prompt)
    if (alias) {
      clearPrompt()
      if (resolved.backend === "acp") {
        showToast("An ACP agent signs in through its own CLI — Frizz holds no account for it")
        return
      }
      if (alias === "login") {
        gatedInputRef.current = null // nothing to dispatch after sign-in — this is a pure account action
        setSignInFor(resolved.backend)
      } else {
        setLogoutFor(resolved.backend)
      }
      return
    }
    if (!resolved.modelAvailable) {
      showToast("Saved model is unavailable — choose a model before starting the thread")
      return
    }
    if (!resolved.effortAvailable) {
      showToast("Saved reasoning level is unavailable for this model — choose another level")
      return
    }
    const expanded = expandedPrompt(prompt)
    const input: DispatchInput = {
      // The chips, and in an editor's sidebar what the editor has in front at THIS Enter
      // (lib/editorContext.ts outgoingMessage). Built here, once: a dispatch the sign-in gate holds runs
      // with this input after the sign-in, so it carries what the human saw when they pressed Enter.
      prompt: outgoingMessage(expanded, stagedItems(promptKey), projectDir, true).trim(),
      // A user command's thread is titled by what was typed, not by the first words of its wrapper.
      ...(expanded !== prompt ? { title: prompt.trim().split("\n")[0]!.slice(0, 120) } : {}),
      // No permissionMode: the server stamps every created worker itself (workerDispatchPermission —
      // the non-interactive floor, raised to bypass only when Settings asks). Dispatch offers no
      // per-thread permission choice; the "Permissions" control behind the Claude Code gear in the model
      // picker (AgentSettingsPopover) owns the default.
      model: resolved.model,
      backend: resolved.backend,
      // An ACP profile resolves to effort "" (no effort axis); the RPC's enum takes that as ABSENT.
      // Sending "" failed every ACP dispatch from the composer with "Invalid enum value" (2026-09-16).
      effort: (resolved.effort || undefined) as DispatchInput["effort"],
    }
    // Auth gate: block ONLY on a positive "signed-out" for this dispatch's backend. Loading/unknown/
    // authed all fall through (fail open) so a flaky or slow read never blocks a logged-in user. An ACP
    // agent has no account here at all — its own CLI reports a missing login on the first prompt.
    if (resolved.backend !== "acp" && authStatus.data?.[resolved.backend] === "signed-out") {
      gatedInputRef.current = input
      setSignInFor(resolved.backend)
      return
    }
    runDispatch(input)
  }

  // The profile readout lives INSIDE the box, along its bottom edge — petite caps, very quiet.
  // Not a dropdown at rest: a plain value; hover materializes the border, click opens the menu.
  // There is no permission control: dispatch permission is fixed server-side.
  //
  // useMemo (measured in the render-perf profile): the footer used to be rebuilt inline on every
  // render, so each prompt KEYSTROKE re-rendered every picker tree — ~222 component renders per
  // keystroke. A keystroke only changes `prompt`; keeping the footer element's identity stable lets
  // React bail out of the whole control subtree, and the
  // element is rebuilt exactly when the default, this box's pick or the model catalogue changes.
  const footer = useMemo(() => {
    if (!resolved) {
      return (
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {target}
          <ProfileGridSelector
            groups={[]}
            value={undefined}
            onValueChange={() => {}}
            placeholder={profileLoadError ? "Profile unavailable" : "Profile loading…"}
            ariaLabel="Model and effort loading"
            disabled
          />
        </div>
      )
    }
    const profileGroups = dispatchProfileGroups(codexList, acpList, claudeList)
    const acpAgent = resolved.acpAgentId ? acpList.find((agent) => agent.id === resolved.acpAgentId) : undefined
    return (
      // gap-x-1.5 between the two pills, the same measured gap the thread composer's strip uses
      // (useThreadComposerControls): two bordered pills on `gap-x-1` read as one segmented control.
      // The same 6px between ROWS: on a phone the pill and "Make default" wrap, and the old 2px row
      // gap stacked two bordered pills nearly touching (5.77px of ink across, 2px down).
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {target}
        <ProfileGridSelector
          groups={profileGroups}
          agentSettings
          // `pickerModel`, not `model`: an ACP row is keyed on the bare agent slug; the model inside
          // the agent is the dropdown's, below.
          value={{ provider: resolved.backend, model: resolved.pickerModel, effort: resolved.effort }}
          onValueChange={choose}
          ariaLabel="Model and effort"
          title={resolved.modelAvailable && resolved.effortAvailable
            ? "Model and reasoning effort"
            : "Saved model or reasoning effort unavailable — choose a supported pair"}
          className="max-w-[min(21rem,72vw)]"
        />
        {acpAgent && (
          <AcpModelSelect
            agentId={acpAgent.id}
            agentLabel={acpAgent.label}
            modelId={resolved.acpModelId}
            onValueChange={(modelId) => chooseAcpModel(acpAgent.id, modelId)}
            className="max-w-[min(14rem,40vw)] px-2 py-1"
          />
        )}
        {picked && defaultResolved && (
          <MakeDefaultButton groups={profileGroups} pick={resolved} defaultProfile={defaultResolved} onClick={makeDefault} />
        )}
      </div>
    )
  }, [resolved, defaultResolved, picked, codexList, claudeList, acpList, profileLoadError, choose, chooseAcpModel, makeDefault, target])

  return (
    <div className="w-full flex flex-col gap-3">
      <Composer
        surface="newComposer"
        autoFocus={autoFocus}
        value={prompt}
        onChange={setPrompt}
        onSubmit={submit}
        onSaveLazy={submitLazy}
        contextTokens={contextTokens}
        contextSources={contextSources}
        header={<EditorContextBar box={{ key: promptKey, projectDir, surface: "newComposer" }} />}
        placeholder="Describe the task…"
        mentionCandidates={mentions}
        fileMentions={embedFileMentions(projectDir)}
        slashSuggest={slashSuggest}
        slashSuggestVersion={userCommandsQuery.dataUpdatedAt}
        minHeight={96}
        maxHeight={340}
        busy={dispatch.isPending || saveLazy.isPending || savingSettings}
        footer={footer}
        leftAction={githubTriggerVisible ? <GithubTrigger /> : undefined}
      />
      {dispatch.isError && (
        <span className="px-0.5 text-[11px] text-danger truncate">{(dispatch.error as Error).message}</span>
      )}
      {pendingDispatch && (
        <div data-pending-dispatch role="status" className="rounded-lg border border-border bg-panel-2 px-3 py-2.5">
          <div className="flex items-center gap-2 text-[11px] text-muted">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" aria-hidden="true" />
            <span>Starting thread…</span>
          </div>
          <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-[12px] leading-relaxed text-fg">{pendingDispatch}</p>
        </div>
      )}
      {signInFor && (
        <SignInModal
          backend={signInFor}
          onClose={() => setSignInFor(null)}
          onAuthed={() => {
            const input = gatedInputRef.current
            gatedInputRef.current = null
            setSignInFor(null)
            if (input) runDispatch(input)
          }}
        />
      )}
      {logoutFor && <LogoutConfirmModal backend={logoutFor} onClose={() => setLogoutFor(null)} />}
    </div>
  )
}

// The anywhere-modal behind the pill button: same form in a centered dialog. Esc closes (captured
// here BEFORE the composer's own Escape-blurs handler can swallow it).
export function NewThreadDialog({ onClose }: { onClose: () => void }) {
  const contentRef = useRef<HTMLDivElement>(null)
  // Over whatever drawers are open — `c`, the palette's New thread or an editor's New thread button all
  // open it on top of a thread (lib/overlaySurface.ts aboveDrawersZ, which says why not z-[200]).
  const z = aboveDrawersZ(useSnapshot(store).drawers.length)
  // Frizz opens this dialog by writing store state, not through RadixDialog.Trigger. Capture the real
  // opener during the mount render so close can restore it explicitly.
  const openerRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )
  useEffect(() => () => {
    const opener = openerRef.current
    window.setTimeout(() => {
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    }, 0)
  }, [])
  return (
    <RadixDialog.Root open onOpenChange={(open) => { if (!open) onClose() }}>
      <RadixDialog.Portal>
        {/* Frosted glass: heavy blur + saturation over a light black wash, so the board reads as a
            texture behind the dialog rather than going fully dark. */}
        <RadixDialog.Overlay className="fixed inset-0 bg-scrim-30 backdrop-blur-md backdrop-saturate-150" style={{ zIndex: z }} />
        <RadixDialog.Content
          ref={contentRef}
          aria-modal="true"
          aria-describedby={undefined}
          onEscapeKeyDown={handleDialogEscape}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            const opener = openerRef.current
            if (opener?.isConnected) opener.focus({ preventScroll: true })
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            contentRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true })
          }}
          // TOP-ANCHORED ON A PHONE. Vertically centred, this dialog sits at ~420pt on a 844pt screen —
          // which is under the keyboard the moment its textarea takes focus, and the composer is the
          // entire point of the dialog. Above the phone breakpoint nothing changes.
          style={{ zIndex: z + 1 }}
          className="fixed left-1/2 top-1/2 w-[640px] max-w-[86vw] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-panel p-5 shadow-2xl shadow-shadow-ink/50 outline-none max-[700px]:top-[calc(env(safe-area-inset-top)+56px)] max-[700px]:w-[calc(100vw-24px)] max-[700px]:max-w-none max-[700px]:translate-y-0"
        >
          <RadixDialog.Title className="mb-1 text-[14px] font-medium">New thread</RadixDialog.Title>
          <DispatchForm autoFocus onDispatched={onClose} />
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

export function Overlay({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    // Frosted glass: heavy blur + saturation over a light black wash, so the board reads as a
    // texture behind the dialog rather than going fully dark. z-[200] matches the shared Radix Dialog
    // tier so the centered picker sits ABOVE the sidebar/prompt box (z-[100] on desktop) rather than
    // behind it.
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-scrim-30 backdrop-blur-md backdrop-saturate-150"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      {children}
    </div>
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] uppercase tracking-wide text-muted">{label}</span>
      {children}
    </label>
  )
}
